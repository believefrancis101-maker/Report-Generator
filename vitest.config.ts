import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    reporters: ['verbose'],
    // The test files that talk to the database share one PostgreSQL
    // instance, so they must not run at the same time.
    fileParallelism: false,
    // The worker tests run many real transactions; on a container volume
    // every commit waits for an fsync, which is slower than the default 5s.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
