import assert from "node:assert/strict";
import { test } from "node:test";
import { cartReducer, cartTotal, initialCart } from "../src/cart.ts";

const pen = { sku: "PEN", name: "펜", unitPrice: 1_500 };

test("상품 추가와 합계", () => {
  const s = cartReducer(initialCart, { type: "ADD_ITEM", item: pen, qty: 2 });
  assert.equal(s.items.length, 1);
  assert.equal(cartTotal(s), 3_000);
});

test("수량 0으로 설정하면 제거", () => {
  const s1 = cartReducer(initialCart, { type: "ADD_ITEM", item: pen, qty: 2 });
  const s2 = cartReducer(s1, { type: "SET_QTY", sku: "PEN", qty: 0 });
  assert.equal(s2.items.length, 0);
});

test("쿠폰 코드 정규화", () => {
  const s = cartReducer(initialCart, { type: "APPLY_COUPON", code: "  welcome10 " });
  assert.equal(s.couponCode, "WELCOME10");
});
