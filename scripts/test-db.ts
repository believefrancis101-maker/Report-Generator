import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

/**
 * Prepares the dedicated test database.
 *
 * Creates `report_generator_test` (from `DATABASE_URL_TEST`) in the same
 * PostgreSQL server when it is missing, then applies the Prisma migrations to
 * it with `prisma migrate deploy`. Safe to run any number of times.
 *
 * The development database is never touched: the admin connection only reads
 * `pg_database`, and the migration step receives the test URL.
 */

const testUrl = process.env.DATABASE_URL_TEST?.trim();
if (!testUrl) {
  console.error(
    'DATABASE_URL_TEST is not set. Add it to .env (see .env.example).',
  );
  process.exit(1);
}

let parsed: URL;
try {
  parsed = new URL(testUrl);
} catch {
  console.error('DATABASE_URL_TEST is not a valid PostgreSQL URL.');
  process.exit(1);
}

const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
if (databaseName === '') {
  console.error('DATABASE_URL_TEST must name a database.');
  process.exit(1);
}

/** Quotes an identifier for the few statements that cannot be parameterised. */
function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** Connects to the `postgres` maintenance database on the same server. */
function adminUrl(): string {
  const url = new URL(testUrl!);
  url.pathname = '/postgres';
  url.search = '';
  return url.toString();
}

async function createDatabaseIfMissing(): Promise<void> {
  const admin = new Client({
    connectionString: adminUrl(),
    connectionTimeoutMillis: 10_000,
  });

  try {
    await admin.connect();
  } catch (error) {
    console.error(
      `Could not reach PostgreSQL. Is the container running (docker compose up -d)? ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exit(1);
  }

  try {
    const existing = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [databaseName],
    );

    if (existing.rowCount === 0) {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      console.log(`created database ${databaseName}`);
    } else {
      console.log(`database ${databaseName} already exists`);
    }
  } finally {
    await admin.end();
  }
}

/** Applies the migrations to the test database. */
function migrate(): void {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const prismaCli = join(root, 'node_modules', 'prisma', 'build', 'index.js');

  const result = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: testUrl },
  });

  if (result.error) {
    console.error(`Could not run the migrations: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error('Applying the migrations failed.');
    process.exit(result.status ?? 1);
  }
}

await createDatabaseIfMissing();
migrate();
console.log(`test database ready: ${databaseName}`);
