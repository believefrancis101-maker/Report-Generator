# report-generator

A **report generator with a durable background job queue** built on PostgreSQL -
no external broker required. Jobs are stored in the database, claimed
atomically by independent worker processes with plain SQL, retried with
exponential backoff and audited attempt by attempt.

The API server and the workers are separate processes, so they scale
independently and a worker crash never takes the API down.

## Stack

- Node.js + TypeScript (strict)
- Express (API server)
- PostgreSQL + Prisma (schema and migrations) + `pg` (plain SQL for the queue core)
- Zod (typed configuration)
- Vitest (tests)
- Docker Compose (local PostgreSQL)

## Queue design

The queue is designed around database-level guarantees rather than an external
broker:

| Concern | Approach |
| --- | --- |
| Enqueue | Idempotent via a unique `idempotency_key` on `jobs` |
| Claiming | `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED LIMIT n)` - two workers never claim the same job |
| Evidence | Every attempt writes a `job_runs` row (worker, start, finish, outcome, error) |
| Retries | `attempts` is bounded by `max_attempts`; the next run time is computed with exponential backoff |
| Failure handling | The database refuses invalid states - `CHECK (status IN (...))` and `CHECK (attempts >= 0)` |
| Stuck jobs | A sweeper requeues jobs whose `started_at` is older than the stuck timeout |

## Project structure

```
report-generator/
├── docker-compose.yml        # PostgreSQL only, container: report-generator-postgres
├── prisma/
│   ├── migrations/            # Hand-edited migration SQL (source of truth)
│   ├── schema.prisma          # jobs, job_runs, reports, sales_orders
│   └── seed.ts                # 500k sales_orders rows in one SQL statement
├── prisma.config.ts          # Prisma CLI configuration
├── src/
│   ├── api/
│   │   └── jobs.ts            # POST /api/jobs
│   ├── app.ts                # Express app factory
│   ├── config.ts             # Typed, Zod-validated configuration
│   ├── db.ts                 # Shared `pg` pool for the queue core
│   ├── jobs/
│   │   ├── enqueue.ts        # Idempotent insert (ON CONFLICT DO NOTHING)
│   │   ├── idempotency.ts    # Canonical JSON + SHA-256 key derivation
│   │   └── validation.ts     # Zod request validation
│   ├── server.ts             # API entrypoint  -> npm run dev:api
│   ├── worker.ts             # Worker entrypoint -> npm run dev:worker
│   └── generated/            # Prisma client (generated, git-ignored)
├── tests/
│   ├── config.test.ts        # Configuration validation tests
│   ├── enqueue.test.ts       # API tests against the real database
│   └── migration.test.ts     # Guards the hand-written CHECK constraints
├── .env.example              # Copy to .env (never committed)
├── .gitignore
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

The API and the worker are **two independent OS processes**. They can be started,
stopped and scaled separately.

## Getting started

```bash
npm install                    # also runs `prisma generate` (postinstall)
cp .env.example .env          # adjust DATABASE_URL if needed
docker compose up -d          # starts report-generator-postgres
npm run prisma:migrate        # applies prisma/migrations to the database
npm run seed                  # 500,000 sales_orders rows
npm run dev:api               # API server  (http://localhost:3000)
npm run dev:worker            # worker process
```

The generated Prisma client lives in `src/generated/` and is **git-ignored**,
so a fresh clone needs it regenerated. `npm install` does that automatically via
the `postinstall` script; run `npm run prisma:generate` manually if you ever
need to redo it (e.g. after a schema change).

### Scripts

| Script | Description |
| --- | --- |
| `npm install` | Installs dependencies and generates the Prisma client (`postinstall`) |
| `npm run dev:api` | API server with hot reload (`tsx watch src/server.ts`) |
| `npm run dev:worker` | Worker process with hot reload (`tsx watch src/worker.ts`) |
| `npm run build` | Type-check and compile to `dist/` |
| `npm run start:api` | Run the compiled API server |
| `npm run start:worker` | Run the compiled worker |
| `npm run typecheck` | TypeScript check without emitting |
| `npm test` | Run the Vitest suite |
| `npm run prisma:generate` | Generate the Prisma client |
| `npm run prisma:migrate` | Apply/create a development migration |
| `npm run seed` | Seed 500,000 `sales_orders` rows |

## API

### `POST /api/jobs`

Enqueues a job. The endpoint does exactly one thing: it inserts a row with
status `pending` and returns. No work is performed here.

```bash
curl -i -X POST http://localhost:3000/api/jobs \
  -H 'content-type: application/json' \
  -d '{
        "type": "sales_report",
        "payload": { "dateFrom": "2024-01-01", "dateTo": "2024-03-31" },
        "idempotencyKey": "my-own-key"
      }'
