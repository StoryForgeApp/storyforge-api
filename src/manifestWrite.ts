// Manifest write path: resolve client-provided mod refs against moddb,
// persist structured rows, and trigger hash verification.

import type { BatchItem } from "drizzle-orm/batch";
import { eq, inArray } from "drizzle-orm";
import { db } from "./db";
import { moddbFile, modpackFile } from "./db/schema";
import { computeCompatibility } from "./manifest";
import { enqueueModFiles } from "./moddbWorker";
import {
  fetchModFromModDb,
  isAllowedModFileUrl,
  mapLimit,
  MODDB_CDN_HOST,
  normalizeFileUrl,
  type ModDbMod,
} from "./moddb";

export type ManifestModInput = {
  modId: number;
  releaseId?: number;
  fileId: number;
  url: string;
  filename?: string;
  required?: boolean;
  side?: "client" | "server" | "both";
  sortOrder?: number;
};

export type ResolvedFile = Omit<
  typeof modpackFile.$inferInsert,
  "id" | "modpackVersion"
>;

export class ManifestInputError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 | 422 = 400,
  ) {
    super(message);
    this.name = "ManifestInputError";
  }
}

/**
 * Resolves user-provided mod references against the upstream moddb API and
 * returns rows ready for insertion. Denormalized metadata is server-fetched;
 * only file selection, ordering, and flags come from the client.
 */
export async function resolveManifestMods(
  mods: ManifestModInput[],
  gameVersion: string | null,
): Promise<ResolvedFile[]> {
  const seenModIds = new Set<number>();
  const seenFileIds = new Set<number>();
  for (const mod of mods) {
    if (seenModIds.has(mod.modId)) {
      throw new ManifestInputError(`Duplicate modId ${mod.modId}`, 409);
    }
    seenModIds.add(mod.modId);
    if (seenFileIds.has(mod.fileId)) {
      throw new ManifestInputError(`Duplicate fileId ${mod.fileId}`, 409);
    }
    seenFileIds.add(mod.fileId);
  }

  const uniqueModIds = [...seenModIds];
  const fetched = await mapLimit(uniqueModIds, 5, fetchModFromModDb);
  const byModId = new Map<number, ModDbMod | null>();
  uniqueModIds.forEach((modId, index) => byModId.set(modId, fetched[index]));

  // Reuse cached hashes so already-verified files appear verified immediately.
  const cached = await db
    .select()
    .from(moddbFile)
    .where(inArray(moddbFile.fileId, [...seenFileIds]));
  const cacheByFileId = new Map(cached.map((row) => [row.fileId, row]));

  const rows: ResolvedFile[] = [];
  for (const input of mods) {
    const mod = byModId.get(input.modId);
    if (!mod) {
      throw new ManifestInputError(`Unknown modId ${input.modId}`, 400);
    }
    const release = mod.releases.find((r) => r.fileid === input.fileId);
    if (!release) {
      throw new ManifestInputError(
        `fileId ${input.fileId} not found for modId ${input.modId}`,
        400,
      );
    }
    if (!isAllowedModFileUrl(input.url)) {
      throw new ManifestInputError(
        `url for fileId ${input.fileId} must be an https://${MODDB_CDN_HOST} URL`,
        422,
      );
    }
    if (normalizeFileUrl(input.url) !== normalizeFileUrl(release.mainfile)) {
      throw new ManifestInputError(
        `url for fileId ${input.fileId} does not match the moddb CDN file`,
        422,
      );
    }

    const gameVersions =
      Array.isArray(release.tags) && release.tags.length > 0 ? release.tags : null;
    const cachedFile = cacheByFileId.get(input.fileId);
    const verified = cachedFile?.status === "ok";

    rows.push({
      modId: input.modId,
      modIdStr: release.modidstr ?? "",
      name: mod.name ?? "",
      modVersion: release.modversion ?? "",
      releaseId: release.releaseid ?? null,
      fileId: input.fileId,
      filename: input.filename ?? release.filename ?? "",
      url: release.mainfile,
      sha256: verified ? (cachedFile?.sha256 ?? null) : null,
      size: verified ? (cachedFile?.size ?? null) : null,
      side: input.side ?? mod.side ?? "both",
      required: input.required ?? true,
      gameVersions: gameVersions ? JSON.stringify(gameVersions) : null,
      compatible: computeCompatibility(gameVersion, gameVersions),
      sortOrder: input.sortOrder ?? 0,
    });
  }

  return rows;
}

/**
 * Atomically replaces all `modpack_file` rows for a version and enqueues
 * hash verification. Uses libsql `batch` so remote Turso stays consistent.
 */
export async function replaceManifestFiles(
  versionId: string,
  rows: ResolvedFile[],
): Promise<void> {
  const inserts = rows.map((row) => ({
    ...row,
    id: crypto.randomUUID(),
    modpackVersion: versionId,
  }));

  const queries: BatchItem<"sqlite">[] = [
    db.delete(modpackFile).where(eq(modpackFile.modpackVersion, versionId)),
  ];
  if (inserts.length > 0) {
    queries.push(db.insert(modpackFile).values(inserts));
  }
  await db.batch(queries as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);

  await enqueueModFiles(
    rows.map((row) => ({ fileId: row.fileId, url: row.url, filename: row.filename })),
  );
}
