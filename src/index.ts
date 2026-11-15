import { Elysia, t } from "elysia";
import * as cheerio from "cheerio";
import { tmpdir } from "node:os";
import { mkdtemp, rm, mkdir, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import cron, { Patterns } from "@elysiajs/cron";
import { JobLock } from "./jobLock";
import { queryServer } from "./vsquery";
import { semver, redis } from "bun";
import { cors } from "@elysiajs/cors";
import { auth } from "./auth";
import { db } from "./db";
import { modpack } from "./db/schema";
import { eq } from "drizzle-orm";
import { checkLimit } from "./rateLimit";
import { verifyPendingFiles } from "./moddbWorker";

// ─── Rate limiter ───────────────────────────────────────────────────

const QUERY_RATE_LIMIT = 5; // requests per window
const QUERY_RATE_WINDOW = 60; // seconds

async function checkRateLimit(
  ip: string,
): Promise<{ allowed: boolean; remaining: number; reset: number }> {
  const result = await checkLimit("query", ip, QUERY_RATE_LIMIT, QUERY_RATE_WINDOW);
  return { allowed: result.allowed, remaining: result.remaining, reset: result.retryAfter };
}

const buildLock = new JobLock(30 * 60 * 1000); // 30m TTL, adjust if needed
const hashVerifyLock = new JobLock(10 * 60 * 1000);

const R2_ACCOUNT_ID = Bun.env.R2_ACCOUNT_ID!;
const R2_ACCESS_KEY_ID = Bun.env.R2_ACCESS_KEY_ID!;
const R2_SECRET_ACCESS_KEY = Bun.env.R2_SECRET_ACCESS_KEY!;
const R2_BUCKET = Bun.env.R2_BUCKET!; // e.g., "my-game"
const R2_PUBLIC_BASE = Bun.env.R2_PUBLIC_BASE!; // e.g., "https://cdn.example.com/game"
const INNOEXTRACT_BIN = Bun.env.INNOEXTRACT_BIN || "./innoextract";
const REDIS_URL = Bun.env.REDIS_URL || undefined;
// Public base URL of this API, e.g. "https://api.getstoryforge.app". Only
// needed when the reverse proxy does not forward X-Forwarded-Host/Proto; game
// download links handed to clients are built from it.
const PUBLIC_BASE_URL = (Bun.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
// A presigned R2 URL only has to outlive a single download: clients keep the
// API URL and follow a fresh redirect when they resume.
const WINDOWS_ZIP_URL_TTL = 60 * 60;

if (
  !R2_ACCOUNT_ID ||
  !R2_ACCESS_KEY_ID ||
  !R2_SECRET_ACCESS_KEY ||
  !R2_BUCKET ||
  !R2_PUBLIC_BASE ||
  !REDIS_URL
) {
  throw new Error("Missing R2_* and REDIS_URL env vars");
}

const s3 = new Bun.S3Client({
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  secretAccessKey: R2_SECRET_ACCESS_KEY,
  accessKeyId: R2_ACCESS_KEY_ID,
  bucket: R2_BUCKET,
});

// Versions whose launcher-ready Windows zip exists in R2. The URL is built per
// request, so this cache stays valid across domains and deployments.
const builtCache = new Set<string>(); // version

type DownloadLinks = {
  windows: string | null;
  mac: string | null;
  mac_arm64: string | null;
  linux: string | null;
  linux_server: string | null;
  windows_server: string | null;
};

// Your existing parser functions here (parseVintageStoryDownloads, etc.)
/**
 * Parse Vintage Story download links from an account downloads HTML page.
 *
 * Output shape:
 * {
 *   "<version>": {
 *     windows: "<link>" | null,
 *     mac: "<link>" | null,
 *     mac_arm64: "<link>" | null,
 *     linux: "<link>" | null,
 *     linux_server: "<link>" | null,
 *     windows_server: "<link>" | null
 *   },
 *   ...
 * }
 *
 * Notes:
 * - Prefers CDN links if both CDN and mirror exist.
 * - Works for both "Stable" and "Unstable" panes.
 * - Robust to minor wording/size changes in anchor text; keys are inferred
 *   from href filename patterns.
 */

// Redis-cached version list (1h TTL)
export async function parseVintageStoryDownloads(url: string): Promise<{
  [version: string]: DownloadLinks;
}> {
  const cacheKey = "vsapi:versions";
  const cached = await redis.get(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch {}
  }
  const html = await fetchText(url);
  const parsed = parseDownloadsFromHtml(html);
  await redis.set(cacheKey, JSON.stringify(parsed), "EX", 3600); // 1h
  return parsed;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; VintageStoryDownloadParser/1.0)",
      Cookie: `PHPSESSID=${Bun.env.PHPSESSID}; vs_websessionkey=${Bun.env.VS_WEBSESSIONKEY};`,
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  return await res.text();
}

/**
 * Core parser: accepts raw HTML string (for testing).
 */
export function parseDownloadsFromHtml(html: string) {
  const $ = cheerio.load(html);

  // Collect version blocks from both stable and unstable panes.
  // Each version block is in a <p> where a bold <b> contains something like "v1.21.0".
  const versions: Record<string, DownloadLinks> = {};

  // Helper to normalize version labels like "v1.21.0" -> "1.21.0"
  const normVersion = (v: string) => v.trim().replace(/^v/i, "");

  // Find all <p> that contain a leading <b>version</b>
  $("div.tabpane p").each((_, p) => {
    const bold = $(p).find("b").first();
    if (!bold.length) return;
    const rawVersion = bold.text();
    if (!/^v?\d/.test(rawVersion)) return;

    const version = normVersion(rawVersion);

    // Initialize structure if not present
    if (!versions[version]) {
      versions[version] = {
        windows: null,
        mac: null,
        mac_arm64: null,
        linux: null,
        linux_server: null,
        windows_server: null,
      };
    }

    // For all anchors in this <p>, map them to the right slot.
    $(p)
      .find("a[href]")
      .each((_, a) => {
        const href = $(a).attr("href");
        if (!href) return;

        // We prefer CDN over mirror when duplicates exist:
        // If the link is a mirror (account.vintagestory.at/files/...),
        // keep it only if we don't already have a CDN link for that slot.
        const isCdn = /cdn\.vintagestory\.at/i.test(href);
        const isMirror = /account\.vintagestory\.at\/files/i.test(href);

        const slot = classifySlotFromHref(href);
        if (!slot) return;

        // Only set if:
        // - slot empty, or
        // - current is mirror but new is CDN (upgrade), or
        // - allow overwrite if same domain type (last one wins – typically OK)
        const current = versions[version][slot];
        if (!current) {
          versions[version][slot] = href;
        } else {
          const currentIsCdn = /cdn\.vintagestory\.at/i.test(current);
          const currentIsMirror = /account\.vintagestory\.at\/files/i.test(current);
          if (isCdn && currentIsMirror) {
            versions[version][slot] = href; // prefer CDN over mirror
          } else if (isMirror && !currentIsCdn) {
            // if current isn't CDN (unlikely), allow mirror
            versions[version][slot] = href;
          }
        }
      });
  });

  // Ensure keys exist and are strings or null, and coerce empty strings to null.
  for (const v of Object.keys(versions)) {
    const entry = versions[v];
    entry.windows = entry.windows || null;
    entry.mac = entry.mac || null;
    entry.mac_arm64 = entry.mac_arm64 || null;
    entry.linux = entry.linux || null;
    entry.linux_server = entry.linux_server || null;
    entry.windows_server = entry.windows_server || null;
  }

  return versions;
}

/**
 * Decide which output field a given href should populate.
 * Uses filename patterns which are consistent across stable/unstable.
 */
function classifySlotFromHref(href: string): keyof DownloadLinks | null {
  const h = href.toLowerCase();

  // Server packages first
  if (/_server_/.test(h) || /server_/.test(h)) {
    // Linux server
    if (/server_.*linux/.test(h) || /linux-?x64.*server/.test(h)) {
      return "linux_server";
    }
    // Windows server
    if (/server_.*win/.test(h) || /win-?x64.*server/.test(h)) {
      return "windows_server";
    }
    // Older naming where just "vs_server_*.tar.gz" (Linux tar.gz)
    if (/vs_server_.*\.tar\.gz$/.test(h)) {
      return "linux_server";
    }
  }

  // Client packages
  // Windows installer (and update/no-music): treat installer as "windows".
  if (/install_.*win/.test(h) || /vs_install_/.test(h)) {
    return "windows";
  }
  // Some links for updates use vs_update_win-x64_...exe (ignore for main client)
  // We DO NOT map updates to "windows" because you asked for main client links.
  // If you want to include updates, you could add an extra field here.

  // Mac
  if (/osx-x64/.test(h) || /mac-x64/.test(h)) {
    return "mac";
  }

  // Mac (Silicon)
  if (/osx-arm64/.test(h) || /mac-arm64/.test(h)) {
    return "mac_arm64";
  }

  // Linux client
  if (/client_.*linux/.test(h) || /linux-?x64.*client/.test(h)) {
    return "linux";
  }
  // Older naming for linux client archives: vs_archive_<ver>.tar.gz
  if (/vs_archive_.*\.tar\.gz$/.test(h)) {
    return "linux";
  }

  // Fallbacks by extension+platform hints
  if (/linux/.test(h) && h.endsWith(".tar.gz")) {
    // If "server" didn’t match earlier, assume client
    return "linux";
  }
  if (/win/.test(h) && h.endsWith(".exe")) {
    return "windows";
  }
  if (/win.*\.zip$/.test(h) && /server/.test(h)) {
    return "windows_server";
  }

  return null;
}

// -------------- helpers --------------
async function r2Head(key: string): Promise<boolean> {
  return s3.exists(key);
}

async function r2Put(
  key: string,
  body: Buffer | Uint8Array,
  contentType: string,
  acl?:
    | "private"
    | "public-read"
    | "public-read-write"
    | "aws-exec-read"
    | "authenticated-read"
    | "bucket-owner-read"
    | "bucket-owner-full-control"
    | "log-delivery-write"
    | undefined,
) {
  await s3.write(key, body, {
    type: contentType,
    acl,
  });
}

function publicUrlFor(key: string) {
  // If you mapped bucket root to R2_PUBLIC_BASE, join path
  return `${R2_PUBLIC_BASE.replace(/\/+$/, "")}/${key.replace(/^\/+/, "")}`;
}

/**
 * Public URL of the launcher-ready Windows zip.
 *
 * This points at this API, not at the bucket: the bucket host is deployment
 * configuration that has already outlived one brand, and Windows downloads
 * broke for every user when it did. `/gamefiles/:version/windows.zip` redirects
 * to a presigned R2 URL, so the host clients see is the API host.
 */
function windowsZipUrl(baseUrl: string, version: string): string {
  return `${baseUrl}/gamefiles/${encodeURIComponent(version)}/windows.zip`;
}

/**
 * Base URL clients should use to reach this API.
 *
 * `PUBLIC_BASE_URL` wins when set. Otherwise trust the reverse proxy headers,
 * then fall back to this request's host.
 */
function publicBaseUrl(request: Request): string {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;

  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  if (forwardedHost) {
    const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    return `${forwardedProto || "https"}://${forwardedHost}`;
  }

  const url = new URL(request.url);
  // The proxy terminates TLS, so the local server only ever sees http. Keep it
  // for local development and upgrade every other host.
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(url.host) ? url.origin : `https://${url.host}`;
}

/** Versions are `MAJOR.MINOR.PATCH`, optionally with a pre-release suffix. */
function isGameVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version);
}

