/**
 * Worker logging.
 *
 * The log lines of the worker are part of its contract - they are parsed by
 * the tests and read by operators, so the format stays fixed:
 *
 *   <ISO timestamp> [worker <WORKER_ID>] claimed <jobId> | concurrent=<n>
 *   <ISO timestamp> [worker <WORKER_ID>] finished <jobId> | concurrent=<n>
 *
 * `n` is the number of jobs this process is currently working on.
 */

/** Writes one line with an ISO timestamp in front. */
export function logLine(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

/** `[worker <id>] claimed <jobId> | concurrent=<n>` */
export function logClaimed(workerId: string, jobId: string, concurrent: number): void {
  logLine(`[worker ${workerId}] claimed ${jobId} | concurrent=${concurrent}`);
}

/** `[worker <id>] finished <jobId> | concurrent=<n>` */
export function logFinished(workerId: string, jobId: string, concurrent: number): void {
  logLine(`[worker ${workerId}] finished ${jobId} | concurrent=${concurrent}`);
}

/** `[worker <id>] lost claim for <jobId>: job was recovered or reclaimed` */
export function logLostClaim(workerId: string, jobId: string): void {
  logLine(
    `[worker ${workerId}] lost claim for ${jobId}: job was recovered or reclaimed`,
  );
}

/**
 * `[worker <id>] job <jobId> failed (attempt <n>/<max>): <message> | retry in <ms>ms at <ISO>`
 */
export function logJobFailed(
  workerId: string,
  jobId: string,
  attempt: number,
  maxAttempts: number,
  message: string,
  delayMs: number,
  runAt: Date,
): void {
  logLine(
    `[worker ${workerId}] job ${jobId} failed (attempt ${attempt}/${maxAttempts}): ${message} | retry in ${delayMs}ms at ${runAt.toISOString()}`,
  );
}

/** `[worker <id>] job <jobId> is DEAD after <n> attempts: <message>` */
export function logJobDead(
  workerId: string,
  jobId: string,
  attempts: number,
  message: string,
): void {
  logLine(
    `[worker ${workerId}] job ${jobId} is DEAD after ${attempts} attempts: ${message}`,
  );
}
