import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { loadConfig } from '../src/config.js';
import { claimJob } from '../src/worker/claim.js';
import { completeJob } from '../src/worker/complete.js';
import { startWorker, type WorkerHandle } from '../src/worker/index.js';

/**
 * Worker tests - they run against the real PostgreSQL database.
 *
 * Start it first: docker compose up -d
 */

const config = loadConfig();

const PAYLOAD = { dateFrom: '2024-01-01', dateTo: '2024-03-31' };

/** A pool for the workers under test (the shared pool is used by the API). */
const workerPool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
});

let logLines: string[] = [];
let consoleSpy: ReturnType<typeof vi.spyOn>;
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
});

afterEach(async () => {
  // Stop every worker that is still running.
  while (running.length > 0) {
    const worker = running.pop();
    await worker?.stop();
  }
  await workerPool.query("DELETE FROM jobs WHERE idempotency_key LIKE 'worker-test-%'");
  logLines = [];
});

afterAll(async () => {
  consoleSpy?.mockRestore();
  await workerPool.end();
});

function captureLogs(): void {
  logLines = [];
  consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logLines.push(args.map((arg) => String(arg)).join(' '));
  });
}

/** Inserts pending jobs and returns their ids. */
async function insertJobs(
  count: number,
  prefix: string,
  runAt: Date = new Date(),
): Promise<string[]> {
  const { rows } = await workerPool.query<{ id: string }>(
    `
    INSERT INTO jobs (type, payload, status, max_attempts, run_at, created_at, updated_at, idempotency_key)
    SELECT 'sales_report', $1::jsonb, 'pending', 5, $2, now(), now(), $3 || '-' || i
    FROM generate_series(1, $4) AS g(i)
    RETURNING id
    `,
    [JSON.stringify(PAYLOAD), runAt, `worker-test-${prefix}`, count],
  );
  return rows.map((row) => row.id);
}

