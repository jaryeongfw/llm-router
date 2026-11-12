import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const PATH = new URL("../../docs/API.md", import.meta.url);

test("docs/API.md 형식", () => {
  assert.ok(existsSync(PATH), "docs/API.md 없음");
  const md = readFileSync(PATH, "utf8");
  for (const h of ["## placeOrder", "## cancelOrder", "## getOrder", "## 오류"]) {
    assert.ok(md.includes(h), `제목 누락: ${h}`);
  }
  for (const e of ["ValidationError", "OutOfStockError", "InvalidStateError", "NotFoundError"]) {
    assert.ok(md.includes(e), `오류 클래스 누락: ${e}`);
  }
  assert.ok(/```(ts|typescript)/.test(md), "TypeScript 예시 코드 없음");
  assert.ok(/[가-힣]/.test(md), "한국어 본문 아님");
});
