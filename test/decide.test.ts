import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { bandOf, clampThinking, decide, type AnalysisInput, type DecideConfig, type Roster, type RoutingTable } from "../src/decide.ts";
import { resolveRoster, type CatalogModel } from "../src/models.ts";

const rd = (p: string) => JSON.parse(readFileSync(join(import.meta.dirname, "..", p), "utf8"));
const LOCAL = ["acme/local-coder", "acme/local-backup"];
const catalog: CatalogModel[] = [...LOCAL, "anthropic/claude-haiku-5-5", "anthropic/claude-sonnet-5-5", "anthropic/claude-opus-5-5"].map((r) => ({ provider: r.split("/")[0], id: r.slice(r.indexOf("/") + 1), contextWindow: 128000 }));
const roster = resolveRoster(rd("config/roster.json") as Roster, LOCAL, catalog);
const table = rd("config/routing-table.v0.json") as RoutingTable;
const cfg = rd("config/llm-router.default.json") as DecideConfig;

type Opts = Partial<AnalysisInput["dimensions"]> & { action?: string | null; sensitive?: boolean; secret?: boolean; sideEffect?: boolean; caps?: string[]; confidence?: number; est?: number };
function analysis(over: Opts = {}): AnalysisInput {
  const { action = "debug", sensitive = false, secret = false, sideEffect = false, caps = [], confidence = 1, est, ...dims } = over;
  return {
    task_type: { domain: "backend", action },
    hard_constraints: { data_sensitivity: sensitive ? "internal_only" : "external_ok", irreversible_side_effects: sideEffect, required_capabilities: caps, secret_present: secret },
    dimensions: { difficulty: 2, ambiguity: 0, scope: 1, verifiability: 2, capabilities: { reasoning: 1 }, ...dims },
    context_signals: { est_context_tokens: est ?? null },
    confidence,
  };
}
const run = (o: Opts = {}, op: "economy" | "balanced" | "quality" = "balanced") => decide(analysis(o), roster, table, cfg, op);

test("구간: 0~1은 easy, 2~3은 hard", () => {
  assert.deepEqual([0, 1, 2, 3].map(bandOf), ["easy", "easy", "hard", "hard"]);
});

test("조회표 그대로: debug/hard(난이도 2) → standard:high", () => {
  const d = run();
  assert.deepEqual([d.tier, d.thinking, d.model, d.table_cell], ["standard", "high", "anthropic/claude-sonnet-5-5", "debug/hard"]);
});

test("구간 상단(난이도 3)은 같은 티어에서 추론 강도 +1", () => {
  const d = run({ difficulty: 3 });
  assert.deepEqual([d.tier, d.thinking], ["standard", "xhigh"]);
  assert.ok(d.thinking_adjustments.includes("difficulty_up"));
});

test("난이도 ±1 오차가 구간 안이면 티어가 바뀌지 않는다", () => {
  assert.equal(run({ difficulty: 2 }).tier, run({ difficulty: 3 }).tier);
  assert.equal(run({ difficulty: 0 }).tier, run({ difficulty: 1 }).tier);
});

test("추론 요구가 높으면 추론 강도 +1", () => {
  const d = run({ capabilities: { reasoning: 3 } });
  assert.equal(d.thinking, "xhigh");
  assert.ok(d.thinking_adjustments.includes("reasoning_up"));
});

test("운영점: economy는 −1, quality는 +1", () => {
  assert.equal(run({}, "economy").thinking, "medium");
  assert.equal(run({}, "quality").thinking, "xhigh");
});

test("max_thinking 상한", () => {
  assert.equal(run({ action: "design", difficulty: 3, capabilities: { reasoning: 3 } }, "quality").thinking, "xhigh");
});

test("verifiable_down: 난이도 0이면 적용", () => {
  const d = run({ difficulty: 0, verifiability: 0, confidence: 0.8 });
  assert.deepEqual([d.base_tier, d.tier, d.thinking], ["light", "local", "off"]);
  assert.ok(d.thinking_adjustments.includes("local_off"));
});

test("verifiable_down: 난이도 1은 신뢰도와 무관하게 적용하지 않음 (08 §6)", () => {
  assert.equal(run({ difficulty: 1, verifiability: 0, confidence: 0.99 }).tier, "light");
  assert.equal(run({ difficulty: 1, verifiability: 0, confidence: 0.85 }).tier, "light");
});

