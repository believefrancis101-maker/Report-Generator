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
├── evidence/                 # Break-it transcripts, raw process logs (see evidence/README.md)
├── scripts/
│   ├── evidence-*.ts         # Break-it scripts: concurrency, backoff, kill, idempotency, ...
│   └── test-db.ts            # Creates and migrates the test database
├── src/
│   ├── api/
│   │   └── jobs.ts            # Job JSON endpoints (enqueue, status, list, report, retry)
│   ├── app.ts                # Express app factory
│   ├── backoff.ts            # Exponential backoff with jitter (pure)
│   ├── config.ts             # Typed, Zod-validated configuration
│   ├── db.ts                 # Shared `pg` pool for the queue core
│   ├── jobs/
│   │   ├── enqueue.ts        # Idempotent insert (ON CONFLICT DO NOTHING)
│   │   ├── idempotency.ts    # Canonical JSON + SHA-256 key derivation
│   │   ├── queries.ts        # Status, list, report, retry and page reads
│   │   ├── status.ts         # The five job states
│   │   └── validation.ts     # Zod request validation
│   ├── faults.ts             # TEST-ONLY fault injection (delay, fail rate, crash)
│   ├── pages/
│   │   ├── dead.ts           # GET /dead - the dead letter view
│   │   ├── jobs.ts           # GET /jobs - counts, filters and the job table
│   │   ├── layout.ts         # escapeHtml, shared shell, status badges
│   │   ├── router.ts         # Mounts the three pages
│   │   └── trigger.ts        # GET / - enqueue form and polling script
│   ├── handlers/
│   │   ├── aggregate.ts      # The SQL analysis over sales_orders
│   │   ├── index.ts          # Job type -> handler registry
│   │   ├── pdf.ts            # pdfkit rendering
│   │   ├── salesReport.ts    # The idempotent sales_report handler
│   │   └── types.ts          # JobHandler / HandlerContext
│   ├── worker/
│   │   ├── claim.ts          # Atomic claim (FOR UPDATE SKIP LOCKED)
│   │   ├── complete.ts       # Completion with fencing
│   │   ├── fail.ts           # Failed attempt -> retry or dead
│   │   ├── handler.ts        # Stub handler (tests only)
│   │   ├── index.ts          # The worker loop (startWorker)
│   │   ├── log.ts            # The log formats
│   │   └── sweep.ts          # Stuck-job recovery (one atomic statement)
│   ├── server.ts             # API entrypoint  -> npm run dev:api
│   ├── sleep.ts              # Sleep helper
│   ├── worker.ts             # Worker entrypoint -> npm run dev:worker
│   └── generated/            # Prisma client (generated, git-ignored)
├── tests/
│   ├── setup.ts              # Points DATABASE_URL at the test database
│   ├── api.test.ts           # Status, list, retry and report endpoints
│   ├── backoff.test.ts       # Backoff unit tests
│   ├── config.test.ts        # Configuration validation tests
│   ├── enqueue.test.ts       # API tests against the real database
│   ├── migration.test.ts     # Guards the hand-written CHECK constraints
│   ├── pages.test.ts         # The HTML pages, including output escaping
│   ├── salesReport.test.ts   # Handler tests: totals, idempotency, crash
│   ├── sweep.test.ts         # Stuck-job recovery, end to end
│   └── worker.test.ts        # Worker tests against the real database
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
npm run test:setup            # creates report_generator_test and migrates it
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
| `npm test` | Run the Vitest suite against the test database |
| `npm run test:setup` | Create the test database (if missing) and apply the migrations |
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

A key must always describe the **same request**. When the key already exists,
the stored job's `type` and `payload` are compared with the submitted ones
(payloads as canonical JSON with sorted keys, so key order is irrelevant). A
mismatch is rejected:

```json
HTTP/1.1 422 Unprocessable Entity
{ "error": "idempotency_key_reused", "message": "This key was already used with a different request" }
```

The stored job is left untouched in that case - no second row is created.

**Errors** - a `400` with a per-field explanation:

