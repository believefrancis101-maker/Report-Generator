import {
  Evidence,
  PORT,
  REPORT_PAYLOAD,
  check,
  cleanSlate,
  histogram,
  readLog,
  renderTable,
  scalar,
  startApi,
  startWorker,
  waitFor,
  withChildren,
} from './lib/evidence.js';

/**
 * Evidence: enqueue is fast, and the worker never exceeds CONCURRENCY.
 *
 * 50 jobs are POSTed at the same time (all requests in flight together) while
 * one worker with CONCURRENCY=3 drains the queue. The response time of every
 * POST proves the API only inserts a row; the worker log proves the cap.
 */

const NAME = 'concurrency';
const JOB_COUNT = 50;
const CONCURRENCY = 3;

const evidence = new Evidence(NAME);

await withChildren(evidence, async (track) => {
  await cleanSlate(evidence);

  const api = await startApi(evidence);
  track(api);

  const worker = startWorker(evidence, 'worker', {
    WORKER_ID: 'evidence-concurrency',
    CONCURRENCY: String(CONCURRENCY),
    POLL_INTERVAL_MS: '100',
  });
  track(worker);

  evidence.log('');
  evidence.log(
    `POSTing ${JOB_COUNT} distinct sales_report jobs concurrently (distinct idempotency keys, payload ${REPORT_PAYLOAD.dateFrom}..${REPORT_PAYLOAD.dateTo}).`,
  );

  const startedAll = performance.now();
  const responses = await Promise.all(
    Array.from({ length: JOB_COUNT }, (_, index) => {
      const started = performance.now();
      return fetch(`http://127.0.0.1:${PORT}/api/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'sales_report',
          payload: REPORT_PAYLOAD,
          idempotencyKey: `evidence-concurrency-${index + 1}`,
        }),
      }).then(async (response) => ({
        index: index + 1,
        status: response.status,
        ms: performance.now() - started,
        body: (await response.json()) as { id?: string },
      }));
    }),
  );
  const enqueueWallMs = performance.now() - startedAll;

  const table = renderTable(
    ['#', 'HTTP', 'response time', 'job id'],
    responses.map((response) => [
      String(response.index),
      String(response.status),
      `${response.ms.toFixed(1)} ms`,
      response.body.id ?? '(none)',
    ]),
  );
  for (const line of table) evidence.log(line);

  const times = responses.map((response) => response.ms);
  evidence.log('');
  evidence.log(
    `enqueue: ${responses.length} requests, wall=${enqueueWallMs.toFixed(1)}ms, ` +
      `min=${Math.min(...times).toFixed(1)}ms, mean=${(times.reduce((a, b) => a + b, 0) / times.length).toFixed(1)}ms, max=${Math.max(...times).toFixed(1)}ms`,
  );

  const statuses = new Set(responses.map((response) => response.status));
  check(
    evidence,
    statuses.size === 1 && statuses.has(202),
    'every POST answered 202 Accepted',
    [...statuses].join(', '),
  );

  const acceptedAt = Date.now();
  const done = await waitFor(
    `${JOB_COUNT} succeeded jobs`,
    async () => {
      const count = await scalar(
        `SELECT count(*) FROM "jobs" WHERE "status" = 'succeeded' AND "idempotency_key" LIKE 'evidence-concurrency-%'`,
      );
      return count === JOB_COUNT ? count : null;
    },
    300_000,
    500,
  );
  evidence.event(
    `${done}/${JOB_COUNT} jobs succeeded (${((Date.now() - acceptedAt) / 1000).toFixed(1)}s after the last response)`,
  );

  const log = readLog(worker);
  const values = [...log.matchAll(/\| concurrent=(\d+)/g)].map((match) =>
    Number(match[1]),
  );
  const claimed = (log.match(/\] claimed [0-9a-f-]{36} \|/g) ?? []).length;
  const finished = (log.match(/\] finished [0-9a-f-]{36} \|/g) ?? []).length;
  const maxConcurrent = values.length === 0 ? 0 : Math.max(...values);

  evidence.log('');
  evidence.log(`worker log: ${worker.logPath}`);
  evidence.log(`claimed jobs: ${claimed}`);
  evidence.log(`processed jobs: ${finished}`);
  evidence.log(`max concurrent= value: ${maxConcurrent}`);
  evidence.log(`histogram: ${histogram(values)}`);

  check(
    evidence,
    maxConcurrent <= CONCURRENCY,
    `max concurrent ${maxConcurrent} never exceeded CONCURRENCY=${CONCURRENCY}`,
  );
  check(
    evidence,
    finished === JOB_COUNT,
    `the worker processed all ${JOB_COUNT} jobs`,
    `saw ${finished}`,
  );

  evidence.log('');
  evidence.log(`rows now: jobs=${await scalar('SELECT count(*) FROM "jobs"')} succeeded=${await scalar(`SELECT count(*) FROM "jobs" WHERE "status" = 'succeeded'`)}`);
  evidence.log(`raw worker log kept at ${worker.logPath}`);
});
