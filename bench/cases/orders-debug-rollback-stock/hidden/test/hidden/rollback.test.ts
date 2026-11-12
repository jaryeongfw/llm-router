import assert from "node:assert/strict";
import { test } from "node:test";
import { Inventory, OrderRepository, OrderService, OutOfStockError } from "../../src/index.ts";

const customer = { id: "C1", tier: "BASIC" as const };

test("재고 부족으로 실패한 주문은 모든 재고를 원래대로 둔다", () => {
  const inventory = new Inventory({ A: 10, B: 5, C: 2 });
  const service = new OrderService(inventory, new OrderRepository());
  assert.throws(
    () => service.placeOrder({ customer, lines: [
      { sku: "A", unitPrice: 1_000, qty: 3 },
      { sku: "B", unitPrice: 1_000, qty: 6 },
      { sku: "C", unitPrice: 1_000, qty: 1 },
    ] }),
    OutOfStockError,
  );
  assert.deepEqual([inventory.available("A"), inventory.available("B"), inventory.available("C")], [10, 5, 2]);
});

test("첫 라인부터 실패해도 재고 불변", () => {
  const inventory = new Inventory({ A: 1 });
  const service = new OrderService(inventory, new OrderRepository());
  assert.throws(() => service.placeOrder({ customer, lines: [{ sku: "A", unitPrice: 1_000, qty: 2 }] }));
  assert.equal(inventory.available("A"), 1);
});
