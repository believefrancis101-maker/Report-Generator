import type { Pool } from 'pg';

/**
 * Stuck-job recovery.
 *
 * A worker can die between claiming a job and recording an outcome. Nobody
 * will ever complete that job, so it would stay in 'processing' forever. The
 * sweep is the recovery path: it finds the jobs that have been 'processing'
 * for longer than `STUCK_TIMEOUT_MS` and puts them back into the queue.
 *
 * WHY ONE STATEMENT
 * -----------------
 * The recovery of the job and the closing of its abandoned execution record
 * happen in a single statement (two data-modifying CTEs). Either both are
 * written or neither is - there is no window in which a job was recovered but
 * its old run still looks like it is in flight.
 *
 * (a) THE SWEEP RESPECTS `max_attempts`
 *     A recovery counts as an attempt, exactly like a failure does. A job
 *     that keeps killing its worker therefore ends up 'dead' instead of being
 *     recovered forever.
 *
 * (b) THE SWEEP AND A FINISHING WORKER ARE SERIALIZED
 *     Both touch the same row, so Postgres serializes them with a row lock.
 *     If the sweep wins, the worker's fenced completion/failure statement
 *     (`WHERE status = 'processing' AND started_at = <its claim>`) no longer
 *     matches anything: a slow-but-alive worker can never overwrite a job
 *     that was recovered and taken over by somebody else.
 *
 * (c) A SLOW JOB CAN STILL RUN TWICE
 *     The sweep cannot distinguish "the worker died" from "the worker is
 *     merely slow". A job that takes longer than `STUCK_TIMEOUT_MS` is
 *     recovered while the original worker is still working on it, so the
 *     work may happen twice. That is why the handlers are idempotent; the
 *     fence in (b) makes sure only one of the two runs can *record* an
 *     outcome.
 */

/**
 * The single statement of the sweep.
 *
 * `$1` is `STUCK_TIMEOUT_MS` in milliseconds. The cast makes its type
 * unambiguous, because the parameter is used both as text (in the message)
 * and as an interval multiplier. The database clock decides what "stuck"
 * means: `now()` is evaluated by Postgres, not by the worker's process.
 */
const SWEEP_SQL = `
WITH recovered AS (
    UPDATE "jobs" SET
        "attempts" = "attempts" + 1,
        "status" = CASE
            WHEN "attempts" + 1 >= "max_attempts" THEN 'dead'
            ELSE 'pending'
        END,
        "last_error" = 'Recovered by sweep: stuck in processing for more than ' || $1::bigint || 'ms',
        "run_at" = now(),
        "finished_at" = CASE
            WHEN "attempts" + 1 >= "max_attempts" THEN now()
            ELSE NULL
        END,
        "updated_at" = now()
    WHERE "status" = 'processing'
      AND "started_at" < now() - ($1::bigint * interval '1 millisecond')
    RETURNING "id", "status", "attempts"
),
closed AS (
    UPDATE "job_runs" r SET
        "finished_at" = now(),
        "outcome" = 'crashed',
        "error" = 'Abandoned: worker did not finish; recovered by sweep'
    FROM recovered
    WHERE r."job_id" = recovered."id"
      AND r."outcome" IS NULL
    RETURNING r."id"
)
SELECT "id", "status", "attempts" FROM recovered
`;

/** What the sweep needs to know. */
export interface SweepSettings {
  /** A job that has been running longer than this (ms) is stuck. */
  stuckTimeoutMs: number;
}

/** A job the sweep put back into the queue. */
export interface RecoveredJob {
  id: string;
  /** `pending` for another attempt, `dead` when the retries are exhausted. */
  status: 'pending' | 'dead';
  attempts: number;
}

/**
 * Recovers every stuck job.
 *
 * @returns the jobs that were recovered - an empty array when there was
 * nothing to do. Running several sweeps at once is safe: the second one
 * matches no rows.
 */
export async function sweepStuckJobs(
  pool: Pool,
  settings: SweepSettings,
): Promise<RecoveredJob[]> {
  const result = await pool.query<RecoveredJob>(SWEEP_SQL, [
    settings.stuckTimeoutMs,
  ]);
  return result.rows;
}
