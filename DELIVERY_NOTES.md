# Delivery notes

Supplementary material, not part of the README's 250 words.

## If the service scales to 10 instances and Redis is unavailable for one minute

- **Quota stays exact.** It lives in PostgreSQL and every instance reserves through the same atomic conditional upsert, so the limit holds across all 10 instances and does not depend on Redis at all.
- **The cache degrades to "always miss", without errors or memory growth.** The Redis client has no offline queue and a 200 ms command timeout, so each instance fails fast and serves from the provider. For that minute nothing is `cached: true`: repeated prompts call the provider and consume quota, users at their limit get 429 instead of a cached answer, and provider load rises to the full request rate. After Redis returns, clients reconnect on their own and the cache refills from cold.
- **Change 1, protect the provider:** add a circuit breaker around Redis so instances stop paying the failed round trip, and single-flight identical prompts (e.g. a PostgreSQL advisory lock per prompt hash) so a cold cache does not cause a stampede.
- **Change 2, keep cached semantics during outages:** a small durable results table in PostgreSQL (`prompt_hash`, `result`, `expires_at`) as a second-level cache, plus Redis with a replica and automatic failover (Sentinel or a managed service).

## AI usage

I used Claude (Claude Code) as a pair programmer for scaffolding, drafting code and tests, and reviewing the concurrency design. I verified its suggestions by reading every change, running the test suite against real PostgreSQL and Redis, running `scripts/verify.sh` against `docker compose`, and checking the EXPLAIN ANALYZE output.

## API

All errors have the shape `{ "error": "<code>" }`. Every `/v1` route requires a non-empty `X-User-Id` header (`401 unauthorized`).

| Endpoint | Success | Errors |
|---|---|---|
| `POST /v1/generations` `{ "prompt": string }` | `201 { id, prompt, result, cached, createdAt }` | `400 invalid_prompt`, `400 invalid_request` (bad JSON), `413 payload_too_large`, `429 quota_exceeded`, `502 provider_error`, `504 provider_timeout` |
| `GET /v1/generations?limit=20&cursor=…` | `200 { items, nextCursor }` (newest first; `nextCursor` is `null` on the last page) | `400 invalid_limit`, `400 invalid_cursor` |
| `GET /v1/quota` | `200 { limit, used, remaining, resetsAt }` | |
| `GET /health` | `200 { status: "ok" }` | |

`limit` defaults to 20 and values above 100 are capped at 100; a non-positive or non-integer value is rejected.

## Design decisions

- **Request flow:** validate → cache lookup → reserve quota → provider (3 s deadline) → cache + store. A cache hit is stored in history with `cached: true` and never touches the quota, so it also works for users at their limit.
- **Reserve before calling the provider.** In-flight requests count toward the limit, which is what makes 10 concurrent requests produce exactly 5 × 201 and 5 × 429, and requests known to be over quota never reach the provider. Errors, timeouts and failed inserts release the unit, against the same `usage_date` that was reserved, so a request that crosses midnight cannot refund the wrong day.
- **`timestamptz(3)`.** PostgreSQL stores microseconds by default, while JavaScript dates have milliseconds. Storing milliseconds lets the cursor carry `createdAt` exactly, so keyset comparisons never skip or repeat rows.
- **Opaque cursor** = base64url of `{ createdAt, id }` of the last row. The query always filters by the requesting user, so a cursor from another user cannot leak data.
- **Cache key** = `generation:v1:` + SHA-256 of the normalized prompt (trim, lowercase, collapse whitespace), giving short, fixed-size keys; TTL is 600 s. Redis runs with `maxmemory` and LRU eviction.
- **Prompt length** is counted in Unicode code points, the same unit as PostgreSQL's `char_length` CHECK constraint.
- **Bounded resources:** no in-process quota or cache state, a bounded `pg` pool, history reads `limit + 1` rows, 32 KiB body limit, and every provider timer is cleared when its call settles or is aborted.
- **The identity check runs in `onRequest`,** before body parsing, so unidentified requests get 401 without their payload being read.
- **Migrations run as a one-shot compose service,** so scaled app instances never race to migrate.
- **Business rules are configuration:** `DAILY_QUOTA`, `CACHE_TTL_SECONDS`, `PROVIDER_TIMEOUT_MS` (see `.env.example`).

## Tests

`npm test` runs 71 tests in about 6 seconds: unit tests, plus integration tests against real PostgreSQL 17 and Redis 7.4 started by Testcontainers. To reuse running instances instead, set `TEST_DATABASE_URL` and `TEST_REDIS_URL`.

- Required (a): `test/integration/quota-concurrency.test.ts` sends 10 concurrent prompts and expects 5 × 201, 5 × 429, 5 rows and 5 provider calls (plus a 50-request burst).
- Required (b): `test/integration/cache.test.ts` sends `merhaba` then `MERHABA` and expects `cached: true`, no second provider call and an unchanged remaining quota.
- Also covered: 401/400/413 with no side effects, 502 and 504 not counted, cached results after the quota is exhausted, errors not cached, the Redis-down fail-open path, quota persistence across a restart, the UTC midnight rollover (injected clock), and keyset pagination over rows sharing a `createdAt`.
- The provider is the real fake with shortened delays, wrapped to record calls. Timing-sensitive unit tests use fake timers, so no test waits in real time.

## Tips

- I've sent you a postman collection to test
- To get arror from AI provider, send prompt which is started with 'error' for example "error deneme"
- To get timeout from AI provider, send prompt which is started with 'timeout' for example "timeout deneme"
- To get slow response from AI provider, send prompt which is started with 'slow' for example "slow deneme"
- Without X-User-Id, 401 unauthorized
- {"prompt":" "}	400 invalid_prompt
- {"prompt": (bozuk JSON)}	400 invalid_request
- ?limit=0	400 invalid_limit
- ?cursor=abc	400 invalid_cursor
- When you want to work with seed data with the length 100.000, use "X-User-Id: seed-user" after running "docker compose exec app npm run seed" command
- To send parallel 10 request run this command on the teminal 
seq 1 10 | xargs -P 10 -I{} curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/v1/generations -H "X-User-Id: parallel-$RANDOM" -H "Content-Type: application/json" -d '{"prompt":"parallel {}"}'
