import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { closePool, pool } from '../src/db.js';
import { deriveIdempotencyKey } from '../src/jobs/idempotency.js';
import { loadConfig } from '../src/config.js';

/**
 * Enqueue endpoint tests - these run against the real PostgreSQL database.
 *
 * Start it first: docker compose up -d
 */

const config = loadConfig();

let server: Server;
let baseUrl: string;

const PAYLOAD = { dateFrom: '2024-01-01', dateTo: '2024-03-31' };

/** The key the API derives for PAYLOAD when the client supplies none. */
const DERIVED_KEY = deriveIdempotencyKey('sales_report', PAYLOAD);

interface EnqueueResponse {
  status: number;
  body: {
    id?: string;
    status?: string;
    attempts?: number;
    duplicate?: boolean;
    error?: string;
    message?: string;
    issues?: { path: string; message: string }[];
  };
}

async function post(
  body: unknown,
  headers: Record<string, string> = {},
): Promise<EnqueueResponse> {
  const response = await fetch(`${baseUrl}/api/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as EnqueueResponse['body'],
  };
}

async function countJobs(key: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM jobs WHERE idempotency_key = $1',
    [key],
  );
  return Number(rows[0]?.count ?? '0');
}

/** Removes every row this suite may have created. */
async function cleanup(): Promise<void> {
  await pool.query(
    "DELETE FROM jobs WHERE idempotency_key LIKE 'test-%' OR idempotency_key = $1",
    [DERIVED_KEY],
  );
}

beforeAll(async () => {
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    throw new Error(
      'These tests need a running PostgreSQL (docker compose up -d): ' +
        (error instanceof Error ? error.message : String(error)),
    );
  }

  await cleanup();

  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await cleanup();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePool();
});

describe('POST /api/jobs', () => {
  it('accepts a job and returns 202 with id, status and attempts', async () => {
    const key = 'test-create-1';
    const response = await post({ type: 'sales_report', payload: PAYLOAD, idempotencyKey: key });

    expect(response.status).toBe(202);
    expect(response.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.body.status).toBe('pending');
    expect(response.body.attempts).toBe(0);
    expect(response.body.duplicate).toBeUndefined();

    const { rows } = await pool.query<{ max_attempts: number; status: string }>(
      'SELECT max_attempts, status FROM jobs WHERE idempotency_key = $1',
      [key],
    );
    expect(rows[0]?.max_attempts).toBe(config.maxAttempts);
    expect(rows[0]?.status).toBe('pending');
  });

  it('collapses a sequential double submit onto one job', async () => {
    const key = 'test-sequential-1';

    const first = await post({ type: 'sales_report', payload: PAYLOAD, idempotencyKey: key });
    const second = await post({ type: 'sales_report', payload: PAYLOAD, idempotencyKey: key });

    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.status).toBe('pending');
    expect(second.body.attempts).toBe(0);

    expect(await countJobs(key)).toBe(1);
  });

  it('collapses 20 concurrent submits onto a single job', async () => {
    const key = 'test-concurrent-1';

    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        post({ type: 'sales_report', payload: PAYLOAD, idempotencyKey: key }),
      ),
    );

    const ids = new Set(responses.map((response) => response.body.id));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toMatch(/^[0-9a-f-]{36}$/);

    const created = responses.filter((response) => response.status === 202);
    const duplicates = responses.filter((response) => response.status === 200);
    expect(created.length).toBe(1);
    expect(duplicates.length).toBe(19);
    expect(duplicates.every((response) => response.body.duplicate === true)).toBe(true);

    expect(await countJobs(key)).toBe(1);
  });

  it('accepts an Idempotency-Key header', async () => {
    const key = 'test-header-1';

    const first = await post(
      { type: 'sales_report', payload: PAYLOAD },
      { 'idempotency-key': key },
    );
    const second = await post(
      { type: 'sales_report', payload: PAYLOAD },
      { 'idempotency-key': key },
    );

    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.id).toBe(first.body.id);
    expect(await countJobs(key)).toBe(1);
  });

  it('derives a key when none is supplied, so identical payloads collapse', async () => {
    const first = await post({ type: 'sales_report', payload: PAYLOAD });
    const second = await post({ type: 'sales_report', payload: PAYLOAD });

    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.id).toBe(first.body.id);

    const derived = DERIVED_KEY;
    expect(await countJobs(derived)).toBe(1);
  });

  it('rejects an invalid body with 400', async () => {
    const response = await post({ type: 'unknown_report', payload: PAYLOAD });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Invalid request body');
    expect(response.body.issues?.[0]?.path).toBe('type');
  });

  it('rejects an invalid date with 400', async () => {
    const response = await post({
      type: 'sales_report',
      payload: { dateFrom: '2024-13-01', dateTo: '2024-03-31' },
    });

    expect(response.status).toBe(400);
    expect(response.body.issues?.[0]?.path).toBe('payload.dateFrom');
    expect(response.body.issues?.[0]?.message).toContain('valid calendar date');
  });

  it('rejects a dateFrom after dateTo with 400', async () => {
    const response = await post({
      type: 'sales_report',
      payload: { dateFrom: '2024-06-01', dateTo: '2024-03-31' },
    });

    expect(response.status).toBe(400);
    expect(response.body.issues?.[0]?.path).toBe('payload.dateTo');
    expect(response.body.issues?.[0]?.message).toContain('on or after');
  });

  it('rejects a body that conflicts with the Idempotency-Key header', async () => {
    const response = await post(
      { type: 'sales_report', payload: PAYLOAD, idempotencyKey: 'body-key' },
      { 'idempotency-key': 'header-key' },
    );

    expect(response.status).toBe(400);
    expect(response.body.issues?.[0]?.message).toContain('conflicts');
  });

  it('returns the existing job when the same key is used with the same payload', async () => {
    const key = 'test-same-payload-1';

    const first = await post({ type: 'sales_report', payload: PAYLOAD, idempotencyKey: key });
    const second = await post({ type: 'sales_report', payload: PAYLOAD, idempotencyKey: key });

    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.status).toBe('pending');
    expect(second.body.attempts).toBe(0);

    expect(await countJobs(key)).toBe(1);
  });

  it('rejects a reused key that carries a different payload with 422', async () => {
    const key = 'test-reused-key-1';
    const otherPayload = { dateFrom: '2024-02-01', dateTo: '2024-03-31' };

    const first = await post({ type: 'sales_report', payload: PAYLOAD, idempotencyKey: key });
    expect(first.status).toBe(202);

    const reused = await post({ type: 'sales_report', payload: otherPayload, idempotencyKey: key });

    expect(reused.status).toBe(422);
    expect(reused.body.error).toBe('idempotency_key_reused');
    expect(reused.body.message).toBe('This key was already used with a different request');

    // The stored job is untouched and no second row was created.
    expect(await countJobs(key)).toBe(1);
    const { rows } = await pool.query<{ payload: { dateFrom: string } }>(
      'SELECT payload FROM jobs WHERE idempotency_key = $1',
      [key],
    );
    expect(rows[0]?.payload.dateFrom).toBe(PAYLOAD.dateFrom);
  });

  it('ignores key order when comparing the stored payload', async () => {
    const key = 'test-reused-key-2';

    const first = await post({
      type: 'sales_report',
      payload: { dateFrom: '2024-01-01', dateTo: '2024-03-31' },
      idempotencyKey: key,
    });
    expect(first.status).toBe(202);

    // Same values, reversed key order in the JSON body.
    const reordered = await post({
      type: 'sales_report',
      payload: { dateTo: '2024-03-31', dateFrom: '2024-01-01' },
      idempotencyKey: key,
    });

    expect(reordered.status).toBe(200);
    expect(reordered.body.duplicate).toBe(true);
    expect(reordered.body.id).toBe(first.body.id);
  });
});

describe('deriveIdempotencyKey', () => {
  it('is independent of key order', () => {
    expect(
      deriveIdempotencyKey('sales_report', { dateFrom: '2024-01-01', dateTo: '2024-03-31' }),
    ).toBe(
      deriveIdempotencyKey('sales_report', { dateTo: '2024-03-31', dateFrom: '2024-01-01' }),
    );
  });

  it('changes when a value changes', () => {
    expect(deriveIdempotencyKey('sales_report', PAYLOAD)).not.toBe(
      deriveIdempotencyKey('sales_report', { dateFrom: '2024-01-02', dateTo: '2024-03-31' }),
    );
  });

  it('is a sha-256 digest of the canonical form', () => {
    expect(deriveIdempotencyKey('sales_report', PAYLOAD)).toMatch(
      /^auto:[0-9a-f]{64}$/,
    );
  });
});
