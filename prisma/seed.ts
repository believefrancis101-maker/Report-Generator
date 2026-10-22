/**
 * Seed script - Stage 2.
 *
 * Fills `sales_orders` with 500,000 rows using a single
 * `INSERT ... SELECT ... FROM generate_series(...)` statement (no JS loop).
 *
 *   customer_name : 5,000 distinct names (50 first names x 100 last names)
 *   category      : 10 distinct categories
 *   created_at    : spread uniformly across the last 24 months
 *
 * Run with: npm run seed
 */
import { closePool, pool, withTransaction } from '../src/db.js';

const ROW_COUNT = 500_000;

const FIRST_NAMES = [
  'Ava', 'Liam', 'Noah', 'Emma', 'Olivia', 'Mia', 'Ethan', 'Sofia', 'Lucas', 'Amelia',
  'Mason', 'Isabella', 'Logan', 'Harper', 'Elijah', 'Layla', 'James', 'Zoe', 'Leo', 'Nora',
  'Henry', 'Ruby', 'Owen', 'Ivy', 'Jack', 'Stella', 'Wyatt', 'Alice', 'Ezra', 'Clara',
  'Caleb', 'Hannah', 'Nathan', 'Maya', 'Julian', 'Gabriel', 'Isaac', 'Lucy', 'Adrian', 'Sarah',
  'Irene', 'Damian', 'Felix', 'Julia', 'Hugo', 'Laura', 'Nina', 'Oscar', 'Pearl', 'Quinn',
] as const;

const LAST_NAMES = [
  'Anderson', 'Baker', 'Carter', 'Dawson', 'Ellis', 'Foster', 'Griffin', 'Hayes', 'Ingram', 'Jensen',
  'Kimball', 'Lawson', 'Mercer', 'Norris', 'Osborne', 'Palmer', 'Quinn', 'Reyes', 'Sullivan', 'Turner',
  'Underwood', 'Vargas', 'Walsh', 'Xiong', 'Young', 'Zimmerman', 'Abbott', 'Bishop', 'Chandler', 'Delgado',
  'Eastman', 'Farrell', 'Granger', 'Holloway', 'Iverson', 'Jacobs', 'Keller', 'Langford', 'Maddox', 'Norwood',
  'Oakley', 'Prescott', 'Radford', 'Sinclair', 'Thornton', 'Upton', 'Vasquez', 'Whitfield', 'Yates', 'Ainsworth',
  'Bramley', 'Copperfield', 'Dunmore', 'Ellery', 'Fairbanks', 'Glenwood', 'Harrow', 'Ironside', 'Jasper', 'Kingsley',
  'Lockhart', 'Marchetti', 'Nordstrom', 'Pemberton', 'Redmayne', 'Rushton', 'Stanhope', 'Trevelyan', 'Umbers', 'Vandermeer',
  'Westbrook', 'Yager', 'Zaragoza', 'Ashcombe', 'Bellamy', 'Cavendish', 'Devonshire', 'Ellsworth', 'Fitzgerald', 'Gallagher',
  'Hawthorne', 'Isherwood', 'Jamison', 'Kensington', 'Livingston', 'Montgomery', 'Nightingale', 'Orchard', 'Penrose', 'Quarry',
  'Ravenswood', 'Stonebridge', 'Ullswater', 'Verity', 'Weatherby', 'Yardley', 'Zennor', 'Ashworth', 'Bramwell', 'Crayford',
] as const;

const CATEGORIES = [
  'Electronics',
  'Home & Garden',
  'Sports & Outdoors',
  'Toys & Games',
  'Books',
  'Clothing',
  'Health & Beauty',
  'Automotive',
  'Grocery',
  'Office Supplies',
] as const;

/** Number of distinct customer names the insert produces: 50 x 100. */
const DISTINCT_CUSTOMERS = FIRST_NAMES.length * LAST_NAMES.length;

/** Renders a TS string array as a PostgreSQL ARRAY[...] literal. */
function sqlArray(values: readonly string[]): string {
  return `ARRAY[${values.map((value) => `'${value.replaceAll("'", "''")}'`).join(', ')}]`;
}

/** The bulk insert. A single statement generates every row server-side. */
const INSERT_SQL = `
INSERT INTO "sales_orders" ("id", "customer_name", "category", "amount_minor", "created_at")
SELECT
  gen_random_uuid(),
  (${sqlArray(FIRST_NAMES)})[1 + ((g.i - 1) % ${FIRST_NAMES.length})]
    || ' '
    || (${sqlArray(LAST_NAMES)})[1 + (((g.i - 1) / ${FIRST_NAMES.length}) % ${LAST_NAMES.length})],
  (${sqlArray(CATEGORIES)})[1 + ((g.i - 1) % ${CATEGORIES.length})],
  (100 + floor(random() * 499900))::int,
  now() - (random() * interval '24 months')
FROM generate_series(1, ${ROW_COUNT}) AS g(i)
`;

interface SeedStats {
  rows: string;
  distinct_customers: string;
  distinct_categories: string;
  min_created_at: Date;
  max_created_at: Date;
  total_amount_minor: string;
}

async function main(): Promise<void> {
  if (new Set(FIRST_NAMES).size !== FIRST_NAMES.length) {
    throw new Error('FIRST_NAMES must not contain duplicates');
  }
  if (new Set(LAST_NAMES).size !== LAST_NAMES.length) {
    throw new Error('LAST_NAMES must not contain duplicates');
  }

  const started = Date.now();
  console.log(
    `[seed] inserting ${ROW_COUNT.toLocaleString('en-US')} sales_orders ` +
      `(${DISTINCT_CUSTOMERS.toLocaleString('en-US')} distinct customers, ` +
      `${CATEGORIES.length} categories) ...`,
  );

  await withTransaction(async (client) => {
    await client.query('TRUNCATE TABLE "sales_orders"');
    await client.query(INSERT_SQL);
  });

  const { rows } = await pool.query<SeedStats>(`
    SELECT
      count(*)::text AS rows,
      count(DISTINCT "customer_name")::text AS distinct_customers,
      count(DISTINCT "category")::text AS distinct_categories,
      min("created_at") AS min_created_at,
      max("created_at") AS max_created_at,
      sum("amount_minor")::text AS total_amount_minor
    FROM "sales_orders"
  `);

  const stats = rows[0];
  if (!stats) throw new Error('seed verification returned no rows');

  if (Number(stats.rows) !== ROW_COUNT) {
    throw new Error(`expected ${ROW_COUNT} rows, found ${stats.rows}`);
  }
  if (Number(stats.distinct_customers) !== DISTINCT_CUSTOMERS) {
    throw new Error(
      `expected ${DISTINCT_CUSTOMERS} distinct customers, found ${stats.distinct_customers}`,
    );
  }
  if (Number(stats.distinct_categories) !== CATEGORIES.length) {
    throw new Error(
      `expected ${CATEGORIES.length} distinct categories, found ${stats.distinct_categories}`,
    );
  }

  console.log(`[seed] rows               : ${stats.rows}`);
  console.log(`[seed] distinct customers : ${stats.distinct_customers}`);
  console.log(`[seed] distinct categories: ${stats.distinct_categories}`);
  console.log(
    `[seed] created_at range    : ${stats.min_created_at.toISOString()} .. ${stats.max_created_at.toISOString()}`,
  );
  console.log(`[seed] total amount_minor : ${stats.total_amount_minor}`);
  console.log(`[seed] done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

try {
  await main();
} catch (error) {
  console.error('[seed] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await closePool();
}
