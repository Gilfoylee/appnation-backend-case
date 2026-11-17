# Delivery notes

Supplementary material, not part of the README's 250 words.

## If the service scales to 10 instances and Redis is unavailable for one minute

- **Quota stays exact.** It lives in PostgreSQL and every instance reserves through the same atomic conditional upsert, so the limit holds across all 10 instances and does not depend on Redis at all.
- **The cache degrades to "always miss", without errors or memory growth.** The Redis client has no offline queue and a 200 ms command timeout, so each instance fails fast and serves from the provider. For that minute nothing is `cached: true`: repeated prompts call the provider and consume quota, users at their limit get 429 instead of a cached answer, and provider load rises to the full request rate. When Redis is back, clients reconnect by themselves; entries that have not expired are served again (a restarted Redis comes back empty, as it is a pure cache) and misses refill it.
- **Change 1, protect the provider:** add a circuit breaker around Redis so instances stop paying the failed round trip, and single-flight identical prompts (e.g. a PostgreSQL advisory lock per prompt hash) so a cold cache does not cause a stampede.
- **Change 2, keep cached semantics during outages:** a small durable results table in PostgreSQL (`prompt_hash`, `result`, `expires_at`) as a second-level cache, plus Redis with a replica and automatic failover (Sentinel or a managed service).
- **Change 3, size PostgreSQL for it:** without Redis every repeated prompt adds a quota upsert, and 10 instances × `DB_POOL_MAX=10` already reach PostgreSQL's default `max_connections` of 100, so I would lower the per-instance pool or put PgBouncer in front.

## AI usage

I used Claude (Claude Code) as a pair programmer for scaffolding, drafting code and tests, and reviewing the concurrency design. I verified its suggestions by reading every change, running the test suite against real PostgreSQL and Redis, running `scripts/verify.sh` against `docker compose`, and checking the EXPLAIN ANALYZE output.

## API

All errors have the shape `{ "error": "<code>" }`. Every `/v1` route requires a non-empty `X-User-Id` header (`401 unauthorized`) of at most 128 characters (`400 invalid_user_id`).

| Endpoint | Success | Errors |
|---|---|---|
| `POST /v1/generations` `{ "prompt": string }` | `201 { id, prompt, result, cached, createdAt }` | `400 invalid_prompt`, `400 invalid_request` (malformed JSON), `413 payload_too_large`, `415 unsupported_media_type`, `429 quota_exceeded`, `502 provider_error`, `504 provider_timeout` |
| `GET /v1/generations?limit=20&cursor=…` | `200 { items, nextCursor }` (newest first; `nextCursor` is `null` on the last page) | `400 invalid_limit`, `400 invalid_cursor` |
| `GET /v1/quota` | `200 { limit, used, remaining, resetsAt }` | |
| `GET /health` | `200 { status: "ok" }` | |

`limit` defaults to 20 and values above 100 are capped at 100; a non-positive, non-integer or repeated value is rejected. Unknown routes answer `404 not_found`, unexpected failures `500 internal_error`.

## Design decisions

