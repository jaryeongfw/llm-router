import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb, runQueryFile, runSql } from "../../src/db.ts";

const REFERENCE = `
SELECT substr(o.ordered_at, 1, 7) AS month, c.name AS category, SUM(oi.qty * oi.unit_price) AS revenue
FROM orders o JOIN order_items oi ON oi.order_id = o.id
JOIN products p ON p.id = oi.product_id JOIN categories c ON c.id = p.category_id
WHERE o.status = 'PAID' GROUP BY 1, 2 ORDER BY 1, 2`;

test("monthly_category_revenue.sql 결과가 기준과 같다", () => {
  const db = openDb();
  const got = runQueryFile("queries/monthly_category_revenue.sql", db).map((r) => ({ month: r.month, category: r.category, revenue: Number(r.revenue) }));
  const want = runSql(db, REFERENCE).map((r) => ({ month: r.month, category: r.category, revenue: Number(r.revenue) }));
  assert.deepEqual(got, want);
});
