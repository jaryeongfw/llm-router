import assert from "node:assert/strict";
import { test } from "node:test";
import { list, run, tempDir, touch } from "./helpers.ts";

test("오래된 파일만 삭제", () => {
  const dir = tempDir();
  touch(dir, "old.tmp", 10);
  touch(dir, "new.tmp", 0);
  const r = run("cleanup_tmp.sh", [dir, "7"]);
  assert.equal(r.code, 0);
  assert.deepEqual(list(dir), ["new.tmp"]);
});
