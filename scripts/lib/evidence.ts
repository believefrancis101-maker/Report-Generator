import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { pool } from '../../src/db.js';

/**
 * Shared harness for the break-it evidence scripts.
 *
 * Every script:
 *   - deletes the queue tables (never `sales_orders`) and says so,
 *   - runs the API and the workers as real child processes of `process.execPath`,
 *   - tees its own output to `evidence/<name>.txt`,
 *   - keeps every child's stdout/stderr, timestamped, in `evidence/logs/`.
 *
 * Nothing here invents output: every value printed comes from the database or
 * from a captured child log.
 */

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const EVIDENCE_DIR = join(ROOT, 'evidence');
export const LOG_DIR = join(EVIDENCE_DIR, 'logs');

/** `--pause` is forwarded by npm: `npm run evidence:kill-recovery -- --pause`. */
export const PAUSE = process.argv.includes('--pause');

/**
 * `--screenshots` replaces the interactive pause with a Playwright capture of
 * the page under test.
 */
export const SCREENSHOTS = process.argv.includes('--screenshots');

/** The API port; override with EVIDENCE_PORT when 3000 is taken. */
export const PORT = Number(process.env.EVIDENCE_PORT ?? 3000);

/** ISO 8601 UTC with milliseconds. */
export function iso(): string {
  return new Date().toISOString();
}

/** ISO for a database timestamp, or `null`. */
export function timestamp(value: Date | string | null): string {
  if (value === null) return 'null';
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Writes a line to stdout and to the evidence file. */
export class Evidence {
  readonly path: string;
  private readonly stream;

  constructor(readonly name: string) {
    mkdirSync(LOG_DIR, { recursive: true });
    this.path = join(EVIDENCE_DIR, `${name}.txt`);
    this.stream = createWriteStream(this.path, { flags: 'w' });
  }

  /** A plain line (tables, rows). */
  log(line = ''): void {
    process.stdout.write(`${line}\n`);
    this.stream.write(`${line}\n`);
  }

  /** A timestamped event line. */
  event(line: string): void {
    this.log(`${iso()} ${line}`);
  }

  /** Marks the run as failed without pretending it passed. */
  fail(line: string): void {
    this.log('');
    this.log(`FAILED: ${line}`);
    process.exitCode = 1;
  }

  close(): Promise<void> {
    return new Promise((resolveClose) => this.stream.end(resolveClose));
  }
}

export interface ManagedChild {
  name: string;
  pid: number;
  logPath: string;
  child: ChildProcess;
  /** Resolves with the exit code once the process is gone. */
  exited: Promise<number | null>;
}

/**
 * Starts `node --import tsx src/<entry>.ts` as a real child process.
 *
 * Not npm, not tsx watch: the PID printed is the process that does the work,
 * so `kill('SIGKILL')` is a real crash.
 */
function startProcess(
  evidence: Evidence,
  name: string,
  entry: 'worker' | 'server',
  env: Record<string, string>,
): ManagedChild {
  const logPath = join(LOG_DIR, `${evidence.name}-${name}.log`);
  // Create the file eagerly so a reader never races the first write.
  writeFileSync(logPath, '');
  const stream = createWriteStream(logPath, { flags: 'w' });

  const child = spawn(
    process.execPath,
    ['--import', 'tsx', join('src', `${entry}.ts`)],
    {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );

  const pid = child.pid;
  if (pid === undefined) {
    throw new Error(`could not start ${name}`);
  }

  const pipe = (source: NodeJS.ReadableStream | null): void => {
    if (source === null) return;
    source.setEncoding('utf8');
    let buffer = '';
    source.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        stream.write(`${iso()} ${line}\n`);
      }
    });
    source.on('end', () => {
      if (buffer !== '') stream.write(`${iso()} ${buffer}\n`);
    });
  };

  pipe(child.stdout);
  pipe(child.stderr);

  const exited = new Promise<number | null>((resolveExit) => {
    child.on('exit', (code, signal) => {
      stream.write(`${iso()} [exit] code=${code} signal=${signal}\n`);
      stream.end();
      resolveExit(code);
    });
  });

  evidence.event(
    `started ${name} (${entry}) pid=${pid} log=evidence/logs/${evidence.name}-${name}.log`,
  );
  return { name, pid, logPath, child, exited };
}

/** Starts a worker with an explicit WORKER_ID. */
export function startWorker(
  evidence: Evidence,
  name: string,
  env: Record<string, string>,
): ManagedChild {
  return startProcess(evidence, name, 'worker', { CONCURRENCY: '3', ...env });
}

/** Starts the API and waits until it answers /health. */
export async function startApi(
  evidence: Evidence,
  name = 'api',
): Promise<ManagedChild> {
  const api = startProcess(evidence, name, 'server', { PORT: String(PORT) });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (response.ok) {
        evidence.event(`api ready pid=${api.pid} http://127.0.0.1:${PORT}`);
        return api;
      }
    } catch {
      // not listening yet
    }
    await sleep(200);
  }
  throw new Error(`the API did not answer on port ${PORT}`);
}

