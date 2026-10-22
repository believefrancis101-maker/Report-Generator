# report-generator

Task 2: **Background Jobs Done Properly** - a report generator backed by a durable
job queue that lives in PostgreSQL (no external broker).

> **Stage 1 status:** project scaffold and typed configuration only.
> Job queue behaviour (enqueue/status endpoints, claiming, retries, backoff,
> stuck-job recovery, dead-letter handling) is **not** implemented yet.

## Stack

- Node.js + TypeScript
- Express (API server)
- PostgreSQL + Prisma
- Zod (typed configuration)
- Vitest (tests)

## Project structure

```
report-generator/
├── docker-compose.yml        # PostgreSQL only, container: report-generator-postgres
├── prisma/
│   └── schema.prisma         # Prisma scaffold (job model lands in a later stage)
├── prisma.config.ts          # Prisma CLI configuration
├── src/
│   ├── config.ts             # Typed, Zod-validated configuration
│   ├── server.ts             # API entrypoint  -> npm run dev:api
│   ├── worker.ts             # Worker entrypoint -> npm run dev:worker
│   └── generated/            # Prisma client (generated, git-ignored)
├── tests/
│   └── config.test.ts        # Configuration validation tests
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
| `STUCK_TIMEOUT_MS` | no | `60000` | A job running longer is considered stuck |
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

## Tests

```bash
npm test
```

The suite currently covers configuration parsing, defaults and rejection of
invalid environments (including the guarantee that the database URL is never
leaked into error messages).

## Roadmap

- [x] Stage 1 - scaffold and typed configuration
- [ ] Stage 2 - job schema, enqueue/status endpoints, claiming, worker processing
- [ ] Stage 3 - retries, exponential backoff, stuck-job recovery, dead-letter handling