- **Request flow:** validate → cache lookup → reserve quota → provider (3 s deadline) → cache + store. A cache hit is stored in history with `cached: true` and never touches the quota, so it also works for users at their limit.
- **Reserve before calling the provider.** In-flight requests count toward the limit, which is what makes 10 concurrent requests produce exactly 5 × 201 and 5 × 429, and requests known to be over quota never reach the provider. Errors, timeouts and failed inserts release the unit, against the same `usage_date` that was reserved, so a request that crosses midnight cannot refund the wrong day. The trade-off is deliberate: while an in-flight request holds the last unit, a concurrent request gets 429 even if that request later fails and returns the unit. The quota can be under-used for a moment but never exceeded.
- **`timestamptz(3)`.** PostgreSQL stores microseconds by default, while JavaScript dates have milliseconds. Storing milliseconds lets the cursor carry `createdAt` exactly, so keyset comparisons never skip or repeat rows.
- **Opaque cursor** = base64url of `{ createdAt, id }` of the last row. The query always filters by the requesting user, so a cursor from another user cannot leak data.
- **Cache key** = `generation:v1:` + SHA-256 of the normalized prompt (trim, lowercase, collapse whitespace), giving short, fixed-size keys; TTL is 600 s. The provider also receives the normalized prompt, so a shared cached result is exactly what any equivalent prompt would get. Redis runs as a pure cache: `maxmemory` with LRU eviction and no snapshots.
- **Prompt validation:** length is counted in Unicode code points, the same unit as PostgreSQL's `char_length` CHECK constraint. NUL characters are rejected with 400 because PostgreSQL text cannot store them; otherwise they would only fail after the provider call.
- **Bounded resources:** no in-process quota or cache state, a bounded `pg` pool, history reads `limit + 1` rows, 32 KiB body limit, and every provider timer is cleared when its call settles or is aborted.
- **The identity check runs in `onRequest`,** before body parsing, so unidentified requests get 401 without their payload being read.
- **Migrations run as a one-shot compose service,** so scaled app instances never race to migrate.
- **Ports:** compose publishes PostgreSQL and Redis on `127.0.0.1:55432` and `127.0.0.1:56379` only, so they never clash with local instances or reach the network; the API port can be changed with `APP_PORT` (default 3000).
- **Business rules are configuration:** `DAILY_QUOTA`, `CACHE_TTL_SECONDS`, `PROVIDER_TIMEOUT_MS` (see `.env.example`, which the `*:dev` scripts load from `.env`).

## Tests

`npm test` runs 92 tests in about 7 seconds: 35 unit tests, plus 57 integration tests against real PostgreSQL 17 and Redis 7.4 started by Testcontainers. `npm run test:unit` needs no Docker.

- Required (a): `test/integration/quota-concurrency.test.ts` sends 10 concurrent prompts and expects 5 × 201, 5 × 429, 5 rows and 5 provider calls. It fails against a check-then-act implementation (verified by temporarily breaking the reservation: 10 × 201).
- Required (b): `test/integration/cache.test.ts` sends `merhaba` then `MERHABA` and expects `cached: true`, no second provider call and an unchanged remaining quota.
- Also covered: a 50-request burst, a burst that only gets the remaining allowance, concurrent provider failures returning their units, 401/400/413/415 with no side effects, 502 and 504 not counted, a failed insert refunded (500), a failure across midnight refunded to the reserved day, cached results after the quota is exhausted, errors not cached, the Redis-down fail-open path, quota persistence across a restart, the UTC midnight rollover (injected clock), and keyset pagination over rows sharing a `createdAt`.
- The provider is the real fake with shortened delays, wrapped to record calls. Timing-sensitive unit tests use fake timers, so no test waits in real time.
- To run the integration tests against already running instances instead of Testcontainers, set `TEST_DATABASE_URL` and `TEST_REDIS_URL`. The tests truncate tables and flush the Redis database, so use a dedicated database and Redis index, e.g. `postgres://app:app@localhost:55432/generations_test` (create it first) and `redis://localhost:56379/1`.

## Tips for manual testing

- I've sent you a Postman collection for manual testing.
- The fake provider reacts to how the prompt starts: `error…` returns 502 (e.g. `error deneme`), `timeout…` returns 504 after ~3 s (e.g. `timeout deneme`), and `slow…` returns 201 after ~2 s (e.g. `slow request`).
- Error responses to try:

  | Request | Response |
  |---|---|
  | no `X-User-Id` header | `401 unauthorized` |
  | body `{"prompt":" "}` | `400 invalid_prompt` |
  | malformed JSON body, e.g. `{"prompt":` | `400 invalid_request` |
  | `?limit=0` | `400 invalid_limit` |
  | `?cursor=abc` | `400 invalid_cursor` |

- To browse 100,000 records, run `docker compose exec app npm run seed`, then send `X-User-Id: seed-user`.
- To send 10 parallel requests from a terminal (each run uses a new user id):

  ```bash
  seq 1 10 | xargs -P 10 -I{} curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/v1/generations -H "X-User-Id: parallel-$RANDOM" -H "Content-Type: application/json" -d '{"prompt":"parallel {}"}'
  ```
