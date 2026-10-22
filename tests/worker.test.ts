import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { loadConfig } from '../src/config.js';
import { claimJob } from '../src/worker/claim.js';
import { completeJob } from '../src/worker/complete.js';
import { failJob } from '../src/worker/fail.js';
import { createStubHandler, type JobHandler } from '../src/worker/handler.js';
import { startWorker, type WorkerHandle } from '../src/worker/index.js';

/**
 * Worker tests - they run against the real PostgreSQL database.
 *
 * Start it first: docker compose up -d
 */

const config = loadConfig();

const PAYLOAD = { dateFrom: '2024-01-01', dateTo: '2024-03-31' };

/** A small backoff so the retries happen quickly. */
const BACKOFF = { baseMs: 100, maxMs: 10_000 };

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
  options: { runAt?: Date; maxAttempts?: number } = {},
): Promise<string[]> {
  const { rows } = await workerPool.query<{ id: string }>(
    `
    INSERT INTO jobs (type, payload, status, max_attempts, run_at, created_at, updated_at, idempotency_key)
    SELECT 'sales_report', $1::jsonb, 'pending', $4, $2, now(), now(), $3 || '-' || i
    FROM generate_series(1, $5) AS g(i)
    RETURNING id
    `,
    [
      JSON.stringify(PAYLOAD),
      options.runAt ?? new Date(),
      `worker-test-${prefix}`,
      options.maxAttempts ?? 5,
      count,
    ],
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
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${description}`);
}

interface JobState {
  id: string;
  status: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  run_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

async function jobStates(ids: string[]): Promise<JobState[]> {
  const { rows } = await workerPool.query<JobState>(
    `SELECT id, status, attempts, max_attempts, last_error, run_at, started_at, finished_at
     FROM jobs WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return rows;
}

/** The concurrency counts that were logged. */
function observedConcurrency(): number[] {
  return logLines
    .map((line) => /concurrent=(\d+)/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]));
}

async function runRows(jobId: string): Promise<{ outcome: string; error: string | null; started_at: Date }[]> {
  const { rows } = await workerPool.query<{
    outcome: string;
    error: string | null;
    started_at: Date;
  }>(
    `SELECT outcome, error, started_at FROM job_runs WHERE job_id = $1 ORDER BY started_at`,
    [jobId],
  );
  return rows;
}

describe('worker loop', () => {
  it('never exceeds the concurrency cap and reaches it', async () => {
    captureLogs();
    const ids = await insertJobs(20, 'concurrency');

    const worker = startWorker({
      workerId: 'worker-concurrency',
      concurrency: 3,
      pollIntervalMs: 50,
      handler: createStubHandler(300),
      backoff: BACKOFF,
      db: workerPool,
    });
    running.push(worker);

    await waitFor(
      async () => (await jobStates(ids)).every((job) => job.status === 'succeeded'),
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

    const states = await jobStates(ids);
    expect(states).toHaveLength(20);
    expect(states.every((job) => job.status === 'succeeded')).toBe(true);

    // Exactly one execution record per job.
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
      handler: createStubHandler(40),
      backoff: BACKOFF,
      db: workerPool,
    });
    const workerB = startWorker({
      workerId: 'worker-b',
      concurrency: 3,
      pollIntervalMs: 20,
      handler: createStubHandler(40),
      backoff: BACKOFF,
      db: workerPool,
    });
    running.push(workerA, workerB);

    await waitFor(
      async () => (await jobStates(ids)).every((job) => job.status === 'succeeded'),
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
      handler: createStubHandler(700),
      backoff: BACKOFF,
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

    const states = await jobStates(ids);
    const succeeded = states.filter((job) => job.status === 'succeeded');
    const pending = states.filter((job) => job.status === 'pending');

    // The jobs that were running finished, the untouched ones stay pending.
    expect(succeeded.length).toBe(2);
    expect(pending.length).toBe(2);

    // No job was left in 'processing'.
    expect(states.every((job) => job.status !== 'processing')).toBe(true);
  });

  it('does not claim a job before its run_at', async () => {
    captureLogs();
    const runAt = new Date(Date.now() + 2_000);
    const ids = await insertJobs(1, 'future', { runAt });

    const worker = startWorker({
      workerId: 'worker-future',
      concurrency: 3,
      pollIntervalMs: 50,
      handler: createStubHandler(0),
      backoff: BACKOFF,
      db: workerPool,
    });
    running.push(worker);

    // Give the worker plenty of chances to (wrongly) claim it early.
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    expect((await jobStates(ids))[0]?.status).toBe('pending');
    expect((await runRows(ids[0]!)).length).toBe(0);

    // Once run_at has passed, the job is picked up.
    await waitFor(
      async () => (await jobStates(ids)).every((job) => job.status === 'succeeded'),
      20_000,
      'the deferred job to succeed',
    );
    await worker.stop();
    running.pop();

    expect((await runRows(ids[0]!)).length).toBe(1);
  });
});