```json
{
  "error": "Invalid request body",
  "issues": [{ "path": "payload.dateTo", "message": "dateTo must be on or after dateFrom" }]
}
```

`max_attempts` is taken from the configuration (`MAX_ATTEMPTS`), the `id` is
generated by the database and all timestamps come from the database clock.

### `GET /api/jobs/:id`

```json
{
  "id": "3f48312c-efc6-4883-95e4-55604b88821e",
  "type": "sales_report",
  "status": "succeeded",
  "attempts": 1,
  "maxAttempts": 5,
  "lastError": null,
  "runAt": "2026-10-22T13:07:52.117Z",
  "startedAt": "2026-10-22T13:07:52.190Z",
  "finishedAt": "2026-10-22T13:07:54.863Z",
  "reportAvailable": true
}
```

Timestamps are ISO 8601 UTC with milliseconds. `reportAvailable` is answered
with an `EXISTS` on `reports`, so the PDF is never loaded just to report its
presence. A malformed id is a `400`, an unknown one a `404`.

`attempts` counts **failed or abandoned runs**, not claims. A job that succeeds
on its first run reports `0`, a job that failed twice before succeeding reports
`2`, and a manual retry resets the counter to `0`. `job_runs` is the full
history: every attempt leaves a row with its worker, start, finish, outcome and
error, so nothing the counter forgets is lost.

### `GET /api/jobs`

`?status=&limit=&offset=` - newest first. `limit` defaults to 50 and is capped
at 200; `status` must be one of the five states. Anything else is a `400`.

```json
{ "jobs": [ ... ], "limit": 50, "offset": 0 }
```

### `GET /api/jobs/:id/report`

Streams the stored PDF:

```
Content-Type: application/pdf
Content-Disposition: attachment; filename="report-<jobId>.pdf"
```

`404` (JSON) when the job has no report.

### `POST /api/jobs/:id/retry`

Puts a dead job back into the queue with a single statement, fenced on
`status = 'dead'`:

```sql
UPDATE "jobs" SET
    "status" = 'pending',
    "run_at" = now(),
    "attempts" = 0,
    "finished_at" = NULL,
    "updated_at" = now()
WHERE "id" = $1 AND "status" = 'dead'
RETURNING ...
```

`attempts` resets to 0 on purpose: a manual retry means an operator decided to
start over, so the job gets its full budget again. Nothing is lost - `job_runs`
keeps every attempt that led to the dead state, and `last_error` is kept until
the next attempt overwrites it. `200` with the job on success, `409` when the
job exists but is not dead, `404` when it does not exist. Two concurrent retries
of the same job produce exactly one `200` and one `409`: the second `UPDATE`
matches no row.

### `GET /health`

```json
{ "status": "ok", "service": "report-generator-api" }
```

## Pages

Three server-rendered HTML pages - no build step, no framework:

| Page | Purpose |
| --- | --- |
| `GET /` | Trigger a report, watch it move and download the PDF |
| `GET /jobs` | Counts per status, filter links and the newest 50 jobs |
| `GET /dead` | Dead letters: payload, full error, run history and a retry button |

They share a small inline stylesheet and a nav. Every dynamic value -
`last_error`, payloads, ids, worker ids - goes through one `escapeHtml` helper,
and the trigger page writes API values into the DOM with `textContent`, so a
hostile error string can never become markup. A status is always a coloured
badge *and* its text label. `GET /jobs?refresh=2` reloads every two seconds,
which is handy while watching jobs move.

## The worker

The worker is an independent process that claims jobs and processes them.

```bash
npm run dev:worker
```

```
2026-10-22T13:13:52.308Z [worker host-31712] claimed 74d6b4a8-ece6-4d73-810d-b189bbd13977 | concurrent=1
2026-10-22T13:13:52.345Z [worker host-31712] finished 2c66bf08-749d-4a38-b872-71d2253bd50d | concurrent=3
```

