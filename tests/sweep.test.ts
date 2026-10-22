import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { loadConfig } from '../src/config.js';
import { CrashError } from '../src/faults.js';
import { aggregateSalesReport } from '../src/handlers/aggregate.js';
import { createStubHandler } from '../src/worker/handler.js';
import { startWorker, type WorkerHandle } from '../src/worker/index.js';
import { sweepStuckJobs } from '../src/worker/sweep.js';

/**
 * Stuck-job recovery - against the real PostgreSQL database.
 *
 * Start it first: docker compose up -d
 */

const config = loadConfig();

const workerPool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
});

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
  while (running.length > 0) {
    await running.pop()?.stop();
  }
  await workerPool.query(
    "DELETE FROM reports WHERE job_id IN (SELECT id FROM jobs WHERE idempotency_key LIKE 'sweep-test-%')",
  );
  await workerPool.query(
    "DELETE FROM jobs WHERE idempotency_key LIKE 'sweep-test-%'",
  );
});

afterAll(async () => {
  await workerPool.end();
});

type JobStatus = 'pending' | 'processing' | 'failed' | 'succeeded' | 'dead';

interface JobSpec {
  key: string;
  status?: JobStatus;
  attempts?: number;
  maxAttempts?: number;
  /** How long ago the job was started (ms). Null: it never started. */
  startedAgoMs?: number | null;
  /** Offset of `run_at` from now (ms). */
  runAtOffsetMs?: number;
  type?: string;
  payload?: unknown;
  /** Also insert an open job_runs row. Processing jobs default to true. */
  openRun?: boolean;
}

/** Inserts a job in a known state and returns its id. */
async function insertJob(spec: JobSpec): Promise<string> {
  const status = spec.status ?? 'processing';
  const startedAgoMs =
    spec.startedAgoMs === undefined
      ? status === 'processing'
        ? 5_000
        : null
      : spec.startedAgoMs;

  const { rows } = await workerPool.query<{ id: string }>(
    `INSERT INTO jobs (
        type, payload, status, attempts, max_attempts, run_at, started_at,
        finished_at, created_at, updated_at, idempotency_key
     ) VALUES (
        $1, $2::jsonb, $3, $4, $5,
        now() + ($6::bigint * interval '1 millisecond'),
        CASE WHEN $7::bigint IS NULL THEN NULL
             ELSE now() - ($7::bigint * interval '1 millisecond') END,
        CASE WHEN $3 IN ('succeeded', 'dead') THEN now() ELSE NULL END,
        now(), now(), $8
     ) RETURNING id`,
    [
      spec.type ?? 'sales_report',
      JSON.stringify(spec.payload ?? {}),
      status,
      spec.attempts ?? 0,
      spec.maxAttempts ?? 5,
      spec.runAtOffsetMs ?? 0,
      startedAgoMs,
      `sweep-test-${spec.key}`,
    ],
  );

  const id = rows[0]!.id;
  const openRun = spec.openRun ?? status === 'processing';
  if (openRun) {
    await workerPool.query(
      `INSERT INTO job_runs (job_id, worker_id, started_at)
       VALUES ($1, 'sweep-test-worker', now())`,
      [id],
    );
  }
  return id;
}

interface JobRow {
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  run_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

async function jobRow(jobId: string): Promise<JobRow> {
  const { rows } = await workerPool.query<JobRow>(
    `SELECT status, attempts, max_attempts, last_error, run_at, started_at, finished_at
     FROM jobs WHERE id = $1`,
    [jobId],
  );
  return rows[0]!;
}

interface RunRow {
  worker_id: string;
  started_at: Date;
  finished_at: Date | null;
  outcome: string | null;
  error: string | null;
}

async function runRows(jobId: string): Promise<RunRow[]> {
  const { rows } = await workerPool.query<RunRow>(
    `SELECT worker_id, started_at, finished_at, outcome, error
     FROM job_runs WHERE job_id = $1 ORDER BY started_at`,
    [jobId],
  );
  return rows;
}

async function reportCount(jobId: string): Promise<number> {
  const { rows } = await workerPool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM reports WHERE job_id = $1',
    [jobId],
  );
  return Number(rows[0]?.count);
}

