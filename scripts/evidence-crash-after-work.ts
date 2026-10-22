import { pool } from '../src/db.js';
import { enqueueJob } from '../src/jobs/enqueue.js';
import {
  Evidence,
  REPORT_PAYLOAD,
  check,
  cleanSlate,
  printJobState,
  readLog,
  sleep,
  startWorker,
  waitExit,
  waitFor,
  waitForLogLine,
  withChildren,
} from './lib/evidence.js';

/**
 * Evidence: a crash after the work was saved does not repeat the work.
 *
 * Worker A has CRASH_AFTER_WORK=true, so it exits with code 1 after the report
 * row is written and before the job is marked succeeded. The job stays
 * `processing` with an open run. Worker B sweeps it, finds the report, and the
 * handler stops at the idempotency check: the aggregation appears exactly once
 * in both logs together.
 */

const NAME = 'crash-after-work';

const evidence = new Evidence(NAME);

await withChildren(evidence, async (track) => {
  await cleanSlate(evidence);

  const workerA = startWorker(evidence, 'worker-a', {
    WORKER_ID: 'evidence-crash-a',
    CONCURRENCY: '1',
    POLL_INTERVAL_MS: '100',
    CRASH_AFTER_WORK: 'true',
  });
  track(workerA);

  const outcome = await enqueueJob(
    {
      type: 'sales_report',
      payload: REPORT_PAYLOAD,
      idempotencyKey: 'evidence-crash-after-work',
    },
    { maxAttempts: 5 },
  );
  if (outcome.outcome !== 'created') {
    throw new Error(`expected a new job, got ${outcome.outcome}`);
  }
  const jobId = outcome.id;
  evidence.event(`enqueued job ${jobId}`);

  const exitCode = await waitExit(workerA, 120_000);
  evidence.event(`worker A exited with code ${exitCode}`);
  check(evidence, exitCode !== 0, 'worker A crashed with a non-zero exit code', String(exitCode));
  await sleep(300);

  await printJobState(
    evidence,
    jobId,
    'AFTER THE CRASH (the report exists, the job is still processing, the run is open)',
  );

  const reports = await pool.query(
    'SELECT "id" FROM "reports" WHERE "job_id" = $1',
    [jobId],
  );
  check(evidence, reports.rowCount === 1, 'the report row was written before the crash', String(reports.rowCount));

  evidence.log('');
  evidence.log('worker A log lines:');
  for (const line of readLog(workerA)
    .split(/\r?\n/)
    .filter((line) => /\[handler\]|crashed|\[exit\]/.test(line))) {
    evidence.log(`  ${line}`);
  }

  evidence.log('');
  evidence.log('starting a normal worker to recover the crashed job');
  const workerB = startWorker(evidence, 'worker-b', {
    WORKER_ID: 'evidence-crash-b',
    CONCURRENCY: '1',
    POLL_INTERVAL_MS: '100',
    WORK_DELAY_MS: '0',
    STUCK_TIMEOUT_MS: '3000',
    SWEEP_INTERVAL_MS: '500',
  });
  track(workerB);

  const sweepLine = await waitForLogLine(workerB, /sweep recovered/, 30_000);
  evidence.log('sweep log line (verbatim, with the capture timestamp):');
  evidence.log(`  ${sweepLine}`);

  await waitFor(
    'the recovered job to succeed',
    async () => {
      const { rows } = await pool.query<{ status: string }>(
        'SELECT "status" FROM "jobs" WHERE "id" = $1',
        [jobId],
      );
      return rows[0]?.status === 'succeeded' ? true : null;
    },
    120_000,
    200,
  );

  const skipLine = await waitForLogLine(workerB, /already exists, skipping/, 10_000);
  evidence.log('worker B log line (verbatim):');
  evidence.log(`  ${skipLine}`);

  await printJobState(evidence, jobId, 'FINAL STATE');

  const { rows: jobRows } = await pool.query<{ attempts: number; status: string }>(
    'SELECT "attempts", "status" FROM "jobs" WHERE "id" = $1',
    [jobId],
  );
  const { rows: runs } = await pool.query<{ outcome: string | null }>(
    'SELECT "outcome" FROM "job_runs" WHERE "job_id" = $1 ORDER BY "started_at", "id"',
    [jobId],
  );
  const reportRows = await pool.query(
    'SELECT "id" FROM "reports" WHERE "job_id" = $1',
    [jobId],
  );
  const aggregationLines = [...readLog(workerA).split(/\r?\n/), ...readLog(workerB).split(/\r?\n/)].filter(
    (line) => line.includes('[handler] aggregation for job'),
  );

  evidence.log('');
  evidence.log(`reports rows: ${reportRows.rowCount}`);
  evidence.log(
    `aggregation log lines across both workers: ${aggregationLines.length}` +
      (aggregationLines.length > 0 ? ` -> ${aggregationLines.map((line) => line.trim()).join(' | ')}` : ''),
  );

  check(evidence, jobRows[0]?.status === 'succeeded', 'the job is succeeded', jobRows[0]?.status);
  check(evidence, jobRows[0]?.attempts === 1, 'attempts=1 (the crashed run counted once)', String(jobRows[0]?.attempts));
  check(evidence, reportRows.rowCount === 1, 'exactly one report row', String(reportRows.rowCount));
  check(
    evidence,
    runs.length === 2 && runs[0]?.outcome === 'crashed' && runs[1]?.outcome === 'succeeded',
    'job_runs shows crashed then succeeded',
    runs.map((run) => run.outcome ?? 'null').join(', '),
  );
  check(
    evidence,
    aggregationLines.length === 1,
    'the aggregation ran exactly once',
    String(aggregationLines.length),
  );
});
