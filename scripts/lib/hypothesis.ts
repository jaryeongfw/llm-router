import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decide, type DecideConfig, type Decision, type Roster, type RoutingTable } from "../../src/decide.ts";

const ROOT = join(import.meta.dirname, "../..");
const rd = (p: string) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

/** 사람이 붙인 라벨(신뢰도 1, 운영점 balanced)에 현재 조회표를 적용한 가설 결정. */
export function hypothesisFor(c: { task_type: { domain: string; action: string | null }; labels: { hard_constraints: never; dimensions: never } }): Decision {
  const roster = rd("config/roster.json") as Roster;
  const table = rd("config/routing-table.v0.json") as RoutingTable;
  const cfg = rd("config/llm-router.default.json") as DecideConfig;
  return decide({ task_type: c.task_type, hard_constraints: c.labels.hard_constraints, dimensions: c.labels.dimensions, confidence: 1 }, roster, table, cfg, "balanced");
}
