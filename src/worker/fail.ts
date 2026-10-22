import type { Pool } from 'pg';
import { withTransaction } from '../db.js';
import type { ClaimedJob } from './claim.js';

/**
 * Recording a failed attempt.
 *
 * `failed` means: the job will be retried, it waits for its `run_at`.
 * `dead` means: the retries are exhausted, the job needs a human.
 * The claim picks up 'pending' and 'failed' jobs, but never a 'dead' one.
 *
 * The statement is fenced exactly like the completion: it only applies while
 * this worker still owns the claim. When it does not, the worker's execution
 * record is closed as 'crashed' - but only if it is still open, so the
 * sweep's own 'crashed' mark is never overwritten.
 */

/** Records the failure and either schedules a retry or kills the job. */
const FAIL_JOB_SQL = `
UPDATE "jobs"
SET
    "attempts" = "attempts" + 1,
    "last_error" = $3,
    "status" = CASE
        WHEN "attempts" + 1 >= "max_attempts" THEN 'dead'
        ELSE 'failed'
    END,
    "run_at" = CASE
        WHEN "attempts" + 1 >= "max_attempts" THEN "run_at"
        ELSE now() + ($4 * interval '1 millisecond')
    END,
    "finished_at" = CASE
        WHEN "attempts" + 1 >= "max_attempts" THEN now()
        ELSE NULL
    END,
    "updated_at" = now()
WHERE "id" = $1
  AND "status" = 'processing'
  AND "started_at" = $2
RETURNING "status", "attempts", "run_at"
`;

/** Closes the execution record of a failed attempt. */
const FAIL_RUN_SQL = `
UPDATE "job_runs"
SET "finished_at" = now(), "outcome" = 'failed', "error" = $2
WHERE "id" = $1
`;

/** Closes the execution record of an attempt whose claim was lost. */
const LOST_RUN_SQL = `
UPDATE "job_runs"
SET "finished_at" = now(), "outcome" = 'crashed'
WHERE "id" = $1
  AND "outcome" IS NULL
`;

/** The outcome of a failed attempt. */
export interface FailOutcome {
  /** False when the claim was lost - the job was taken over by somebody. */
  updated: boolean;
  /** The new status of the job: 'failed' or 'dead'. */
  status?: 'failed' | 'dead';
  /** The new attempt count. */
  attempts?: number;
  /** When the job may be claimed again (unchanged for a dead job). */
  runAt?: Date;
}

/**
 * Records a failed attempt.
 *
 * @param delayMs how long to wait before the next attempt. The delay is
 * computed in JavaScript and handed to the database as a number of
 * milliseconds, so the scheduling uses the database clock.
 */
export async function failJob(
  db: Pool,
  job: ClaimedJob,
  lastError: string,
  delayMs: number,
): Promise<FailOutcome> {
  return withTransaction(async (client) => {
    const updated = await client.query<{
      status: 'failed' | 'dead';
      attempts: number;
      run_at: Date;
    }>(FAIL_JOB_SQL, [job.id, job.startedAt, lastError, delayMs]);

    const row = updated.rows[0];
    if (!row) {
      // The claim is gone: the job was recovered or reclaimed meanwhile.
      await client.query(LOST_RUN_SQL, [job.runId]);
      return { updated: false };
    }

    await client.query(FAIL_RUN_SQL, [job.runId, lastError]);
    return {
      updated: true,
      status: row.status,
      attempts: row.attempts,
      runAt: row.run_at,
    };
  }, db);
}
