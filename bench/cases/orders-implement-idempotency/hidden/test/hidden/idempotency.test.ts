import assert from "node:assert/strict";
import { test } from "node:test";
import * as api from "../../src/index.ts";
import { Inventory, OrderRepository, OrderService } from "../../src/index.ts";

const customer = { id: "C1", tier: "BASIC" as const };
const lines = [{ sku: "A", unitPrice: 1_000, qty: 2 }];

function setup(stock = 10) {
  const inventory = new Inventory({ A: stock });
  const repo = new OrderRepository();
  return { inventory, repo, service: new OrderService(inventory, repo) };
}

test("IdempotencyConflictError를 index에서 export", () => {
  assert.equal(typeof (api as Record<string, unknown>).IdempotencyConflictError, "function");
});

test("같은 키와 같은 내용은 같은 주문, 재예약 없음", () => {
  const { inventory, repo, service } = setup();
  const a = service.placeOrder({ customer, lines }, { idempotencyKey: "k1" });
  const b = service.placeOrder({ customer, lines: [{ sku: "A", unitPrice: 1_000, qty: 2 }] }, { idempotencyKey: "k1" });
  assert.equal(a.id, b.id);
  assert.equal(inventory.available("A"), 8);
  assert.equal(repo.count(), 1);
});

test("같은 키와 다른 내용은 충돌 오류", () => {
  const { service } = setup();
  service.placeOrder({ customer, lines }, { idempotencyKey: "k1" });
  const Conflict = (api as Record<string, unknown>).IdempotencyConflictError as new (...a: never[]) => Error;
  assert.throws(() => service.placeOrder({ customer, lines: [{ sku: "A", unitPrice: 1_000, qty: 3 }] }, { idempotencyKey: "k1" }), Conflict);
});

test("키 없이 호출하면 매번 새 주문", () => {
  const { repo, service } = setup();
  service.placeOrder({ customer, lines });
  service.placeOrder({ customer, lines });
  assert.equal(repo.count(), 2);
});

test("실패한 요청은 키를 소비하지 않음", () => {
  const { inventory, service } = setup(1);
  assert.throws(() => service.placeOrder({ customer, lines }, { idempotencyKey: "k2" }));
  inventory.release("A", 5);
  const order = service.placeOrder({ customer, lines }, { idempotencyKey: "k2" });
  assert.equal(order.status, "PLACED");
});
