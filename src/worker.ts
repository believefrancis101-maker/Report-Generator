/**
 * Worker entrypoint.
 *
 * Validates the configuration and runs as an independent OS process.
 */
import 'dotenv/config';
import { ConfigError, loadConfig } from './config.js';

function main(): void {
  const config = loadConfig();

  console.log(`[worker] started`);
  console.log(`[worker] worker id: ${config.workerId}`);
  console.log(
    `[worker] concurrency=${config.concurrency} pollIntervalMs=${config.pollIntervalMs} sweepIntervalMs=${config.sweepIntervalMs}`,
  );
  console.log('[worker] no job processing yet');

  // Keeps the process alive until it is asked to stop.
  const keepAlive = setInterval(() => undefined, 60_000);

  const shutdown = (signal: string): void => {
    console.log(`[worker] received ${signal}, shutting down`);
    clearInterval(keepAlive);
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

try {
  main();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
