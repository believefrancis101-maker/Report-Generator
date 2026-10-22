import { describe, expect, it } from 'vitest';
import { hostname } from 'node:os';
import { ConfigError, defaultWorkerId, loadConfig, type Env } from '../src/config.js';

const VALID_DATABASE_URL = 'postgresql://report:report_local_dev@localhost:5432/report_generator?schema=public';

function env(overrides: Env = {}): Env {
  return { DATABASE_URL: VALID_DATABASE_URL, ...overrides };
}

function expectConfigError(overrides: Env): ConfigError {
  try {
    loadConfig(env(overrides));
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected loadConfig to throw a ConfigError');
}

describe('loadConfig - defaults', () => {
  it('applies every default when only DATABASE_URL is provided', () => {
    const config = loadConfig(env());

    expect(config.databaseUrl).toBe(VALID_DATABASE_URL);
    expect(config.port).toBe(3000);
    expect(config.maxAttempts).toBe(5);
    expect(config.concurrency).toBe(3);
    expect(config.backoffBaseMs).toBe(2000);
    expect(config.backoffMaxMs).toBe(300000);
    expect(config.stuckTimeoutMs).toBe(60000);
    expect(config.sweepIntervalMs).toBe(15000);
    expect(config.pollIntervalMs).toBe(1000);
    expect(config.workerId).toBe(defaultWorkerId());
    // TEST-ONLY defaults
    expect(config.failRate).toBe(0);
    expect(config.crashAfterWork).toBe(false);
    expect(config.workDelayMs).toBe(0);
  });

  it('derives the default worker id from hostname and pid', () => {
    expect(defaultWorkerId()).toBe(`${hostname()}-${process.pid}`);
    expect(loadConfig(env()).workerId).toBe(`${hostname()}-${process.pid}`);
  });
});

describe('loadConfig - typed parsing', () => {
  it('parses numeric environment strings into numbers', () => {
    const config = loadConfig(
      env({
        PORT: '8080',
        MAX_ATTEMPTS: '9',
        CONCURRENCY: '12',
        BACKOFF_BASE_MS: '100',
        BACKOFF_MAX_MS: '900000',
        STUCK_TIMEOUT_MS: '45000',
        SWEEP_INTERVAL_MS: '5000',
        POLL_INTERVAL_MS: '250',
        WORK_DELAY_MS: '1500',
      }),
    );

    expect(config.port).toBe(8080);
    expect(config.maxAttempts).toBe(9);
    expect(config.concurrency).toBe(12);
    expect(config.backoffBaseMs).toBe(100);
    expect(config.backoffMaxMs).toBe(900000);
    expect(config.stuckTimeoutMs).toBe(45000);
    expect(config.sweepIntervalMs).toBe(5000);
    expect(config.pollIntervalMs).toBe(250);
    expect(config.workDelayMs).toBe(1500);
    expect(typeof config.port).toBe('number');
  });

  it('parses boolean environment strings', () => {
    expect(loadConfig(env({ CRASH_AFTER_WORK: 'true' })).crashAfterWork).toBe(true);
    expect(loadConfig(env({ CRASH_AFTER_WORK: 'TRUE' })).crashAfterWork).toBe(true);
    expect(loadConfig(env({ CRASH_AFTER_WORK: '1' })).crashAfterWork).toBe(true);
    expect(loadConfig(env({ CRASH_AFTER_WORK: 'false' })).crashAfterWork).toBe(false);
    expect(loadConfig(env({ CRASH_AFTER_WORK: '0' })).crashAfterWork).toBe(false);
  });

  it('accepts a custom worker id', () => {
    expect(loadConfig(env({ WORKER_ID: 'worker-a' })).workerId).toBe('worker-a');
  });

  it('accepts a fractional fail rate inside the valid range', () => {
    expect(loadConfig(env({ FAIL_RATE: '0.25' })).failRate).toBe(0.25);
  });
});

describe('loadConfig - invalid environment', () => {
  it('rejects a missing DATABASE_URL', () => {
    const error = expectConfigError({ DATABASE_URL: undefined });
    expect(error.message).toContain('DATABASE_URL');
  });

  it('rejects an empty DATABASE_URL', () => {
    const error = expectConfigError({ DATABASE_URL: '' });
    expect(error.message).toContain('DATABASE_URL');
  });

  it('rejects a non-numeric PORT', () => {
    const error = expectConfigError({ PORT: 'abc' });
    expect(error.message).toContain('PORT must be a number');
  });

  it('rejects a non-finite PORT', () => {
    const error = expectConfigError({ PORT: 'Infinity' });
    expect(error.message).toContain('PORT');
  });

  it('rejects a non-integer PORT', () => {
    const error = expectConfigError({ PORT: '3000.5' });
    expect(error.message).toContain('PORT must be an integer');
  });

  it('rejects an out-of-range PORT', () => {
    expect(expectConfigError({ PORT: '0' }).message).toContain('PORT');
    expect(expectConfigError({ PORT: '65536' }).message).toContain('PORT');
  });

  it('rejects a non-positive MAX_ATTEMPTS', () => {
    expect(expectConfigError({ MAX_ATTEMPTS: '0' }).message).toContain('MAX_ATTEMPTS');
  });

  it('rejects a non-positive CONCURRENCY', () => {
    expect(expectConfigError({ CONCURRENCY: '0' }).message).toContain('CONCURRENCY');
  });

  it('rejects non-positive timing settings', () => {
    expect(expectConfigError({ POLL_INTERVAL_MS: '0' }).message).toContain('POLL_INTERVAL_MS');
    expect(expectConfigError({ SWEEP_INTERVAL_MS: '0' }).message).toContain('SWEEP_INTERVAL_MS');
    expect(expectConfigError({ STUCK_TIMEOUT_MS: '0' }).message).toContain('STUCK_TIMEOUT_MS');
    expect(expectConfigError({ BACKOFF_BASE_MS: '0' }).message).toContain('BACKOFF_BASE_MS');
  });

  it('rejects a FAIL_RATE outside 0..1', () => {
    expect(expectConfigError({ FAIL_RATE: '1.5' }).message).toContain('FAIL_RATE');
    expect(expectConfigError({ FAIL_RATE: '-0.1' }).message).toContain('FAIL_RATE');
  });

  it('rejects an invalid boolean', () => {
    const error = expectConfigError({ CRASH_AFTER_WORK: 'maybe' });
    expect(error.message).toContain('CRASH_AFTER_WORK must be a boolean');
  });

  it('rejects a negative WORK_DELAY_MS', () => {
    expect(expectConfigError({ WORK_DELAY_MS: '-1' }).message).toContain('WORK_DELAY_MS');
  });

  it('falls back to the default worker id when WORKER_ID is blank', () => {
    expect(loadConfig(env({ WORKER_ID: '' })).workerId).toBe(defaultWorkerId());
    expect(loadConfig(env({ WORKER_ID: '   ' })).workerId).toBe(defaultWorkerId());
  });

  it('falls back to defaults for blank optional settings', () => {
    const config = loadConfig(
      env({ PORT: '', MAX_ATTEMPTS: '', CONCURRENCY: '', FAIL_RATE: '' }),
    );
    expect(config.port).toBe(3000);
    expect(config.maxAttempts).toBe(5);
    expect(config.concurrency).toBe(3);
    expect(config.failRate).toBe(0);
  });

  it('rejects a backoff configuration where the maximum is below the base', () => {
    const error = expectConfigError({ BACKOFF_BASE_MS: '5000', BACKOFF_MAX_MS: '1000' });
    expect(error.message).toContain('BACKOFF_MAX_MS');
  });

  it('accepts a backoff configuration where the maximum equals the base', () => {
    const config = loadConfig(env({ BACKOFF_BASE_MS: '5000', BACKOFF_MAX_MS: '5000' }));
    expect(config.backoffBaseMs).toBe(5000);
    expect(config.backoffMaxMs).toBe(5000);
  });

  it('reports every problem at once', () => {
    const error = expectConfigError({ PORT: 'abc', CONCURRENCY: '0' });
    expect(error.issues.length).toBeGreaterThanOrEqual(2);
  });
});

describe('loadConfig - secret handling', () => {
  it('never leaks the database URL in error messages', () => {
    const secretUrl = 'postgresql://user:super-secret-password@db.internal:5432/secret_db';
    let message = '';
    try {
      loadConfig({ DATABASE_URL: secretUrl, PORT: 'not-a-port' });
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      message = error.message;
    }

    expect(message).not.toContain('super-secret-password');
    expect(message).not.toContain(secretUrl);
  });

  it('keeps the database URL out of the config error issues', () => {
    const error = expectConfigError({
      DATABASE_URL: 'https://example.com/hook?token=abc123',
      PORT: 'abc',
    });
    expect(error.issues.join(' ')).not.toContain('abc123');
    expect(error.issues.join(' ')).not.toContain('example.com');
  });
});
