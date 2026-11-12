import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fillTemplate } from "../scripts/lib/fake.ts";
import { loadConfig } from "../src/config.ts";
import { SchemaSet } from "../src/schema.ts";
import { LOG_MAX_BYTES, estimateContext, followUpContext, estimateTokens, registerRouter, type RouterState } from "../src/runtime.ts";

const json = (action: string, difficulty: number, domain = "backend") => JSON.stringify({
  task_type: { domain, action }, dimensions: { difficulty, ambiguity: 0, scope: 1, verifiability: 2, consistency: 0,
    capabilities: { long_context: 0, multi_step_tools: 1, code_correctness: 1, instruction_following: 1, korean_writing: 0, reasoning: 1 } },
  difficulty_rationale: "테스트", confidence: 0.9, sensitivity_suspected: false,
});

function setup(opts: { local?: string[]; scope?: "query" | "session"; analyzer?: (prompt: string) => string; suspicion?: "warn" | "confirm" | "block"; toolPolicy?: "warn" | "confirm" | "off"; answer?: boolean; noUi?: boolean; decisionTimeout?: number; analyzerDelay?: number } = {}) {
  const loaded = loadConfig({ userPath: null });
  if (opts.suspicion) loaded.cfg.analyzer.suspicion_without_local = opts.suspicion;
  if (opts.toolPolicy) loaded.cfg.tool_result_policy = opts.toolPolicy;
  if (opts.decisionTimeout) loaded.cfg.decision_timeout_ms = opts.decisionTimeout;
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
      return { result: async () => {
        if (opts.analyzerDelay) await new Promise((r) => setTimeout(r, opts.analyzerDelay));
        return { content: [{ type: "text", text }], stopReason: "stop" };
      } };
    },
  };
  let route: any;
  const records: any[] = [];
  const handle = registerRouter({ registerVirtualModel: (d: any) => { route = d.route; } } as never, loaded, { onDecision: (r) => records.push(r) });
  const notes: string[] = [];
  const asked: string[] = [];
  const ctx = { modelRegistry: registry, sessionManager: { getSessionId: () => "s" }, hasUI: !opts.noUi, ui: { notify: (m: string) => notes.push(m), confirm: async (_t: string, m: string) => { asked.push(m); return opts.answer ?? true; } } };
  const user = async (text: string, state?: RouterState, level = "medium", history: { role: string; content: unknown }[] = []) =>
    route({ reason: "user", thinkingLevel: level, state, messages: [...history, { role: "user", content: text }] }, ctx);
  return { route, ctx, user, calls, records, notes, asked, handle, logDir: loaded.cfg.log_dir };
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

test("session 고정이어도 로컬 전용 데이터가 오면 외부 고정 모델을 쓰지 않는다", async () => {
  const { user } = setup({ scope: "session", analyzer: byPrompt });
  const r1 = await user("마이크로서비스 설계 판단");
  assert.equal(r1.state.tier, "heavy");
  const r2 = await user(fillTemplate("고객 {{FAKE_PHONE}}에게 보낼 안내 문구", 3), r1.state);
  assert.equal(r2.state.tier, "local");
  assert.equal(r2.model.provider, "acme");
});

test("판단 모델 기본은 local, 로컬 전용 요청은 local로만 판단", async () => {
  const { user, calls } = setup();
  await user("TCP와 UDP 차이");
  await user(fillTemplate("고객 {{FAKE_PHONE}} 안내", 4));
  assert.deepEqual(calls, ["acme/local-coder", "acme/local-coder"]);
});

