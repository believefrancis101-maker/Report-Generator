import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { CrashError } from '../src/faults.js';
import {
  aggregateSalesReport,
  type SalesReportParams,
} from '../src/handlers/aggregate.js';
import { salesReportHandler, type ReportSummary } from '../src/handlers/salesReport.js';
import type { HandlerContext } from '../src/handlers/types.js';
import type { ClaimedJob } from '../src/worker/claim.js';
import { startWorker, type WorkerHandle } from '../src/worker/index.js';
import { loadConfig } from '../src/config.js';

/**
 * The sales report handler - it runs against the real PostgreSQL database.
 *
 * Start it first: docker compose up -d
 */

const config = loadConfig();

const workerPool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
});

const PARAMS: SalesReportParams = { dateFrom: '2024-01-01', dateTo: '2024-03-31' };

/**
 * A small, hand-computed set of orders.
 *
 *   2024-01-05  ada      Electronics   1,000
 *   2024-01-20  bob      Electronics   2,000
 *   2024-02-03  ada      Books         5,000
 *   2024-03-15  cecilia  Books         1,500
 *   2023-12-31  outside  Books         9,999   <- outside the range
 *
 * Totals for the range: revenue 9,500 minor units, 4 orders.
 */
const FIXTURE = [
  { customer: 'sales-test-ada', category: 'Electronics', amountMinor: 1_000, createdAt: '2024-01-05T10:00:00Z' },
  { customer: 'sales-test-bob', category: 'Electronics', amountMinor: 2_000, createdAt: '2024-01-20T10:00:00Z' },
  { customer: 'sales-test-ada', category: 'Books', amountMinor: 5_000, createdAt: '2024-02-03T10:00:00Z' },
  { customer: 'sales-test-cecilia', category: 'Books', amountMinor: 1_500, createdAt: '2024-03-15T10:00:00Z' },
  { customer: 'sales-test-outside', category: 'Books', amountMinor: 9_999, createdAt: '2023-12-31T10:00:00Z' },
];

const running: WorkerHandle[] = [];

beforeAll(async () => {
  try {
    await workerPool.query('SELECT 1');
  } catch (error) {
    throw new Error(
      'These tests need a running PostgreSQL (docker compose up -d): ' +
        (error instanceof Error ? error.message : String(error)),
    );
  }

  for (const row of FIXTURE) {
    await workerPool.query(
      `INSERT INTO sales_orders (id, customer_name, category, amount_minor, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4::timestamptz)`,
      [row.customer, row.category, row.amountMinor, row.createdAt],
    );
  }
});

afterEach(async () => {
  while (running.length > 0) {
    const worker = running.pop();
    await worker?.stop();
  }
  await workerPool.query("DELETE FROM reports WHERE job_id IN (SELECT id FROM jobs WHERE idempotency_key LIKE 'report-test-%')");
  await workerPool.query("DELETE FROM jobs WHERE idempotency_key LIKE 'report-test-%'");
});

afterAll(async () => {
  await workerPool.query("DELETE FROM sales_orders WHERE customer_name LIKE 'sales-test-%'");
  await workerPool.end();
});

/** Creates a job row and returns its id. */
async function insertJob(
  prefix: string,
  type = 'sales_report',
  payload: unknown = PARAMS,
  maxAttempts = 5,
): Promise<string> {
  const { rows } = await workerPool.query<{ id: string }>(
    `INSERT INTO jobs (type, payload, status, max_attempts, run_at, created_at, updated_at, idempotency_key)
     VALUES ($1, $2::jsonb, 'pending', $3, now(), now(), now(), $4)
     RETURNING id`,
    [type, JSON.stringify(payload), maxAttempts, `report-test-${prefix}`],
  );
  return rows[0]!.id;
}

/** A claimed job, as the worker would hand it to the handler. */
function claimedJob(id: string, type = 'sales_report'): ClaimedJob {
  return {
    id,
    type,
    payload: PARAMS,
    attempts: 0,
    max_attempts: 5,
    startedAt: new Date(),
    runId: '00000000-0000-0000-0000-000000000000',
  };
}

/** A context for the handler, with a spy on the aggregation. */
function makeContext(
  aggregate: ReturnType<typeof vi.fn>,
  overrides: Partial<HandlerContext> = {},
): HandlerContext {
  return {
    db: workerPool,
    workerId: 'test-handler',
    random: () => 0,
    faults: { workDelayMs: 0, failRate: 0, crashAfterWork: false },
    aggregate: aggregate as unknown as HandlerContext['aggregate'],
    applyFaults: async () => undefined,
    crashAfterWork: () => undefined,
    ...overrides,
  };
}

