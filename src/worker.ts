/**
 * Worker entrypoint.
 *
 * Validates the configuration, starts the worker loop and shuts down cleanly
 * on SIGTERM/SIGINT: stop claiming, wait for the running jobs to finish,
 * close the pool, exit 0.
 *
 * SIGKILL skips this on purpose - a job that is killed that way stays
 * 'processing' and is picked up again by the stuck-job sweeper.
 */
import 'dotenv/config';
import { ConfigError, loadConfig } from './config.js';
import { closePool } from './db.js';
import { startWorker } from './worker/index.js';
import { logLine } from './worker/log.js';

async function main(): Promise<void> {
  const config = loadConfig();

  const worker = startWorker({
    workerId: config.workerId,
    concurrency: config.concurrency,
    pollIntervalMs: config.pollIntervalMs,
    workDelayMs: config.workDelayMs,
    failRate: config.failRate,
    backoff: {
      baseMs: config.backoffBaseMs,
      maxMs: config.backoffMaxMs,
    },
  });

  logLine(
    `[worker ${config.workerId}] started | concurrency=${config.concurrency} pollIntervalMs=${config.pollIntervalMs}`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logLine(`[worker ${config.workerId}] received ${signal}, shutting down`);
    await worker.stop();
    await closePool();
    process.exit(0);
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
}

try {
  await main();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
