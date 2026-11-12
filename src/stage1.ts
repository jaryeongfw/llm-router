/**
 * 1단 분석: 결정적 규칙. 외부 호출 없음.
 * 매치된 문자열은 반환하지 않는다. 규칙 id만 반환한다 (07-spec §5.2, §8).
 */

export type RuleGroup = "secret" | "pii" | "internal_marker" | "user_explicit" | "side_effect" | "capability";
export type Capability = "tool_use" | "image_input" | "long_context_200k" | "long_context_1m" | "structured_output" | "reasoning";

export interface RuleDef {
  id: string;
  group: RuleGroup;
  kind: "regex" | "keywords" | "config_list" | "attachment" | "context_estimate";
  pattern?: string;
  flags?: string;
  keywords?: string[];
  validator?: "luhn" | "kr_rrn_shape";
  config_key?: string;
  threshold_tokens?: number;
  effect: { data_sensitivity?: "external_ok" | "internal_only"; irreversible_side_effects?: boolean; add_capability?: Capability; secret_present?: boolean };
}

export interface RulesFile { version: number; rules: RuleDef[] }

export interface InternalMarkers { domains: string[]; path_prefixes: string[]; keywords: string[] }

export interface Stage1Input {
  text: string;
  attachments?: "image"[];
  estContextTokens?: number | null;
  internalMarkers?: InternalMarkers;
}

export interface HardConstraints {
  data_sensitivity: "external_ok" | "internal_only";
  irreversible_side_effects: boolean;
  required_capabilities: Capability[];
  latency: "interactive" | "background";
  budget_cap_usd: number | null;
  /** 비밀정보 형식 문자열 포함. 모델에는 가려서 보낸다 (secret_policy) (07-spec §6.5). */
  secret_present: boolean;
}

export interface Stage1Result {
  hard_constraints: HardConstraints;
  rule_hits: string[];
  groups: RuleGroup[];
  /** 규칙 평가 중 예외가 나서 보수적으로 민감 처리했는지 */
  failsafe: boolean;
}

interface Compiled extends RuleDef {
  re?: RegExp;
}

export type CompiledRule = Compiled;

export function compileRules(file: RulesFile): Compiled[] {
  return file.rules.map((r) => {
    if (r.kind !== "regex") return { ...r };
    if (!r.pattern) throw new Error(`regex 규칙에 pattern 없음: ${r.id}`);
    const flags = new Set([...(r.flags ?? ""), "g", "u"]);
    return { ...r, re: new RegExp(r.pattern, [...flags].join("")) };
  });
}

export function luhnOk(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** 형식만 본다(앞 6자리 + 성별 자리 1~8 + 6자리). 날짜 유효성은 보지 않는다: 재현율 우선. */
export function krRrnShapeOk(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, "");
  return digits.length === 13 && /[1-8]/.test(digits[6]);
}

function regexHit(rule: Compiled, text: string): boolean {
  const re = rule.re!;
  re.lastIndex = 0;
  for (const m of text.matchAll(re)) {
    if (!rule.validator) return true;
    if (rule.validator === "luhn" && luhnOk(m[0])) return true;
    if (rule.validator === "kr_rrn_shape" && krRrnShapeOk(m[0])) return true;
  }
  return false;
}

function includesAny(text: string, words: string[]): boolean {
  const lower = text.toLowerCase();
  return words.some((w) => w.length > 0 && lower.includes(w.toLowerCase()));
}

function configList(markers: InternalMarkers | undefined, key: string | undefined): string[] {
  if (!markers || !key) return [];
  const leaf = key.split(".").at(-1) as keyof InternalMarkers;
  return markers[leaf] ?? [];
}

function hit(rule: Compiled, input: Stage1Input): boolean {
  switch (rule.kind) {
    case "regex":
      return regexHit(rule, input.text);
    case "keywords":
      return includesAny(input.text, rule.keywords ?? []);
    case "config_list":
      return includesAny(input.text, configList(input.internalMarkers, rule.config_key));
    case "attachment":
      return (input.attachments ?? []).includes("image");
    case "context_estimate":
      return (input.estContextTokens ?? 0) > (rule.threshold_tokens ?? Number.POSITIVE_INFINITY);
  }
}

