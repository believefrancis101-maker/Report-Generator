import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { closePool, pool } from '../src/db.js';
import { JOB_STATUSES, type JobStatus } from '../src/jobs/status.js';

/**
 * The three server-rendered pages, against the real database.
 *
 * Start it first: docker compose up -d
 */

let server: Server;
let baseUrl: string;

interface DeadJobFixture {
  key: string;
  status?: JobStatus;
  attempts?: number;
  maxAttempts?: number;
  lastError: string | null;
  payload?: unknown;
}

async function insertJob(fixture: DeadJobFixture): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO "jobs" (
        "type", "payload", "status", "attempts", "max_attempts", "last_error",
        "run_at", "created_at", "updated_at", "finished_at", "idempotency_key"
     ) VALUES (
        'sales_report', $1::jsonb, $2, $3, $4, $5,
        now(), now(), now(), now(), $6
     ) RETURNING "id"`,
    [
      JSON.stringify(fixture.payload ?? { dateFrom: '2024-01-01', dateTo: '2024-03-31' }),
      fixture.status ?? 'dead',
      fixture.attempts ?? 5,
      fixture.maxAttempts ?? 5,
      fixture.lastError,
      `pages-test-${fixture.key}`,
    ],
  );
  return rows[0]!.id;
}

async function insertRun(
  jobId: string,
  workerId: string,
  outcome: string,
  error: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO "job_runs" ("job_id", "worker_id", "started_at", "finished_at", "outcome", "error")
     VALUES ($1, $2, now() - interval '4 seconds', now() - interval '3 seconds', $3, $4)`,
    [jobId, workerId, outcome, error],
  );
}

async function get(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`);
}

async function cleanup(): Promise<void> {
  await pool.query(
    "DELETE FROM job_runs WHERE job_id IN (SELECT id FROM jobs WHERE idempotency_key LIKE 'pages-test-%')",
  );
  await pool.query("DELETE FROM jobs WHERE idempotency_key LIKE 'pages-test-%'");
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

describe('GET /', () => {
  it('renders the trigger form and the navigation', async () => {
    const response = await get('/');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');

    const html = await response.text();
    expect(html).toContain('id="trigger-form"');
    expect(html).toContain('id="dateFrom"');
    expect(html).toContain('id="dateTo"');
    expect(html).toContain('id="idempotencyKey"');
    expect(html).toContain('href="/jobs"');
    expect(html).toContain('href="/dead"');
    // The form talks to the enqueue endpoint and polls the status endpoint.
    expect(html).toContain("'/api/jobs'");
    expect(html).toContain("'/api/jobs/'");
    // Same label as the jobs table: attempts counts failed runs.
    expect(html).toContain("addRow('Failed attempts', 'job-attempts')");
  });
});

describe('GET /jobs', () => {
  it('shows a count for all five statuses, zeros included', async () => {
    const pending = await insertJob({
      key: 'counts-pending',
      status: 'pending',
      attempts: 0,
      lastError: null,
    });
    const dead = await insertJob({ key: 'counts-dead', lastError: 'nothing worked' });

    const counts = await pool.query<{ status: string; count: string }>(
      'SELECT "status", count(*)::text AS "count" FROM "jobs" GROUP BY "status"',
    );
    const expected: Record<string, number> = {
      pending: 0,
      processing: 0,
      succeeded: 0,
      failed: 0,
      dead: 0,
    };
    for (const row of counts.rows) expected[row.status] = Number(row.count);

    const response = await get('/jobs');
    expect(response.status).toBe(200);
    const html = await response.text();

    for (const status of JOB_STATUSES) {
      expect(html).toContain(`data-status-count="${status}"`);
      expect(html).toContain(`badge badge-${status}`);
      const match = html.match(
        new RegExp(`data-status-count="${status}"[\\s\\S]*?<strong>(\\d+)</strong>`),
      );
      expect(match, `count for ${status}`).not.toBeNull();
      expect(Number(match![1])).toBe(expected[status]);
    }

    // Both fixtures are visible in the unfiltered table.
    expect(html).toContain(pending);
    expect(html).toContain(dead);
    // The column counts failed/abandoned runs, not claims - say so.
    expect(html).toContain('<th>Failed attempts</th>');
  });

  it('filters the table by status and keeps the other statuses out', async () => {
    const pending = await insertJob({
      key: 'filter-pending',
      status: 'pending',
      attempts: 0,
      lastError: null,
    });
    const dead = await insertJob({ key: 'filter-dead', lastError: 'boom' });

    const html = await (await get('/jobs?status=dead')).text();

    expect(html).toContain(dead);
    expect(html).not.toContain(pending);
    expect(html).toContain('href="/jobs?status=dead" aria-current="true"');
  });

  it('rejects an unknown status with a 400 page', async () => {
    const response = await get('/jobs?status=exploded');
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('Invalid request');
  });

  it('auto-refreshes every two seconds with ?refresh=2', async () => {
    const html = await (await get('/jobs?refresh=2')).text();
    expect(html).toContain('<meta http-equiv="refresh" content="2">');
    expect(html).toContain('Refreshing every 2 seconds.');
  });
});

describe('GET /dead', () => {
  it('renders the payload, the full error and the run history', async () => {
    const id = await insertJob({
      key: 'diagnose',
      lastError: 'aggregation timed out after 30000ms',
    });
    await insertRun(id, 'worker-test-1', 'failed', 'connection reset');
    await insertRun(id, 'worker-test-2', 'failed', 'aggregation timed out after 30000ms');

    const response = await get('/dead');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');

    const html = await response.text();
    expect(html).toContain(id);
    // The payload, pretty printed.
    expect(html).toContain('&quot;dateFrom&quot;: &quot;2024-01-01&quot;');
    // The full error, not a truncated one.
    expect(html).toContain('aggregation timed out after 30000ms');
    // The run history.
    expect(html).toContain('worker-test-1');
    expect(html).toContain('worker-test-2');
    expect(html).toContain('connection reset');
    expect(html).toContain('ms</td>');
    // The label matches the jobs table.
    expect(html).toContain('<dt>Failed attempts</dt>');
    // The retry button carries the job id.
    expect(html).toContain(`data-retry="${id}"`);
  });

  it('escapes a hostile last_error and payload instead of rendering HTML', async () => {
    const id = await insertJob({
      key: 'xss',
      lastError: '<script>alert(1)</script>',
      payload: {
        dateFrom: '2024-01-01',
        dateTo: '2024-03-31',
        note: '<img src=x onerror=alert(2)>',
      },
    });

    const html = await (await get('/dead')).text();

    expect(html).toContain(id);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;');
    expect(html).not.toContain('<img src=x onerror=alert(2)>');
  });

  it('shows an empty state when nothing is dead', async () => {
    const html = await (await get('/dead')).text();
    if (!html.includes('No dead jobs.')) {
      // Other dead jobs may exist in a shared database; the empty state is
      // only required when the table really is empty.
      const { rows } = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS "count" FROM "jobs" WHERE "status" = 'dead'`,
      );
      expect(Number(rows[0]!.count)).toBeGreaterThan(0);
    }
  });
});
