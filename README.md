# crossorbit

Sync bridge between a CrossPoint e-reader (firmware 2.0) and BookOrbit 3.8+. Point the device's KOReader sync server at this service and it translates CrossPoint reading progress and clippings into BookOrbit progress and annotations, in both directions. There is no UI and no background polling: BookOrbit is read only when the device syncs.

## What it does

- `GET /users/auth`, `PUT /syncs/progress`, `GET /syncs/progress/:document` are forwarded to BookOrbit's KOReader endpoints with the device credentials. The CrossPoint `position` object is stripped, and its `xpath` is used when `progress` is empty.
- `POST /users/create` answers 403. Create KOReader credentials in BookOrbit settings instead.
- `GET`/`PUT /api/v1/clippings/:document` speak CrossPoint's clipping protocol (sync version 2). Uploaded clippings become BookOrbit annotations anchored by EPUB CFI. Deleting one on the device deletes the annotation. When the device starts a sync, highlights made in BookOrbit are pulled down as clippings and annotations deleted in BookOrbit become deletions on the device.
- `GET /healthz` checks the database.

Device credentials are forwarded per request and never stored. Postgres holds the document hash to book mapping, the clipping to annotation mapping with the device's layout fields, and tombstones. Book text is never persisted; parsed EPUBs are kept in a small in-memory cache.

## Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | | Postgres connection string. Migrations run at startup. |
| `BOOKORBIT_URL` | yes | | BookOrbit base URL, e.g. `http://bookorbit:3000`. |
| `BOOKORBIT_API_KEY` | yes | | BookOrbit API key (`bok_...`) with read and write access, owned by the same user as the device credentials. |
| `PORT` | no | `8080` | HTTP port. |
| `LOG_LEVEL` | no | `info` | `debug`, `info`, `warn` or `error`. Logs are JSON lines. |

## Device setup

1. In BookOrbit, create KOReader sync credentials and an API key.
2. On the CrossPoint device, set the KOReader sync server to `http://<host>:8080` and enter the BookOrbit KOReader username and password.
3. Enable clipping sync.

## Unraid

1. Docker tab, Add Container.
2. Repository: the image you built, e.g. `crossorbit:latest` (`docker build -t crossorbit .` on the Unraid host).
3. Network type: the bridge or custom network that can reach BookOrbit and Postgres.
4. Add a port mapping: container `8080` to a host port of your choice.
5. Add variables `DATABASE_URL`, `BOOKORBIT_URL`, `BOOKORBIT_API_KEY`, and optionally `LOG_LEVEL`.
6. Apply. The container reports healthy once `/healthz` responds.

A dedicated database is recommended, e.g. `CREATE DATABASE crossorbit;` on the Postgres container BookOrbit already uses.

## Development

```sh
npm ci
npm run typecheck
TEST_DATABASE_URL=postgres://bookorbit:bookorbit@localhost:55432/crossorbit_test npm test
```

The integration test drops and recreates the `public` schema of the test database.
