import { createHash } from 'node:crypto';

/**
 * Idempotency keys.
 *
 * A client may supply a key (request body or `Idempotency-Key` header). When
 * it does not, one is derived from the request itself so that identical
 * requests collapse onto a single job.
 */

/**
 * Canonical JSON serialisation: object keys are sorted, `undefined` members
 * are dropped. `{ a, b }` and `{ b, a }` therefore produce the same string.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`);
  return `{${entries.join(',')}}`;
}

/**
 * Derives a stable key from the job type and its payload.
 *
 * The payload is serialised with sorted keys, so key order never changes the
 * result.
 */
export function deriveIdempotencyKey(type: string, payload: unknown): string {
  const material = `${type}:${canonicalJson(payload)}`;
  return `auto:${createHash('sha256').update(material, 'utf8').digest('hex')}`;
}
