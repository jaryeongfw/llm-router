import assert from "node:assert/strict";
import { test } from "node:test";
import { InvalidStateError, Inventory, OrderRepository, OrderService, ValidationError } from "../../src/index.ts";

function setup() {
  const inventory = new Inventory({ A: 10, B: 10 });
  const service = new OrderService(inventory, new OrderRepository());
  // 상품 합계 60,000, GOLD 5% = 3,000, 정액 쿠폰 4,000 → 상품 결제분 53,000
  const order = service.placeOrder({
    customer: { id: "C1", tier: "GOLD" },
    lines: [{ sku: "A", unitPrice: 10_000, qty: 2 }, { sku: "B", unitPrice: 20_000, qty: 2 }],
    coupon: { kind: "fixed", amount: 4_000, minOrder: 0 },
  });
  return { inventory, service, order };
}

test("부분 환불: 비례 배분 금액, 재고 해제, 상태", () => {
  const { inventory, service, order } = setup();
  const r = service.refundLines(order.id, [0]);
  assert.equal(r.refundAmount, Math.floor((20_000 * 53_000) / 60_000));
  assert.equal(r.order.status, "PARTIALLY_REFUNDED");
  assert.equal(inventory.available("A"), 10);
  assert.equal(inventory.available("B"), 8);
  assert.equal(service.getOrder(order.id).status, "PARTIALLY_REFUNDED");
});

test("나머지 라인 환불 시 REFUNDED, 배송비는 환불하지 않음", () => {
  const { service, order } = setup();
  service.refundLines(order.id, [0]);
  const r = service.refundLines(order.id, [1]);
  assert.equal(r.refundAmount, Math.floor((40_000 * 53_000) / 60_000));
  assert.equal(r.order.status, "REFUNDED");
});

test("이미 환불된 라인과 범위 밖 인덱스는 ValidationError", () => {
  const { service, order } = setup();
  service.refundLines(order.id, [1]);
  assert.throws(() => service.refundLines(order.id, [1]), ValidationError);
  assert.throws(() => service.refundLines(order.id, [5]), ValidationError);
});

test("취소된 주문은 InvalidStateError", () => {
  const { service, order } = setup();
  service.cancelOrder(order.id);
  assert.throws(() => service.refundLines(order.id, [0]), InvalidStateError);
});
