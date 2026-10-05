import { createAuthEndpoint, getSessionFromCtx, sessionMiddleware } from "better-auth/api";
import type { BetterAuthPlugin } from "better-auth";
import { z } from "zod";
import { db } from "../db";
import { modpack, modpackVersion } from "../db/schema";
import { and, eq, exists, or, sql } from "drizzle-orm";
import { getManifestForVersion, recomputeManifestHash } from "../manifest";
import {
  ManifestInputError,
  replaceManifestFiles,
  resolveManifestMods,
  type ManifestModInput,
  type ResolvedFile,
} from "../manifestWrite";
import { checkLimit } from "../rateLimit";

// ─── R2 delete helper (upload is handled by Elysia route) ────────────

const R2_ACCOUNT_ID = Bun.env.R2_ACCOUNT_ID!;
const R2_ACCESS_KEY_ID = Bun.env.R2_ACCESS_KEY_ID!;
const R2_SECRET_ACCESS_KEY = Bun.env.R2_SECRET_ACCESS_KEY!;
const R2_BUCKET = Bun.env.R2_BUCKET!;

const s3 = new Bun.S3Client({
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  secretAccessKey: R2_SECRET_ACCESS_KEY,
  accessKeyId: R2_ACCESS_KEY_ID,
  bucket: R2_BUCKET,
});

function modpackConfigKey(slug: string, version: string): string {
  return `modpacks/${slug}/${version}/modconfigs.zip`;
}

async function r2DeleteModConfig(slug: string, version: string): Promise<void> {
  const key = modpackConfigKey(slug, version);
  await s3.delete(key);
}

const SemVer = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/,
    "Invalid semantic version",
  );

const ManifestModBody = z.object({
  modId: z.number().int().positive(),
  releaseId: z.number().int().positive().optional(),
  fileId: z.number().int().positive(),
  url: z.string().min(1),
  filename: z.string().optional(),
  required: z.boolean().optional(),
  side: z.enum(["client", "server", "both"]).optional(),
  sortOrder: z.number().int().optional(),
});

const ManifestModsBody = z.array(ManifestModBody).min(1).max(500);

type ErrorCtx = {
  error: (status: any, body?: { message?: string }) => any;
};

function manifestErrorResponse(ctx: ErrorCtx, error: unknown): any {
  if (error instanceof ManifestInputError) {
    const status =
      error.status === 409
        ? "CONFLICT"
        : error.status === 422
          ? "UNPROCESSABLE_ENTITY"
          : "BAD_REQUEST";
    return ctx.error(status, { message: error.message });
  }
  throw error;
}

/** Resolves a pack + version from route params (drizzle, not the auth adapter). */
async function resolvePackAndVersion(params: { slug: string; version: string }) {
  const pack = (
    await db.select().from(modpack).where(eq(modpack.slug, params.slug)).limit(1)
  )[0];
  if (!pack) return null;
  const version = (
    await db
      .select()
      .from(modpackVersion)
      .where(and(eq(modpackVersion.modpack, pack.id), eq(modpackVersion.version, params.version)))
      .limit(1)
  )[0];
  if (!version) return null;
  return { pack, version };
}

/** Persists structured manifest fields + rows; returns whether anything changed. */
async function applyManifestWrite(
  versionId: string,
  mods: ManifestModInput[] | undefined,
  gameVersion: string | null,
  extra: Record<string, unknown>,
): Promise<boolean> {
  let resolvedRows: ResolvedFile[] | null = null;
  if (mods) {
    resolvedRows = await resolveManifestMods(mods, gameVersion);
    extra.manifestVersion = 1;
  }
  if (resolvedRows) {
    await replaceManifestFiles(versionId, resolvedRows);
  }
  if (Object.keys(extra).length > 0) {
    await db.update(modpackVersion).set(extra).where(eq(modpackVersion.id, versionId));
  }
  if (resolvedRows) {
    await recomputeManifestHash(versionId);
  }
  return resolvedRows != null || Object.keys(extra).length > 0;
}

// ─── Plugin ─────────────────────────────────────────────────────────

type Modpack = {
  id: string;
  slug: string;
  name: string;
  description: string;
  imageUrl?: string;
  owner: string;
  createdAt: Date;
  updatedAt: Date;
  modpackVersions: ModpackVersion[];
};

type ModpackVersion = {
  id: string;
  version: string;
  gameVersion: string;
  modConfigsUrl: string;
  downloads: number;
  modpack: string;
  createdAt: Date;
  updatedAt: Date;
};

