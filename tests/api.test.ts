import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { closePool, pool } from '../src/db.js';
import type { JobStatus } from '../src/jobs/status.js';

/**
 * Status, list, retry and report endpoints - against the real database.
 *
 * Start it first: docker compose up -d
 */

let server: Server;
let baseUrl: string;

/** The documented shape of a job in the API. */
const JOB_KEYS = [
  'attempts',
  'finishedAt',
  'id',
  'lastError',
  'maxAttempts',
  'reportAvailable',
  'runAt',
  'startedAt',
  'status',
  'type',
];

interface JobBody {
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

interface JobFixture {
  key: string;
  status?: JobStatus;
  attempts?: number;
  maxAttempts?: number;
  lastError?: string | null;
  /** How long ago the job was created, in ms. */
  createdAgoMs?: number;
}

async function insertJob(fixture: JobFixture): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO "jobs" (
        "type", "payload", "status", "attempts", "max_attempts", "last_error",
        "run_at", "created_at", "updated_at", "idempotency_key"
     ) VALUES (
        'sales_report', '{"dateFrom":"2024-01-01","dateTo":"2024-03-31"}'::jsonb,
        $1, $2, $3, $4,
        now() - ($5::bigint * interval '1 millisecond'),
        now() - ($5::bigint * interval '1 millisecond'),
        now(), $6
     ) RETURNING "id"`,
    [
      fixture.status ?? 'pending',
      fixture.attempts ?? 0,
      fixture.maxAttempts ?? 5,
      fixture.lastError ?? null,
      fixture.createdAgoMs ?? 0,
      `api-test-${fixture.key}`,
    ],
  );
  return rows[0]!.id;
}

async function insertReport(jobId: string): Promise<void> {
  const pdf = Buffer.from('%PDF-1.4\n% test report\n%%EOF\n', 'ascii');
  await pool.query(
    `INSERT INTO "reports" ("job_id", "summary", "pdf")
     VALUES ($1, '{"totals":{"revenueMinor":0,"orders":0}}'::jsonb, $2)`,
    [jobId, pdf],
  );
}

async function get(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`);
}

/** The body of an error response. */
async function errorBody(response: Response): Promise<{ error?: string }> {
  return (await response.json()) as { error?: string };
}

