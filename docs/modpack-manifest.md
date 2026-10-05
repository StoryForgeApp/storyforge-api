# Modpack Manifest — Spec

Status: draft for review
Owner: API (`vsapi`)
Consumers: StoryForge launcher, web frontend, future install tooling

## 1. Problem

A modpack version currently stores `modsString` (opaque launcher-defined text) plus a
`modConfigsUrl` zip. There is no structured, verifiable description of what a pack
contains. Consequences:

- Launcher cannot resolve, diff, update, or verify mods
- No integrity data (sha256/size) → no tamper detection, no dedupe
- Platform cannot scan packs, index "who uses mod X", or show pack contents without
  parsing launcher-private formats

This spec adds a **manifest**: a structured, content-hashed list of mod files plus config
archive for each `modpack_version`, exposed over stable endpoints.

### Goals

- Reproducible installs (exact file URLs + hashes + sizes)
- Server-computed integrity, cached per upstream `fileid`
- Machine-readable pack contents for UI, indexing, and future scanning
- Full backwards compatibility: existing versions keep working via a legacy shape

### Non-goals (v1)

- Hosting mod binaries ourselves (downloads keep pointing at moddb CDN)
- Mod-to-mod dependency resolution (upstream API declares no dependencies)
- Repacking configs + manifest into a single downloadable artifact (future `/pack`)
- Org-owned packs / collaborators (separate work)

### Upstream API facts the design relies on

`GET https://mods.vintagestory.at/api/mod/:modid` returns
`mod.side` (`client|server|both`), `mod.name`, `mod.tags`, and `releases[]` where each
release has `releaseid`, `fileid`, `modidstr`, `modversion`, `filename`,
`mainfile` (CDN URL with `?dl=` suffix), `tags` (supported game versions), `created`,
`changelog`. **No upstream size or hash exists** — the API must compute those itself.

## 2. Data model

New tables in `src/db/schema.ts`. Drizzle, SQLite, matching existing conventions.

### 2.1 `modpack_file`

One row per mod that belongs to a modpack version.

```ts
export const modpackFile = sqliteTable(
  "modpack_file",
  {
    id: text("id").primaryKey(),
    modpackVersion: text("modpack_version")
      .notNull()
      .references(() => modpackVersion.id, { onDelete: "cascade" }),
    modId: integer("mod_id").notNull(), // upstream modid
    modIdStr: text("mod_id_str").notNull(), // e.g. "workbenchexpansion"
    name: text("name").notNull(),
    modVersion: text("mod_version").notNull(),
    releaseId: integer("release_id"),
    fileId: integer("file_id").notNull(), // upstream fileid; hash cache key
    filename: text("filename").notNull(),
    url: text("url").notNull(),
    sha256: text("sha256"), // null until verified
    size: integer("size"), // null until verified, bytes
    side: text("side").notNull().default("both"), // client | server | both
    required: integer("required", { mode: "boolean" }).notNull().default(true),
    gameVersions: text("game_versions"), // JSON array snapshot of release.tags
    compatible: integer("compatible", { mode: "boolean" }), // null = unknown
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    uniqueIndex("modpack_file_version_mod_uidx").on(table.modpackVersion, table.modId),
    index("modpack_file_version_idx").on(table.modpackVersion),
    index("modpack_file_modId_idx").on(table.modId),
    index("modpack_file_fileId_idx").on(table.fileId),
  ],
);
```

Notes:

- `unique(modpackVersion, modId)` — one file per mod per version. Updating a mod means
  replacing its row (new `fileId`, hash reset).
- `gameVersions` + `compatible` are snapshots from the upstream release, refreshed on
  write. `compatible` is computed against `modpack_version.gameVersion`, not trusted
  from the client.
- `sortOrder` preserves launcher UI ordering; manifest arrays are sorted by `modId` for
  hashing regardless.

### 2.2 `moddb_file` (hash cache)

Hashes are expensive (download the artifact once). Cache per upstream `fileid`,
shared across all packs.

```ts
export const moddbFile = sqliteTable("moddb_file", {
  fileId: integer("file_id").primaryKey(),
  url: text("url").notNull(),
  filename: text("filename").notNull(),
  size: integer("size"),
  sha256: text("sha256"),
  status: text("status").notNull().default("pending"), // pending | ok | failed
  attempts: integer("attempts").notNull().default(0),
  verifiedAt: integer("verified_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
});
```