async function downloadToFile(url: string, outPath: string) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  await Bun.write(outPath, new Uint8Array(arrayBuffer));
}

async function run(cmd: string, args: string[], opts: { cwd?: string } = {}) {
  const p = Bun.spawn([cmd, ...args], {
    cwd: opts.cwd,
    stderr: "inherit",
    stdin: "inherit",
    stdout: "inherit",
    onExit: (_p, code) => {
      if (code !== 0) {
        throw new Error(`Command failed: ${cmd} ${args.join(" ")} (exit code ${code})`);
      }
    },
  });
  return p.exited;
}

// Zip directory contents into zipPath
async function zipDirectory(srcDir: string, zipPath: string) {
  // Use system zip for Windows-friendliness; zips the contents (.) into archive
  await run("zip", ["-r", "-9", zipPath, "."], { cwd: srcDir });
}

function windowsZipKey(version: string): string {
  return `${version}/windows.zip`; // path layout in bucket
}

// Core: ensure the launcher-ready Windows zip for a version exists in R2,
// building it from the official installer if needed.
async function ensureWindowsZip(version: string, windowsExeUrl: string): Promise<void> {
  if (builtCache.has(version)) return;

  const key = windowsZipKey(version);
  if (await r2Head(key)) {
    builtCache.add(version);
    console.log(`Found existing windows zip for ${version}`);
    return;
  }
  console.log(`Building windows zip for ${version}...`);

  // Build on demand
  const workDir = await mkdtemp(join(tmpdir(), `vs-${version}-`));
  try {
    const exePath = join(workDir, `installer-${version}.exe`);
    const extractDir = join(workDir, "extracted");
    const zipPath = join(workDir, "windows.zip");

    await downloadToFile(windowsExeUrl, exePath);
    await mkdir(extractDir, { recursive: true });

    // Extract
    await run(INNOEXTRACT_BIN, ["--output-dir", extractDir, exePath]);

    // Optional: sanity check at least one file
    try {
      await stat(extractDir);
    } catch {
      throw new Error("Extraction failed: no output directory");
    }

    // Zip contents
    await zipDirectory(extractDir, zipPath);

    // Upload to R2
    const zipData = await readFile(zipPath);
    await r2Put(key, zipData, "application/zip", "public-read");

    builtCache.add(version);
  } finally {
    // Clean temp directory
    await rm(workDir, { recursive: true, force: true });
  }
}

