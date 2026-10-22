/**
 * Shared PostgreSQL connection pool.
 *
 * The queue core (claim, failure handling, sweep, retry) talks to Postgres
 * with plain, visible SQL through this pool. Prisma is used for schema,
 * migrations and simple reads.
 */
import 'dotenv/config';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { loadConfig } from './config.js';

const config = loadConfig();

/** Parameter types accepted by the `pg` driver. */
export type SqlParam = string | number | boolean | Date | Buffer | null;

/** The one pool shared by the whole process. */
export const pool = new Pool({
  connectionString: config.databaseUrl,
  // CONCURRENCY job slots plus headroom for the claim loop, the stuck-job
  // sweep and status polling.
  max: config.concurrency + 3,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (error) => {
  console.error(`[db] idle client error: ${error.message}`);
});

/** Runs a parameterised statement on a pooled connection. */
export async function query<Row extends QueryResultRow = QueryResultRow>(
  text: string,
  params: SqlParam[] = [],
): Promise<QueryResult<Row>> {
  return pool.query<Row, SqlParam[]>(text, params);
}

/** Runs a statement inside a transaction on a dedicated client. */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Closes every pooled connection. */
export async function closePool(): Promise<void> {
  await pool.end();
}
