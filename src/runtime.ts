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
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mergeStages } from "./analyze.ts";
import type { Loaded } from "./config.ts";
import { clampThinking, decide, type AnalysisInput, type Decision, type OperatingPoint, type Thinking } from "./decide.ts";
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
interface RouteCtx { modelRegistry: Registry; sessionManager?: { getSessionId(): string }; hasUI?: boolean; ui?: { notify(msg: string, level?: string): void; confirm?(title: string, message: string): Promise<boolean> } }
interface RouteRequest<S> {
  thinkingLevel: string;
  reason: "user" | "continuation" | "retry" | "direct";
  previous?: { model: PiModel; thinkingLevel?: string };
  failed?: { model: PiModel; thinkingLevel?: string; message?: { stopReason?: string; errorMessage?: string } };
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
  /** "user"·"escalation"은 예약 값이다 (사용자 고정, 상향 재시도). 지금은 router만 기록하지만 값이 있으면 고정으로 취급한다 */
  pinned_by: "router" | "user" | "escalation";
  sensitive: boolean;
}

export interface DecisionRecord {
  state: RouterState;
  decision: Decision;
  analyzer: string | null;
  stage2: Stage2Result["status"];
  latency_ms: { stage1: number; stage2: number | null; total: number };
  /** 2단 민감 의심을 반영하지 않은 이유 (no_local이면 화면에 경고) */
  suspicion_ignored?: "secret_masked" | "no_local" | null;
  /** 대화 전체 예상 토큰 수 */
  est_context_tokens?: number;
}

/**
 * 공급자·모델 쪽 일시 장애로 보이는 오류인가 (과부하, 속도 제한, 5xx, 연결 실패, 시간 초과).
 * 컨텍스트 초과는 모델을 바꿔도 같으므로 제외한다 (압축 후 같은 모델로 재시도).
 */
export function isProviderFault(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false;
  if (/context|too long|too large|maximum.{0,20}(tokens|length)|prompt is too/i.test(errorMessage)) return false;
  return /overload|rate.?limit|too many requests|\b429\b|\b5\d\d\b|unavailable|capacity|server error|bad gateway|timed? ?out|timeout|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|connection|network|fetch failed/i.test(errorMessage);
}

/** 도구 결과에서 민감 정보 규칙이 걸린 건 (값은 담지 않는다) */
export interface ToolResultWarning { tool: string; rules: string[] }

/** 판단 실패 시 분석 결과의 차원은 일부만 null이다. 로그에는 모든 키를 채워 같은 형식으로 남긴다. */
function fullDimensions(d: AnalysisInput["dimensions"]) {
  const caps = d.capabilities as Record<string, number | null>;
  const keys = ["long_context", "multi_step_tools", "code_correctness", "instruction_following", "korean_writing", "reasoning"];
  return {
    difficulty: d.difficulty ?? null, ambiguity: d.ambiguity ?? null, scope: d.scope ?? null, verifiability: d.verifiability ?? null,
    consistency: (d as { consistency?: number | null }).consistency ?? null,
    capabilities: Object.fromEntries(keys.map((k) => [k, caps[k] ?? null])),
  };
}

/** 표시나 단가가 없는 이미지 한 장의 대략적인 토큰 수 */
const IMAGE_TOKENS = 1600;

/**
 * 대화 전체(시스템·사용자·어시스턴트·도구 결과)의 토큰 수를 거칠게 추정한다. 토크나이저 없이 문자 수로:
 * ASCII 4자 ≈ 1토큰, 그 밖(한글 등) 1.5자 ≈ 1토큰, 이미지 한 장 ≈ 1600토큰.
 * 도구 정의는 messages에 없어 빠진다.
 */
export function estimateTokens(messages: readonly { role?: string; content?: unknown }[]): number {
  let ascii = 0;
  let other = 0;
  let images = 0;
  const add = (s: unknown) => {
    if (typeof s !== "string" || !s) return;
    const nonAscii = s.replace(/[\x00-\x7f]+/g, "").length;
    other += nonAscii;
    ascii += s.length - nonAscii;
  };
  for (const m of messages) {
    if (typeof m.content === "string") add(m.content);
    else if (Array.isArray(m.content)) {
      for (const b of m.content as { type?: string; text?: unknown; thinking?: unknown; arguments?: unknown }[]) {
        if (b?.type === "image") images++;
        else if (b?.type === "text") add(b.text);
        else if (b?.type === "thinking") add(b.thinking);
        else if (b?.type === "toolCall") add(JSON.stringify(b.arguments ?? null));
      }
    }
  }
  return Math.ceil(ascii / 4 + other / 1.5) + images * IMAGE_TOKENS;
}

