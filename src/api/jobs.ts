import { Router } from 'express';
import { loadConfig } from '../config.js';
import { enqueueJob } from '../jobs/enqueue.js';
import { parseEnqueueRequest } from '../jobs/validation.js';

/**
 * HTTP routes for the job queue.
 */
export function createJobsRouter(): Router {
  const router = Router();
  const config = loadConfig();

  router.post('/api/jobs', async (req, res) => {
    const parsed = parseEnqueueRequest(req.body, req.get('idempotency-key'));
    if (!parsed.ok) {
      res.status(400).json({ error: 'Invalid request body', issues: parsed.issues });
      return;
    }

    const outcome = await enqueueJob(
      {
        type: parsed.value.type,
        payload: parsed.value.payload,
        idempotencyKey: parsed.value.idempotencyKey,
      },
      { maxAttempts: config.maxAttempts },
    );

    if (outcome.duplicate) {
      res.status(200).json({
        id: outcome.id,
        status: outcome.status,
        attempts: outcome.attempts,
        duplicate: true,
      });
      return;
    }

    res.status(202).json({
      id: outcome.id,
      status: outcome.status,
      attempts: outcome.attempts,
    });
  });

  return router;
}
