import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Roster } from "../src/decide.ts";
import { claudeVersion, pickClaudeAnalyzer, resolveAnalyzers, resolveRoster, splitRef, type CatalogModel } from "../src/models.ts";

const rosterFile = JSON.parse(readFileSync(join(import.meta.dirname, "../config/roster.json"), "utf8")) as Roster;
const M = (ref: string, extra: Partial<CatalogModel> = {}): CatalogModel => ({ ...splitRef(ref), contextWindow: 200000, input: ["text"], ...extra });
const anthropic = [
  M("anthropic/claude-haiku-4-5", { cost: { input: 1, output: 5 } }),
  M("anthropic/claude-haiku-4-5-20251001", { cost: { input: 1, output: 5 } }),
  M("anthropic/claude-haiku-5-5", { cost: { input: 0.1, output: 0.5 } }),
  M("anthropic/claude-sonnet-5-5", { cost: { input: 2, output: 10 } }),
  M("anthropic/claude-opus-5-5", { cost: { input: 4, output: 20 } }),
];

test("splitRef: id에 '/'가 있어도 첫 '/'에서 나눈다", () => {
  assert.deepEqual(splitRef("acme/team/qwen/coder"), { provider: "acme", id: "team/qwen/coder" });
});

test("claudeVersion: 날짜 접미사는 버전이 아니다", () => {
  assert.deepEqual(claudeVersion("claude-haiku-4-5-20251001"), [4, 5]);
  assert.deepEqual(claudeVersion("claude-opus-5"), [5]);
});

test("Claude 판단 모델: haiku 최신 버전", () => {
  assert.equal(pickClaudeAnalyzer(anthropic), "anthropic/claude-haiku-5-5");
});

test("haiku가 없으면 가장 싼 Claude", () => {
  assert.equal(pickClaudeAnalyzer(anthropic.filter((m) => !m.id.includes("haiku"))), "anthropic/claude-sonnet-5-5");
});

test("Claude가 없으면 null", () => {
  assert.equal(pickClaudeAnalyzer([M("acme/local-coder")]), null);
});

test("다른 공급자의 Claude도 고르되 anthropic을 우선", () => {
  const other = [M("proxy/claude-haiku-5-5"), ...anthropic];
  assert.equal(pickClaudeAnalyzer(other), "anthropic/claude-haiku-5-5");
  assert.equal(pickClaudeAnalyzer([M("proxy/claude-haiku-5-5")]), "proxy/claude-haiku-5-5");
});

test("local 자리표시를 사용자 모델로 바꾸고, 쓸 수 없는 모델은 뺀다", () => {
  const r = resolveRoster(rosterFile, ["acme/local-coder", "acme/missing"], [M("acme/local-coder", { contextWindow: 64000 }), ...anthropic]);
  const local = r.tiers.find((t) => t.id === "local")!;
  assert.deepEqual(local.models.map((m) => [m.ref, m.role, m.context_window, m.data_policy]), [["acme/local-coder", "primary", 64000, "internal"]]);
  assert.equal(r.tiers.find((t) => t.id === "heavy")!.models[0].ref, "anthropic/claude-opus-5-5");
});

const A = { prefer: "local" as const, model: null, claude_auto: true };

test("판단 모델 기본: local 먼저, 다음 Claude. 로컬 전용은 local만", () => {
  const cat = [M("acme/local-coder"), ...anthropic];
  const r = resolveAnalyzers(A, resolveRoster(rosterFile, ["acme/local-coder"], cat), cat);
  assert.deepEqual(r.external_ok.map((x) => x.ref), ["acme/local-coder", "anthropic/claude-haiku-5-5"]);
  assert.deepEqual(r.internal_only.map((x) => x.ref), ["acme/local-coder"]);
  assert.equal(r.external_ok[1].thinking, "off");
});

test("local이 없으면 Claude 자동 선택, 로컬 전용 분석기는 없음", () => {
  const r = resolveAnalyzers(A, resolveRoster(rosterFile, [], anthropic), anthropic);
  assert.deepEqual(r.external_ok.map((x) => x.ref), ["anthropic/claude-haiku-5-5"]);
  assert.deepEqual(r.internal_only, []);
  assert.equal(r.claude, "anthropic/claude-haiku-5-5");
});

test("prefer: claude면 Claude 먼저", () => {
  const cat = [M("acme/local-coder"), ...anthropic];
  const r = resolveAnalyzers({ ...A, prefer: "claude" }, resolveRoster(rosterFile, ["acme/local-coder"], cat), cat);
  assert.deepEqual(r.external_ok.map((x) => x.ref), ["anthropic/claude-haiku-5-5", "acme/local-coder"]);
});

test("명시 지정 모델이 맨 앞, 쓸 수 없으면 무시", () => {
  const cat = [M("acme/local-coder"), ...anthropic];
  const roster = resolveRoster(rosterFile, ["acme/local-coder"], cat);
  assert.equal(resolveAnalyzers({ ...A, model: "anthropic/claude-sonnet-5-5" }, roster, cat).external_ok[0].ref, "anthropic/claude-sonnet-5-5");
  assert.equal(resolveAnalyzers({ ...A, model: "nope/x" }, roster, cat).external_ok[0].ref, "acme/local-coder");
});
