import { pool } from '../src/db.js';
import { enqueueJob } from '../src/jobs/enqueue.js';
import {
  Evidence,
  REPORT_PAYLOAD,
  check,
  cleanSlate,
  readLog,
  renderTable,
  startWorker,
  stop,
  timestamp,
  waitFor,
  waitForLogLine,
  withChildren,
} from './lib/evidence.js';

/**
 * Evidence: the retry schedule is exponential with jitter, bounded by
 * MAX_ATTEMPTS, and the job ends up dead.
 *
 * One worker is forced to fail every attempt (FAIL_RATE=1). The gaps between
 * the recorded start times must sit inside
 *   [base * 2^(n-1), 1.5 * base * 2^(n-1) + poll slack].
 * The lower bound is the nominal delay, the upper bound is the maximum jitter
 * (50% of the nominal part) plus the time the worker needs to poll and claim.
 */

const NAME = 'backoff';
const BASE_MS = 2_000;
const MAX_ATTEMPTS = 5;
const POLL_INTERVAL_MS = 250;
/** Claim + scheduling headroom on top of the jitter window. */
const POLL_SLACK_MS = 1_500;

const evidence = new Evidence(NAME);

await withChildren(evidence, async (track) => {
  await cleanSlate(evidence);

  const worker = startWorker(evidence, 'worker', {
    WORKER_ID: 'evidence-backoff',
    CONCURRENCY: '1',
    POLL_INTERVAL_MS: String(POLL_INTERVAL_MS),
    FAIL_RATE: '1',
    BACKOFF_BASE_MS: String(BASE_MS),
    MAX_ATTEMPTS: String(MAX_ATTEMPTS),
  });
  track(worker);

  const outcome = await enqueueJob(
    {
      type: 'sales_report',
      payload: REPORT_PAYLOAD,
      idempotencyKey: 'evidence-backoff',
    },
    { maxAttempts: MAX_ATTEMPTS },
  );
  if (outcome.outcome !== 'created') {
    throw new Error(`expected a new job, got ${outcome.outcome}`);
  }
  const jobId = outcome.id;
  evidence.event(`enqueued job ${jobId}`);

  await waitFor(
    'the job to become dead',
    async () => {
      const { rows } = await pool.query<{ status: string }>(
        'SELECT "status" FROM "jobs" WHERE "id" = $1',
        [jobId],
      );
      return rows[0]?.status === 'dead' ? true : null;
    },
    180_000,
    200,
  );
  await waitForLogLine(worker, /is DEAD after/, 10_000);

  const { rows: runs } = await pool.query<{
    started_at: Date;
    finished_at: Date | null;
    outcome: string | null;
  }>(
    `SELECT "started_at", "finished_at", "outcome"
     FROM "job_runs" WHERE "job_id" = $1 ORDER BY "started_at", "id"`,
    [jobId],
  );

  const retryPattern =
    /job ([0-9a-f-]{36}) failed \(attempt (\d+)\/(\d+)\):.*\| retry in (\d+)ms at ([0-9T:.Z-]+)/;
  const retries = new Map<number, { delayMs: number; at: string }>();
  const log = readLog(worker);
  for (const line of log.split(/\r?\n/)) {
    const match = retryPattern.exec(line);
    if (match) {
      retries.set(Number(match[2]), {
        delayMs: Number(match[4]),
        at: match[5]!,
      });
    }
  }

  evidence.log('');
  evidence.log(`job ${jobId}`);
  evidence.log(`worker log: ${worker.logPath}`);
  evidence.log('');

  const rows: string[][] = [];
  const windowChecks: string[] = [];
  let windowsOk = true;

  for (let attempt = 1; attempt <= runs.length; attempt += 1) {
    const run = runs[attempt - 1]!;
    const started = run.started_at.getTime();
    const previous = attempt > 1 ? runs[attempt - 2]!.started_at.getTime() : null;
    const gap = previous === null ? null : started - previous;
    const exponential = attempt > 1 ? BASE_MS * 2 ** (attempt - 2) : null;
    const retry = retries.get(attempt);

    rows.push([
      String(attempt),
      timestamp(run.started_at),
      retry ? `${retry.at} (+${retry.delayMs}ms)` : '(none, last attempt)',
      gap === null ? '-' : `${gap} ms`,
      exponential === null ? '-' : `${exponential} ms`,
      exponential === null ? '-' : `${exponential}..${Math.round(exponential * 1.5) + POLL_SLACK_MS} ms`,
    ]);

    if (gap !== null && exponential !== null) {
      const low = exponential;
      const high = Math.round(exponential * 1.5) + POLL_SLACK_MS;
      const ok = gap >= low && gap <= high;
      if (!ok) windowsOk = false;
      // The retry that led to this attempt was logged after the previous one.
      const previousRetry = retries.get(attempt - 1);
      windowChecks.push(
        `  attempt ${attempt}: gap=${gap}ms in [${low}, ${high}]  ${ok ? 'PASS' : 'FAIL'}` +
          (previousRetry
            ? `  (previous attempt logged retry in ${previousRetry.delayMs}ms, jitter=${previousRetry.delayMs - exponential}ms, at most ${Math.round(exponential * 0.5)}ms)`
            : ''),
      );
    }
  }

  for (const line of renderTable(
    ['attempt', 'started_at', 'scheduled retry (worker log)', 'gap since previous start', 'exponential part', 'jitter window'],
    rows,
  )) {
    evidence.log(line);
  }

  evidence.log('');
  evidence.log('jitter window check (nominal delay <= gap <= 1.5x nominal + poll slack):');
  for (const line of windowChecks) evidence.log(line);
  check(evidence, windowsOk, 'every gap lies inside its jitter window');
  check(
    evidence,
    runs.length === MAX_ATTEMPTS,
    `the job ran exactly ${MAX_ATTEMPTS} times`,
    `saw ${runs.length}`,
  );

  const job = await pool.query<{
    status: string;
    attempts: number;
    max_attempts: number;
    last_error: string | null;
    finished_at: Date | null;
  }>(
    'SELECT "status", "attempts", "max_attempts", "last_error", "finished_at" FROM "jobs" WHERE "id" = $1',
    [jobId],
  );
  const final = job.rows[0]!;
  evidence.log('');
  evidence.log(
    `attempts=${final.attempts}/${final.max_attempts} finished_at=${timestamp(final.finished_at)} last_error=${final.last_error}`,
  );

  // Stop the worker before the closing line so the evidence ends on the state.
  await stop(evidence, worker);
  evidence.log(`status=${final.status}`);
});
