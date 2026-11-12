import type { TIER_DISCOUNT_RATE } from "./config.ts";

export type Tier = keyof typeof TIER_DISCOUNT_RATE;

export interface Customer {
  id: string;
  tier: Tier;
}

export interface LineItem {
  sku: string;
  unitPrice: number;
  qty: number;
}

export type Coupon =
  | { kind: "fixed"; amount: number; minOrder: number }
  | { kind: "percent"; rate: number; maxDiscount: number; minOrder: number };

export interface PriceBreakdown {
  subtotal: number;
  tierDiscount: number;
  couponDiscount: number;
  shipping: number;
  total: number;
}

export type OrderStatus = "PLACED" | "CANCELLED" | "PARTIALLY_REFUNDED" | "REFUNDED";

export interface Order {
  id: string;
  customer: Customer;
  lines: LineItem[];
  coupon: Coupon | null;
  price: PriceBreakdown;
  status: OrderStatus;
  refundedLines: number[];
}

export interface PlaceOrderInput {
  customer: Customer;
  lines: LineItem[];
  coupon?: Coupon | null;
}
