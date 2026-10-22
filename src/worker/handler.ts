import type { ClaimedJob } from './claim.js';

/**
 * The job handler.
 *
 * A handler performs the actual work of a job. It must throw to signal a
 * failure; the worker catches that and records the failed attempt.
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
 *
 * With a `failRate` between 0 and 1 the handler fails on purpose with that
 * probability - the draw happens at the start of the work, after the delay.
 */
export function createStubHandler(
  workDelayMs: number,
  failRate = 0,
  random: () => number = Math.random,
): JobHandler {
  return async () => {
    if (workDelayMs > 0) {
      await sleep(workDelayMs);
    }
    if (failRate > 0 && random() < failRate) {
      throw new Error(`Injected failure (FAIL_RATE=${failRate})`);
    }
  };
}
