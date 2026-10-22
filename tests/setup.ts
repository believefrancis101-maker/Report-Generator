import 'dotenv/config';

/**
 * Runs before every test file, so it executes before `src/db.ts` is imported
 * and builds the shared pool from `DATABASE_URL`.
 *
 * The suite must never touch the development database: it inserts and deletes
 * jobs, runs and reports, and the worker tests drive real claims. Everything is
 * pointed at `DATABASE_URL_TEST` instead.
 */
const testUrl = process.env.DATABASE_URL_TEST?.trim();
const devUrl = process.env.DATABASE_URL?.trim();

if (!testUrl) {
  throw new Error(
    'DATABASE_URL_TEST is not set. Add it to .env (see .env.example), then run `npm run test:setup`.',
  );
}

/** `host:port/database` - credentials and query parameters are irrelevant. */
function databaseIdentity(url: string): string | null {
  try {
    const parsed = new URL(url);
    const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
    return `${parsed.hostname}:${parsed.port || '5432'}/${database}`;
  } catch {
    return null;
  }
}

const testIdentity = databaseIdentity(testUrl);
const devIdentity = devUrl ? databaseIdentity(devUrl) : null;

if (testIdentity !== null && testIdentity === devIdentity) {
  throw new Error(
    'DATABASE_URL_TEST points at the same database as DATABASE_URL. The test suite must not touch the development database.',
  );
}

process.env.DATABASE_URL = testUrl;
