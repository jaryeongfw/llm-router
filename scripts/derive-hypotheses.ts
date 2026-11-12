/** 케이스의 expected_tier_hypothesis / expected_thinking_hypothesis를 현재 조회표로 다시 계산해 쓴다. */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hypothesisFor } from "./lib/hypothesis.ts";

const CASES = join(import.meta.dirname, "../bench/cases");
const summary = new Map<string, number>();
for (const id of readdirSync(CASES).sort()) {
  const p = join(CASES, id, "case.json");
  const c = JSON.parse(readFileSync(p, "utf8"));
  const d = hypothesisFor(c);
  const { expected_tier_hypothesis: _t, expected_thinking_hypothesis: _k, ...rest } = c;
  writeFileSync(p, JSON.stringify({ ...rest, expected_tier_hypothesis: d.tier, expected_thinking_hypothesis: d.thinking }, null, 2) + "\n");
  const key = `${d.tier}:${d.thinking}`;
  summary.set(key, (summary.get(key) ?? 0) + 1);
  console.log(`${id.padEnd(36)} ${c.task_type.action}/${c.labels.dimensions.difficulty} → ${key}${d.adjustments.length ? ` (${d.adjustments.join(",")})` : ""}${d.thinking_adjustments.length ? ` [${d.thinking_adjustments.join(",")}]` : ""}`);
}
console.log(`\n분포: ${[...summary].sort().map(([k, v]) => `${k} ${v}`).join(", ")}`);
