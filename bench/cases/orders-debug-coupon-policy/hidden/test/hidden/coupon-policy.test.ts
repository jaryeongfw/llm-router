import assert from "node:assert/strict";
import { test } from "node:test";
import { priceOrder } from "../../src/pricing.ts";

test("최소 주문 금액은 등급 할인 전 상품 합계로 판단", () => {
  const p = priceOrder([{ sku: "A", unitPrice: 50_000, qty: 1 }], "VIP", { kind: "fixed", amount: 3_000, minOrder: 48_000 });
  assert.equal(p.tierDiscount, 5_000);
  assert.equal(p.couponDiscount, 3_000);
  assert.equal(p.total, 50_000 - 5_000 - 3_000 + 3_000);
});

test("정률 쿠폰은 등급 할인 후 금액 기준", () => {
  const p = priceOrder([{ sku: "A", unitPrice: 100_000, qty: 1 }], "VIP", { kind: "percent", rate: 0.1, maxDiscount: 50_000, minOrder: 0 });
  assert.equal(p.couponDiscount, 9_000);
});

test("정액 쿠폰은 등급 할인 후 금액을 넘지 않음", () => {
  const p = priceOrder([{ sku: "A", unitPrice: 4_000, qty: 1 }], "VIP", { kind: "fixed", amount: 5_000, minOrder: 0 });
  assert.equal(p.couponDiscount, 3_600);
  assert.ok(p.total >= 0);
});
