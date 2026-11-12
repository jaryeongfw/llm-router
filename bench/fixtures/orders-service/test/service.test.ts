import assert from "node:assert/strict";
import { test } from "node:test";
import { InvalidStateError, Inventory, OrderRepository, OrderService, OutOfStockError, ValidationError } from "../src/index.ts";

function setup() {
  const inventory = new Inventory({ A: 10, B: 5 });
  const service = new OrderService(inventory, new OrderRepository());
  return { inventory, service };
}

const customer = { id: "C1", tier: "BASIC" as const };

test("주문 생성 시 재고 예약", () => {
  const { inventory, service } = setup();
  const order = service.placeOrder({ customer, lines: [{ sku: "A", unitPrice: 1_000, qty: 3 }] });
  assert.equal(order.status, "PLACED");
  assert.equal(order.id, "O-0001");
  assert.equal(inventory.available("A"), 7);
});

test("재고 부족 시 OutOfStockError", () => {
  const { service } = setup();
  assert.throws(() => service.placeOrder({ customer, lines: [{ sku: "B", unitPrice: 1_000, qty: 6 }] }), OutOfStockError);
});

test("수량 0은 거부", () => {
  const { service } = setup();
  assert.throws(() => service.placeOrder({ customer, lines: [{ sku: "A", unitPrice: 1_000, qty: 0 }] }), ValidationError);
});

test("취소 시 재고 복구, 두 번 취소는 거부", () => {
  const { inventory, service } = setup();
  const order = service.placeOrder({ customer, lines: [{ sku: "A", unitPrice: 1_000, qty: 4 }] });
  service.cancelOrder(order.id);
  assert.equal(inventory.available("A"), 10);
  assert.throws(() => service.cancelOrder(order.id), InvalidStateError);
});