function defaults(): HardConstraints {
  return { data_sensitivity: "external_ok", irreversible_side_effects: false, required_capabilities: [], latency: "interactive", budget_cap_usd: null, secret_present: false };
}

export function runStage1(rules: Compiled[], input: Stage1Input): Stage1Result {
  const hc = defaults();
  const rule_hits: string[] = [];
  const groups = new Set<RuleGroup>();
  // secret 규칙을 먼저 원문에 적용하고, 나머지 규칙은 비밀 값을 가린 텍스트에 적용한다.
  // 예: 접속 문자열 user:pw@host가 이메일(pii)로 다시 잡혀 "비밀정보 + 로컬 전용"으로 잘못 차단되는 것을 막는다.
  const masked = { ...input, text: maskSecrets(rules, input.text).text };
  const ordered = [...rules.filter((r) => r.group === "secret"), ...rules.filter((r) => r.group !== "secret")];
  for (const rule of ordered) {
    if (!hit(rule, rule.group === "secret" ? input : masked)) continue;
    rule_hits.push(rule.id);
    groups.add(rule.group);
    if (rule.effect.data_sensitivity === "internal_only") hc.data_sensitivity = "internal_only";
    if (rule.effect.irreversible_side_effects) hc.irreversible_side_effects = true;
    if (rule.effect.secret_present) hc.secret_present = true;
    const cap = rule.effect.add_capability;
    if (cap && !hc.required_capabilities.includes(cap)) hc.required_capabilities.push(cap);
  }
  return { hard_constraints: hc, rule_hits, groups: [...groups], failsafe: false };
}

/** 규칙 평가가 예외로 실패하면 민감으로 간주한다 (07-spec §5.1). */
export function runStage1Safe(rules: Compiled[], input: Stage1Input): Stage1Result {
  try {
    return runStage1(rules, input);
  } catch {
    return { hard_constraints: { ...defaults(), data_sensitivity: "internal_only" }, rule_hits: [], groups: [], failsafe: true };
  }
}

export interface SecretSpan { start: number; end: number; rule: string }

/** 가림 자리표시에 쓰는 짧은 이름. 점이나 대입 기호가 없어 규칙에 다시 걸리지 않는다. */
export function secretLabel(ruleId: string): string {
  return ruleId.replace(/^secret\./, "");
}

/**
 * secret 규칙에 걸린 구간. 이름 있는 그룹 v 또는 w가 있으면 그 부분만, 없으면 매치 전체.
 * 겹치는 구간은 합친다 (앞선 규칙 이름 유지).
 */
export function secretSpans(rules: Compiled[], text: string): SecretSpan[] {
  const spans: SecretSpan[] = [];
  for (const rule of rules) {
    if (rule.group !== "secret" || !rule.re) continue;
    const flags = new Set([...rule.re.flags, "d", "g"]);
    const re = new RegExp(rule.re.source, [...flags].join(""));
    for (const m of text.matchAll(re)) {
      const idx = (m as RegExpMatchArray & { indices?: { groups?: Record<string, [number, number] | undefined> } }).indices;
      const g = idx?.groups?.v ?? idx?.groups?.w;
      const [start, end] = g ?? [m.index!, m.index! + m[0].length];
      if (end > start) spans.push({ start, end, rule: rule.id });
    }
  }
  spans.sort((x, y) => x.start - y.start || y.end - x.end);
  const merged: SecretSpan[] = [];
  for (const sp of spans) {
    const last = merged.at(-1);
    if (last && sp.start < last.end) last.end = Math.max(last.end, sp.end);
    else merged.push({ ...sp });
  }
  return merged;
}

/**
 * 비밀 값을 `[[MASKED 규칙이름]]`으로 바꾼다 (번호 없음, 복원 불가). 2단 분석기 입력용.
 * 런타임의 복원 가능한 가림은 src/secrets.ts의 SecretVault를 쓴다.
 */
export function maskSecrets(rules: Compiled[], text: string): { text: string; masked: number } {
  const spans = secretSpans(rules, text);
  let out = "";
  let pos = 0;
  for (const sp of spans) {
    out += text.slice(pos, sp.start) + `[[MASKED ${secretLabel(sp.rule)}]]`;
    pos = sp.end;
  }
  return { text: out + text.slice(pos), masked: spans.length };
}
