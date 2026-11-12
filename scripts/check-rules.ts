/**
 * 1단 규칙을 분석기 정답 세트(bench/analyzer/gold.jsonl)로 평가한다.
 * 목표 (07-spec §5.2, §12): secret·pii 재현율 1.0, 민감도 정밀도 ≥ 0.8.
 * 출력에는 프롬프트나 생성된 가짜 값을 넣지 않는다. 사례 id와 규칙 id만 출력한다.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileRules, runStage1, type RuleGroup, type RulesFile } from "../src/stage1.ts";
import { fillTemplate } from "./lib/fake.ts";

const ROOT = join(import.meta.dirname, "..");
const rules = compileRules(JSON.parse(readFileSync(join(ROOT, "config/sensitivity-rules.json"), "utf8")) as RulesFile);
const gold = readFileSync(join(ROOT, "bench/analyzer/gold.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

const SEEDS = [1, 2, 3];

interface Count { tp: number; fp: number; fn: number; tn: number }
const zero = (): Count => ({ tp: 0, fp: 0, fn: 0, tn: 0 });
function add(c: Count, expected: boolean, got: boolean) {
  if (expected && got) c.tp++;
  else if (!expected && got) c.fp++;
  else if (expected && !got) c.fn++;
  else c.tn++;
}
const recall = (c: Count) => (c.tp + c.fn === 0 ? 1 : c.tp / (c.tp + c.fn));
const precision = (c: Count) => (c.tp + c.fp === 0 ? 1 : c.tp / (c.tp + c.fp));

const sensitivity = zero();
const sideEffect = zero();
const image = zero();
const byGroup = new Map<RuleGroup, Count>();
const misses: string[] = [];
const falseAlarms: string[] = [];

for (const row of gold) {
  for (const seed of SEEDS) {
    const text = fillTemplate(row.prompt_template, seed);
    const r = runStage1(rules, { text, attachments: row.attachments ?? [] });
    const exp = row.expected;
    add(sensitivity, exp.data_sensitivity === "internal_only", r.hard_constraints.data_sensitivity === "internal_only");
    add(sideEffect, exp.irreversible_side_effects, r.hard_constraints.irreversible_side_effects);
    add(image, (exp.required_capabilities ?? []).includes("image_input"), r.hard_constraints.required_capabilities.includes("image_input"));
    for (const g of ["secret", "pii", "internal_marker", "user_explicit", "side_effect", "capability"] as RuleGroup[]) {
      const c = byGroup.get(g) ?? zero();
      add(c, (exp.rule_groups ?? []).includes(g), r.groups.includes(g));
      byGroup.set(g, c);
    }
    if (seed !== SEEDS[0]) continue;
    const wantIn = exp.data_sensitivity === "internal_only";
    const gotIn = r.hard_constraints.data_sensitivity === "internal_only";
    if (wantIn && !gotIn) misses.push(`${row.id} (민감 미탐)`);
    if (!wantIn && gotIn) falseAlarms.push(`${row.id} (민감 오탐: ${r.rule_hits.join(",")})`);
    if (exp.irreversible_side_effects && !r.hard_constraints.irreversible_side_effects) misses.push(`${row.id} (부작용 미탐)`);
    if (!exp.irreversible_side_effects && r.hard_constraints.irreversible_side_effects) falseAlarms.push(`${row.id} (부작용 오탐: ${r.rule_hits.join(",")})`);
  }
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
console.log(`정답 세트 ${gold.length}건 × 시드 ${SEEDS.length}개\n`);
console.log("| 대상 | TP | FP | FN | TN | 재현율 | 정밀도 |");
console.log("|---|---|---|---|---|---|---|");
const line = (name: string, c: Count) => console.log(`| ${name} | ${c.tp} | ${c.fp} | ${c.fn} | ${c.tn} | ${pct(recall(c))} | ${pct(precision(c))} |`);
line("민감도 (internal_only)", sensitivity);
line("비가역 부작용", sideEffect);
line("이미지 입력", image);
for (const [g, c] of byGroup) line(`그룹 ${g}`, c);
if (misses.length) console.log(`\n미탐:\n- ${misses.join("\n- ")}`);
if (falseAlarms.length) console.log(`\n오탐 (허용 범위 확인용):\n- ${falseAlarms.join("\n- ")}`);

const failures: string[] = [];
for (const g of ["secret", "pii"] as RuleGroup[]) {
  const c = byGroup.get(g)!;
  if (recall(c) < 1) failures.push(`${g} 재현율 ${pct(recall(c))} < 100%`);
}
if (recall(sensitivity) < 1) failures.push(`민감도 재현율 ${pct(recall(sensitivity))} < 100%`);
if (precision(sensitivity) < 0.8) failures.push(`민감도 정밀도 ${pct(precision(sensitivity))} < 80%`);

if (failures.length) {
  console.error(`\n실패:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\n통과: 수용 기준 충족");
