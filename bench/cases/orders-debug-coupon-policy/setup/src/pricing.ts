import { FREE_SHIPPING_THRESHOLD, SHIPPING_FEE, TIER_DISCOUNT_RATE } from "./config.ts";
import type { Coupon, LineItem, PriceBreakdown, Tier } from "./models.ts";

export function subtotalOf(lines: LineItem[]): number {
  return lines.reduce((sum, line) => sum + line.unitPrice * line.qty, 0);
}

export function tierDiscountOf(subtotal: number, tier: Tier): number {
  return Math.floor(subtotal * TIER_DISCOUNT_RATE[tier]);
}

export function couponDiscountOf(coupon: Coupon | null, subtotal: number, afterTier: number): number {
  if (!coupon) return 0;
  if (subtotal < coupon.minOrder) return 0;
  if (coupon.kind === "fixed") {
    return Math.min(coupon.amount, afterTier);
  }
  const raw = Math.floor(afterTier * coupon.rate);
  return Math.min(raw, coupon.maxDiscount);
}

export function shippingOf(afterDiscounts: number): number {
  return afterDiscounts >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_FEE;
}

export function priceOrder(lines: LineItem[], tier: Tier, coupon: Coupon | null): PriceBreakdown {
  const subtotal = subtotalOf(lines);
  const tierDiscount = tierDiscountOf(subtotal, tier);
  const afterTier = subtotal - tierDiscount;
  const couponDiscount = couponDiscountOf(coupon, afterTier, subtotal);
  const afterDiscounts = afterTier - couponDiscount;
  const shipping = shippingOf(afterDiscounts);
  return { subtotal, tierDiscount, couponDiscount, shipping, total: afterDiscounts + shipping };
}
