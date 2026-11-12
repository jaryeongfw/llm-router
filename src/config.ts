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
import { compileRules, type CompiledRule, type InternalMarkers, type RulesFile } from "./stage1.ts";
import type { Taxonomy } from "./stage2.ts";

export const ROOT = join(import.meta.dirname, "..");

export interface PluginConfig extends DecideConfig {
  mode: "A" | "B" | "C";
  direct_tier: string;
  decision_timeout_ms: number;
  pin_scope: "query" | "session";
  local_models: LocalModelInput[];
  analyzer: AnalyzerConfig & { timeout_ms: number; max_tokens: number; mask_secrets: boolean };
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

export function loadConfig(opts: { root?: string; userPath?: string | null } = {}): Loaded {
  const root = opts.root ?? ROOT;
  const base = readJson(join(root, "config/llm-router.default.json")) as PluginConfig;
  const path = opts.userPath === undefined ? userConfigPath() : opts.userPath;
  const user = path && existsSync(path) ? readJson(path) : null;
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
  };
}