describe('retries and the dead state', () => {
  it('retries a failing job with growing delays until it dies', async () => {
    captureLogs();
    const ids = await insertJobs(1, 'retry', { maxAttempts: 3 });

    const worker = startWorker({
      workerId: 'worker-retry',
      concurrency: 1,
      pollIntervalMs: 20,
      handler: createStubHandler(0, 1),
      backoff: { baseMs: 100, maxMs: 10_000 },
      db: workerPool,
    });
    running.push(worker);

    // The first failure leaves the job 'failed' and waiting for its retry.
    await waitFor(
      async () => (await jobStates(ids))[0]?.status === 'failed',
      10_000,
      'the first failure',
    );
    const afterFirstFailure = (await jobStates(ids))[0]!;
    expect(afterFirstFailure.attempts).toBe(1);
    // finished_at is only set when the job is done for good.
    expect(afterFirstFailure.finished_at).toBeNull();
    expect(afterFirstFailure.last_error).toBe('Injected failure (FAIL_RATE=1)');

    // The retries exhaust the attempt budget and the job dies.
    await waitFor(
      async () => (await jobStates(ids))[0]?.status === 'dead',
      20_000,
      'the job to die',
    );

    const dead = (await jobStates(ids))[0]!;
    expect(dead.attempts).toBe(3);
    expect(dead.max_attempts).toBe(3);
    expect(dead.finished_at).not.toBeNull();

    // Three attempts, all of them failed.
    const runs = await runRows(ids[0]!);
    expect(runs.length).toBe(3);
    expect(runs.every((run) => run.outcome === 'failed')).toBe(true);

    // The gaps between the attempts grow with the backoff.
    const gaps = runs
      .slice(1)
      .map((run, index) => run.started_at.getTime() - runs[index]!.started_at.getTime());
    expect(gaps.length).toBe(2);
    expect(gaps[1]!).toBeGreaterThan(gaps[0]!);

    // A dead job is never claimed again. The largest delay used for this
    // job was 200ms (the second retry), so wait twice that.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect((await runRows(ids[0]!)).length).toBe(3);
    expect((await jobStates(ids))[0]?.status).toBe('dead');
    expect((await jobStates(ids))[0]?.attempts).toBe(3);

    await worker.stop();
    running.pop();
  });

  it('succeeds when a job fails once and then works', async () => {
    captureLogs();
    const ids = await insertJobs(1, 'flaky', { maxAttempts: 5 });

    let calls = 0;
    const handler: JobHandler = async () => {
      calls += 1;
      if (calls === 1) throw new Error('first attempt fails');
    };

    const worker = startWorker({
      workerId: 'worker-flaky',
      concurrency: 1,
      pollIntervalMs: 20,
      handler,
      backoff: { baseMs: 50, maxMs: 1_000 },
      db: workerPool,
    });
    running.push(worker);

    await waitFor(
      async () => (await jobStates(ids))[0]?.status === 'succeeded',
      20_000,
      'the job to succeed on the second attempt',
    );
    await worker.stop();
    running.pop();

    const state = (await jobStates(ids))[0]!;
    expect(state.status).toBe('succeeded');
    expect(state.attempts).toBe(1);

    const runs = await runRows(ids[0]!);
    expect(runs.length).toBe(2);
    expect(runs.map((run) => run.outcome)).toEqual(['failed', 'succeeded']);
  });

  it('keeps the most recent failure message in last_error', async () => {
    captureLogs();
    const ids = await insertJobs(1, 'last-error', { maxAttempts: 5 });

    let calls = 0;
    const handler: JobHandler = async () => {
      calls += 1;
      throw new Error(`failure number ${calls}`);
    };

    const worker = startWorker({
      workerId: 'worker-last-error',
      concurrency: 1,
      pollIntervalMs: 20,
      handler,
      backoff: { baseMs: 100, maxMs: 10_000 },
      db: workerPool,
    });
    running.push(worker);

    await waitFor(
      async () => (await jobStates(ids))[0]?.last_error === 'failure number 1',
      10_000,
      'the first failure message',
    );
    await waitFor(
      async () => (await jobStates(ids))[0]?.last_error === 'failure number 2',
      10_000,
      'the second failure message',
    );

    await worker.stop();
    running.pop();

    const state = (await jobStates(ids))[0]!;
    expect(state.last_error).toBe('failure number 2');
    const runs = await runRows(ids[0]!);
    expect(runs[1]?.error).toBe('failure number 2');
  });

  it('does not leak a concurrency slot when jobs fail', async () => {
    captureLogs();
    const ids = await insertJobs(10, 'leak', { maxAttempts: 2 });

    const worker = startWorker({
      workerId: 'worker-leak',
      concurrency: 2,
      pollIntervalMs: 20,
      handler: createStubHandler(0, 1),
      backoff: { baseMs: 50, maxMs: 500 },
      db: workerPool,
    });
    running.push(worker);

    let maxActive = 0;
    const sampler = setInterval(() => {
      maxActive = Math.max(maxActive, worker.activeCount());
    }, 10);

    await waitFor(
      async () => (await jobStates(ids)).every((job) => job.status === 'dead'),
      30_000,
      'all 10 jobs to die',
    );
    clearInterval(sampler);

    await worker.stop();
    running.pop();

    // The cap was never exceeded...
    expect(maxActive).toBeLessThanOrEqual(2);
    const observed = observedConcurrency();
    expect(observed.length).toBeGreaterThan(0);
    expect(Math.max(...observed)).toBeLessThanOrEqual(2);

    // ...and the counter returned to zero instead of leaking slots.
    expect(worker.activeCount()).toBe(0);
  });

  it('refuses to record a failure when the claim was lost', async () => {
    const ids = await insertJobs(1, 'fenced-failure');

    const claimed = await claimJob(workerPool, 'worker-fenced-failure');
    expect(claimed).not.toBeNull();
    if (!claimed) return;

    // Reset the job behind the worker's back: new started_at, back to
    // 'pending' - the claim token no longer matches.
    await workerPool.query(
      `UPDATE jobs SET status = 'pending', started_at = now(), updated_at = now() WHERE id = $1`,
      [claimed.id],
    );

    // The fenced statement must affect zero rows.
    const { rowCount } = await workerPool.query(
      `UPDATE jobs
       SET attempts = attempts + 1, last_error = $3, status = 'failed', updated_at = now()
       WHERE id = $1 AND status = 'processing' AND started_at = $2`,
      [claimed.id, claimed.startedAt, 'boom'],
    );
    expect(rowCount).toBe(0);

    const outcome = await failJob(workerPool, claimed, 'boom', 100);
    expect(outcome.updated).toBe(false);

    // The job row is untouched.
    const state = (await jobStates(ids))[0]!;
    expect(state.status).toBe('pending');
    expect(state.attempts).toBe(0);
    expect(state.last_error).toBeNull();

    // The execution record is closed as crashed.
    const { rows: runs } = await workerPool.query<{ outcome: string }>(
      'SELECT outcome FROM job_runs WHERE id = $1',
      [claimed.runId],
    );
    expect(runs[0]?.outcome).toBe('crashed');
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

    expect((await jobStates(ids))[0]?.status).toBe('pending');

    const { rows: runs } = await workerPool.query<{ outcome: string }>(
      'SELECT outcome FROM job_runs WHERE id = $1',
      [claimed.runId],
    );
    expect(runs[0]?.outcome).toBe('crashed');
  });
});