/** Stops a child. SIGTERM first, SIGKILL after the grace period. */
export async function stop(
  evidence: Evidence,
  managed: ManagedChild,
  graceMs = 5_000,
): Promise<void> {
  if (managed.child.exitCode !== null || managed.child.signalCode !== null) {
    return;
  }
  evidence.event(`stopping ${managed.name} pid=${managed.pid}`);
  managed.child.kill('SIGTERM');
  const timer = setTimeout(() => {
    if (managed.child.exitCode === null && managed.child.signalCode === null) {
      evidence.event(
        `SIGKILL ${managed.name} pid=${managed.pid} at ${iso()} (grace expired)`,
      );
      managed.child.kill('SIGKILL');
    }
  }, graceMs);
  await managed.exited;
  clearTimeout(timer);
}

/** Kills a child with SIGKILL and prints the PID and the time. */
export async function sigkill(
  evidence: Evidence,
  managed: ManagedChild,
): Promise<void> {
  evidence.event(
    `SIGKILL ${managed.name} pid=${managed.pid} at ${iso()}`,
  );
  managed.child.kill('SIGKILL');
  const code = await managed.exited;
  evidence.event(`${managed.name} pid=${managed.pid} exited code=${code}`);
}

/** Reads a captured child log. */
export function readLog(managed: ManagedChild): string {
  return readFileSync(managed.logPath, 'utf8');
}

/** The raw child log, verbatim. */
export function printLog(evidence: Evidence, managed: ManagedChild): void {
  evidence.log(`--- ${managed.logPath} (verbatim) ---`);
  evidence.log(readLog(managed).trimEnd());
  evidence.log('--- end of log ---');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** Polls `fn` until it returns a non-null value. */
export async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null>,
  timeoutMs: number,
  intervalMs = 250,
): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== null) return value;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    }
    await sleep(intervalMs);
  }
}

/** Waits for a line matching `pattern` to appear in a child log. */
export function waitForLogLine(
  managed: ManagedChild,
  pattern: RegExp,
  timeoutMs: number,
  intervalMs = 100,
): Promise<string> {
  return waitFor(
    `"${pattern}" in ${managed.name} log`,
    async () => {
      const match = readLog(managed)
        .split(/\r?\n/)
        .find((line) => pattern.test(line));
      return match ?? null;
    },
    timeoutMs,
    intervalMs,
  );
}

/** Where the Playwright captures are written. */
export const SCREENSHOT_DIR = join(EVIDENCE_DIR, 'screenshots');

/** One screenshot point in a script. */
export interface ScreenshotPoint {
  /** What to capture, shown by the `--pause` prompt. */
  what: string;
  /** The page to open. */
  url: string;
  /** File name inside `evidence/screenshots/`. */
  file: string;
}

/**
 * Captures one page exactly as an operator would see it: 1400x900 viewport at
 * 2x scale, full page, after the network is idle and the table has rendered.
 */
async function captureScreenshot(point: ScreenshotPoint): Promise<string> {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await page.goto(point.url, { waitUntil: 'networkidle' });
    // The page shell is not enough: the jobs table must be rendered.
    await page.waitForSelector('.table-wrap table', { state: 'visible' });
    const path = join(SCREENSHOT_DIR, point.file);
    await page.screenshot({ path, fullPage: true });
    return path;
  } finally {
    await browser.close();
  }
}

/**
 * A screenshot point.
 *
 * - `--screenshots`: capture the page with Playwright and continue.
 * - `--pause`: print `SCREENSHOT NOW` and wait for Enter (the manual path).
 * - neither: do nothing, so the scripts stay non-interactive.
 */
export async function pauseForScreenshot(
  evidence: Evidence,
  point: ScreenshotPoint,
): Promise<void> {
  if (SCREENSHOTS) {
    await captureScreenshot(point);
    return;
  }
  if (!PAUSE) return;
  evidence.log('');
  evidence.log(`SCREENSHOT NOW: ${point.what}`);
  evidence.log('Press Enter to continue...');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((resolveQuestion) => rl.question('', () => resolveQuestion()));
  rl.close();
}