### 2.3 `modpack_version` additions

| Column | Type | Purpose |
|---|---|---|
| `manifest_hash` | text, nullable | sha256 of canonical manifest, computed on write |
| `mod_configs_sha256` | text, nullable | hash of uploaded configs zip |
| `mod_configs_size` | integer, nullable | size of uploaded configs zip, bytes |
| `changelog` | text, nullable | release notes (plain text or sanitized HTML) |
| `manifest_version` | integer, default 0 | 0 = legacy (`modsString` only), 1 = structured |

`modsString` stays; deprecated, no longer written by new clients (see §7).

## 3. Canonical manifest + hashing

`manifestHash = sha256(utf8(canonicalJSON))`.

Canonicalization rules (must match exactly across API and launcher):

1. Fixed key order (as listed in §4).
2. `mods` sorted ascending by `modId`, then `fileId`.
3. No insignificant whitespace (`JSON.stringify` defaults).
4. Excluded from hash input: `manifestHash`, `generatedAt`.
5. Nullable fields are included as `null`, never omitted.
6. Numbers are safe integers; sizes in bytes.

Algorithm:

1. Build manifest object without `manifestHash`/`generatedAt`.
2. `canonical = JSON.stringify(manifestObject)` (keys already created in fixed order).
3. `manifestHash = sha256hex(canonical)`.
4. Response adds `manifestHash` and `generatedAt`, keeping hash input untouched.

ETag: `"sha256-<manifestHash>"`. Endpoint honors `If-None-Match` → `304`.

## 4. Manifest JSON, version 1

```json
{
  "manifestVersion": 1,
  "slug": "stone-age",
  "name": "Stone Age",
  "version": "1.2.0",
  "gameVersion": "1.21.0",
  "publishedAt": "2026-10-05T11:00:00.000Z",
  "manifestHash": "9f2c…",
  "generatedAt": "2026-10-05T11:00:00.000Z",
  "mods": [
    {
      "modId": 100,
      "modIdStr": "workbenchexpansion",
      "name": "Workbench expansion",
      "modVersion": "1.8.0",
      "releaseId": 7697,
      "fileId": 16783,
      "filename": "workbench-expansion-1.8.0.zip",
      "url": "https://moddbcdn.vintagestory.at/workbench-expansion-_2321….zip?dl=workbench-expansion-1.8.0.zip",
      "sha256": "a1b2…",
      "size": 184320,
      "side": "both",
      "required": true,
      "sortOrder": 0,
      "gameVersions": ["1.20.0", "1.20.1"],
      "compatible": true,
      "verified": true
    }
  ],
  "modConfigs": {
    "url": "https://cdn…/modpacks/stone-age/1.2.0/modconfigs.zip",
    "sha256": "c3d4…",
    "size": 20480
  }
}
```

Field rules:

- `verified` is derived: `sha256 != null && upstream status == ok`. Never stored.
- `compatible`: exact game-version membership in `gameVersions`; pre-release tags
  (`1.20.0-pre.1`) follow VS semantics — exact match unless the pack targets the
  matching pre-release line. If `gameVersions` is null → `compatible: null`.
- `modConfigs` is `null` when no configs uploaded.
- `required: false` means "launcher may let user deselect"; server still hashes it.

### Legacy shape (existing versions)

When `manifest_version = 0` (no rows, `modsString` present):

```json
{
  "manifestVersion": 0,
  "legacy": true,
  "slug": "…",
  "version": "…",
  "gameVersion": "…",
  "modsString": "…unknown-launcher-format…",
  "mods": [],
  "modConfigs": { "url": "…", "sha256": null, "size": null }
}
```

Old launchers keep reading `modsString` from existing endpoints; the manifest endpoint
only promises `mods` for `manifestVersion >= 1`. `legacy: true` lets new clients show
"republish to add verification".

## 5. Endpoints

All plugin endpoints live under the better-auth mount (currently `/api/auth`); paths
below are plugin-relative, matching existing `createAuthEndpoint` style in
`src/auth/modpacks.ts`. New endpoints get the same OpenAPI metadata treatment.

