// Hash verification worker for mod files.
// Downloads each unique upstream file once, computes sha256/size, caches the
// result in `moddb_file`, and propagates it to every `modpack_file` row.

import { and, asc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { db } from "./db";
import { moddbFile, modpackFile } from "./db/schema";
import { mapLimit } from "./moddb";
import { recomputeManifestHash } from "./manifest";

export const MAX_VERIFY_ATTEMPTS = 5;
const BATCH_SIZE = 5;
const DOWNLOAD_TIMEOUT_MS = 120_000;

export type ModFileRef = { fileId: number; url: string; filename: string };

/** Upserts pending cache rows for file ids that are not verified yet. */
export async function enqueueModFiles(files: ModFileRef[]): Promise<void> {
  const unique = new Map<number, ModFileRef>();
  for (const file of files) {
    if (!unique.has(file.fileId)) unique.set(file.fileId, file);
  }
  if (unique.size === 0) return;

  const values = [...unique.values()].map((file) => ({
    fileId: file.fileId,
    url: file.url,
    filename: file.filename,
  }));

  const chunkSize = 100;
  for (let i = 0; i < values.length; i += chunkSize) {
    await db
      .insert(moddbFile)
      .values(values.slice(i, i + chunkSize))
      .onConflictDoUpdate({
        target: moddbFile.fileId,
        set: {
          url: sql`excluded.url`,
          filename: sql`excluded.filename`,
        },
      });
  }
}

type ModdbRow = typeof moddbFile.$inferSelect;

async function recordFailure(file: ModdbRow, error: unknown): Promise<void> {
  const attempts = file.attempts + 1;
  const terminal = attempts >= MAX_VERIFY_ATTEMPTS;
  await db
    .update(moddbFile)
    .set({
      attempts,
      status: terminal ? "failed" : "pending",
      lastAttemptAt: new Date(),
    })
    .where(eq(moddbFile.fileId, file.fileId));
  console.error(
    `[moddb] verify failed for fileId ${file.fileId} (attempt ${attempts}${terminal ? ", giving up" : ""}):`,
    error,
  );
}

async function verifyOne(file: ModdbRow): Promise<void> {
  const res = await fetch(file.url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} for ${file.url}`);
  }

  const hasher = new Bun.CryptoHasher("sha256");
  const reader = res.body.getReader();
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      hasher.update(value);
      size += value.byteLength;
    }
  }
  const sha256 = hasher.digest("hex");
  const verifiedAt = new Date();

  await db
    .update(moddbFile)
    .set({ status: "ok", sha256, size, verifiedAt, lastAttemptAt: verifiedAt })
    .where(eq(moddbFile.fileId, file.fileId));

  const affected = await db
    .update(modpackFile)
    .set({ sha256, size })
    .where(eq(modpackFile.fileId, file.fileId))
    .returning({ version: modpackFile.modpackVersion });

  const versionIds = [...new Set(affected.map((row) => row.version))];
  for (const versionId of versionIds) {
    await recomputeManifestHash(versionId);
  }

  console.log(`[moddb] verified fileId ${file.fileId} (${size} bytes, ${sha256.slice(0, 12)}…)`);
}

/**
 * Verifies up to `max` eligible pending/failed files per run.
 * Failed files retry with exponential backoff (2^attempts minutes, capped 60).
 */
export async function verifyPendingFiles(max = BATCH_SIZE): Promise<number> {
  const candidates = await db
    .select()
    .from(moddbFile)
    .where(
      or(
        eq(moddbFile.status, "pending"),
        and(eq(moddbFile.status, "failed"), lt(moddbFile.attempts, MAX_VERIFY_ATTEMPTS)),
      ),
    )
    .orderBy(asc(moddbFile.attempts), asc(moddbFile.fileId))
    .limit(100);

  const now = Date.now();
  const due = candidates
    .filter((file) => {
      if (file.attempts > 0 && file.lastAttemptAt) {
        const backoffMs = Math.min(2 ** file.attempts, 60) * 60_000;
        return now - file.lastAttemptAt.getTime() >= backoffMs;
      }
      return true;
    })
    .slice(0, max);

  if (due.length === 0) return 0;

  await mapLimit(due, BATCH_SIZE, async (file) => {
    try {
      await verifyOne(file);
    } catch (error) {
      await recordFailure(file, error);
    }
  });

  return due.length;
}