// Build every Windows zip that is still missing from R2 (run by the cron job).
async function buildMissingWindowsZips(sourceUrl: string) {
  const versions = await parseVintageStoryDownloads(sourceUrl);

  for (const [version, links] of Object.entries(versions)) {
    // The official Windows channel only ships an installer; the zip is built
    // from it so the launcher has something it can extract.
    if (!links.windows || !/\.exe(\?|$)/i.test(links.windows)) {
      console.log(`No Windows installer link for ${version}, skipping windows zip build.`);
      continue;
    }
    try {
      await ensureWindowsZip(version, links.windows);
    } catch (e) {
      console.error(`Failed to build windows zip for ${version}:`, e);
      // A failed build is retried on the next cron run.
    }
  }
}

// Redis-cached list of versions whose Windows zip exists in R2
async function listBuiltWindowsZipVersions(newest: string): Promise<Set<string>> {
  const cacheKey = "vsapi:builtzipversions:" + newest;
  const cached = await redis.get(cacheKey);
  if (cached) {
    console.log(`Cache hit for ${cacheKey}`);
    try {
      const parsed = JSON.parse(cached) as { newest?: string; versions?: string[] };
      if (parsed.newest === newest && Array.isArray(parsed.versions)) {
        const versions = new Set(parsed.versions);
        console.log(
          `Cached built zips for versions: ${[...versions].sort(semver.order).reverse().join(", ")}`,
        );
        return versions;
      }
      console.log(`Cached entry for ${cacheKey} is stale, listing R2 objects`);
    } catch {}
  }
  console.log(`Cache miss for ${cacheKey}, listing R2 objects`);
  const versions = new Set<string>();
  let ContinuationToken: string | undefined = undefined;
  do {
    const resp = await s3.list({
      continuationToken: ContinuationToken,
    });
    for (const obj of resp.contents ?? []) {
      const key = obj.key || "";
      if (/^[^/]+\/windows\.zip$/i.test(key)) {
        const version = key.split("/", 1)[0];
        versions.add(version);
        builtCache.add(version);
      }
    }
    ContinuationToken = resp.isTruncated ? resp.nextContinuationToken : undefined;
  } while (ContinuationToken);
  // Save to Redis
  await redis.set(cacheKey, JSON.stringify({ newest, versions: [...versions] }), "EX", 604800); // 7d
  return versions;
}

