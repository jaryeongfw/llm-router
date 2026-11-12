import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb, runQueryFile, runSql } from "../../src/db.ts";

test("고객별 ltv와 items가 원천 데이터와 일치", () => {
  const db = openDb();
  const got = runQueryFile("queries/customer_ltv.sql", db).map((r) => ({ id: r.customer_id, ltv: Number(r.ltv), items: Number(r.items) }));
  const pay = new Map((runSql(db, "SELECT o.customer_id AS id, SUM(p.amount) AS s FROM orders o JOIN payments p ON p.order_id=o.id WHERE o.status='PAID' GROUP BY 1") as { id: string; s: number }[]).map((r) => [r.id, Number(r.s)]));
  const qty = new Map((runSql(db, "SELECT o.customer_id AS id, SUM(oi.qty) AS s FROM orders o JOIN order_items oi ON oi.order_id=o.id WHERE o.status='PAID' GROUP BY 1") as { id: string; s: number }[]).map((r) => [r.id, Number(r.s)]));
  const ids = (runSql(db, "SELECT id FROM customers ORDER BY id") as { id: string }[]).map((r) => r.id);
  assert.deepEqual(got, ids.map((id) => ({ id, ltv: pay.get(id) ?? 0, items: qty.get(id) ?? 0 })));
});