/** Waits until the predicate holds, or fails after the timeout. */
async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 30_000,
  description = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${description}`);
}

/** The concurrency counts that were logged. */
function observedConcurrency(): number[] {
  return logLines
    .map((line) => /concurrent=(\d+)/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]));
}

async function jobStatuses(ids: string[]): Promise<string[]> {
  const { rows } = await workerPool.query<{ id: string; status: string }>(
    'SELECT id, status FROM jobs WHERE id = ANY($1::uuid[])',
    [ids],
  );
  return rows.map((row) => row.status);
}

describe('worker loop', () => {
  it('never exceeds the concurrency cap and reaches it', async () => {
    captureLogs();
    const ids = await insertJobs(20, 'concurrency');

    const worker = startWorker({
      workerId: 'worker-concurrency',
      concurrency: 3,
      pollIntervalMs: 50,
      workDelayMs: 300,
      db: workerPool,
    });
    running.push(worker);

    await waitFor(
      async () => (await jobStatuses(ids)).every((status) => status === 'succeeded'),
      30_000,
      'all 20 jobs to succeed',
    );
    await worker.stop();
    running.pop();

    const observed = observedConcurrency();
    expect(observed.length).toBeGreaterThan(0);
    expect(Math.max(...observed)).toBeLessThanOrEqual(3);
    // A cap of 1 would also satisfy the check above, so assert the cap was
    // actually reached.
    expect(Math.max(...observed)).toBe(3);

    const statuses = await jobStatuses(ids);
    expect(statuses).toHaveLength(20);
    expect(statuses.every((status) => status === 'succeeded')).toBe(true);

    // Exactly one execution record per job.
    const { rows } = await workerPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM job_runs WHERE job_id = ANY($1::uuid[])',
      [ids],
    );
    expect(Number(rows[0]?.count)).toBe(20);
    const { rows: perJob } = await workerPool.query<{ job_id: string; count: string }>(
      'SELECT job_id, count(*)::text AS count FROM job_runs WHERE job_id = ANY($1::uuid[]) GROUP BY job_id',
      [ids],
    );
    expect(perJob).toHaveLength(20);
    expect(perJob.every((row) => Number(row.count) === 1)).toBe(true);

    // Every job was claimed and finished exactly once.
    const claimed = logLines.filter((line) => line.includes('claimed')).length;
    const finished = logLines.filter((line) => line.includes('finished')).length;
    expect(claimed).toBe(20);
    expect(finished).toBe(20);
  });

  it('gives every job to exactly one worker when two workers compete', async () => {
    captureLogs();
    const ids = await insertJobs(40, 'race');

    const workerA = startWorker({
      workerId: 'worker-a',
      concurrency: 3,
      pollIntervalMs: 20,
      workDelayMs: 40,
      db: workerPool,
    });
    const workerB = startWorker({
      workerId: 'worker-b',
      concurrency: 3,
      pollIntervalMs: 20,
      workDelayMs: 40,
      db: workerPool,
    });
    running.push(workerA, workerB);

    await waitFor(
      async () => (await jobStatuses(ids)).every((status) => status === 'succeeded'),
      30_000,
      'all 40 jobs to succeed',
    );
    await workerA.stop();
    await workerB.stop();
    running.length = 0;

    // No job was claimed twice.
    const { rows: perJob } = await workerPool.query<{ job_id: string; count: string }>(
      'SELECT job_id, count(*)::text AS count FROM job_runs WHERE job_id = ANY($1::uuid[]) GROUP BY job_id',
      [ids],
    );
    expect(perJob).toHaveLength(40);
    expect(perJob.every((row) => Number(row.count) === 1)).toBe(true);

    // Both workers picked up work.
    const { rows: perWorker } = await workerPool.query<{ worker_id: string; count: string }>(
      'SELECT worker_id, count(*)::text AS count FROM job_runs WHERE job_id = ANY($1::uuid[]) GROUP BY worker_id',
      [ids],
    );
    expect(perWorker.length).toBe(2);
    expect(perWorker.every((row) => Number(row.count) > 0)).toBe(true);
  });

  it('waits for running jobs when it is stopped', async () => {
    captureLogs();
    const ids = await insertJobs(4, 'shutdown');

    const worker = startWorker({
      workerId: 'worker-shutdown',
      concurrency: 2,
      pollIntervalMs: 50,
      workDelayMs: 700,
      db: workerPool,
    });
    running.push(worker);

    // Wait until the worker picked up jobs, then stop it mid-flight.
    await waitFor(
      async () => logLines.some((line) => line.includes('claimed')),
      10_000,
      'the first job to be claimed',
    );

    await worker.stop();
    running.pop();

    const statuses = await jobStatuses(ids);
    const succeeded = statuses.filter((status) => status === 'succeeded');
    const pending = statuses.filter((status) => status === 'pending');

    // The jobs that were running finished, the untouched ones stay pending.
    expect(succeeded.length).toBe(2);
    expect(pending.length).toBe(2);

    // No job was left in 'processing'.
    expect(statuses.every((status) => status !== 'processing')).toBe(true);
  });

  it('does not claim a job before its run_at', async () => {
    captureLogs();
    const runAt = new Date(Date.now() + 2_000);
    const ids = await insertJobs(1, 'future', runAt);

    const worker = startWorker({
      workerId: 'worker-future',
      concurrency: 3,
      pollIntervalMs: 50,
      workDelayMs: 0,
      db: workerPool,
    });
    running.push(worker);

    // Give the worker plenty of chances to (wrongly) claim it early.
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    expect((await jobStatuses(ids))[0]).toBe('pending');
    const { rows: earlyRuns } = await workerPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM job_runs WHERE job_id = ANY($1::uuid[])',
      [ids],
    );
    expect(Number(earlyRuns[0]?.count)).toBe(0);

    // Once run_at has passed, the job is picked up.
    await waitFor(
      async () => (await jobStatuses(ids)).every((status) => status === 'succeeded'),
      20_000,
      'the deferred job to succeed',
    );
    await worker.stop();
    running.pop();

    const { rows: lateRuns } = await workerPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM job_runs WHERE job_id = ANY($1::uuid[])',
      [ids],
    );
    expect(Number(lateRuns[0]?.count)).toBe(1);
  });
});

describe('completion fencing', () => {
  it('refuses to complete a job whose claim was lost', async () => {
    const ids = await insertJobs(1, 'fencing');

    const claimed = await claimJob(workerPool, 'worker-fencing');
    expect(claimed).not.toBeNull();
    if (!claimed) return;
    expect(claimed.id).toBe(ids[0]);

    // Simulate the sweeper: the job goes back to 'pending' with a new
    // started_at, so the claim token no longer matches.
    await workerPool.query(
      `UPDATE jobs SET status = 'pending', started_at = now(), updated_at = now() WHERE id = $1`,
      [claimed.id],
    );

    // The completion must affect zero rows.
    const { rowCount } = await workerPool.query(
      `UPDATE jobs
       SET status = 'succeeded', finished_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'processing' AND started_at = $2`,
      [claimed.id, claimed.startedAt],
    );
    expect(rowCount).toBe(0);

    // The real completion reports the lost claim and leaves the job alone.
    const completed = await completeJob(workerPool, claimed);
    expect(completed).toBe(false);

    expect((await jobStatuses(ids))[0]).toBe('pending');

    const { rows: runs } = await workerPool.query<{ outcome: string }>(
      'SELECT outcome FROM job_runs WHERE id = $1',
      [claimed.runId],
    );
    expect(runs[0]?.outcome).toBe('crashed');
  });
});