describe('sweepStuckJobs', () => {
  it('recovers a stuck job: pending, one more attempt, run closed as crashed', async () => {
    const jobId = await insertJob({ key: 'recover', startedAgoMs: 60_000 });

    const recovered = await sweepStuckJobs(workerPool, { stuckTimeoutMs: 1_000 });

    expect(recovered).toContainEqual({
      id: jobId,
      status: 'pending',
      attempts: 1,
    });

    const job = await jobRow(jobId);
    expect(job.status).toBe('pending');
    expect(job.attempts).toBe(1);
    expect(job.last_error).toBe(
      'Recovered by sweep: stuck in processing for more than 1000ms',
    );
    expect(job.finished_at).toBeNull();
    // The job is claimable again.
    expect(job.run_at.getTime()).toBeLessThanOrEqual(Date.now());

    const runs = await runRows(jobId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.outcome).toBe('crashed');
    expect(runs[0]?.error).toBe(
      'Abandoned: worker did not finish; recovered by sweep',
    );
    expect(runs[0]?.finished_at).not.toBeNull();
  });

  it('kills a stuck job that used its last allowed attempt', async () => {
    const jobId = await insertJob({
      key: 'dead',
      attempts: 2,
      maxAttempts: 3,
      startedAgoMs: 60_000,
    });

    const recovered = await sweepStuckJobs(workerPool, { stuckTimeoutMs: 1_000 });

    expect(recovered).toContainEqual({
      id: jobId,
      status: 'dead',
      attempts: 3,
    });

    const job = await jobRow(jobId);
    expect(job.status).toBe('dead');
    expect(job.attempts).toBe(3);
    expect(job.finished_at).not.toBeNull();
    expect(job.last_error).toContain('Recovered by sweep');

    const runs = await runRows(jobId);
    expect(runs[0]?.outcome).toBe('crashed');
  });

  it('leaves recent processing jobs and jobs in other states alone', async () => {
    const recent = await insertJob({ key: 'recent', startedAgoMs: 0 });
    const pending = await insertJob({
      key: 'pending',
      status: 'pending',
      startedAgoMs: 60_000,
      openRun: true,
    });
    const failed = await insertJob({
      key: 'failed',
      status: 'failed',
      startedAgoMs: 60_000,
      openRun: true,
    });
    const succeeded = await insertJob({
      key: 'succeeded',
      status: 'succeeded',
      startedAgoMs: 60_000,
      openRun: true,
    });
    const dead = await insertJob({
      key: 'dead-status',
      status: 'dead',
      startedAgoMs: 60_000,
      openRun: true,
    });

    const recovered = await sweepStuckJobs(workerPool, { stuckTimeoutMs: 1_000 });

    for (const id of [recent, pending, failed, succeeded, dead]) {
      expect(recovered.map((job) => job.id)).not.toContain(id);
    }

    expect((await jobRow(recent)).status).toBe('processing');
    expect((await jobRow(recent)).attempts).toBe(0);
    expect((await jobRow(pending)).status).toBe('pending');
    expect((await jobRow(failed)).status).toBe('failed');
    expect((await jobRow(succeeded)).status).toBe('succeeded');
    expect((await jobRow(dead)).status).toBe('dead');

    // No run row was closed either.
    for (const id of [recent, pending, failed, succeeded, dead]) {
      const runs = await runRows(id);
      expect(runs[0]?.outcome).toBeNull();
      expect(runs[0]?.finished_at).toBeNull();
    }
  });

  it('recovers a stuck job exactly once when two sweeps run concurrently', async () => {
    const jobId = await insertJob({ key: 'concurrent', startedAgoMs: 60_000 });

    const [first, second] = await Promise.all([
      sweepStuckJobs(workerPool, { stuckTimeoutMs: 1_000 }),
      sweepStuckJobs(workerPool, { stuckTimeoutMs: 1_000 }),
    ]);

    const recoveredForJob = [...first, ...second].filter(
      (job) => job.id === jobId,
    );
    expect(recoveredForJob).toHaveLength(1);

    const job = await jobRow(jobId);
    // The attempt was counted once, not twice.
    expect(job.attempts).toBe(1);
    expect(job.status).toBe('pending');
  });
});

