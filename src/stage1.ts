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
  /** keywords: 영문·숫자로 시작·끝나는 키워드는 식별자 안에서 매치하지 않는다 (isConfidential, PII_FIELD 등) */
  word_boundary?: boolean;
  /** true면 매치된 값을 모델로 보내기 전 가린다. secret 그룹은 항상 가린다 (07-spec §6.5) */
  mask?: boolean;
  /** false면 도구 결과 민감 정보 검사에 적용하지 않는다 (07-spec §6.6). 기본 true. 주제어(고객정보·PII 등)는 코드·문서에 흔해 표식으로 쓰지 않는다 */
  tool_result_scan?: boolean;
  /** regex·keywords: 매치 바로 뒤가 이 패턴이면 그 매치는 무시한다 (부정 표현, 주제어 용법) */
  unless_followed_by?: string;
  /** regex·keywords: 매치 바로 앞이 이 패턴으로 끝나면 그 매치는 무시한다 */
  unless_preceded_by?: string;
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
  after?: RegExp;
  before?: RegExp;
}

export type CompiledRule = Compiled;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ASCII_WORD = /[A-Za-z0-9_]/;

/** 키워드 목록을 대소문자 무시 정규식 하나로. 매치 위치를 원문 기준으로 얻기 위해 소문자 변환 대신 i 플래그를 쓴다. */
function keywordsRe(words: string[], boundary: boolean): RegExp | undefined {
  const parts = words.filter((w) => w.length > 0).map((w) => {
    let p = escapeRe(w);
    if (boundary && ASCII_WORD.test(w[0])) p = `(?<![A-Za-z0-9_])${p}`;
    if (boundary && ASCII_WORD.test(w.at(-1)!)) p = `${p}(?![A-Za-z0-9_])`;
    return p;
  });
  return parts.length ? new RegExp(parts.join("|"), "giu") : undefined;
}

export function compileRules(file: RulesFile): Compiled[] {
  return file.rules.map((r) => {
    const out: Compiled = { ...r };
    if (r.unless_followed_by) out.after = new RegExp(r.unless_followed_by, "iuy");
    if (r.unless_preceded_by) out.before = new RegExp(`(?:${r.unless_preceded_by})$`, "iu");
    if (r.kind === "keywords") out.re = keywordsRe(r.keywords ?? [], r.word_boundary === true);
    if (r.kind !== "regex") return out;
    if (!r.pattern) throw new Error(`regex 규칙에 pattern 없음: ${r.id}`);
    const flags = new Set([...(r.flags ?? ""), "g", "u"]);
    out.re = new RegExp(r.pattern, [...flags].join(""));
    return out;
  });
}

/** 매치 앞뒤 문맥이 예외 패턴이면 그 매치는 무시한다. */
function exempt(rule: Compiled, text: string, start: number, end: number): boolean {
  if (rule.after) {
    rule.after.lastIndex = end;
    if (rule.after.test(text)) return true;
  }
  return !!rule.before && rule.before.test(text.slice(Math.max(0, start - 80), start));
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
  const re = rule.re;
  // 빈 키워드 목록만 정상. regex 규칙에 컴파일된 식이 없으면 예외로 failsafe(민감 간주)가 동작하게 한다
  if (!re) {
    if (rule.kind === "regex") throw new Error(`컴파일되지 않은 regex 규칙: ${rule.id}`);
    return false;
  }
  re.lastIndex = 0;
  for (const m of text.matchAll(re)) {
    if (m[0].length === 0) continue;
    if (exempt(rule, text, m.index!, m.index! + m[0].length)) continue;
    if (!rule.validator) return true;
    if (rule.validator === "luhn" && luhnOk(m[0])) return true;
    if (rule.validator === "kr_rrn_shape" && krRrnShapeOk(m[0])) return true;
  }
  return false;
}

/** 사용자 설정 목록 매칭. 영문·숫자로 시작·끝나는 항목은 식별자 안에서 매치하지 않는다 (예: "corp" ≠ "incorporated"). */
function includesAny(text: string, words: string[]): boolean {
  const re = keywordsRe(words, true);
  if (!re) return false;
  re.lastIndex = 0;
  return re.test(text);
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
      return regexHit(rule, input.text);
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

/** 가림 규칙: secret 그룹 + mask를 표시한 pii 규칙 (07-spec §6.5). */
export const isMaskableRule = (r: Compiled): boolean => r.group === "secret" || r.mask === true;

/** 1단 선(先)가림과 2단 입력·진단 로그용: secret 그룹만 가린다. */
export const isSecretRule = (r: Compiled): boolean => r.group === "secret";

/**
 * 가림 자리표시에 쓰는 짧은 이름. 그룹 접두를 뗀 규칙 이름 — 점이나 대입 기호가 없어 규칙에 다시 걸리지 않는다.
 */
export function maskLabel(ruleId: string): string {
  return ruleId.split(".").pop() ?? ruleId;
}

/**
 * 가림 규칙에 걸린 구간. 이름 있는 그룹 v 또는 w가 있으면 그 부분만, 없으면 매치 전체.
 * 겹치는 구간은 합친다 (앞선 규칙 이름 유지). 기본은 secret 그룹만; 복원 가능한 가림(SecretVault)은 isMaskableRule을 쓴다.
 */
export function secretSpans(rules: Compiled[], text: string, isMaskable: (r: Compiled) => boolean = isSecretRule): SecretSpan[] {
  const spans: SecretSpan[] = [];
  for (const rule of rules) {
    if (!isMaskable(rule) || !rule.re) continue;
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
    out += text.slice(pos, sp.start) + `[[MASKED ${maskLabel(sp.rule)}]]`;
    pos = sp.end;
  }
  return { text: out + text.slice(pos), masked: spans.length };
}