**The loop** - while the worker runs it claims a job whenever it has a free
slot. A claimed job is started without awaiting it, so the worker immediately
claims the next one; when there is nothing to claim (or the concurrency cap
is reached) it sleeps for `POLL_INTERVAL_MS`. The active counter is
incremented when a job is claimed and decremented in a `finally` block, so a
failing handler can never leak a slot.

**The claim is atomic** - one transaction with two statements:

```sql
UPDATE "jobs"
SET "status" = 'processing', "started_at" = now(), "updated_at" = now()
WHERE "id" = (
    SELECT "id" FROM "jobs"
    WHERE "status" IN ('pending', 'failed') AND "run_at" <= now()
    ORDER BY "run_at" LIMIT 1 FOR UPDATE SKIP LOCKED
)
RETURNING *;

INSERT INTO "job_runs" ("job_id", "worker_id", "started_at") VALUES ($1, $2, now());
```

The subselect locks the row it picks (`FOR UPDATE`), competing workers *skip*
locked rows instead of waiting for them (`SKIP LOCKED`), and the `UPDATE`
flips the status in the same statement - so there is no window in which two
workers can grab the same job. A separate `SELECT` followed by an `UPDATE`
would have exactly that race window. Both statements share one transaction:
a crash between them cannot leave a `processing` job without its `job_runs`
row.

**Stuck jobs are recovered by a sweep** - if a worker dies between claiming a
job and recording an outcome, the job would stay `processing` forever. Every
worker sweeps once at startup and then every `SWEEP_INTERVAL_MS`: one
statement puts the abandoned job back into the queue and closes its execution
record in the same atomic step (two data-modifying CTEs):

```sql
WITH recovered AS (
    UPDATE "jobs" SET
        "attempts" = "attempts" + 1,
        "status"  = CASE WHEN "attempts" + 1 >= "max_attempts" THEN 'dead' ELSE 'pending' END,
        "last_error" = 'Recovered by sweep: stuck in processing for more than ' || $1 || 'ms',
        "run_at"  = now(),
        "finished_at" = CASE WHEN "attempts" + 1 >= "max_attempts" THEN now() ELSE NULL END,
        "updated_at"  = now()
    WHERE "status" = 'processing'
      AND "started_at" < now() - ($1 * interval '1 millisecond')
    RETURNING "id", "status", "attempts"
),
closed AS (
    UPDATE "job_runs" r SET
        "finished_at" = now(),
        "outcome"     = 'crashed',
        "error"       = 'Abandoned: worker did not finish; recovered by sweep'
    FROM recovered
    WHERE r."job_id" = recovered."id" AND r."outcome" IS NULL
    RETURNING r."id"
)
SELECT "id", "status", "attempts" FROM recovered
```

`STUCK_TIMEOUT_MS` (`$1`) is the only input, and `now()` is the database
clock. The recovery counts as an attempt, so a job that keeps killing its
worker ends up `dead` instead of being recovered forever. The sweep and a
worker finishing the same job are serialized by the row lock: if the sweep
wins, the worker's fenced `UPDATE` (`status = 'processing' AND started_at =
<its claim>`) matches nothing, and the "lost claim" path only closes its run
row when it is still open - the sweep's mark is never overwritten. A worker
that is merely slow can therefore still run the job twice, which is exactly
why the handlers are idempotent. The sweep never overlaps with itself: a tick
that arrives while the previous sweep is running is skipped.

```
2026-10-22T16:59:43.841Z [worker host-31712] sweep recovered d2ff6491-5fab-46d9-8dad-238f4e36caa5 -> pending (attempts=1)
```

**Completion is fenced** - the claim hands back the `started_at` it wrote, and
the completion only applies while that token still matches:

```sql
UPDATE "jobs"
SET "status" = 'succeeded', "finished_at" = now(), "updated_at" = now()
WHERE "id" = $1 AND "status" = 'processing' AND "started_at" = $2
```

If the job was recovered and handed to somebody else in the meantime, the
update affects zero rows. The worker then logs
`lost claim for <jobId>: job was recovered or reclaimed` and marks its own
execution record as `crashed` - a slow worker can never overwrite the result
of the worker that took the job over.

**Failures are retried, then killed.** When the handler throws, the worker
records the failure with one fenced statement:

```sql
UPDATE "jobs"
SET
    "attempts" = "attempts" + 1,
    "last_error" = $3,
    "status" = CASE WHEN "attempts" + 1 >= "max_attempts" THEN 'dead' ELSE 'failed' END,
    "run_at" = CASE WHEN "attempts" + 1 >= "max_attempts" THEN "run_at"
                    ELSE now() + ($4 * interval '1 millisecond') END,
    "finished_at" = CASE WHEN "attempts" + 1 >= "max_attempts" THEN now() ELSE NULL END,
    "updated_at" = now()
