import type { Pool } from 'pg';
import type { JobStatus } from './status.js';

/**
 * Read queries for the queue: the status endpoint, the list endpoint, the
 * report download and the views the HTML pages render.
 *
 * The PDF column is never selected here - `reportAvailable` is answered with
 * an EXISTS, so listing jobs stays cheap even when reports are large.
 */

/** A job as the API exposes it. Timestamps are ISO 8601 UTC strings. */
export interface JobView {
  id: string;
  type: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  runAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  reportAvailable: boolean;
}

interface JobRow {
  id: string;
  type: string;
  status: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  run_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  report_available: boolean;
}

/** The columns every job view needs. `j` is the jobs table alias. */
const JOB_COLUMNS = `
    j."id",
    j."type",
    j."status",
    j."attempts",
    j."max_attempts",
    j."last_error",
    j."run_at",
    j."started_at",
    j."finished_at",
    EXISTS (SELECT 1 FROM "reports" r WHERE r."job_id" = j."id") AS report_available
`;

function toJobView(row: JobRow): JobView {
  return {
    id: row.id,
    type: row.type,
    status: row.status as JobStatus,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lastError: row.last_error,
    runAt: row.run_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
    reportAvailable: row.report_available,
  };
}

/** One job, or `null` when it does not exist. */
export async function getJob(db: Pool, id: string): Promise<JobView | null> {
  const { rows } = await db.query<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM "jobs" j WHERE j."id" = $1`,
    [id],
  );
  const row = rows[0];
  return row ? toJobView(row) : null;
}

/** The newest jobs first, optionally filtered by status. */
export async function listJobs(
  db: Pool,
  options: { status?: JobStatus | undefined; limit: number; offset: number },
): Promise<JobView[]> {
  const { rows } = await db.query<JobRow>(
    `SELECT ${JOB_COLUMNS}
     FROM "jobs" j
     WHERE ($1::text IS NULL OR j."status" = $1)
     ORDER BY j."created_at" DESC, j."id" DESC
     LIMIT $2 OFFSET $3`,
    [options.status ?? null, options.limit, options.offset],
  );
  return rows.map(toJobView);
}

/** The stored PDF of a job, or `null` when there is none. */
export async function getReportPdf(
  db: Pool,
  jobId: string,
): Promise<Buffer | null> {
  const { rows } = await db.query<{ pdf: Buffer }>(
    'SELECT "pdf" FROM "reports" WHERE "job_id" = $1',
    [jobId],
  );
  return rows[0]?.pdf ?? null;
}

export type RetryResult =
  | { outcome: 'retried'; job: JobView }
  | { outcome: 'not_dead' }
  | { outcome: 'missing' };

/**
 * Puts a dead job back into the queue.
 *
 * One statement, fenced on `status = 'dead'`: two concurrent retries of the
 * same job cannot both succeed. `attempts` is reset to 0 on purpose - an
 * operator decided to start over, so the job gets the full retry budget
 * again. The failure history is not lost: `attempts` is only a counter, the
 * `job_runs` rows keep every attempt, including the ones that made the job
 * dead. `last_error` stays as well, so the reason is visible until the next
 * attempt overwrites it.
 */
export async function retryJob(db: Pool, id: string): Promise<RetryResult> {
  const updated = await db.query<JobRow>(
    `UPDATE "jobs" SET
        "status" = 'pending',
        "run_at" = now(),
        "attempts" = 0,
        "finished_at" = NULL,
        "updated_at" = now()
     WHERE "id" = $1 AND "status" = 'dead'
     RETURNING
        "id",
        "type",
        "status",
        "attempts",
        "max_attempts",
        "last_error",
        "run_at",
        "started_at",
        "finished_at",
        EXISTS (SELECT 1 FROM "reports" r WHERE r."job_id" = "jobs"."id") AS report_available`,
    [id],
  );

  const row = updated.rows[0];
  if (row) {
    return { outcome: 'retried', job: toJobView(row) };
  }

  // Only now, after the UPDATE matched nothing, ask whether the job exists.
  const existing = await db.query<{ exists: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM "jobs" WHERE "id" = $1) AS "exists"',
    [id],
  );
  return existing.rows[0]?.exists
    ? { outcome: 'not_dead' }
    : { outcome: 'missing' };
}

/** How many jobs there are per status - every status, including zeros. */
export async function countJobsByStatus(
  db: Pool,
): Promise<Record<JobStatus, number>> {
  const { rows } = await db.query<{ status: string; count: string }>(
    'SELECT "status", count(*)::text AS "count" FROM "jobs" GROUP BY "status"',
  );

  const counts: Record<JobStatus, number> = {
    pending: 0,
    processing: 0,
    succeeded: 0,
    failed: 0,
    dead: 0,
  };
  for (const row of rows) {
    if (row.status in counts) {
      counts[row.status as JobStatus] = Number(row.count);
    }
  }
  return counts;
}

/** One execution attempt, for the dead letter view. */
export interface JobRunView {
  workerId: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  outcome: string | null;
  error: string | null;
}

/** A dead job with everything an operator needs to diagnose it. */
export interface DeadJobView {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: string;
  finishedAt: string | null;
  runs: JobRunView[];
}

interface DeadJobRow {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  created_at: Date;
  finished_at: Date | null;
}

interface RunRow {
  job_id: string;
  worker_id: string;
  started_at: Date;
  finished_at: Date | null;
  outcome: string | null;
  error: string | null;
}

/** Every dead job, newest first, with its complete run history. */
export async function getDeadJobs(db: Pool): Promise<DeadJobView[]> {
  const jobs = await db.query<DeadJobRow>(
    `SELECT "id", "type", "payload", "attempts", "max_attempts", "last_error",
            "created_at", "finished_at"
     FROM "jobs"
     WHERE "status" = 'dead'
     ORDER BY COALESCE("finished_at", "created_at") DESC, "id" DESC`,
  );

  const runsByJob = new Map<string, JobRunView[]>();
  if (jobs.rows.length > 0) {
    const runs = await db.query<RunRow>(
      `SELECT "job_id", "worker_id", "started_at", "finished_at", "outcome", "error"
       FROM "job_runs"
       WHERE "job_id" = ANY($1::uuid[])
       ORDER BY "started_at", "id"`,
      [jobs.rows.map((job) => job.id)],
    );

    for (const run of runs.rows) {
      const list = runsByJob.get(run.job_id) ?? [];
      list.push({
        workerId: run.worker_id,
        startedAt: run.started_at.toISOString(),
        finishedAt: run.finished_at?.toISOString() ?? null,
        durationMs:
          run.finished_at === null
            ? null
            : run.finished_at.getTime() - run.started_at.getTime(),
        outcome: run.outcome,
        error: run.error,
      });
      runsByJob.set(run.job_id, list);
    }
  }

  return jobs.rows.map((job) => ({
    id: job.id,
    type: job.type,
    payload: job.payload,
    attempts: job.attempts,
    maxAttempts: job.max_attempts,
    lastError: job.last_error,
    createdAt: job.created_at.toISOString(),
    finishedAt: job.finished_at?.toISOString() ?? null,
    runs: runsByJob.get(job.id) ?? [],
  }));
}
