import assert from "node:assert/strict";
import { test } from "node:test";
import { cardLines, fmtCost, fmtTokens, plainTheme, statsLines, statusText, summarize, truncate, visibleWidth, type QueryCard } from "../src/report.ts";

const A = (ref: string, input: number, output: number, cacheRead: number, cost: number, thinkingLevel = "low", stopReason = "stop", cacheWrite = 0) => {
  const [provider, ...rest] = ref.split("/");
  return { role: "assistant", provider, model: rest.join("/"), thinkingLevel, stopReason, usage: { input, output, cacheRead, cacheWrite, cost: { total: cost } } };
};

const card = (over: Partial<QueryCard> = {}): QueryCard => ({
  v: 1, card_id: "d_1", query_id: "q_abc", tier: "standard", model: "anthropic/claude-sonnet-5-5", thinking: "high", operating_point: "balanced",
  cell: "debug/hard", adjustments: [], thinking_adjustments: [], analyzer: "acme/local-coder", analyzer_ms: 5200, stage2: "ok",
  capped: false, ask_user: false, pinned: false, aborted: false,
  usage: summarize([A("anthropic/claude-sonnet-5-5", 3000, 400, 15000, 0.02, "high"), A("anthropic/claude-sonnet-5-5", 200, 900, 15100, 0.011, "high")]),
  ...over,
});

test("summarize: 모델별 합계, 입력은 캐시 포함", () => {
  const s = summarize([A("a/x", 100, 10, 1000, 0.1), A("b/y", 5, 5, 0, 0), A("a/x", 50, 20, 2000, 0.2), { role: "user" }]);
  assert.equal(s.calls, 3);
  assert.equal(s.input, 100 + 5 + 50 + 3000);
  assert.equal(s.cacheRead, 3000);
  assert.deepEqual(s.byModel.map((m) => [m.ref, m.calls]), [["a/x", 2], ["b/y", 1]]);
  assert.ok(Math.abs(s.cost - 0.3) < 1e-9);
});

test("summarize: 캐시 쓰기도 입력에 포함 (첫 호출은 대부분 캐시 쓰기로 집계됨)", () => {
  const s = summarize([A("anthropic/claude-opus-5-5", 4, 1800, 0, 0.05, "xhigh", "stop", 9000)]);
  assert.equal(s.input, 9004);
  assert.equal(s.byModel[0].input, 9004);
});

test("표시 너비: 한글은 2칸, ANSI는 0칸", () => {
  assert.equal(visibleWidth("abc"), 3);
  assert.equal(visibleWidth("호출 4회"), 8);
  assert.equal(visibleWidth("\x1b[31m라우터\x1b[0m"), 6);
  assert.ok(visibleWidth(truncate("가나다라마바사아자차", 9)) <= 9);
});

test("숫자 표시", () => {
  assert.equal(fmtTokens(18234), "18.2K");
  assert.equal(fmtTokens(2_500_000), "2.5M");
  assert.equal(fmtCost(0), "$0");
  assert.equal(fmtCost(0.0012), "$0.0012");
  assert.equal(fmtCost(0.031), "$0.031");
});

test("카드: 결정과 사용량, 판단 모델", () => {
  const lines = cardLines(card(), 120, plainTheme);
  assert.match(lines[0], /◆ router {2}standard · claude-sonnet-5-5 · high {2}debug\/hard/);
  assert.match(lines[1], /호출 2회 · 입력 33\.3K \(캐시 30\.1K\) · 출력 1\.3K · \$0\.031/);
  assert.match(lines[2], /판단 local-coder 5\.2s/);
  assert.equal(lines.length, 3);
});

test("카드: 결정과 다른 모델이 응답했으면 모델별 줄을 보인다", () => {
  const c = card({ usage: summarize([A("anthropic/claude-sonnet-5-5", 1, 1, 0, 0.01), A("anthropic/claude-opus-5-5", 1, 1, 0, 0.05, "high", "stop")]) });
  const lines = cardLines(c, 120, plainTheme);
  assert.ok(lines.some((l) => l.includes("! claude-opus-5-5")));
});

test("카드: 고정 유지, 제한, 모호성, 펼친 보기", () => {
  const lines = cardLines(card({ pinned: true, capped: true, ask_user: true, thinking_adjustments: ["difficulty_up"] }), 140, plainTheme, true);
  assert.ok(lines[2].includes("이전 결정 유지") && lines[2].includes("제한") && lines[2].includes("모호"));
  assert.ok(lines.at(-1)!.includes("추론 보정 difficulty_up"));
});

test("카드: 판단 실패는 경고로 보인다", () => {
  const lines = cardLines(card({ stage2: "parse_error", cell: null, adjustments: ["low_confidence_up"] }), 120, plainTheme);
  assert.match(lines[0], /기본 티어/);
  assert.match(lines[2], /판단 실패\(형식 오류, local-coder\) → 기본 티어/);
});

test("카드: 좁은 화면에서는 줄을 자른다", () => {
  for (const l of cardLines(card(), 30, plainTheme)) assert.ok(visibleWidth(l) <= 30, l);
});

test("상태줄: 티어 순서와 누적 비용", () => {
  const s = statusText([card({ tier: "heavy" }), card({ tier: "local", usage: summarize([A("acme/local", 1, 1, 0, 0)]) }), card({ tier: "local", usage: summarize([A("acme/local", 1, 1, 0, 0)]) })], plainTheme);
  assert.equal(s, "router ▸ local 2 · heavy 1  $0.031");
  assert.equal(statusText([], plainTheme), undefined);
});

test("stats: 티어별·모델별 막대와 합계", () => {
  const cards = [card({ tier: "local" }), card({ tier: "local" }), card({ tier: "heavy" })];
  const all = summarize([A("acme/local", 10, 1, 0, 0), A("acme/local", 10, 1, 0, 0), A("anthropic/claude-opus-5-5", 100, 50, 0, 0.08)]);
  const lines = statsLines(cards, all, plainTheme, 100);
  assert.match(lines[0], /라우팅 쿼리 3건/);
  const local = lines.find((l) => l.trimStart().startsWith("local"))!;
  const heavy = lines.find((l) => l.trimStart().startsWith("heavy"))!;
  assert.ok((local.match(/█/g) ?? []).length > (heavy.match(/█/g) ?? []).length);
  assert.ok(lines.some((l) => l.includes("합계 3회")));
});

test("카드: local 없이 민감 의심을 넘긴 경우 경고", () => {
  assert.ok(cardLines(card({ sensitivity_warning: true }), 200, plainTheme)[2].includes("민감 정보 의심"));
  assert.ok(!cardLines(card(), 200, plainTheme)[2].includes("민감 정보 의심"));
});

test("카드: 도구 결과 민감 정보 경고", () => {
  const l = cardLines(card({ tool_result_warnings: { count: 2, rules: ["pii.email"] } }), 200, plainTheme)[2];
  assert.ok(l.includes("도구 결과 2건") && l.includes("pii.email"));
});