describe('stuck-job recovery in the worker', () => {
  it('recovers a crashed job, reclaims it and finishes it', async () => {
    const aggregate = vi.fn(aggregateSalesReport);
    const jobId = await insertJob({
      key: 'e2e',
      status: 'pending',
      attempts: 0,
      payload: { dateFrom: '2024-01-01', dateTo: '2024-03-31' },
    });

    // Worker A crashes after the report was saved, before it can mark the
    // job as succeeded. That leaves the job 'processing'.
    const workerA = startWorker({
      workerId: 'sweep-e2e-a',
      concurrency: 1,
      pollIntervalMs: 20,
      backoff: { baseMs: 50, maxMs: 500 },
      sweep: false,
      faults: { workDelayMs: 0, failRate: 0, crashAfterWork: true },
      crashAfterWork: () => {
        throw new CrashError('crashed after the work was saved (TEST-ONLY)');
      },
      aggregate,
      db: workerPool,
    });
    running.push(workerA);

    await expect
      .poll(async () => reportCount(jobId), { timeout: 10_000, interval: 25 })
      .toBe(1);
    expect((await jobRow(jobId)).status).toBe('processing');

    // The crashed process is gone. The job is now stuck.
    await workerA.stop();
    running.pop();

    // Worker B has a short stuck timeout: it recovers the job, claims it and
    // finishes it.
    const workerB = startWorker({
      workerId: 'sweep-e2e-b',
      concurrency: 1,
      pollIntervalMs: 20,
      backoff: { baseMs: 50, maxMs: 500 },
      sweep: { stuckTimeoutMs: 300, intervalMs: 100 },
      aggregate,
      db: workerPool,
    });
    running.push(workerB);

    await expect
      .poll(async () => (await jobRow(jobId)).status, {
        timeout: 20_000,
        interval: 25,
      })
      .toBe('succeeded');

    await workerB.stop();
    running.pop();

    const job = await jobRow(jobId);
    expect(job.status).toBe('succeeded');
    // One recovery attempt, and the handler did not run a second time.
    expect(job.attempts).toBe(1);
    expect(await reportCount(jobId)).toBe(1);
    expect(aggregate).toHaveBeenCalledTimes(1);

    const runs = await runRows(jobId);
    expect(runs.map((run) => run.outcome)).toEqual(['crashed', 'succeeded']);
    expect(runs[0]?.worker_id).toBe('sweep-e2e-a');
    expect(runs[0]?.error).toBe(
      'Abandoned: worker did not finish; recovered by sweep',
    );
    expect(runs[1]?.worker_id).toBe('sweep-e2e-b');
  });

  it('fences the completion of a worker that was only slow', async () => {
    const jobId = await insertJob({ key: 'slow', status: 'pending' });

    // Worker A takes 600 ms, much longer than the 100 ms stuck timeout.
    const workerA = startWorker({
      workerId: 'sweep-slow-a',
      concurrency: 1,
      pollIntervalMs: 20,
      backoff: { baseMs: 50, maxMs: 500 },
      sweep: false,
      handler: createStubHandler(600),
      db: workerPool,
    });
    running.push(workerA);

    await expect
      .poll(async () => (await jobRow(jobId)).status, {
        timeout: 10_000,
        interval: 25,
      })
      .toBe('processing');

    // Worker B notices that the job looks stuck, recovers it and finishes it
    // while worker A is still working.
    const workerB = startWorker({
      workerId: 'sweep-slow-b',
      concurrency: 1,
      pollIntervalMs: 20,
      backoff: { baseMs: 50, maxMs: 500 },
      sweep: { stuckTimeoutMs: 100, intervalMs: 50 },
      handler: createStubHandler(0),
      db: workerPool,
    });
    running.push(workerB);

    await expect
      .poll(async () => (await jobRow(jobId)).status, {
        timeout: 20_000,
        interval: 25,
      })
      .toBe('succeeded');

    // Now let the slow worker finish: its completion must affect no row.
    await workerA.stop();
    running.pop();
    await workerB.stop();
    running.pop();

    const job = await jobRow(jobId);
    expect(job.status).toBe('succeeded');
    expect(job.attempts).toBe(1);

    const runs = await runRows(jobId);
    expect(runs.map((run) => run.worker_id)).toEqual([
      'sweep-slow-a',
      'sweep-slow-b',
    ]);
    // The sweep's mark on the abandoned run survives the late completion.
    expect(runs[0]?.outcome).toBe('crashed');
    expect(runs[0]?.error).toBe(
      'Abandoned: worker did not finish; recovered by sweep',
    );
    expect(runs[1]?.outcome).toBe('succeeded');

    // The job's state belongs to the newer run: the claim wrote both the job's
    // and the run's started_at inside one transaction.
    expect(job.started_at?.getTime()).toBe(runs[1]?.started_at.getTime());
  });
});
