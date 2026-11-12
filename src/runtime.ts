/**
 * pi virtual model `router/auto` (07-spec §7).
 * - reason "user"        : 사용자 쿼리마다 1단 → 2단 → decide로 (티어, 모델, 추론 강도)를 정하고 상태로 저장한다.
 *                          pin_scope가 "session"이면 첫 결정을 유지한다.
 * - reason "continuation": 같은 쿼리의 도구 루프. 직전 응답 모델을 유지한다 (캐시 보존).
 * - reason "retry"       : 실패한 요청의 모델을 유지한다.
 * - reason "direct"      : 요약 등 루프 밖 요청. direct_tier 모델.
 * 결정 로그에는 쿼리 원문을 남기지 않는다 (해시와 분석 결과만).
 */
import { createHmac, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mergeStages } from "./analyze.ts";
import type { Loaded } from "./config.ts";
import { decide, type Decision, type OperatingPoint, type Thinking } from "./decide.ts";
import { refOf, resolveAnalyzers, resolveRoster, splitRef, type CatalogModel } from "./models.ts";
import { maskSecrets, runStage1Safe } from "./stage1.ts";
import { runStage2, type Complete, type Stage2Result } from "./stage2.ts";

/** 이 모듈이 쓰는 pi 부분 (실제 타입은 @earendil-works/pi-coding-agent). */
type PiModel = { provider: string; id: string; contextWindow?: number; maxTokens?: number; input?: string[]; reasoning?: boolean; cost?: { input: number; output: number } };
interface Registry {
  getAvailable(): PiModel[];
  find(provider: string, id: string): PiModel | undefined;
  streamSimple(model: PiModel, context: { systemPrompt?: string; messages: unknown[] }, options?: Record<string, unknown>): { result(): Promise<{ content: { type: string; text?: string }[]; stopReason: string; errorMessage?: string }> };
}
interface RouteCtx { modelRegistry: Registry; sessionManager?: { getSessionId(): string } }
interface RouteRequest<S> {
  thinkingLevel: string;
  reason: "user" | "continuation" | "retry" | "direct";
  previous?: { model: PiModel; thinkingLevel?: string };
  failed?: { model: PiModel; thinkingLevel?: string };
  state?: S;
  messages: readonly { role: string; content?: unknown }[];
  signal?: AbortSignal;
}
interface RouteResult<S> { model: PiModel; thinkingLevel: string; state?: S }
export interface RouterHost {
  registerVirtualModel(def: {
    provider: string; id: string; name: string; thinkingLevels: string[]; contextWindow?: number; maxTokens?: number;
    route(req: RouteRequest<RouterState>, ctx: RouteCtx): Promise<RouteResult<RouterState>>;
  }): void;
  registerCommand?(name: string, opts: { description: string; handler: (args: string, ctx: { ui: { notify(msg: string, level?: string): void }; sessionManager?: { getSessionId(): string } }) => unknown }): void;
}

export interface RouterState {
  v: 1;
  task_id: string;
  query_id: string;
  scope: "query" | "session";
  tier: string;
  model: string;
  thinking: Thinking;
  operating_point: OperatingPoint;
  decided_at: string;
  decision_ref: string;
  mode: "A" | "B" | "C";
  pinned_by: "router" | "user" | "escalation";
  sensitive: boolean;
}

export interface DecisionRecord {
  state: RouterState;
  decision: Decision;
  analyzer: string | null;
  stage2: Stage2Result["status"];
  latency_ms: { stage1: number; stage2: number | null; total: number };
}

function lastUserText(messages: RouteRequest<unknown>["messages"]): string {
  const m = [...messages].reverse().find((x) => x.role === "user");
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) return m.content.filter((b: { type?: string }) => b?.type === "text").map((b: { text?: string }) => b.text ?? "").join("\n");
  return "";
}

function hasImage(messages: RouteRequest<unknown>["messages"]): boolean {
  const m = [...messages].reverse().find((x) => x.role === "user");
  return Array.isArray(m?.content) && m.content.some((b: { type?: string }) => b?.type === "image");
}

const toCatalog = (m: PiModel): CatalogModel => ({ provider: m.provider, id: m.id, contextWindow: m.contextWindow, maxTokens: m.maxTokens, input: m.input, reasoning: m.reasoning, cost: m.cost });

class DecisionLog {
  private dir: string;
  private salt: Buffer | null = null;
  constructor(dir: string) {
    this.dir = dir;
  }
  private ensure(): Buffer {
    if (this.salt) return this.salt;
    mkdirSync(this.dir, { recursive: true });
    const p = join(this.dir, "salt");
    if (!existsSync(p)) writeFileSync(p, randomBytes(32).toString("hex"), { mode: 0o600 });
    this.salt = Buffer.from(readFileSync(p, "utf8"), "hex");
    return this.salt;
  }
  hash(text: string): string {
    return createHmac("sha256", this.ensure()).update(text).digest("hex").slice(0, 32);
  }
  write(rec: Record<string, unknown>): void {
    try {
      this.ensure();
      appendFileSync(join(this.dir, "decisions.jsonl"), JSON.stringify(rec) + "\n");
    } catch {
      // 기록 실패는 라우팅을 막지 않는다
    }
  }
}

