import type { ClaimedJob } from './claim.js';

/**
 * The job handler.
 *
 * A handler performs the actual work of a job. It must throw to signal a
 * failure; the worker catches that and hands the job to `onJobFailure`.
 */
export type JobHandler = (job: ClaimedJob) => Promise<void>;

/** Sleeps for the given number of milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The stub handler used until the report generation is implemented: it waits
 * for `workDelayMs` and then succeeds.
 */
export function createStubHandler(workDelayMs: number): JobHandler {
  return async () => {
    if (workDelayMs > 0) {
      await sleep(workDelayMs);
    }
  };
}