/** The database name from DATABASE_URL (never the credentials). */
export function databaseName(): string {
  try {
    const url = new URL(process.env.DATABASE_URL ?? '');
    return decodeURIComponent(url.pathname.replace(/^\//, '')) || '(unknown)';
  } catch {
    return '(unknown)';
  }
}

/**
 * Deletes every row from `jobs` (cascading to `job_runs` and `reports`).
 * `sales_orders` is never touched, and its row count is printed as proof.
 */
export async function cleanSlate(evidence: Evidence): Promise<void> {
  const salesBefore = await scalar('SELECT count(*) FROM "sales_orders"');
  evidence.log(
    `WARNING: deleting every row from jobs (cascades to job_runs and reports) in database "${databaseName()}". sales_orders is not touched.`,
  );
  const deleted = await pool.query('DELETE FROM "jobs"');
  evidence.event(
    `clean slate: removed ${deleted.rowCount ?? 0} job row(s); jobs=0; sales_orders=${salesBefore} (before and after)`,
  );
}

/** Runs a query returning a single number. */
export async function scalar(
  sql: string,
  params: (string | number)[] = [],
): Promise<number> {
  const { rows } = await pool.query<{ value: string }>(
    `SELECT (${sql})::text AS value`,
    params,
  );
  return Number(rows[0]!.value);
}

/** Prints one job row and all of its runs. */
export async function printJobState(
  evidence: Evidence,
  jobId: string,
  title: string,
): Promise<void> {
  evidence.log(title);

  const job = await pool.query<{
    status: string;
    attempts: number;
    max_attempts: number;
    run_at: Date;
    started_at: Date | null;
    finished_at: Date | null;
    last_error: string | null;
  }>(
    `SELECT "status", "attempts", "max_attempts", "run_at", "started_at", "finished_at", "last_error"
     FROM "jobs" WHERE "id" = $1`,
    [jobId],
  );

  const row = job.rows[0];
  if (!row) {
    evidence.log(`  job ${jobId} not found`);
    return;
  }

  evidence.log(
    `  jobs     id=${jobId} status=${row.status} attempts=${row.attempts}/${row.max_attempts} ` +
      `run_at=${timestamp(row.run_at)} started_at=${timestamp(row.started_at)} ` +
      `finished_at=${timestamp(row.finished_at)} last_error=${row.last_error ?? 'null'}`,
  );

  const runs = await pool.query<{
    worker_id: string;
    started_at: Date;
    finished_at: Date | null;
    outcome: string | null;
    error: string | null;
  }>(
    `SELECT "worker_id", "started_at", "finished_at", "outcome", "error"
     FROM "job_runs" WHERE "job_id" = $1 ORDER BY "started_at", "id"`,
    [jobId],
  );

  if (runs.rows.length === 0) {
    evidence.log('  job_runs (none)');
  }
  for (const run of runs.rows) {
    evidence.log(
      `  job_runs worker=${run.worker_id} started_at=${timestamp(run.started_at)} ` +
        `finished_at=${timestamp(run.finished_at)} outcome=${run.outcome ?? 'null'} error=${run.error ?? 'null'}`,
    );
  }

  const reports = await scalar('SELECT count(*) FROM "reports" WHERE "job_id" = $1', [
    jobId,
  ]);
  evidence.log(`  reports  count=${reports}`);
}

/** Pads a table so it stays readable in a text file. */
export function renderTable(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? '').length)),
  );
  const format = (cells: string[]): string =>
    `  ${cells.map((cell, index) => cell.padEnd(widths[index]!)).join('  ')}`;
  return [
    format(headers),
    `  ${widths.map((width) => '-'.repeat(width)).join('  ')}`,
    ...rows.map(format),
  ];
}

/** `concurrent=1: 3, concurrent=2: 9` */
export function histogram(values: number[]): string {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([value, count]) => `concurrent=${value}: ${count}`)
    .join(', ');
}

/** The report payload used by the scripts: one month of seeded data. */
export const REPORT_PAYLOAD = {
  dateFrom: '2025-06-01',
  dateTo: '2025-06-30',
};

/** Closes the database pool and the evidence file. */
export async function finish(evidence: Evidence): Promise<void> {
  await pool.end();
  await evidence.close();
}

/** Throws with a readable message when an invariant does not hold. */
export function check(
  evidence: Evidence,
  condition: boolean,
  message: string,
  detail?: string,
): void {
  if (condition) {
    evidence.log(`  PASS: ${message}`);
    return;
  }
  throw new Error(`${message}${detail === undefined ? '' : ` - ${detail}`}`);
}

/**
 * Runs a script body, stops every child it started (reverse order) and closes
 * the pool and the evidence file, whether the body succeeded or failed.
 */
export async function withChildren(
  evidence: Evidence,
  body: (track: (child: ManagedChild) => void) => Promise<void>,
): Promise<void> {
  const children: ManagedChild[] = [];
  try {
    await body((child) => {
      children.push(child);
    });
  } catch (error) {
    evidence.fail(error instanceof Error ? error.message : String(error));
  } finally {
    for (const child of [...children].reverse()) {
      try {
        await stop(evidence, child);
      } catch (error) {
        evidence.event(
          `could not stop ${child.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    await finish(evidence);
  }
}

/** Waits for a child to exit and returns the code. */
export async function waitExit(
  managed: ManagedChild,
  timeoutMs: number,
): Promise<number | null> {
  const timeout = sleep(timeoutMs).then(() => 'timeout' as const);
  const result = await Promise.race([
    managed.exited.then((code) => code ?? -1),
    timeout,
  ]);
  if (result === 'timeout') {
    throw new Error(`${managed.name} did not exit within ${timeoutMs}ms`);
  }
  return result;
}
