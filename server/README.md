# Lighthouse save service

A small HTTP service for Brave Quest: Lighthouse. It stores:

- **game saves**, keyed by an anonymous sync code the player carries between devices;
- **anonymous progress events** (which build, which input type, which milestone);
- **player feedback**.

There are no accounts. The service does not store IP addresses, and it never stores the sync
code itself, only `sha256(code)`. The only thing a player can identify themselves with is the
optional `contact` field on feedback, which they fill in by choice.

Node 22, plain JavaScript, built-in `node:http`. One runtime dependency: `pg`.

## Endpoints

All responses are JSON with `Cache-Control: no-store`.

| Method | Path | Key | Success | Notes |
| --- | --- | --- | --- | --- |
| GET | `/health` | no | `200 {ok:true}` | `503 {ok:false}` if the store is unreachable |
| GET | `/v1/save` | yes | `200 {v:1, at, objective, save}` | `404 {error:"no_save"}` |
| PUT | `/v1/save` | yes | `200 {ok:true, at}` | `409 {error:"stale", at}` if the stored save is as new or newer |
| POST | `/v1/event` | no | `204` | |
| POST | `/v1/feedback` | no | `204` | |

**Sync key.** Sent as `Authorization: Bearer <key>`. The key is upper-cased and dashes and
spaces are removed; what is left must be 12 to 32 characters of Crockford base32
(`0-9 A-Z` without `I L O U`). Anything else is `401 {error:"bad_key"}`.

**PUT /v1/save** body: `{v:1, at:<ms timestamp, integer > 0>, objective:<string, cut to 120
chars>, save:<string, 1..245760 chars>}`. The write only happens if `at` is newer than the stored
`at` (one atomic statement in Postgres).

**POST /v1/event** body: `{name, build, platform, sid}` where `name` matches
`^[a-z0-9_.:-]{1,48}$`, `build` is at most 40 chars, `platform` is one of `touch`, `keyboard`,
`pad`, `unknown`, and `sid` matches `^[a-z0-9]{8,24}$`.

**POST /v1/feedback** body: `{text, build, platform, progress?, contact?}`: `text` 1..4000 chars
after trimming, `progress` at most 120, `contact` at most 200.

The body does not have to be sent as `application/json`; it is parsed as JSON whatever the
content type.

Errors: `400 bad_request`, `401 bad_key`, `403 origin_not_allowed`, `404 not_found`,
`405 method_not_allowed`, `413 too_large` (save bodies over 300 KB, event/feedback bodies over
32 KB), `429 rate_limited` (with `Retry-After` in seconds), `500 internal`.

**Rate limits** (per client IP, held in memory, reset on restart):

| What | Limit |
| --- | --- |
| GET + PUT `/v1/save` combined | 120 per minute |
| `/v1/event` | 120 per minute |
| `/v1/feedback` (valid submissions) | 5 per hour |
| GET `/v1/save` answering 404 | 30 per hour, then every GET from that IP is 429 until the window ends |
| Brand-new save ids | 10 per hour (updating an existing save is unaffected) |

IPv6 clients are counted per /64.

## Environment variables

| Name | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `DATABASE_URL` | unset | Postgres connection string. When unset the service uses an in-memory store and **nothing is persistent** (it says so at startup) |
| `ALLOWED_ORIGINS` | empty | Comma-separated browser origins allowed by CORS. See below |
| `TRUST_PROXY` | `1` | When `1`, the client IP is `CF-Connecting-IP`, else the first `X-Forwarded-For` entry, else the socket address. Set to `0` if the service is reachable directly |

`ALLOWED_ORIGINS` entries are either exact origins or contain one `*`:

```
ALLOWED_ORIGINS=https://nattyman.github.io,https://*.itch.zone,http://localhost:*
```

- `https://*.itch.zone`: the `*` is exactly one subdomain label.
- `http://localhost:*`: the `*` is any port.

A request with an `Origin` header that is not on the list gets `403` (except `/health`). Requests
with no `Origin` header (curl, health checks) are let through. Entries the service cannot use are
named in a warning at startup. If the list is empty, no browser can use the service.

Keep `TRUST_PROXY=1` only when every request arrives through the proxy or tunnel: those headers
can be set by anyone who can reach the port directly, which would let them dodge the rate limits.

## Run locally

```
cd server
npm install
ALLOWED_ORIGINS='http://localhost:*' npm start          # in-memory store
curl http://localhost:3000/health
```

With Postgres:

```
DATABASE_URL=postgres://user:pass@localhost:5432/lighthouse ALLOWED_ORIGINS='http://localhost:*' npm start
```

The tables (`saves`, `events`, `feedback`) are created at startup if they do not exist.

## Tests

```
cd server
npm test                      # node --test "test/*.test.js", in-memory store
```

The Postgres tests are skipped unless `TEST_DATABASE_URL` points at a database you do not mind
filling with test rows:

```
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/lighthouse_test npm test
```

## Deploy on Coolify

1. New resource from this Git repository.
2. Build pack: **Dockerfile**. Base directory: `/server`. Dockerfile location: `/Dockerfile`.
3. Port (exposes): `3000`.
4. Add a **PostgreSQL** database in the same project and copy its internal connection URL into
   the app's `DATABASE_URL` environment variable.
5. Set `ALLOWED_ORIGINS` to the origins the game is served from.
6. Health check: path `/health`, port `3000` (the image also carries its own `HEALTHCHECK`).
7. Deploy, then point the domain or Cloudflare Tunnel at the app and check
   `https://<domain>/health` answers `{"ok":true}`.

If `/health` answers 503 the app cannot reach the database: check `DATABASE_URL`.

Behind a Cloudflare Tunnel, add a public
hostname to the tunnel for the service and send it to Coolify's proxy, `http://localhost:80`;
in Coolify give the app that same hostname as its domain.

For the public beta: `ALLOWED_ORIGINS=https://nattyman.github.io,https://*.itch.zone`
(GitHub Pages, and the frame itch.io serves browser games from).

## Reading what comes in

From the database's terminal in Coolify (or any `psql` connected to it):

```sql
-- feedback, newest first
select created_at, build, platform, progress, contact, text from feedback order by created_at desc limit 50;
-- how far players get: sessions that reached each milestone
select name, count(distinct sid) as sessions from events group by name order by sessions desc;
-- saves being synced
select count(*) as saves, max(updated_at) as latest from saves;
```

## Layout

```
src/index.js   reads the environment, builds the store, listens, shuts down on SIGTERM
src/app.js     createApp({ store, config }) -> (req, res) handler: routing, CORS, limits, validation
src/store.js   createMemoryStore() and createPgStore(databaseUrl)
test/          node --test suites
```