### 5.1 `GET /modpacks/:slug/versions/:version/manifest`

- Auth: optional. Public if `modpack.public = true`; otherwise owner-only
  (404 for everyone else, no existence leak).
- Cache: `Cache-Control: public, max-age=300` for public packs; `ETag` always.
- `If-None-Match` → `304`, empty body.
- Errors: `404` pack/version not found; legacy versions return `200` with the shape in §4.
- Query: none in v1.

### 5.2 `PUT /modpacks/:slug/versions/:version/manifest`

- Auth: `sessionMiddleware` + ownership. Owner-only.
- Body:

```ts
z.object({
  mods: z.array(
    z.object({
      modId: z.number().int().positive(),
      releaseId: z.number().int().positive().optional(),
      fileId: z.number().int().positive(),
      url: z.string().url(),
      filename: z.string().optional(),
      required: z.boolean().default(true),
      side: z.enum(["client", "server", "both"]).default("both"),
      sortOrder: z.number().int().default(0),
    }),
  ).min(1).max(500),
  changelog: z.string().max(10_000).optional(),
})
```

- Server resolves each `fileId` against
  `https://mods.vintagestory.at/api/mod/…` (or trusts `modIdStr`/`name`/`modVersion`
  from a server-side lookup), rejects unknown fileIds, and fills denormalized fields.
  `url` must pass the allowlist (§6) and match the upstream `mainfile` for that `fileId`.
- Atomic replace of `modpack_file` rows for this version (single transaction).
- Recomputes `compatible` against `modpack_version.gameVersion`.
- Enqueues hash verification for unseen `fileId`s (§8).
- Sets `manifest_version = 1`, recomputes `manifest_hash`.
- Response: the v1 manifest.
- Errors: `400` invalid body / unknown fileId; `401`; `404`; `409` duplicate `modId`
  (also caught by unique index); `422` URL host not allowed or upstream mismatch.

### 5.3 `POST /modpacks/:slug/versions` and `PUT /modpacks/:slug/versions/:version` (extended)

- Add optional `mods` array with the same element schema as §5.2.
- Add optional `changelog`.
- When `mods` is present: replace rows, set `manifest_version = 1`, enqueue hashes,
  recompute `manifest_hash`. When absent: behavior unchanged (legacy).
- Existing `modsString` body field: still accepted, deprecated, no longer required.

### 5.4 `POST /api/modpacks/:slug/versions/upload` (extend, `src/index.ts`)

- Compute `sha256` + `size` of the received `modConfigs` buffer (≤ 5 MB, synchronous,
  cheap) before R2 write.
- Response becomes `{ url, key, sha256, size }`.
- Version create/update accepts optional `modConfigsSha256` / `modConfigsSize` and
  persists them; if omitted, manifest shows `sha256: null` for configs.
- Note (out of scope, tracked): uploads for a version that is never created leave an
  orphaned R2 object. Needs a sweep job or a draft-version flow later.

### 5.5 Unchanged

`GET /modpacks`, `GET /modpacks/:slug`, version list/detail, `incrementDownload` keep
their responses. Version payloads gain `manifestVersion`, `modConfigsSha256`,
`modConfigsSize`, `changelog` fields. `modsString` stays in responses until consumers
migrate.

## 6. Validation rules

| Rule | Limit / check |
|---|---|
| Mods per version | 1–500 |
| `url` host allowlist | `moddbcdn.vintagestory.at` (HTTPS only) |
| `url` match | must equal upstream `mainfile` for `fileId` (normalized: ignore `?dl=`) |
| Duplicate `modId` | rejected, `409` |
| `side` | `client \| server \| both` |
| `required` | boolean, default `true` |
| Request size | manifest body ≤ 512 KB |
| `changelog` | ≤ 10,000 chars, HTML sanitized on read or stored plain |
| Ownership | version's pack owner == session user |
| Rate limit | PUT manifest: 30/user/min; create/update version: 10/user/min |

## 7. Backwards compatibility

- Additive migration only (drizzle `0007_*`): two new tables + five nullable columns.
- Legacy versions: `manifest_version` defaults to 0, manifest endpoint returns the §4
  legacy shape. Zero change for existing launcher flows.
