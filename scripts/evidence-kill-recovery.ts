import { pool } from '../src/db.js';
import {
  Evidence,
  PORT,
  REPORT_PAYLOAD,
  check,
  cleanSlate,
  pauseForScreenshot,
  printJobState,
  sigkill,
  sleep,
  startApi,
  startWorker,
  timestamp,
  waitFor,
  waitForLogLine,
  withChildren,
} from './lib/evidence.js';

/**
 * Evidence: a killed worker leaves the job `processing` with an open run, and
 * the sweep in the next worker recovers it exactly once.
 *
 * Worker A sleeps 20s inside the handler, so it can be killed while the job is
 * genuinely in flight. A job older than STUCK_TIMEOUT_MS (8s) is recovered by
 * worker B at startup, which closes the abandoned run as `crashed` and puts the
 * job back in the queue.
 */

const NAME = 'kill-recovery';
const STUCK_TIMEOUT_MS = 8_000;
const SWEEP_INTERVAL_MS = 1_000;

const evidence = new Evidence(NAME);

await withChildren(evidence, async (track) => {
  await cleanSlate(evidence);

  const api = await startApi(evidence);
  track(api);

  const workerA = startWorker(evidence, 'worker-a', {
    WORKER_ID: 'evidence-kill-a',
    CONCURRENCY: '1',
    POLL_INTERVAL_MS: '100',
    WORK_DELAY_MS: '20000',
    STUCK_TIMEOUT_MS: String(STUCK_TIMEOUT_MS),
    SWEEP_INTERVAL_MS: String(SWEEP_INTERVAL_MS),
  });
  track(workerA);

  const response = await fetch(`http://127.0.0.1:${PORT}/api/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'sales_report',
      payload: REPORT_PAYLOAD,
      idempotencyKey: 'evidence-kill-recovery',
    }),
  });
  const body = (await response.json()) as { id?: string };
  check(evidence, response.status === 202 && typeof body.id === 'string', 'the API accepted the job with 202', `HTTP ${response.status}`);
  const jobId = body.id!;
  evidence.event(`enqueued job ${jobId}`);

  await waitFor(
    'the job to be processing with an open run',
    async () => {
      const { rows } = await pool.query<{ status: string; open_runs: string }>(
        `SELECT j."status",
                (SELECT count(*) FROM "job_runs" r WHERE r."job_id" = j."id" AND r."outcome" IS NULL) AS open_runs
         FROM "jobs" j WHERE j."id" = $1`,
        [jobId],
      );
      const row = rows[0];
      return row?.status === 'processing' && Number(row.open_runs) > 0 ? true : null;
    },
    30_000,
    100,
  );

  evidence.log('');
  await printJobState(evidence, jobId, 'BEFORE KILL (worker A is inside the 20s handler delay)');
  evidence.log('');
  evidence.log(`the API is still up: http://127.0.0.1:${PORT}/jobs`);
  await pauseForScreenshot(evidence, {
    what: `/jobs with the job processing (blue) and one open run - http://127.0.0.1:${PORT}/jobs`,
    url: `http://127.0.0.1:${PORT}/jobs`,
    file: 'kill-1-before.png',
  });

  evidence.log('');
  await sigkill(evidence, workerA);
  await sleep(500);

  await printJobState(evidence, jobId, 'AFTER KILL (worker A is gone; nothing has swept yet)');
  await pauseForScreenshot(evidence, {
    what: `/jobs still shows the job as processing and the run is still open - http://127.0.0.1:${PORT}/jobs`,
    url: `http://127.0.0.1:${PORT}/jobs`,
    file: 'kill-2-after-kill.png',
  });

  // Worker B must only recover the job once it is older than the stuck timeout.
  const stuckSinceStart = await waitFor(
    'the job to be older than STUCK_TIMEOUT_MS',
    async () => {
      const { rows } = await pool.query<{ started_at: Date }>(
        'SELECT "started_at" FROM "jobs" WHERE "id" = $1',
        [jobId],
      );
      const startedAt = rows[0]?.started_at;
      if (!startedAt) return null;
      const ageMs = Date.now() - startedAt.getTime();
      if (ageMs < STUCK_TIMEOUT_MS + 500) return null;
      evidence.event(
        `job started_at=${timestamp(startedAt)} is ${ageMs}ms old (stuck timeout ${STUCK_TIMEOUT_MS}ms)`,
      );
      return ageMs;
    },
    30_000,
    250,
  );
  evidence.log(`job age at recovery: ${stuckSinceStart}ms`);

  const workerB = startWorker(evidence, 'worker-b', {
    WORKER_ID: 'evidence-kill-b',
    CONCURRENCY: '1',
    POLL_INTERVAL_MS: '100',
    WORK_DELAY_MS: '0',
    STUCK_TIMEOUT_MS: String(STUCK_TIMEOUT_MS),
    SWEEP_INTERVAL_MS: String(SWEEP_INTERVAL_MS),
  });
  track(workerB);

  const sweepLine = await waitForLogLine(workerB, /sweep recovered/, 20_000);
  evidence.log('');
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

  await printJobState(evidence, jobId, 'AFTER RECOVERY');
  await waitForLogLine(workerB, /\] finished /, 10_000);

  const { rows: runs } = await pool.query<{ outcome: string | null; error: string | null }>(
    'SELECT "outcome", "error" FROM "job_runs" WHERE "job_id" = $1 ORDER BY "started_at", "id"',
    [jobId],
  );
  const { rows: jobRows } = await pool.query<{ attempts: number; status: string }>(
    'SELECT "attempts", "status" FROM "jobs" WHERE "id" = $1',
    [jobId],
  );
  const reportRows = await pool.query(
    'SELECT 1 FROM "reports" WHERE "job_id" = $1',
    [jobId],
  );

  evidence.log('');
  check(evidence, jobRows[0]?.status === 'succeeded', 'the job is succeeded', jobRows[0]?.status);
  check(evidence, jobRows[0]?.attempts === 1, 'attempts=1 (the abandoned run counted once)', String(jobRows[0]?.attempts));
  check(evidence, reportRows.rowCount === 1, 'exactly one report row', String(reportRows.rowCount));
  check(
    evidence,
    runs.length === 2 && runs[0]?.outcome === 'crashed' && runs[1]?.outcome === 'succeeded',
    'job_runs shows crashed then succeeded',
    runs.map((run) => run.outcome ?? 'null').join(', '),
  );
  evidence.log(`crash error: ${runs[0]?.error ?? 'null'}`);

  await pauseForScreenshot(evidence, {
    what: `/dead should still be empty and /jobs shows the job succeeded with 2 runs - http://127.0.0.1:${PORT}/jobs`,
    url: `http://127.0.0.1:${PORT}/jobs`,
    file: 'kill-3-after-recovery.png',
  });
});
