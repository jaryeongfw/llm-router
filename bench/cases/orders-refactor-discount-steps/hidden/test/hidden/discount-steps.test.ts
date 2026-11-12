import assert from "node:assert/strict";
import { test } from "node:test";
import * as pricing from "../../src/pricing.ts";

const RATE = { BASIC: 0, SILVER: 0.03, GOLD: 0.05, VIP: 0.1 } as const;
type Tier = keyof typeof RATE;
type Coupon = Parameters<typeof pricing.priceOrder>[2];

function reference(subtotal: number, tier: Tier, coupon: Coupon) {
  const tierDiscount = Math.floor(subtotal * RATE[tier]);
  const afterTier = subtotal - tierDiscount;
  let couponDiscount = 0;
  if (coupon && subtotal >= coupon.minOrder) {
    couponDiscount = coupon.kind === "fixed" ? Math.min(coupon.amount, afterTier) : Math.min(Math.floor(afterTier * coupon.rate), coupon.maxDiscount);
  }
  const after = afterTier - couponDiscount;
  const shipping = after >= 50_000 ? 0 : 3_000;
  return { subtotal, tierDiscount, couponDiscount, shipping, total: after + shipping };
}

test("DISCOUNT_STEPS는 함수 목록", () => {
  const steps = (pricing as Record<string, unknown>).DISCOUNT_STEPS;
  assert.ok(Array.isArray(steps) && steps.length >= 2);
  assert.ok((steps as unknown[]).every((s) => typeof s === "function"));
});

test("priceOrder 동작 불변 (조합 회귀)", () => {
  const coupons: Coupon[] = [
    null,
    { kind: "fixed", amount: 5_000, minOrder: 30_000 },
    { kind: "fixed", amount: 9_000, minOrder: 0 },
    { kind: "percent", rate: 0.15, maxDiscount: 7_000, minOrder: 20_000 },
    { kind: "percent", rate: 0.05, maxDiscount: 100_000, minOrder: 0 },
  ];
  for (const unit of [1_990, 8_000, 12_345, 33_333, 61_000]) {
    for (const qty of [1, 2, 3]) {
      for (const tier of Object.keys(RATE) as Tier[]) {
        for (const coupon of coupons) {
          const got = pricing.priceOrder([{ sku: "A", unitPrice: unit, qty }], tier, coupon);
          assert.deepEqual(got, reference(unit * qty, tier, coupon), `${unit}x${qty} ${tier} ${JSON.stringify(coupon)}`);
        }
      }
    }
  }
});
