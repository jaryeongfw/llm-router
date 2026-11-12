import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fillTemplate } from "../scripts/lib/fake.ts";
import { loadConfig } from "../src/config.ts";
import { registerRouter, type RouterState } from "../src/runtime.ts";

const json = (action: string, difficulty: number, domain = "backend") => JSON.stringify({
  task_type: { domain, action }, dimensions: { difficulty, ambiguity: 0, scope: 1, verifiability: 2, consistency: 0,
    capabilities: { long_context: 0, multi_step_tools: 1, code_correctness: 1, instruction_following: 1, korean_writing: 0, reasoning: 1 } },
  difficulty_rationale: "테스트", confidence: 0.9, sensitivity_suspected: false,
});

function setup(opts: { local?: string[]; scope?: "query" | "session"; analyzer?: (prompt: string) => string } = {}) {
  const loaded = loadConfig({ userPath: null });
  loaded.cfg.local_models = opts.local ?? ["acme/local-coder"];
  loaded.cfg.pin_scope = opts.scope ?? "query";
  loaded.cfg.log_dir = mkdtempSync(join(tmpdir(), "router-test-"));
  const models = [...loaded.cfg.local_models, "anthropic/claude-haiku-5-5", "anthropic/claude-sonnet-5-5", "anthropic/claude-opus-5-5"]
    .map((r) => ({ provider: r.split("/")[0], id: r.slice(r.indexOf("/") + 1), contextWindow: 200000, input: ["text"] }));
  const calls: string[] = [];
  const registry = {
    getAvailable: () => models,
    find: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id),
    streamSimple: (m: { provider: string; id: string }, ctx: { messages: { content: string }[] }) => {
      calls.push(`${m.provider}/${m.id}`);
      const text = (opts.analyzer ?? (() => json("explain", 0, "general")))(ctx.messages[0].content);
      return { result: async () => ({ content: [{ type: "text", text }], stopReason: "stop" }) };
    },
  };
  let route: any;
  registerRouter({ registerVirtualModel: (d: any) => { route = d.route; } } as never, loaded);
  const ctx = { modelRegistry: registry, sessionManager: { getSessionId: () => "s" } };
  const user = async (text: string, state?: RouterState, level = "medium") =>
    route({ reason: "user", thinkingLevel: level, state, messages: [{ role: "user", content: text }] }, ctx);
  return { route, ctx, user, calls };
}

const byPrompt = (p: string) => (p.includes("설계") ? json("design", 3) : json("explain", 0, "general"));

test("쿼리마다 다시 결정한다", async () => {
  const { user } = setup({ analyzer: byPrompt });
  const r1 = await user("TCP와 UDP 차이");
  const r2 = await user("마이크로서비스 설계 판단", r1.state);
  assert.equal(r1.state.tier, "local");
  assert.equal(r2.state.tier, "heavy");
  assert.notEqual(r1.state.query_id, r2.state.query_id);
});

test("같은 쿼리의 도구 루프와 재시도는 직전 모델 유지", async () => {
  const { route, ctx, user } = setup({ analyzer: byPrompt });
  const r = await user("마이크로서비스 설계 판단");
  const cont = await route({ reason: "continuation", thinkingLevel: "medium", state: r.state, previous: { model: r.model, thinkingLevel: r.thinkingLevel }, messages: [] }, ctx);
  assert.equal(cont.model, r.model);
  const retry = await route({ reason: "retry", thinkingLevel: "medium", state: r.state, failed: { model: r.model, thinkingLevel: r.thinkingLevel }, messages: [] }, ctx);
  assert.equal(retry.model, r.model);
});

test("session 고정이면 첫 결정 유지", async () => {
  const { user } = setup({ scope: "session", analyzer: byPrompt });
  const r1 = await user("TCP와 UDP 차이");
  const r2 = await user("마이크로서비스 설계 판단", r1.state);
  assert.equal(r2.model, r1.model);
});

test("session 고정이어도 사내 전용 데이터가 오면 외부 고정 모델을 쓰지 않는다", async () => {
  const { user } = setup({ scope: "session", analyzer: byPrompt });
  const r1 = await user("마이크로서비스 설계 판단");
  assert.equal(r1.state.tier, "heavy");
  const r2 = await user(fillTemplate("고객 {{FAKE_PHONE}}에게 보낼 안내 문구", 3), r1.state);
  assert.equal(r2.state.tier, "local");
  assert.equal(r2.model.provider, "acme");
});

test("판단 모델 기본은 local, 사내 전용 요청은 local로만 판단", async () => {
  const { user, calls } = setup();
  await user("TCP와 UDP 차이");
  await user(fillTemplate("고객 {{FAKE_PHONE}} 안내", 4));
  assert.deepEqual(calls, ["acme/local-coder", "acme/local-coder"]);
});

test("local이 없으면 Claude 판단 모델 자동 선택, 사내 전용 쿼리는 차단", async () => {
  const { user, calls } = setup({ local: [] });
  const r = await user("TCP와 UDP 차이");
  assert.deepEqual(calls, ["anthropic/claude-haiku-5-5"]);
  assert.equal(r.state.tier, "light");
  await assert.rejects(user(fillTemplate("고객 {{FAKE_PHONE}} 안내", 5)), /local 모델이 없습니다/);
});

test("local 판단 모델이 본문 없이 끝나면 Claude로 넘어간다", async () => {
  let n = 0;
  const { user, calls } = setup({ analyzer: () => (n++ === 0 ? "" : json("explain", 0, "general")) });
  const r = await user("TCP와 UDP 차이");
  assert.deepEqual(calls, ["acme/local-coder", "anthropic/claude-haiku-5-5"]);
  assert.equal(r.state.tier, "local");
});

test("운영점: router/auto:high는 quality", async () => {
  const { user } = setup({ analyzer: () => json("debug", 2) });
  const mid = await user("버그 원인 찾아 고쳐 줘");
  const high = await user("버그 원인 찾아 고쳐 줘", undefined, "high");
  assert.equal(mid.state.operating_point, "balanced");
  assert.equal(high.state.operating_point, "quality");
  assert.notEqual(high.thinkingLevel, mid.thinkingLevel);
});