WHERE "id" = $1 AND "status" = 'processing' AND "started_at" = $2
RETURNING "status", "attempts", "run_at"
```

`failed` means the job will be retried once its `run_at` has passed; `dead`
means the retries are exhausted and the job needs a human. The claim picks up
`pending` and `failed` jobs, but never a `dead` one.

```
2026-10-22T13:55:22.905Z [worker host-31712] job eeec174d-… failed (attempt 1/3): Injected failure (FAIL_RATE=1) | retry in 275ms at 2026-10-22T13:55:23.166Z
2026-10-22T13:55:24.936Z [worker host-31712] job eeec174d-… is DEAD after 3 attempts: Injected failure (FAIL_RATE=1)
```

**Backoff** - [`src/backoff.ts`](src/backoff.ts) is a pure function; the
configuration and the source of randomness are injected, so it is unit tested
without any I/O:

```ts
exponential = baseMs * 2 ** (failureCount - 1)   // the first retry waits ~base
jitter     = Math.floor(random() * exponential * 0.5)
delay      = Math.min(maxMs, exponential + jitter)
```

The jitter is what keeps a batch of failed jobs from retrying in lockstep -
without it, jobs that failed together retry together and hit the failing
dependency in a thundering herd. The delay is computed in JavaScript and
handed to the database as a number of milliseconds
(`now() + ($4 * interval '1 millisecond')`), so the schedule is based on the
**database clock** and workers on different machines stay consistent.

## Report generation

A `sales_report` job is handled by
[`src/handlers/salesReport.ts`](src/handlers/salesReport.ts); the worker looks
the handler up by job type in [`src/handlers/index.ts`](src/handlers/index.ts).
An unknown type throws and goes through the usual retry/dead path, so a typo in
a producer can never be silently ignored.

The handler is **idempotent**, and it proves it in the cheapest possible way:

1. `SELECT 1 FROM reports WHERE job_id = $1` - if the report already exists
   the handler logs `report for <jobId> already exists, skipping` and returns
   without aggregating or rendering anything.
2. The analysis runs over `sales_orders` for the requested period (inclusive,
   in UTC): revenue and orders by category and month, the top 10 customers with
   their rank, and month-over-month growth (SQL `lag()`) with each category's
   share of its month (a window function). The aggregation is a separate
   function so the tests can spy on it.
3. The PDF is rendered with `pdfkit` - title, job id, parameters, totals, the
   category-by-month table (it paginates), the top customers and the growth
   table. Amounts are stored in minor units and printed as `NGN 1,234.56`
   (the text is used because the built-in PDF fonts have no naira glyph).
4. `INSERT INTO reports (job_id, summary, pdf) ... ON CONFLICT (job_id) DO
   NOTHING` - the UNIQUE constraint on `job_id` is what makes concurrent
   attempts safe.

On the 500,000-row seed the aggregation takes **~2.7 s**, which is why the work
does not happen in the request: the API only enqueues.

**The crash that proves it.** With `CRASH_AFTER_WORK=true` the worker is killed
after the report row exists but before the job is marked `succeeded`. The job
stays `processing` - exactly the state the recovery path has to deal with. Once
it is claimable again, the next attempt finds the report and skips the work:
one report, one aggregation. That scenario is a test in
[`tests/salesReport.test.ts`](tests/salesReport.test.ts).

```
[handler] aggregation for job 9814fb98-… took 2670ms (250 category-months, 10 top customers, 25 months)
[handler] report for 9814fb98-… saved (23223 bytes, 2670ms aggregation)
[handler] report for 9814fb98-… already exists, skipping
```

**Shutdown** - on `SIGTERM`/`SIGINT` the worker stops claiming, waits for the
running jobs to finish, closes the pool and exits `0`. `SIGKILL` skips that
on purpose: the job stays `processing` and is recovered by the sweeper.

## Configuration

Configuration is validated with Zod in [`src/config.ts`](src/config.ts). Both
entrypoints load it at startup and **fail fast** with a readable error message
when the environment is invalid. The database URL is never logged.

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | - | PostgreSQL connection string, must be non-empty |
| `DATABASE_URL_TEST` | for tests | - | Database `npm test` uses; the app never reads it |
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

> **`STUCK_TIMEOUT_MS` must be comfortably longer than the slowest legitimate
> job** (a report currently takes roughly 2-6 s on the 500k-row seed). If it is
> too short, healthy jobs are recovered while they are still running: they are
> counted as a failed attempt and the work happens twice. Set it to several
> times the worst-case job duration.

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

`jobs.attempts` counts **failed or abandoned runs**: failing an attempt
increments it, the stuck-job sweep increments it when it recovers an abandoned
job, and a successful claim does not change it. `job_runs` is the full history
instead - one row per attempt, including the successful ones - so the counter
only has to answer "how many times has this failed", while the evidence trail
stays complete.

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
npm run test:setup   # once: create report_generator_test and apply migrations
npm test
```

