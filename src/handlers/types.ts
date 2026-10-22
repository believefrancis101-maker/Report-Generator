import type { Pool } from 'pg';
import type { ClaimedJob } from '../worker/claim.js';
import type { ApplyFaults, FaultConfig } from '../faults.js';
import type { AggregateFunction } from './aggregate.js';

/**
 * The contract between the worker and the job handlers.
 */

/**
 * Everything a handler may use. The injectable pieces are part of the
 * context so the tests can replace them (spy on the aggregation, inject a
 * crash, disable the fault injection).
 */
export interface HandlerContext {
  /** Connection pool for the database. */
  db: Pool;
  /** Identity of the worker that runs the job. */
  workerId: string;
  /** Source of randomness for the fault injection. */
  random: () => number;
  /** TEST-ONLY fault settings. */
  faults: FaultConfig;
  /** The aggregation over the sales data - replaceable in tests. */
  aggregate: AggregateFunction;
  /** TEST-ONLY fault injection applied at the start of the handler. */
  applyFaults: ApplyFaults;
  /** TEST-ONLY crash after the work was saved. */
  crashAfterWork: () => void;
}

/**
 * A handler performs the work of a job. It must throw to signal a failure;
 * the worker then records the failed attempt.
 */
export type JobHandler = (job: ClaimedJob, ctx: HandlerContext) => Promise<void>;

/** Maps a job type to the handler that knows how to do the work. */
export type HandlerRegistry = Record<string, JobHandler>;
