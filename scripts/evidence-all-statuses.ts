import { pool } from '../src/db.js';
import { enqueueJob } from '../src/jobs/enqueue.js';
import {
  Evidence,
  PORT,
  REPORT_PAYLOAD,
  SCREENSHOTS,
  check,
  cleanSlate,
  pauseForScreenshot,
  printJobState,
  renderTable,
  sleep,
  startApi,
  startWorker,
  stop,
  timestamp,
  waitFor,
  withChildren,
} from './lib/evidence.js';

/**
 * Evidence: all five job states exist at the same time, produced the real way.
 *
 *   succeeded  - three jobs completed by a normal worker;
 *   dead       - a job with max_attempts=1 run by a worker with FAIL_RATE=1;
 *   failed     - a job that failed once with a 10 minute backoff (waiting);
 *   processing - a job inside a 10 minute handler delay, left running;
 *   pending    - a job whose run_at is one hour in the future.
 *
 * The API stays up while the states are on screen, so /jobs can be opened for
 * the screenshot.
 */

const NAME = 'all-statuses';

const STATUSES = ['pending', 'processing', 'succeeded', 'failed', 'dead'] as const;

const evidence = new Evidence(NAME);

await withChildren(evidence, async (track) => {
  await cleanSlate(evidence);

  const api = await startApi(evidence);
  track(api);

  const enqueueViaApi = async (key: string): Promise<string> => {
    const response = await fetch(`http://127.0.0.1:${PORT}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'sales_report',
        payload: REPORT_PAYLOAD,
        idempotencyKey: key,
      }),
    });
    const body = (await response.json()) as { id?: string };
    if (response.status !== 202 || typeof body.id !== 'string') {
      throw new Error(`enqueue ${key} answered HTTP ${response.status}: ${JSON.stringify(body)}`);
    }
    return body.id;
  };

  // --- succeeded ---------------------------------------------------------
  evidence.log('');
  evidence.log('phase 1: succeeded - a normal worker completes three jobs');

  const workerOk = startWorker(evidence, 'worker-ok', {
    WORKER_ID: 'evidence-status-ok',
    CONCURRENCY: '3',
    POLL_INTERVAL_MS: '100',
  });
  track(workerOk);

  const succeededIds: string[] = [];
  for (let index = 1; index <= 3; index += 1) {
    succeededIds.push(await enqueueViaApi(`evidence-status-succeeded-${index}`));
  }
  await waitFor(
    'the three jobs to succeed',
    async () => {
      const { rows } = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM "jobs"
         WHERE "status" = 'succeeded' AND "idempotency_key" LIKE 'evidence-status-succeeded-%'`,
      );
      return rows[0]?.count === '3' ? true : null;
    },
    120_000,
    200,
  );
  evidence.event(`three jobs succeeded: ${succeededIds.join(', ')}`);
  await stop(evidence, workerOk);

  // --- dead ---------------------------------------------------------------
  evidence.log('');
  evidence.log('phase 2: dead - max_attempts=1 and a worker that always fails');

  const workerDead = startWorker(evidence, 'worker-dead', {
    WORKER_ID: 'evidence-status-dead',
    CONCURRENCY: '1',
    POLL_INTERVAL_MS: '100',
    FAIL_RATE: '1',
    MAX_ATTEMPTS: '1',
  });
  track(workerDead);

  const deadOutcome = await enqueueJob(
    {
      type: 'sales_report',
      payload: REPORT_PAYLOAD,
      idempotencyKey: 'evidence-status-dead',
    },
    { maxAttempts: 1 },
  );
  if (deadOutcome.outcome !== 'created') {
    throw new Error(`expected a new job, got ${deadOutcome.outcome}`);
  }
  const deadId = deadOutcome.id;
  await waitFor(
    'the dead job',
    async () => {
      const { rows } = await pool.query<{ status: string }>(
        'SELECT "status" FROM "jobs" WHERE "id" = $1',
        [deadId],
      );
      return rows[0]?.status === 'dead' ? true : null;
    },
    60_000,
    200,
  );
  evidence.event(`job ${deadId} is dead`);
  await stop(evidence, workerDead);

  // --- failed (waiting for a retry) --------------------------------------
  evidence.log('');
  evidence.log('phase 3: failed - one failure, run_at ten minutes in the future');

  const workerFailed = startWorker(evidence, 'worker-failed', {
    WORKER_ID: 'evidence-status-failed',
    CONCURRENCY: '1',
    POLL_INTERVAL_MS: '100',
    FAIL_RATE: '1',
    BACKOFF_BASE_MS: '600000',
    BACKOFF_MAX_MS: '600000',
  });
  track(workerFailed);

  const failedOutcome = await enqueueJob(
    {
      type: 'sales_report',
      payload: REPORT_PAYLOAD,
      idempotencyKey: 'evidence-status-failed',
    },
    { maxAttempts: 5 },
  );
  if (failedOutcome.outcome !== 'created') {
    throw new Error(`expected a new job, got ${failedOutcome.outcome}`);
  }
  const failedId = failedOutcome.id;
  await waitFor(
    'the job to be failed once',
    async () => {
      const { rows } = await pool.query<{ status: string; attempts: number }>(
        'SELECT "status", "attempts" FROM "jobs" WHERE "id" = $1',
        [failedId],
      );
      return rows[0]?.status === 'failed' && rows[0].attempts === 1 ? true : null;
    },
    60_000,
    200,
  );
  const { rows: failedRows } = await pool.query<{ run_at: Date }>(
    'SELECT "run_at" FROM "jobs" WHERE "id" = $1',
    [failedId],
  );
  evidence.event(`job ${failedId} is failed, run_at=${timestamp(failedRows[0]!.run_at)}`);
  await stop(evidence, workerFailed);

  // --- processing ---------------------------------------------------------
  evidence.log('');
  evidence.log('phase 4: processing - a worker with a ten minute handler delay');

  const workerProcessing = startWorker(evidence, 'worker-processing', {
    WORKER_ID: 'evidence-status-processing',
    CONCURRENCY: '1',
    POLL_INTERVAL_MS: '100',
    WORK_DELAY_MS: '600000',
  });
  track(workerProcessing);

  const processingId = await enqueueViaApi('evidence-status-processing');
  await waitFor(
    'the job to be processing with an open run',
    async () => {
      const { rows } = await pool.query<{ status: string; open_runs: string }>(
        `SELECT j."status",
                (SELECT count(*) FROM "job_runs" r WHERE r."job_id" = j."id" AND r."outcome" IS NULL) AS open_runs
         FROM "jobs" j WHERE j."id" = $1`,
        [processingId],
      );
      return rows[0]?.status === 'processing' && Number(rows[0].open_runs) > 0 ? true : null;
    },
    60_000,
    200,
  );
  evidence.event(`job ${processingId} is processing`);

  // --- pending ------------------------------------------------------------
  evidence.log('');
  evidence.log('phase 5: pending - run_at one hour in the future');

  const { rows: pendingRows } = await pool.query<{ id: string }>(
    `INSERT INTO "jobs" ("type", "payload", "status", "max_attempts", "run_at", "created_at", "updated_at", "idempotency_key")
     VALUES ('sales_report', $1::jsonb, 'pending', 5, now() + interval '1 hour', now(), now(), 'evidence-status-pending')
     RETURNING "id"`,
    [JSON.stringify(REPORT_PAYLOAD)],
  );
  const pendingId = pendingRows[0]!.id;
  evidence.event(`job ${pendingId} is pending, run_at one hour in the future`);

  // --- the five states side by side --------------------------------------
  const counts = await pool.query<{ status: string; count: string }>(
    'SELECT "status", count(*)::text AS count FROM "jobs" GROUP BY 1',
  );
  const countByStatus = new Map(counts.rows.map((row) => [row.status, row.count]));

  evidence.log('');
  evidence.log('counts per status in the jobs table:');
  for (const line of renderTable(
    ['status', 'count'],
    STATUSES.map((status) => [status, countByStatus.get(status) ?? '0']),
  )) {
    evidence.log(line);
  }

  evidence.log('');
  evidence.log('the five jobs:');
  for (const line of renderTable(
    ['status', 'job id', 'note'],
    [
      ['succeeded', succeededIds[0]!, 'first of three'],
      ['dead', deadId, 'max_attempts=1, FAIL_RATE=1'],
      ['failed', failedId, 'BACKOFF_BASE_MS=600000'],
      ['processing', processingId, 'WORK_DELAY_MS=600000, worker left running'],
      ['pending', pendingId, 'run_at = now() + 1 hour'],
    ],
  )) {
    evidence.log(line);
  }

  await printJobState(evidence, pendingId, 'PENDING JOB (inserted with a future run_at)');

  const observed = STATUSES.filter((status) => Number(countByStatus.get(status) ?? '0') > 0);
  check(
    evidence,
    observed.length === STATUSES.length,
    'all five statuses exist at the same time',
    observed.join(', '),
  );

  evidence.log('');
  evidence.log(`the API is still up: http://127.0.0.1:${PORT}/jobs`);
  evidence.log(`dead letter page (should be empty apart from the dead job above): http://127.0.0.1:${PORT}/dead`);
  await pauseForScreenshot(evidence, {
    what: `/jobs with all five statuses - http://127.0.0.1:${PORT}/jobs`,
    url: `http://127.0.0.1:${PORT}/jobs`,
    file: 'all-statuses.png',
  });
  // The dead letter page is captured only in --screenshots mode: the manual
  // --pause flow keeps its single prompt.
  if (SCREENSHOTS) {
    await pauseForScreenshot(evidence, {
      what: `/dead with the dead job's payload, full error and run history - http://127.0.0.1:${PORT}/dead`,
      url: `http://127.0.0.1:${PORT}/dead`,
      file: 'dead-letter.png',
    });
  }

  await sleep(200);
  evidence.log('stopping the processing worker and the API');
});
