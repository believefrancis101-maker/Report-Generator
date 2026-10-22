/**
 * API server entrypoint.
 *
 * Stage 1 scope: process scaffold only. It validates the configuration, starts
 * an HTTP server and exposes a health endpoint. Job/queue endpoints are added
 * in later stages.
 */
import 'dotenv/config';
import express from 'express';
import { ConfigError, loadConfig } from './config.js';

function main(): void {
  const config = loadConfig();

  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'report-generator-api' });
  });

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
