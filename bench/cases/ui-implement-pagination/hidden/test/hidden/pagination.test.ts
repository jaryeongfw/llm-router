import assert from "node:assert/strict";
import { test } from "node:test";
import { getPageItems } from "../../src/pagination.ts";

test("예시 표", () => {
  assert.deepEqual(getPageItems(1, 1), [1]);
  assert.deepEqual(getPageItems(5, 10), [1, "…", 4, 5, 6, "…", 10]);
  assert.deepEqual(getPageItems(1, 10), [1, 2, "…", 10]);
  assert.deepEqual(getPageItems(4, 10), [1, 2, 3, 4, 5, "…", 10]);
  assert.deepEqual(getPageItems(10, 10), [1, "…", 9, 10]);
  assert.deepEqual(getPageItems(2, 5), [1, 2, 3, 4, 5]);
  assert.deepEqual(getPageItems(7, 20, 2), [1, "…", 5, 6, 7, 8, 9, "…", 20]);
});

test("total 0은 빈 배열", () => {
  assert.deepEqual(getPageItems(1, 0), []);
});

test("범위 밖 current는 RangeError", () => {
  assert.throws(() => getPageItems(0, 5), RangeError);
  assert.throws(() => getPageItems(6, 5), RangeError);
});
