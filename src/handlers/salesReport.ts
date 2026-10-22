import { z } from 'zod';
import type { ClaimedJob } from '../worker/claim.js';
import type { HandlerContext } from './types.js';
import type { SalesReportParams } from './aggregate.js';
import { renderSalesReportPdf } from './pdf.js';

/**
 * The `sales_report` handler.
 *
 * The handler is idempotent: the report is stored in the `reports` table with
 * a UNIQUE constraint on `job_id`, and the handler checks for an existing
 * report *before* doing any work. A worker that crashes after the report was
 * saved therefore never repeats the expensive part.
 */

const payloadSchema = z.object({
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/** The report summary that is stored next to the PDF. */
export interface ReportSummary {
  params: SalesReportParams;
  generatedAt: string;
  totals: { revenueMinor: number; orders: number };
  byCategoryMonth: unknown[];
  topCustomers: unknown[];
  growth: unknown[];
}

/**
 * Does the work of a `sales_report` job.
 */
export async function salesReportHandler(
  job: ClaimedJob,
  ctx: HandlerContext,
): Promise<void> {
  // TEST-ONLY: the injected delay and the deliberate failure happen before
  // anything else, so a job that fails on purpose never leaves a report.
  await ctx.applyFaults(ctx.faults, ctx.random);

  // STEP 1 - the idempotency check comes first: if the report is already
  // there, the work is done - no aggregation, no rendering.
  const existing = await ctx.db.query('SELECT 1 FROM reports WHERE job_id = $1', [
    job.id,
  ]);
  if ((existing.rowCount ?? 0) > 0) {
    console.log(`[handler] report for ${job.id} already exists, skipping`);
    return;
  }

  const parsed = payloadSchema.safeParse(job.payload);
  if (!parsed.success) {
    throw new Error(
      `Invalid sales_report payload: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join(', ')}`,
    );
  }
  const params: SalesReportParams = {
    dateFrom: parsed.data.dateFrom,
    dateTo: parsed.data.dateTo,
  };

  // STEP 2 - the aggregation over the sales data, and STEP 3 - measuring it.
  const startedAt = Date.now();
  const analysis = await ctx.aggregate(ctx.db, params);
  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[handler] aggregation for job ${job.id} took ${elapsedMs}ms ` +
      `(${analysis.byCategoryMonth.length} category-months, ` +
      `${analysis.topCustomers.length} top customers, ` +
      `${analysis.growth.length} months)`,
  );

  // STEP 4 - render the PDF.
  const generatedAt = new Date().toISOString();
  const pdf = await renderSalesReportPdf(job, params, analysis, generatedAt);

  // STEP 5 - store the report. The UNIQUE constraint on `job_id` is what
  // makes this safe against concurrent attempts.
  const summary: ReportSummary = {
    params,
    generatedAt,
    totals: analysis.totals,
    byCategoryMonth: analysis.byCategoryMonth,
    topCustomers: analysis.topCustomers,
    growth: analysis.growth,
  };
  const inserted = await ctx.db.query(
    `INSERT INTO reports (job_id, summary, pdf) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (job_id) DO NOTHING
     RETURNING id`,
    [job.id, JSON.stringify(summary), pdf],
  );
  if ((inserted.rowCount ?? 0) > 0) {
    console.log(
      `[handler] report for ${job.id} saved (${pdf.length} bytes, ${elapsedMs}ms aggregation)`,
    );
  } else {
    console.log(`[handler] report for ${job.id} already existed, nothing written`);
  }

  // STEP 6 - TEST-ONLY: the crash that proves the idempotency. It happens
  // after the report was saved and before the job is marked as succeeded, so
  // the next attempt finds the finished report and skips the work.
  if (ctx.faults.crashAfterWork) {
    ctx.crashAfterWork();
  }
}
