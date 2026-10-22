import { Router } from 'express';
import { pool } from '../db.js';
import { countJobsByStatus, getDeadJobs, listJobs } from '../jobs/queries.js';
import { jobsPageQuerySchema } from '../jobs/validation.js';
import { escapeHtml, layout } from './layout.js';
import { renderDeadPage } from './dead.js';
import { renderJobsPage } from './jobs.js';
import { renderTriggerPage } from './trigger.js';

/**
 * The three server-rendered pages. They read the same tables as the API but
 * return HTML, so they work without a build step or a frontend framework.
 */

const MAX_JOBS_ON_PAGE = 50;

function invalidQueryPage(message: string): string {
  return layout({
    title: 'Invalid request',
    active: 'jobs',
    body: `<h1>Invalid request</h1>
<p class="notice error">${escapeHtml(message)}</p>
<p><a href="/jobs">Back to jobs</a></p>`,
  });
}

export function createPagesRouter(): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.type('html').send(renderTriggerPage());
  });

  router.get('/jobs', async (req, res) => {
    const parsed = jobsPageQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((issue) => issue.message)
        .join('; ');
      res.status(400).type('html').send(invalidQueryPage(message));
      return;
    }

    const status = parsed.data.status ?? null;
    const refreshSeconds = parsed.data.refresh === '2' ? 2 : null;

    const [counts, jobs] = await Promise.all([
      countJobsByStatus(pool),
      listJobs(pool, {
        status: status ?? undefined,
        limit: MAX_JOBS_ON_PAGE,
        offset: 0,
      }),
    ]);

    res.type('html').send(
      renderJobsPage({
        counts,
        jobs,
        status,
        refreshSeconds: refreshSeconds === 2 ? 2 : null,
      }),
    );
  });

  router.get('/dead', async (_req, res) => {
    const jobs = await getDeadJobs(pool);
    res.type('html').send(renderDeadPage(jobs));
  });

  return router;
}
