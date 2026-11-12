import assert from "node:assert/strict";
import { test } from "node:test";
import { list, run, tempDir, touch } from "../helpers.ts";

test("keep=7이면 최신 7개가 남는다", () => {
  const dir = tempDir();
  for (let d = 1; d <= 10; d++) touch(dir, `app-202601${String(d).padStart(2, "0")}.log`);
  touch(dir, "keep-me.txt");
  assert.equal(run("rotate_logs.sh", [dir, "7"]).code, 0);
  assert.deepEqual(list(dir), [4, 5, 6, 7, 8, 9, 10].map((d) => `app-202601${String(d).padStart(2, "0")}.log`).concat("keep-me.txt"));
});

test("keep=1이면 최신 1개", () => {
  const dir = tempDir();
  touch(dir, "app-20260101.log");
  touch(dir, "app-20260102.log");
  run("rotate_logs.sh", [dir, "1"]);
  assert.deepEqual(list(dir), ["app-20260102.log"]);
});
