// Upstream Vintage Story moddb client: fetch + helpers.
// API shape: https://mods.vintagestory.at/api/mod/:modid

export type ModDbRelease = {
  releaseid: number;
  fileid: number;
  filename: string;
  mainfile: string;
  modidstr: string;
  modversion: string;
  tags: string[];
  created: string;
};

export type ModDbMod = {
  modid: number;
  name: string;
  side: string | null;
  releases: ModDbRelease[];
};

export const MODDB_CDN_HOST = "moddbcdn.vintagestory.at";

const MODDB_API = "https://mods.vintagestory.at/api/mod";
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<number, { at: number; mod: ModDbMod | null }>();

/** Fetches mod metadata, with a small in-process TTL cache (negative caching included). */
export async function fetchModFromModDb(modId: number): Promise<ModDbMod | null> {
  const now = Date.now();
  const hit = cache.get(modId);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.mod;

  try {
    const res = await fetch(`${MODDB_API}/${modId}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      cache.set(modId, { at: now, mod: null });
      return null;
    }
    const json = (await res.json()) as { mod?: ModDbMod };
    const mod = json.mod && Array.isArray(json.mod.releases) ? json.mod : null;
    if (cache.size > 500) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(modId, { at: now, mod });
    return mod;
  } catch {
    cache.set(modId, { at: now, mod: null });
    return null;
  }
}

export function isAllowedModFileUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname === MODDB_CDN_HOST;
  } catch {
    return false;
  }
}

/** Strips query/hash for comparison (upstream CDN URLs carry `?dl=` suffixes). */
export function normalizeFileUrl(raw: string): string {
  const url = new URL(raw);
  return `${url.origin}${url.pathname}`;
}

/** Runs `fn` over `items` with bounded concurrency, preserving order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}
