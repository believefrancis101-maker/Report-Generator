import type { Pool } from 'pg';

/**
 * The aggregation behind a sales report.
 *
 * All date arithmetic happens in the database and in UTC: the range is
 * inclusive, `created_at >= dateFrom` and `created_at < dateTo + 1 day`.
 */

export interface SalesReportParams {
  dateFrom: string;
  dateTo: string;
}

export interface CategoryMonthRow {
  month: string;
  category: string;
  revenueMinor: number;
  orders: number;
  customers: number;
  topCustomer: string | null;
}

export interface TopCustomerRow {
  rank: number;
  customerName: string;
  revenueMinor: number;
  orders: number;
}

export interface GrowthCategoryRow {
  category: string;
  revenueMinor: number;
  sharePct: number;
}

export interface GrowthRow {
  month: string;
  revenueMinor: number;
  orders: number;
  prevRevenueMinor: number | null;
  growthPct: number | null;
  categories: GrowthCategoryRow[];
}

export interface SalesAnalysis {
  totals: { revenueMinor: number; orders: number };
  byCategoryMonth: CategoryMonthRow[];
  topCustomers: TopCustomerRow[];
  growth: GrowthRow[];
}

/** The aggregation is injectable, so the tests can spy on it. */
export type AggregateFunction = (
  db: Pool,
  params: SalesReportParams,
) => Promise<SalesAnalysis>;

/** The reporting period, expressed as a UTC range. */
const RANGE_SQL = `
  "created_at" >= ($1::date::timestamp AT TIME ZONE 'UTC')
  AND "created_at" <  (($2::date + 1)::timestamp AT TIME ZONE 'UTC')
`;

/** Revenue and order count by category by month (UTC). */
const TOTALS_AND_CATEGORY_MONTH_SQL = `
WITH filtered AS (
    SELECT
        "customer_name",
        "category",
        "amount_minor",
        date_trunc('month', "created_at" AT TIME ZONE 'UTC') AS month
    FROM "sales_orders"
    WHERE ${RANGE_SQL}
),
category_month AS (
    SELECT
        month,
        category,
        SUM("amount_minor")::bigint AS revenue_minor,
        COUNT(*)::bigint AS orders,
        COUNT(DISTINCT "customer_name")::bigint AS customers
    FROM filtered
    GROUP BY month, category
),
category_customer AS (
    SELECT
        month,
        category,
        "customer_name",
        SUM("amount_minor")::bigint AS spend_minor,
        ROW_NUMBER() OVER (
            PARTITION BY month, category
            ORDER BY SUM("amount_minor") DESC, "customer_name"
        ) AS rank_in_category
    FROM filtered
    GROUP BY month, category, "customer_name"
)
SELECT
    to_char(cm.month, 'YYYY-MM') AS month,
    cm.category,
    cm.revenue_minor,
    cm.orders,
    cm.customers,
    cc."customer_name" AS top_customer
FROM category_month cm
LEFT JOIN category_customer cc
    ON cc.month = cm.month
   AND cc.category = cm.category
   AND cc.rank_in_category = 1
ORDER BY cm.month, cm.revenue_minor DESC, cm.category
`;

/** The totals of the whole period. */
const TOTALS_SQL = `
SELECT
    COALESCE(SUM("amount_minor"), 0)::bigint AS revenue_minor,
    COUNT(*)::bigint AS orders
FROM "sales_orders"
WHERE ${RANGE_SQL}
`;

/** The ten customers with the highest spend, with their rank. */
const TOP_CUSTOMERS_SQL = `
WITH spend AS (
    SELECT
        "customer_name",
        SUM("amount_minor")::bigint AS revenue_minor,
        COUNT(*)::bigint AS orders
    FROM "sales_orders"
    WHERE ${RANGE_SQL}
    GROUP BY "customer_name"
)
SELECT
    ROW_NUMBER() OVER (ORDER BY revenue_minor DESC, "customer_name") AS rank,
    "customer_name",
    revenue_minor,
    orders
FROM spend
ORDER BY revenue_minor DESC, "customer_name"
LIMIT 10
`;

/**
 * Month over month growth (via `lag()`) and the share every category has of
 * the revenue of its month (via a window function).
 */
