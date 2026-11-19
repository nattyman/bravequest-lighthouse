# Lighthouse save service

A small HTTP service for Brave Quest: Lighthouse. It stores:

- **game saves**, keyed by an anonymous sync code the player carries between devices;
- **anonymous progress events** (which build, which input type, which milestone);
- **player feedback**;
- **player records** for the Keepers' Board (best times, deaths, completion, an optional display name).

Optional **keeper accounts** (sign in by emailed link, six-digit code or password) are built in but
switched off unless configured: see [Accounts](#accounts). Guests and their sync codes work exactly
the same either way.

The service does not store IP addresses, and it never stores the sync code itself, only
`sha256(code)`. Without an account, the only things a player can identify themselves with are the
optional `contact` field on feedback and the optional board name, both filled in by choice. With an
account the service also holds the account's email address.

Node 22, plain JavaScript, built-in `node:http`, `node:crypto` and `fetch`. One runtime dependency: `pg`.

## Endpoints

All responses are JSON with `Cache-Control: no-store`.

| Method | Path | Key | Success | Notes |
| --- | --- | --- | --- | --- |
| GET | `/health` | no | `200 {ok:true}` | `503 {ok:false}` if the store is unreachable |
| GET | `/v1/save` | yes | `200 {v:1, at, objective, save}` | `404 {error:"no_save"}` |
| PUT | `/v1/save` | yes | `200 {ok:true, at}` | `409 {error:"stale", at}` if the stored save is as new or newer |
| POST | `/v1/event` | no | `204` | |
| POST | `/v1/feedback` | no | `204` | |
| PUT | `/v1/record` | yes | `200 {ok:true, name}` | `404 {error:"no_save"}`, `409 {error:"name_taken"}`, `400 {error:"name_invalid"}`, `403 {error:"account_needed"}` (see [Accounts](#accounts)) |
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
  milestone reached without a time (it is stored but skipped by the checks below). A time must not
  be earlier than a milestone the story puts ahead of it (the lantern after the Stag, the dungeons after
  the Gloaming, the giant after sailing); where the story leaves the order open, any order is accepted. The `gloaming` time is the Act 1 time and must be at least 300 s; the
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
| `ACCOUNTS` | unset | `on` switches accounts on, if the four settings below are also set. Otherwise every account path answers `503 {error:"accounts_off"}` |
| `APP_URL` | unset | The game's address; sign-in links are `APP_URL?signin=<token>` |
| `SESSION_SECRET` | unset | At least 32 random characters. Keys the hashes of sign-in links and codes |
| `RESEND_API_KEY`, `MAIL_FROM` | unset | The mail sender (Resend), e.g. `MAIL_FROM=Brave Quest <keeper@example.com>` |
| `MAIL_FAKE` | unset | `1`: keep emails in memory instead of sending them (local use and tests only; nothing is sent or logged) |
| `COOKIE_INSECURE` | unset | `1`: leave `Secure` off the session cookie (local use over plain http only) |
| `SUPER_ADMIN_EMAILS` | empty | Comma-separated addresses that are made `admin` at every sign-in and cannot be demoted, disabled or deleted |
| `ADMIN_API_KEY` | unset | At least 32 characters. Turns on the private admin API under `/admin/v1` (answers 404 while unset) |

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

## Accounts

Accounts are optional: a player can sign in to keep their keeper name and saves across
devices. There is no sign-up form: the first successful sign-in by link or code creates
the account; a password can be added afterwards.

They are **off** unless `ACCOUNTS=on`, `APP_URL`, `SESSION_SECRET` and a mail sender are all set
(the start-up log says which are missing, by name). While off, `/v1/auth/*`, `/v1/me` and
`/v1/saves*` answer `503 {error:"accounts_off"}` and nothing else changes.

**Sessions.** Signing in sets the cookie `bq_s` (a random 32-byte token; the database keeps only its
SHA-256): `Path=/; Max-Age=5184000; HttpOnly; Secure; SameSite=Lax`, no `Domain`. A signed-in request
more than a day after the last renewal sets the cookie again and moves the expiry to 60 days from then.
Sessions that expire are deleted.

**Who a request belongs to.** A live `bq_s` cookie means that account; otherwise a valid
`Authorization: Bearer <sync code>` means that guest, exactly as before; with both, the account wins.

**Browsers.** Account paths (and, while accounts are on, every `/v1` path) allow the `X-BQ-Client`
header and `DELETE` in CORS. Only origins listed exactly in `ALLOWED_ORIGINS` get
`Access-Control-Allow-Credentials: true`; wildcard entries (itch.io, `localhost:*`) never do, so to test
accounts locally list the exact origin, e.g. `http://localhost:8996`. Any request that uses the cookie
and is not GET/HEAD, and the sign-in routes that make a session (`code`, `link`, `password`), must carry
`X-BQ-Client: 1` and an exactly-listed `Origin`, else `403 {error:"bad_origin"}`.

| Method | Path | Success | Errors |
| --- | --- | --- | --- |
| POST | `/v1/auth/start` `{email}` | `200 {ok:true, id}` and one email with a link and a six-digit code | `400 bad_email`, `429` |
| POST | `/v1/auth/code` `{id, code}` | `200 {ok:true, me}` + cookie | `400 {error:"bad_code", left}`, `410 expired`, `403 disabled` |
| POST | `/v1/auth/link` `{token}` | `200 {ok:true, me}` + cookie | `410 expired`, `403 disabled` |
| POST | `/v1/auth/password` `{email, password}` | `200 {ok:true, me}` + cookie | `401 bad_login` |
| POST | `/v1/auth/signout` `{everywhere?}` | `200 {ok:true}`, cookie cleared | |
| GET | `/v1/me` | `200 me` | `401 signed_out`, `403 disabled` |
| PUT | `/v1/me` `{name?, password?:{new, current?}}` | `200 {ok:true, me}` | `400 name_invalid`, `409 name_taken`, `400 weak_password`, `401 bad_login`, `403 reauth` |
| DELETE | `/v1/me` | `200 {ok:true}`, cookie cleared | `403 reauth`, `409 super` |

`me` is `{id, email, name, role, tools, hasPassword, created}` (`created` in ms).

- `start` answers the same for every well-formed address (new, existing, disabled, or over its limit),
  so it never shows whether an address has an account. The link and the code expire after 15 minutes
  and work once; using either spends both, and a successful sign-in retires any other sign-in emails
  still waiting for that address. A code allows five wrong tries; the answer says how many are left.
- Every password sign-in failure is the same `401 bad_login`, and takes the same scrypt work.
  Passwords are 10 to 200 characters and not on a short list of common ones. They are stored as
  `scrypt$N$r$p$salt$hash` (N=16384, r=8, p=1, random salt); at most two hashes run at once and 16 wait,
  beyond that the answer is `429`.
- Setting a first password, and deleting the account, need a session made in the last 15 minutes
  (`403 reauth`: sign in again). Changing a password needs the current one; it ends the account's
  other sessions and sends a "password changed" email.
- `name` is the keeper name, with the same rules as the board name; it is unique across accounts and
  guests' board names. `""` clears it.
- Deleting the account removes it with its save slots, its board record and its sessions, and sends an
  "account deleted" email. A super admin cannot delete their account.
- Roles: `player` (no test tools), `tester` (the tool groups in the `tester_tools` setting, by default
  `start, give, map, teleport`, plus any ticked for the account), `admin` (all six: `start, cheats, give,
  map, teleport, monsters`).

**Save slots** (signed in only: guests and signed-out callers get `401 {error:"signed_out"}`; writes need
the `X-BQ-Client` / `Origin` check above). Ten slots, numbered 1 to 10; any other slot in the path is
`400 {error:"bad_slot"}`.

| Method | Path | Success | Errors |
| --- | --- | --- | --- |
| GET | `/v1/saves` | `200 {max:10, slots:[{slot, name, test, at, objective, rec, updated}]}` (used slots, by number) | |
| GET | `/v1/saves/:slot` | `200 {slot, name, test, at, objective, rec, body, updated}` | `404 no_save` |
| PUT | `/v1/saves/:slot` | `200 {ok:true, at, test}` | `409 {error:"stale", at}`, `400 bad_request`, `413 too_large` |
| POST | `/v1/saves/:slot/rename` `{name}` | `200 {ok:true}` | `404 no_save`, `400 bad_request` |
| DELETE | `/v1/saves/:slot` | `200 {ok:true}` (also when the slot was empty) | |
| POST | `/v1/saves/claim` `{code, slot?}` | `200 {ok:true, slot, name}` | `404 no_save`, `409 {error:"full"}`, `409 {error:"slot_taken"}`, `401 bad_key`, `400 bad_slot` |

- **PUT** body: the `/v1/save` body, `{v:1, at, objective, save}`, with the same checks and the same 300 KB
  limit (`v` may be left out, and `body` is accepted in place of `save`), plus optional `rec`, `name`, `test`.
  **Newer wins, exactly as `PUT /v1/save`**: if the slot holds a save whose `at` is as new or newer, nothing is
  written (not the name, `rec` or `test` either) and the answer is `409 {error:"stale", at:<the stored at>}`.
  `rec` is the slot list's summary: `{play?, pct?, rank?, ri?}`, each a number, a string of at most 40
  characters or `null` (other keys are dropped); left out, the stored one is kept. `name` (1 to 24 characters
  after trimming, no control characters): left out, the stored one, else `Save <slot>`. `test` (boolean) is
  sticky: once a slot is a test save it stays one until the slot is deleted; the answer's `test` says what
  is stored. `updated` (ms) is when the server last wrote the slot; `at` is the game's own save time.
- **Claim** moves the guest save stored under the sync code `code` into `slot` (1 to 10; the first free slot
  when left out), all in one transaction: the guest's board record is merged into the account's (the
  Act 1, full-game, boss times and the deaths of a finished run keep the lower value; build, play, deaths,
  completion, badges, rank, days and splits come from whichever record was uploaded last; the crew is the
  account's unless it has none), the guest's keeper name moves to the account if the account has none
  (and nobody else holds it), and the guest's save and record are deleted, so the code is retired. The
  answer's `name` is the account's keeper name afterwards (`""` if none). A code with no save is `404
  no_save` and counts as a failed lookup, in the same budget as `GET /v1/save` (30 an hour per client: past
  it both answer 429); claims are also limited to 20 an hour per client and per account. A malformed code is
  `401 bad_key`, as on the guest routes.

**Records and boards with an account.** `PUT /v1/record`, `GET /v1/record` and `GET /v1/board` follow the
same rule as everything else: a live session cookie wins over a Bearer code. For an account the record's
id is `a:<account id>`; it needs no guest save, but at least one save slot that is not a test save (`404
no_save` otherwise). `name` in the body sets the account's keeper name (the same as `PUT /v1/me`, so the two
never disagree; `409 name_taken` writes nothing); the answer's `name` is the keeper name. A body with
`test:true` is `400 bad_request`. On boards, `you` is the account's. Cookie writes need the request check.

For guests nothing changes, except that **while accounts are on a guest cannot take a new name**: a `PUT
/v1/record` whose `name` is not `""` is `403 {error:"account_needed"}` (nothing written) unless the guest's
record already has that name (any case). A guest who has a name keeps it, may send it again, and may clear
it with `""` (after which a new one needs an account). While accounts are off, guests set names as before.
Every write of a keeper name, in records or accounts, takes the same lock in Postgres, so a name cannot be
taken twice by a guest and an account at once.

**Limits** (in memory, per process; all in `src/accounts/limits.js`): `start` 5 an hour per address
(over it: the usual answer, no email) and 20 an hour per client; `code` + `link` 60 per 15 minutes per
client; `password` 10 per 15 minutes per address and client, 30 per client; `/v1/me` and `signout` 120 a
minute per client; `/v1/saves*` 120 a minute per client; claims as above. Every `429` has `Retry-After`.

**Email** goes through Resend's API (`RESEND_API_KEY`, `MAIL_FROM`). A failed send is logged as one
line without the address, and does not change any answer. The service never logs addresses, tokens,
codes, cookies or passwords.

**Tables** (created at start-up like the others; the existing tables are not changed):
`accounts`, `sessions`, `sign_ins`, `account_saves`, `audit`, `settings`. An account's board record is a
row in `records` with id `a:<account id>`.

## Private admin API

`/admin/v1/*` is for the studio admin site only, never for players or browsers. It works whether or
not accounts are on (only the sign-in email needs them), and it is answered before CORS.

**The guard**, checked in this order for every path under the prefix:

1. `ADMIN_API_KEY` unset or shorter than 32 characters: `404 {error:"not_found"}` (the prefix does not exist).
2. A `CF-Connecting-IP` or `CF-Ray` header (the request came through the public Cloudflare Tunnel) or an
   `Origin` header (a browser): `404`, even with the right key.
3. `X-Admin-Key` missing or not equal to `ADMIN_API_KEY` (constant-time compare): `401 {error:"admin_key"}`.
4. `X-Admin-Email` missing or not an address: `400 {error:"admin_email"}`. It names the signed-in admin and
   is recorded (lower-cased) in the audit log.

Node's own `fetch` sends no `Origin` header, so the admin's server-side calls pass step 2.

**How the admin reaches it.** The admin calls the service on the internal Coolify network, at the
service's internal address (for example `http://<service container name>:3000`, set as the admin's
`SERVICE_URL`), never through the public hostname: anything that comes through the tunnel is refused.
Both sides share the same `ADMIN_API_KEY`, kept in Coolify.

All answers are JSON with `Cache-Control: no-store`. Dates are epoch milliseconds. Pages are 1-based;
`per` is 50 by default and at most 200. A malformed or unknown account id is `404 {error:"not_found"}`
on every account path.

| Method | Path | Success | Errors |
| --- | --- | --- | --- |
| GET | `/accounts?q=&role=&status=&page=&per=` | `{total, page, per, rows:[{id, email, name, role, status, created, lastSeen, saves, super}]}` | `400 bad_request` (unknown role/status, bad paging) |
| GET | `/accounts/:id` | `{account:{id, email, name, role, tools, status, hasPassword, created, lastSeen, super}, saves:[{slot, name, test, at, objective, rec, updated, bytes}], sessions:[{created, lastUsed, note}], record}` | `404` |
| POST | `/accounts/:id` `{role?, tools?, status?, name?}` | `{ok:true, account}` | `400 bad_request`, `400 name_invalid`, `409 name_taken`, `409 super`, `404` |
| POST | `/accounts/:id/signout` | `{ok:true, ended}` | `404` |
| POST | `/accounts/:id/signin-email` | `{ok:true}` | `404`, `409 disabled`, `502 mail_failed`, `503 accounts_off` |
| DELETE | `/accounts/:id` | `{ok:true}` | `409 super`, `404` |
| GET | `/accounts/:id/saves/:slot` | `{slot, name, test, at, objective, rec, body}` | `400 bad_slot`, `404 no_save`, `404` |
| DELETE | `/accounts/:id/saves/:slot` | `{ok:true}` | `400 bad_slot`, `404 no_save`, `404` |
| GET | `/audit?page=&per=` | `{total, page, per, rows:[{at, admin_email, action, account_id, email, detail}]}` | `400 bad_request` |
| GET | `/settings` | `{testerTools}` | |
| PUT | `/settings` `{testerTools}` | `{ok:true, testerTools}` | `400 bad_request` |

- `q` matches part of the email or the keeper name, ignoring case (taken literally). The list is newest
  first; `saves` is the number of used slots; `super` marks the addresses in `SUPER_ADMIN_EMAILS`.
- `sessions` lists live sessions only, and never their token hashes. `record` is the account's board
  record as `GET /v1/record` gives it, or `null`. `bytes` is the save's length in characters.
- `POST /accounts/:id`: the admin sends one field at a time; several are accepted and all are checked
  before anything is written. `role` is `player`, `tester` or `admin`; `tools` a list of the six tool
  groups (stored without repeats, in the panel's order); `status` `active` or `disabled`; `name` the
  keeper name with the same rules and storage as `PUT /v1/me` (the account's record row follows it;
  `""` clears it). Disabling ends all the account's sessions at once.
- A super admin cannot be changed or deleted here (`409 super`); signing them out, sending them a
  sign-in email and their saves work as for anyone.
- The sign-in email is the normal one (link and code, 15 minutes, once). Deleting removes the account,
  its saves, its record, its sessions and any sign-ins waiting for its address (no email is sent).
- `testerTools` is the set every tester gets (default `start, give, map, teleport`).
- **Audit.** Every change, and every download of a whole save, writes one `audit` row: the admin's
  email, an action (`role`, `tools`, `disable`, `enable`, `name`, `signout`, `signin-email`, `delete`,
  `save-download`, `save-delete`, `settings`), the account id and a `detail` of what changed (`from`,
  `to`, counts, the slot). Never a save body, token, code or password. In the list, `email` is the
  account's current address, or `null` once it is deleted (a deletion's `detail` keeps the address).

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

The tables (`saves`, `events`, `feedback`, `records`, and the account tables) and their indexes are
created at startup if they do not exist (`CREATE … IF NOT EXISTS`, under an advisory lock). Deploying this version on a
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

The account tests use a fake clock and a fake mailer; the admin API tests (`test/admin.test.js`, and
`test/pg_admin.test.js` against Postgres) call a listening server with `fetch` the way the admin does; one of the Postgres tests builds the schema of
the version before accounts in a schema of its own, fills it, and checks that starting the new code
leaves every row and column as it was.

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
src/http.js    request helpers shared by all routes: sync keys, client address, bodies, answers, limiter
src/records.js record and board rules: milestone and boss ids, floors, ranges, name and crew checks
src/blocked-words.js  the words a board name may not contain (extend it here)
src/store.js   createMemoryStore() and createPgStore(databaseUrl); mounts the account stores below
src/stores/accounts.js  accounts, sessions, sign_ins (memory + Postgres)
src/stores/slots.js     account_saves
src/stores/admin.js     audit, settings, the admin's account search
src/accounts/config.js       the account settings from the environment
src/accounts/limits.js       every account limit and constant
src/accounts/context.js      sessions, cookies, request checks, the owner resolver, roles and tools, `me`
src/accounts/crypto.js       tokens, hashes, scrypt passwords (with a concurrency cap)
src/accounts/mailer.js       Resend sender and the fake one; emails.js: the three emails
src/accounts/auth-routes.js  /v1/auth/* and /v1/me
src/accounts/saves-routes.js /v1/saves* (slots and claim)
src/accounts/admin-routes.js /admin/v1/* and its guard
test/          node --test suites
```
