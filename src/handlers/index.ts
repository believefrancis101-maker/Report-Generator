import { salesReportHandler } from './salesReport.js';
import type { HandlerRegistry, JobHandler } from './types.js';

/**
 * The registry of job handlers.
 *
 * A job type that is not in here is an error: the worker throws and the job
 * goes through the normal retry/dead path.
 */
export const handlers: HandlerRegistry = {
  sales_report: salesReportHandler,
};

/** Looks up the handler for a job type. */
export function resolveHandler(
  registry: HandlerRegistry,
  type: string,
): JobHandler | undefined {
  return Object.prototype.hasOwnProperty.call(registry, type)
    ? registry[type]
    : undefined;
}
