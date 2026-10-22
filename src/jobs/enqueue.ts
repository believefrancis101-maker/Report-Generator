import type { Pool, PoolClient } from 'pg';
import { pool as sharedPool } from '../db.js';
import { canonicalJson } from './idempotency.js';

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
 * When the key already exists, the stored job is compared with the submitted
 * request. A key that was reused with a different request is rejected instead
 * of silently returning the old job.
 *
 * All timestamps come from the database clock (`now()`), never from Node.
 */

export type InsertedJobRow = {
  id: string;
  status: string;
  attempts: number;
};

export type ExistingJobRow = InsertedJobRow & {
  type: string;
  payload: unknown;
};

/** What the enqueue path returns. */
export type EnqueueOutcome =
  | { outcome: 'created'; id: string; status: string; attempts: number }
  | { outcome: 'duplicate'; id: string; status: string; attempts: number }
  /** The key exists, but it was used with a different request. */
  | { outcome: 'key_reused'; id: string };

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
SELECT "id", "status", "attempts", "type", "payload" FROM "jobs" WHERE "idempotency_key" = $1
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

  const inserted = await db.query<InsertedJobRow>(INSERT_SQL, [
    input.type,
    JSON.stringify(input.payload),
    options.maxAttempts,
    input.idempotencyKey,
  ]);

  const created = inserted.rows[0];
  if (created) {
    return {
      outcome: 'created',
      id: created.id,
      status: created.status,
      attempts: created.attempts,
    };
  }

  // The key already existed: the unique index rejected our insert.
  const existing = await db.query<ExistingJobRow>(SELECT_BY_KEY_SQL, [
    input.idempotencyKey,
  ]);
  const found = existing.rows[0];
  if (!found) {
    // Unreachable: ON CONFLICT DO NOTHING only skips a row that exists.
    throw new Error('job vanished after a conflicting insert');
  }

  // The same key must always describe the same request. Payloads are
  // compared as canonical JSON (sorted keys), so key order never matters.
  const sameRequest =
    found.type === input.type &&
    canonicalJson(found.payload) === canonicalJson(input.payload);

  if (!sameRequest) {
    return { outcome: 'key_reused', id: found.id };
  }

  return {
    outcome: 'duplicate',
    id: found.id,
    status: found.status,
    attempts: found.attempts,
  };
}
