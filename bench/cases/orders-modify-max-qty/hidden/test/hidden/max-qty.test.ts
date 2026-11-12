import assert from "node:assert/strict";
import { test } from "node:test";
import { Inventory, OrderRepository, OrderService, ValidationError } from "../../src/index.ts";

const customer = { id: "C1", tier: "BASIC" as const };

test("라인당 최대 수량 50", () => {
  const service = new OrderService(new Inventory({ A: 500 }), new OrderRepository());
  assert.doesNotThrow(() => service.placeOrder({ customer, lines: [{ sku: "A", unitPrice: 100, qty: 50 }] }));
  assert.throws(() => service.placeOrder({ customer, lines: [{ sku: "A", unitPrice: 100, qty: 51 }] }), ValidationError);
});
