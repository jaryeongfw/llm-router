import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeStages } from "../src/analyze.ts";
import type { Stage1Result } from "../src/stage1.ts";
import type { Stage2Result } from "../src/stage2.ts";

const s1 = (o: Partial<Stage1Result["hard_constraints"]> = {}): Stage1Result => ({
  hard_constraints: { data_sensitivity: "external_ok", irreversible_side_effects: false, required_capabilities: [], latency: "interactive", budget_cap_usd: null, secret_present: false, ...o },
  rule_hits: [], groups: [], failsafe: false,
});
const s2 = (suspected: boolean): Stage2Result => ({
  status: "ok", latency_ms: 1,
  output: {
    task_type: { domain: "backend", action: "debug" },
    dimensions: { difficulty: 1, ambiguity: 0, scope: 1, verifiability: 0, consistency: 0, capabilities: { long_context: 0, multi_step_tools: 1, code_correctness: 1, instruction_following: 0, korean_writing: 0, reasoning: 1 } },
    difficulty_rationale: "", confidence: 0.9, sensitivity_suspected: suspected,
  },
});

test("2단 민감 의심은 internal_only로 올린다", () => {
  const m = mergeStages(s1(), s2(true));
  assert.equal(m.analysis.hard_constraints.data_sensitivity, "internal_only");
  assert.deepEqual(m.sensitiveBy, ["stage2"]);
});

test("비밀정보를 이미 가렸으면 2단 의심을 반영하지 않는다 (잘못된 차단 방지)", () => {
  const m = mergeStages(s1({ secret_present: true }), s2(true));
  assert.equal(m.analysis.hard_constraints.data_sensitivity, "external_ok");
  assert.equal(m.suspicionIgnored, "secret_masked");
});

test("2단 실패 시 차원은 null, 신뢰도 0", () => {
  const m = mergeStages(s1(), { status: "timeout", output: null, latency_ms: 3000 });
  assert.equal(m.analysis.dimensions.difficulty, null);
  assert.equal(m.analysis.confidence, 0);
});
