# crossorbit

Sync bridge between a CrossPoint e-reader (firmware 2.0) and BookOrbit 3.10+. Point the device's KOReader sync server at this service and it translates CrossPoint reading progress and clippings into BookOrbit progress and annotations, in both directions. A read-only status page runs on its own port. There is no background polling: BookOrbit is read only when the device syncs.

## What it does

- `GET /users/auth`, `PUT /syncs/progress`, `GET /syncs/progress/:document` are forwarded to BookOrbit's KOReader endpoints with the device credentials. The CrossPoint `position` object is validated and stripped (its `xpath` is used when `progress` is empty), and it is restored on pull while BookOrbit still holds the same position. The progress `metadata` title and authors are sent with BookOrbit's match-check, so books it cannot match appear under its unmatched books with link suggestions. A push for a book BookOrbit does not know yet is kept and answered with success, as kosync servers do, and replayed on the next pull for that book.
- `POST /users/create` answers 403. Create KOReader credentials in BookOrbit settings instead.
- `GET`/`PUT /api/v1/clippings/:document` speak CrossPoint's clipping protocol (sync version 2). Highlights go through BookOrbit's KOReader plugin annotation exchange (`/api/v1/koreader/plugin/annotations/exchange` and `exchange-ack`) with the device credentials, exactly as the KOReader plugin syncs. A clipping's device offsets are mapped to a crengine XPointer range (`pos0`/`pos1`) in the EPUB, and its KOReader identity is `md5(datetime|pos0)` with the datetime taken from the clipping's creation time. Each sync sends the complete key list, so deleting a clipping on the device deletes the BookOrbit annotation. BookOrbit answers with highlights to add, edit or delete, which crossorbit maps back to device offsets, stores as new revisions and acknowledges. Notes and colors set in BookOrbit are kept with the clipping and sent back unchanged, though CrossPoint cannot show them. A clipping moved on the device is re-anchored. If the new spot cannot be found in the EPUB, the previous anchor is kept.
- `GET`/`PUT /api/v1/bookmarks/:document` speak CrossPoint's bookmark sync (sync version 2, firmware with PR #4531). Bookmarks go through BookOrbit's KOReader bookmark exchange as dogears. The device XPointer is sent as is, and the note is the bookmark name, else its summary. BookOrbit stores the note as the title. Renaming a bookmark on the device renames it in BookOrbit, and deleting it deletes it. BookOrbit's new bookmarks and renames are pulled down with the id derived from the XPointer, as the device expects. Bookmarks deleted in BookOrbit are deleted on the device.
- `PUT /api/v1/stats/sessions` receives the device's reading-session log and records each session as a BookOrbit reading session (`crosspoint:<session_id>`, deduplicated by BookOrbit). Every well-formed session is acknowledged at once so the device keeps moving; sessions for books BookOrbit cannot match yet, or whose upload fails, are kept and retried on later uploads.
- `GET /healthz` checks the database.

