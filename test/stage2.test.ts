import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildSystemPrompt, parseStage2, runStage2, type Taxonomy } from "../src/stage2.ts";

const tax = JSON.parse(readFileSync(join(import.meta.dirname, "../config/taxonomy.json"), "utf8")) as Taxonomy;
const good = '{"task_type":{"domain":"frontend","action":"debug"},"dimensions":{"difficulty":1,"ambiguity":0,"scope":1,"verifiability":0,"consistency":0,"capabilities":{"long_context":0,"multi_step_tools":1,"code_correctness":2,"instruction_following":1,"korean_writing":0,"reasoning":1}},"difficulty_rationale":"경계값 수정","confidence":0.8,"sensitivity_suspected":false}';

test("시스템 프롬프트에 모든 도메인·행위 id가 들어간다", () => {
  const s = buildSystemPrompt(tax);
  for (const e of [...tax.domains, ...tax.actions]) assert.ok(s.includes(`- ${e.id} (`), e.id);
});

test("앞뒤 잡음이 있어도 JSON 객체를 뽑는다", () => {
  const o = parseStage2(`\n\n결과:\n${good}\n끝`, tax);
  assert.equal(o.task_type.action, "debug");
  assert.equal(o.dimensions.capabilities.code_correctness, 2);
});

test("범위 밖 값은 0~3으로 맞추고, 신뢰도는 0~1", () => {
  const o = parseStage2(good.replace('"difficulty":1', '"difficulty":7').replace('"confidence":0.8', '"confidence":3'), tax);
  assert.equal(o.dimensions.difficulty, 3);
  assert.equal(o.confidence, 1);
});

test("분류 체계에 없는 id는 오류", () => {
  assert.throws(() => parseStage2(good.replace('"debug"', '"hack"'), tax));
  assert.throws(() => parseStage2(good.replace('"frontend"', '"mobile"'), tax));
});

test("action null 허용", () => {
  assert.equal(parseStage2(good.replace('"action":"debug"', '"action":null'), tax).task_type.action, null);
});

test("기본 모델이 실패하면 대체 모델, 형식 오류는 대체하지 않음", async () => {
  const fail = async () => { throw new Error("403"); };
  const ok = async () => good;
  const r1 = await runStage2("x", tax, [{ ref: "a", complete: fail }, { ref: "b", complete: ok }], 1000);
  assert.deepEqual([r1.status, r1.model], ["ok", "b"]);
  const r2 = await runStage2("x", tax, [{ ref: "a", complete: async () => "모르겠음" }, { ref: "b", complete: ok }], 1000);
  assert.deepEqual([r2.status, r2.model], ["parse_error", "a"]);
  const r3 = await runStage2("x", tax, [{ ref: "a", complete: fail }], 1000);
  assert.equal(r3.status, "unavailable");
});
