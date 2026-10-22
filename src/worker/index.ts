import type { Pool } from 'pg';
import { pool as sharedPool } from '../db.js';
import { backoffDelayMs, type BackoffOptions } from '../backoff.js';
import { applyFaults, crashAfterWork, CrashError, type ApplyFaults, type FaultConfig } from '../faults.js';
import { handlers as defaultRegistry, resolveHandler } from '../handlers/index.js';
import {
  aggregateSalesReport,
  type AggregateFunction,
} from '../handlers/aggregate.js';
import type { HandlerContext, HandlerRegistry, JobHandler } from '../handlers/types.js';
import { claimJob, type ClaimedJob } from './claim.js';
import { completeJob } from './complete.js';
import { failJob } from './fail.js';
import { sweepStuckJobs } from './sweep.js';
import {
  logClaimed,
  logFinished,
  logJobDead,
  logJobFailed,
  logLine,
  logLostClaim,
  logSweepRecovered,
} from './log.js';

/**
 * The worker loop.
 *
 * The loop is a plain function so it can be started in-process by the tests
 * against a real database.
 */

/** The maximum length of the error message stored on the job. */
const MAX_ERROR_LENGTH = 2000;

export interface StartWorkerOptions {
  /** Identity of this worker, e.g. `host-1234`. */
  workerId: string;
  /** Maximum number of jobs this worker processes at the same time. */
  concurrency: number;
  /** How long to wait before polling again when there is nothing to do. */
  pollIntervalMs: number;
  /** The backoff configuration for retries. */
  backoff: BackoffOptions;
  /**
   * Stuck-job recovery: the timeout that decides what "stuck" means and how
   * often to look for stuck jobs. `false` switches the sweep off.
   */
  sweep: SweepOptions | false;
  /** TEST-ONLY fault settings. */
  faults?: FaultConfig;
  /**
   * Replaces the handler of every job. Only the tests use this - the worker
   * normally looks the handler up in the registry.
   */
  handler?: JobHandler;
  /** The registry that maps a job type to its handler. */
  handlers?: HandlerRegistry;
  /** The aggregation used by the sales report handler. */
  aggregate?: AggregateFunction;
  /** TEST-ONLY fault injection applied at the start of a handler. */
  applyFaults?: ApplyFaults;
  /** TEST-ONLY crash after the work was saved. */
  crashAfterWork?: () => void;
  /** Source of randomness for the backoff jitter and the fault injection. */
  random?: () => number;
  /** Connection pool to use. Defaults to the shared pool. */
  db?: Pool;
}

export interface WorkerHandle {
  /** Stops claiming, the sweep and waits for the running jobs to finish. */
  stop(): Promise<void>;
  /** The number of jobs this worker is currently working on. */
  activeCount(): number;
}

/** How the sweep is scheduled. */
export interface SweepOptions {
  /** A job that has been running longer than this (ms) is stuck. */
  stuckTimeoutMs: number;
  /** How often (ms) the worker looks for stuck jobs. */
  intervalMs: number;
}

