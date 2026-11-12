import assert from "node:assert/strict";
import { test } from "node:test";
import { priceOrder } from "../../src/pricing.ts";

test("GOLD 등급 할인은 원 단위 내림", () => {
  const p = priceOrder([{ sku: "A", unitPrice: 12_350, qty: 1 }], "GOLD", null);
  assert.equal(p.tierDiscount, 617);
  assert.equal(p.total, 12_350 - 617 + 3_000);
});

test("VIP 등급 할인은 원 단위 내림", () => {
  const p = priceOrder([{ sku: "A", unitPrice: 4_115, qty: 3 }], "VIP", null);
  assert.equal(p.tierDiscount, 1_234);
});
