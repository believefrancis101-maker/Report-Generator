import { hostname } from 'node:os';
import { z } from 'zod';

/**
 * Typed, validated runtime configuration.
 *
 * All environment variables are read once, validated with Zod and exposed as a
 * frozen, typed object. Validation failures throw {@link ConfigError} so that
 * both entrypoints can fail fast with a readable message.
 *
 * Security note: secret values (notably `DATABASE_URL`) are never included in
 * error messages or logs.
 */

/** Error thrown when the environment does not satisfy the configuration schema. */
export class ConfigError extends Error {
  /** Individual, human readable problems (never contain secret values). */
  readonly issues: string[];

  constructor(issues: string[]) {
    super(
      `Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`,
    );
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/** Fully validated configuration shared by the API server and the worker. */
export interface Config {
  /** Postgres connection string. Secret - never log this value. */
  readonly databaseUrl: string;
  /** TCP port the API server listens on. */
  readonly port: number;
  /** Maximum number of delivery attempts for a single job. */
  readonly maxAttempts: number;
  /** Number of jobs a worker may process concurrently. */
  readonly concurrency: number;
  /** Base delay (ms) used for exponential backoff between retries. */
  readonly backoffBaseMs: number;
  /** Upper bound (ms) for the exponential backoff delay. */
  readonly backoffMaxMs: number;
  /** A job that has been running longer than this (ms) is considered stuck. */
  readonly stuckTimeoutMs: number;
  /** Interval (ms) between stuck-job sweeps. */
  readonly sweepIntervalMs: number;
  /** Interval (ms) between job polls by the worker. */
  readonly pollIntervalMs: number;
  /** Stable identity of this worker process, e.g. `my-host-1234`. */
  readonly workerId: string;
  /**
   * TEST-ONLY: probability (0..1) that a unit of work fails on purpose.
   * Never enable in production.
   */
  readonly failRate: number;
  /**
   * TEST-ONLY: crash the worker after the first unit of work.
   * Never enable in production.
   */
  readonly crashAfterWork: boolean;
  /**
   * TEST-ONLY: artificial delay (ms) injected into each unit of work.
   * Never enable in production.
   */
  readonly workDelayMs: number;
}

/**
 * Default string values for optional settings. Numeric and boolean settings
 * are validated after parsing, never coerced implicitly.
 */
const DEFAULTS = {
  PORT: '3000',
  MAX_ATTEMPTS: '5',
  CONCURRENCY: '3',
  BACKOFF_BASE_MS: '2000',
  BACKOFF_MAX_MS: '300000',
  STUCK_TIMEOUT_MS: '60000',
  SWEEP_INTERVAL_MS: '15000',
  POLL_INTERVAL_MS: '1000',
  /** TEST-ONLY */
  FAIL_RATE: '0',
  /** TEST-ONLY */
  CRASH_AFTER_WORK: 'false',
  /** TEST-ONLY */
  WORK_DELAY_MS: '0',
} as const;

/** Matches plain decimal numbers, optionally with an exponent. */
const NUMBER_PATTERN = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/** Truthy/falsy strings accepted for boolean settings. */
const TRUE_VALUES = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'n', 'off']);

/**
 * Parses an environment string into a finite number. Non numeric, empty and
 * non-finite values are rejected instead of being coerced.
 */
function numberField(name: string) {
  return z
    .string()
    .trim()
    .min(1, `${name} must not be empty`)
    .transform((value, ctx) => {
      if (!NUMBER_PATTERN.test(value)) {
        ctx.addIssue({
          code: 'custom',
          message: `${name} must be a number, received "${value}"`,
        });
        return z.NEVER;
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        ctx.addIssue({
          code: 'custom',
          message: `${name} must be a finite number, received "${value}"`,
        });
        return z.NEVER;
      }
      return parsed;
    });
}

/** Parses an environment string into a boolean. Anything unrecognised is rejected. */
function booleanField(name: string) {
  return z
    .string()
    .trim()
    .min(1, `${name} must not be empty`)
    .transform((value, ctx) => {
      const normalized = value.toLowerCase();
      if (TRUE_VALUES.has(normalized)) return true;
      if (FALSE_VALUES.has(normalized)) return false;
      ctx.addIssue({
        code: 'custom',
        message: `${name} must be a boolean (true or false), received "${value}"`,
      });
      return z.NEVER;
    });
}