- New publishes set `manifest_version = 1` and write structured rows; `modsString` may
  remain empty for them.
- `modsString` marked deprecated in OpenAPI docs. Removal is a future breaking release
  after launcher adoption metrics show no reads.
- Migration is backfill-free. If desired, an opt-in script can parse known `modsString`
  formats into rows — **blocked on a sample of the launcher format**, which lives
  outside this repo.

## 8. Hash verification worker

- Enqueue: on manifest write, for each `fileId` missing from `moddb_file`, insert
  `status = 'pending'` (upsert; existing `ok` rows are reused).
- Worker: cron job (reuse `@elysiajs/cron` + `JobLock` from `src/index.ts`), every 5 min,
  batch of N (start: 5 concurrent downloads).
  - Download `url` streaming, compute sha256 + byte size.
  - On success: `status = 'ok'`, `verifiedAt = now`.
  - On failure: `attempts++`; retry with exponential backoff; `status = 'failed'` after
    5 attempts.
  - On `ok`: update all `modpack_file` rows with that `fileId` and recompute
    `manifest_hash` for affected versions.
- Launcher contract:
  - `sha256 == null` → install anyway, show "unverified" badge.
  - `sha256 != null` → verify after download; mismatch = hard fail, delete file.
- Hash cache is immutable per `fileId`: upstream CDN URLs are content-addressed
  (hash in path), so a changed file gets a new `fileId`.

## 9. Security considerations

- Manifest visibility mirrors pack visibility; owner-only for private packs. (Note: the
  existing `GET /modpacks/:slug` leaks private packs — fix independently, tracked.)
- Server-verified hashes are the trust root; client-supplied hashes are never accepted
  in v1 (unlike a trust-on-first-use design).
- URL allowlist + upstream `mainfile` match prevents manifest abuse as an arbitrary
  download redirector.
- Configs zip hash is computed server-side at upload.
- `incrementDownload` spoofing is unaffected by this spec; rate limiting it is tracked
  separately.

## 10. Open questions

1. **`modsString` format** — owned by the launcher, no sample in this repo. Needed only
   if we backfill legacy versions; not required for v1.
2. **Single artifact download** — future `GET /modpacks/:slug/versions/:version/pack`
   returning a zip containing manifest + configs (not mod binaries). Name reserved.
3. **Mod-level metadata in UI** — logo/description come from moddb; cache them in
   `moddb_file` later if list rendering needs it.
4. **Multi-game-version packs** — currently one `gameVersion` per version; VS packs
   often span patch lines. `compatible` warns, doesn't block. Revisit if users ask.
5. **Deduplicated storage of hashes across packs** — solved by `moddb_file` cache, but
   cache invalidation policy (when a fileId URL 404s) needs a decision.

## 11. Implementation notes (as built)

- `moddb_file` additionally carries `last_attempt_at` to implement retry backoff.
- Manifest write `side` is optional; when omitted the server uses the upstream mod's
  `side`. `required` defaults to `true`.
- Structured fields (`changelog`, `mod_configs_sha256/size`, `manifest_version`) are
  written via drizzle, not the better-auth adapter: the adapter only maps columns
  declared in the plugin `schema` block. Legacy fields keep flowing through the adapter.
- `resolveManifestMods` is shared by PUT manifest and version create/update. Version
  create resolves mods **before** inserting, so invalid input cannot leave an orphan.
- Hash worker: `@elysiajs/cron` every 5 minutes behind a `JobLock`; downloads have a
  120 s timeout, batch concurrency 5, max 5 attempts with exponential backoff.
- Rate limits: manifest PUT 30/min/user; version create+update combined 10/min/user
  (Redis fixed window via `src/rateLimit.ts`).
- `GET .../manifest` returns `304` on matching `If-None-Match` for v1 manifests;
  legacy responses have no ETag.
- Verified: `tsc --noEmit`, compile build, runtime smoke (404 missing version,
  401 unauthenticated PUT), unit checks for compatibility/URL/hash helpers.
- Deferred (tracked): upload orphan sweep, `incrementDownload` throttling,
  `GET /modpacks/:slug` private-pack leak.
