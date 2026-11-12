import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const PATH = new URL("../../CHANGELOG.md", import.meta.url);

test("CHANGELOG 형식", () => {
  assert.ok(existsSync(PATH), "CHANGELOG.md 없음");
  const md = readFileSync(PATH, "utf8");
  assert.ok(md.includes("## [1.2.0] - 2026-11-20"), "버전 제목 누락");
  const section = md.split("## [1.2.0] - 2026-11-20")[1].split(/\n## \[/)[0];
  for (const h of ["### 추가", "### 변경", "### 수정"]) assert.ok(section.includes(h), `소제목 누락: ${h}`);
  assert.ok(!/개발 도구 버전/.test(section), "사용자에게 무관한 chore 항목 포함");
  assert.ok(/50/.test(section.split("### 변경")[1] ?? ""), "최대 수량 변경이 '변경'에 없음");
});
