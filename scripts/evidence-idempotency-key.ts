import { pool } from '../src/db.js';
import {
  Evidence,
  PORT,
  REPORT_PAYLOAD,
  check,
  cleanSlate,
  renderTable,
  startApi,
  withChildren,
} from './lib/evidence.js';

/**
 * Evidence: the idempotency key is enforced by the database, not by a
 * check-then-insert in application code.
 *
 *   - the same key twice sequentially: 202, then 200 with `duplicate: true`;
 *   - 20 submits of another key at the same time: one insert, 19 duplicates;
 *   - `count(*)` is 1 for every key;
 *   - the same key with a different payload is rejected with 422.
 */

const NAME = 'idempotency-key';

interface PostResult {
  label: string;
  status: number;
  ms: number;
  body: Record<string, unknown>;
}

const evidence = new Evidence(NAME);

await withChildren(evidence, async (track) => {
  await cleanSlate(evidence);

  const api = await startApi(evidence);
  track(api);

  const post = async (label: string, body: unknown): Promise<PostResult> => {
    const started = performance.now();
    const response = await fetch(`http://127.0.0.1:${PORT}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return {
      label,
      status: response.status,
      ms: performance.now() - started,
      body: (await response.json()) as Record<string, unknown>,
    };
  };

  const request = (key: string, payload: unknown = REPORT_PAYLOAD) => ({
    type: 'sales_report',
    payload,
    idempotencyKey: key,
  });

  evidence.log('');
  evidence.log('the same key, twice, sequentially:');
  const first = await post('1', request('evidence-idem-sequential'));
  const second = await post('2', request('evidence-idem-sequential'));
  for (const line of renderTable(
    ['#', 'HTTP', 'response time', 'body'],
    [first, second].map((result) => [
      result.label,
      String(result.status),
      `${result.ms.toFixed(1)} ms`,
      JSON.stringify(result.body),
    ]),
  )) {
    evidence.log(line);
  }
  check(evidence, first.status === 202, 'the first submit answered 202', String(first.status));
  check(
    evidence,
    second.status === 200 && second.body.duplicate === true,
    'the second submit answered 200 with duplicate=true',
    JSON.stringify(second.body),
  );
  check(
    evidence,
    first.body.id === second.body.id,
    'both submits returned the same job id',
    `${String(first.body.id)} vs ${String(second.body.id)}`,
  );

  evidence.log('');
  evidence.log('20 submits of another key at the same time:');
  const concurrent = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      post(String(index + 1), request('evidence-idem-concurrent')),
    ),
  );
  for (const line of renderTable(
    ['#', 'HTTP', 'response time', 'body'],
    concurrent.map((result) => [
      result.label,
      String(result.status),
      `${result.ms.toFixed(1)} ms`,
      JSON.stringify(result.body),
    ]),
  )) {
    evidence.log(line);
  }

  const accepted = concurrent.filter((result) => result.status === 202).length;
  const duplicates = concurrent.filter(
    (result) => result.status === 200 && result.body.duplicate === true,
  ).length;
  const ids = new Set(concurrent.map((result) => String(result.body.id)));
  evidence.log('');
  evidence.log(
    `status codes: ${[...new Set(concurrent.map((result) => result.status))].sort((a, b) => a - b).join(', ')}`,
  );
  evidence.log(
    `202 accepted: ${accepted}, 200 duplicate: ${duplicates}, distinct job ids: ${ids.size}`,
  );
  check(
    evidence,
    accepted === 1 && duplicates === 19 && ids.size === 1,
    'exactly one insert, 19 duplicates, one job id',
    `accepted=${accepted} duplicates=${duplicates} ids=${ids.size}`,
  );

  const counts = await pool.query<{ idempotency_key: string; count: string }>(
    `SELECT "idempotency_key", count(*)::text AS count
     FROM "jobs" WHERE "idempotency_key" LIKE 'evidence-idem-%'
     GROUP BY 1 ORDER BY 1`,
  );
  evidence.log('');
  evidence.log('rows per key:');
  for (const line of renderTable(
    ['idempotency_key', 'count'],
    counts.rows.map((row) => [row.idempotency_key, row.count]),
  )) {
    evidence.log(line);
  }
  check(
    evidence,
    counts.rows.length === 2 && counts.rows.every((row) => row.count === '1'),
    'each key has exactly one row',
    counts.rows.map((row) => `${row.idempotency_key}=${row.count}`).join(', '),
  );

  evidence.log('');
  evidence.log('the same key with a different payload:');
  const reused = await post(
    'reused',
    request('evidence-idem-sequential', {
      dateFrom: '2025-07-01',
      dateTo: '2025-07-31',
    }),
  );
  evidence.log(`  HTTP ${reused.status} ${JSON.stringify(reused.body)}`);
  check(
    evidence,
    reused.status === 422,
    'the mismatching payload answered 422',
    String(reused.status),
  );
});
