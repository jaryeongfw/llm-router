import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb, runQueryFile, runSql } from "../../src/db.ts";

const REFERENCE = `
SELECT o.customer_id, COUNT(DISTINCT o.id) AS order_count, SUM(oi.qty * oi.unit_price) AS amount
FROM orders o JOIN order_items oi ON oi.order_id = o.id
WHERE o.status = 'PAID' GROUP BY o.customer_id ORDER BY amount DESC, o.customer_id LIMIT 5`;

test("top_customers.sql은 취소 주문을 제외한다", () => {
  const db = openDb();
  const norm = (rows: Record<string, unknown>[]) => rows.map((r) => ({ id: r.customer_id, n: Number(r.order_count), amount: Number(r.amount) }));
  assert.deepEqual(norm(runQueryFile("queries/top_customers.sql", db)), norm(runSql(db, REFERENCE)));
});
