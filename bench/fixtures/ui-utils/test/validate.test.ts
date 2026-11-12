import assert from "node:assert/strict";
import { test } from "node:test";
import { validateCouponCode, validateQty } from "../src/validate.ts";

test("수량 검증", () => {
  assert.deepEqual(validateQty("3"), []);
  assert.deepEqual(validateQty("abc"), [{ field: "qty", code: "NOT_INTEGER" }]);
  assert.deepEqual(validateQty("100"), [{ field: "qty", code: "OUT_OF_RANGE" }]);
});

test("쿠폰 코드 검증", () => {
  assert.deepEqual(validateCouponCode(" welcome10 "), []);
  assert.deepEqual(validateCouponCode("ab-12"), [{ field: "couponCode", code: "INVALID_FORMAT" }]);
});
