/**
 * 라우팅 결과 집계와 표시 (순수 함수). src/ui.ts가 pi 화면에 붙인다.
 *   - 쿼리 카드: 결정(티어·모델·추론 강도)과 그 쿼리의 실제 사용량
 *   - 상태줄: 세션 누적 티어별 쿼리 수와 비용
 *   - /router stats: 티어별·모델별 막대
 * 쿼리 원문은 다루지 않는다.
 */

export interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export const plainTheme: ThemeLike = { fg: (_c, t) => t, bold: (t) => t };

export interface UsageLike { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } }
export interface AssistantLike { role: string; provider?: string; model?: string; thinkingLevel?: string; usage?: UsageLike; stopReason?: string }

/** input은 전체 입력 토큰(비캐시 + 캐시 읽기 + 캐시 쓰기), cacheRead는 그중 캐시 읽기 */
export interface ModelUse { ref: string; calls: number; input: number; output: number; cacheRead: number; cost: number; thinking: string[]; errors: number }
export interface UsageSummary { calls: number; input: number; output: number; cacheRead: number; cost: number; byModel: ModelUse[] }

export interface QueryCard {
  v: 1;
  /** 카드 고유 id (결정 id, 고정 유지 카드는 시각 접미사) */
  card_id: string;
  query_id: string;
  tier: string;
  model: string;
  thinking: string;
  operating_point: string;
  cell: string | null;
  adjustments: string[];
  thinking_adjustments: string[];
  analyzer: string | null;
  analyzer_ms: number | null;
  stage2: string;
  capped: boolean;
  ask_user: boolean;
  /** 판단 모델이 민감 정보를 의심했지만 local 모델이 없어 외부 모델로 진행함 (이전 카드에는 없음) */
  sensitivity_warning?: boolean;
  /** 도구 결과에서 민감 정보 규칙이 걸려 외부 모델로 보낸 건수와 규칙 id (값은 없음) */
  tool_result_warnings?: { count: number; rules: string[] };
  /** 이 쿼리에서 새로 결정하지 않고 이전 결정을 유지했는지 (pin_scope: session 등) */
  pinned: boolean;
  aborted: boolean;
  usage: UsageSummary;
}

export function summarize(messages: readonly AssistantLike[]): UsageSummary {
  const by = new Map<string, ModelUse>();
  for (const m of messages) {
    if (m.role !== "assistant" || !m.provider || !m.model) continue;
    const ref = `${m.provider}/${m.model}`;
    const u = by.get(ref) ?? { ref, calls: 0, input: 0, output: 0, cacheRead: 0, cost: 0, thinking: [], errors: 0 };
    u.calls++;
    u.input += (m.usage?.input ?? 0) + (m.usage?.cacheRead ?? 0) + (m.usage?.cacheWrite ?? 0);
    u.output += m.usage?.output ?? 0;
    u.cacheRead += m.usage?.cacheRead ?? 0;
    u.cost += m.usage?.cost?.total ?? 0;
    if (m.thinkingLevel && !u.thinking.includes(m.thinkingLevel)) u.thinking.push(m.thinkingLevel);
    if (m.stopReason === "error") u.errors++;
    by.set(ref, u);
  }
  const byModel = [...by.values()].sort((a, b) => b.calls - a.calls || b.cost - a.cost);
  const sum = (k: "calls" | "input" | "output" | "cacheRead" | "cost") => byModel.reduce((s, u) => s + u[k], 0);
  return { calls: sum("calls"), input: sum("input"), output: sum("output"), cacheRead: sum("cacheRead"), cost: sum("cost"), byModel };
}

// ---- 표시 도우미 (터미널 칸 너비: 한글·CJK·전각은 2칸)

const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g;
const WIDE = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/;

export function visibleWidth(s: string): number {
  let w = 0;
  for (const ch of s.replace(ANSI, "")) w += WIDE.test(ch) ? 2 : 1;
  return w;
}

