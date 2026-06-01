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

// ─── Rate limiter ───────────────────────────────────────────────────

const QUERY_RATE_LIMIT = 5; // requests per window
const QUERY_RATE_WINDOW = 60; // seconds

async function checkRateLimit(
  ip: string,
): Promise<{ allowed: boolean; remaining: number; reset: number }> {
  const key = `ratelimit:query:${ip}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, QUERY_RATE_WINDOW);
  }
  const remaining = Math.max(0, QUERY_RATE_LIMIT - count);
  return { allowed: count <= QUERY_RATE_LIMIT, remaining, reset: QUERY_RATE_WINDOW };
}

const buildLock = new JobLock(30 * 60 * 1000); // 30m TTL, adjust if needed

const R2_ACCOUNT_ID = Bun.env.R2_ACCOUNT_ID!;
const R2_ACCESS_KEY_ID = Bun.env.R2_ACCESS_KEY_ID!;
const R2_SECRET_ACCESS_KEY = Bun.env.R2_SECRET_ACCESS_KEY!;
const R2_BUCKET = Bun.env.R2_BUCKET!; // e.g., "my-game"
const R2_PUBLIC_BASE = Bun.env.R2_PUBLIC_BASE!; // e.g., "https://cdn.example.com/game"
const INNOEXTRACT_BIN = Bun.env.INNOEXTRACT_BIN || "./innoextract";
const REDIS_URL = Bun.env.REDIS_URL || undefined;

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

// Minimal cache to avoid duplicate builds within process lifetime
const builtCache = new Map<string, string>(); // version -> public URL

type DownloadLinks = {
  windows: string | null;
  mac: string | null;
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
  if (/osx/.test(h) || /mac/.test(h)) {
    return "mac";
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

// Core: ensure windows zip exists in R2 for a version, building if needed
async function ensureWindowsZip(version: string, windowsExeUrl: string): Promise<string> {
  if (builtCache.has(version)) return builtCache.get(version)!;

  const key = windowsZipKey(version);
  const exists = await r2Head(key);
  if (exists) {
    const url = publicUrlFor(key);
    builtCache.set(version, url);
    console.log(`Found existing windows zip for ${version} - ${url}`);
    return url;
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

    const url = publicUrlFor(key);
    builtCache.set(version, url);
    return url;
  } finally {
    // Clean temp directory
    await rm(workDir, { recursive: true, force: true });
  }
}

// Get latest versions + resolve Windows zip URL (R2 or build-on-demand)
async function getVersionsWithResolvedWindowsZip(sourceUrl: string) {
  const versions = await parseVintageStoryDownloads(sourceUrl);
  // Build a normalized output structure
  const out: Record<string, DownloadLinks & { windows_zip?: string | null }> = {};

  for (const [version, links] of Object.entries(versions)) {
    out[version] = { ...links, windows_zip: null };

    // We only act if we have a Windows installer link to transform
    if (links.windows && /\.exe(\?|$)/i.test(links.windows)) {
      try {
        const r2Url = await ensureWindowsZip(version, links.windows);
        out[version].windows_zip = r2Url;
      } catch (e) {
        console.error(`Failed to build windows zip for ${version}:`, e);
        // Leave windows_zip null; caller may fall back to installer if desired
      }
    } else if (links.windows && /\.zip(\?|$)/i.test(links.windows)) {
      // In case upstream already provides zip
      out[version].windows_zip = links.windows;
    } else {
      console.log(`No Windows installer link for ${version}, skipping windows zip build.`);
    }
  }
  return out;
}

// Redis-cached built windows zips (1d TTL)
async function listBuiltWindowsZipsFromR2(newest: string): Promise<Map<string, string>> {
  const cacheKey = "vsapi:builtzips:" + newest;
  const cached = await redis.get(cacheKey);
  if (cached) {
    console.log(`Cache hit for ${cacheKey}`);
    try {
      const obj = JSON.parse(cached);
      const sorted = Object.keys(obj).sort(semver.order).reverse();
      console.log(`Cached built zips for versions: ${sorted.join(", ")}`);
      if (sorted[0] !== newest) {
        console.log(`Warning: cached newest version ${sorted[0]} differs from expected ${newest}`);
        throw new Error("Cache inconsistency");
      }
      return new Map(Object.entries(obj));
    } catch {}
  }
  console.log(`Cache miss for ${cacheKey}, listing R2 objects`);
  const out = new Map<string, string>();
  let ContinuationToken: string | undefined = undefined;
  do {
    const resp = await s3.list({
      continuationToken: ContinuationToken,
    });
    for (const obj of resp.contents ?? []) {
      const key = obj.key || "";
      if (/^[^/]+\/windows\.zip$/i.test(key)) {
        const version = key.split("/", 1)[0];
        out.set(version, publicUrlFor(key));
        builtCache.set(version, publicUrlFor(key));
      }
    }
    ContinuationToken = resp.isTruncated ? resp.nextContinuationToken : undefined;
  } while (ContinuationToken);
  // Save to Redis
  await redis.set(cacheKey, JSON.stringify(Object.fromEntries(out)), "EX", 604800); // 7d
  return out;
}

// Merge already-built zips into parsed versions without triggering builds
async function mergeBuiltZips(versions: Record<string, DownloadLinks>) {
  // Sort the versions from a semver perspective to get the newest
  const sorted = Object.keys(versions).sort(semver.order).reverse();
  const newest = sorted[0];
  console.log(`Merging built zips, newest version detected: ${newest}`);
  const built = await listBuiltWindowsZipsFromR2(newest);
  const out: Record<string, DownloadLinks> = {};
  for (const [version, links] of Object.entries(versions)) {
    out[version] = { ...links, windows: null };
    const builtUrl = built.get(version);
    if (builtUrl) {
      console.log(`Found already existing windows zip for ${version}`);
      out[version].windows = builtUrl;
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
const app = new Elysia()
  // Enable CORS for all routes
  .use(cors())
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
          await getVersionsWithResolvedWindowsZip("https://account.vintagestory.at/");
          console.log(`[${new Date().toISOString()}] Cron: completed`);
        } catch (e) {
          console.error(`[${new Date().toISOString()}] Cron: failed`, e);
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
  .get("/versions", async () => {
    const versions = await parseVintageStoryDownloads("https://account.vintagestory.at/");
    return Object.keys(versions);
  })
  .get("/download", async () => {
    // Return parsed links plus any already-built windows zips in R2 (Redis cached)
    const versions = await parseVintageStoryDownloads("https://account.vintagestory.at/");
    return await mergeBuiltZips(versions);
  })
  .get(
    "/download/:version",
    async ({ params: { version } }) => {
      const versions = await parseVintageStoryDownloads("https://account.vintagestory.at/");
      const v = versions[version];
      if (!v) {
        return { error: "Version not found" };
      }
      const merged = await mergeBuiltZips({ [version]: v });
      return merged[version];
    },
    {
      params: t.Object({
        version: t.String(),
      }),
    },
  )
  .get(
    "/download/:version/:platform",
    async ({ params: { version, platform } }) => {
      let versions = await parseVintageStoryDownloads("https://account.vintagestory.at/");
      const v = versions[version];
      if (!v) {
        return { error: "Version not found" };
      }
      if (platform === "windows") {
        versions = await mergeBuiltZips({ [version]: v });
      }
      if (!(platform in v)) {
        return { error: "Invalid platform" };
      }
      return { url: versions[version][platform] };
    },
    {
      params: t.Object({
        version: t.String(),
        platform: t.Enum({
          windows: "windows",
          mac: "mac",
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
  .get("/resolved", async ({ set, store: { cron } }) => {
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

      // Build R2 key from optional version field (for pre-linking) or use "latest"
      const versionField = formData.get("version");
      const version = typeof versionField === "string" && versionField.trim()
        ? versionField.trim()
        : "latest";

      const key = `modpacks/${slug}/${version}/modconfigs.zip`;
      const buffer = Buffer.from(await modConfigFile.arrayBuffer());

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
      return { url, key };
    },
    {
      params: t.Object({
        slug: t.String(),
      }),
    },
  )
  .listen(3050);

console.log(`Elysia running at ${app.server?.hostname}:${app.server?.port}`);