interface UsageLike { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number }
type Msg = { role?: string; content?: unknown; usage?: UsageLike; stopReason?: string };

/**
 * 이번 요청에 실릴 컨텍스트 크기. 가장 최근 정상 응답의 실제 입력 토큰 수(시스템 프롬프트·도구 정의 포함)에,
 * 그 뒤에 추가된 메시지만 문자 수로 추정해 더한다. 응답이 없으면 전체를 문자 수로 추정한다.
 * 압축 직후에는 남은 응답의 사용량이 압축 전 크기일 수 있으므로, 같은 구간의 문자 추정보다 지나치게 크면 쓰지 않는다.
 */
export function estimateContext(messages: readonly Msg[]): { tokens: number; basis: "usage" | "chars" } {
  const chars = () => ({ tokens: estimateTokens(messages), basis: "chars" as const });
  const i = messages.findLastIndex((m) => m.role === "assistant" && m.usage && m.stopReason !== "error" && m.stopReason !== "aborted");
  if (i < 0) return chars();
  const u = messages[i].usage!;
  const used = u.totalTokens ?? (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + (u.output ?? 0);
  if (!(used > 0)) return chars();
  // 시스템 프롬프트·도구 정의는 messages 밖이라 여유를 둔다
  if (used > estimateTokens(messages.slice(0, i + 1)) * 2 + USAGE_SLACK_TOKENS) return chars();
  return { tokens: used + estimateTokens(messages.slice(i + 1)), basis: "usage" };
}

/** 시스템 프롬프트와 도구 정의가 차지할 수 있는 토큰 여유 */
const USAGE_SLACK_TOKENS = 40_000;

function lastUserText(messages: RouteRequest<unknown>["messages"]): string {
  const m = [...messages].reverse().find((x) => x.role === "user");
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) return m.content.filter((b: { type?: string }) => b?.type === "text").map((b: { text?: string }) => b.text ?? "").join("\n");
  return "";
}

function textOf(m: { content?: unknown }): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) return m.content.filter((b: { type?: string }) => b?.type === "text").map((b: { text?: string }) => b.text ?? "").join("\n");
  return "";
}

/**
 * "응 해줘", "그걸로 진행"처럼 짧은 후속 요청은 앞 대화 없이는 난이도·행위를 판단할 수 없다.
 * 직전 사용자 메시지 2개와 직전 어시스턴트 답변의 일부를 모아 돌려준다. 짧은 요청이 아니거나 앞 대화가 없으면 null.
 * 이 텍스트는 판단 모델 입력과 1단 규칙(민감도)에 함께 쓰인다.
 */
export function followUpContext(messages: RouteRequest<unknown>["messages"], maxChars: number): { users: string[]; assistant: string } | null {
  if (!(maxChars > 0)) return null;
  const i = messages.findLastIndex((x) => x.role === "user");
  if (i <= 0 || textOf(messages[i]).trim().length > maxChars) return null;
  const before = messages.slice(0, i);
  const users = before.filter((x) => x.role === "user").slice(-2).map((x) => textOf(x).trim().slice(0, 300)).filter(Boolean);
  const a = before.findLast((x) => x.role === "assistant");
  const assistant = a ? textOf(a).trim().slice(-400) : "";
  return users.length || assistant ? { users, assistant } : null;
}

function hasImage(messages: RouteRequest<unknown>["messages"]): boolean {
  const m = [...messages].reverse().find((x) => x.role === "user");
  return Array.isArray(m?.content) && m.content.some((b: { type?: string }) => b?.type === "image");
}

const toCatalog = (m: PiModel): CatalogModel => ({ provider: m.provider, id: m.id, contextWindow: m.contextWindow, maxTokens: m.maxTokens, input: m.input, reasoning: m.reasoning, cost: m.cost });

