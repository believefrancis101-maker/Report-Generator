/**
 * Exponential backoff with jitter.
 *
 * A pure function: the configuration and the source of randomness are
 * injected, so it can be unit tested without any I/O.
 */

export interface BackoffOptions {
  /** Delay of the first retry, in milliseconds. */
  baseMs: number;
  /** Upper bound for the delay, in milliseconds. */
  maxMs: number;
}

/**
 * Computes how long to wait before the next attempt.
 *
 *   exponential = baseMs * 2 ** (failureCount - 1)   // the first retry waits ~base
 *   jitter     = floor(random() * exponential * 0.5)
 *   delay      = min(maxMs, exponential + jitter)
 *
 * The jitter is what keeps a batch of failed jobs from retrying in lockstep.
 */
export function backoffDelayMs(
  failureCount: number,
  options: BackoffOptions,
  random: () => number = Math.random,
): number {
  // The exponent never goes below zero, so the delay stays a whole multiple
  // of the base delay.
  const exponent = Math.max(0, failureCount - 1);
  const exponential = options.baseMs * 2 ** exponent;
  // JITTER: without it, jobs that failed together retry together and hit the
  // failing dependency in a thundering herd.
  const jitter = Math.floor(random() * exponential * 0.5);
  return Math.min(options.maxMs, exponential + jitter);
}
