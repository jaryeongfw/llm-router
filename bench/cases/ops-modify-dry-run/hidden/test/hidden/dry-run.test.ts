import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { list, run, tempDir, touch } from "../helpers.ts";

test("--dry-run은 삭제하지 않고 대상을 출력", () => {
  const dir = tempDir();
  touch(dir, "old.tmp", 10);
  touch(dir, "new.tmp", 0);
  const r = run("cleanup_tmp.sh", ["--dry-run", dir, "7"]);
  assert.equal(r.code, 0);
  assert.deepEqual(list(dir), ["new.tmp", "old.tmp"]);
  assert.ok(r.stdout.includes(`삭제 예정: ${join(dir, "old.tmp")}`), r.stdout);
  assert.ok(!r.stdout.includes("new.tmp"));
});

test("플래그 없으면 기존 동작", () => {
  const dir = tempDir();
  touch(dir, "old.tmp", 10);
  assert.equal(run("cleanup_tmp.sh", [dir, "7"]).code, 0);
  assert.deepEqual(list(dir), []);
});

test("--dry-run에서도 인자 검증", () => {
  const dir = tempDir();
  assert.equal(run("cleanup_tmp.sh", ["--dry-run", dir, "x"]).code, 2);
});
