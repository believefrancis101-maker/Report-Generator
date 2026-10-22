import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The CHECK constraints on `jobs` cannot be expressed in the Prisma schema
 * language, so they live in the hand-edited migration SQL. That SQL is the
 * source of truth - this suite fails if a migration is regenerated and the
 * constraints are lost.
 */
const MIGRATIONS_DIR = join(process.cwd(), 'prisma', 'migrations');

function readMigrations(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      sql: readFileSync(join(MIGRATIONS_DIR, entry.name, 'migration.sql'), 'utf8'),
    }));
}

describe('migration SQL', () => {
  const migrations = readMigrations();

  it('contains at least one migration', () => {
    expect(migrations.length).toBeGreaterThan(0);
  });

  it('keeps the jobs status CHECK constraint', () => {
    const sql = migrations.map((m) => m.sql).join('\n');
    expect(sql).toMatch(
      /ADD\s+CONSTRAINT\s+"?jobs_status_check"?\s+CHECK\s*\(\s*"?status"?\s+IN\s*\(\s*'pending'\s*,\s*'processing'\s*,\s*'succeeded'\s*,\s*'failed'\s*,\s*'dead'\s*\)/i,
    );
  });

  it('keeps the jobs attempts CHECK constraint', () => {
    const sql = migrations.map((m) => m.sql).join('\n');
    expect(sql).toMatch(
      /ADD\s+CONSTRAINT\s+"?jobs_attempts_check"?\s+CHECK\s*\(\s*"?attempts"?\s*>=\s*0\s*\)/i,
    );
  });

  it('keeps the jobs max_attempts CHECK constraint', () => {
    const sql = migrations.map((m) => m.sql).join('\n');
    expect(sql).toMatch(
      /ADD\s+CONSTRAINT\s+"?jobs_max_attempts_check"?\s+CHECK\s*\(\s*"?max_attempts"?\s*>\s*0\s*\)/i,
    );
  });

  it('keeps the job_runs outcome CHECK constraint', () => {
    const sql = migrations.map((m) => m.sql).join('\n');
    expect(sql).toMatch(
      /ADD\s+CONSTRAINT\s+"?job_runs_outcome_check"?\s+CHECK\s*\(\s*"?outcome"?\s+IS\s+NULL\s+OR\s+"?outcome"?\s+IN\s*\(\s*'succeeded'\s*,\s*'failed'\s*,\s*'crashed'\s*\)/i,
    );
  });

  it('keeps the db-generated uuid defaults for jobs, job_runs and reports', () => {
    const sql = migrations.map((m) => m.sql).join('\n');
    for (const table of ['jobs', 'job_runs', 'reports']) {
      expect(sql).toMatch(
        new RegExp(
          `ALTER\\s+TABLE\\s+"${table}"\\s+ALTER\\s+COLUMN\\s+"id"\\s+SET\\s+DEFAULT\\s+gen_random_uuid\\(\\)`,
          'i',
        ),
      );
    }
  });

  it('keeps the (status, run_at) index on jobs', () => {
    const sql = migrations.map((m) => m.sql).join('\n');
    expect(sql).toMatch(/CREATE\s+INDEX\s+"jobs_status_run_at_idx"\s+ON\s+"jobs"\("status",\s*"run_at"\)/i);
  });

  it('keeps the created_at index on sales_orders', () => {
    const sql = migrations.map((m) => m.sql).join('\n');
    expect(sql).toMatch(
      /CREATE\s+INDEX\s+"sales_orders_created_at_idx"\s+ON\s+"sales_orders"\("created_at"\)/i,
    );
  });

  it('creates the four tables', () => {
    const sql = migrations.map((m) => m.sql).join('\n');
    for (const table of ['jobs', 'job_runs', 'reports', 'sales_orders']) {
      expect(sql).toMatch(new RegExp(`CREATE\\s+TABLE\\s+"${table}"`, 'i'));
    }
  });
});
