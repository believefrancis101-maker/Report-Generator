import { describe, expect, it } from 'vitest';
import { backoffDelayMs } from '../src/backoff.js';

const OPTIONS = { baseMs: 100, maxMs: 10_000 };

describe('backoffDelayMs', () => {
  it('waits about the base delay for the first retry', () => {
    expect(backoffDelayMs(1, OPTIONS, () => 0)).toBe(100);
    expect(backoffDelayMs(1, OPTIONS, () => 0.99)).toBeLessThan(150);
  });

  it('grows with the failure count', () => {
    const delays = [1, 2, 3, 4, 5].map((failureCount) =>
      backoffDelayMs(failureCount, OPTIONS, () => 0),
    );

    expect(delays).toEqual([100, 200, 400, 800, 1600]);
    for (let index = 1; index < delays.length; index += 1) {
      expect(delays[index]!).toBeGreaterThan(delays[index - 1]!);
    }
  });

  it('is capped at maxMs', () => {
    expect(backoffDelayMs(20, OPTIONS, () => 1)).toBe(OPTIONS.maxMs);
    expect(backoffDelayMs(20, OPTIONS, () => 0.99)).toBe(OPTIONS.maxMs);
  });

  it('returns different delays for the same input with different randomness', () => {
    const low = backoffDelayMs(3, OPTIONS, () => 0.1);
    const high = backoffDelayMs(3, OPTIONS, () => 0.9);

    expect(low).not.toBe(high);
    expect(low).toBe(400 + Math.floor(0.1 * 400 * 0.5));
    expect(high).toBe(400 + Math.floor(0.9 * 400 * 0.5));
  });

  it('returns exactly the exponential part when random() is 0', () => {
    expect(backoffDelayMs(1, OPTIONS, () => 0)).toBe(100);
    expect(backoffDelayMs(2, OPTIONS, () => 0)).toBe(200);
    expect(backoffDelayMs(5, OPTIONS, () => 0)).toBe(1600);
  });

  it('keeps the jitter below 50% of the exponential part', () => {
    const exponential = 800;
    const delay = backoffDelayMs(4, OPTIONS, () => 0.999999);

    expect(delay).toBeGreaterThanOrEqual(exponential);
    expect(delay).toBeLessThan(exponential + exponential * 0.5);
  });

  it('never returns a negative delay', () => {
    expect(backoffDelayMs(0, OPTIONS, () => 0)).toBe(100);
    expect(backoffDelayMs(-3, OPTIONS, () => 0)).toBe(100);
  });
});