export const modpacks: BetterAuthPlugin = {
  schema: {
    modpack: {
      fields: {
        slug: {
          type: "string",
          unique: true,
        },
        name: {
          type: "string",
        },
        description: {
          type: "string",
        },
        imageUrl: {
          type: "string",
          required: false,
        },
        owner: {
          type: "string",
          references: {
            model: "user",
            field: "id",
            onDelete: "set null",
          },
        },
        public: {
          type: "boolean",
          defaultValue: true,
        },
        createdAt: {
          type: "date",
          required: true,
          defaultValue: () => new Date(),
        },
        updatedAt: {
          type: "date",
          required: false,
          onUpdate: () => new Date(),
        },
      },
      modelName: "modpack",
    },
    modpackVersion: {
      fields: {
        version: {
          type: "string",
        },
        modConfigsUrl: {
          type: "string",
          required: false,
        },
        modsString: {
          type: "string",
          required: false,
        },
        gameVersion: {
          type: "string",
          required: false,
        },
        downloads: {
          type: "number",
          bigint: true,
          defaultValue: 0,
        },
        imageUrl: {
          type: "string",
          required: false,
        },
        modpack: {
          type: "string",
          references: {
            model: "modpack",
            field: "id",
            onDelete: "cascade",
          },
        },
        createdAt: {
          type: "date",
          required: true,
          defaultValue: () => new Date(),
        },
        updatedAt: {
          type: "date",
          required: false,
          onUpdate: () => new Date(),
        },
      },
      modelName: "modpackVersion",
    },
  },
  endpoints: {
    // ── Modpack CRUD ──────────────────────────────────────────────

    getModpacks: createAuthEndpoint(
      "/modpacks",
      {
        metadata: {
          openapi: {
            description: "Returns the list of available modpacks",
            responses: {
              200: {
                content: {
                  "application/json": {
                    schema: {
                      description: "List of available modpacks",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          slug: { type: "string" },
                          name: { type: "string" },
                          description: { type: "string" },
                          imageUrl: { type: "string" },
                          downloads: { type: "number" },
                          owner: {
                            type: "object",
                            properties: {
                              id: { type: "string" },
                              name: { type: "string" },
                              image: { type: "string" },
                            },
                          },
                          createdAt: { type: "string" },
                        },
                      },
                      type: "array",
                    },
                  },
                },
                description: "Success",
              },
            },
          },
        },
        method: "GET",
      },
      async (ctx) => {
        const session = await getSessionFromCtx(ctx);

        // Current session user (may be null for unauthenticated requests)
        const sessionUserId = session?.user?.id ?? null;

        const downloadsSubquery = sql<number>`
          COALESCE(
            (SELECT SUM(${modpackVersion.downloads})
             FROM ${modpackVersion}
             WHERE ${modpackVersion.modpack} = "modpack"."id"
            ), 0
          )
        `;

        const where =
          // Always require versions — except for the current user's own modpacks
          or(
            and(
              exists(
                db.select().from(modpackVersion).where(eq(modpack.id, modpackVersion.modpack)),
              ),
              eq(modpack.public, true),
            ),
            sessionUserId ? eq(modpack.owner, sessionUserId) : undefined,
          );

        const totalCount = await db.$count(modpack, where);

        const allModpacks = await db.query.modpack.findMany({
          orderBy: (table, { desc }) => desc(table.updatedAt),
          where,
          with: {
            user: true,
            modpackVersions: true,
          },
          extras: {
            downloads: downloadsSubquery.as("downloads"),
          },
        });

        let result = allModpacks.map((m) => ({
          ...m,
          owner: m.user ? { id: m.user.id, name: m.user.name, image: m.user.image } : null,
          user: undefined,
        }));

        return ctx.json({ totalCount, modpacks: result });
      },
    ),

    getModpack: createAuthEndpoint(
      "/modpacks/:slug",
      {
        method: "GET",
        metadata: {
          openapi: {
            description: "Returns a single modpack by its slug",
            parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
            responses: {
              200: {
                description: "Modpack found",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        slug: { type: "string" },
                        name: { type: "string" },
                        description: { type: "string" },
                        imageUrl: { type: "string" },
                        downloads: { type: "number" },
                        owner: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            name: { type: "string" },
                            image: { type: "string" },
                          },
                        },
                        modpackVersions: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              id: { type: "string" },
                              version: { type: "string" },
                              downloads: { type: "number" },
                            },
                          },
                        },
                        createdAt: { type: "string", format: "date-time" },
                        updatedAt: { type: "string", format: "date-time" },
                      },
                    },
                  },
                },
              },
              404: { description: "Modpack not found" },
            },
          },
        },
      },
      async (ctx) => {
        const modpack = (await ctx.context.adapter.findOne({
          model: "modpack",
          where: [{ field: "slug", value: ctx.params.slug, operator: "eq" }],
          join: { user: true },
        })) as any;
        if (!modpack) return ctx.error("NOT_FOUND");

        const versions = (await ctx.context.adapter.findMany({
          model: "modpackVersion",
          where: [{ field: "modpack", value: modpack.id, operator: "eq" }],
        })) as any[];
        const downloads = versions.reduce((sum: number, v: any) => sum + (v.downloads || 0), 0);
        const { user: _, ...modpackClean } = modpack;
        const owner = modpack.user
          ? { id: modpack.user.id, name: modpack.user.name, image: modpack.user.image }
          : null;

        return ctx.json({ ...modpackClean, owner, downloads, modpackVersions: versions });
      },
    ),

    createModpack: createAuthEndpoint(
      "/modpacks",
      {
        method: "POST",
        body: z.object({
          slug: z.string(),
          name: z.string(),
          description: z.string().optional(),
          imageUrl: z
            .url()
            .refine(
              (url) =>
                url.startsWith("https://") && new URL(url).hostname === "moddbcdn.vintagestory.at",
            )
            .optional(),
        }),
        use: [sessionMiddleware],
        metadata: {
          openapi: {
            description: "Creates a new modpack. Requires authentication.",
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      slug: { type: "string" },
                      name: { type: "string" },
                      description: { type: "string" },
                      imageUrl: { type: "string" },
                    },
                    required: ["slug", "name"],
                  },
                },
              },
            },
            responses: {
              200: {
                description: "Modpack created",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        slug: { type: "string" },
                        name: { type: "string" },
                        description: { type: "string" },
                        imageUrl: { type: "string" },
                        downloads: { type: "number" },
                        owner: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            name: { type: "string" },
                            image: { type: "string" },
                          },
                        },
                        createdAt: { type: "string", format: "date-time" },
                      },
                    },
                  },
                },
              },
              401: { description: "Unauthorized – session required" },
              409: { description: "Conflict – slug already exists" },
            },
          },
        },
      },
      async (ctx) => {
        if (!ctx.context.session) return ctx.error("UNAUTHORIZED");

        // Check for duplicate slug
        const existing = await ctx.context.adapter.findOne({
          model: "modpack",
          where: [{ field: "slug", value: ctx.body.slug, operator: "eq" }],
        });
        if (existing)
          return ctx.error("CONFLICT", { message: "A modpack with this slug already exists" });

        const created = (await ctx.context.adapter.create({
          model: "modpack",
          data: {
            slug: ctx.body.slug,
            name: ctx.body.name,
            description: ctx.body.description ?? "",
            imageUrl: ctx.body.imageUrl,
            owner: ctx.context.session.user.id,
          },
        })) as any;
        const owner = {
          id: ctx.context.session.user.id,
          name: ctx.context.session.user.name,
          image: ctx.context.session.user.image,
        };
        return ctx.json({
          ...created,
          owner,
          downloads: 0,
        });
      },
    ),

    removeModpack: createAuthEndpoint(
      "/modpacks/:slug",
      {
        method: "DELETE",
        use: [sessionMiddleware],
        metadata: {
          openapi: {
            description:
              "Deletes a modpack and all its versions (cascading). Requires authentication and ownership.",
            parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
            responses: {
              200: { description: "Modpack deleted" },
              401: { description: "Unauthorized – session required" },
              404: { description: "Modpack not found" },
            },
          },
        },
      },
      async (ctx) => {
        if (!ctx.context.session) return ctx.error("UNAUTHORIZED");
        return ctx.json(
          ctx.context.adapter.delete({
            model: "modpack",
            where: [
              {
                field: "slug",
                value: ctx.params.slug,
                operator: "eq",
                connector: "AND",
              },
              {
                field: "owner",
                value: ctx.context.session.user.id,
                operator: "eq",
              },
            ],
          }),
        );
      },
    ),

    modifyModpack: createAuthEndpoint(
      "/modpacks/:slug",
      {
        method: "PUT",
        body: z.object({
          name: z.string().optional(),
          description: z.string().optional(),
          imageUrl: z
            .url()
            .refine(
              (url) =>
                url.startsWith("https://") && new URL(url).hostname === "moddbcdn.vintagestory.at",
            )
            .optional(),
        }),
        use: [sessionMiddleware],
        metadata: {
          openapi: {
            description:
              "Updates a modpack's metadata. Requires authentication and ownership. All fields are optional – only provided fields are updated.",
            parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      description: { type: "string" },
                      imageUrl: { type: "string" },
                    },
                  },
                },
              },
            },
            responses: {
              200: {
                description: "Modpack updated",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        slug: { type: "string" },
                        name: { type: "string" },
                        description: { type: "string" },
                        imageUrl: { type: "string" },
                        downloads: { type: "number" },
                        owner: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            name: { type: "string" },
                            image: { type: "string" },
                          },
                        },
                        createdAt: { type: "string", format: "date-time" },
                        updatedAt: { type: "string", format: "date-time" },
                      },
                    },
                  },
                },
              },
              401: { description: "Unauthorized – session required or not the owner" },
              404: { description: "Modpack not found" },
              409: { description: "Conflict – slug already exists" },
            },
          },
        },
      },
      async (ctx) => {
        if (!ctx.context.session) return ctx.error("UNAUTHORIZED");

        await ctx.context.adapter.update({
          model: "modpack",
          where: [
            { field: "slug", value: ctx.params.slug, operator: "eq", connector: "AND" },
            { field: "owner", value: ctx.context.session.user.id, operator: "eq" },
          ],
          update: ctx.body,
        });

        // Re-fetch with user join and compute downloads
        const modpack = (await ctx.context.adapter.findOne({
          model: "modpack",
          where: [{ field: "slug", value: ctx.params.slug, operator: "eq" }],
          join: { user: true },
        })) as any;
        if (!modpack) return ctx.error("NOT_FOUND");

        const versions = (await ctx.context.adapter.findMany({
          model: "modpackVersion",
          where: [{ field: "modpack", value: modpack.id, operator: "eq" }],
        })) as any[];
        const downloads = versions.reduce((sum: number, v: any) => sum + (v.downloads || 0), 0);

        const { user: _, ...modpackClean } = modpack;
        const owner = modpack.user
          ? { id: modpack.user.id, name: modpack.user.name, image: modpack.user.image }
          : null;

        return ctx.json({ ...modpackClean, owner, downloads });
      },
    ),

    // ── Slug availability ────────────────────────────────────────

    checkSlug: createAuthEndpoint(
      "/modpacks/slug-availability",
      {
        method: "GET",
        query: z.object({
          slug: z.string(),
        }),
        metadata: {
          openapi: {
            description:
              "Checks whether a modpack slug is available. If taken, returns up to 5 alternatives.",
            parameters: [{ name: "slug", in: "query", required: true, schema: { type: "string" } }],
            responses: {
              200: {
                description: "Slug availability result",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        available: { type: "boolean" },
                        suggestion: { type: "string" },
                        alternatives: {
                          type: "array",
                          items: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      async (ctx) => {
        const slug = ctx.query.slug.trim();

        // Check exact match
        const exact = await ctx.context.adapter.findOne({
          model: "modpack",
          where: [{ field: "slug", value: slug, operator: "eq" }],
        });
        if (!exact) return ctx.json({ available: true });

        // Slug is taken — find alternatives by appending number suffixes
        const alternatives: string[] = [];
        for (let i = 1; alternatives.length < 5 && i < 100; i++) {
          const candidate = `${slug}-${i}`;
          const exists = await ctx.context.adapter.findOne({
            model: "modpack",
            where: [{ field: "slug", value: candidate, operator: "eq" }],
          });
          if (!exists) alternatives.push(candidate);
        }

        return ctx.json({
          available: false,
          suggestion: alternatives[0] ?? null,
          alternatives,
        });
      },
    ),

    // ── Modpack Version CRUD ──────────────────────────────────────

    getModpackVersions: createAuthEndpoint(
      "/modpacks/:slug/versions",
      {
        method: "GET",
        query: z.object({
          limit: z.coerce.number().optional(),
          offset: z.coerce.number().optional(),
          sortBy: z.string().optional(),
          order: z.enum(["asc", "desc"]).optional(),
        }),
        metadata: {
          openapi: {
            description:
              "Returns all versions of a modpack, sorted by creation date (newest first by default).",
            parameters: [
              { name: "slug", in: "path", required: true, schema: { type: "string" } },
              { name: "limit", in: "query", required: false, schema: { type: "number" } },
              { name: "offset", in: "query", required: false, schema: { type: "number" } },
              { name: "sortBy", in: "query", required: false, schema: { type: "string" } },
              {
                name: "order",
                in: "query",
                required: false,
                schema: { type: "string", enum: ["asc", "desc"] },
              },
            ],
            responses: {
              200: {
                description: "Version list",
                content: {
                  "application/json": {
                    schema: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          version: { type: "string" },
                          gameVersion: { type: "string" },
                          modsString: { type: "string" },
                          modConfigsUrl: { type: "string" },
                          downloads: { type: "number" },
                          imageUrl: { type: "string" },
                          modpack: { type: "string" },
                          createdAt: { type: "string", format: "date-time" },
                          updatedAt: { type: "string", format: "date-time" },
                        },
                      },
                    },
                  },
                },
              },
              404: { description: "Modpack not found" },
            },
          },
        },
      },
      async (ctx) => {
        // Resolve modpack by slug
        const modpack = await ctx.context.adapter.findOne<Modpack>({
          model: "modpack",
          where: [{ field: "slug", value: ctx.params.slug, operator: "eq" }],
        });
        if (!modpack) return ctx.error("NOT_FOUND", { message: "Modpack not found" });

        return ctx.json(
          ctx.context.adapter.findMany<ModpackVersion>({
            model: "modpackVersion",
            limit: ctx.query.limit,
            offset: ctx.query.offset,
            sortBy: {
              field: ctx.query.sortBy ?? "createdAt",
              direction: ctx.query.order ?? "desc",
            },
            where: [
              {
                field: "modpack",
                value: modpack.id,
                operator: "eq",
              },
            ],
          }),
        );
      },
    ),

    getModpackVersion: createAuthEndpoint(
      "/modpacks/:slug/versions/:version",
      {
        method: "GET",
        metadata: {
          openapi: {
            description: "Returns a specific version of a modpack.",
            parameters: [
              { name: "slug", in: "path", required: true, schema: { type: "string" } },
              { name: "version", in: "path", required: true, schema: { type: "string" } },
            ],
            responses: {
              200: {
                description: "Version found",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        version: { type: "string" },
                        gameVersion: { type: "string" },
                        modsString: { type: "string" },
                        modConfigsUrl: { type: "string" },
                        downloads: { type: "number" },
                        imageUrl: { type: "string" },
                        modpack: { type: "string" },
                        createdAt: { type: "string", format: "date-time" },
                        updatedAt: { type: "string", format: "date-time" },
                      },
                    },
                  },
                },
              },
              404: { description: "Modpack not found" },
            },
          },
        },
      },
      async (ctx) => {
        const modpack = await ctx.context.adapter.findOne<Modpack>({
          model: "modpack",
          where: [{ field: "slug", value: ctx.params.slug, operator: "eq" }],
        });
        if (!modpack) return ctx.error("NOT_FOUND", { message: "Modpack not found" });

        return ctx.json(
          ctx.context.adapter.findOne<ModpackVersion>({
            model: "modpackVersion",
            where: [
              { field: "modpack", value: modpack.id, operator: "eq", connector: "AND" },
              { field: "version", value: ctx.params.version, operator: "eq" },
            ],
          }),
        );
      },
    ),

    getModpackManifest: createAuthEndpoint(
      "/modpacks/:slug/versions/:version/manifest",
      {
        method: "GET",
        metadata: {
          openapi: {
            description:
              "Returns the structured manifest for a modpack version. " +
              "Structured manifests (manifestVersion 1) include mod file URLs, sha256 hashes, and sizes. " +
              "Legacy versions return manifestVersion 0 with the original modsString passthrough. " +
              "Private modpacks are only visible to their owner.",
            parameters: [
              { name: "slug", in: "path", required: true, schema: { type: "string" } },
              { name: "version", in: "path", required: true, schema: { type: "string" } },
            ],
            responses: {
              200: { description: "Manifest found" },
              304: { description: "Not modified (ETag match)" },
              404: { description: "Modpack or version not found" },
            },
          },
        },
      },
      async (ctx) => {
        const found = await resolvePackAndVersion(ctx.params);
        if (!found) return ctx.error("NOT_FOUND", { message: "Version not found" });
        const { pack, version } = found;

        const session = await getSessionFromCtx(ctx);
        const isOwner = session?.user?.id === pack.owner;
        if (!pack.public && !isOwner) {
          return ctx.error("NOT_FOUND", { message: "Version not found" });
        }

        const manifest = await getManifestForVersion(version.id);
        if (!manifest) return ctx.error("NOT_FOUND", { message: "Version not found" });

        const cacheControl = pack.public ? "public, max-age=300" : "private, no-store";
        if (manifest.manifestVersion === 1) {
          const etag = `"sha256-${manifest.manifestHash}"`;
          if (ctx.request?.headers.get("if-none-match") === etag) {
            return new Response(null, {
              status: 304,
              headers: { ETag: etag, "Cache-Control": cacheControl },
            });
          }
          return ctx.json(manifest, {
            headers: { ETag: etag, "Cache-Control": cacheControl },
          });
        }
        return ctx.json(manifest, { headers: { "Cache-Control": cacheControl } });
      },
    ),

    putModpackManifest: createAuthEndpoint(
      "/modpacks/:slug/versions/:version/manifest",
      {
        method: "PUT",
        use: [sessionMiddleware],
        body: z.object({
          mods: ManifestModsBody,
          changelog: z.string().max(10_000).optional(),
        }),
        metadata: {
          openapi: {
            description:
              "Replaces the structured manifest of a modpack version. Requires ownership. " +
              "Mod metadata (name, version, filename, game versions) is resolved server-side from " +
              "the moddb API and validated against the moddb CDN. Hash verification is queued.",
            parameters: [
              { name: "slug", in: "path", required: true, schema: { type: "string" } },
              { name: "version", in: "path", required: true, schema: { type: "string" } },
            ],
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["mods"],
                    properties: {
                      mods: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            modId: { type: "number" },
                            releaseId: { type: "number" },
                            fileId: { type: "number" },
                            url: { type: "string" },
                            filename: { type: "string" },
                            required: { type: "boolean" },
                            side: { type: "string", enum: ["client", "server", "both"] },
                            sortOrder: { type: "number" },
                          },
                          required: ["modId", "fileId", "url"],
                        },
                      },
                      changelog: { type: "string" },
                    },
                  },
                },
              },
            },
            responses: {
              200: { description: "Manifest replaced and returned" },
              400: { description: "Unknown modId or fileId" },
              401: { description: "Unauthorized – session required or not the owner" },
              404: { description: "Modpack or version not found" },
              409: { description: "Duplicate modId or fileId" },
              422: { description: "URL host not allowed or does not match moddb" },
              429: { description: "Rate limited" },
            },
          },
        },
      },
      async (ctx) => {
        if (!ctx.context.session) return ctx.error("UNAUTHORIZED");
        const userId = ctx.context.session.user.id;

        const rl = await checkLimit("manifest:write", userId, 30, 60);
        if (!rl.allowed) {
          return ctx.error("TOO_MANY_REQUESTS", { message: "Too many manifest updates" });
        }

        const found = await resolvePackAndVersion(ctx.params);
        if (!found) return ctx.error("NOT_FOUND", { message: "Version not found" });
        const { pack, version } = found;
        if (pack.owner !== userId) return ctx.error("UNAUTHORIZED");

        try {
          const extra: Record<string, unknown> = {};
          if (ctx.body.changelog != null) extra.changelog = ctx.body.changelog;
          await applyManifestWrite(
            version.id,
            ctx.body.mods,
            version.gameVersion ?? null,
            extra,
          );
          const manifest = await recomputeManifestHash(version.id);
          return ctx.json(manifest ?? { ok: true });
        } catch (error) {
          return manifestErrorResponse(ctx, error);
        }
      },
    ),

    incrementDownload: createAuthEndpoint(
      "/modpacks/:slug/versions/:version/download",
      {
        method: "POST",
        metadata: {
          openapi: {
            description:
              "Increments the download count for a modpack version by 1. Returns the updated version.",
            parameters: [
              { name: "slug", in: "path", required: true, schema: { type: "string" } },
              { name: "version", in: "path", required: true, schema: { type: "string" } },
            ],
            responses: {
              200: {
                description: "Download count incremented",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        version: { type: "string" },
                        gameVersion: { type: "string" },
                        downloads: { type: "number" },
                      },
                    },
                  },
                },
              },
              404: { description: "Modpack or version not found" },
            },
          },
        },
      },
      async (ctx) => {
        const modpack = await ctx.context.adapter.findOne<Modpack>({
          model: "modpack",
          where: [{ field: "slug", value: ctx.params.slug, operator: "eq" }],
        });
        if (!modpack) return ctx.error("NOT_FOUND", { message: "Modpack not found" });

        const version = await ctx.context.adapter.findOne<ModpackVersion>({
          model: "modpackVersion",
          where: [
            { field: "modpack", value: modpack.id, operator: "eq", connector: "AND" },
            { field: "version", value: ctx.params.version, operator: "eq" },
          ],
        });
        if (!version) return ctx.error("NOT_FOUND", { message: "Version not found" });

        const updated = await ctx.context.adapter.update<ModpackVersion>({
          model: "modpackVersion",
          where: [
            { field: "modpack", value: modpack.id, operator: "eq", connector: "AND" },
            { field: "version", value: ctx.params.version, operator: "eq" },
          ],
          update: {
            downloads: (version.downloads || 0) + 1,
          },
        });

        return ctx.json(updated);
      },
    ),

    createModpackVersion: createAuthEndpoint(
      "/modpacks/:slug/versions",
      {
        method: "POST",
        use: [sessionMiddleware],
        body: z.object({
          version: SemVer,
          gameVersion: SemVer,
          modsString: z.string().optional(),
          mods: ManifestModsBody.optional(),
          changelog: z.string().max(10_000).optional(),
          modConfigsUrl: z.string().optional(),
          modConfigsSha256: z.string().optional(),
          modConfigsSize: z.number().int().nonnegative().optional(),
          imageUrl: z.string().optional(),
        }),
        metadata: {
          openapi: {
            description:
              "Creates a new version for a modpack. Requires authentication and ownership. " +
              "Upload modConfig files via POST /api/modpacks/:slug/versions/upload first, then pass the returned URL as modConfigsUrl.",
            parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      version: { type: "string" },
                      gameVersion: { type: "string" },
                      modsString: { type: "string" },
                      modConfigsUrl: { type: "string", description: "R2 URL from upload endpoint" },
                      imageUrl: { type: "string" },
                    },
                    required: ["version"],
                  },
                },
              },
            },
            responses: {
              200: {
                description: "Version created",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        version: { type: "string" },
                        gameVersion: { type: "string" },
                        modsString: { type: "string" },
                        modConfigsUrl: { type: "string" },
                        downloads: { type: "number" },
                        imageUrl: { type: "string" },
                        modpack: { type: "string" },
                        createdAt: { type: "string", format: "date-time" },
                      },
                    },
                  },
                },
              },
              401: { description: "Unauthorized – session required or not the owner" },
              404: { description: "Modpack not found" },
              409: { description: "Version already exists for this modpack" },
            },
          },
        },
      },
      async (ctx) => {
        if (!ctx.context.session) return ctx.error("UNAUTHORIZED");
        const userId = ctx.context.session.user.id;

        const rl = await checkLimit("modpack:version:write", userId, 10, 60);
        if (!rl.allowed) {
          return ctx.error("TOO_MANY_REQUESTS", { message: "Too many version writes" });
        }

        const modpack = await ctx.context.adapter.findOne<Modpack>({
          model: "modpack",
          where: [{ field: "slug", value: ctx.params.slug, operator: "eq" }],
        });
        if (!modpack) return ctx.error("NOT_FOUND", { message: "Modpack not found" });
        if (modpack.owner !== userId)
          return ctx.error("UNAUTHORIZED", { message: "You must own the modpack" });

        // Check for duplicate version
        const existing = await ctx.context.adapter.findOne({
          model: "modpackVersion",
          where: [
            { field: "modpack", value: modpack.id, operator: "eq", connector: "AND" },
            { field: "version", value: ctx.body.version, operator: "eq" },
          ],
        });
        if (existing)
          return ctx.error("CONFLICT", { message: "This version already exists for this modpack" });

        let resolvedRows: ResolvedFile[] | null = null;
        try {
          if (ctx.body.mods) {
            resolvedRows = await resolveManifestMods(ctx.body.mods, ctx.body.gameVersion ?? null);
          }
        } catch (error) {
          return manifestErrorResponse(ctx, error);
        }

        const result = (await ctx.context.adapter.create({
          model: "modpackVersion",
          data: {
            version: ctx.body.version,
            gameVersion: ctx.body.gameVersion ?? "",
            modsString: ctx.body.modsString ?? "",
            modConfigsUrl: ctx.body.modConfigsUrl ?? "",
            imageUrl: ctx.body.imageUrl,
            modpack: modpack.id,
          },
        })) as { id?: string } | null;

        const versionId = result?.id;
        if (!versionId) return ctx.json(result);

        const extra: Record<string, unknown> = {};
        if (resolvedRows) extra.manifestVersion = 1;
        if (ctx.body.changelog != null) extra.changelog = ctx.body.changelog;
        if (ctx.body.modConfigsSha256 != null) {
          extra.modConfigsSha256 = ctx.body.modConfigsSha256;
        }
        if (ctx.body.modConfigsSize != null) {
          extra.modConfigsSize = ctx.body.modConfigsSize;
        }

        if (resolvedRows) await replaceManifestFiles(versionId, resolvedRows);
        if (Object.keys(extra).length > 0) {
          await db.update(modpackVersion).set(extra).where(eq(modpackVersion.id, versionId));
        }
        if (resolvedRows) await recomputeManifestHash(versionId);

        const fresh = (
          await db.select().from(modpackVersion).where(eq(modpackVersion.id, versionId)).limit(1)
        )[0];
        return ctx.json(fresh ?? result);
      },
    ),

    updateModpackVersion: createAuthEndpoint(
      "/modpacks/:slug/versions/:version",
      {
        method: "PUT",
        use: [sessionMiddleware],
        body: z.object({
          version: SemVer.optional(),
          gameVersion: SemVer.optional(),
          modsString: z.string().optional(),
          mods: ManifestModsBody.optional(),
          changelog: z.string().max(10_000).optional(),
          modConfigsUrl: z.string().optional(),
          modConfigsSha256: z.string().optional(),
          modConfigsSize: z.number().int().nonnegative().optional(),
          imageUrl: z.string().optional(),
        }),
        metadata: {
          openapi: {
            description:
              "Updates a modpack version. Requires authentication and ownership. " +
              "All fields are optional – only provided fields are updated.",
            parameters: [
              { name: "slug", in: "path", required: true, schema: { type: "string" } },
              { name: "version", in: "path", required: true, schema: { type: "string" } },
            ],
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      version: { type: "string", description: "New version identifier" },
                      gameVersion: { type: "string" },
                      modsString: { type: "string" },
                      modConfigsUrl: { type: "string", description: "R2 URL from upload endpoint" },
                      imageUrl: { type: "string" },
                    },
                  },
                },
              },
            },
            responses: {
              200: { description: "Version updated" },
              401: { description: "Unauthorized – session required or not the owner" },
              404: { description: "Modpack or version not found" },
              409: { description: "Version rename conflicts with existing version" },
            },
          },
        },
      },
      async (ctx) => {
        if (!ctx.context.session) return ctx.error("UNAUTHORIZED");
        const userId = ctx.context.session.user.id;

        const rl = await checkLimit("modpack:version:write", userId, 10, 60);
        if (!rl.allowed) {
          return ctx.error("TOO_MANY_REQUESTS", { message: "Too many version writes" });
        }

        const modpack = await ctx.context.adapter.findOne<Modpack>({
          model: "modpack",
          where: [{ field: "slug", value: ctx.params.slug, operator: "eq" }],
        });
        if (!modpack) return ctx.error("NOT_FOUND", { message: "Modpack not found" });
        if (modpack.owner !== userId) return ctx.error("UNAUTHORIZED");

        const versionRecord = await ctx.context.adapter.findOne({
          model: "modpackVersion",
          where: [
            { field: "modpack", value: modpack.id, operator: "eq", connector: "AND" },
            { field: "version", value: ctx.params.version, operator: "eq" },
          ],
        });
        if (!versionRecord) return ctx.error("NOT_FOUND", { message: "Version not found" });

        const currentVersion = versionRecord as {
          id: string;
          gameVersion?: string | null;
        };

        const update: Record<string, unknown> = {};

        if (ctx.body.modsString != null) update.modsString = ctx.body.modsString;
        if (ctx.body.imageUrl != null) update.imageUrl = ctx.body.imageUrl;
        if (ctx.body.gameVersion != null) update.gameVersion = ctx.body.gameVersion;
        if (ctx.body.modConfigsUrl != null) update.modConfigsUrl = ctx.body.modConfigsUrl;

        if (ctx.body.version != null && ctx.body.version !== ctx.params.version) {
          const dup = await ctx.context.adapter.findOne({
            model: "modpackVersion",
            where: [
              { field: "modpack", value: modpack.id, operator: "eq", connector: "AND" },
              { field: "version", value: ctx.body.version, operator: "eq" },
            ],
          });
          if (dup)
            return ctx.error("CONFLICT", { message: "A version with that name already exists" });
          update.version = ctx.body.version;
        }

        // Structured fields go through drizzle: better-auth's adapter drops
        // columns not declared in the plugin schema.
        const extra: Record<string, unknown> = {};
        let resolvedRows: ResolvedFile[] | null = null;
        if (ctx.body.mods) {
          try {
            resolvedRows = await resolveManifestMods(
              ctx.body.mods,
              ctx.body.gameVersion ?? currentVersion.gameVersion ?? null,
            );
          } catch (error) {
            return manifestErrorResponse(ctx, error);
          }
          extra.manifestVersion = 1;
        }
        if (ctx.body.changelog != null) extra.changelog = ctx.body.changelog;
        if (ctx.body.modConfigsSha256 != null) {
          extra.modConfigsSha256 = ctx.body.modConfigsSha256;
        }
        if (ctx.body.modConfigsSize != null) {
          extra.modConfigsSize = ctx.body.modConfigsSize;
        }

        if (Object.keys(update).length === 0 && Object.keys(extra).length === 0) {
          return ctx.json(versionRecord);
        }

        if (Object.keys(update).length > 0) {
          await ctx.context.adapter.update<ModpackVersion>({
            model: "modpackVersion",
            where: [
              { field: "modpack", value: modpack.id, operator: "eq", connector: "AND" },
              { field: "version", value: ctx.params.version, operator: "eq" },
            ],
            update,
          });
        }

        if (resolvedRows) await replaceManifestFiles(currentVersion.id, resolvedRows);
        if (Object.keys(extra).length > 0) {
          await db
            .update(modpackVersion)
            .set(extra)
            .where(eq(modpackVersion.id, currentVersion.id));
        }
        if (resolvedRows) await recomputeManifestHash(currentVersion.id);

        const fresh = (
          await db
            .select()
            .from(modpackVersion)
            .where(eq(modpackVersion.id, currentVersion.id))
            .limit(1)
        )[0];
        return ctx.json(fresh ?? versionRecord);
      },
    ),

    deleteModpackVersion: createAuthEndpoint(
      "/modpacks/:slug/versions/:version",
      {
        method: "DELETE",
        use: [sessionMiddleware],
        metadata: {
          openapi: {
            description:
              "Deletes a modpack version and its uploaded modconfig file from storage. " +
              "Requires authentication and ownership.",
            parameters: [
              { name: "slug", in: "path", required: true, schema: { type: "string" } },
              { name: "version", in: "path", required: true, schema: { type: "string" } },
            ],
            responses: {
              200: { description: "Version deleted" },
              401: { description: "Unauthorized – session required or not the owner" },
              404: { description: "Modpack or version not found" },
            },
          },
        },
      },
      async (ctx) => {
        if (!ctx.context.session) return ctx.error("UNAUTHORIZED");

        // Resolve modpack and check ownership
        const modpack = await ctx.context.adapter.findOne<Modpack>({
          model: "modpack",
          where: [{ field: "slug", value: ctx.params.slug, operator: "eq" }],
        });
        if (!modpack) return ctx.error("NOT_FOUND", { message: "Modpack not found" });
        if (modpack.owner !== ctx.context.session.user.id) return ctx.error("UNAUTHORIZED");

        // Fetch version to get its modConfigsUrl
        const versionRecord = await ctx.context.adapter.findOne<ModpackVersion>({
          model: "modpackVersion",
          where: [
            { field: "modpack", value: modpack.id, operator: "eq", connector: "AND" },
            { field: "version", value: ctx.params.version, operator: "eq" },
          ],
        });
        if (!versionRecord) return ctx.error("NOT_FOUND", { message: "Version not found" });

        // Delete the R2 object if present
        if (versionRecord.modConfigsUrl) {
          try {
            await r2DeleteModConfig(ctx.params.slug, ctx.params.version);
          } catch (err) {
            console.error("R2 delete failed:", err);
            // Continue with DB deletion even if R2 delete fails
          }
        }

        return ctx.json(
          ctx.context.adapter.delete({
            model: "modpackVersion",
            where: [
              { field: "modpack", value: modpack.id, operator: "eq", connector: "AND" },
              { field: "version", value: ctx.params.version, operator: "eq" },
            ],
          }),
        );
      },
    ),
  },
  id: "modpacks-plugin",
};
