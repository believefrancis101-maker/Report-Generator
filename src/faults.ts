/**
 * TEST-ONLY fault injection.
 *
 * Everything in this file exists to exercise failure paths in development and
 * in automated tests. None of it is a production control and it must never be
 * enabled in a deployed environment.
 *
 * The configuration behind it is marked TEST-ONLY as well: `WORK_DELAY_MS`,
 * `FAIL_RATE` and `CRASH_AFTER_WORK`.
 */

import { sleep } from './sleep.js';

/** The TEST-ONLY fault settings of a worker. */
export interface FaultConfig {
  /** Artificial delay before the work starts. */
  workDelayMs: number;
  /** Probability (0..1) that the work fails on purpose. */
  failRate: number;
  /** Whether the worker crashes after the work was saved. */
  crashAfterWork: boolean;
}

/**
 * A crash that is *not* a job failure.
 *
 * A crashed worker leaves its job in 'processing' - it did not get the chance
 * to record an outcome. That is what the sweeper recovers later on.
 */
export class CrashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrashError';
  }
}

/** The fault injection applied at the start of a handler. */
export type ApplyFaults = (
  faults: FaultConfig,
  random: () => number,
) => Promise<void>;

/**
 * Waits for the configured delay and then fails on purpose with the
 * configured probability.
 */
export const applyFaults: ApplyFaults = async (faults, random) => {
  if (faults.workDelayMs > 0) {
    await sleep(faults.workDelayMs);
  }
  if (faults.failRate > 0 && random() < faults.failRate) {
    throw new Error(`Injected failure (FAIL_RATE=${faults.failRate})`);
  }
};

/**
 * The crash that happens *after* the work was saved but *before* the job is
 * marked as succeeded. It proves that the work is idempotent: the next
 * attempt finds the finished report and does not repeat the work.
 *
 * The default kills the process, exactly like a real crash would.
 */
export function crashAfterWork(): never {
  process.exit(1);
}