// Merge already-built zips into parsed versions without triggering builds.
async function mergeBuiltZips(versions: Record<string, DownloadLinks>, baseUrl: string) {
  // Sort the versions from a semver perspective to get the newest
  const sorted = Object.keys(versions).sort(semver.order).reverse();
  const newest = sorted[0];
  console.log(`Merging built zips, newest version detected: ${newest}`);
  const built = await listBuiltWindowsZipVersions(newest);
  const out: Record<string, DownloadLinks> = {};
  for (const [version, links] of Object.entries(versions)) {
    out[version] = { ...links, windows: null };
    if (built.has(version)) {
      console.log(`Found already existing windows zip for ${version}`);
      out[version].windows = windowsZipUrl(baseUrl, version);
    } else if (links.windows && /\.zip(\?|$)/i.test(links.windows)) {
      // upstream-provided zip (rare), surface it too
      out[version].windows = links.windows;
    } else {
      console.log(`No built windows zip for ${version}`);
    }
  }
  return out;
}

// -------------- routes --------------

// ─── Zip bomb detection ─────────────────────────────────────────────

interface ZipInfo {
  entries: number;
  uncompressedSize: number;
  compressedSize: number;
}

/** Parses the zip central directory to extract total uncompressed/compressed
 *  sizes and entry count without decompressing. Returns null if not a valid zip. */
