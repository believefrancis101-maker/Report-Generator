/**
 * The five states of a job.
 *
 * `dead` is terminal until an operator retries the job; the claim picks up
 * `pending` and `failed` jobs only.
 */
export const JOB_STATUSES = [
  'pending',
  'processing',
  'succeeded',
  'failed',
  'dead',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

/** True when the value is one of the five job states. */
export function isJobStatus(value: string): value is JobStatus {
  return (JOB_STATUSES as readonly string[]).includes(value);
}