async function cleanup(): Promise<void> {
  await pool.query(
    "DELETE FROM reports WHERE job_id IN (SELECT id FROM jobs WHERE idempotency_key LIKE 'api-test-%')",
  );
  await pool.query("DELETE FROM jobs WHERE idempotency_key LIKE 'api-test-%'");
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

  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(async () => {
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePool();
});

describe('GET /api/jobs/:id', () => {
  it('returns the documented job shape', async () => {
    const id = await insertJob({
      key: 'shape',
      status: 'failed',
      attempts: 2,
      maxAttempts: 5,
      lastError: 'boom',
    });

    const response = await get(`/api/jobs/${id}`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as JobBody;
    expect(Object.keys(body).sort()).toEqual(JOB_KEYS);
    expect(body).toMatchObject({
      id,
      type: 'sales_report',
      status: 'failed',
      attempts: 2,
      maxAttempts: 5,
      lastError: 'boom',
      startedAt: null,
      finishedAt: null,
      reportAvailable: false,
    });
    // ISO 8601 UTC with milliseconds.
    expect(body.runAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('reports reportAvailable without exposing the pdf', async () => {
    const id = await insertJob({ key: 'available', status: 'succeeded' });
    await insertReport(id);

    const body = (await (await get(`/api/jobs/${id}`)).json()) as JobBody;
    expect(body.reportAvailable).toBe(true);
    expect(JSON.stringify(body)).not.toContain('%PDF');
  });

  it('answers 404 for an unknown job', async () => {
    const response = await get('/api/jobs/00000000-0000-4000-8000-000000000000');
    expect(response.status).toBe(404);
    expect((await errorBody(response)).error).toBe('Job not found');
  });

  it('answers 400 for a malformed id', async () => {
    const response = await get('/api/jobs/not-a-uuid');
    expect(response.status).toBe(400);
    expect((await errorBody(response)).error).toBe('Invalid job id');
  });
});

describe('GET /api/jobs', () => {
  it('filters by status', async () => {
    const pending = await insertJob({ key: 'filter-pending', status: 'pending' });
    const dead = await insertJob({ key: 'filter-dead', status: 'dead' });

    const response = await get('/api/jobs?status=dead&limit=200');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { jobs: JobBody[]; limit: number; offset: number };
    expect(body.limit).toBe(200);
    expect(body.offset).toBe(0);
    expect(body.jobs.length).toBeGreaterThan(0);
    expect(body.jobs.every((job) => job.status === 'dead')).toBe(true);

    const ids = body.jobs.map((job) => job.id);
    expect(ids).toContain(dead);
    expect(ids).not.toContain(pending);
  });

  it('returns the newest jobs first and applies the default limit of 50', async () => {
    const older = await insertJob({ key: 'older', createdAgoMs: 3_600_000 });
    const newer = await insertJob({ key: 'newer', createdAgoMs: 0 });

    const body = (await (await get('/api/jobs?status=pending')).json()) as {
      jobs: JobBody[];
      limit: number;
    };

    expect(body.limit).toBe(50);
    const ids = body.jobs.map((job) => job.id);
    expect(ids.indexOf(newer)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(newer)).toBeLessThan(ids.indexOf(older));
  });

  it('rejects an invalid status', async () => {
    const response = await get('/api/jobs?status=exploded');
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('Invalid query');
  });

  it('rejects a limit above 200', async () => {
    const response = await get('/api/jobs?limit=201');
    expect(response.status).toBe(400);
  });
});

describe('POST /api/jobs/:id/retry', () => {
  it('puts a dead job back into the queue and resets attempts', async () => {
    const id = await insertJob({
      key: 'retry-dead',
      status: 'dead',
      attempts: 5,
      maxAttempts: 5,
      lastError: 'it died',
    });

    const response = await fetch(`${baseUrl}/api/jobs/${id}/retry`, {
      method: 'POST',
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as JobBody;
    expect(body.status).toBe('pending');
    expect(body.attempts).toBe(0);
    expect(body.finishedAt).toBeNull();
    // The reason is kept until the next attempt overwrites it.
    expect(body.lastError).toBe('it died');

    const { rows } = await pool.query<{ status: string; attempts: number }>(
      'SELECT "status", "attempts" FROM "jobs" WHERE "id" = $1',
      [id],
    );
    expect(rows[0]).toEqual({ status: 'pending', attempts: 0 });
  });

  it('answers 409 when the job is not dead', async () => {
    const id = await insertJob({ key: 'retry-alive', status: 'pending' });

    const response = await fetch(`${baseUrl}/api/jobs/${id}/retry`, {
      method: 'POST',
    });
    expect(response.status).toBe(409);
    expect((await errorBody(response)).error).toBe('job_not_dead');
  });

  it('answers 404 for an unknown job', async () => {
    const response = await fetch(
      `${baseUrl}/api/jobs/00000000-0000-4000-8000-000000000000/retry`,
      { method: 'POST' },
    );
    expect(response.status).toBe(404);
  });

  it('lets exactly one of two concurrent retries win', async () => {
    const id = await insertJob({
      key: 'retry-race',
      status: 'dead',
      attempts: 5,
    });

    const [first, second] = await Promise.all([
      fetch(`${baseUrl}/api/jobs/${id}/retry`, { method: 'POST' }),
      fetch(`${baseUrl}/api/jobs/${id}/retry`, { method: 'POST' }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
  });
});

describe('GET /api/jobs/:id/report', () => {
  it('streams the stored PDF as an attachment', async () => {
    const id = await insertJob({ key: 'report', status: 'succeeded' });
    await insertReport(id);

    const response = await get(`/api/jobs/${id}/report`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="report-${id}.pdf"`,
    );

    const body = Buffer.from(await response.arrayBuffer());
    expect(body.subarray(0, 4).toString('ascii')).toBe('%PDF');
  });

  it('answers 404 when the job has no report', async () => {
    const id = await insertJob({ key: 'report-missing', status: 'pending' });

    const response = await get(`/api/jobs/${id}/report`);
    expect(response.status).toBe(404);
    expect((await errorBody(response)).error).toBe('Report not found');
  });
});
