# Lighthouse save service

A small HTTP service for Brave Quest: Lighthouse. It stores:

- **game saves**, keyed by an anonymous sync code the player carries between devices;
- **anonymous progress events** (which build, which input type, which milestone);
- **player feedback**;
- **player records** for the Keepers' Board (best times, deaths, completion, an optional display name).

There are no accounts. The service does not store IP addresses, and it never stores the sync
code itself, only `sha256(code)`. The only things a player can identify themselves with are the
optional `contact` field on feedback and the optional board name, both filled in by choice.

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
| PUT | `/v1/record` | yes | `200 {ok:true, name}` | `404 {error:"no_save"}`, `409 {error:"name_taken"}`, `400 {error:"name_invalid"}` |
| GET | `/v1/record` | yes | `200 {name, crew, …}` | `404 {error:"no_record"}` |
| GET | `/v1/board` | optional | `200 {b, crew, rows, you?}` | |

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

**PUT /v1/record** body (the display name is tied to the sync code: the code is the password,
the name is the username):

```
{ name?, crew?, build, play, deaths, pct, badges, rank, days,
  splits: { <milestoneId>: <seconds of play when reached> | null },
  bosses: { <bossId>: <best winning fight, seconds> | null } }
```

- A record needs a save for the same code (`404 no_save` otherwise). The game uploads its save
  first, so this only refuses codes that have never synced, and it means new board entries are held
  to the same "new save ids" limit as saves.
- `name`: omitted or `null` keeps the stored name; `""` takes the player off the boards (and frees
  the name). Otherwise it is trimmed and runs of spacing become one space; then it must be 3 to 16
  characters of ASCII letters, digits, space, `_`, `-`, `'` (a curly `’` becomes `'`), with at least one
  letter or digit, and must not contain a word from `src/blocked-words.js` (checked on a form with no
  case, spacing or punctuation, digit swaps like `1`/`3`/`5` undone and repeated letters squeezed).
  Breaking a rule is `400 name_invalid`. Names are unique ignoring case: `409 name_taken`, and
  then **nothing in the upload is written**, so send `name` only when the player sets or changes it.
  The answer's `name` is the name now stored (`""` if none).
- `crew`: omitted or `null` keeps it; `""` leaves the crew; else 4 to 12 of `A-Z 0-9` after trimming
  and upper-casing (`400 bad_request` otherwise).
- `build` at most 40 chars; `play` 0..50 000 000, `deaths` 0..1 000 000, `pct` 0..100, `badges`
  0..1000, `rank` 0..20, `days` 0..10 000, all integers.
- `splits`: keys are milestone ids, in order `ashore, plain-flame, stag, lantern, staff, lamp-cured,
  gloaming, undertow, crane, answer, sailed, giant`. Values are integers 0..`play`, or `null` for a
  milestone reached without a time (it is stored but skipped by the checks below). The times must not
  decrease in milestone order. The `gloaming` time is the Act 1 time and must be at least 300 s; the
  `giant` time is the full-game time and must be at least 1200 s.
- `bosses`: keys are `stag, gloaming, undertow, crane, answer, giant`; values integers of at least 10 s
  (`null` = no win yet, ignored).
- Anything else is `400 bad_request`. Unknown extra fields are ignored.
- **Bests only improve**: the Act 1 time, the full-game time, each boss time, and the deaths of a
  finished full run keep the lower of the stored and sent values. Everything else (build, play,
  deaths, pct, badges, rank, days, splits) is replaced by the latest upload.

