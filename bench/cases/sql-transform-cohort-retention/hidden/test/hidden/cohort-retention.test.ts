import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb, runQueryFile, runSql } from "../../src/db.ts";

type Row = { cohort: string; cohort_size: number; m1_retained: number; m2_retained: number };

function reference(db: ReturnType<typeof openDb>): Row[] {
  const customers = runSql(db, "SELECT id, signup_date FROM customers") as { id: string; signup_date: string }[];
  const active = new Set((runSql(db, "SELECT DISTINCT customer_id, substr(ordered_at,1,7) AS m FROM orders WHERE status='PAID'") as { customer_id: string; m: string }[]).map((r) => `${r.customer_id}|${r.m}`));
  const addMonth = (ym: string, k: number) => {
    const [y, m] = ym.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 1 + k, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  };
  const map = new Map<string, Row>();
  for (const c of customers) {
    const cohort = c.signup_date.slice(0, 7);
    const row = map.get(cohort) ?? { cohort, cohort_size: 0, m1_retained: 0, m2_retained: 0 };
    row.cohort_size++;
    if (active.has(`${c.id}|${addMonth(cohort, 1)}`)) row.m1_retained++;
    if (active.has(`${c.id}|${addMonth(cohort, 2)}`)) row.m2_retained++;
    map.set(cohort, row);
  }
  return [...map.values()].sort((a, b) => a.cohort.localeCompare(b.cohort));
}

test("cohort_retention.sql 결과가 기준과 같다", () => {
  const db = openDb();
  const got = runQueryFile("queries/cohort_retention.sql", db).map((r) => ({
    cohort: String(r.cohort), cohort_size: Number(r.cohort_size), m1_retained: Number(r.m1_retained), m2_retained: Number(r.m2_retained),
  }));
  assert.deepEqual(got, reference(db));
});
