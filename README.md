# Obsidian LiveSync → Hugo Publisher

Self-hosted publisher that watches an Obsidian LiveSync CouchDB database, rebuilds markdown notes with `post_published: true`, extracts embedded images, runs Hugo (PaperMod), and writes a static site to `/public` for your existing Caddy reverse proxy.

No Git, no Obsidian on the server, no filesystem sync.

## Architecture

```
Obsidian → LiveSync → CouchDB → livesync-publisher → Hugo → /public → Caddy
```

## Quick start (production)

Pull the image from GitHub Container Registry (after CI publishes it):

```yaml
services:
  livesync-publisher:
    image: ghcr.io/<your-github-user>/livesync-publisher:latest
    restart: unless-stopped
    environment:
      COUCHDB_URL: http://couchdb.host:5984
      COUCHDB_DB: obsidian-livesync-v2
      COUCHDB_USER: admin
      COUCHDB_PASSWORD: ${COUCHDB_PASSWORD}
      PUID: 1000
      PGID: 1000
    volumes:
      - /mnt/user/appdata/blog/hugo:/hugo
      - /mnt/user/appdata/blog/public:/public
      - /mnt/user/appdata/blog/state:/state
```

Expected host layout:

```
appdata/blog/
├── compose.yaml
├── hugo/
│   ├── hugo.toml          # or hugo.yml / hugo.yaml
│   ├── content/
│   ├── static/            # favicon, robots.txt, avatar, …
│   ├── themes/
│   ├── layouts/           # optional PaperMod overrides
│   └── assets/            # optional custom CSS
└── public/                # Hugo output → Caddy
```

The publisher writes only `hugo/content/posts/` (generated markdown) and `hugo/static/img/` (images extracted from posts). Everything else is yours to edit on the host. On first start with an empty `hugo/` directory, the container seeds a default config, PaperMod theme, and archetypes.

Point Caddy at `/srv/blog/public`:

```
blog.example.com {
  root * /srv/blog/public
  encode zstd gzip
  file_server
}
```

## LiveSync compatibility