```

```json
HTTP/1.1 202 Accepted
{ "id": "3f48312c-efc6-4883-95e4-55604b88821e", "status": "pending", "attempts": 0 }
```

The same request again returns the **same job**:

```json
HTTP/1.1 200 OK
{ "id": "3f48312c-efc6-4883-95e4-55604b88821e", "status": "pending", "attempts": 0, "duplicate": true }
```

**Body**

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `"sales_report"` | The only supported job type |
| `payload.dateFrom` | `YYYY-MM-DD` | Inclusive start of the reporting period |
| `payload.dateTo` | `YYYY-MM-DD` | Inclusive end; must be on or after `dateFrom` |
| `idempotencyKey` | string (optional) | Up to 255 characters |

**Idempotency key** - resolved in this order:

1. the `Idempotency-Key` request header,
2. `idempotencyKey` in the body,
3. a key derived from the request: `sha256(type + ":" + canonical payload)`,
   where the payload is serialised with **sorted keys**, so `{ a, b }` and
   `{ b, a }` hash to the same key.

Supplying a header *and* a body key with different values is a `400`.

**Guarantees** - idempotency is enforced by the **database**, not by
application code: `jobs.idempotency_key` carries a UNIQUE index and the
insert uses `ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`. If no row
comes back, the existing job for that key is returned instead. Concurrent
submits of the same key therefore collapse onto one row and one job id, no
matter how many arrive at once.

**Errors** - a `400` with a per-field explanation:

```json
{
  "error": "Invalid request body",
  "issues": [{ "path": "payload.dateTo", "message": "dateTo must be on or after dateFrom" }]
}
```

`max_attempts` is taken from the configuration (`MAX_ATTEMPTS`), the `id` is
generated by the database and all timestamps come from the database clock.

### `GET /health`

```json
{ "status": "ok", "service": "report-generator-api" }
```

## Configuration

Configuration is validated with Zod in [`src/config.ts`](src/config.ts). Both
entrypoints load it at startup and **fail fast** with a readable error message
when the environment is invalid. The database URL is never logged.

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | - | PostgreSQL connection string, must be non-empty |
| `PORT` | no | `3000` | API server port (1-65535) |
| `MAX_ATTEMPTS` | no | `5` | Delivery attempts per job (positive integer) |
| `CONCURRENCY` | no | `3` | Concurrent jobs per worker (positive integer) |
| `BACKOFF_BASE_MS` | no | `2000` | Base retry delay in ms (positive integer) |
| `BACKOFF_MAX_MS` | no | `300000` | Max retry delay in ms, must be `>= BACKOFF_BASE_MS` |
| `STUCK_TIMEOUT_MS` | no | `60000` | A job running longer than this is considered stuck |
| `SWEEP_INTERVAL_MS` | no | `15000` | Interval between stuck-job sweeps |
| `POLL_INTERVAL_MS` | no | `1000` | Interval between job polls |
| `WORKER_ID` | no | `<hostname>-<pid>` | Stable worker identity |
| `FAIL_RATE` | no | `0` | **TEST-ONLY** - deliberate failure probability (0..1) |
| `CRASH_AFTER_WORK` | no | `false` | **TEST-ONLY** - crash after the first unit of work |
| `WORK_DELAY_MS` | no | `0` | **TEST-ONLY** - artificial delay per unit of work |

> **TEST-ONLY settings** (`FAIL_RATE`, `CRASH_AFTER_WORK`, `WORK_DELAY_MS`) exist
> to exercise failure paths in automated tests. They are **not production
> controls** and must never be enabled in a deployed environment.

Numeric variables are parsed and range-checked; non-numeric, non-finite,
out-of-range and non-integer values are rejected instead of being coerced.

## Database

`docker-compose.yml` provides PostgreSQL only - jobs are stored in the database,
so no broker (Redis, RabbitMQ, ...) is required.

```bash
docker compose up -d
docker compose ps
```

The container is named `report-generator-postgres`, uses the persistent named
volume `report-generator-pgdata` and ships a `pg_isready` health check.

Local development credentials (defaults, overridable via `POSTGRES_USER`,
`POSTGRES_PASSWORD`, `POSTGRES_DB`):

```
postgresql://report:report_local_dev@localhost:55432/report_generator?schema=public
```

The container is published on host port `55432` (override with `POSTGRES_PORT`).
Keep `POSTGRES_PORT` and the port in `DATABASE_URL` in sync.

### Schema

| Table | Purpose |
| --- | --- |
| `jobs` | The queue: `type`, `payload` (jsonb), `status`, `attempts`, `max_attempts`, `last_error`, `run_at`, `started_at`, `finished_at`, `idempotency_key` (unique), `created_at`, `updated_at` |
| `job_runs` | One row per execution attempt: `job_id` (FK), `worker_id`, `started_at`, `finished_at`, `outcome`, `error` |
| `reports` | The produced artefact: `job_id` (unique FK), `summary` (jsonb), `pdf` (bytea), `created_at` |
| `sales_orders` | Source data: `customer_name`, `category`, `amount_minor`, `created_at` |

Column names are `snake_case` (Prisma `@map` / `@@map`). The `id` of `jobs`,
`job_runs` and `reports` is generated by the database
(`DEFAULT gen_random_uuid()`), so plain SQL can insert rows without supplying
an id and Prisma never drifts from the database.

### Migrations - the hand-edited SQL is the source of truth

The Prisma schema language **cannot express CHECK constraints**, so the
constraints below are written by hand into the migration SQL:

```sql
-- jobs
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_status_check"
    CHECK ("status" IN ('pending', 'processing', 'succeeded', 'failed', 'dead'));
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_attempts_check"
    CHECK ("attempts" >= 0);
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_max_attempts_check"
    CHECK ("max_attempts" > 0);

