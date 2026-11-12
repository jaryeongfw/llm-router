/**
 * 설정 불러오기: 저장소 기본값(config/) 위에 사용자 설정을 덮어쓴다.
 * 사용자 설정 위치: 환경 변수 LLM_ROUTER_CONFIG, 없으면 ~/.pi/agent/llm-router.json (없어도 됨)
 * 사용자 설정에서 주로 바꾸는 것: local_models(로컬 모델), analyzer, internal_markers, pin_scope
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DecideConfig, Roster, RoutingTable } from "./decide.ts";
import type { AnalyzerConfig, LocalModelInput } from "./models.ts";
import { SchemaSet } from "./schema.ts";
import { compileRules, type CompiledRule, type InternalMarkers, type RulesFile } from "./stage1.ts";
import type { Taxonomy } from "./stage2.ts";

export const ROOT = join(import.meta.dirname, "..");

export interface PluginConfig extends DecideConfig {
  mode: "A" | "B" | "C";
  direct_tier: string;
  decision_timeout_ms: number;
  pin_scope: "query" | "session";
  /** 도구 결과에서 개인정보·기밀 표식이 보이고 외부 모델로 보낼 때: warn 경고 / off 검사 안 함 */
  tool_result_policy: "warn" | "confirm" | "off";
  local_models: LocalModelInput[];
  analyzer: AnalyzerConfig & { timeout_ms: number; max_tokens: number; mask_secrets: boolean; suspicion_without_local: "warn" | "confirm" | "block"; followup_max_chars: number };
  virtual_levels: Record<"low" | "medium" | "high", "economy" | "balanced" | "quality">;
  internal_markers: InternalMarkers;
  log_dir: string;
}

export interface Loaded {
  cfg: PluginConfig;
  roster: Roster & { judge?: unknown };
  table: RoutingTable;
  taxonomy: Taxonomy;
  rules: CompiledRule[];
  userConfigPath: string | null;
  /** 사용자 설정에서 무시한 항목과 이유 (파일 오류 포함). 없으면 빈 배열 */
  configIssues: string[];
}

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.LLM_ROUTER_CONFIG ?? join(homedir(), ".pi/agent/llm-router.json");
}

/** 객체는 키별로 합치고, 배열과 값은 덮어쓴다. */
function merge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== "object" || Array.isArray(over)) return (over ?? base) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) {
    if (k.startsWith("$")) continue;
    const b = out[k];
    out[k] = b && typeof b === "object" && !Array.isArray(b) && v && typeof v === "object" && !Array.isArray(v) ? merge(b, v) : v;
  }
  return out as T;
}

/**
 * 사용자 설정을 읽고 스키마(user-config.schema.json)로 검사한다.
 * 깨진 JSON이나 스키마에 맞지 않는 항목은 확장 로딩을 막지 않고, 그 항목만 버리고(기본값 사용) 이유를 돌려준다.
 */
export function readUserConfig(path: string | null, schemaDir = join(ROOT, "spec/schemas")): { value: Record<string, unknown> | null; issues: string[] } {
  if (!path || !existsSync(path)) return { value: null, issues: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { value: null, issues: [`사용자 설정 파일을 읽을 수 없어 기본값을 씁니다 (${path}): ${(e as Error).message}`] };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { value: null, issues: [`사용자 설정은 JSON 객체여야 합니다 (${path}). 기본값을 씁니다`] };
  const value: Record<string, unknown> = Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith("$")));
  const issues: string[] = [];
  const schemas = new SchemaSet(schemaDir);
  // 오류가 난 최상위 항목만 버린다. 항목 하나를 버려도 다시 검사해 남은 오류가 없을 때까지 반복한다.
  for (let round = 0; round < 50; round++) {
    const errors = schemas.validate("user-config.schema.json", value);
    if (!errors.length) break;
    const bad = new Set<string>();
    for (const e of errors) {
      const unknown = e.path === "$" ? /^허용되지 않은 속성: (.+)$/.exec(e.message)?.[1] : undefined;
      if (unknown !== undefined && unknown in value) {
        if (!bad.has(unknown)) issues.push(`사용자 설정 '${unknown}' 무시: 알 수 없는 항목 (오타인지 확인하세요)`);
        bad.add(unknown);
        continue;
      }
      const key = e.path.split(/[.\[]/)[1];
      if (key && key in value) {
        if (!bad.has(key)) issues.push(`사용자 설정 '${key}' 무시: ${e.path.replace(/^\$\.?/, "")} ${e.message}`);
        bad.add(key);
      } else if (!key) {
        issues.push(`사용자 설정 오류: ${e.message}`);
        return { value: null, issues };
      }
    }
    if (!bad.size) return { value: null, issues };
    for (const k of bad) delete value[k];
  }
  return { value, issues };
}

export function loadConfig(opts: { root?: string; userPath?: string | null } = {}): Loaded {
  const root = opts.root ?? ROOT;
  const base = readJson(join(root, "config/llm-router.default.json")) as PluginConfig;
  const path = opts.userPath === undefined ? userConfigPath() : opts.userPath;
  const { value: user, issues } = readUserConfig(path, join(root, "spec/schemas"));
  const cfg = merge(base, user);
  cfg.log_dir = cfg.log_dir.replace(/^~(?=\/|$)/, homedir());
  const at = (p: string) => join(root, p);
  return {
    cfg,
    roster: readJson(at(cfg.roster)),
    table: readJson(at(cfg.routing_table)),
    taxonomy: readJson(at(cfg.taxonomy)),
    rules: compileRules(readJson(at(cfg.rules)) as RulesFile),
    userConfigPath: user ? path : null,
    configIssues: issues,
  };
}
