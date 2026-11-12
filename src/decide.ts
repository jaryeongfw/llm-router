/**
 * 결정 규칙 v0 (07-spec §6). 순수 함수: 입출력 외 부작용 없음.
 * 결과는 (티어, 물리 모델, 추론 강도) 이며 태스크 시작 시 한 번 정하고 고정한다.
 */

export const THINKING_LADDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Thinking = (typeof THINKING_LADDER)[number];
export type OperatingPoint = "economy" | "balanced" | "quality";
export type Level = number | null;

export interface RosterModel {
  ref: string;
  role?: "primary" | "fallback";
  data_policy: "internal" | "external_vendor";
  context_window: number;
  capabilities: string[];
  thinking_levels: Thinking[];
  default_thinking: Thinking;
}
export interface Tier { id: string; rank: number; models: RosterModel[] }
export interface Roster { tiers: Tier[] }

export type Band = "easy" | "hard";
export interface Cell { action: string; band: Band; tier: string; thinking: Thinking }

/** 조회표는 거친 구간을 키로 쓴다 (08-routing-eval §4 A1). 분석기 난이도 오차는 거의 항상 ±1 이내다. */
export function bandOf(difficulty: number): Band {
  return difficulty <= 1 ? "easy" : "hard";
}
const BAND_TOP: Record<Band, number> = { easy: 1, hard: 3 };
export interface RoutingTable { tiers_order: string[]; default_tier: string; cells: Cell[] }

export interface DecideConfig {
  default_tier: string;
  side_effect_floor: string;
  low_confidence: number;
  operating_points: Record<OperatingPoint, { thinking_shift: number; allow_verifiable_down: boolean; tier_shift?: number }>;
  thinking_rules: { reasoning_up_at: number; max_thinking: Thinking };
  secret_policy: { mode: "mask" | "heavy" | "block"; tier?: string };
  verifiable_down: { max_difficulty: number; confident_max_difficulty: number; min_confidence: number };
}

export interface AnalysisInput {
  task_type: { domain: string; action: string | null };
  hard_constraints: {
    data_sensitivity: "external_ok" | "internal_only";
    irreversible_side_effects: boolean;
    required_capabilities: string[];
    secret_present?: boolean;
  };
  dimensions: {
    difficulty: Level; ambiguity: Level; scope: Level; verifiability: Level;
    capabilities: { reasoning: Level; [k: string]: Level };
  };
  context_signals?: { matched_files?: number | null; est_context_tokens?: number | null };
  confidence: number;
}

export type TierAdjustment = "secret_policy" | "side_effect_floor" | "scope_up" | "low_confidence_up" | "verifiable_down" | "capability_filter" | "context_filter" | "sensitivity_filter";
export type ThinkingAdjustment = "difficulty_up" | "reasoning_up" | "operating_point_shift" | "clamped_to_model" | "local_off";

export interface Decision {
  tier: string;
  model: string;
  thinking: Thinking;
  base_tier: string;
  base_thinking: Thinking;
  table_cell: string | null;
  operating_point: OperatingPoint;
  adjustments: TierAdjustment[];
  thinking_adjustments: ThinkingAdjustment[];
  capped: boolean;
  ask_user: boolean;
  reason: string;
  fallback_reason: string | null;
}

const idx = (t: Thinking) => THINKING_LADDER.indexOf(t);

export function shiftThinking(t: Thinking, by: number): Thinking {
  return THINKING_LADDER[Math.max(0, Math.min(THINKING_LADDER.length - 1, idx(t) + by))];
}

/** 모델이 지원하지 않는 값이면 가장 가까운 지원 값으로 (거리가 같으면 높은 쪽). */
export function clampThinking(t: Thinking, supported: Thinking[]): Thinking {
  if (supported.includes(t)) return t;
  let best = supported[0];
  for (const s of supported) {
    const d = Math.abs(idx(s) - idx(t));
    const bd = Math.abs(idx(best) - idx(t));
    if (d < bd || (d === bd && idx(s) > idx(best))) best = s;
  }
  return best;
}