export function registerRouter(pi: RouterHost, loaded: Loaded, opts: { onDecision?: (r: DecisionRecord) => void } = {}) {
  const { cfg, taxonomy, rules, table } = loaded;
  const log = new DecisionLog(cfg.log_dir);
  const last = new Map<string, DecisionRecord>();

  const completeVia = (reg: Registry, ref: string, thinking?: Thinking): Complete => async (system, user, signal) => {
    const { provider, id } = splitRef(ref);
    const model = reg.find(provider, id);
    if (!model) throw new Error(`모델 없음: ${ref}`);
    const res = await reg.streamSimple(model, { systemPrompt: system, messages: [{ role: "user", content: user, timestamp: Date.now() }] },
      { signal, maxTokens: cfg.analyzer.max_tokens, ...(thinking && thinking !== "off" ? { reasoning: thinking } : {}) }).result();
    if (res.stopReason === "error" || res.stopReason === "aborted") throw new Error(res.errorMessage ?? res.stopReason);
    const out = res.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    // 추론형 모델은 사고 과정이 출력 상한을 다 쓰면 본문이 비어 있다. 형식 오류가 아니라 호출 실패로 보고 다음 판단 모델로 넘긴다.
    if (!out.trim()) throw new Error(`본문 없음 (stop=${res.stopReason}, 블록 ${res.content.map((b) => b.type).join(",") || "없음"})`);
    // 진단용: 환경 변수를 켠 경우에만 원시 출력 기록 (합성 데이터 검증 전용)
    if (process.env.LLM_ROUTER_DEBUG_STAGE2) appendFileSync(process.env.LLM_ROUTER_DEBUG_STAGE2, JSON.stringify({ ref, stop: res.stopReason, blocks: res.content.map((b) => b.type), len: out.length, head: out.slice(0, 300), tail: out.slice(-200) }) + "\n");
    return out;
  };

  const physical = (reg: Registry, ref: string): PiModel => {
    const { provider, id } = splitRef(ref);
    const m = reg.find(provider, id);
    if (!m) throw new Error(`라우터가 고른 모델을 찾을 수 없습니다: ${ref}`);
    return m;
  };

  async function decideForQuery(req: RouteRequest<RouterState>, ctx: RouteCtx): Promise<RouteResult<RouterState>> {
    const t0 = Date.now();
    const reg = ctx.modelRegistry;
    const available = reg.getAvailable().filter((m) => !(m.provider === "router"));
    const catalog = available.map(toCatalog);
    const roster = resolveRoster(loaded.roster, cfg.local_models, catalog);
    const analyzers = resolveAnalyzers(cfg.analyzer, roster, catalog);
    const text = lastUserText(req.messages);
    const s1 = runStage1Safe(rules, { text, attachments: hasImage(req.messages) ? ["image"] : [], internalMarkers: cfg.internal_markers });
    const t1 = Date.now();
    const route = s1.hard_constraints.data_sensitivity === "internal_only" ? analyzers.internal_only : analyzers.external_ok;
    const input = cfg.analyzer.mask_secrets ? maskSecrets(rules, text).text : text;
    const s2: Stage2Result = route.length
      ? await runStage2(input, taxonomy, route.map((r) => ({ ref: r.ref, complete: completeVia(reg, r.ref, (r as { thinking?: Thinking }).thinking) })), cfg.analyzer.timeout_ms)
      : { status: "unavailable", output: null, latency_ms: 0, error: "판단 모델 없음" };
    const { analysis } = mergeStages(s1, s2);
    const op = cfg.virtual_levels[req.thinkingLevel as "low" | "medium" | "high"] ?? "balanced";
    const isAvail = new Set(catalog.map(refOf));
    // 결정 실패(필수 제약을 만족하는 티어 없음)는 그대로 던져 요청을 막는다 (fail-closed)
    const decision = decide(analysis, roster, table, cfg, op, (ref) => isAvail.has(ref));
    const qid = log.hash(text);
    const state: RouterState = {
      v: 1, task_id: req.state?.task_id ?? `t_${qid.slice(0, 12)}`, query_id: `q_${qid.slice(0, 12)}`, scope: cfg.pin_scope,
      tier: decision.tier, model: decision.model, thinking: decision.thinking, operating_point: op,
      decided_at: new Date().toISOString(), decision_ref: `d_${Date.now().toString(36)}`, mode: cfg.mode, pinned_by: "router",
      sensitive: analysis.hard_constraints.data_sensitivity === "internal_only",
    };
    const rec: DecisionRecord = { state, decision, analyzer: s2.model ?? null, stage2: s2.status, latency_ms: { stage1: t1 - t0, stage2: route.length ? s2.latency_ms : null, total: Date.now() - t0 } };
    const sid = ctx.sessionManager?.getSessionId() ?? "default";
    last.set(sid, rec);
    opts.onDecision?.(rec);
    log.write({
      v: 1, ts: state.decided_at, session: log.hash(sid).slice(0, 12), query: state.query_id, prompt_hash: qid,
      rule_hits: s1.rule_hits, task_type: analysis.task_type, dimensions: analysis.dimensions, confidence: analysis.confidence,
      decision: { tier: decision.tier, model: decision.model, thinking: decision.thinking, cell: decision.table_cell, adjustments: decision.adjustments, thinking_adjustments: decision.thinking_adjustments, capped: decision.capped, ask_user: decision.ask_user, operating_point: op },
      analyzer: s2.model ?? null, stage2: s2.status, stage2_error: s2.error?.slice(0, 200) ?? null, latency_ms: rec.latency_ms,
    });
    return { model: physical(reg, decision.model), thinkingLevel: decision.thinking, state };
  }

  pi.registerVirtualModel({
    provider: "router",
    id: "auto",
    name: "Auto (llm-router)",
    thinkingLevels: ["low", "medium", "high"],
    contextWindow: 128_000,
    maxTokens: 16_384,
    async route(req, ctx) {
      const reg = ctx.modelRegistry;
      if (req.reason === "retry" && req.failed) return { model: req.failed.model, thinkingLevel: req.failed.thinkingLevel ?? req.state?.thinking ?? "off" };
      if (req.reason === "continuation") {
        if (req.previous) return { model: req.previous.model, thinkingLevel: req.previous.thinkingLevel ?? req.state?.thinking ?? "off" };
        if (req.state) return { model: physical(reg, req.state.model), thinkingLevel: req.state.thinking };
      }
      if (req.reason === "direct") {
        const avail = new Set(reg.getAvailable().map(refOf));
        const roster = resolveRoster(loaded.roster, cfg.local_models, reg.getAvailable().map(toCatalog));
        const tier = roster.tiers.find((t) => t.id === cfg.direct_tier && t.models.some((m) => avail.has(m.ref))) ?? roster.tiers.find((t) => t.models.some((m) => avail.has(m.ref)));
        const m = tier?.models.find((x) => avail.has(x.ref));
        if (!m) throw new Error("요약 등에 쓸 모델이 없습니다");
        return { model: physical(reg, m.ref), thinkingLevel: m.default_thinking };
      }
      // 사용자 쿼리: session 고정이면 첫 결정 유지, 아니면 다시 결정.
      // 고정 중이라도 1단 규칙은 쿼리마다 본다. 사내 전용 데이터인데 고정 모델이 외부 모델이면 다시 결정한다.
      if (req.state && (cfg.pin_scope === "session" || req.state.pinned_by !== "router")) {
        const s1 = runStage1Safe(rules, { text: lastUserText(req.messages), internalMarkers: cfg.internal_markers });
        const pinnedInternal = cfg.local_models.some((m) => (typeof m === "string" ? m : m.ref) === req.state!.model);
        if (s1.hard_constraints.data_sensitivity !== "internal_only" || pinnedInternal) {
          return { model: physical(reg, req.state.model), thinkingLevel: req.state.thinking };
        }
      }
      return decideForQuery(req, ctx);
    },
  });

  pi.registerCommand?.("router", {
    description: "llm-router: 마지막 결정 보기 (/router status)",
    handler: (_args, ctx) => {
      const rec = last.get(ctx.sessionManager?.getSessionId() ?? "default");
      if (!rec) return ctx.ui.notify("아직 결정이 없습니다. /model router/auto 로 선택한 뒤 질문하세요.", "info");
      const d = rec.decision;
      ctx.ui.notify([
        `티어 ${d.tier} · ${d.model} · 추론 ${d.thinking} (운영점 ${d.operating_point})`,
        `조회표 ${d.table_cell ?? "-"}${d.adjustments.length ? ` · 보정 ${d.adjustments.join(", ")}` : ""}${d.thinking_adjustments.length ? ` · 추론 보정 ${d.thinking_adjustments.join(", ")}` : ""}`,
        `판단 모델 ${rec.analyzer ?? "없음"} (${rec.stage2}) · ${rec.latency_ms.total}ms${d.ask_user ? " · 요청이 모호합니다" : ""}`,
      ].join("\n"), "info");
    },
  });

  return { last };
}