Clippings and bookmarks uploaded for a book BookOrbit cannot match yet are acknowledged and kept, then sent to BookOrbit on the first sync after it matches (for example once the book is linked under BookOrbit's unmatched books). The exchange can also refuse a book: `unmatched` means it is not in the library, and `positionIncompatible` means BookOrbit cannot map positions for that file. In both cases the changes stay queued and are resent on the next sync, and the problems page lists the book until an exchange succeeds. BookOrbit keeps exchange state per device id. crossorbit uses one id per KOReader user (`crossorbit-<hash>`), so every CrossPoint signed in as that user shares it. Only MD5 document hashes are sent to BookOrbit's match-check; other document ids are accepted but stay unmatched. Malformed requests get crosspoint-sync's errors: `403` with code `2004` for a bad document and `2003` for a bad body or query. Successful device credential checks are cached for a minute so paged syncs do not re-check every page.

crossorbit is single-user by design. Highlights and bookmarks are written with each device's own credentials, but one `BOOKORBIT_API_KEY` downloads EPUBs, reads metadata and covers, and uploads reading sessions. The device credentials and the API key must therefore belong to the same BookOrbit user, and the document mapping is shared.

## Web UI

`UI_PORT` (default `8081`) serves a read-only dashboard: a shelf of synced books with covers, device progress and highlight counts, per-book highlight lists, recent activity, and a problems page for unanchored highlights, books BookOrbit cannot find, and books whose exchange BookOrbit refused. Covers are proxied through `/covers/:bookId` so the API key never reaches the browser. Only `GET` routes exist, and the UI only reads the database and BookOrbit.

The UI has no authentication. Expose it only through Pangolin (or a similar authenticating proxy), never directly.

Device credentials are forwarded per request and never stored. The database (Postgres or SQLite) holds the document hash to book mapping, each clipping and bookmark with its device layout fields and KOReader identity, and tombstones. Book text is never persisted; parsed EPUBs are kept in a small in-memory cache.

## Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | | `postgres://...` / `postgresql://...` for Postgres, or `sqlite:<path>` (e.g. `sqlite:/data/crossorbit.db`) for SQLite. Migrations run at startup. |
| `BOOKORBIT_URL` | yes | | BookOrbit base URL, e.g. `http://bookorbit:3000`. |
| `BOOKORBIT_API_KEY` | yes | | BookOrbit API key (`bok_...`) owned by the same user as the device credentials. It needs write access to upload reading sessions. If BookOrbit refuses the key, syncs fail with a 502 that names the problem. |
| `PORT` | no | `8080` | HTTP port. |
| `METRICS_PORT` | no | `9090` | Prometheus metrics port, serving `/metrics`. `0` disables it. Keep it off the public proxy. |
| `UI_PORT` | no | `8081` | Read-only web UI (shelf, highlights, activity, problems). `0` disables it. It has no authentication: put it behind Pangolin or another authenticating proxy. |
| `LOG_LEVEL` | no | `info` | `debug`, `info`, `warn` or `error`. Logs are JSON lines. |

## Device setup

1. In BookOrbit, create KOReader sync credentials and an API key.
2. On the CrossPoint device, set the KOReader sync server to `http://<host>:8080` and enter the BookOrbit KOReader username and password.
3. Enable clipping sync.
4. Optionally enable **Sync on sleep** on the device. It runs the same sync when the reader goes to sleep: position is pushed via the existing `/syncs/progress`, and bookmarks and reading sessions go through the endpoints above. Nothing extra is needed on the server.

## Unraid

1. Docker tab, Add Container.
2. Repository: `ghcr.io/abs3ntdev/crossorbit:latest` for the newest release, or `:develop` to follow `main`. Every build is also tagged `sha-<commit>`.
3. Network type: the bridge or custom network that can reach BookOrbit and Postgres.
4. Add a port mapping: container `8080` to a host port of your choice.
5. Add variables `DATABASE_URL`, `BOOKORBIT_URL`, `BOOKORBIT_API_KEY`, and optionally `LOG_LEVEL`.
6. Apply. The container reports healthy once `/healthz` responds.

For SQLite, mount a volume at `/data` and set `DATABASE_URL=sqlite:/data/crossorbit.db`. For Postgres, a dedicated database is recommended, e.g. `CREATE DATABASE crossorbit;` on the Postgres container BookOrbit already uses.

## Metrics

`http://<container>:9090/metrics` serves Prometheus metrics. Each scrape also checks the database and the BookOrbit API key.

```yaml
scrape_configs:
  - job_name: crossorbit
    static_configs:
      - targets: ['crossorbit:9090']
```

| Metric | Meaning |
|---|---|
| `crossorbit_dependency_up{dependency}` | `database` (Postgres or SQLite) or `bookorbit` answered the last scrape |
| `crossorbit_last_sync_timestamp_seconds{kind}` | Last successful `progress`, `clippings`, `bookmarks` or `sessions` sync |
| `crossorbit_progress_syncs_total{direction,status}` | Progress pushes and pulls |
| `crossorbit_clippings_total{direction,kind}` | Clippings created, updated, deleted or skipped, to the device or to BookOrbit |
| `crossorbit_clippings_unanchored_total{direction}` | Highlights that could not be placed in the EPUB |
| `crossorbit_clippings_stored{state}` | Stored clippings: `live`, `deleted`, `unanchored` |
| `crossorbit_bookmarks_total{direction,kind}` | Bookmarks created, renamed, deleted or skipped, to the device or to BookOrbit |
| `crossorbit_bookmarks_unanchored_total{direction}` | Bookmarks without an exact EPUB position |
| `crossorbit_reading_sessions_total{outcome}` | Reading sessions `uploaded`, `unresolved` or `failed` (kept for retry) |
| `crossorbit_documents` | Device documents mapped to BookOrbit books |
| `crossorbit_epub_loads_total{outcome}` | EPUB downloads from BookOrbit |
| `crossorbit_http_requests_total`, `crossorbit_http_request_duration_seconds` | Device requests by route |
| `crossorbit_bookorbit_requests_total`, `crossorbit_bookorbit_request_duration_seconds` | BookOrbit requests by operation |

A Grafana dashboard is in `grafana/crossorbit.json`.

## Development

```sh
npm install -g pnpm@12.18.0
pnpm install --frozen-lockfile
pnpm typecheck
TEST_DATABASE_URL=postgres://bookorbit:bookorbit@localhost:55432/crossorbit_test pnpm test
TEST_DATABASE_URL=sqlite: pnpm test
```

The Postgres run drops and recreates the `public` schema of the test database and creates a scratch `crossorbit_upgrade_test` database to check upgrades from the legacy SQL migration runner. With `sqlite:` the suite uses a temporary file.