test("quality 운영점에서는 verifiable_down을 하지 않음", () => {
  assert.equal(run({ difficulty: 0, verifiability: 0 }, "quality").tier, "light");
});

test("민감 데이터는 사내 티어로 제한되고 capped 표시", () => {
  const d = run({ sensitive: true, difficulty: 3 });
  assert.deepEqual([d.tier, d.model, d.capped], ["local", "acme/local-coder", true]);
});

test("사내 기본 모델을 쓸 수 없으면 티어 내 대체 모델", () => {
  const d = decide(analysis({ sensitive: true }), roster, table, cfg, "balanced", (ref) => ref !== "acme/local-coder");
  assert.equal(d.model, "acme/local-backup");
  assert.ok(d.fallback_reason);
});

const withPolicy = (mode: "mask" | "heavy" | "block") => ({ ...cfg, secret_policy: { mode, tier: "heavy" } });

test("비밀정보 mask(기본): 티어는 평소대로 (런타임이 가림)", () => {
  assert.equal(cfg.secret_policy.mode, "mask");
  const plain = run({ difficulty: 0, verifiability: 0 });
  const secret = run({ secret: true, difficulty: 0, verifiability: 0 });
  assert.equal(secret.tier, plain.tier);
  assert.ok(!secret.adjustments.includes("secret_policy"));
  assert.equal(run({ secret: true, sensitive: true }).tier, "local", "개인정보와 함께 있어도 사내 티어로 (가린 뒤 처리)");
});

test("비밀정보 heavy: 난이도와 무관하게 heavy, 사내 전용과 겹치면 결정 실패", () => {
  for (const difficulty of [0, 2]) {
    const d = decide(analysis({ secret: true, difficulty, verifiability: 0 }), roster, table, withPolicy("heavy"));
    assert.deepEqual([d.tier, d.model], ["heavy", "anthropic/claude-opus-5-5"]);
    assert.ok(d.adjustments.includes("secret_policy"));
  }
  assert.throws(() => decide(analysis({ secret: true, sensitive: true }), roster, table, withPolicy("heavy")), /비밀정보/);
});

test("비밀정보 block: 결정하지 않음", () => {
  assert.throws(() => decide(analysis({ secret: true }), roster, table, withPolicy("block")), /secret_policy: block/);
});

test("비가역 부작용은 하한 티어(heavy)", () => {
  const d = run({ action: "code_modify", difficulty: 0, verifiability: 0, sideEffect: true });
  assert.equal(d.tier, "heavy");
  assert.ok(!d.adjustments.includes("verifiable_down"));
});

test("이미지 입력이 필요하면 사내 티어 제외", () => {
  assert.equal(run({ action: "explain", difficulty: 0, caps: ["image_input"] }).tier, "light");
});

test("민감 + 이미지 입력이면 후보가 없어 예외 (외부로 대체하지 않음)", () => {
  assert.throws(() => run({ sensitive: true, caps: ["image_input"] }));
});

test("신뢰도가 낮으면 한 단계 위", () => {
  assert.equal(run({ confidence: 0.3 }).tier, "heavy");
});

test("난이도 미상이면 기본 티어(heavy)와 그 기본 추론 강도", () => {
  const d = run({ difficulty: null });
  assert.deepEqual([d.tier, d.thinking, d.table_cell], ["heavy", "medium", null]);
});

test("모호성 3이면 되묻기 표시", () => {
  assert.equal(run({ ambiguity: 3 }).ask_user, true);
});

test("지원하지 않는 추론 강도는 가까운 값으로", () => {
  assert.equal(clampThinking("off", ["low", "medium", "high"]), "low");
  assert.equal(clampThinking("minimal", ["off", "low"]), "low");
});

test("local 모델이 없으면 사내 티어가 비고, 민감 데이터는 배정 불가", () => {
  const noLocal = resolveRoster(rd("config/roster.json") as Roster, [], catalog);
  assert.equal(noLocal.tiers.find((x) => x.id === "local")!.models.length, 0);
  assert.equal(decide(analysis({ action: "explain", difficulty: 0 }), noLocal, table, cfg).tier, "light", "local이 없으면 다음 티어");
  assert.throws(() => decide(analysis({ sensitive: true }), noLocal, table, cfg), /티어가 없습니다/);
});
