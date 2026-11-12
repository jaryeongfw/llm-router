import assert from "node:assert/strict";
import { test } from "node:test";
import { Inventory, OrderRepository, OrderService, OutOfStockError } from "../../src/index.ts";

test("재고 부족 메시지에 SKU, 요청 수량, 가용 수량 포함", () => {
  const service = new OrderService(new Inventory({ "SKU-9": 2 }), new OrderRepository());
  assert.throws(
    () => service.placeOrder({ customer: { id: "C1", tier: "BASIC" }, lines: [{ sku: "SKU-9", unitPrice: 100, qty: 5 }] }),
    (err: unknown) => err instanceof OutOfStockError && err.message === "재고 부족: SKU-9 (요청 5, 가용 2)"
      && err.sku === "SKU-9" && err.requested === 5 && err.available === 2,
  );
});
