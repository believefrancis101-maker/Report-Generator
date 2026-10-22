import { z } from 'zod';
import { deriveIdempotencyKey } from './idempotency.js';

/**
 * Request validation for the enqueue endpoint.
 */

/** True when the string is a real calendar date (rejects e.g. 2024-02-30). */
function isCalendarDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) return false;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date in YYYY-MM-DD format')
  .refine(isCalendarDate, 'must be a valid calendar date');

/** The job types the API accepts. */
export const jobTypeSchema = z.literal('sales_report');

export const enqueueRequestSchema = z
  .object({
    type: jobTypeSchema,
    payload: z
      .object({
        dateFrom: isoDate,
        dateTo: isoDate,
      })
      .strict(),
    idempotencyKey: z
      .string()
      .trim()
      .min(1, 'must not be empty')
      .max(255, 'must be at most 255 characters')
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // ISO dates (YYYY-MM-DD) sort chronologically as plain strings.
    if (value.payload.dateFrom > value.payload.dateTo) {
      ctx.addIssue({
        code: 'custom',
        path: ['payload', 'dateTo'],
        message: 'dateTo must be on or after dateFrom',
      });
    }
  });

/** A validated enqueue request, including the effective idempotency key. */
export interface EnqueueRequest {
  type: 'sales_report';
  payload: { dateFrom: string; dateTo: string };
  idempotencyKey: string;
}

/** A single, human readable problem with the request. */
export interface RequestIssue {
  path: string;
  message: string;
}

export type ParseEnqueueResult =
  | { ok: true; value: EnqueueRequest }
  | { ok: false; issues: RequestIssue[] };

function toIssue(issue: z.core.$ZodIssue): RequestIssue {
  return {
    path: issue.path.map((segment) => String(segment)).join('.'),
    message: issue.message,
  };
}

/**
 * Validates the request body and resolves the effective idempotency key.
 *
 * Precedence: `Idempotency-Key` header, then `idempotencyKey` in the body,
 * then a key derived from the type and the canonicalised payload.
 */
export function parseEnqueueRequest(
  body: unknown,
  headerKey: string | undefined,
): ParseEnqueueResult {
  const parsed = enqueueRequestSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map(toIssue) };
  }

  const header = headerKey?.trim();
  const bodyKey = parsed.data.idempotencyKey;

  if (header && bodyKey && header !== bodyKey) {
    return {
      ok: false,
      issues: [
        {
          path: 'idempotencyKey',
          message:
            'idempotencyKey in the body conflicts with the Idempotency-Key header',
        },
      ],
    };
  }

  const idempotencyKey =
    header ||
    bodyKey ||
    deriveIdempotencyKey(parsed.data.type, parsed.data.payload);

  return {
    ok: true,
    value: {
      type: parsed.data.type,
      payload: parsed.data.payload,
      idempotencyKey,
    },
  };
}
