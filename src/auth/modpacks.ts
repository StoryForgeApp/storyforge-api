import { createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import type { BetterAuthPlugin } from "better-auth";
import { z } from "zod";
import { db } from "../db";
import { modpackVersion as modpackVersionTable } from "../db/schema";

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
        query: z.object({
          limit: z.coerce.number().max(100).min(1).optional(),
          offset: z.coerce.number().min(0).optional(),
          search: z.string().optional(),
          sortBy: z.enum(["createdAt", "name", "downloads", "updatedAt"]).optional(),
          order: z.enum(["asc", "desc"]).optional(),
          owner: z.string().optional(),
        }),
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
        const { limit = 20, offset = 0 } = ctx.query;
        const sortBy = ctx.query.sortBy ?? "createdAt";
        const order = ctx.query.order ?? "desc";

        const totalCount = await ctx.context.adapter.count({ model: "modpack" });

        const allModpacks = await db.query.modpack.findMany({
          orderBy:
            sortBy === "downloads"
              ? (table, { desc, asc }) => [
                  order === "desc" ? desc(table.createdAt) : asc(table.createdAt),
                ]
              : sortBy === "name"
                ? (table, { desc, asc }) => [order === "desc" ? desc(table.name) : asc(table.name)]
                : sortBy === "updatedAt"
                  ? (table, { desc, asc }) => [
                      order === "desc" ? desc(table.updatedAt) : asc(table.updatedAt),
                    ]
                  : (table, { desc, asc }) => [
                      order === "desc" ? desc(table.createdAt) : asc(table.createdAt),
                    ],
          // Drizzle relational API does its own pagination; for downloads sort
          // we fetch all and sort in memory below.
          ...(sortBy === "downloads" ? {} : { limit, offset }),
          with: {
            user: true,
            modpackVersions: true,
          },
          extras: (table, { sql }) => ({
            downloads:
              sql<number>`SELECT COALESCE(SUM(downloads), 0) FROM ${modpackVersionTable} WHERE ${modpackVersionTable.modpack} = ${table.id}`.as(
                "downloads",
              ),
          }),
        });

        let result = allModpacks.map((m) => ({
          ...m,
          owner: m.user ? { id: m.user.id, name: m.user.name, image: m.user.image } : null,
          user: undefined,
        }));

        if (sortBy === "downloads") {
          result.sort((a, b) =>
            order === "desc" ? b.downloads - a.downloads : a.downloads - b.downloads,
          );
          if (limit != null) result = result.slice(offset ?? 0, (offset ?? 0) + limit);
        }

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
          imageUrl: z.string().optional(),
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
            },
          },
        },
      },
      async (ctx) => {
        if (!ctx.context.session) return ctx.error("UNAUTHORIZED");
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
          slug: z.string().optional(),
          imageUrl: z.string().optional(),
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
                      slug: { type: "string" },
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
          where: [{ field: "slug", value: ctx.body.slug ?? ctx.params.slug, operator: "eq" }],
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
          version: z.string(),
          gameVersion: z.string().optional(),
          modsString: z.string().optional(),
          modConfigsUrl: z.string().optional(),
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

        const modpack = await ctx.context.adapter.findOne<Modpack>({
          model: "modpack",
          where: [{ field: "slug", value: ctx.params.slug, operator: "eq" }],
        });
        if (!modpack) return ctx.error("NOT_FOUND", { message: "Modpack not found" });
        if (modpack.owner !== ctx.context.session.user.id)
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

        const result = await ctx.context.adapter.create({
          model: "modpackVersion",
          data: {
            version: ctx.body.version,
            gameVersion: ctx.body.gameVersion ?? "",
            modsString: ctx.body.modsString ?? "",
            modConfigsUrl: ctx.body.modConfigsUrl ?? "",
            imageUrl: ctx.body.imageUrl,
            modpack: modpack.id,
          },
        });

        return ctx.json(result);
      },
    ),

    updateModpackVersion: createAuthEndpoint(
      "/modpacks/:slug/versions/:version",
      {
        method: "PUT",
        use: [sessionMiddleware],
        body: z.object({
          version: z.string().optional(),
          gameVersion: z.string().optional(),
          modsString: z.string().optional(),
          modConfigsUrl: z.string().optional(),
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

        const modpack = await ctx.context.adapter.findOne<Modpack>({
          model: "modpack",
          where: [{ field: "slug", value: ctx.params.slug, operator: "eq" }],
        });
        if (!modpack) return ctx.error("NOT_FOUND", { message: "Modpack not found" });
        if (modpack.owner !== ctx.context.session.user.id) return ctx.error("UNAUTHORIZED");

        const versionRecord = await ctx.context.adapter.findOne({
          model: "modpackVersion",
          where: [
            { field: "modpack", value: modpack.id, operator: "eq", connector: "AND" },
            { field: "version", value: ctx.params.version, operator: "eq" },
          ],
        });
        if (!versionRecord) return ctx.error("NOT_FOUND", { message: "Version not found" });

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

        if (Object.keys(update).length === 0) return ctx.json(versionRecord);

        const result = await ctx.context.adapter.update<ModpackVersion>({
          model: "modpackVersion",
          where: [
            { field: "modpack", value: modpack.id, operator: "eq", connector: "AND" },
            { field: "version", value: ctx.params.version, operator: "eq" },
          ],
          update,
        });

        return ctx.json(result);
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