const envSchema = z
  .object({
    DATABASE_URL: z
      .string()
      .trim()
      .min(1, 'DATABASE_URL is required and must not be empty'),
    PORT: numberField('PORT').pipe(
      z
        .number()
        .int('PORT must be an integer')
        .min(1, 'PORT must be greater than or equal to 1')
        .max(65535, 'PORT must be less than or equal to 65535'),
    ),
    MAX_ATTEMPTS: numberField('MAX_ATTEMPTS').pipe(
      z
        .number()
        .int('MAX_ATTEMPTS must be an integer')
        .min(1, 'MAX_ATTEMPTS must be greater than or equal to 1'),
    ),
    CONCURRENCY: numberField('CONCURRENCY').pipe(
      z
        .number()
        .int('CONCURRENCY must be an integer')
        .min(1, 'CONCURRENCY must be greater than or equal to 1'),
    ),
    BACKOFF_BASE_MS: numberField('BACKOFF_BASE_MS').pipe(
      z
        .number()
        .int('BACKOFF_BASE_MS must be an integer')
        .min(1, 'BACKOFF_BASE_MS must be greater than or equal to 1'),
    ),
    BACKOFF_MAX_MS: numberField('BACKOFF_MAX_MS').pipe(
      z
        .number()
        .int('BACKOFF_MAX_MS must be an integer')
        .min(1, 'BACKOFF_MAX_MS must be greater than or equal to 1'),
    ),
    STUCK_TIMEOUT_MS: numberField('STUCK_TIMEOUT_MS').pipe(
      z
        .number()
        .int('STUCK_TIMEOUT_MS must be an integer')
        .min(1, 'STUCK_TIMEOUT_MS must be greater than or equal to 1'),
    ),
    SWEEP_INTERVAL_MS: numberField('SWEEP_INTERVAL_MS').pipe(
      z
        .number()
        .int('SWEEP_INTERVAL_MS must be an integer')
        .min(1, 'SWEEP_INTERVAL_MS must be greater than or equal to 1'),
    ),
    POLL_INTERVAL_MS: numberField('POLL_INTERVAL_MS').pipe(
      z
        .number()
        .int('POLL_INTERVAL_MS must be an integer')
        .min(1, 'POLL_INTERVAL_MS must be greater than or equal to 1'),
    ),
    WORKER_ID: z
      .string()
      .trim()
      .min(1, 'WORKER_ID must not be empty'),
    /** TEST-ONLY */
    FAIL_RATE: numberField('FAIL_RATE').pipe(
      z
        .number()
        .min(0, 'FAIL_RATE must be greater than or equal to 0')
        .max(1, 'FAIL_RATE must be less than or equal to 1'),
    ),
    /** TEST-ONLY */
    CRASH_AFTER_WORK: booleanField('CRASH_AFTER_WORK'),
    /** TEST-ONLY */
    WORK_DELAY_MS: numberField('WORK_DELAY_MS').pipe(
      z
        .number()
        .int('WORK_DELAY_MS must be an integer')
        .min(0, 'WORK_DELAY_MS must be greater than or equal to 0'),
    ),
  })
  .superRefine((values, ctx) => {
    if (values.BACKOFF_MAX_MS < values.BACKOFF_BASE_MS) {
      ctx.addIssue({
        code: 'custom',
        path: ['BACKOFF_MAX_MS'],
        message:
          'BACKOFF_MAX_MS must be greater than or equal to BACKOFF_BASE_MS',
      });
    }
  });

/** Default worker identity: `<hostname>-<pid>`. */
export function defaultWorkerId(): string {
  return `${hostname()}-${process.pid}`;
}

/** Raw environment view used for configuration. */
export type Env = Record<string, string | undefined>;

/**
 * Returns the environment value, or the default when the variable is unset or
 * blank. A blank optional setting means "not configured" and therefore falls
 * back to its documented default.
 */
function pick(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

/**
 * Validates the given environment and returns the typed configuration.
 *
 * @throws {ConfigError} when the environment is invalid. The error message
 * never contains the value of `DATABASE_URL`.
 */
export function loadConfig(env: Env = process.env): Config {
  const raw = {
    DATABASE_URL: env.DATABASE_URL?.trim() ?? '',
    PORT: pick(env.PORT, DEFAULTS.PORT),
    MAX_ATTEMPTS: pick(env.MAX_ATTEMPTS, DEFAULTS.MAX_ATTEMPTS),
    CONCURRENCY: pick(env.CONCURRENCY, DEFAULTS.CONCURRENCY),
    BACKOFF_BASE_MS: pick(env.BACKOFF_BASE_MS, DEFAULTS.BACKOFF_BASE_MS),
    BACKOFF_MAX_MS: pick(env.BACKOFF_MAX_MS, DEFAULTS.BACKOFF_MAX_MS),
    STUCK_TIMEOUT_MS: pick(env.STUCK_TIMEOUT_MS, DEFAULTS.STUCK_TIMEOUT_MS),
    SWEEP_INTERVAL_MS: pick(env.SWEEP_INTERVAL_MS, DEFAULTS.SWEEP_INTERVAL_MS),
    POLL_INTERVAL_MS: pick(env.POLL_INTERVAL_MS, DEFAULTS.POLL_INTERVAL_MS),
    WORKER_ID: pick(env.WORKER_ID, defaultWorkerId()),
    FAIL_RATE: pick(env.FAIL_RATE, DEFAULTS.FAIL_RATE),
    CRASH_AFTER_WORK: pick(env.CRASH_AFTER_WORK, DEFAULTS.CRASH_AFTER_WORK),
    WORK_DELAY_MS: pick(env.WORK_DELAY_MS, DEFAULTS.WORK_DELAY_MS),
  };

  const result = envSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) =>
        issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
      ),
    );
  }

  const values = result.data;
  return Object.freeze({
    databaseUrl: values.DATABASE_URL,
    port: values.PORT,
    maxAttempts: values.MAX_ATTEMPTS,
    concurrency: values.CONCURRENCY,
    backoffBaseMs: values.BACKOFF_BASE_MS,
    backoffMaxMs: values.BACKOFF_MAX_MS,
    stuckTimeoutMs: values.STUCK_TIMEOUT_MS,
    sweepIntervalMs: values.SWEEP_INTERVAL_MS,
    pollIntervalMs: values.POLL_INTERVAL_MS,
    workerId: values.WORKER_ID,
    failRate: values.FAIL_RATE,
    crashAfterWork: values.CRASH_AFTER_WORK,
    workDelayMs: values.WORK_DELAY_MS,
  });
}
