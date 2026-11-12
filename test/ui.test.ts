import assert from "node:assert/strict";
import { test } from "node:test";
import type { DecisionRecord } from "../src/runtime.ts";
import { CARD_TYPE, currentQueryAssistants, registerUi } from "../src/ui.ts";

const rec = (tier: string, model: string): DecisionRecord => ({
  state: { v: 1, task_id: "t", query_id: "q_1", scope: "query", tier, model, thinking: "low", operating_point: "balanced", decided_at: "", decision_ref: `d_${tier}`, mode: "A", pinned_by: "router", sensitive: false },
  decision: { tier, model, thinking: "low", base_tier: tier, base_thinking: "low", table_cell: "explain/easy", operating_point: "balanced", adjustments: [], thinking_adjustments: [], capped: false, ask_user: false, reason: "", fallback_reason: null },
  analyzer: "acme/local-coder", stage2: "ok", latency_ms: { stage1: 1, stage2: 4000, total: 4001 },
});
const msg = (role: string, extra = {}) => ({ type: "message", message: { role, ...extra } });
const asst = (provider: string, model: string, cost = 0) => msg("assistant", { provider, model, thinkingLevel: "low", usage: { input: 10, output: 5, cacheRead: 0, cost: { total: cost } } });

function setup(pinScope: "query" | "session" = "query") {
  const handlers: Record<string, Function> = {};
  const entries: any[] = [];
  const statuses: (string | undefined)[] = [];
  const notes: string[] = [];
  let renderer: Function | undefined;
  let command: any;
  const pending = new Map<string, DecisionRecord>();
  const last = new Map<string, DecisionRecord>();
  const host = {
    on: (e: string, h: Function) => { handlers[e] = h; },
    appendEntry: (type: string, data: unknown) => { entries.push({ type: "custom", customType: type, data }); },
    registerEntryRenderer: (_t: string, r: Function) => { renderer = r; },
    registerCommand: (_n: string, c: any) => { command = c; },
  };
  registerUi(host as never, { last, pinScope, takePending: (sid) => { const r = pending.get(sid); pending.delete(sid); return r; } });
  const branch: any[] = [];
  const ctx = {
    model: { provider: "router", id: "auto" },
    ui: { setStatus: (_k: string, t: string | undefined) => statuses.push(t), notify: (m: string) => notes.push(m) },
    sessionManager: { getBranch: () => [...branch, ...entries], getSessionId: () => "s" },
  };
  const query = (text: string, answers: any[], decision?: DecisionRecord) => {
    branch.push(msg("user", { content: text }), ...answers);
    if (decision) {
      pending.set("s", decision);
      last.set("s", decision);
    }
    handlers.agent_settled({ aborted: false }, ctx);
  };
  return { handlers, entries, statuses, notes, ctx, query, get renderer() { return renderer; }, get command() { return command; } };
}

test("현재 쿼리의 응답만 모은다", () => {
  const b = [msg("user"), asst("a", "x"), msg("user"), asst("b", "y"), msg("toolResult"), asst("b", "y")];
  assert.deepEqual(currentQueryAssistants(b as never).map((m) => m.model), ["y", "y"]);
});

test("쿼리가 끝나면 카드를 남기고 상태줄을 갱신한다", () => {
  const s = setup();
  s.query("q1", [asst("acme", "local-coder"), asst("acme", "local-coder")], rec("local", "acme/local-coder"));
  s.query("q2", [asst("anthropic", "claude-opus-5-5", 0.05)], rec("heavy", "anthropic/claude-opus-5-5"));
  assert.equal(s.entries.length, 2);
  assert.equal(s.entries[0].customType, CARD_TYPE);
  assert.equal(s.entries[0].data.usage.calls, 2);
  assert.equal(s.entries[1].data.tier, "heavy");
  assert.equal(s.statuses.at(-1), "router ▸ local 1 · heavy 1  $0.050");
});

test("새 결정이 없으면 카드 없음 (query 모드), 세션 고정이면 '이전 결정 유지' 카드", () => {
  const q = setup("query");
  q.query("q1", [asst("acme", "local-coder")], rec("local", "acme/local-coder"));
  q.query("q2 (차단됨)", [msg("assistant", { stopReason: "error" })]);
  assert.equal(q.entries.length, 1);
  const s = setup("session");
  s.query("q1", [asst("acme", "local-coder")], rec("local", "acme/local-coder"));
  s.query("q2", [asst("acme", "local-coder")]);
  assert.equal(s.entries.length, 2);
  assert.equal(s.entries[1].data.pinned, true);
  assert.notEqual(s.entries[1].data.card_id, s.entries[0].data.card_id);
});

test("router/auto가 아닌 모델로 대화하면 카드 없음", () => {
  const s = setup();
  s.ctx.model = { provider: "anthropic", id: "claude-opus-5-5" };
  s.query("q1", [asst("anthropic", "claude-opus-5-5")]);
  assert.equal(s.entries.length, 0);
});

test("세션을 다시 열면 카드에서 상태줄 복원", () => {
  const s = setup();
  s.query("q1", [asst("acme", "local-coder")], rec("local", "acme/local-coder"));
  s.handlers.session_start({}, s.ctx);
  assert.equal(s.statuses.at(-1), "router ▸ local 1  $0");
});

test("렌더러와 /router stats", () => {
  const s = setup();
  s.query("q1", [asst("acme", "local-coder")], rec("local", "acme/local-coder"));
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
  const comp = s.renderer!({ data: s.entries[0].data }, { expanded: false }, theme);
  assert.match(comp.render(80)[0], /◆ router {2}local · local-coder · low/);
  s.command.handler("stats", s.ctx);
  assert.match(s.notes.at(-1)!, /라우팅 쿼리 1건/);
  assert.match(s.notes.at(-1)!, /local-coder/);
  s.command.handler("", s.ctx);
  assert.match(s.notes.at(-1)!, /local · local-coder · low/);
});