/** 결정 로그 한 파일의 크기 상한과 보관할 이전 파일 수 */
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_KEEP = 3;

class DecisionLog {
  private dir: string;
  private salt: Buffer | null = null;
  constructor(dir: string) {
    this.dir = dir;
  }
  private ensure(): Buffer {
    if (this.salt) return this.salt;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const p = join(this.dir, "salt");
    if (!existsSync(p)) writeFileSync(p, randomBytes(32).toString("hex"), { mode: 0o600 });
    this.salt = Buffer.from(readFileSync(p, "utf8"), "hex");
    return this.salt;
  }
  /** 크기가 상한을 넘으면 decisions.1.jsonl … decisions.N.jsonl로 밀고 가장 오래된 것을 지운다 */
  private rotate(file: string): void {
    let size = 0;
    try { size = statSync(file).size; } catch { return; }
    if (size < LOG_MAX_BYTES) return;
    const nth = (n: number) => join(this.dir, `decisions.${n}.jsonl`);
    try { unlinkSync(nth(LOG_KEEP)); } catch { /* 없으면 무시 */ }
    for (let n = LOG_KEEP - 1; n >= 1; n--) try { renameSync(nth(n), nth(n + 1)); } catch { /* 없으면 무시 */ }
    renameSync(file, nth(1));
  }
  hash(text: string): string {
    return createHmac("sha256", this.ensure()).update(text).digest("hex").slice(0, 32);
  }
  write(rec: Record<string, unknown>): void {
    try {
      this.ensure();
      const file = join(this.dir, "decisions.jsonl");
      this.rotate(file);
      appendFileSync(file, JSON.stringify(rec) + "\n", { mode: 0o600 });
    } catch {
      // 기록 실패는 라우팅을 막지 않는다
    }
  }
}

