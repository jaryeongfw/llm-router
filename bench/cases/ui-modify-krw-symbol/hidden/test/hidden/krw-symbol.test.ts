import assert from "node:assert/strict";
import { test } from "node:test";
import { formatKRW } from "../../src/format.ts";

test("₩ 접두 형식", () => {
  assert.equal(formatKRW(1_234), "₩1,234");
  assert.equal(formatKRW(0), "₩0");
  assert.equal(formatKRW(1_000_000), "₩1,000,000");
});

test("음수는 -₩", () => {
  assert.equal(formatKRW(-1_234), "-₩1,234");
});
