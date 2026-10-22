import { Router } from 'express';
import { pool } from '../db.js';
import { loadConfig } from '../config.js';
import { enqueueJob } from '../jobs/enqueue.js';
import {
  getJob,
  getReportPdf,
  listJobs,
  retryJob,
} from '../jobs/queries.js';
import {
  jobIdSchema,
  listJobsQuerySchema,
  parseEnqueueRequest,
} from '../jobs/validation.js';

/**
 * HTTP routes for the job queue.
 */
export function createJobsRouter(): Router {
  const router = Router();
  const config = loadConfig();

  /** Parses a job id, answering 400 when it is not a UUID. */
  const parseJobId = (value: string): string | null => {
    const parsed = jobIdSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  };

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

    if (outcome.outcome === 'key_reused') {
      res.status(422).json({
        error: 'idempotency_key_reused',
        message: 'This key was already used with a different request',
      });
      return;
    }

    if (outcome.outcome === 'duplicate') {
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

  /** The newest jobs first, 50 by default and at most 200 per page. */
  router.get('/api/jobs', async (req, res) => {
    const parsed = listJobsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Invalid query',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),
          message: issue.message,
        })),
      });
      return;
    }

    const jobs = await listJobs(pool, {
      status: parsed.data.status,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });

    res.json({
      jobs,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });
  });

  /** The stored PDF, streamed as a download. */
  router.get('/api/jobs/:id/report', async (req, res) => {
    const id = parseJobId(req.params.id);
    if (!id) {
      res.status(400).json({
        error: 'Invalid job id',
        message: 'job id must be a UUID',
      });
      return;
    }

    const pdf = await getReportPdf(pool, id);
    if (!pdf) {
      res.status(404).json({
        error: 'Report not found',
        message: `No report exists for job ${id}`,
      });
      return;
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="report-${id}.pdf"`,
    );
    res.setHeader('Content-Length', String(pdf.length));
    res.send(pdf);
  });

  /** One job, with `reportAvailable` instead of the PDF itself. */
  router.get('/api/jobs/:id', async (req, res) => {
    const id = parseJobId(req.params.id);
    if (!id) {
      res.status(400).json({
        error: 'Invalid job id',
        message: 'job id must be a UUID',
      });
      return;
    }

    const job = await getJob(pool, id);
    if (!job) {
      res.status(404).json({ error: 'Job not found', message: `No job ${id}` });
      return;
    }

    res.json(job);
  });

  /** Puts a dead job back into the queue. */
  router.post('/api/jobs/:id/retry', async (req, res) => {
    const id = parseJobId(req.params.id);
    if (!id) {
      res.status(400).json({
        error: 'Invalid job id',
        message: 'job id must be a UUID',
      });
      return;
    }

    const result = await retryJob(pool, id);

    if (result.outcome === 'missing') {
      res.status(404).json({ error: 'Job not found', message: `No job ${id}` });
      return;
    }

    if (result.outcome === 'not_dead') {
      res.status(409).json({
        error: 'job_not_dead',
        message: 'Only dead jobs can be retried',
      });
      return;
    }

    res.json(result.job);
  });

  return router;
}
