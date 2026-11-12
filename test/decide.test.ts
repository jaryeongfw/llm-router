import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { clampThinking, decide, type AnalysisInput, type DecideConfig, type Roster, type RoutingTable } from "../src/decide.ts";

const rd = (p: string) => JSON.parse(readFileSync(join(import.meta.dirname, "..", p), "utf8"));
const roster = rd("config/roster.json") as Roster;
const table = rd("config/routing-table.v0.json") as RoutingTable;
const cfg = rd("config/llm-router.default.json") as DecideConfig;

function analysis(over: Partial<AnalysisInput["dimensions"]> & { action?: string | null; sensitive?: boolean; sideEffect?: boolean; caps?: string[]; confidence?: number; est?: number } = {}): AnalysisInput {
  const { action = "debug", sensitive = false, sideEffect = false, caps = [], confidence = 1, est, ...dims } = over;
  return {
    task_type: { domain: "backend", action },
    hard_constraints: { data_sensitivity: sensitive ? "internal_only" : "external_ok", irreversible_side_effects: sideEffect, required_capabilities: caps },
    dimensions: { difficulty: 2, ambiguity: 0, scope: 1, verifiability: 2, capabilities: { reasoning: 1 }, ...dims },
    context_signals: { est_context_tokens: est ?? null },
    confidence,
  };
}

test("조회표 그대로: debug/2 → standard:high", () => {
  const d = decide(analysis(), roster, table, cfg);
  assert.deepEqual([d.tier, d.thinking, d.model], ["standard", "high", "anthropic/claude-sonnet-5-5"]);
  assert.equal(d.table_cell, "debug/2");
});

test("추론 요구가 높으면 추론 강도 +1", () => {
  const d = decide(analysis({ capabilities: { reasoning: 3 } }), roster, table, cfg);
  assert.equal(d.thinking, "xhigh");
  assert.ok(d.thinking_adjustments.includes("reasoning_up"));
});

test("운영점: economy는 −1, quality는 +1", () => {
  assert.equal(decide(analysis(), roster, table, cfg, "economy").thinking, "medium");
  assert.equal(decide(analysis(), roster, table, cfg, "quality").thinking, "xhigh");
});

test("max_thinking 상한", () => {
  const d = decide(analysis({ action: "design", difficulty: 3, capabilities: { reasoning: 3 } }), roster, table, cfg, "quality");
  assert.equal(d.thinking, "xhigh");
});

test("검증 가능하고 쉬우면 한 단계 아래 티어", () => {
  const d = decide(analysis({ difficulty: 1, verifiability: 0 }), roster, table, cfg);
  assert.equal(d.base_tier, "light");
  assert.equal(d.tier, "local");
  assert.equal(d.thinking, "off");
  assert.ok(d.thinking_adjustments.includes("local_off"));
});

test("quality 운영점에서는 verifiable_down을 하지 않음", () => {
  const d = decide(analysis({ difficulty: 1, verifiability: 0 }), roster, table, cfg, "quality");
  assert.equal(d.tier, "light");
});

test("민감 데이터는 사내 티어로 제한되고 capped 표시", () => {
  const d = decide(analysis({ sensitive: true, difficulty: 3 }), roster, table, cfg);
  assert.equal(d.tier, "local");
  assert.equal(d.model, "simflow/ixi-simflow-codeadvisor");
  assert.equal(d.capped, true);
});

test("사내 기본 모델을 쓸 수 없으면 티어 내 대체 모델", () => {
  const d = decide(analysis({ sensitive: true }), roster, table, cfg, "balanced", (ref) => !ref.startsWith("simflow/"));
  assert.equal(d.model, "lgu-axeng/axengdev/qwen/qwen3-coder-next");
  assert.ok(d.fallback_reason);
});

test("비가역 부작용은 하한 티어(heavy)", () => {
  const d = decide(analysis({ action: "code_modify", difficulty: 0, verifiability: 0, sideEffect: true }), roster, table, cfg);
  assert.equal(d.tier, "heavy");
  assert.ok(!d.adjustments.includes("verifiable_down"));
});

test("이미지 입력이 필요하면 사내 티어 제외", () => {
  const d = decide(analysis({ action: "explain", difficulty: 0, caps: ["image_input"] }), roster, table, cfg);
  assert.equal(d.tier, "light");
});

test("민감 + 이미지 입력이면 후보가 없어 예외 (외부로 대체하지 않음)", () => {
  assert.throws(() => decide(analysis({ sensitive: true, caps: ["image_input"] }), roster, table, cfg));
});

test("신뢰도가 낮으면 한 단계 위", () => {
  const d = decide(analysis({ confidence: 0.3 }), roster, table, cfg);
  assert.equal(d.tier, "heavy");
});

test("난이도 미상이면 기본 티어(heavy)와 그 기본 추론 강도", () => {
  const d = decide(analysis({ difficulty: null }), roster, table, cfg);
  assert.deepEqual([d.tier, d.thinking, d.table_cell], ["heavy", "medium", null]);
});

test("모호성 3이면 되묻기 표시", () => {
  assert.equal(decide(analysis({ ambiguity: 3 }), roster, table, cfg).ask_user, true);
});

test("지원하지 않는 추론 강도는 가까운 값으로", () => {
  assert.equal(clampThinking("off", ["low", "medium", "high"]), "low");
  assert.equal(clampThinking("minimal", ["off", "low"]), "low");
});
