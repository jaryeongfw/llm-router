import assert from "node:assert/strict";
import { test } from "node:test";
import { list, run, tempDir, touch } from "./helpers.ts";

test("keep 인자 검증", () => {
  const dir = tempDir();
  assert.equal(run("rotate_logs.sh", [dir, "0"]).code, 2);
});

test("로그가 keep보다 적으면 아무것도 지우지 않음", () => {
  const dir = tempDir();
  touch(dir, "app-20260101.log");
  touch(dir, "other.txt");
  assert.equal(run("rotate_logs.sh", [dir, "3"]).code, 0);
  assert.deepEqual(list(dir), ["app-20260101.log", "other.txt"]);
});
