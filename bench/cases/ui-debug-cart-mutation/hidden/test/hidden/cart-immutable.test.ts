import assert from "node:assert/strict";
import { test } from "node:test";
import { cartReducer, initialCart } from "../../src/cart.ts";

const pen = { sku: "PEN", name: "펜", unitPrice: 1_500 };
const cup = { sku: "CUP", name: "컵", unitPrice: 4_000 };

test("같은 상품 재추가 시 이전 상태는 바뀌지 않는다", () => {
  const s1 = cartReducer(cartReducer(initialCart, { type: "ADD_ITEM", item: pen, qty: 1 }), { type: "ADD_ITEM", item: cup, qty: 1 });
  const snapshot = structuredClone(s1);
  const s2 = cartReducer(s1, { type: "ADD_ITEM", item: pen, qty: 2 });
  assert.deepEqual(s1, snapshot);
  assert.equal(s2.items.find((i) => i.sku === "PEN")?.qty, 3);
  assert.notEqual(s2.items[0], s1.items[0]);
  assert.equal(s2.items[1], s1.items[1], "바뀌지 않은 항목은 같은 참조 유지");
});

test("initialCart는 오염되지 않는다", () => {
  const s = cartReducer(initialCart, { type: "ADD_ITEM", item: pen, qty: 1 });
  cartReducer(s, { type: "ADD_ITEM", item: pen, qty: 1 });
  assert.deepEqual(initialCart, { items: [], couponCode: null });
});