function primary(tier: Tier, available?: (ref: string) => boolean): { model: RosterModel; fallback: boolean } | null {
  const ordered = [...tier.models].sort((a, b) => (a.role === "fallback" ? 1 : 0) - (b.role === "fallback" ? 1 : 0));
  for (const [i, m] of ordered.entries()) if (!available || available(m.ref)) return { model: m, fallback: i > 0 };
  return null;
}

export function lookupCell(table: RoutingTable, action: string | null, difficulty: Level): Cell | null {
  if (difficulty === null) return null;
  const band = bandOf(difficulty);
  return table.cells.find((c) => c.action === action && c.band === band)
    ?? table.cells.find((c) => c.action === "*" && c.band === band)
    ?? null;
}

export function decide(
  a: AnalysisInput,
  roster: Roster,
  table: RoutingTable,
  cfg: DecideConfig,
  op: OperatingPoint = "balanced",
  available?: (ref: string) => boolean,
): Decision {
  const tiers = [...roster.tiers].sort((x, y) => x.rank - y.rank);
  const rankOf = (id: string) => tiers.find((t) => t.id === id)?.rank ?? tiers.at(-1)!.rank;
  const maxRank = tiers.at(-1)!.rank;
  const adjustments: TierAdjustment[] = [];
  const reasons: string[] = [];

  // 1. 필수 제약 필터
  let candidates = tiers.filter((t) => primary(t, available) !== null);
  const before = candidates.length;
  if (a.hard_constraints.data_sensitivity === "internal_only") {
    candidates = candidates.filter((t) => t.models.every((m) => m.data_policy === "internal"));
    adjustments.push("sensitivity_filter");
    reasons.push("민감 데이터 → 사내 티어만");
  }
  // 비밀정보 (07-spec §6.5)
  //   mask : 런타임이 모든 모델 호출에서 가리므로(src/secret-guard.ts) 티어에 영향 없음
  //   heavy: secret_policy.tier만 후보 / block: 결정하지 않음
  const secret = a.hard_constraints.secret_present === true;
  if (secret && cfg.secret_policy.mode === "block") throw new Error("비밀정보가 포함되어 작업을 시작하지 않습니다 (secret_policy: block). 비밀정보를 지우고 다시 요청하세요");
  if (secret && cfg.secret_policy.mode === "heavy") {
    const tier = cfg.secret_policy.tier ?? tiers.at(-1)!.id;
    candidates = candidates.filter((t) => t.id === tier);
    adjustments.push("secret_policy");
    reasons.push(`비밀정보 포함 → ${tier}만 시도`);
  }
  const caps = a.hard_constraints.required_capabilities;
  if (caps.length) {
    const n = candidates.length;
    candidates = candidates.filter((t) => caps.every((c) => primary(t, available)!.model.capabilities.includes(c)));
    if (candidates.length < n) adjustments.push("capability_filter");
  }
  const est = a.context_signals?.est_context_tokens ?? null;
  if (est !== null) {
    const n = candidates.length;
    candidates = candidates.filter((t) => est <= primary(t, available)!.model.context_window * 0.8);
    if (candidates.length < n) adjustments.push("context_filter");
  }

  // 2. 조회표
  const d = a.dimensions;
  const cell = lookupCell(table, a.task_type.action, d.difficulty);
  const baseTier = cell?.tier ?? cfg.default_tier;
  const baseTierObj = tiers.find((t) => t.id === baseTier)!;
  const baseThinking: Thinking = cell?.thinking ?? primary(baseTierObj)!.model.default_thinking;
  if (!cell) reasons.push("난이도 미상 → 기본 티어");

  // 3. 티어 보정 (각 최대 한 단계)
  const opCfg = cfg.operating_points[op];
  let target = rankOf(baseTier);
  if (a.hard_constraints.irreversible_side_effects && target < rankOf(cfg.side_effect_floor)) {
    target = rankOf(cfg.side_effect_floor);
    adjustments.push("side_effect_floor");
    reasons.push("비가역 부작용 → 하한 티어");
  }
  if ((d.scope ?? 0) >= 3 || (a.context_signals?.matched_files ?? 0) > 20) {
    target += 1;
    adjustments.push("scope_up");
  }
  if (a.confidence < cfg.low_confidence) {
    target += 1;
    adjustments.push("low_confidence_up");
  }
  const vd = cfg.verifiable_down;
  const easyEnough = d.difficulty !== null
    && (d.difficulty <= vd.max_difficulty || (a.confidence >= vd.min_confidence && d.difficulty <= vd.confident_max_difficulty));
  if (opCfg.allow_verifiable_down && d.verifiability === 0 && easyEnough
      && !adjustments.includes("side_effect_floor") && target > 0) {
    target -= 1;
    adjustments.push("verifiable_down");
  }
  target = Math.max(0, Math.min(maxRank, target + (opCfg.tier_shift ?? 0)));

  // 4. 후보 중 target 이상인 가장 싼 티어, 없으면 가장 높은 후보 (fail-closed)
  let chosen = candidates.find((t) => t.rank >= target) ?? null;
  let capped = false;
  if (!chosen) {
    chosen = candidates.at(-1) ?? null;
    capped = true;
    if (chosen) reasons.push(`필요 티어 미충족 → ${chosen.id}로 제한`);
  }
  if (!chosen) {
    // 후보가 하나도 없음: 제약 위반으로 대체하지 않는다. 사내 티어가 없으면 호출자가 사용자에게 알린다.
    if (before === 0) throw new Error("사용 가능한 티어가 없습니다");
    if (secret && cfg.secret_policy.mode === "heavy" && a.hard_constraints.data_sensitivity === "internal_only") {
      throw new Error("비밀정보와 사내 전용 데이터가 함께 있어 배정할 티어가 없습니다. 비밀정보를 지우고 다시 요청하세요");
    }
    if (a.hard_constraints.data_sensitivity === "internal_only") {
      throw new Error("필수 제약을 만족하는 티어가 없습니다: 사내 전용 데이터(개인정보·사내 표식)가 있는데 쓸 수 있는 local 모델이 없습니다. 사용자 설정 local_models에 사내·자체 호스팅 모델을 지정하세요");
    }
    throw new Error("필수 제약을 만족하는 티어가 없습니다 (필요 능력 또는 컨텍스트 크기를 만족하는 모델 없음)");
  }
  const pick = primary(chosen, available)!;

  // 5. 추론 강도
  const thinkingAdj: ThinkingAdjustment[] = [];
  let thinking = baseThinking;
  if (cell && d.difficulty === BAND_TOP[cell.band]) {
    thinking = shiftThinking(thinking, 1);
    thinkingAdj.push("difficulty_up");
  }
  if ((d.capabilities.reasoning ?? 0) >= cfg.thinking_rules.reasoning_up_at) {
    thinking = shiftThinking(thinking, 1);
    thinkingAdj.push("reasoning_up");
  }
  if (opCfg.thinking_shift !== 0) {
    thinking = shiftThinking(thinking, opCfg.thinking_shift);
    thinkingAdj.push("operating_point_shift");
  }
  if (idx(thinking) > idx(cfg.thinking_rules.max_thinking)) thinking = cfg.thinking_rules.max_thinking;
  const supported = pick.model.thinking_levels;
  if (supported.length === 1 && supported[0] === "off") {
    if (thinking !== "off") thinkingAdj.push("local_off");
    thinking = "off";
  } else {
    const c = clampThinking(thinking, supported);
    if (c !== thinking) thinkingAdj.push("clamped_to_model");
    thinking = c;
  }

  return {
    tier: chosen.id,
    model: pick.model.ref,
    thinking,
    base_tier: baseTier,
    base_thinking: baseThinking,
    table_cell: cell ? `${cell.action}/${cell.band}` : null,
    operating_point: op,
    adjustments,
    thinking_adjustments: thinkingAdj,
    capped,
    ask_user: d.ambiguity === 3,
    reason: reasons.join("; ") || "조회표",
    fallback_reason: pick.fallback ? "기본 모델 사용 불가 → 티어 내 대체 모델" : null,
  };
}