test("local이 없으면 Claude 판단 모델 자동 선택, 로컬 전용 쿼리는 차단", async () => {
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

const suspected = (action = "explain", difficulty = 0) => JSON.stringify({ ...JSON.parse(json(action, difficulty, "general")), sensitivity_suspected: true });

test("local이 없으면 판단 모델의 민감 의심만으로 막지 않는다 (경고 표시)", async () => {
  const { user, records } = setup({ local: [], analyzer: () => suspected() });
  const r = await user("TCP와 UDP 차이");
  assert.equal(r.state.tier, "light");
  assert.equal(r.state.sensitive, false);
  assert.equal(records.at(-1).suspicion_ignored, "no_local");
});

test("suspicion_without_local: block이면 차단하고 이유를 알린다", async () => {
  const { user } = setup({ local: [], analyzer: () => suspected(), suspicion: "block" });
  await assert.rejects(user("TCP와 UDP 차이"), /판단 모델의 민감 의심/);
});

test("차단 메시지에 걸린 규칙 이름을 붙인다 (값은 붙이지 않는다)", async () => {
  const { user } = setup({ local: [] });
  const text = fillTemplate("고객 {{FAKE_PHONE}} 안내", 6);
  await assert.rejects(user(text), (e: Error) => e.message.includes("pii.phone_kr") && !e.message.includes(text.slice(3, 10)));
});

test("local이 있으면 판단 모델의 민감 의심은 local로 보낸다", async () => {
  const { user } = setup({ analyzer: () => suspected("debug", 2) });
  const r = await user("버그 원인 찾아 고쳐 줘");
  assert.equal(r.state.tier, "local");
});

test("토큰 추정: 문자 종류, 블록 종류, 이미지", () => {
  assert.equal(estimateTokens([{ role: "user", content: "a".repeat(400) }]), 100);
  assert.equal(estimateTokens([{ role: "user", content: "가".repeat(150) }]), 100);
  assert.equal(estimateTokens([
    { role: "system", content: "abcd" },
    { role: "assistant", content: [{ type: "thinking", thinking: "abcd" }, { type: "toolCall", arguments: { p: "x" } }] },
    { role: "toolResult", content: [{ type: "text", text: "abcd" }, { type: "image" }] },
  ]), Math.ceil((4 + 4 + JSON.stringify({ p: "x" }).length + 4) / 4) + 1600);
});

test("대화가 길면 컨텍스트 신호로 작은 컨텍스트 모델을 피한다", async () => {
  const { user, records } = setup({ analyzer: byPrompt });
  const history = [{ role: "toolResult", content: [{ type: "text", text: "x".repeat(4 * 120_000) }] }];
  const r = await user("TCP와 UDP 차이", undefined, "medium", history);
  assert.notEqual(r.state.tier, "local");
  assert.ok(records.at(-1).est_context_tokens > 100_000);
  assert.ok(records.at(-1).decision.adjustments.includes("capability_filter"));
});

test("로컬 전용인데 local 모델이 컨텍스트를 감당 못 하면 그 이유를 알린다", async () => {
  const { user } = setup({ analyzer: byPrompt });
  const history = [{ role: "toolResult", content: [{ type: "text", text: "x".repeat(4 * 120_000) }] }];
  await assert.rejects(user("#local TCP와 UDP 차이", undefined, "medium", history), /local 모델이 필요 능력\(long_context_200k\)/);
});

// ---- 도구 결과 경고, 중단·시간 상한, 고정 경로, 토큰 추정

const toolResult = (text: string, id = "c1", tool = "read") => ({ role: "toolResult", toolCallId: id, toolName: tool, content: [{ type: "text", text }] });
const cont = (route: any, ctx: any, state: RouterState, model: any, messages: unknown[]) =>
  route({ reason: "continuation", thinkingLevel: "medium", state, previous: { model, thinkingLevel: "low" }, messages }, ctx);

test("도구 결과에 개인정보가 있고 외부 모델로 보내면 경고한다 (한 번만, 값 없이)", async () => {
  const { route, ctx, user, notes, handle, logDir } = setup({ local: [], analyzer: byPrompt });
  const r = await user("마이크로서비스 설계 판단");
  const text = fillTemplate("고객 {{FAKE_PHONE}} 연락처", 8);
  const msgs = [toolResult(text)];
  await cont(route, ctx, r.state, r.model, msgs);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /read.*pii\.phone_kr.*외부 모델/s);
  assert.ok(!notes[0].includes(text.slice(3, 12)));
  await cont(route, ctx, r.state, r.model, msgs);
  assert.equal(notes.length, 1, "같은 도구 결과는 다시 경고하지 않는다");
  const w = handle.takeToolWarnings("s");
  assert.deepEqual(w.map((x: any) => [x.tool, x.rules]), [["read", ["pii.phone_kr"]]]);
  assert.deepEqual(handle.takeToolWarnings("s"), []);
  const logged = readFileSync(join(logDir, "decisions.jsonl"), "utf8");
  assert.match(logged, /tool_result_warning/);
  assert.ok(!logged.includes(text.slice(3, 12)));
});

test("도구 결과 검사: 민감 정보 없음, 로컬 모델로 가는 중, 정책 off는 경고하지 않는다", async () => {
  const clean = setup({ local: [], analyzer: byPrompt });
  const r = await clean.user("마이크로서비스 설계 판단");
  await cont(clean.route, clean.ctx, r.state, r.model, [toolResult("const total = a + b;")]);
  assert.equal(clean.notes.length, 0);

  const off = setup({ local: [], analyzer: byPrompt, toolPolicy: "off" });
  const r2 = await off.user("마이크로서비스 설계 판단");
  await cont(off.route, off.ctx, r2.state, r2.model, [toolResult(fillTemplate("{{FAKE_PHONE}}", 1))]);
  assert.equal(off.notes.length, 0);

  const local = setup({ analyzer: byPrompt });
  const r3 = await local.user("TCP와 UDP 차이");
  assert.equal(r3.model.provider, "acme");
  const msgs = [toolResult(fillTemplate("{{FAKE_PHONE}}", 2))];
  await cont(local.route, local.ctx, r3.state, r3.model, msgs);
  assert.equal(local.notes.length, 0, "로컬 모델로 가면 경고하지 않는다");
  const ext = await local.user("마이크로서비스 설계 판단", r3.state, "medium", msgs);
  assert.equal(ext.model.provider, "anthropic");
  assert.equal(local.notes.length, 1, "외부 모델로 바뀌면 이전 도구 결과에 대해 경고한다");
});

test("도구 결과의 주제어(data_terms)는 경고하지 않는다 (표식이 아니라 말)", async () => {
  const { route, ctx, user, notes } = setup({ local: [], analyzer: byPrompt });
  const r = await user("마이크로서비스 설계 판단");
  await cont(route, ctx, r.state, r.model, [toolResult("고객정보 처리 모듈 구현. 개인정보 마스킹은 따로 보강할 것")]);
  assert.equal(notes.length, 0);
});

test("도구 결과의 비밀 값은 여기서 보지 않는다 (secret-guard 담당)", async () => {
  const { route, ctx, user, notes } = setup({ local: [], analyzer: byPrompt });
  const r = await user("마이크로서비스 설계 판단");
  await cont(route, ctx, r.state, r.model, [toolResult(fillTemplate("키 {{FAKE_AWS_KEY}}", 3))]);
  assert.equal(notes.length, 0);
});

test("사용자가 중단하면 판단을 멈추고 요청을 끝낸다", async () => {
  const ac = new AbortController();
  const { route, ctx, calls } = setup({ analyzerDelay: 200 });
  setTimeout(() => ac.abort(), 30);
  await assert.rejects(route({ reason: "user", thinkingLevel: "medium", signal: ac.signal, messages: [{ role: "user", content: "TCP와 UDP 차이" }] }, ctx), /중단/);
  assert.deepEqual(calls, ["acme/local-coder"], "대체 모델은 시도하지 않는다");
});

test("decision_timeout_ms가 판단 전체 시간을 제한한다 (대체 모델을 더 시도하지 않는다)", async () => {
  const { user, calls, records } = setup({ analyzer: () => "", analyzerDelay: 120, decisionTimeout: 60 });
  const r = await user("TCP와 UDP 차이");
  assert.deepEqual(calls, ["acme/local-coder"]);
  assert.equal(records.at(-1).stage2, "timeout");
  assert.equal(r.state.tier, "heavy", "판단 실패 시 기본 티어");
});

test("세션 고정이어도 이미지가 오면 이미지를 못 받는 고정 모델은 다시 결정한다", async () => {
  const { route, ctx, user } = setup({ scope: "session", analyzer: byPrompt });
  const r1 = await user("TCP와 UDP 차이");
  assert.equal(r1.state.tier, "local");
  const r2 = await route({ reason: "user", thinkingLevel: "medium", state: r1.state, messages: [{ role: "user", content: [{ type: "text", text: "이 화면 설명" }, { type: "image" }] }] }, ctx);
  assert.notEqual(r2.state.tier, "local");
});

test("세션 고정이어도 대화가 너무 길면 컨텍스트가 작은 고정 모델은 다시 결정한다", async () => {
  const { user } = setup({ scope: "session", analyzer: byPrompt });
  const r1 = await user("TCP와 UDP 차이");
  const history = [{ role: "toolResult", content: [{ type: "text", text: "x".repeat(4 * 120_000) }] }];
  const r2 = await user("TCP와 UDP 차이", r1.state, "medium", history);
  assert.notEqual(r2.state.tier, "local");
});

const asst = (total: number) => ({ role: "assistant", stopReason: "stop", usage: { input: total - 100, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: total }, content: [{ type: "text", text: "ok" }] });

test("컨텍스트 추정: 직전 응답의 실제 사용량 + 그 뒤 메시지", () => {
  const e = estimateContext([{ role: "user", content: "a".repeat(40_000) }, asst(30_000), { role: "toolResult", content: [{ type: "text", text: "b".repeat(4_000) }] }]);
  assert.deepEqual([e.basis, e.tokens], ["usage", 30_000 + 1_000]);
});

test("컨텍스트 추정: 응답이 없거나 실패 응답뿐이거나 사용량이 비정상이면 문자 수로", () => {
  assert.equal(estimateContext([{ role: "user", content: "a".repeat(400) }]).basis, "chars");
  assert.equal(estimateContext([{ role: "user", content: "a" }, { ...asst(500), stopReason: "error" }]).basis, "chars");
  // 압축 직후: 남은 메시지는 작은데 사용량은 압축 전 크기
  const stale = estimateContext([{ role: "user", content: "a".repeat(400) }, asst(900_000)]);
  assert.equal(stale.basis, "chars");
  assert.ok(stale.tokens < 1000);
});

test("결정 로그의 실제 기록이 decision-log 스키마를 따른다 (결정, 판단 실패, 도구 결과 경고)", async () => {
  const schemas = new SchemaSet(join(import.meta.dirname, "../spec/schemas"));
  const { route, ctx, user, logDir } = setup({ local: [], analyzer: byPrompt });
  const r = await user("마이크로서비스 설계 판단");
  await cont(route, ctx, r.state, r.model, [toolResult(fillTemplate("{{FAKE_PHONE}}", 9))]);
  const bad = setup({ analyzer: () => "" });
  await bad.user("TCP와 UDP 차이");
  await user(fillTemplate("#local 고객 {{FAKE_PHONE}}", 1)).catch(() => {});
  const lines = [logDir, bad.logDir].flatMap((d) => readFileSync(join(d, "decisions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)));
  assert.ok(lines.some((l) => l.kind === "tool_result_warning") && lines.some((l) => l.kind === "decision" && l.stage2 !== "ok"));
  for (const l of lines) assert.deepEqual(schemas.validate("decision-log.schema.json", l), [], JSON.stringify(l).slice(0, 200));
});

test("결정 로그: 소유자만 읽을 수 있고, 크기가 넘으면 이전 파일로 민다", async () => {
  const { user, logDir } = setup({ analyzer: byPrompt });
  await user("TCP와 UDP 차이");
  const file = join(logDir, "decisions.jsonl");
  assert.equal(statSync(file).mode & 0o077, 0, "그룹·기타 권한 없음");
  assert.equal(statSync(join(logDir, "salt")).mode & 0o077, 0);
  appendFileSync(file, "x".repeat(LOG_MAX_BYTES));
  await user("TCP와 UDP 차이");
  assert.ok(existsSync(join(logDir, "decisions.1.jsonl")));
  assert.ok(statSync(file).size < 10_000, "새 파일로 시작");
  assert.equal(statSync(file).mode & 0o077, 0);
});

test("디버그 출력: 비밀 값은 가리고 민감 정보가 보이면 본문을 남기지 않는다", async () => {
  const dbg = join(mkdtempSync(join(tmpdir(), "router-dbg-")), "stage2.jsonl");
  process.env.LLM_ROUTER_DEBUG_STAGE2 = dbg;
  try {
    const key = fillTemplate("{{FAKE_AWS_KEY}}", 4);
    const phone = fillTemplate("{{FAKE_PHONE}}", 4);
    const { user } = setup({ analyzer: () => json("explain", 0, "general").replace("테스트", `키 ${key}`) });
    await user("TCP와 UDP 차이");
    const { user: user2 } = setup({ analyzer: () => json("explain", 0, "general").replace("테스트", `연락처 ${phone}`) });
    await user2("TCP와 UDP 차이");
    const raw = readFileSync(dbg, "utf8");
    assert.ok(!raw.includes(key) && !raw.includes(phone));
    assert.match(raw, /MASKED/);
    assert.match(raw, /본문 생략/);
    assert.equal(statSync(dbg).mode & 0o077, 0);
  } finally {
    delete process.env.LLM_ROUTER_DEBUG_STAGE2;
  }
});

test("재시도: 공급자 일시 장애면 같은 티어의 다른 모델, 그 밖의 오류는 같은 모델", async () => {
  const { route, ctx, user } = setup({ local: ["acme/local-a", "acme/local-b"], analyzer: byPrompt });
  const r = await user("TCP와 UDP 차이");
  assert.equal(r.model.id, "local-a");
  const retry = (errorMessage: string) => route({ reason: "retry", thinkingLevel: "medium", state: r.state, failed: { model: r.model, thinkingLevel: "off", message: { stopReason: "error", errorMessage } }, messages: [] }, ctx);
  assert.equal((await retry("529 overloaded_error")).model.id, "local-b");
  assert.equal((await retry("ECONNRESET: socket hang up")).model.id, "local-b");
  assert.equal((await retry("400 prompt is too long: 250000 tokens > 200000 maximum")).model.id, "local-a");
  assert.equal((await retry("401 invalid api key")).model.id, "local-a");
});

test("재시도: 같은 티어에 대체 모델이 없으면 같은 모델", async () => {
  const { route, ctx, user } = setup({ analyzer: byPrompt });
  const r = await user("TCP와 UDP 차이");
  const out = await route({ reason: "retry", thinkingLevel: "medium", state: r.state, failed: { model: r.model, message: { errorMessage: "503 service unavailable" } }, messages: [] }, ctx);
  assert.equal(out.model, r.model);
});

test("tool_result_policy: confirm — 허용하면 보내고 한 번만 묻는다 (값 없이)", async () => {
  const { route, ctx, user, asked, notes } = setup({ local: [], analyzer: byPrompt, toolPolicy: "confirm" });
  const r = await user("마이크로서비스 설계 판단");
  const text = fillTemplate("고객 {{FAKE_PHONE}}", 5);
  const msgs = [toolResult(text)];
  const out = await cont(route, ctx, r.state, r.model, msgs);
  assert.equal(out.model, r.model);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /pii\.phone_kr/);
  assert.ok(!asked[0].includes(text.slice(3, 12)));
  await cont(route, ctx, r.state, r.model, msgs);
  assert.equal(asked.length, 1);
  assert.equal(notes.length, 0, "confirm이면 별도 경고 알림은 없다");
});

test("tool_result_policy: confirm — 거부하면 요청이 끝나고 다음에 다시 묻는다", async () => {
  const { route, ctx, user, asked } = setup({ local: [], analyzer: byPrompt, toolPolicy: "confirm", answer: false });
  const r = await user("마이크로서비스 설계 판단");
  const msgs = [toolResult(fillTemplate("{{FAKE_PHONE}}", 6))];
  await assert.rejects(cont(route, ctx, r.state, r.model, msgs), /거부/);
  await assert.rejects(cont(route, ctx, r.state, r.model, msgs), /거부/);
  assert.equal(asked.length, 2);
});

test("confirm인데 확인할 화면이 없으면 보내지 않는다", async () => {
  const { route, ctx, user } = setup({ local: [], analyzer: byPrompt, toolPolicy: "confirm", noUi: true });
  const r = await user("마이크로서비스 설계 판단");
  await assert.rejects(cont(route, ctx, r.state, r.model, [toolResult(fillTemplate("{{FAKE_PHONE}}", 7))]), /확인할 화면이 없어/);
});

test("suspicion_without_local: confirm — 허용하면 진행, 거부하면 종료", async () => {
  const yes = setup({ local: [], analyzer: () => suspected(), suspicion: "confirm" });
  const r = await yes.user("TCP와 UDP 차이");
  assert.equal(r.state.tier, "light");
  assert.equal(yes.asked.length, 1);
  const no = setup({ local: [], analyzer: () => suspected(), suspicion: "confirm", answer: false });
  await assert.rejects(no.user("TCP와 UDP 차이"), /거부/);
  const none = setup({ local: [], analyzer: () => json("explain", 0, "general"), suspicion: "confirm" });
  await none.user("TCP와 UDP 차이");
  assert.equal(none.asked.length, 0, "의심이 없으면 묻지 않는다");
});

test("짧은 후속 요청은 앞 대화를 판단 모델에 함께 보낸다", async () => {
  const seen: string[] = [];
  const { user, records } = setup({ analyzer: (p) => { seen.push(p); return json("debug", 2); } });
  const history = [{ role: "user", content: "결제 모듈의 반올림 버그 원인을 찾아줘" }, { role: "assistant", content: [{ type: "text", text: "원인은 tier 계산입니다. 고칠까요?" }] }];
  await user("응 해줘", undefined, "medium", history);
  assert.match(seen[0], /\[이전 대화\][\s\S]*반올림 버그[\s\S]*고칠까요[\s\S]*\[이번 요청\]\n응 해줘/);
  assert.equal(records.length, 1);
  seen.length = 0;
  await user("결제 모듈의 반올림 버그 원인을 자세히 찾아서 고쳐 주고 테스트도 추가해 줘. 범위는 pricing 폴더 전체", undefined, "medium", history);
  assert.ok(!seen[0].includes("[이전 대화]"), "긴 요청은 앞 대화를 붙이지 않는다");
});

test("후속 요청의 앞 대화가 로컬 전용이면 이번 요청도 로컬로 처리한다", async () => {
  const { user, calls } = setup({ analyzer: byPrompt });
  const history = [{ role: "user", content: fillTemplate("고객 {{FAKE_PHONE}}에게 보낼 문구 써줘", 3) }, { role: "assistant", content: "초안입니다. 이대로 쓸까요?" }];
  const r = await user("응 그걸로", undefined, "medium", history);
  assert.equal(r.state.tier, "local");
  assert.deepEqual(calls, ["acme/local-coder"]);
});

test("followUpContext: 짧은 요청과 앞 대화가 있을 때만, 설정 0이면 끈다", () => {
  const msgs = [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "응" }];
  assert.deepEqual(followUpContext(msgs, 60), { users: ["a"], assistant: "b" });
  assert.equal(followUpContext(msgs, 0), null);
  assert.equal(followUpContext([{ role: "user", content: "응" }], 60), null);
  assert.equal(followUpContext([...msgs.slice(0, 2), { role: "user", content: "x".repeat(100) }], 60), null);
});
