import type { Pool } from 'pg';
import { withTransaction } from '../db.js';
import type { ClaimedJob } from './claim.js';

/**
 * Completing a job - with fencing.
 *
 * The claim hands back the `started_at` timestamp it wrote. Completion only
 * succeeds while the job still carries *that* timestamp:
 *
 *   WHERE id = $1 AND status = 'processing' AND started_at = $2
 *
 * If the job was recovered by the sweeper and handed to somebody else in the
 * meantime, its `started_at` no longer matches and the UPDATE affects zero
 * rows. The worker then reports that it lost the claim and marks its
 * execution record as 'crashed'. Without this fence a slow worker could
 * overwrite the result of the worker that actually took the job over.
 */

/** Marks the job as succeeded - only while the claim is still valid. */
const COMPLETE_JOB_SQL = `
UPDATE "jobs"
SET "status" = 'succeeded',
    "finished_at" = now(),
    "updated_at" = now()
WHERE "id" = $1
  AND "status" = 'processing'
  AND "started_at" = $2
`;

/** Marks the execution record as finished successfully. */
const COMPLETE_RUN_SQL = `
UPDATE "job_runs"
SET "finished_at" = now(),
    "outcome" = 'succeeded'
WHERE "id" = $1
`;

/** Marks the execution record as crashed - the claim was lost. */
const LOST_RUN_SQL = `
UPDATE "job_runs"
SET "finished_at" = now(),
    "outcome" = 'crashed'
WHERE "id" = $1
`;

/**
 * Completes a claimed job.
 *
 * @returns `true` when the job was completed by this worker, `false` when
 * the claim was lost (the job was recovered or reclaimed by somebody else).
 */
export async function completeJob(
  db: Pool,
  job: ClaimedJob,
): Promise<boolean> {
  return withTransaction(async (client) => {
    const updated = await client.query(COMPLETE_JOB_SQL, [
      job.id,
      job.startedAt,
    ]);

    if (updated.rowCount === 0) {
      // The claim is gone. Record the attempt as crashed and leave the job
      // row alone - it now belongs to whoever picked it up.
      await client.query(LOST_RUN_SQL, [job.runId]);
      return false;
    }

    await client.query(COMPLETE_RUN_SQL, [job.runId]);
    return true;
  }, db);
}