**GET /v1/record** returns the caller's own record: `{name, crew, build, play, deaths, pct, badges,
rank, days, act1, full, fullDeaths, splits, bosses, at}` (`act1`, `full`, `fullDeaths` are `null`
until reached; `at` is the last upload, ms).

**GET /v1/board**`?b=<board>&crew=<code>&limit=<n>`

- `b`: `act1` (fastest Act 1), `full` (fastest full game), `deaths` (finished full runs only: fewest
  deaths, then the faster full time), `pct` (highest completion, then least play time), or
  `boss:<bossId>` (fastest win).
- `crew` (optional, any case): only that crew. `limit`: 1..100, default 25.
- Answer: `{b, crew, rows:[{pos, name, value, rank, badges, at}]}`. `value` is seconds, a death count
  or a percentage. Equal values (after the second key above) go to the record created first, so
  positions are unique. Rows with no name or hidden by moderation are never listed and take no
  position.
- With `Authorization: Bearer <code>` the answer also has `you`: `{pos, value}` for the caller even
  outside the limit, `{pos:null, value}` if the caller has a value but is not listed (no name,
  hidden, or not in that crew), or `null` (no record, or nothing on that board). A malformed key is
  `401 bad_key`; without the header there is no `you`.

The body does not have to be sent as `application/json`; it is parsed as JSON whatever the
content type.

Errors: `400 bad_request`, `400 name_invalid`, `401 bad_key`, `403 origin_not_allowed`,
`404 not_found` (unknown path), `404 no_save`, `404 no_record`, `405 method_not_allowed`,
`409 stale`, `409 name_taken`, `413 too_large` (save bodies over 300 KB, event/feedback/record
bodies over 32 KB), `429 rate_limited` (with `Retry-After` in seconds), `500 internal`.

**Rate limits** (per client IP, held in memory, reset on restart):

| What | Limit |
| --- | --- |
| GET + PUT `/v1/save` combined | 120 per minute |
| `/v1/event` + PUT `/v1/record` combined | 120 per minute |
| GET `/v1/board` + GET `/v1/record` combined | 30 per minute |
| `/v1/feedback` (valid submissions) | 5 per hour |
| GET `/v1/save` answering 404 | 30 per hour, then every GET `/v1/save` and GET `/v1/record` from that IP is 429 until the window ends (a GET `/v1/record` 404 does not count) |
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

The tables (`saves`, `events`, `feedback`, `records`) and their indexes are created at startup if
they do not exist (`CREATE … IF NOT EXISTS`, under an advisory lock). Deploying this version on a
database that already has the other tables needs no manual step: the `records` table appears on the
first start. That only covers new tables and indexes: a later change to the columns of an existing
table would need its own `ALTER TABLE`, because `IF NOT EXISTS` leaves an existing table as it is.

`records` (one row per sync code):

| Column | Meaning |
| --- | --- |
| `id` | sha256 of the sync code, as `saves.id` |
| `name`, `name_key` | display name and its lower-cased form; `''` = not on the boards. `name_key` is unique when not `''` (`records_name_key_idx`) |
| `crew` | crew code, `''` = none |
| `build`, `play`, `deaths`, `pct`, `badges`, `rank`, `days` | latest upload |
| `act1`, `full_run` | best seconds of play at the gloaming / giant milestones, `null` if not reached |
| `full_deaths` | fewest deaths on a finished full run, `null` until one is finished (the `deaths` board) |
| `splits`, `bosses` | jsonb: latest run's milestone times; best boss times |
| `hidden` | set by moderation; hidden rows are never listed |
| `created_at`, `updated_at` | |

Moderation (hide or rename a row) is done in SQL, outside the service.

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
-- named records, newest first; hide one by name
select name, crew, act1, full_run, full_deaths, pct, updated_at from records where name <> '' order by updated_at desc limit 50;
update records set hidden = true where name_key = lower('Some Name');
```

## Layout

```
src/index.js   reads the environment, builds the store, listens, shuts down on SIGTERM
src/app.js     createApp({ store, config }) -> (req, res) handler: routing, CORS, limits, validation
src/records.js record and board rules: milestone and boss ids, floors, ranges, name and crew checks
src/blocked-words.js  the words a board name may not contain (extend it here)
src/store.js   createMemoryStore() and createPgStore(databaseUrl)
test/          node --test suites
```