/** 칸 너비 기준으로 자른다. ANSI 이스케이프는 유지한다. */
export function truncate(s: string, width: number): string {
  if (visibleWidth(s) <= width) return s;
  let out = "";
  let w = 0;
  const parts = s.split(/(\x1b\[[0-9;]*m)/);
  for (const p of parts) {
    if (p.startsWith("\x1b[")) {
      out += p;
      continue;
    }
    for (const ch of p) {
      const cw = WIDE.test(ch) ? 2 : 1;
      if (w + cw > width - 1) return out + "…\x1b[0m";
      out += ch;
      w += cw;
    }
  }
  return out;
}

const pad = (s: string, width: number) => s + " ".repeat(Math.max(0, width - visibleWidth(s)));

export function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

export function fmtCost(n: number): string {
  if (n === 0) return "$0";
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(3)}`;
}

export const shortModel = (ref: string) => ref.slice(ref.lastIndexOf("/") + 1);

const TIER_COLOR: Record<string, string> = { local: "success", light: "accent", standard: "warning", heavy: "error" };
const THINKING_COLOR: Record<string, string> = { off: "thinkingOff", minimal: "thinkingMinimal", low: "thinkingLow", medium: "thinkingMedium", high: "thinkingHigh", xhigh: "thinkingXhigh", max: "thinkingMax" };
const tierText = (t: ThemeLike, tier: string) => t.fg(TIER_COLOR[tier] ?? "text", tier);
const thinkText = (t: ThemeLike, level: string) => t.fg(THINKING_COLOR[level] ?? "muted", level);

function bar(value: number, max: number, width: number): string {
  const n = max > 0 ? Math.round((value / max) * width) : 0;
  return "█".repeat(n) + "░".repeat(width - n);
}

// ---- 쿼리 카드

export function cardLines(card: QueryCard, width: number, t: ThemeLike, expanded = false): string[] {
  const u = card.usage;
  const head = [
    t.fg("customMessageLabel", "◆ router"),
    `${tierText(t, card.tier)} · ${t.bold(shortModel(card.model))} · ${thinkText(t, card.thinking)}`,
    t.fg("dim", card.cell ?? "기본 티어"),
  ].join("  ");
  const lines = [head];
  const cache = u.cacheRead ? ` (캐시 ${fmtTokens(u.cacheRead)})` : "";
  lines.push(t.fg("muted", `  호출 ${u.calls}회 · 입력 ${fmtTokens(u.input)}${cache} · 출력 ${fmtTokens(u.output)} · ${fmtCost(u.cost)}`));
  const notes: string[] = [];
  const STAGE2: Record<string, string> = { parse_error: "형식 오류", timeout: "시간 초과", unavailable: "호출 실패" };
  if (card.pinned) notes.push("이전 결정 유지");
  else if (card.stage2 !== "ok") notes.push(t.fg("warning", `판단 실패(${STAGE2[card.stage2] ?? card.stage2}${card.analyzer ? `, ${shortModel(card.analyzer)}` : ""}) → 기본 티어`));
  else if (card.analyzer) notes.push(`판단 ${shortModel(card.analyzer)} ${card.analyzer_ms !== null ? `${(card.analyzer_ms / 1000).toFixed(1)}s` : ""}`.trim());
  else notes.push(`판단 모델 없음 (${card.stage2})`);
  if (card.adjustments.length) notes.push(`보정 ${card.adjustments.join(", ")}`);
  if (card.capped) notes.push(t.fg("warning", "필요 티어보다 낮게 제한됨"));
  if (card.tool_result_warnings?.count) notes.push(t.fg("warning", `도구 결과 ${card.tool_result_warnings.count}건에 민감 정보 규칙(${card.tool_result_warnings.rules.join(", ")}) → 외부 모델로 전송`));
  if (card.ask_user) notes.push(t.fg("warning", "요청이 모호함"));
  if (card.sensitivity_warning) notes.push(t.fg("warning", "판단 모델이 민감 정보 의심 (local 모델 없음 → 외부 모델로 진행)"));
  if (card.aborted) notes.push(t.fg("warning", "중단됨"));
  lines.push(t.fg("dim", `  ${notes.join(" · ")}`));
  // 결정과 다른 모델이 응답했으면 (재시도 중 전환 등) 항상 보여 준다
  const others = u.byModel.filter((m) => m.ref !== card.model);
  if (expanded || others.length) {
    for (const m of u.byModel) {
      const mark = m.ref === card.model ? " " : t.fg("warning", "!");
      lines.push(t.fg("dim", `  ${mark} ${pad(shortModel(m.ref), 26)} ${m.calls}회 · ${m.thinking.join("/") || "-"} · 입력 ${fmtTokens(m.input)} · 출력 ${fmtTokens(m.output)} · ${fmtCost(m.cost)}${m.errors ? ` · 오류 ${m.errors}` : ""}`));
    }
  }
  if (expanded) {
    lines.push(t.fg("dim", `  운영점 ${card.operating_point}${card.thinking_adjustments.length ? ` · 추론 보정 ${card.thinking_adjustments.join(", ")}` : ""} · ${card.query_id}`));
  }
  return lines.map((l) => truncate(l, Math.max(10, width)));
}

// ---- 상태줄

export const TIER_ORDER = ["local", "light", "standard", "heavy"];

export function statusText(cards: readonly QueryCard[], t: ThemeLike): string | undefined {
  if (!cards.length) return undefined;
  const counts = new Map<string, number>();
  for (const c of cards) counts.set(c.tier, (counts.get(c.tier) ?? 0) + 1);
  const tiers = [...TIER_ORDER.filter((x) => counts.has(x)), ...[...counts.keys()].filter((x) => !TIER_ORDER.includes(x))];
  const cost = cards.reduce((s, c) => s + c.usage.cost, 0);
  return `${t.fg("dim", "router ▸")} ${tiers.map((x) => `${tierText(t, x)} ${counts.get(x)}`).join(t.fg("dim", " · "))}  ${t.fg("muted", fmtCost(cost))}`;
}

// ---- /router stats

export function statsLines(cards: readonly QueryCard[], all: UsageSummary, t: ThemeLike, width = 80): string[] {
  const lines: string[] = [];
  const cost = cards.reduce((s, c) => s + c.usage.cost, 0);
  lines.push(t.bold(`llm-router · 이 세션 라우팅 쿼리 ${cards.length}건 · ${fmtCost(cost)}`));
  if (cards.length) {
    lines.push("");
    lines.push(t.fg("muted", "티어별 (router/auto로 처리한 쿼리)"));
    const byTier = new Map<string, { n: number; calls: number; cost: number }>();
    for (const c of cards) {
      const e = byTier.get(c.tier) ?? { n: 0, calls: 0, cost: 0 };
      e.n++;
      e.calls += c.usage.calls;
      e.cost += c.usage.cost;
      byTier.set(c.tier, e);
    }
    const max = Math.max(...[...byTier.values()].map((e) => e.n));
    for (const tier of [...TIER_ORDER, ...[...byTier.keys()].filter((x) => !TIER_ORDER.includes(x))]) {
      const e = byTier.get(tier);
      if (!e) continue;
      lines.push(`  ${pad(tierText(t, tier), 9)} ${t.fg(TIER_COLOR[tier] ?? "text", bar(e.n, max, 16))}  ${pad(`${e.n}건`, 5)} ${pad(`${e.calls}회`, 6)} ${fmtCost(e.cost)}`);
    }
    const thinking = new Map<string, number>();
    for (const c of cards) thinking.set(c.thinking, (thinking.get(c.thinking) ?? 0) + 1);
    lines.push(t.fg("dim", `  추론 강도: ${[...thinking].map(([k, v]) => `${thinkText(t, k)} ${v}`).join(" · ")}`));
  }
  if (all.byModel.length) {
    lines.push("");
    lines.push(t.fg("muted", "모델별 (이 세션의 모든 응답)"));
    const max = Math.max(...all.byModel.map((m) => m.calls));
    for (const m of all.byModel) {
      lines.push(`  ${pad(shortModel(m.ref), 26)} ${t.fg("accent", bar(m.calls, max, 12))}  ${pad(`${m.calls}회`, 6)} 입력 ${pad(fmtTokens(m.input), 7)} 출력 ${pad(fmtTokens(m.output), 7)} ${fmtCost(m.cost)}`);
    }
    lines.push(t.fg("dim", `  합계 ${all.calls}회 · 입력 ${fmtTokens(all.input)} (캐시 ${fmtTokens(all.cacheRead)}) · 출력 ${fmtTokens(all.output)} · ${fmtCost(all.cost)}`));
  } else {
    lines.push(t.fg("dim", "아직 응답이 없습니다."));
  }
  return lines.map((l) => truncate(l, width));
}
