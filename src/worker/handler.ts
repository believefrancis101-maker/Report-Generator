import { applyFaults, type FaultConfig } from '../faults.js';
import type { JobHandler } from '../handlers/types.js';

/**
 * The stub handler - **for tests only**.
 *
 * The real handlers live in `src/handlers`. This one just waits and (with a
 * fail rate) fails on purpose, so the queue mechanics can be tested without
 * touching the sales data.
 */
export type { JobHandler };

/**
 * The stub handler used by the tests until the report generation is
 * exercised for real: it waits for `workDelayMs` and then succeeds.
 *
 * With a `failRate` between 0 and 1 the handler fails on purpose with that
 * probability - the draw happens at the start of the work, after the delay.
 */
export function createStubHandler(
  workDelayMs: number,
  failRate = 0,
  random: () => number = Math.random,
): JobHandler {
  const faults: FaultConfig = {
    workDelayMs,
    failRate,
    crashAfterWork: false,
  };
  return async () => {
    await applyFaults(faults, random);
  };
}