export function registerRouter(pi: RouterHost, loaded: Loaded, opts: { onDecision?: (r: DecisionRecord) => void } = {}) {
  const { cfg, taxonomy, rules, table } = loaded;
  const log = new DecisionLog(cfg.log_dir);
  const last = new Map<string, DecisionRecord>();
  const pending = new Map<string, DecisionRecord>();

  // ---- 도구 결과의 개인정보·기밀 표식 검사 (정책: 경고). 값은 어디에도 남기지 않고 규칙 id와 도구 이름만 남긴다.
  // 비밀 값은 secret-guard가 가리므로 여기서는 보지 않는다. secret 규칙은 접속 문자열이 이메일로 오인되는 것을 막는 용도로만 넣는다.
  // internal_marker.data_terms(고객정보·PII 등)는 데이터가 있다는 표식이 아니라 말 자체라, 코드·문서에 흔하게 나오는
  // 도구의 결과에서는 제외한다 (tool_result_scan: false). 붙여 넣은 실제 값은 pii 규칙이 따로 잡는다.
  const toolRules = rules.filter((r) => (r.group === "secret" || r.group === "pii" || r.group === "internal_marker") && r.tool_result_scan !== false);
  const localRefs = new Set(cfg.local_models.map((m) => (typeof m === "string" ? m : m.ref)));
  const toolSeen = new Map<string, Map<string, { tool: string; rules: string[]; warned: boolean }>>();
  const toolWarnings = new Map<string, ToolResultWarning[]>();
  const TOOL_SCAN_MAX_CHARS = 300_000;

  /** 전송 전 확인. 거부하거나 확인할 화면이 없으면 요청을 끝낸다 (사용자가 confirm을 골랐으므로 조용히 보내지 않는다) */
  async function confirmSend(ctx: RouteCtx, title: string, message: string): Promise<void> {
    if (!ctx.hasUI || !ctx.ui?.confirm) throw new Error(`${title}: 확인할 화면이 없어 보내지 않습니다. 설정을 "warn"으로 바꾸거나 민감 정보를 뺀 뒤 다시 요청하세요`);
    if (!(await ctx.ui.confirm(title, message))) throw new Error(`${title}: 사용자가 전송을 거부했습니다`);
  }

  async function checkToolResults(req: RouteRequest<RouterState>, ctx: RouteCtx, model: PiModel): Promise<void> {
    if (cfg.tool_result_policy === "off") return;
    const sid = ctx.sessionManager?.getSessionId() ?? "default";
    let seen = toolSeen.get(sid);
    if (!seen) toolSeen.set(sid, (seen = new Map()));
    for (const m of req.messages as { role: string; content?: unknown; toolCallId?: string; toolName?: string }[]) {
      if (m.role !== "toolResult") continue;
      const text = (Array.isArray(m.content) ? m.content.filter((b: { type?: string }) => b?.type === "text").map((b: { text?: string }) => b.text ?? "").join("\n") : typeof m.content === "string" ? m.content : "").slice(0, TOOL_SCAN_MAX_CHARS);
      const id = m.toolCallId ?? log.hash(text);
      if (seen.has(id)) continue;
      const hits = text ? runStage1Safe(toolRules, { text, internalMarkers: cfg.internal_markers }).rule_hits.filter((r) => !r.startsWith("secret.")) : [];
      seen.set(id, { tool: m.toolName ?? "tool", rules: hits, warned: false });
    }
    // 로컬 모델로 가는 요청은 경고하지 않는다. 나중에 외부 모델로 바뀌면 그때 경고한다 (대화 기록이 함께 나가므로)
    if (localRefs.has(refOf(model))) return;
    const fresh = [...seen.values()].filter((e) => e.rules.length && !e.warned);
    if (!fresh.length) return;
    const items = fresh.map((e) => ({ tool: e.tool, rules: e.rules }));
    const tools = [...new Set(items.map((i) => i.tool))].join(", ");
    const ruleIds = [...new Set(items.flatMap((i) => i.rules))].join(", ");
    const confirm = cfg.tool_result_policy === "confirm";
    // 거부하면 던지므로 warned를 켜지 않는다. 다음 요청에서 같은 도구 결과가 다시 대화 기록에 실려 다시 묻는다.
    if (confirm) await confirmSend(ctx, "도구 결과의 민감 정보", `도구 결과 ${items.length}건(${tools})에 민감 정보 규칙이 걸렸습니다 (${ruleIds}).\n${refOf(model)}(외부 모델)로 보낼까요?`);
    for (const e of fresh) e.warned = true;
    toolWarnings.set(sid, [...(toolWarnings.get(sid) ?? []), ...items]);
    log.write({ v: 1, kind: "tool_result_warning", ts: new Date().toISOString(), session: log.hash(sid).slice(0, 12), model: refOf(model), items, ...(confirm ? { confirmed: true } : {}) });
    if (!confirm) ctx.ui?.notify(`⚠ 도구 결과 ${items.length}건(${tools})에 민감 정보 규칙이 걸렸습니다 (${ruleIds}). ${refOf(model)}(외부 모델)로 전송됩니다. 막으려면 지금 중단하세요.`, "warning");
  }

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
    // 비밀 값은 가리고, 개인정보·기밀 표식이 보이면 본문은 남기지 않는다. 파일은 소유자만 읽는다.
    if (process.env.LLM_ROUTER_DEBUG_STAGE2) {
      const sensitive = runStage1Safe(rules, { text: out, internalMarkers: cfg.internal_markers }).hard_constraints.data_sensitivity === "internal_only";
      const show = (t: string) => (sensitive ? "[본문 생략: 민감 정보 규칙 해당]" : maskSecrets(rules, t).text);
      appendFileSync(process.env.LLM_ROUTER_DEBUG_STAGE2, JSON.stringify({ ref, stop: res.stopReason, blocks: res.content.map((b) => b.type), len: out.length, head: show(out.slice(0, 300)), tail: show(out.slice(-200)) }) + "\n", { mode: 0o600 });
    }
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
    const follow = followUpContext(req.messages, cfg.analyzer.followup_max_chars);
    // 후속 요청이면 앞 대화도 민감도·부작용 규칙과 판단 모델 입력에 포함한다
    const analysisText = follow ? [...follow.users, follow.assistant, text].filter(Boolean).join("\n") : text;
    const ctxEst = estimateContext(req.messages as Msg[]);
    const est = ctxEst.tokens;
    const s1 = runStage1Safe(rules, { text: analysisText, attachments: hasImage(req.messages) ? ["image"] : [], estContextTokens: est, internalMarkers: cfg.internal_markers });
    const t1 = Date.now();
    const route = s1.hard_constraints.data_sensitivity === "internal_only" ? analyzers.internal_only : analyzers.external_ok;
    const request = follow
      ? `[이전 대화]\n${follow.users.map((u) => `사용자: ${u}`).join("\n")}${follow.assistant ? `\n어시스턴트: ${follow.assistant}` : ""}\n\n[이번 요청]\n${text}`
      : text;
    const input = cfg.analyzer.mask_secrets ? maskSecrets(rules, request).text : request;
    const s2: Stage2Result = route.length
      ? await runStage2(input, taxonomy, route.map((r) => ({ ref: r.ref, complete: completeVia(reg, r.ref, (r as { thinking?: Thinking }).thinking) })), cfg.analyzer.timeout_ms, { totalMs: cfg.decision_timeout_ms, signal: req.signal })
      : { status: "unavailable", output: null, latency_ms: 0, error: "판단 모델 없음" };
    // 로컬 전용 데이터를 받을 수 있는 티어(모두 internal 모델)가 있는지. decide의 민감 필터와 같은 기준
    const localAvailable = roster.tiers.some((t) => t.models.length > 0 && t.models.every((m) => m.data_policy === "internal"));
    const merged = mergeStages(s1, s2, { localAvailable, suspicionWithoutLocal: cfg.analyzer.suspicion_without_local, estContextTokens: est });
    if (req.signal?.aborted) throw new Error("요청이 중단되었습니다");
    const { analysis } = merged;
    const op = cfg.virtual_levels[req.thinkingLevel as "low" | "medium" | "high"] ?? "balanced";
    const isAvail = new Set(catalog.map(refOf));
    // 결정 실패(필수 제약을 만족하는 티어 없음)는 그대로 던져 요청을 막는다 (fail-closed).
    // 사용자가 표현을 고칠 수 있도록 걸린 규칙 이름(값 아님)을 덧붙인다.
    let decision: Decision;
    try {
      decision = decide(analysis, roster, table, cfg, op, (ref) => isAvail.has(ref));
    } catch (e) {
      const why = [...s1.rule_hits, ...(merged.sensitiveBy.includes("stage2") ? ["판단 모델의 민감 의심"] : [])];
      throw new Error(why.length ? `${(e as Error).message} (걸린 규칙: ${why.join(", ")})` : (e as Error).message);
    }
    // 판단 모델만 민감 정보를 의심하고 local이 없을 때: confirm이면 보내기 전에 묻는다
    if (merged.suspicionIgnored === "no_local" && cfg.analyzer.suspicion_without_local === "confirm") {
      await confirmSend(ctx, "판단 모델의 민감 정보 의심", `판단 모델이 이 요청에 민감 정보가 있다고 의심합니다 (규칙에는 걸리지 않음). local 모델이 없어 ${decision.model}(외부 모델)로 보낼까요?`);
    }
    const qid = log.hash(text);
    const state: RouterState = {
      v: 1, task_id: req.state?.task_id ?? `t_${qid.slice(0, 12)}`, query_id: `q_${qid.slice(0, 12)}`, scope: cfg.pin_scope,
      tier: decision.tier, model: decision.model, thinking: decision.thinking, operating_point: op,
      decided_at: new Date().toISOString(), decision_ref: `d_${Date.now().toString(36)}`, mode: cfg.mode, pinned_by: "router",
      sensitive: analysis.hard_constraints.data_sensitivity === "internal_only",
    };
    const rec: DecisionRecord = { state, decision, analyzer: s2.model ?? null, stage2: s2.status, latency_ms: { stage1: t1 - t0, stage2: route.length ? s2.latency_ms : null, total: Date.now() - t0 }, suspicion_ignored: merged.suspicionIgnored, est_context_tokens: est };
    const sid = ctx.sessionManager?.getSessionId() ?? "default";
    last.set(sid, rec);
    pending.set(sid, rec);
    opts.onDecision?.(rec);
    log.write({
      v: 1, kind: "decision", ts: state.decided_at, session: log.hash(sid).slice(0, 12), query: state.query_id, prompt_hash: qid,
      rule_hits: s1.rule_hits, task_type: analysis.task_type, dimensions: fullDimensions(analysis.dimensions), confidence: analysis.confidence,
      decision: { tier: decision.tier, model: decision.model, thinking: decision.thinking, cell: decision.table_cell, adjustments: decision.adjustments, thinking_adjustments: decision.thinking_adjustments, capped: decision.capped, ask_user: decision.ask_user, operating_point: op },
      analyzer: s2.model ?? null, stage2: s2.status, stage2_error: s2.error?.slice(0, 200) ?? null, latency_ms: rec.latency_ms,
      sensitive_by: merged.sensitiveBy, suspicion_ignored: merged.suspicionIgnored, est_context_tokens: est, est_basis: ctxEst.basis, ...(follow ? { followup_context: true } : {}),
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
      const result = await routeInner(req, ctx);
      if (req.reason !== "direct") await checkToolResults(req, ctx, result.model);
      return result;
    },
  });

  async function routeInner(req: RouteRequest<RouterState>, ctx: RouteCtx): Promise<RouteResult<RouterState>> {
    {
      const reg = ctx.modelRegistry;
      if (req.reason === "retry" && req.failed) {
        const keep = { model: req.failed.model, thinkingLevel: req.failed.thinkingLevel ?? req.state?.thinking ?? "off" };
        // 공급자 일시 장애면 같은 티어의 다른 모델로 넘긴다 (캐시는 포기). 같은 티어라 데이터 정책(로컬 전용 여부)은 그대로다.
        if (!isProviderFault(req.failed.message?.errorMessage)) return keep;
        const avail = new Set(reg.getAvailable().map(refOf));
        const roster = resolveRoster(loaded.roster, cfg.local_models, reg.getAvailable().map(toCatalog));
        const failedRef = refOf(req.failed.model);
        const tier = roster.tiers.find((t) => t.models.some((m) => m.ref === failedRef));
        const alt = tier?.models.find((m) => m.ref !== failedRef && avail.has(m.ref));
        if (!alt) return keep;
        const wanted = (req.failed.thinkingLevel ?? req.state?.thinking ?? alt.default_thinking) as Thinking;
        return { model: physical(reg, alt.ref), thinkingLevel: clampThinking(wanted, alt.thinking_levels) };
      }
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
      // 고정 중이라도 1단 규칙은 쿼리마다 본다. 로컬 전용 데이터인데 고정 모델이 외부 모델이면 다시 결정한다.
      // 이미지 첨부나 긴 대화처럼 고정 모델이 감당하지 못하는 요청도 다시 결정한다.
      if (req.state && (cfg.pin_scope === "session" || req.state.pinned_by !== "router")) {
        const est = estimateContext(req.messages as Msg[]).tokens;
        const s1 = runStage1Safe(rules, { text: lastUserText(req.messages), attachments: hasImage(req.messages) ? ["image"] : [], estContextTokens: est, internalMarkers: cfg.internal_markers });
        const pinnedInternal = localRefs.has(req.state.model);
        const sensitiveOk = s1.hard_constraints.data_sensitivity !== "internal_only" || pinnedInternal;
        const roster = resolveRoster(loaded.roster, cfg.local_models, reg.getAvailable().map(toCatalog));
        const pm = roster.tiers.flatMap((t) => t.models).find((m) => m.ref === req.state!.model);
        // 로스터에 없는 모델(사용자가 직접 고른 모델 등)은 능력을 알 수 없으므로 그대로 둔다
        const capable = !pm || (s1.hard_constraints.required_capabilities.every((c) => pm.capabilities.includes(c)) && est <= pm.context_window * 0.8);
        if (sensitiveOk && capable) return { model: physical(reg, req.state.model), thinkingLevel: req.state.thinking };
      }
      return decideForQuery(req, ctx);
    }
  }

  return {
    last,
    pinScope: cfg.pin_scope,
    /** 이번 쿼리에서 새로 내린 결정을 한 번만 꺼낸다 (쿼리 카드용) */
    takePending(sid: string) {
      const r = pending.get(sid);
      pending.delete(sid);
      return r;
    },
    /** 이번 쿼리에서 도구 결과 경고가 난 건을 한 번만 꺼낸다 (쿼리 카드용) */
    takeToolWarnings(sid: string): ToolResultWarning[] {
      const w = toolWarnings.get(sid) ?? [];
      toolWarnings.delete(sid);
      return w;
    },
  };
}
