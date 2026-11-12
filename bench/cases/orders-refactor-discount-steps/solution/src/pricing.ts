import { FREE_SHIPPING_THRESHOLD, SHIPPING_FEE, TIER_DISCOUNT_RATE } from "./config.ts";
import type { Coupon, LineItem, PriceBreakdown, Tier } from "./models.ts";

export interface DiscountContext {
  subtotal: number;
  current: number;
  tier: Tier;
  coupon: Coupon | null;
}

export type DiscountStep = (ctx: DiscountContext) => number;

export function subtotalOf(lines: LineItem[]): number {
  return lines.reduce((sum, line) => sum + line.unitPrice * line.qty, 0);
}

export function tierDiscountOf(subtotal: number, tier: Tier): number {
  return Math.floor(subtotal * TIER_DISCOUNT_RATE[tier]);
}

export function couponDiscountOf(coupon: Coupon | null, subtotal: number, afterTier: number): number {
  if (!coupon) return 0;
  if (subtotal < coupon.minOrder) return 0;
  if (coupon.kind === "fixed") return Math.min(coupon.amount, afterTier);
  return Math.min(Math.floor(afterTier * coupon.rate), coupon.maxDiscount);
}

export const DISCOUNT_STEPS: DiscountStep[] = [
  (ctx) => tierDiscountOf(ctx.subtotal, ctx.tier),
  (ctx) => couponDiscountOf(ctx.coupon, ctx.subtotal, ctx.current),
];

export function shippingOf(afterDiscounts: number): number {
  return afterDiscounts >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_FEE;
}

export function priceOrder(lines: LineItem[], tier: Tier, coupon: Coupon | null): PriceBreakdown {
  const subtotal = subtotalOf(lines);
  const discounts: number[] = [];
  let current = subtotal;
  for (const step of DISCOUNT_STEPS) {
    const d = step({ subtotal, current, tier, coupon });
    discounts.push(d);
    current -= d;
  }
  const shipping = shippingOf(current);
  return { subtotal, tierDiscount: discounts[0], couponDiscount: discounts[1], shipping, total: current + shipping };
}
