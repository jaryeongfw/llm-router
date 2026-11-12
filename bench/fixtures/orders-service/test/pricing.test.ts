import assert from "node:assert/strict";
import { test } from "node:test";
import { priceOrder } from "../src/pricing.ts";

test("BASIC, 쿠폰 없음, 배송비 부과", () => {
  const p = priceOrder([{ sku: "A", unitPrice: 10_000, qty: 2 }], "BASIC", null);
  assert.deepEqual(p, { subtotal: 20_000, tierDiscount: 0, couponDiscount: 0, shipping: 3_000, total: 23_000 });
});

test("SILVER 등급 할인과 무료 배송", () => {
  const p = priceOrder([{ sku: "A", unitPrice: 30_000, qty: 2 }], "SILVER", null);
  assert.equal(p.tierDiscount, 1_800);
  assert.equal(p.shipping, 0);
  assert.equal(p.total, 58_200);
});

test("정액 쿠폰", () => {
  const p = priceOrder([{ sku: "A", unitPrice: 40_000, qty: 1 }], "BASIC", { kind: "fixed", amount: 5_000, minOrder: 30_000 });
  assert.equal(p.couponDiscount, 5_000);
  assert.equal(p.total, 38_000);
});

test("정률 쿠폰 최대 할인액", () => {
  const p = priceOrder([{ sku: "A", unitPrice: 200_000, qty: 1 }], "BASIC", { kind: "percent", rate: 0.1, maxDiscount: 15_000, minOrder: 0 });
  assert.equal(p.couponDiscount, 15_000);
});
