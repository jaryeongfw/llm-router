import assert from "node:assert/strict";
import { test } from "node:test";
import { validatePassword } from "../../src/validate.ts";

const codes = (pw: string) => validatePassword(pw).map((e) => { assert.equal(e.field, "password"); return e.code; });

test("정책 충족", () => {
  assert.deepEqual(codes("Tiger!2026x"), []);
});

test("코드 순서와 누적", () => {
  assert.deepEqual(codes("abc"), ["TOO_SHORT", "NO_DIGIT", "NO_SYMBOL"]);
  assert.deepEqual(codes("1234567890"), ["NO_LETTER", "NO_SYMBOL"]);
  assert.deepEqual(codes("abcd efgh 12!"), ["HAS_SPACE"]);
  assert.deepEqual(codes("aaaa1234!xyz"), ["REPEATED_CHAR"]);
  assert.deepEqual(codes("aaa1234!xyz9"), []);
});

test("길이 경계", () => {
  assert.deepEqual(codes("Abcdef12!x"), []);
  assert.deepEqual(codes("Abcdef12!"), ["TOO_SHORT"]);
  assert.deepEqual(codes("A1!" + "bc".repeat(30) + "d"), []);
  assert.deepEqual(codes("A1!" + "bc".repeat(31)), ["TOO_LONG"]);
});