The suite runs against a **separate database** from the one you develop on -
`report_generator_test` in the same container. `npm run test:setup` creates it
when it is missing and applies `prisma/migrations` to it with
`prisma migrate deploy`, so the test schema can never drift from the real one.

`tests/setup.ts` is a Vitest `setupFiles` entry: it runs before any test module
is imported, and therefore before `src/db.ts` builds its connection pool, and
sets `DATABASE_URL` to `DATABASE_URL_TEST`. If both variables name the same
database it refuses to run, so a misconfiguration cannot delete development
data. Nothing in the application reads `DATABASE_URL_TEST`.

Because the test and development databases are separate, a worker running
against the development database cannot claim the jobs the tests create - and
the tests never write to the development tables.

The suite covers configuration parsing, defaults and rejection of invalid
environments (including the guarantee that the database URL is never leaked
into error messages), the presence of the hand-written CHECK constraints and
indexes in the migration SQL, and the enqueue endpoint.

The endpoint tests run against a **real PostgreSQL database** - start it with
`docker compose up -d` first. They submit the same idempotency key twice
sequentially and then 20 times concurrently, and assert that exactly one row
exists and that every response carries the same job id. A key reused with a
different payload is expected to fail with `422`.

The worker tests run the worker **in-process** (`startWorker`) against the same
database: they check that the concurrency cap is respected and actually
reached, that every job ends up with exactly one execution record, that two
workers competing for the same jobs never double-claim one, that a job with a
future `run_at` waits, and that a lost claim cannot overwrite a job that was
taken over by somebody else. The retry tests check that a failing job goes
`failed` -> `failed` -> `dead` with growing gaps between the attempts, that a
job which fails once and then works ends up `succeeded`, that `last_error`
holds the most recent failure, and that failing jobs do not leak a
concurrency slot.

The endpoint tests also cover the status, list, retry and report endpoints: the
documented job shape, `400`/`404` handling, filtering by status, the PDF
download headers, and two concurrent retries of one dead job (exactly one `200`
and one `409`). The page tests assert that `/dead` shows the payload, the full
error and the run history, that a `last_error` of `<script>alert(1)</script>`
is escaped rather than rendered, and that `/jobs` shows a count for all five
statuses.

## Break-it evidence

