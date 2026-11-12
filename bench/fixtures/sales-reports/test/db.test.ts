import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb, runQueryFile, runSql } from "../src/db.ts";

test("시드 데이터 적재", () => {
  const db = openDb();
  const [row] = runSql(db, "SELECT COUNT(*) AS n FROM customers");
  assert.equal(row.n, 16);
});

test("결제 합계는 PAID 주문 금액과 같다", () => {
  const db = openDb();
  const [a] = runSql(db, "SELECT SUM(amount) AS s FROM payments");
  const [b] = runSql(db, "SELECT SUM(oi.qty * oi.unit_price) AS s FROM orders o JOIN order_items oi ON oi.order_id = o.id WHERE o.status = 'PAID'");
  assert.equal(a.s, b.s);
});

test("top_customers는 5행", () => {
  assert.equal(runQueryFile("queries/top_customers.sql").length, 5);
});

test("customer_ltv 합계는 결제 합계와 같다", () => {
  const db = openDb();
  const rows = runQueryFile("queries/customer_ltv.sql", db);
  const total = rows.reduce((s, r) => s + Number(r.ltv), 0);
  const [p] = runSql(db, "SELECT SUM(amount) AS s FROM payments");
  assert.equal(total, p.s);
});
