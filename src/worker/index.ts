import type { Pool } from 'pg';
import { pool as sharedPool } from '../db.js';
import { claimJob, type ClaimedJob } from './claim.js';
import { completeJob } from './complete.js';
import { createStubHandler, type JobHandler } from './handler.js';
import { logClaimed, logFinished, logLostClaim, logLine } from './log.js';

/**
 * The worker loop.
 *
 * The loop is a plain function so it can be started in-process by the tests
 * against a real database.
 */

export interface StartWorkerOptions {
  /** Identity of this worker, e.g. `host-1234`. */
  workerId: string;
  /** Maximum number of jobs this worker processes at the same time. */
  concurrency: number;
  /** How long to wait before polling again when there is nothing to do. */
  pollIntervalMs: number;
  /** Artificial delay per job (used by the stub handler). */
  workDelayMs?: number;
  /** Performs the work of a job. Defaults to the stub handler. */
  handler?: JobHandler;
  /**
   * Called when a handler throws.
   *
   * TODO: the retry/backoff/dead-letter logic goes here - it will decide
   * whether the job is scheduled for another attempt (`status = 'failed'`)
   * or moved to the dead-letter state (`status = 'dead'`). Until then the
   * job row is left untouched.
   */
  onJobFailure?: (job: ClaimedJob, error: Error) => void | Promise<void>;
  /** Connection pool to use. Defaults to the shared pool. */
  db?: Pool;
}

export interface WorkerHandle {
  /** Stops claiming and waits for the running jobs to finish. */
  stop(): Promise<void>;
}

export function startWorker(options: StartWorkerOptions): WorkerHandle {
  const db = options.db ?? sharedPool;
  const handler = options.handler ?? createStubHandler(options.workDelayMs ?? 0);

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

  const runJob = async (job: ClaimedJob): Promise<void> => {
    try {
      await handler(job);
      const completed = await completeJob(db, job);
      if (completed) {
        logFinished(options.workerId, job.id, activeCount);
      } else {
        // The claim was lost - the job was recovered or reclaimed meanwhile.
        logLostClaim(options.workerId, job.id);
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      logLine(
        `[worker ${options.workerId}] job ${job.id} failed: ${failure.message}`,
      );
      try {
        // TODO: retry / backoff / dead-letter handling lives here.
        await options.onJobFailure?.(job, failure);
      } catch (hookError) {
        logLine(
          `[worker ${options.workerId}] failure hook for job ${job.id} threw: ${
            hookError instanceof Error ? hookError.message : String(hookError)
          }`,
        );
      }
      // The job row is left alone until the retry logic exists.
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

  const stop = async (): Promise<void> => {
    running = false;
    // Interrupt the pending sleep so the loop exits right away.
    wake?.();
    await loopPromise;
    // Let the jobs that are still running finish.
    await Promise.allSettled([...inFlight]);
  };

  return { stop };
}