async function readReport(jobId: string): Promise<{ summary: ReportSummary; pdf: Buffer } | undefined> {
  const { rows } = await workerPool.query<{ summary: ReportSummary; pdf: Buffer }>(
    'SELECT summary, pdf FROM reports WHERE job_id = $1',
    [jobId],
  );
  return rows[0];
}

describe('salesReport handler', () => {
  it('computes the summary from the sales data and stores a PDF', async () => {
    const aggregate = vi.fn(aggregateSalesReport);
    const jobId = await insertJob('summary');

    await salesReportHandler(claimedJob(jobId), makeContext(aggregate));

    const report = await readReport(jobId);
    expect(report).toBeDefined();

    // The hand-computed totals.
    expect(report!.summary.totals).toEqual({ revenueMinor: 9_500, orders: 4 });

    // Revenue and orders by category and month.
    expect(report!.summary.byCategoryMonth).toEqual([
      {
        month: '2024-01',
        category: 'Electronics',
        revenueMinor: 3_000,
        orders: 2,
        customers: 2,
        topCustomer: 'sales-test-bob',
      },
      {
        month: '2024-02',
        category: 'Books',
        revenueMinor: 5_000,
        orders: 1,
        customers: 1,
        topCustomer: 'sales-test-ada',
      },
      {
        month: '2024-03',
        category: 'Books',
        revenueMinor: 1_500,
        orders: 1,
        customers: 1,
        topCustomer: 'sales-test-cecilia',
      },
    ]);

    // The top customers, ranked.
    expect(report!.summary.topCustomers).toEqual([
      { rank: 1, customerName: 'sales-test-ada', revenueMinor: 6_000, orders: 2 },
      { rank: 2, customerName: 'sales-test-bob', revenueMinor: 2_000, orders: 1 },
      { rank: 3, customerName: 'sales-test-cecilia', revenueMinor: 1_500, orders: 1 },
    ]);

    // The month over month growth.
    expect(report!.summary.growth).toEqual([
      {
        month: '2024-01',
        revenueMinor: 3_000,
        orders: 2,
        prevRevenueMinor: null,
        growthPct: null,
        categories: [{ category: 'Electronics', revenueMinor: 3_000, sharePct: 100 }],
      },
      {
        month: '2024-02',
        revenueMinor: 5_000,
        orders: 1,
        prevRevenueMinor: 3_000,
        growthPct: 66.67,
        categories: [{ category: 'Books', revenueMinor: 5_000, sharePct: 100 }],
      },
      {
        month: '2024-03',
        revenueMinor: 1_500,
        orders: 1,
        prevRevenueMinor: 5_000,
        growthPct: -70,
        categories: [{ category: 'Books', revenueMinor: 1_500, sharePct: 100 }],
      },
    ]);

    // The parameters and the generation timestamp.
    expect(report!.summary.params).toEqual(PARAMS);
    expect(Date.parse(report!.summary.generatedAt)).not.toBeNaN();

    // The PDF is a real, non-empty PDF.
    expect(report!.pdf.length).toBeGreaterThan(1_000);
    expect(report!.pdf.subarray(0, 4).toString('ascii')).toBe('%PDF');
  });

  it('does the work only once for the same job', async () => {
    const aggregate = vi.fn(aggregateSalesReport);
    const jobId = await insertJob('idempotent');
    const ctx = makeContext(aggregate);

    await salesReportHandler(claimedJob(jobId), ctx);
    await salesReportHandler(claimedJob(jobId), ctx);

    const { rows } = await workerPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM reports WHERE job_id = $1',
      [jobId],
    );
    expect(Number(rows[0]?.count)).toBe(1);
    // The second run found the report and skipped the work.
    expect(aggregate).toHaveBeenCalledTimes(1);
  });

  it('produces one report when two invocations run concurrently', async () => {
    const aggregate = vi.fn(aggregateSalesReport);
    const jobId = await insertJob('concurrent');
    const ctx = makeContext(aggregate);

    await Promise.all([
      salesReportHandler(claimedJob(jobId), ctx),
      salesReportHandler(claimedJob(jobId), ctx),
    ]);

    const { rows } = await workerPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM reports WHERE job_id = $1',
      [jobId],
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });

  it('does not repeat the work after a crash between the report and the completion', async () => {
    const aggregate = vi.fn(aggregateSalesReport);
    const jobId = await insertJob('crash');

    const worker = startWorker({
      workerId: 'worker-crash',
      concurrency: 1,
      pollIntervalMs: 20,
      backoff: { baseMs: 50, maxMs: 500 },
      // The worker crashes after the report was saved.
      faults: { workDelayMs: 0, failRate: 0, crashAfterWork: true },
      crashAfterWork: () => {
        throw new CrashError('crashed after the work was saved (TEST-ONLY)');
      },
      aggregate,
      sweep: false,
      db: workerPool,
    });
    running.push(worker);

    // Wait until the report was written.
    await expect
      .poll(async () => (await readReport(jobId)) !== undefined, {
        timeout: 10_000,
        interval: 25,
      })
      .toBe(true);

    // The job is still 'processing': the crash did not record an outcome.
    const { rows: afterCrash } = await workerPool.query<{ status: string }>(
      'SELECT status FROM jobs WHERE id = $1',
      [jobId],
    );
    expect(afterCrash[0]?.status).toBe('processing');
    expect(aggregate).toHaveBeenCalledTimes(1);

    await worker.stop();
    running.pop();

    // Simulate what the sweeper will do: the job becomes claimable again.
    await workerPool.query(
      `UPDATE jobs SET status = 'pending', started_at = NULL, run_at = now(), updated_at = now()
       WHERE id = $1`,
      [jobId],
    );

    const secondWorker = startWorker({
      workerId: 'worker-crash-2',
      concurrency: 1,
      pollIntervalMs: 20,
      backoff: { baseMs: 50, maxMs: 500 },
      aggregate,
      sweep: false,
      db: workerPool,
    });
    running.push(secondWorker);

    await expect
      .poll(
        async () => {
          const { rows } = await workerPool.query<{ status: string }>(
            'SELECT status FROM jobs WHERE id = $1',
            [jobId],
          );
          return rows[0]?.status;
        },
        { timeout: 10_000, interval: 25 },
      )
      .toBe('succeeded');

    await secondWorker.stop();
    running.pop();

    // Still exactly one report - and the aggregation did not run again.
    const { rows } = await workerPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM reports WHERE job_id = $1',
      [jobId],
    );
    expect(Number(rows[0]?.count)).toBe(1);
    expect(aggregate).toHaveBeenCalledTimes(1);
  });

  it('produces no report when the job fails', async () => {
    const aggregate = vi.fn(aggregateSalesReport);
    const jobId = await insertJob('failing');

    const worker = startWorker({
      workerId: 'worker-failing',
      concurrency: 1,
      pollIntervalMs: 20,
      backoff: { baseMs: 50, maxMs: 500 },
      faults: { workDelayMs: 0, failRate: 1, crashAfterWork: false },
      aggregate,
      sweep: false,
      db: workerPool,
    });
    running.push(worker);

    await expect
      .poll(
        async () => {
          const { rows } = await workerPool.query<{ status: string }>(
            'SELECT status FROM jobs WHERE id = $1',
            [jobId],
          );
          return rows[0]?.status;
        },
        { timeout: 10_000, interval: 25 },
      )
      .toBe('failed');

    await worker.stop();
    running.pop();

    const { rows } = await workerPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM reports WHERE job_id = $1',
      [jobId],
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it('fails a job with an unknown type', async () => {
    const aggregate = vi.fn(aggregateSalesReport);
    const jobId = await insertJob('unknown-type', 'unknown_report');

    const worker = startWorker({
      workerId: 'worker-unknown',
      concurrency: 1,
      pollIntervalMs: 20,
      backoff: { baseMs: 50, maxMs: 500 },
      aggregate,
      sweep: false,
      db: workerPool,
    });
    running.push(worker);

    await expect
      .poll(
        async () => {
          const { rows } = await workerPool.query<{ status: string }>(
            'SELECT status FROM jobs WHERE id = $1',
            [jobId],
          );
          return rows[0]?.status;
        },
        { timeout: 10_000, interval: 25 },
      )
      .toBe('failed');

    await worker.stop();
    running.pop();

    const { rows } = await workerPool.query<{ last_error: string | null }>(
      'SELECT last_error FROM jobs WHERE id = $1',
      [jobId],
    );
    expect(rows[0]?.last_error).toContain('Unknown job type');
    expect(rows[0]?.last_error).toContain('unknown_report');

    // The unknown type never produced a report.
    const { rows: reports } = await workerPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM reports WHERE job_id = $1',
      [jobId],
    );
    expect(Number(reports[0]?.count)).toBe(0);
  });
});
