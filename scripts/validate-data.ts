/**
 * 설정과 벤치마크 데이터를 스키마와 참조 무결성으로 검사한다 (07-spec §12-1).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { compileRules, runStage1, type RulesFile } from "../src/stage1.ts";
import { FAKE_KEYS, placeholdersOf } from "./lib/fake.ts";
import { hypothesisFor } from "./lib/hypothesis.ts";
import { SchemaSet } from "./lib/schema.ts";

const ROOT = join(import.meta.dirname, "..");
const schemas = new SchemaSet(join(ROOT, "spec/schemas"));
const errors: string[] = [];
const warnings: string[] = [];
const readJson = (rel: string) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));

function schemaCheck(schemaFile: string, label: string, value: unknown): void {
  for (const e of schemas.validate(schemaFile, value)) errors.push(`${label}: ${e.path} ${e.message}`);
}

// ---- 설정
const roster = readJson("config/roster.json");
const taxonomy = readJson("config/taxonomy.json");
const rulesFile = readJson("config/sensitivity-rules.json") as RulesFile;
const table = readJson("config/routing-table.v0.json");
const pluginConfig = readJson("config/llm-router.default.json");
schemaCheck("roster.schema.json", "config/roster.json", roster);
schemaCheck("taxonomy.schema.json", "config/taxonomy.json", taxonomy);
schemaCheck("rules.schema.json", "config/sensitivity-rules.json", rulesFile);
schemaCheck("routing-table.schema.json", "config/routing-table.v0.json", table);
schemaCheck("plugin-config.schema.json", "config/llm-router.default.json", pluginConfig);

const tierIds: string[] = roster.tiers.map((t: { id: string }) => t.id);
const domainIds = new Set<string>(taxonomy.domains.map((d: { id: string }) => d.id));
const actionIds = new Set<string>(taxonomy.actions.map((a: { id: string }) => a.id));

function unique(label: string, ids: string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) errors.push(`${label}: 중복 id ${id}`);
    seen.add(id);
  }
}
unique("roster.tiers", tierIds);
unique("taxonomy.domains", [...taxonomy.domains.map((d: { id: string }) => d.id)]);
unique("taxonomy.actions", [...taxonomy.actions.map((a: { id: string }) => a.id)]);
unique("rules", rulesFile.rules.map((r) => r.id));

// 티어 순서 = rank 순서
const byRank = [...roster.tiers].sort((a, b) => a.rank - b.rank).map((t: { id: string }) => t.id);
if (JSON.stringify(byRank) !== JSON.stringify(table.tiers_order)) errors.push(`routing-table.tiers_order ${JSON.stringify(table.tiers_order)} ≠ roster rank 순서 ${JSON.stringify(byRank)}`);

// 모델 ref 중복 (티어 간)
const allRefs = roster.tiers.flatMap((t: { models: { ref: string }[] }) => t.models.map((m) => m.ref));
unique("roster 티어 모델", allRefs);

// 조회표: 모든 (행위 ∪ *) × 난이도 0~3이 정확히 한 칸
const cellKeys = new Map<string, number>();
for (const c of table.cells) {
  const key = `${c.action}/${c.difficulty}`;
  cellKeys.set(key, (cellKeys.get(key) ?? 0) + 1);
  if (!tierIds.includes(c.tier)) errors.push(`routing-table ${key}: 없는 티어 ${c.tier}`);
  if (c.action !== "*" && !actionIds.has(c.action)) errors.push(`routing-table ${key}: 없는 행위`);
  if (c.basis === "measured" && c.n < 30) errors.push(`routing-table ${key}: measured인데 n=${c.n} < 30`);
}
// 추론 강도: 티어 기본 모델(primary)이 지원하는 값이어야 한다
type RModel = { ref: string; role?: string; thinking_levels: string[]; default_thinking: string };
const tierPrimary = new Map<string, RModel>();
for (const t of roster.tiers as { id: string; models: RModel[] }[]) {
  const p = t.models.filter((m) => m.role !== "fallback");
  if (p.length !== 1) errors.push(`roster ${t.id}: primary 모델이 ${p.length}개 (정확히 1개여야 함)`);
  if (p[0]) tierPrimary.set(t.id, p[0]);
  for (const m of t.models) if (!m.thinking_levels.includes(m.default_thinking)) errors.push(`roster ${m.ref}: default_thinking ${m.default_thinking} 미지원`);
}
for (const c of table.cells) {
  const p = tierPrimary.get(c.tier);
  if (p && !p.thinking_levels.includes(c.thinking)) errors.push(`routing-table ${c.action}/${c.difficulty}: ${c.tier}(${p.ref})는 추론 강도 ${c.thinking} 미지원`);
}

for (const a of [...actionIds, "*"]) for (let d = 0; d <= 3; d++) {
  const n = cellKeys.get(`${a}/${d}`) ?? 0;
  if (n !== 1) errors.push(`routing-table: ${a}/${d} 칸이 ${n}개`);
}
if (!tierIds.includes(table.default_tier)) errors.push(`routing-table.default_tier 없는 티어 ${table.default_tier}`);

// 플러그인 설정
for (const k of ["default_tier", "direct_tier", "side_effect_floor"]) {
  if (!tierIds.includes(pluginConfig[k])) errors.push(`plugin-config.${k}: 없는 티어 ${pluginConfig[k]}`);
}
const analyzerRefs = roster.analyzers.map((m: { ref: string }) => m.ref);
for (const k of ["model", "fallback"]) {
  const ref = pluginConfig.analyzer[k];
  if (ref && !analyzerRefs.includes(ref)) errors.push(`plugin-config.analyzer.${k}: roster.analyzers에 없음 ${ref}`);
}
for (const m of roster.analyzers) if (m.data_policy !== "internal") errors.push(`roster.analyzers ${m.ref}: 분석기는 internal이어야 함 (07-spec §5.1)`);
if (!roster.tiers.some((t: { models: { data_policy: string }[] }) => t.models.every((m) => m.data_policy === "internal"))) {
  errors.push("roster: internal 전용 티어가 없음 (민감 태스크를 처리할 수 없음)");
}

// 규칙 컴파일
let compiled: ReturnType<typeof compileRules> = [];
try {
  compiled = compileRules(rulesFile);
} catch (e) {
  errors.push(`sensitivity-rules 컴파일 실패: ${(e as Error).message}`);
}

// ---- 시드 케이스
const casesDir = join(ROOT, "bench/cases");
const caseIds = readdirSync(casesDir).filter((d) => statSync(join(casesDir, d)).isDirectory()).sort();
const fixtures = new Set(readdirSync(join(ROOT, "bench/fixtures")));
const counts = { cases: 0, byAction: new Map<string, number>(), byVerification: new Map<string, number>() };

for (const id of caseIds) {
  const dir = join(casesDir, id);
  const label = `bench/cases/${id}`;
  if (!existsSync(join(dir, "case.json"))) {
    errors.push(`${label}: case.json 없음`);
    continue;
  }
  const c = JSON.parse(readFileSync(join(dir, "case.json"), "utf8"));
  schemaCheck("seed-case.schema.json", label, c);
  counts.cases++;
  counts.byAction.set(c.task_type?.action, (counts.byAction.get(c.task_type?.action) ?? 0) + 1);
  counts.byVerification.set(c.verification?.type, (counts.byVerification.get(c.verification?.type) ?? 0) + 1);
  if (c.id !== id) errors.push(`${label}: id(${c.id}) ≠ 디렉터리 이름`);
  if (c.fixture !== null && !fixtures.has(c.fixture)) errors.push(`${label}: 없는 fixture ${c.fixture}`);
  if (!domainIds.has(c.task_type?.domain)) errors.push(`${label}: 없는 도메인 ${c.task_type?.domain}`);
  if (c.task_type?.action !== null && !actionIds.has(c.task_type?.action)) errors.push(`${label}: 없는 행위 ${c.task_type?.action}`);
  if (c.expected_tier_hypothesis && !tierIds.includes(c.expected_tier_hypothesis)) errors.push(`${label}: 없는 티어 ${c.expected_tier_hypothesis}`);
  try {
    const h = hypothesisFor(c);
    if (c.expected_tier_hypothesis !== h.tier || c.expected_thinking_hypothesis !== h.thinking) {
      errors.push(`${label}: 예상값 ${c.expected_tier_hypothesis}:${c.expected_thinking_hypothesis} ≠ 조회표 결과 ${h.tier}:${h.thinking} (npm run derive로 갱신)`);
    }
  } catch (e) {
    errors.push(`${label}: 결정 규칙 실행 실패 ${(e as Error).message}`);
  }
  const v = c.verification ?? {};
  if (["command", "hybrid", "mutation"].includes(v.type) && c.fixture === null) errors.push(`${label}: ${v.type} 검증에는 fixture가 필요`);
  if (["command", "hybrid"].includes(v.type) && !existsSync(join(dir, "hidden"))) errors.push(`${label}: ${v.type}인데 hidden/ 없음`);
  if (["command", "hybrid", "mutation"].includes(v.type) && !existsSync(join(dir, "solution"))) errors.push(`${label}: solution/ 없음`);
  if (v.type === "mutation") {
    for (const m of v.mutants ?? []) if (!existsSync(join(dir, m))) errors.push(`${label}: mutant 경로 없음 ${m}`);
    for (const g of v.test_globs ?? []) if (!existsSync(join(dir, "solution", g))) errors.push(`${label}: solution에 테스트 파일 없음 ${g}`);
  }
  if (c.verification?.type === "rubric" || c.verification?.type === "hybrid") {
    if (!c.verification.rubric.some((r: { must: boolean }) => r.must)) errors.push(`${label}: must 항목 없는 루브릭`);
  }
  // 라벨과 1단 규칙의 일관성: 라벨이 external_ok인데 규칙이 민감으로 판정하면 데이터나 규칙이 틀린 것
  for (const [name, text] of [["prompt", c.prompt], ...c.rewrites.map((t: string, i: number) => [`rewrite${i}`, t])] as [string, string][]) {
    const r = runStage1(compiled, { text });
    if (c.labels.hard_constraints.data_sensitivity !== r.hard_constraints.data_sensitivity) {
      warnings.push(`${label} ${name}: 라벨 민감도 ${c.labels.hard_constraints.data_sensitivity} ≠ 규칙 ${r.hard_constraints.data_sensitivity} (${r.rule_hits.join(",")})`);
    }
    if (c.labels.hard_constraints.irreversible_side_effects !== r.hard_constraints.irreversible_side_effects) {
      warnings.push(`${label} ${name}: 라벨 부작용 ${c.labels.hard_constraints.irreversible_side_effects} ≠ 규칙 (${r.rule_hits.join(",")})`);
    }
  }
}

// ---- 분석기 정답 세트
const goldLines = readFileSync(join(ROOT, "bench/analyzer/gold.jsonl"), "utf8").trim().split("\n");
const goldIds: string[] = [];
goldLines.forEach((line, i) => {
  const label = `gold.jsonl:${i + 1}`;
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    errors.push(`${label}: JSON 파싱 실패`);
    return;
  }
  schemaCheck("analyzer-gold.schema.json", label, row);
  goldIds.push(row.id);
  for (const key of placeholdersOf(row.prompt_template)) if (!FAKE_KEYS.includes(key)) errors.push(`${label}: 알 수 없는 자리표시자 FAKE_${key}`);
  const t = row.expected?.task_type;
  if (t && !domainIds.has(t.domain)) errors.push(`${label}: 없는 도메인 ${t.domain}`);
  if (t && t.action !== null && !actionIds.has(t.action)) errors.push(`${label}: 없는 행위 ${t.action}`);
  // 원문에 민감 값이 그대로 들어가 있으면 안 된다: 자리표시자를 지운 템플릿은 secret/pii 규칙에 걸리지 않아야 한다
  const stripped = row.prompt_template.replace(/\{\{FAKE_[A-Z_]+\}\}/g, "");
  const hits = runStage1(compiled, { text: stripped }).rule_hits.filter((h) => h.startsWith("secret.") || h.startsWith("pii."));
  if (hits.length) errors.push(`${label}: 템플릿 원문에 민감 형식 문자열 (${hits.join(",")})`);
});
unique("gold.jsonl", goldIds);

// ---- 보고
console.log(`케이스 ${counts.cases}건, 정답 세트 ${goldLines.length}건, 규칙 ${rulesFile.rules.length}개, 조회표 ${table.cells.length}칸`);
console.log(`행위별: ${[...counts.byAction].map(([k, v]) => `${k} ${v}`).join(", ")}`);
console.log(`검증 유형별: ${[...counts.byVerification].map(([k, v]) => `${k} ${v}`).join(", ")}`);
if (warnings.length) console.log(`\n경고 ${warnings.length}건:\n- ${warnings.join("\n- ")}`);
if (errors.length) {
  console.error(`\n오류 ${errors.length}건:\n- ${errors.join("\n- ")}`);
  process.exit(1);
}
console.log("\n통과");
