# crossorbit

Sync bridge between a CrossPoint e-reader (firmware 2.0) and BookOrbit 3.8+. Point the device's KOReader sync server at this service and it translates CrossPoint reading progress and clippings into BookOrbit progress and annotations, in both directions. There is no UI and no background polling: BookOrbit is read only when the device syncs.

## What it does

- `GET /users/auth`, `PUT /syncs/progress`, `GET /syncs/progress/:document` are forwarded to BookOrbit's KOReader endpoints with the device credentials. The CrossPoint `position` object is stripped, and its `xpath` is used when `progress` is empty.
- `POST /users/create` answers 403. Create KOReader credentials in BookOrbit settings instead.
- `GET`/`PUT /api/v1/clippings/:document` speak CrossPoint's clipping protocol (sync version 2). Uploaded clippings become BookOrbit annotations anchored by EPUB CFI. Deleting one on the device deletes the annotation. When the device starts a sync, highlights made in BookOrbit are pulled down as clippings and annotations deleted in BookOrbit become deletions on the device.
- `GET /healthz` checks the database.

Device credentials are forwarded per request and never stored. The database (Postgres or SQLite) holds the document hash to book mapping, the clipping to annotation mapping with the device's layout fields, and tombstones. Book text is never persisted; parsed EPUBs are kept in a small in-memory cache.

## Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | | `postgres://...` / `postgresql://...` for Postgres, or `sqlite:<path>` (e.g. `sqlite:/data/crossorbit.db`) for SQLite. Migrations run at startup. |
| `BOOKORBIT_URL` | yes | | BookOrbit base URL, e.g. `http://bookorbit:3000`. |
| `BOOKORBIT_API_KEY` | yes | | BookOrbit API key (`bok_...`) with read and write access, owned by the same user as the device credentials. |
| `PORT` | no | `8080` | HTTP port. |
| `METRICS_PORT` | no | `9090` | Prometheus metrics port, serving `/metrics`. `0` disables it. Keep it off the public proxy. |
| `LOG_LEVEL` | no | `info` | `debug`, `info`, `warn` or `error`. Logs are JSON lines. |

## Device setup

1. In BookOrbit, create KOReader sync credentials and an API key.
2. On the CrossPoint device, set the KOReader sync server to `http://<host>:8080` and enter the BookOrbit KOReader username and password.
3. Enable clipping sync.

## Unraid

1. Docker tab, Add Container.
2. Repository: `ghcr.io/abs3ntdev/crossorbit:latest` for the newest release, or `:develop` to follow `main`. Every build is also tagged `sha-<commit>`.
3. Network type: the bridge or custom network that can reach BookOrbit and Postgres.
4. Add a port mapping: container `8080` to a host port of your choice.
5. Add variables `DATABASE_URL`, `BOOKORBIT_URL`, `BOOKORBIT_API_KEY`, and optionally `LOG_LEVEL`.
6. Apply. The container reports healthy once `/healthz` responds.

For SQLite, mount a volume at `/data` and set `DATABASE_URL=sqlite:/data/crossorbit.db`. For Postgres, a dedicated database is recommended, e.g. `CREATE DATABASE crossorbit;` on the Postgres container BookOrbit already uses.

## Metrics

`http://<container>:9090/metrics` serves Prometheus metrics. Each scrape also checks Postgres and the BookOrbit API key.

```yaml
scrape_configs:
  - job_name: crossorbit
    static_configs:
      - targets: ['crossorbit:9090']
```

| Metric | Meaning |
|---|---|
| `crossorbit_dependency_up{dependency}` | `postgres` (the configured database, Postgres or SQLite) or `bookorbit` answered the last scrape |
| `crossorbit_last_sync_timestamp_seconds{kind}` | Last successful `progress` or `clippings` sync |
| `crossorbit_progress_syncs_total{direction,status}` | Progress pushes and pulls |
| `crossorbit_clippings_total{direction,kind}` | Clippings created, updated, deleted or skipped, to the device or to BookOrbit |
| `crossorbit_clippings_unanchored_total{direction}` | Highlights that could not be placed in the EPUB |
| `crossorbit_clippings_stored{state}` | Stored clippings: `live`, `deleted`, `unanchored` |
| `crossorbit_documents` | Device documents mapped to BookOrbit books |
| `crossorbit_epub_loads_total{outcome}` | EPUB downloads from BookOrbit |
| `crossorbit_http_requests_total`, `crossorbit_http_request_duration_seconds` | Device requests by route |
| `crossorbit_bookorbit_requests_total`, `crossorbit_bookorbit_request_duration_seconds` | BookOrbit requests by operation |

A Grafana dashboard is in `grafana/crossorbit.json`.

## Development

```sh
npm ci
npm run typecheck
TEST_DATABASE_URL=postgres://bookorbit:bookorbit@localhost:55432/crossorbit_test npm test
TEST_DATABASE_URL=sqlite: npm test
```

The Postgres run drops and recreates the `public` schema of the test database and creates a scratch `crossorbit_upgrade_test` database to check upgrades from the legacy SQL migration runner. With `sqlite:` the suite uses a temporary file.
