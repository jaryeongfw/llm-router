import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const PATH = new URL("../../docs/RUNBOOK-disk.md", import.meta.url);

test("런북 형식", () => {
  assert.ok(existsSync(PATH), "docs/RUNBOOK-disk.md 없음");
  const md = readFileSync(PATH, "utf8");
  for (const h of ["## 증상", "## 확인", "## 조치", "## 확인 후 마무리"]) assert.ok(md.includes(h), `제목 누락: ${h}`);
  for (const s of ["check_disk.sh", "rotate_logs.sh", "cleanup_tmp.sh"]) assert.ok(md.includes(s), `스크립트 언급 누락: ${s}`);
  assert.ok(!/rm\s+-rf\s+\//.test(md), "위험한 rm -rf / 예시 포함");
});
