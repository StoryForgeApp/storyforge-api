import { Elysia, t } from "elysia";
import Redis from "ioredis";
import dotenv from "dotenv";
import * as cheerio from "cheerio";
import {
  S3Client,
  HeadObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  ListObjectsV2CommandOutput,
} from "@aws-sdk/client-s3";
import { tmpdir } from "node:os";
import { mkdtemp, rm, mkdir, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import cron, { Patterns } from "@elysiajs/cron";
import { JobLock } from "./jobLock";
import { semver } from "bun";

const buildLock = new JobLock(30 * 60 * 1000); // 30m TTL, adjust if needed

// ---------- config ----------
dotenv.config();

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID!;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID!;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY!;
const R2_BUCKET = process.env.R2_BUCKET!; // e.g., "my-game"
const R2_PUBLIC_BASE = process.env.R2_PUBLIC_BASE!; // e.g., "https://cdn.example.com/game"
const INNOEXTRACT_BIN = process.env.INNOEXTRACT_BIN || "./innoextract";
const REDIS_URL = process.env.REDIS_URL || undefined;

if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET || !R2_PUBLIC_BASE || !REDIS_URL) {
  throw new Error("Missing R2_* and REDIS_URL env vars");
}

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

// Minimal cache to avoid duplicate builds within process lifetime
const builtCache = new Map<string, string>(); // version -> public URL

// Redis setup
const redis = new Redis(REDIS_URL);

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
      "Cookie": `PHPSESSID=${process.env.PHPSESSID}; vs_websessionkey=${process.env.VS_WEBSESSIONKEY};`
    }
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
          const currentIsMirror = /account\.vintagestory\.at\/files/i.test(
            current
          );
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
  try {
    await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return true;
  } catch (e: any) {
    if (e.$metadata?.httpStatusCode === 404) return false;
    return false;
  }
}

async function r2Put(key: string, body: Buffer | Uint8Array, contentType: string, cacheControl?: string) {
  await s3.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: cacheControl,
    })
  );
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
  const file = createWriteStream(outPath);
  await pipeline(res.body as any, file);
}

async function run(cmd: string, args: string[], opts: { cwd?: string } = {}) {
  await new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit", cwd: opts.cwd });
    p.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
    p.on("error", reject);
  });
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
    return url;
  }

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
    await r2Put(key, zipData, "application/zip", "public, max-age=31536000, immutable");

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
  const out: Record<
    string,
    DownloadLinks & { windows_zip?: string | null }
  > = {};

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
    }
  }
  return out;
}


// Redis-cached built windows zips (1d TTL)
async function listBuiltWindowsZipsFromR2(newest: string): Promise<Map<string, string>> {
  const cacheKey = "vsapi:builtzips:" + newest;
  const cached = await redis.get(cacheKey);
  if (cached) {
    try {
      const obj = JSON.parse(cached);
      return new Map(Object.entries(obj));
    } catch {}
  }
  const out = new Map<string, string>();
  let ContinuationToken: string | undefined = undefined;
  do {
    const resp: ListObjectsV2CommandOutput = await s3.send(
      new ListObjectsV2Command({
        Bucket: R2_BUCKET,
        ContinuationToken,
      })
    );
    for (const obj of resp.Contents ?? []) {
      const key = obj.Key || "";
      if (/^[^/]+\/windows\.zip$/i.test(key)) {
        const version = key.split("/", 1)[0];
        out.set(version, publicUrlFor(key));
        builtCache.set(version, publicUrlFor(key));
      }
    }
    ContinuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
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
  const out: Record<string, DownloadLinks> =
    {};
  for (const [version, links] of Object.entries(versions)) {
    out[version] = { ...links, windows: null };
    const builtUrl = built.get(version);
    if (builtUrl) {
      out[version].windows = builtUrl;
    } else if (links.windows && /\.zip(\?|$)/i.test(links.windows)) {
      // upstream-provided zip (rare), surface it too
      out[version].windows = links.windows;
    }
  }
  return out;
}

// -------------- routes --------------
const app = new Elysia()
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
          `[${new Date().toISOString()}] Cron: start refreshing versions and building missing zips`
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
    })
  )
  .get("/versions", async () => {
    const versions = await parseVintageStoryDownloads("https://account.vintagestory.at/");
    return Object.keys(versions);
  })
  .get("/download", async () => {
    // Return parsed links plus any already-built windows zips in R2 (Redis cached)
    const versions = await parseVintageStoryDownloads("https://account.vintagestory.at/");
    return await mergeBuiltZips(versions);
  })
  .get("/download/:version", async ({ params: { version } }) => {
    const versions = await parseVintageStoryDownloads("https://account.vintagestory.at/");
    const v = versions[version];
    if (!v) {
      return { error: "Version not found" };
    }
    const merged = await mergeBuiltZips({ [version]: v });
    return merged[version];
  }, {
    params: t.Object({
      version: t.String()
    })
  })
  .get("/download/:version/:platform", async ({ params: { version, platform } }) => {
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
  }, {
    params: t.Object({
      version: t.String(),
      platform: t.Enum({
        windows: "windows",
        mac: "mac",
        linux: "linux",
        linux_server: "linux_server",
        windows_server: "windows_server"
      })
    })
  })
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
  .listen(3050);

console.log(`Elysia running at ${app.server?.hostname}:${app.server?.port}`);