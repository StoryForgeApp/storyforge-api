// Modpack manifest: canonical JSON, hashing, and assembly.
// Spec: docs/modpack-manifest.md

import { asc, eq, inArray } from "drizzle-orm";
import { db } from "./db";
import { moddbFile, modpack, modpackFile, modpackVersion } from "./db/schema";

export type ManifestMod = {
  modId: number;
  modIdStr: string;
  name: string;
  modVersion: string;
  releaseId: number | null;
  fileId: number;
  filename: string;
  url: string;
  sha256: string | null;
  size: number | null;
  side: string;
  required: boolean;
  sortOrder: number;
  gameVersions: string[] | null;
  compatible: boolean | null;
  verified: boolean;
};

export type ManifestConfigs = {
  url: string;
  sha256: string | null;
  size: number | null;
} | null;

export type ManifestV1 = {
  manifestVersion: 1;
  legacy: false;
  slug: string;
  name: string;
  version: string;
  gameVersion: string | null;
  publishedAt: string;
  manifestHash: string;
  generatedAt: string;
  mods: ManifestMod[];
  modConfigs: ManifestConfigs;
};

export type LegacyManifest = {
  manifestVersion: 0;
  legacy: true;
  slug: string;
  name: string;
  version: string;
  gameVersion: string | null;
  modsString: string | null;
  mods: [];
  modConfigs: ManifestConfigs;
};

export type Manifest = ManifestV1 | LegacyManifest;

type VersionRow = typeof modpackVersion.$inferSelect;
type FileRow = typeof modpackFile.$inferSelect;
type ModdbRow = typeof moddbFile.$inferSelect;

export function sha256Hex(input: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(input).digest("hex");
}

/**
 * Exact game-version membership. Pack targeting a pre-release line
 * (e.g. 1.21.0-rc.1) also matches other tags on the same base version.
 * Returns null when the mod release has no game-version snapshot.
 */
export function computeCompatibility(
  gameVersion: string | null,
  gameVersions: string[] | null,
): boolean | null {
  if (!gameVersions) return null;
  if (!gameVersion) return null;
  if (gameVersions.includes(gameVersion)) return true;
  if (gameVersion.includes("-")) {
    const base = gameVersion.split("-")[0];
    return gameVersions.some((tag) => tag.split("-")[0] === base);
  }
  return false;
}

function parseGameVersions(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((v) => typeof v === "string")
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function buildConfigs(version: VersionRow): ManifestConfigs {
  if (!version.modConfigsUrl) return null;
  return {
    url: version.modConfigsUrl,
    sha256: version.modConfigsSha256,
    size: version.modConfigsSize,
  };
}

function toManifestMod(file: FileRow, verified: boolean): ManifestMod {
  return {
    modId: file.modId,
    modIdStr: file.modIdStr,
    name: file.name,
    modVersion: file.modVersion,
    releaseId: file.releaseId,
    fileId: file.fileId,
    filename: file.filename,
    url: file.url,
    sha256: file.sha256,
    size: file.size,
    side: file.side,
    required: file.required,
    sortOrder: file.sortOrder,
    gameVersions: parseGameVersions(file.gameVersions),
    compatible: file.compatible,
    verified,
  };
}

function buildManifest(input: {
  pack: { slug: string; name: string };
  version: VersionRow;
  files: FileRow[];
  moddb: Map<number, ModdbRow>;
}): Manifest {
  const { pack, version, files, moddb } = input;

  // Legacy versions have no structured rows; keep the old contract intact.
  if (version.manifestVersion < 1) {
    return {
      manifestVersion: 0,
      legacy: true,
      slug: pack.slug,
      name: pack.name,
      version: version.version,
      gameVersion: version.gameVersion,
      modsString: version.modsString,
      mods: [],
      modConfigs: buildConfigs(version),
    };
  }

  const mods = [...files]
    .sort((a, b) => a.modId - b.modId || a.fileId - b.fileId)
    .map((file) => toManifestMod(file, moddb.get(file.fileId)?.status === "ok"));

  // Canonical hash input: fixed key order, sorted mods, no hash/generatedAt.
  const canonical = {
    manifestVersion: 1 as const,
    legacy: false as const,
    slug: pack.slug,
    name: pack.name,
    version: version.version,
    gameVersion: version.gameVersion,
    publishedAt: (version.createdAt ?? new Date()).toISOString(),
    mods,
    modConfigs: buildConfigs(version),
  };

  return {
    ...canonical,
    manifestHash: sha256Hex(JSON.stringify(canonical)),
    generatedAt: new Date().toISOString(),
  };
}

/** Loads a version by id and assembles its manifest (v1 or legacy). */
export async function getManifestForVersion(versionId: string): Promise<Manifest | null> {
  const version = (
    await db.select().from(modpackVersion).where(eq(modpackVersion.id, versionId)).limit(1)
  )[0];
  if (!version) return null;

  const pack = (
    await db.select().from(modpack).where(eq(modpack.id, version.modpack)).limit(1)
  )[0];
  if (!pack) return null;

  const files =
    version.manifestVersion >= 1
      ? await db
          .select()
          .from(modpackFile)
          .where(eq(modpackFile.modpackVersion, versionId))
          .orderBy(asc(modpackFile.modId))
      : [];

  const fileIds = files.map((f) => f.fileId);
  const cached = fileIds.length
    ? await db.select().from(moddbFile).where(inArray(moddbFile.fileId, fileIds))
    : [];
  const moddb = new Map(cached.map((row) => [row.fileId, row]));

  return buildManifest({ pack, version, files, moddb });
}

/** Recomputes and persists `manifest_hash`. Returns the fresh manifest. */
export async function recomputeManifestHash(versionId: string): Promise<Manifest | null> {
  const manifest = await getManifestForVersion(versionId);
  if (!manifest) return null;
  if (manifest.manifestVersion === 1) {
    await db
      .update(modpackVersion)
      .set({ manifestHash: manifest.manifestHash })
      .where(eq(modpackVersion.id, versionId));
  }
  return manifest;
}