The publisher reads CouchDB documents directly; it does not call the Obsidian plug-in API.
The plaintext note/chunk contract was checked against [LiveSync 1.0.0](https://github.com/vrtmrz/obsidian-livesync/releases/tag/1.0.0)
and [1.0.35](https://github.com/vrtmrz/obsidian-livesync/releases/tag/1.0.35), which pin
`@vrtmrz/livesync-commonlib` 0.1.0 and 0.1.36 respectively. No breaking change to that content schema was found.

- Markdown metadata uses `type: plain`; image metadata uses `type: newnote`.
- Content follows `children` order, including repeated chunk IDs.
- Embedded `eden[id].data` takes precedence over standalone `type: leaf` documents.
- Referenced standalone chunk arrivals reprocess the owning notes or posts using an image,
  even without another metadata revision. Dependencies are rebuilt on publisher startup.
- Empty content is valid; clearing a published note removes it because its publication gate is absent.

LiveSync [1.0.33 documents a metadata-before-chunk arrival issue](https://github.com/vrtmrz/obsidian-livesync/blob/1.0.35/updates.md#L82-L84).
Previously, the publisher stopped trying after its short chunk lookup retry and ignored subsequent
chunk notifications, leaving the published page stale. It also ignored embedded `eden` content.
These were publisher compatibility gaps, not a newly introduced `eden` format.

**Required storage settings:** use an unencrypted, unobfuscated CouchDB remote with uncompressed
stored content. E2EE, property/path obfuscation, compressed content, and chunk-pack decoding are
not supported. Turning a setting off does not rewrite content already stored using it; existing
encoded data must be migrated with LiveSync's supported procedures before this publisher can read it.
Object Storage and P2P alone do not supply this publisher's CouchDB feed.

After deploying an updated publisher, use the recovery rebuild below or make a small edit to an
affected note to republish it. By default, an existing checkpoint prevents a full content rebuild
on restart. If edits never reach CouchDB, investigate the Obsidian/LiveSync connection separately;
the publisher cannot restore client sync status.

## Publishing rules

Posts are any vault markdown note with `post_published: true` in frontmatter.

| Condition                         | Result                               |
| --------------------------------- | ------------------------------------ |
| `post_published: true` in frontmatter  | Published to site                    |
| `post_published` missing or not `true` | Removed from site (if was published) |
| Document deleted in CouchDB       | Removed from site                    |
| Conflicted revision               | Skipped (logged)                     |

Minimal auto-generated Hugo frontmatter when missing:

```yaml
---
title: "My Article"
date: 2026-05-20
slug: my-article
---
```

## Images

- LiveSync binary docs (`type: newnote`) with image extensions are indexed
- Obsidian wikilinks `![[image.png]]` and markdown `![](path)` are resolved
- Files written to `/hugo/static/img/<hash>-<name>` and linked as `/img/...`
- Reference counting removes orphaned images when posts are updated or unpublished

## Environment variables

| Variable              | Required | Default             | Description                                 |
| --------------------- | -------- | ------------------- | ------------------------------------------- |
| `COUCHDB_URL`         | yes      | —                   | CouchDB base URL (no database suffix)       |
| `COUCHDB_DB`          | yes      | —                   | Database name (e.g. `obsidian-livesync-v2`) |
| `COUCHDB_USER`        | no       | —                   | Username if not in URL                      |
| `COUCHDB_PASSWORD`    | no       | —                   | Password if not in URL                      |
| `COUCHDB_AUTO_CREATE` | no       | `false`             | Create DB on startup if missing (dev)       |
| `REBUILD_ON_START`    | no       | `false`             | Reconcile generated content and run Hugo on every startup |
| `DEBOUNCE_MS`         | no       | `4000`              | Debounce window for rebuilds                |
| `LOG_LEVEL`           | no       | `info`              | Pino log level                              |
| `IMAGE_URL_PREFIX`    | no       | `/img`              | URL prefix in rewritten markdown            |
| `MAX_IMAGE_BYTES`     | no       | `10485760`          | Max image size (10 MB)                      |
| `IMAGE_EXTENSIONS`    | no       | see `.env.example`  | Allowed image extensions                    |
| `PUID` / `PGID`       | no       | `1000`              | Volume ownership (Unraid-friendly)          |
| `HUGO_SITE`           | no       | `/hugo`             | Hugo site directory inside container        |
| `HUGO_DEST`           | no       | `/public`           | Hugo output directory                       |
| `CONTENT_DIR`         | no       | `/hugo/content`     | Generated post markdown directory           |
| `IMAGE_DIR`           | no       | `/hugo/static/img`  | Extracted post images directory             |

## Recovery rebuild

Set `REBUILD_ON_START` when generated content is stale, missing, or damaged:

```yaml
environment:
  REBUILD_ON_START: "true"
```

Recreate the publisher to apply the changed environment:

```bash
docker compose up -d --force-recreate livesync-publisher
```

A plain `docker restart` does not apply new environment settings. Once the container has
`REBUILD_ON_START=true`, every startup performs the recovery rebuild. Set it back to `"false"`
and recreate the container afterward if you only wanted a one-time recovery.

The rebuild:

- Regenerates published markdown and referenced images from current CouchDB content,
  bypassing the image file cache.
- Removes tracked output for deleted or unpublished notes and cleans up orphaned images.
  Saved custom slugs are respected, including when a slug changes.
- Reconstructs image reference counts from the saved ownership records.
- Preserves the saved change checkpoint and replays changes, including edits arriving during
  rebuilding. With no saved checkpoint, startup captures a sequence before scanning.
- Runs Hugo before starting the change feed. A failed Hugo rebuild aborts startup without
  advancing the checkpoint.

Watch for `startup_rebuild_started` and `startup_rebuild_finished` in the logs.
Conflicted or unreadable notes are skipped rather than deleting their previous published output.

**Keep `/state`.** Reconciliation uses its post-reference records to identify publisher-owned
posts and images; it does not wipe unrelated source files. Output without intact ownership
records cannot be safely pruned. A damaged `refcount.json` can be regenerated, but malformed
ownership records must be repaired or restored before rebuilding.

Rebuilding does not modify CouchDB or recover edits that never reached it. With
`REBUILD_ON_START=false`, checkpointed restarts retain the normal watch/resume behavior.
The first startup without a checkpoint still rebuilds automatically.

## Volumes

Use bind mounts, not named Docker volumes — easier to browse, edit, and back up on Unraid.

| Mount     | Required | Purpose                                                       |
| --------- | -------- | ------------------------------------------------------------- |
| `/hugo`   | yes      | Full Hugo site (config, themes, static, layouts, assets)      |
| `/public` | yes      | Hugo output (serve via Caddy)                                 |
| `/state`  | yes      | `last_seq`, image refs, refcount                              |

Publisher writes only `/hugo/content/posts/` and `/hugo/static/img/`. Put `hugo.toml`, `hugo.yml`, or `hugo.yaml` at the root of `/hugo`. Restart the container after config changes.

## Local development

One command starts the full stack: CouchDB, seed data, publisher, and a static site preview.

```bash
cp .env.example .env   # optional overrides
make dev
# or: docker compose -f docker-compose.dev.yml up --build
```

### Dev stack

| Service              | Port | Purpose                                      |
| -------------------- | ---- | -------------------------------------------- |
| `couchdb`            | 5984 | LiveSync database + Fauxton UI               |
| `couchdb-seed`       | —    | One-shot: inserts sample LiveSync documents  |
| `livesync-publisher` | —    | Watches CouchDB, runs Hugo, writes `/public` |
| `caddy`              | 8080 | Serves `dev/public` as the blog              |

After startup:

- Site: http://localhost:8080/
- Sample post: http://localhost:8080/blog/hello-from-livesync/
- CouchDB Fauxton: http://localhost:5984/\_utils (user `admin`, password `changeme` by default)

Seed fixtures live in `docker/dev/fixtures/` and include a published post, a draft (`post_published: false`), and a post with an embedded image. Re-seeding is skipped once `dev-seed-marker` exists in the database.

Host bind mounts:

| Path            | Purpose                                              |
| --------------- | ---------------------------------------------------- |
| `dev/hugo/`     | Hugo site (config, themes, static — editable)        |
| `dev/public/`   | Hugo output (served by Caddy)                        |
| `dev/state/`    | `last_seq`, image refs, refcount                     |

### Make targets

```bash
make dev        # up --build
make dev-down   # stop containers
make dev-reset  # down -v, wipe dev/public and dev/state
make dev-logs   # follow publisher logs
make dev-seed   # re-run seed (no-op if already seeded)
```

Fresh start from scratch:

```bash
make dev-reset && make dev
```

`docker-compose.dev.yml` sets `COUCHDB_AUTO_CREATE=true`. Dev Hugo config lives in `dev/hugo/hugo.toml` (default `baseURL` is `http://localhost:8080/`).

### Connect Obsidian (optional)

Point **Self-hosted LiveSync** at the local CouchDB:

- URL: `http://localhost:5984`
- Database: `obsidian-livesync-v2`
- User / password: `admin` / `changeme` (or your `.env` values)

Any vault markdown note with `post_published: true` in frontmatter is published — the publisher picks up `_changes` within a few seconds.

### Build and test without Docker

Build TypeScript locally:

```bash
cd publisher && npm install && npm run build
```

Run unit tests (Vitest):

```bash
cd publisher && npm test
```

Init PaperMod submodule (optional; Docker build clones it automatically):

```bash
git submodule update --init --recursive
```

## Obsidian setup

1. Install **Self-hosted LiveSync** and connect to your CouchDB.
2. Add frontmatter to any note you want on the site:

```yaml
---
post_published: true
post_title: "My Article"
post_slug: my-article
post_description: "Short summary for SEO."
post_tags:
  - homelab
post_date: 2026-05-20
---
```

All public post metadata lives in `post_*` fields. Obsidian `#tags`, frontmatter `tags`, and other vault properties stay private and are not published.

3. Save — the publisher picks up changes via CouchDB `_changes` within a few seconds.

## Troubleshooting

| Symptom                                       | Check                                                                                                                                                                                                                                                                        |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No posts on site                              | `post_published: true` set?                                                                                                                                                                                                                                                       |
| Post not updating                             | Publisher logs (`LOG_LEVEL=debug`), CouchDB connectivity                                                                                                                                                                                                                     |
| Images broken                                 | Image doc replicated? Supported extension? Under size limit?                                                                                                                                                                                                                 |
| Hugo build fails                              | `docker logs` — missing theme or invalid frontmatter                                                                                                                                                                                                                         |
| Restart re-processes everything               | Delete `dev/state/last_seq.json` to force full bootstrap                                                                                                                                                                                                                     |
| Site empty after first start                  | Wait for Hugo build in publisher logs (`build_finished`), or check `dev/public/`                                                                                                                                                                                             |
| Hugo config changes ignored                 | Edit files under `hugo/` on the host and restart the container                                                                                                                                                                                                               |
| Seed docs missing                             | Run `make dev-seed`, or `make dev-reset && make dev` for a clean database                                                                                                                                                                                                    |
| `You are not a server admin` (401) on startup | `COUCHDB_USER` must be `admin`; password must match the existing CouchDB volume. After changing `COUCHDB_PASSWORD`, run `make dev-reset` to reset `couchdb_data`. If CouchDB logs show `Missing system database _users`, the volume is corrupt — `dev-reset` fixes that too. |

Structured log events: `change_received`, `doc_written`, `doc_deleted`, `doc_skipped`, `image_missing`, `build_started`, `build_finished`, `build_failed`.

## Versioning and releases

Version lives in `publisher/package.json`. That value is logged at startup (`version` in every JSON log line) and baked into the Docker image label `org.opencontainers.image.version`.

**Release flow (automated tags):**

1. Land feature and fix commits on `main` with normal messages (`feat:`, `fix:`, etc.).
2. Bump `version` in `publisher/package.json` in a **separate** release commit (semver: `MAJOR.MINOR.PATCH`).
3. Push to `main`. Do not create the tag manually.

```bash
# 1. land changes first (examples)
git commit -m "fix(publisher): remove posts on LiveSync soft delete"
git commit -m "feat(dev): add one-command local stack"

# 2. bump version (separate commit)
npm version patch --prefix publisher --no-git-tag-version
git add publisher/package.json publisher/package-lock.json
git commit -m "chore(release): bump version to 0.1.1"

# 3. push — CI creates tag and release
git push origin main
```

Use `npm version minor` or `npm version major` when the release is not a patch.

The bump commit subject is enough (`chore(release): bump version to 0.1.1`). A short body is optional for migration or breaking-change notes. The full changelog comes from earlier commits and GitHub auto-generated release notes — do not restate every change in the bump commit.

4. GitHub Actions on `main` detects the `package.json` change, creates tag `v0.1.1`, publishes versioned Docker tags, and creates a GitHub Release — all in one workflow run.

The same push also publishes `latest` and `sha-<commit>`. Pushing an existing tag manually (e.g. to retry) still runs the tag workflow as a fallback.

Manual tags are optional; CI fails a tag build if `vX.Y.Z` ≠ `package.json` version.

**Do not** bump `package.json` without intending a release — any commit that changes that file triggers a new tag when the version is new.

**Pin production** to a version tag instead of `latest`:

```yaml
image: ghcr.io/<owner>/livesync-publisher:0.1.1
```

Check the running image:

```bash
docker inspect livesync-publisher --format '{{index .Config.Labels "org.opencontainers.image.version"}}'
docker logs livesync-publisher 2>&1 | head -1   # "version":"0.1.1" in JSON
```

## Build image locally

```bash
docker build --build-arg VERSION=0.1.0-local -t livesync-publisher:local .
```

## Deferred / out of scope

- E2EE / path obfuscation
- PDF and other non-image attachments
- Hugo Page Bundles (flat `static/img/` only)
- `notes/` and `pages/` sections (folders configurable, not styled)
- Wiki links between notes, HTML `<img>` rewriting
- Scheduled publishing, search, AI summaries

## License

MIT