function inspectZip(buf: Buffer): ZipInfo | null {
  if (buf.length < 22) return null;

  // Search backwards from end for EOCD signature 0x06054b50
  const EOCD_SIG = 0x06054b50;
  const maxSearch = Math.min(buf.length, 65557); // max comment + EOCD
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - maxSearch); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) return null;

  const totalEntries = buf.readUInt16LE(eocdOffset + 8);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  if (cdOffset >= buf.length || totalEntries === 0) return null;

  let uncompressed = 0;
  let compressed = 0;
  let offset = cdOffset;

  for (let i = 0; i < totalEntries && offset + 46 <= buf.length; i++) {
    const sig = buf.readUInt32LE(offset);
    if (sig !== 0x02014b50) break; // not a central directory header

    uncompressed += buf.readUInt32LE(offset + 24);
    compressed += buf.readUInt32LE(offset + 20);

    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    offset += 46 + nameLen + extraLen + commentLen;
  }

  return { entries: totalEntries, uncompressedSize: uncompressed, compressedSize: compressed };
}
const app = new Elysia()
  // Enable CORS for all routes
  .use(cors())
  .get("/", () => ({ ok: true }))
  .mount(auth.handler)
  .use(
    cron({
      name: "download-versions",
      pattern: Patterns.EVERY_2_HOURS,
      run: async () => {
        if (buildLock.isLocked) {
          console.log(`[${new Date().toISOString()}] Cron: skipped (job already running)`);
          return;
        }
        const release = await buildLock.acquire();
        console.log(
          `[${new Date().toISOString()}] Cron: start refreshing versions and building missing zips`,
        );
        try {
          await buildMissingWindowsZips("https://account.vintagestory.at/");
          console.log(`[${new Date().toISOString()}] Cron: completed`);
        } catch (e) {
          console.error(`[${new Date().toISOString()}] Cron: failed`, e);
        } finally {
          release();
        }
      },
    }),
  )
  .use(
    cron({
      name: "verify-mod-hashes",
      pattern: Patterns.EVERY_5_MINUTES,
      run: async () => {
        if (hashVerifyLock.isLocked) {
          console.log(`[${new Date().toISOString()}] Cron: hash verify skipped (already running)`);
          return;
        }
        const release = await hashVerifyLock.acquire();
        try {
          const processed = await verifyPendingFiles(5);
          if (processed > 0) {
            console.log(
              `[${new Date().toISOString()}] Cron: hash verification processed ${processed} file(s)`,
            );
          }
        } catch (e) {
          console.error(`[${new Date().toISOString()}] Cron: hash verification failed`, e);
        } finally {
          release();
        }
      },
    }),
  )
  .get("/mod/:modid", async ({ params: { modid } }) => {
    const cacheKey = `vsapi:mod:${modid}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch {}
    }
    const response = await fetch(`https://mods.vintagestory.at/api/mod/${modid}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch mod ${modid}: ${response.status} ${response.statusText}`);
    }
    const mod = await response.json();
    // Cache for 1 hour
    await redis.set(cacheKey, JSON.stringify(mod), "EX", 3600);
    return mod;
  })
  .get(
    "/mods",
    async ({ query }) => {
      // Check in redis if we have cached mod list
      const cacheKey = `vsapi:mods:${query.versions || "all"}`;
      const cached = await redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached);
        } catch {}
      }

      let fetchUrl = "https://mods.vintagestory.at/api/mods";
      if (query.versions) {
        fetchUrl += `?${query.versions
          .split(",")
          .map((v) => `gameversions[]=${v}`)
          .join("&")}`;
      }

      // Fetch and parse
      const response = await fetch(fetchUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch mods: ${response.status} ${response.statusText}`);
      }
      const mods = await response.json();

      // Cache for 1 hour
      await redis.set(cacheKey, JSON.stringify(mods), "EX", 3600);

      return mods;
    },
    {
      query: t.Object({
        versions: t.Optional(t.String()),
      }),
    },
  )
  .get("/modtags", async () => {
    // Check in redis if we have cached mod tags
    const cacheKey = "vsapi:modtags";
    const cached = await redis.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch {}
    }

    // Fetch and parse
    const response = await fetch("https://mods.vintagestory.at/api/tags");
    if (!response.ok) {
      throw new Error(`Failed to fetch mod tags: ${response.status} ${response.statusText}`);
    }
    const modtags = await response.json();

    // Cache for 7 days
    await redis.set(cacheKey, JSON.stringify(modtags), "EX", 604800);

    return modtags;
  })
  .get("/releases/latest", async () => {
    // Proxy for the GitHub releases API: browsers hit GitHub's unauthenticated
    // rate limit (60/h/IP), so the website reads from here instead. Cached for
    // 15 minutes with a stale copy served if GitHub is unavailable.
    const cacheKey = "vsapi:releases:latest";
    const cached = await redis.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch {}
    }

    const headers: Record<string, string> = { accept: "application/vnd.github+json" };
    if (Bun.env.GITHUB_TOKEN) headers.authorization = `Bearer ${Bun.env.GITHUB_TOKEN}`;

    try {
      const response = await fetch(
        "https://api.github.com/repos/lovelesscodes/storyforge/releases/latest",
        { headers },
      );
      if (!response.ok) throw new Error(`GitHub responded ${response.status}`);

      const release = (await response.json()) as {
        tag_name: string;
        html_url: string;
        published_at: string | null;
        assets: {
          name: string;
          browser_download_url: string;
          size: number;
          download_count: number;
        }[];
      };

      const payload = {
        version: release.tag_name,
        url: release.html_url,
        publishedAt: release.published_at,
        assets: (release.assets ?? [])
          .filter((asset) => asset.name !== "latest.json" && !asset.name.endsWith(".sig"))
          .map((asset) => ({
            name: asset.name,
            url: asset.browser_download_url,
            size: asset.size,
            downloads: asset.download_count,
          })),
      };

      await redis.set(cacheKey, JSON.stringify(payload), "EX", 900);
      await redis.set(`${cacheKey}:stale`, JSON.stringify(payload));
      return payload;
    } catch (error) {
      const stale = await redis.get(`${cacheKey}:stale`);
      if (stale) {
        try {
          return JSON.parse(stale);
        } catch {}
      }
      throw error;
    }
  })
  .get("/github/stats", async () => {
    // Repo stats for the marketing site (stars, forks, total downloads).
    const cacheKey = "vsapi:github:stats";
    const cached = await redis.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch {}
    }

    const headers: Record<string, string> = { accept: "application/vnd.github+json" };
    if (Bun.env.GITHUB_TOKEN) headers.authorization = `Bearer ${Bun.env.GITHUB_TOKEN}`;

    try {
      const [repoResponse, releasesResponse] = await Promise.all([
        fetch("https://api.github.com/repos/lovelesscodes/storyforge", { headers }),
        fetch("https://api.github.com/repos/lovelesscodes/storyforge/releases?per_page=100", {
          headers,
        }),
      ]);
      if (!repoResponse.ok) throw new Error(`GitHub responded ${repoResponse.status}`);

      const repo = (await repoResponse.json()) as {
        stargazers_count: number;
        forks_count: number;
      };
      const releases = releasesResponse.ok
        ? ((await releasesResponse.json()) as {
            assets: { name: string; download_count: number }[];
          }[])
        : [];

      const downloads = releases.reduce(
        (sum, release) =>
          sum +
          release.assets.reduce(
            (assetSum, asset) =>
              assetSum +
              (asset.name !== "latest.json" && !asset.name.endsWith(".sig")
                ? asset.download_count
                : 0),
            0,
          ),
        0,
      );

      const payload = {
        stars: repo.stargazers_count,
        forks: repo.forks_count,
        downloads,
      };

      await redis.set(cacheKey, JSON.stringify(payload), "EX", 3600);
      await redis.set(`${cacheKey}:stale`, JSON.stringify(payload));
      return payload;
    } catch (error) {
      const stale = await redis.get(`${cacheKey}:stale`);
      if (stale) {
        try {
          return JSON.parse(stale);
        } catch {}
      }
      throw error;
    }
  })
  .get("/versions", async () => {
    const versions = await parseVintageStoryDownloads("https://account.vintagestory.at/");
    return Object.keys(versions);
  })
  .get("/download", async ({ request }) => {
    // Return parsed links plus any already-built windows zips in R2 (Redis cached)
    const versions = await parseVintageStoryDownloads("https://account.vintagestory.at/");
    return await mergeBuiltZips(versions, publicBaseUrl(request));
  })
  .get(
    "/download/:version",
    async ({ request, params: { version } }) => {
      const versions = await parseVintageStoryDownloads("https://account.vintagestory.at/");
      const v = versions[version];
      if (!v) {
        return { error: "Version not found" };
      }
      const merged = await mergeBuiltZips({ [version]: v }, publicBaseUrl(request));
      return merged[version];
    },
    {
      params: t.Object({
        version: t.String(),
      }),
    },
  )
  .get(
    "/gamefiles/:version/windows.zip",
    async ({ params: { version }, redirect, set }) => {
      if (!isGameVersion(version)) {
        set.status = 400;
        return { error: "Invalid version" };
      }
      const key = windowsZipKey(version);
      if (!(await r2Head(key))) {
        set.status = 404;
        return { error: `No Windows download has been built for ${version} yet` };
      }
      // Presigned so the archive streams from R2 (ranges included) rather than
      // through this server, and so no bucket hostname is baked into the URL.
      return redirect(s3.presign(key, { method: "GET", expiresIn: WINDOWS_ZIP_URL_TTL }), 302);
    },
    {
      params: t.Object({
        version: t.String(),
      }),
    },
  )
  .get(
    "/download/:version/:platform",
    async ({ request, params: { version, platform }, set }) => {
      const versions = await parseVintageStoryDownloads("https://account.vintagestory.at/");
      const v = versions[version];
      if (!v) {
        return { error: "Version not found" };
      }
      if (platform === "windows") {
        const merged = await mergeBuiltZips({ [version]: v }, publicBaseUrl(request));
        const url = merged[version].windows;
        if (!url) {
          // The zip is built from the official installer by the cron job, so a
          // brand new release can go without one for a short while.
          set.status = 404;
          return { error: `No Windows download has been built for ${version} yet` };
        }
        return { url };
      }
      if (!(platform in v)) {
        return { error: "Invalid platform" };
      }
      return { url: v[platform] };
    },
    {
      params: t.Object({
        version: t.String(),
        platform: t.Enum({
          windows: "windows",
          mac: "mac",
          mac_arm64: "mac_arm64",
          linux: "linux",
          linux_server: "linux_server",
          windows_server: "windows_server",
        }),
      }),
    },
  )
  .get(
    "/query/:address",
    async ({ request, params: { address }, query, set }) => {
      // Rate limit
      const ip =
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        request.headers.get("x-real-ip") ||
        "unknown";
      const rl = await checkRateLimit(ip);
      set.headers["X-RateLimit-Limit"] = String(QUERY_RATE_LIMIT);
      set.headers["X-RateLimit-Remaining"] = String(rl.remaining);
      set.headers["X-RateLimit-Reset"] = String(rl.reset);
      if (!rl.allowed) {
        set.status = 429;
        return { error: "Too many requests", retryAfter: rl.reset };
      }

      let host = address;
      let port = 42420;

      // Parse host:port from address
      if (!host.startsWith("[")) {
        const parts = host.split(":");
        if (parts.length > 1) {
          const maybePort = parseInt(parts[parts.length - 1], 10);
          if (!isNaN(maybePort) && maybePort > 0 && maybePort <= 65535) {
            port = maybePort;
            host = parts.slice(0, -1).join(":");
          }
        }
      }

      const password = query.password || "";
      const timeout = query.timeout ? parseInt(query.timeout, 10) : 8000;

      const result = await queryServer(host, port, timeout, password);
      const passwordResult = await queryServer(
        host,
        port,
        timeout,
        password,
        result.serverGameVersion,
        result.serverNetworkVersion,
      );
      return { ...result, ...passwordResult };
    },
    {
      params: t.Object({
        address: t.String(),
      }),
      query: t.Object({
        password: t.Optional(t.String()),
        timeout: t.Optional(t.String()),
      }),
    },
  )
  .get("/resolved", async ({ request, set, store: { cron } }) => {
    // Validate session
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session || session.user.role !== "admin") {
      set.status = 401;
      return { error: "Unauthorized – session required" };
    }
    if (buildLock.isLocked) {
      set.status = 409;
      return { ok: false, message: "Build is already running" };
    }
    try {
      await cron["download-versions"].trigger();
      return { ok: true, message: "Build started in background" };
    } catch (e) {
      set.status = 500;
      return { ok: false, message: (e as Error).message };
    }
  })
  // ─── Modpack modConfig upload ────────────────────────────────────
  .post(
    "/api/modpacks/:slug/versions/upload",
    async ({ request, params: { slug }, set }) => {
      // Validate session
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session) {
        set.status = 401;
        return { error: "Unauthorized – session required" };
      }

      // Find modpack and check ownership
      const [mp] = await db.select().from(modpack).where(eq(modpack.slug, slug)).limit(1);
      if (!mp) {
        set.status = 404;
        return { error: "Modpack not found" };
      }
      if (mp.owner !== session.user.id) {
        set.status = 401;
        return { error: "Unauthorized – you must own the modpack" };
      }

      // Parse multipart form data
      const contentType = request.headers.get("content-type") ?? "";
      if (!contentType.includes("multipart/form-data")) {
        set.status = 400;
        return { error: "Expected multipart/form-data with modConfig field" };
      }

      let formData: FormData;
      try {
        formData = await request.formData();
      } catch {
        set.status = 400;
        return { error: "Failed to parse form data" };
      }

      const modConfigFile = formData.get("modConfig");
      if (!modConfigFile || typeof modConfigFile === "string") {
        set.status = 400;
        return { error: "modConfig file is required" };
      }

      // ── Size limits ──────────────────────────────────────────
      const MAX_UPLOAD_SIZE = 5 * 1024 * 1024; // 5 MB
      if (modConfigFile.size > MAX_UPLOAD_SIZE) {
        set.status = 400;
        return { error: `File too large — max ${MAX_UPLOAD_SIZE / 1024 / 1024}MB` };
      }

      const buffer = Buffer.from(await modConfigFile.arrayBuffer());
      const modConfigsSha256 = new Bun.CryptoHasher("sha256").update(buffer).digest("hex");
      const modConfigsSize = buffer.byteLength;

      // ── Zip bomb detection ────────────────────────────────────
      const zipInfo = inspectZip(buffer);
      if (zipInfo) {
        const MAX_UNCOMPRESSED = 10 * 1024 * 1024; // 10 MB
        const MAX_ENTRIES = 10_000;
        const MAX_RATIO = 100; // compressed * ratio < uncompressed → suspicious

        if (zipInfo.uncompressedSize > MAX_UNCOMPRESSED) {
          set.status = 400;
          return {
            error: `Zip expands to ${(zipInfo.uncompressedSize / 1024 / 1024).toFixed(0)}MB, max ${MAX_UNCOMPRESSED / 1024 / 1024}MB`,
          };
        }
        if (zipInfo.entries > MAX_ENTRIES) {
          set.status = 400;
          return { error: `Zip contains ${zipInfo.entries} entries, max ${MAX_ENTRIES}` };
        }
        if (
          zipInfo.compressedSize > 1024 &&
          zipInfo.uncompressedSize > zipInfo.compressedSize * MAX_RATIO
        ) {
          set.status = 400;
          return { error: "Suspicious compression ratio — possible zip bomb" };
        }
      }

      // Build R2 key from optional version field (for pre-linking) or use "latest"
      const versionField = formData.get("version");
      const version =
        typeof versionField === "string" && versionField.trim() ? versionField.trim() : "latest";

      const key = `modpacks/${slug}/${version}/modconfigs.zip`;

      try {
        await s3.write(key, buffer, {
          type: "application/zip",
          acl: "public-read",
        });
      } catch (err) {
        console.error("R2 upload failed:", err);
        set.status = 500;
        return { error: "Failed to upload modConfig to storage" };
      }

      const url = publicUrlFor(key);
      return { url, key, sha256: modConfigsSha256, size: modConfigsSize };
    },
    {
      params: t.Object({
        slug: t.String(),
      }),
    },
  )
  // ─── Admin: Redis key management ──────────────────────────────────
  .get(
    "/admin/redis",
    async ({ request, query, set }) => {
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session || session.user.role !== "admin") {
        set.status = 401;
        return { error: "Unauthorized – admin required" };
      }

      const existed = await redis.exists(query.key);
      await redis.del(query.key);

      return { ok: true, key: query.key, existed: existed };
    },
    {
      query: t.Object({
        key: t.String(),
      }),
    },
  )
  .listen(3050);

console.log(`Elysia running at ${app.server?.hostname}:${app.server?.port}`);
