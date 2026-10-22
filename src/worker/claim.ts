import type { Pool } from 'pg';
import { withTransaction } from '../db.js';

/**
 * Claiming a job.
 *
 * WHY THIS IS ATOMIC
 * ------------------
 * The UPDATE below picks its row with a subselect that ends in
 * `FOR UPDATE SKIP LOCKED`:
 *
 *   - `FOR UPDATE` takes a row lock on the row the subselect picked, so no
 *     other transaction can modify that row until this transaction finishes.
 *   - `SKIP LOCKED` makes a competing worker *skip* a row that is already
 *     locked instead of waiting for it. Without it, every other worker would
 *     queue up behind the first one on the very same row.
 *   - The `UPDATE` flips `status` to 'processing' in the very same statement
 *     that selected the row, so there is no window between "I picked it" and
 *     "I own it". The row stays locked for the whole transaction, and the
 *     transaction also contains the INSERT into `job_runs`. A crash between
 *     the two statements therefore cannot leave a 'processing' job without
 *     its execution record - the transaction rolls back as a whole.
 *
 * WHY NOT "SELECT ... THEN UPDATE"
 * --------------------------------
 * A separate SELECT followed by a separate UPDATE has a race window: both
 * workers can read the same 'pending' row before either of them writes to
 * it, and both would then run the same job. The lock has to be taken as part
 * of the statement that selects the row, which is what the subselect with
 * `FOR UPDATE SKIP LOCKED` does here.
 */

/** The single statement that claims a job. */
const CLAIM_JOB_SQL = `
UPDATE "jobs"
SET "status" = 'processing',
    "started_at" = now(),
    "updated_at" = now()
WHERE "id" = (
    SELECT "id"
    FROM "jobs"
    WHERE "status" IN ('pending', 'failed')
      AND "run_at" <= now()
    ORDER BY "run_at"
    LIMIT 1
    FOR UPDATE SKIP LOCKED
)
RETURNING *
`;

/**
 * The second statement of the claim transaction: the execution record. It is
 * written in the same transaction as the claim, so a crash can never leave a
 * 'processing' job without a `job_runs` row.
 */
const CLAIM_RUN_SQL = `
INSERT INTO "job_runs" ("job_id", "worker_id", "started_at")
VALUES ($1, $2, now())
RETURNING "id"
`;

/** A job this worker owns, plus the id of its execution record. */
export interface ClaimedJob {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
  /** The claim timestamp - the fencing token handed back on completion. */
  startedAt: Date;
  /** Id of the `job_runs` row created for this attempt. */
  runId: string;
}

type ClaimedJobRow = {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
  started_at: Date;
};

/**
 * Atomically claims the next runnable job, or returns `null` when there is
 * nothing to do.
 */
export async function claimJob(
  db: Pool,
  workerId: string,
): Promise<ClaimedJob | null> {
  return withTransaction(async (client) => {
    const updated = await client.query<ClaimedJobRow>(CLAIM_JOB_SQL);
    const job = updated.rows[0];
    if (!job) return null;

    const run = await client.query<{ id: string }>(CLAIM_RUN_SQL, [
      job.id,
      workerId,
    ]);
    const runRow = run.rows[0];
    if (!runRow) {
      throw new Error(`failed to record the execution of job ${job.id}`);
    }

    return {
      id: job.id,
      type: job.type,
      payload: job.payload,
      attempts: job.attempts,
      max_attempts: job.max_attempts,
      startedAt: job.started_at,
      runId: runRow.id,
    };
  }, db);
}