`scripts/evidence-*.ts` (exposed as `npm run evidence:*`) try to break the queue
on purpose and write down what happened. Each one starts from a clean queue -
it prints a warning and deletes every row from `jobs`, cascading to `job_runs`
and `reports`, and never touches `sales_orders`. They spawn the API and the
workers as real child processes of `process.execPath`
(`node --import tsx src/worker.ts`), so `SIGKILL` kills the process that
actually holds the job. Output goes to `evidence/<name>.txt` and the raw
timestamped child logs to `evidence/logs/`.

Add `--pause` to a script to stop at each screenshot point; it prints
`SCREENSHOT NOW: <what to capture>` and keeps the API up until Enter is pressed.
`evidence/README.md` maps every output file (and screenshot) to the behaviour it
demonstrates.

| Check | Command | Observed |
| --- | --- | --- |
| Enqueue does not do the work | `npm run evidence:concurrency` | 50 simultaneous POSTs: 50 × `202`, wall 197.4 ms (min 147.2, mean 164.7, max 182.6 ms). All 50 processed with `CONCURRENCY=3`; the worker log never exceeds `concurrent=3` (`concurrent=1: 30, concurrent=2: 34, concurrent=3: 36`). |
| Backoff and jitter | `npm run evidence:backoff` | 5 attempts. Gaps between starts 3,174 / 4,239 / 8,999 / 18,876 ms for nominal 2,000 / 4,000 / 8,000 / 16,000 ms; every gap inside `[nominal, 1.5 × nominal + poll slack]`. Final line: `status=dead`. |
| Kill mid-job, recover | `npm run evidence:kill-recovery` | `SIGKILL` at `16:58:50.006Z`; the job stayed `processing` with one open run; the sweep recovered it at 8,653 ms of age (`attempts=1`), runs show `crashed` → `succeeded`, exactly one `reports` row. |
| Idempotency key | `npm run evidence:idempotency-key` | First submit `202`, repeat `200 {"duplicate":true}` with the same id. 20 concurrent submits of another key: 1 × `202` + 19 × `200`, one distinct id, `count(*) = 1` per key. Same key with a different payload: `422`. |
| Two workers, one queue | `npm run evidence:two-workers` | 100 jobs → 100 runs over 100 distinct jobs, 0 jobs with more than one run. worker-a 51 runs, worker-b 49, both peaked at `concurrent=3`. |
| Crash after the work | `npm run evidence:crash-after-work` | Worker exited with code 1 after saving the report; the job was still `processing` with the run open. Recovery logged `report ... already exists, skipping`; final `attempts=1`, one `reports` row, and the aggregation log line appears once across both workers. |
| All five states at once | `npm run evidence:all-statuses` | `pending 1, processing 1, succeeded 3, failed 1, dead 1`, produced by real workers; the API stayed up for the screenshot. |

Real excerpts from the runs above:

```text
enqueue: 50 requests, wall=197.4ms, min=147.2ms, mean=164.7ms, max=182.6ms
max concurrent= value: 3
histogram: concurrent=1: 30, concurrent=2: 34, concurrent=3: 36

attempt 2: gap=3174ms in [2000, 4500]  PASS  (previous attempt logged retry in 2923ms, jitter=923ms, at most 1000ms)
attempt 5: gap=18876ms in [16000, 25500]  PASS  (previous attempt logged retry in 18715ms, jitter=2715ms, at most 8000ms)

2026-10-22T16:58:59.281Z [worker evidence-kill-b] sweep recovered 96229105-7bd6-435d-9c13-75376ed28295 -> pending (attempts=1)
```

## Status

Implemented:

- Typed, fail-fast configuration with Zod (secrets never logged)
- Schema, migration and seed data, including database-level CHECK constraints
- Independent API server and worker processes with a shared connection pool
- `POST /api/jobs` with idempotency enforced by a database constraint
- Worker with an atomic claim, a concurrency cap and fenced completion
- Retries with exponential backoff and jitter, and a dead-letter state
- The stuck-job sweeper, which closes abandoned runs and requeues the job
- Idempotent `sales_report` generation: aggregation, PDF and stored artefact
- Status, list, report download and retry endpoints
- Server-rendered trigger, jobs and dead letter pages