export function startWorker(options: StartWorkerOptions): WorkerHandle {
  const db = options.db ?? sharedPool;
  const random = options.random ?? Math.random;
  const registry = options.handlers ?? defaultRegistry;
  const faults: FaultConfig = options.faults ?? {
    workDelayMs: 0,
    failRate: 0,
    crashAfterWork: false,
  };

  const context: HandlerContext = {
    db,
    workerId: options.workerId,
    random,
    faults,
    aggregate: options.aggregate ?? aggregateSalesReport,
    applyFaults: options.applyFaults ?? applyFaults,
    crashAfterWork: options.crashAfterWork ?? crashAfterWork,
  };

  let running = true;
  /** Jobs this process is currently working on. */
  let activeCount = 0;
  const inFlight = new Set<Promise<void>>();
  /** Resolves the pending sleep when the worker is stopped. */
  let wake: (() => void) | null = null;

  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });

  /**
   * Finds the handler for a job. An unknown job type throws - the job then
   * goes through the normal retry/dead path.
   */
  const handlerFor = (job: ClaimedJob): JobHandler => {
    if (options.handler) return options.handler;
    const handler = resolveHandler(registry, job.type);
    if (!handler) {
      throw new Error(`Unknown job type: "${job.type}"`);
    }
    return handler;
  };

  /**
   * Records a failed attempt: the job is scheduled for another try, or it is
   * killed when the retries are exhausted.
   */
  const handleFailure = async (job: ClaimedJob, error: Error): Promise<void> => {
    const message = error.message.slice(0, MAX_ERROR_LENGTH);
    // The attempt that just failed.
    const failureCount = job.attempts + 1;
    const delayMs = backoffDelayMs(failureCount, options.backoff, random);

    let outcome;
    try {
      outcome = await failJob(db, job, message, delayMs);
    } catch (dbError) {
      logLine(
        `[worker ${options.workerId}] could not record the failure of job ${job.id}: ${
          dbError instanceof Error ? dbError.message : String(dbError)
        }`,
      );
      return;
    }

    if (!outcome.updated) {
      // The claim was lost - the job was recovered or reclaimed meanwhile.
      logLostClaim(options.workerId, job.id);
      return;
    }

    if (outcome.status === 'dead') {
      logJobDead(options.workerId, job.id, outcome.attempts ?? failureCount, message);
      return;
    }

    logJobFailed(
      options.workerId,
      job.id,
      outcome.attempts ?? failureCount,
      job.max_attempts,
      message,
      delayMs,
      outcome.runAt ?? new Date(),
    );
  };

  const runJob = async (job: ClaimedJob): Promise<void> => {
    let failure: Error | null = null;
    try {
      const handler = handlerFor(job);
      await handler(job, context);
    } catch (error) {
      if (error instanceof CrashError) {
        // A crash is not a job failure: the job stays 'processing' and the
        // sweeper recovers it later.
        logLine(
          `[worker ${options.workerId}] job ${job.id} crashed: ${error.message}`,
        );
        throw error;
      }
      // Non-Error throws are coerced to a message.
      failure = error instanceof Error ? error : new Error(String(error));
    }

    if (failure) {
      await handleFailure(job, failure);
      return;
    }

    try {
      const completed = await completeJob(db, job);
      if (completed) {
        logFinished(options.workerId, job.id, activeCount);
      } else {
        // The claim was lost - the job was recovered or reclaimed meanwhile.
        logLostClaim(options.workerId, job.id);
      }
    } catch (error) {
      logLine(
        `[worker ${options.workerId}] could not complete job ${job.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  const loop = async (): Promise<void> => {
    while (running) {
      if (activeCount < options.concurrency) {
        const job = await claimJob(db, options.workerId);
        if (job) {
          activeCount += 1;
          // Start the job without awaiting it, so the loop can claim the
          // next one right away.
          const task = runJob(job).finally(() => {
            // Decrement in a finally block: a throwing handler must never
            // leak a concurrency slot.
            activeCount -= 1;
          });
          inFlight.add(task);
          void task.then(
            () => inFlight.delete(task),
            () => inFlight.delete(task),
          );
          logClaimed(options.workerId, job.id, activeCount);
          // No sleep: try to claim the next job immediately.
          continue;
        }
      }
      // Nothing to claim (or the concurrency cap is reached): wait.
      await sleep(options.pollIntervalMs);
    }
  };

  const loopPromise = loop().catch((error: unknown) => {
    logLine(
      `[worker ${options.workerId}] loop stopped: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });

  // --- Stuck-job recovery -------------------------------------------------
  const sweepSettings = options.sweep;
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** The sweep that is currently running, so that ticks never overlap. */
  let sweepInFlight: Promise<void> | null = null;

  const runSweep = async (): Promise<void> => {
    if (!sweepSettings) return;
    try {
      const recovered = await sweepStuckJobs(db, {
        stuckTimeoutMs: sweepSettings.stuckTimeoutMs,
      });
      for (const job of recovered) {
        logSweepRecovered(
          options.workerId,
          job.id,
          job.status,
          job.attempts,
        );
      }
    } catch (error) {
      // A failing sweep must never take the worker down: the jobs it did not
      // recover are simply found again on the next tick.
      logLine(
        `[worker ${options.workerId}] sweep failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  const tickSweep = (): void => {
    // Never overlap: a sweep that is still running means this tick is
    // skipped. Several workers sweeping at the same time is safe - the
    // second UPDATE matches no rows.
    if (sweepInFlight) return;
    sweepInFlight = runSweep().finally(() => {
      sweepInFlight = null;
    });
  };

  if (sweepSettings) {
    // Once at startup, so a worker that starts after a crash recovers the
    // jobs the dead worker left behind without waiting for the first tick.
    tickSweep();
    sweepTimer = setInterval(tickSweep, sweepSettings.intervalMs);
  }

  const stop = async (): Promise<void> => {
    running = false;
    // Stop the sweep timer; a sweep that is already running is awaited below.
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
    // Interrupt the pending sleep so the loop exits right away.
    wake?.();
    await loopPromise;
    // Let an in-flight sweep finish before the pool is closed.
    await sweepInFlight;
    // Let the jobs that are still running finish.
    await Promise.allSettled([...inFlight]);
  };

  return {
    stop,
    activeCount: () => activeCount,
  };
}