const GROWTH_SQL = `
WITH filtered AS (
    SELECT
        "category",
        "amount_minor",
        date_trunc('month', "created_at" AT TIME ZONE 'UTC') AS month
    FROM "sales_orders"
    WHERE ${RANGE_SQL}
),
monthly AS (
    SELECT
        month,
        category,
        SUM("amount_minor")::bigint AS revenue_minor,
        COUNT(*)::bigint AS orders
    FROM filtered
    GROUP BY month, category
),
month_totals AS (
    SELECT
        month,
        SUM(revenue_minor)::bigint AS month_revenue_minor,
        SUM(orders)::bigint AS month_orders
    FROM monthly
    GROUP BY month
),
growth AS (
    SELECT
        month,
        month_revenue_minor,
        month_orders,
        LAG(month_revenue_minor) OVER (ORDER BY month) AS prev_month_revenue_minor,
        LAG(month_orders) OVER (ORDER BY month) AS prev_month_orders
    FROM month_totals
)
SELECT
    to_char(m.month, 'YYYY-MM') AS month,
    m.category,
    m.revenue_minor,
    m.orders,
    g.month_revenue_minor,
    g.prev_month_revenue_minor,
    CASE
        WHEN g.prev_month_revenue_minor IS NULL OR g.prev_month_revenue_minor = 0 THEN NULL
        ELSE ROUND(
            (g.month_revenue_minor - g.prev_month_revenue_minor)::numeric * 100
            / g.prev_month_revenue_minor, 2
        )
    END AS growth_pct,
    CASE
        WHEN g.month_revenue_minor = 0 THEN 0
        ELSE ROUND(m.revenue_minor::numeric * 100 / g.month_revenue_minor, 2)
    END AS share_pct
FROM monthly m
JOIN growth g ON g.month = m.month
ORDER BY m.month, m.revenue_minor DESC, m.category
`;

/** Formats a UTC month start as `YYYY-MM`. */
function monthKey(value: Date | string): string {
  if (typeof value === 'string') return value;
  return value.toISOString().slice(0, 7);
}

function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'number' ? value : Number(value);
}

/**
 * Runs the analysis for a reporting period.
 */
export const aggregateSalesReport: AggregateFunction = async (db, params) => {
  const [totalsResult, categoryMonthResult, topCustomersResult, growthResult] =
    await Promise.all([
      db.query<{ revenue_minor: string; orders: string }>(TOTALS_SQL, [
        params.dateFrom,
        params.dateTo,
      ]),
      db.query<{
        month: Date;
        category: string;
        revenue_minor: string;
        orders: string;
        customers: string;
        top_customer: string | null;
      }>(TOTALS_AND_CATEGORY_MONTH_SQL, [params.dateFrom, params.dateTo]),
      db.query<{
        rank: string;
        customer_name: string;
        revenue_minor: string;
        orders: string;
      }>(TOP_CUSTOMERS_SQL, [params.dateFrom, params.dateTo]),
      db.query<{
        month: Date;
        category: string;
        revenue_minor: string;
        orders: string;
        month_revenue_minor: string;
        prev_month_revenue_minor: string | null;
        growth_pct: string | null;
        share_pct: string;
      }>(GROWTH_SQL, [params.dateFrom, params.dateTo]),
    ]);

  const totalsRow = totalsResult.rows[0];
  const totals = {
    revenueMinor: toNumber(totalsRow?.revenue_minor),
    orders: toNumber(totalsRow?.orders),
  };

  const byCategoryMonth: CategoryMonthRow[] = categoryMonthResult.rows.map(
    (row) => ({
      month: monthKey(row.month),
      category: row.category,
      revenueMinor: toNumber(row.revenue_minor),
      orders: toNumber(row.orders),
      customers: toNumber(row.customers),
      topCustomer: row.top_customer,
    }),
  );

  const topCustomers: TopCustomerRow[] = topCustomersResult.rows.map((row) => ({
    rank: toNumber(row.rank),
    customerName: row.customer_name,
    revenueMinor: toNumber(row.revenue_minor),
    orders: toNumber(row.orders),
  }));

  // The growth rows are one per month, with the category breakdown of that
  // month attached.
  const growthByMonth = new Map<string, GrowthRow>();
  for (const row of growthResult.rows) {
    const month = monthKey(row.month);
    let entry = growthByMonth.get(month);
    if (!entry) {
      entry = {
        month,
        revenueMinor: toNumber(row.month_revenue_minor),
        orders: toNumber(row.orders),
        prevRevenueMinor:
          row.prev_month_revenue_minor === null
            ? null
            : toNumber(row.prev_month_revenue_minor),
        growthPct:
          row.growth_pct === null ? null : Number(Number(row.growth_pct).toFixed(2)),
        categories: [],
      };
      growthByMonth.set(month, entry);
    }
    entry.categories.push({
      category: row.category,
      revenueMinor: toNumber(row.revenue_minor),
      sharePct: Number(Number(row.share_pct).toFixed(2)),
    });
  }

  const growth: GrowthRow[] = [...growthByMonth.values()].sort((left, right) =>
    left.month < right.month ? -1 : left.month > right.month ? 1 : 0,
  );

  return { totals, byCategoryMonth, topCustomers, growth };
};
