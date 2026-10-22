import type { Pool, PoolClient } from 'pg';
import { pool as sharedPool } from '../db.js';

/**
 * Enqueueing a job.
 *
 * The handler does exactly one thing: it inserts a job row with status
 * `pending` and returns. No work is performed here.
 *
 * Idempotency is enforced by the database: `jobs.idempotency_key` carries a
 * UNIQUE index, and the insert relies on `ON CONFLICT ... DO NOTHING` rather
 * than a check-then-insert in application code.
 *
 * All timestamps come from the database clock (`now()`), never from Node.
 */

export type JobRow = {
  id: string;
  status: string;
  attempts: number;
};

/** What the enqueue path returns. */
export interface EnqueueOutcome {
  id: string;
  status: string;
  attempts: number;
  /** True when the job already existed for this idempotency key. */
  duplicate: boolean;
}

export interface EnqueueInput {
  type: string;
  payload: unknown;
  idempotencyKey: string;
}

export interface EnqueueOptions {
  /** Maximum delivery attempts for the new job (from the configuration). */
  maxAttempts: number;
  /** Connection to use; defaults to the shared pool. */
  db?: Pool | PoolClient;
}

const INSERT_SQL = `
INSERT INTO "jobs" ("type", "payload", "status", "max_attempts", "run_at", "created_at", "updated_at", "idempotency_key")
VALUES ($1, $2::jsonb, 'pending', $3, now(), now(), now(), $4)
ON CONFLICT ("idempotency_key") DO NOTHING
RETURNING "id", "status", "attempts"
`;

const SELECT_BY_KEY_SQL = `
SELECT "id", "status", "attempts" FROM "jobs" WHERE "idempotency_key" = $1
`;

/**
 * Inserts a pending job, or returns the existing one for the same
 * idempotency key.
 */
export async function enqueueJob(
  input: EnqueueInput,
  options: EnqueueOptions,
): Promise<EnqueueOutcome> {
  const db = options.db ?? sharedPool;

  const inserted = await db.query<JobRow>(INSERT_SQL, [
    input.type,
    JSON.stringify(input.payload),
    options.maxAttempts,
    input.idempotencyKey,
  ]);

  const created = inserted.rows[0];
  if (created) {
    return {
      id: created.id,
      status: created.status,
      attempts: created.attempts,
      duplicate: false,
    };
  }

  // The key already existed: the unique index rejected our insert.
  const existing = await db.query<JobRow>(SELECT_BY_KEY_SQL, [
    input.idempotencyKey,
  ]);
  const found = existing.rows[0];
  if (!found) {
    // Unreachable: ON CONFLICT DO NOTHING only skips a row that exists.
    throw new Error('job vanished after a conflicting insert');
  }

  return {
    id: found.id,
    status: found.status,
    attempts: found.attempts,
    duplicate: true,
  };
}