-- job_runs
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_outcome_check"
    CHECK ("outcome" IS NULL OR "outcome" IN ('succeeded', 'failed', 'crashed'));
```

Workflow for schema changes:

```bash
npm run prisma:migrate -- --create-only --name <name>   # generate the SQL
# edit prisma/migrations/<name>/migration.sql by hand (CHECK constraints, ...)
npm run prisma:migrate                                 # apply it
```

A later `prisma migrate dev` does **not** drop those constraints (Prisma does
not model CHECK constraints, so it never emits a `DROP CONSTRAINT` for them).
`tests/migration.test.ts` fails if the hand-written constraints ever disappear
from the migration files. Verify against a live database with:

```bash
docker exec report-generator-postgres psql -U report -d report_generator -c "\d jobs"
```

### Seeding

```bash
npm run seed            # or: npx prisma db seed
```

The seed inserts **500,000** `sales_orders` rows with a single
`INSERT ... SELECT ... FROM generate_series(...)` statement (no JS loop):
5,000 distinct customer names (50 first names x 100 last names), 10 categories
and `created_at` spread across the last 24 months. It truncates
`sales_orders` first, so it is safe to re-run.

### Database access

`src/db.ts` exports the shared `pg` pool used by the queue core (claim,
failure handling, sweep, retry) so that the hot-path SQL stays plain and
visible. The pool is sized `CONCURRENCY + 3` - one connection per job slot plus
headroom for the claim loop, the stuck-job sweep and status polling. Prisma is
used for the schema, migrations and simple reads.

## Tests

```bash
npm test
```

The suite covers configuration parsing, defaults and rejection of invalid
environments (including the guarantee that the database URL is never leaked
into error messages), the presence of the hand-written CHECK constraints and
indexes in the migration SQL, and the enqueue endpoint.

The endpoint tests run against a **real PostgreSQL database** - start it with
`docker compose up -d` first. They submit the same idempotency key twice
sequentially and then 20 times concurrently, and assert that exactly one row
exists and that every response carries the same job id.

## Status

Implemented:

- Typed, fail-fast configuration with Zod (secrets never logged)
- Schema, migration and seed data, including database-level CHECK constraints
- Independent API server and worker processes with a shared connection pool
- `POST /api/jobs` with idempotency enforced by a database constraint

In progress:

- The worker's claim/retry loop and the report generation
