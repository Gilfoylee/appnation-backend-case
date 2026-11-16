# AI Generation Service

Fastify + Kysely/PostgreSQL + Redis backend for AI generations: daily quota, shared cache, cursor-paginated history.

**Versions:** Node.js 24.22, PostgreSQL 17.10, Redis 7.4.12

## Setup & tests

```bash
docker compose up --build                  # PostgreSQL, Redis, one-shot migration, API on :3000
./scripts/verify.sh                        # the case's verification flow (curl, xargs -P 10)
docker compose exec app npm run seed       # 100,000 rows for "seed-user"
docker compose exec app npm run explain    # EXPLAIN ANALYZE of the history query
npm ci && npm test                         # needs Docker: Testcontainers starts PostgreSQL + Redis
```

`GET /v1/quota` shows the remaining allowance.

## Quota under concurrency

Each cache miss reserves a unit before calling the provider with one atomic `INSERT … ON CONFLICT DO UPDATE … WHERE used < 5 RETURNING` on the `(user_id, usage_date)` row; its row lock serializes concurrent requests, so at most five succeed. Provider errors and timeouts release the unit.

## Index & EXPLAIN

`(user_id, created_at DESC, id DESC)` matches the filter and sort order; `id` breaks `createdAt` ties, and the keyset predicate becomes an index condition, so deep pages cost the same as the first. Page after row 50,000 of 100,000:

```
Limit  (actual time=0.012..0.014 rows=21 loops=1)
  Buffers: shared hit=4
  ->  Index Scan using generations_user_history_idx on generations  (actual time=0.012..0.013 rows=21 loops=1)
        Index Cond: (((user_id)::text = 'seed-user'::text) AND (ROW(created_at, id) < ROW('2026-11-16 13:18:55.181+00'::timestamp with time zone, '6eb34327-b9bf-4cb2-aec9-7b84a26eeea4'::uuid)))
Execution Time: 0.049 ms
```

## Technical choice

The quota lives in PostgreSQL, not Redis: it survives restarts and stays exact when Redis fails. Redis is only a fail-open cache (no offline queue, 200 ms command timeout).

## Time spent & known gaps

Time spent: TODO hours.

- A crash between reservation and provider response keeps that unit consumed for the day.
- Concurrent misses for the same prompt all call the provider (no single-flight).
- Client disconnects do not cancel the provider call.

Scaling answer and AI usage: [DELIVERY_NOTES.md](DELIVERY_NOTES.md).
