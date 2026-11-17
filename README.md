# AI Generation Service

Node.js 24.22, PostgreSQL 17.10, Redis 7.4.12 (Fastify, Kysely).

## Setup & tests

```bash
docker compose up --build
./scripts/verify.sh                      # verification flow, API on :3000
docker compose exec app npm run seed     # 100,000 rows
docker compose exec app npm run explain
npm ci && npm test                       # needs Docker (Testcontainers)
```

## Quota under concurrency

Before calling the provider, a cache miss reserves a unit with one atomic `INSERT … ON CONFLICT DO UPDATE … WHERE used < 5` on the user's daily row, whose lock serializes concurrent requests: at most five succeed. Errors and timeouts release it.

## Index & EXPLAIN

`(user_id, created_at DESC, id DESC)` matches filter and order; `id` breaks `createdAt` ties. The keyset predicate is an index condition, so the page after row 50,000 costs like the first:

```
Limit (actual time=0.010..0.012 rows=21 loops=1)
  Buffers: shared hit=4
  ->  Index Scan using generations_user_history_idx on generations (actual time=0.010..0.011 rows=21 loops=1)
        Index Cond: (((user_id)::text = 'seed-user'::text) AND (ROW(created_at, id) < ROW('2026-11-17 08:40:17.064+00'::timestamp with time zone, 'a6349599-a766-4aaf-9930-96299afb203a'::uuid)))
Execution Time: 0.031 ms
```

## Technical choice

Quota lives in PostgreSQL, not Redis: it survives restarts and stays exact during Redis outages; Redis is only a fail-open cache.

## Time spent & known gaps

Time spent: 5 hours.

- A crash mid-request keeps its reserved unit for the day.
- No single-flight: concurrent misses for one prompt each call the provider.
- Client disconnects don't cancel provider calls.

Scaling answer, AI usage, API: [DELIVERY_NOTES.md](DELIVERY_NOTES.md).
