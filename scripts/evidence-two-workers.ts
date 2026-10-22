import { pool } from '../src/db.js';
import { enqueueJob } from '../src/jobs/enqueue.js';
import {
  Evidence,
  REPORT_PAYLOAD,
  check,
  cleanSlate,
  readLog,
  renderTable,
  scalar,
  startWorker,
  waitFor,
  withChildren,
} from './lib/evidence.js';

/**
 * Evidence: two workers never process the same job.
 *
 * 100 jobs are queued while two workers (CONCURRENCY=3 each) are polling. The
 * claim is a single `UPDATE ... FOR UPDATE SKIP LOCKED RETURNING`, so no job
 * can be handed out twice. `job_runs` is the proof: one run per job, none with
 * two.
 */

const NAME = 'two-workers';
const JOB_COUNT = 100;
const CONCURRENCY = 3;

/** The largest `concurrent=` value in a worker log. */
function maxConcurrent(log: string): number {
  const values = [...log.matchAll(/\| concurrent=(\d+)/g)].map((match) =>
    Number(match[1]),
  );
  return values.length === 0 ? 0 : Math.max(...values);
}

const evidence = new Evidence(NAME);

await withChildren(evidence, async (track) => {
  await cleanSlate(evidence);

  const workerA = startWorker(evidence, 'worker-a', {
    WORKER_ID: 'worker-a',
    CONCURRENCY: String(CONCURRENCY),
    POLL_INTERVAL_MS: '100',
  });
  const workerB = startWorker(evidence, 'worker-b', {
    WORKER_ID: 'worker-b',
    CONCURRENCY: String(CONCURRENCY),
    POLL_INTERVAL_MS: '100',
  });
  track(workerA);
  track(workerB);

  evidence.log('');
  evidence.log(`enqueuing ${JOB_COUNT} jobs while both workers poll`);
  const enqueueStarted = performance.now();
  const outcomes = await Promise.all(
    Array.from({ length: JOB_COUNT }, (_, index) =>
      enqueueJob(
        {
          type: 'sales_report',
          payload: REPORT_PAYLOAD,
          idempotencyKey: `evidence-two-workers-${index}`,
        },
        { maxAttempts: 5 },
      ),
    ),
  );
  check(
    evidence,
    outcomes.every((outcome) => outcome.outcome === 'created'),
    `all ${JOB_COUNT} enqueues created a new job`,
  );
  evidence.log(
    `enqueued ${outcomes.length} jobs in ${(performance.now() - enqueueStarted).toFixed(1)}ms`,
  );

  await waitFor(
    `${JOB_COUNT} succeeded jobs`,
    async () => {
      const count = await scalar(
        `SELECT count(*) FROM "jobs" WHERE "status" = 'succeeded' AND "idempotency_key" LIKE 'evidence-two-workers-%'`,
      );
      return count === JOB_COUNT ? count : null;
    },
    300_000,
    500,
  );
  evidence.event(`all ${JOB_COUNT} jobs succeeded`);

  const totalRuns = await scalar('SELECT count(*) FROM "job_runs"');
  const distinctJobs = await scalar('SELECT count(DISTINCT "job_id") FROM "job_runs"');
  const doubleClaimed = await pool.query<{ job_id: string; runs: number }>(
    `SELECT "job_id", count(*)::int AS runs
     FROM "job_runs" GROUP BY 1 HAVING count(*) > 1 ORDER BY 1`,
  );
  const perWorker = await pool.query<{
    worker_id: string;
    runs: string;
    jobs: string;
  }>(
    `SELECT "worker_id",
            count(*)::text AS runs,
            count(DISTINCT "job_id")::text AS jobs
     FROM "job_runs" GROUP BY 1 ORDER BY 1`,
  );

  const maxByWorker = new Map<string, number>([
    ['worker-a', maxConcurrent(readLog(workerA))],
    ['worker-b', maxConcurrent(readLog(workerB))],
  ]);

  evidence.log('');
  evidence.log(`total job_runs: ${totalRuns}`);
  evidence.log(`distinct jobs in job_runs: ${distinctJobs}`);
  evidence.log(`jobs with more than one run: ${doubleClaimed.rowCount}`);
  for (const row of doubleClaimed.rows) {
    evidence.log(`  DOUBLE CLAIM ${row.job_id} runs=${row.runs}`);
  }
  evidence.log('');
  evidence.log('per worker:');
  for (const line of renderTable(
    ['worker', 'runs', 'distinct jobs', 'max concurrent'],
    perWorker.rows.map((row) => [
      row.worker_id,
      row.runs,
      row.jobs,
      String(maxByWorker.get(row.worker_id) ?? 0),
    ]),
  )) {
    evidence.log(line);
  }

  check(
    evidence,
    doubleClaimed.rowCount === 0,
    'no job has more than one run',
    String(doubleClaimed.rowCount),
  );
  check(
    evidence,
    totalRuns === JOB_COUNT && distinctJobs === JOB_COUNT,
    'one run per job',
    `runs=${totalRuns} jobs=${distinctJobs}`,
  );
  check(
    evidence,
    perWorker.rows.every(
      (row) => (maxByWorker.get(row.worker_id) ?? 0) <= CONCURRENCY,
    ),
    `each worker stayed at or below CONCURRENCY=${CONCURRENCY}`,
  );
});
