// Parsing of the Vintage Story download pages.
//
// Two sources feed the version list:
//
// - the account downloads page (`account.vintagestory.at`), which carries one
//   `<p><b>vX.Y.Z</b></p>` block per Stable and Unstable build, and
// - the preview pages (`info.vintagestory.at/vNdotM`), which is the only place
//   pre-releases (`1.23.0-pre.1`) are published. The account page merely links
//   to them, so a preview build is invisible to the Stable/Unstable parser.

import * as cheerio from "cheerio";

export type DownloadLinks = {
  windows: string | null;
  mac: string | null;
  mac_arm64: string | null;
  linux: string | null;
  linux_server: string | null;
  windows_server: string | null;
};

export function emptyDownloadLinks(): DownloadLinks {
  return {
    windows: null,
    mac: null,
    mac_arm64: null,
    linux: null,
    linux_server: null,
    windows_server: null,
  };
}

/**
 * Decide which output field a given href should populate.
 * Uses filename patterns which are consistent across stable/unstable/pre.
 */
export function classifySlotFromHref(href: string): keyof DownloadLinks | null {
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

/**
 * Core parser: accepts raw HTML string (for testing).
 */
export function parseDownloadsFromHtml(html: string): Record<string, DownloadLinks> {
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
      versions[version] = emptyDownloadLinks();
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
 * Preview pages linked from the account page, e.g.
 * `https://info.vintagestory.at/v1dot23`.
 */
export function previewPageUrlsFromHtml(html: string): string[] {
  const urls = new Set<string>();
  const matches = html.matchAll(/https?:\/\/info\.vintagestory\.at\/v\d+dot\d+/gi);
  for (const match of matches) {
    urls.add(match[0]);
  }
  return [...urls];
}

// `..._1.23.0-pre.1.tar.gz` -> `1.23.0-pre.1`. macOS archives end in `.tar`
// rather than `.tar.gz`, so both are accepted.
const PREVIEW_FILE_VERSION_RE =
  /_(\d+\.\d+\.\d+[-+][0-9A-Za-z.-]+?)\.(?:tar\.gz|tar|zip|exe)(?:[?#]|$)/i;

/**
 * A preview page lists one section per build, each with a link per platform.
 * The version is only in the href, never in a stable label, so it is read from
 * the CDN filename. Only the `gamefiles/pre/` channel is considered.
 */
export function parsePreviewDownloadsFromHtml(
  html: string,
): Record<string, DownloadLinks> {
  const $ = cheerio.load(html);
  const versions: Record<string, DownloadLinks> = {};

  $("a[href]").each((_, a) => {
    const href = $(a).attr("href");
    if (!href) return;
    if (!/cdn\.vintagestory\.at\/gamefiles\/pre\//i.test(href)) return;

    const match = PREVIEW_FILE_VERSION_RE.exec(href);
    if (!match) return;
    const version = match[1];

    const slot = classifySlotFromHref(href);
    if (!slot) return;

    const entry = (versions[version] ??= emptyDownloadLinks());
    if (!entry[slot]) entry[slot] = href;
  });

  return versions;
}

/**
 * Adds entries from `extra` that `base` does not already have. A build served
 * on the Stable or Unstable channel always wins over a preview listing.
 */
export function mergeVersionMaps(
  base: Record<string, DownloadLinks>,
  extra: Record<string, DownloadLinks>,
): Record<string, DownloadLinks> {
  const merged = { ...base };
  for (const [version, links] of Object.entries(extra)) {
    if (merged[version]) continue;
    merged[version] = links;
  }
  return merged;
}
