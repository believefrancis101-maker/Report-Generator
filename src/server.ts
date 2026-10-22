/**
 * API server entrypoint.
 *
 * Validates the configuration, starts an HTTP server and exposes the job
 * endpoints.
 */
import 'dotenv/config';
import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';

function main(): void {
  const config = loadConfig();

  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`[api] listening on http://localhost:${config.port}`);
    console.log('[api] database: configured (connection string is not logged)');
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    console.error(`[api] server error: ${error.message}`);
    process.exit(1);
  });

  const shutdown = (signal: string): void => {
    console.log(`[api] received ${signal}, shutting down`);
    server.close(() => process.exit(0));
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
