import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Prisma CLI configuration.
 *
 * The datasource URL is taken from the environment (see `.env.example`). When
 * `DATABASE_URL` is absent the value from `prisma/schema.prisma` is used, so
 * `prisma generate` also works without a local `.env` file.
 */
const databaseUrl = process.env.DATABASE_URL;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  ...(databaseUrl ? { datasource: { url: databaseUrl } } : {}),
});
