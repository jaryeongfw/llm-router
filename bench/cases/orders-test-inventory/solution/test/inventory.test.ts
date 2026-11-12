import assert from "node:assert/strict";
import { test } from "node:test";
import { OutOfStockError, ValidationError } from "../src/errors.ts";
import { Inventory } from "../src/inventory.ts";

test("가용 수량 전부 예약 가능", () => {
  const inv = new Inventory({ A: 3 });
  inv.reserve("A", 3);
  assert.equal(inv.available("A"), 0);
});

test("초과 예약은 OutOfStockError, 필드 값 확인", () => {
  const inv = new Inventory({ A: 2 });
  assert.throws(() => inv.reserve("A", 5), (e: unknown) => e instanceof OutOfStockError && e.requested === 5 && e.available === 2);
  assert.equal(inv.available("A"), 2);
});

test("해제는 기존 수량에 더한다", () => {
  const inv = new Inventory({ A: 2 });
  inv.release("A", 3);
  assert.equal(inv.available("A"), 5);
});

test("0 이하 수량은 ValidationError", () => {
  const inv = new Inventory({ A: 2 });
  assert.throws(() => inv.reserve("A", 0), ValidationError);
  assert.throws(() => inv.release("A", 0), ValidationError);
  assert.throws(() => inv.release("A", -1), ValidationError);
});

test("모르는 SKU는 0", () => {
  assert.equal(new Inventory().available("X"), 0);
});
