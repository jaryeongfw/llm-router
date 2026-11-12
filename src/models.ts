/**
 * 실행 환경의 모델 목록으로 티어와 판단 모델(2단 분석기)을 정한다.
 * - local 티어: 저장소 기본 설정에는 자리표시(placeholder)만 있고, 사용자 설정의 local_models로 채운다.
 * - 판단 모델: 명시 지정 → local 모델 → Claude 자동 선택 순 (analyzer.prefer로 순서 변경 가능).
 *   internal_only 요청은 local 모델로만 분석한다. local이 없으면 2단을 건너뛴다.
 */
import type { Roster, RosterModel, Thinking, Tier } from "./decide.ts";

/** 사용 가능한(자격 증명이 있는) 모델 하나. pi Model에서 필요한 부분만. */
export interface CatalogModel {
  provider: string;
  id: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
  reasoning?: boolean;
  cost?: { input: number; output: number };
}

export const refOf = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;

/** "provider/id"를 나눈다. id에는 '/'가 들어갈 수 있다. */
export function splitRef(ref: string): { provider: string; id: string } {
  const i = ref.indexOf("/");
  return { provider: ref.slice(0, i), id: ref.slice(i + 1) };
}

export interface LocalModelSpec { ref: string; context_window?: number; max_output?: number; capabilities?: string[]; thinking_levels?: Thinking[] }
export type LocalModelInput = string | LocalModelSpec;

export interface AnalyzerConfig {
  prefer: "local" | "claude";
  model: string | null;
  claude_auto: boolean;
}

export interface ResolvedAnalyzers {
  /** 외부 전송 가능한 요청의 분석기 후보 (순서대로 시도) */
  external_ok: { ref: string; thinking?: Thinking }[];
  /** 로컬 전용 요청의 분석기 후보. local 모델만 */
  internal_only: { ref: string }[];
  /** 자동 선택된 Claude 모델 (없으면 null) */
  claude: string | null;
}

const asSpec = (m: LocalModelInput): LocalModelSpec => (typeof m === "string" ? { ref: m } : m);

/** 자리표시를 사용자 local 모델로 바꾸고, 쓸 수 없는 모델은 뺀다. */
export function resolveRoster(roster: Roster, localModels: LocalModelInput[], catalog: CatalogModel[]): Roster {
  const byRef = new Map(catalog.map((m) => [refOf(m), m]));
  const tiers: Tier[] = roster.tiers.map((t) => {
    const models: RosterModel[] = [];
    for (const m of t.models as (RosterModel & { placeholder?: boolean })[]) {
      if (m.placeholder) {
        localModels.map(asSpec).forEach((spec, i) => {
          const c = byRef.get(spec.ref);
          if (!c) return;
          models.push({
            ...m,
            placeholder: undefined,
            ref: spec.ref,
            role: i === 0 ? "primary" : "fallback",
            context_window: spec.context_window ?? c.contextWindow ?? m.context_window,
            capabilities: spec.capabilities ?? m.capabilities,
            thinking_levels: spec.thinking_levels ?? m.thinking_levels,
            default_thinking: (spec.thinking_levels ?? m.thinking_levels)[0],
          } as RosterModel);
        });
      } else if (byRef.has(m.ref)) {
        models.push(m);
      }
    }
    // primary가 빠졌으면 남은 첫 모델을 primary로
    if (models.length && !models.some((m) => m.role !== "fallback")) models[0] = { ...models[0], role: "primary" };
    return { ...t, models };
  });
  return { ...roster, tiers };
}

/** "claude-haiku-5-5" → [5, 5]. 날짜 접미사(8자리)는 버전에서 뺀다. */
export function claudeVersion(id: string): number[] {
  return id.split(/[-.]/).filter((p) => /^\d{1,2}$/.test(p)).map(Number);
}

function cmpVersion(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Claude 판단 모델 자동 선택.
 * 1) haiku 계열 중 최신 버전 (같으면 날짜 없는 별칭, anthropic 공급자 우선)
 * 2) haiku가 없으면 입력 단가가 가장 싼 Claude 모델
 */
export function pickClaudeAnalyzer(catalog: CatalogModel[]): string | null {
  const claude = catalog.filter((m) => /claude/i.test(m.id) && !(m.input && !m.input.includes("text")));
  if (!claude.length) return null;
  const rank = (m: CatalogModel) => (m.provider === "anthropic" ? 0 : 1);
  const haiku = claude.filter((m) => /haiku/i.test(m.id));
  if (haiku.length) {
    haiku.sort((a, b) => cmpVersion(claudeVersion(b.id), claudeVersion(a.id)) || rank(a) - rank(b) || a.id.length - b.id.length);
    return refOf(haiku[0]);
  }
  const priced = claude.filter((m) => m.cost && Number.isFinite(m.cost.input));
  const pool = priced.length ? priced : claude;
  pool.sort((a, b) => (a.cost?.input ?? Infinity) - (b.cost?.input ?? Infinity) || rank(a) - rank(b));
  return refOf(pool[0]);
}

export function resolveAnalyzers(cfg: AnalyzerConfig, resolved: Roster, catalog: CatalogModel[], localTierId = "local"): ResolvedAnalyzers {
  const available = new Set(catalog.map(refOf));
  const local = (resolved.tiers.find((t) => t.id === localTierId)?.models ?? []).map((m) => m.ref).filter((r) => available.has(r));
  const claude = cfg.claude_auto ? pickClaudeAnalyzer(catalog) : null;
  const explicit = cfg.model && available.has(cfg.model) ? cfg.model : null;
  const ordered = cfg.prefer === "claude" ? [claude, ...local] : [...local, claude];
  const ext = [explicit, ...ordered].filter((r): r is string => !!r);
  const uniq = [...new Set(ext)];
  return {
    external_ok: uniq.map((ref) => (ref === claude || (ref.startsWith("anthropic/") && !local.includes(ref)) ? { ref, thinking: "off" as Thinking } : { ref })),
    internal_only: [...new Set([explicit && local.includes(explicit) ? explicit : null, ...local].filter((r): r is string => !!r))].map((ref) => ({ ref })),
    claude,
  };
}
