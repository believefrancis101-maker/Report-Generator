import express, {
  type ErrorRequestHandler,
  type Express,
  type RequestHandler,
} from 'express';
import { createJobsRouter } from './api/jobs.js';
import { createPagesRouter } from './pages/router.js';

/**
 * Builds the Express application.
 *
 * Kept separate from `server.ts` so the app can be mounted by the tests
 * without opening a fixed port.
 */
export function createApp(): Express {
  const app = express();

  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'report-generator-api' });
  });

  app.use(createJobsRouter());
  app.use(createPagesRouter());

  const notFound: RequestHandler = (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  };
  app.use(notFound);

  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    // Malformed JSON bodies are a client error, not a server error.
    if (
      error instanceof SyntaxError &&
      'status' in error &&
      (error as { status?: number }).status === 400
    ) {
      res.status(400).json({ error: 'Invalid JSON body' });
      return;
    }
    console.error('[api] unhandled error:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'Internal server error' });
  };
  app.use(errorHandler);

  return app;
}
