import { Elysia } from "elysia";
import dotenv from "dotenv";
import * as cheerio from "cheerio";

dotenv.config();

type DownloadLinks = {
  windows: string | null;
  mac: string | null;
  linux: string | null;
  linux_server: string | null;
  windows_server: string | null;
};

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
export async function parseVintageStoryDownloads(url: string): Promise<{
  [version: string]: DownloadLinks;
}> {
  const html = await fetchText(url);
  return parseDownloadsFromHtml(html);
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
  if (/linux/.test(h) && /\.tar\.gz$/.test(h)) {
    // If "server" didn’t match earlier, assume client
    return "linux";
  }
  if (/win/.test(h) && /\.exe$/.test(h)) {
    return "windows";
  }
  if (/win.*\.zip$/.test(h) && /server/.test(h)) {
    return "windows_server";
  }

  return null;
}

const app = new Elysia().get("/", async () => {
  return await parseVintageStoryDownloads("https://account.vintagestory.at/");
}).listen(3000);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);
