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

test("기본 모델이 실패하거나 형식 오류면 대체 모델", async () => {
  const fail = async () => { throw new Error("403"); };
  const ok = async () => good;
  const r1 = await runStage2("x", tax, [{ ref: "a", complete: fail }, { ref: "b", complete: ok }], 1000);
  assert.deepEqual([r1.status, r1.model], ["ok", "b"]);
  const r2 = await runStage2("x", tax, [{ ref: "a", complete: async () => "모르겠음" }, { ref: "b", complete: ok }], 1000);
  assert.deepEqual([r2.status, r2.model], ["ok", "b"]);
  const r2b = await runStage2("x", tax, [{ ref: "a", complete: async () => "모르겠음" }], 1000);
  assert.deepEqual([r2b.status, r2b.model], ["parse_error", "a"]);
  const r3 = await runStage2("x", tax, [{ ref: "a", complete: fail }], 1000);
  assert.equal(r3.status, "unavailable");
});

const hang = (signal?: AbortSignal) => new Promise<string>((_, rej) => signal?.addEventListener("abort", () => rej(new Error("aborted"))));

test("판단 전체 시간 상한: 남은 시간만큼만 기다리고 다 쓰면 더 시도하지 않는다", async () => {
  const t0 = Date.now();
  const tried: string[] = [];
  const mk = (ref: string) => ({ ref, complete: async (_s: string, _u: string, sig?: AbortSignal) => { tried.push(ref); return hang(sig); } });
  const r = await runStage2("x", tax, [mk("a"), mk("b"), mk("c")], 1000, { totalMs: 120 });
  assert.equal(r.status, "timeout");
  assert.deepEqual(tried, ["a"], "첫 시도가 전체 상한을 다 써서 다음 모델은 시도하지 않음");
  assert.ok(Date.now() - t0 < 600);
});

test("시도별 상한이 남은 시간보다 짧으면 대체 모델을 시도한다", async () => {
  const tried: string[] = [];
  const r = await runStage2("x", tax, [
    { ref: "a", complete: async (_s, _u, sig) => { tried.push("a"); return hang(sig); } },
    { ref: "b", complete: async () => { tried.push("b"); return good; } },
  ], 40, { totalMs: 500 });
  assert.deepEqual([r.status, r.model, tried.join("")], ["ok", "b", "ab"]);
});

test("사용자 중단: 호출을 끊고 다음 모델은 시도하지 않는다", async () => {
  const ac = new AbortController();
  const tried: string[] = [];
  const mk = (ref: string) => ({ ref, complete: async (_s: string, _u: string, sig?: AbortSignal) => { tried.push(ref); return hang(sig); } });
  setTimeout(() => ac.abort(), 30);
  const r = await runStage2("x", tax, [mk("a"), mk("b")], 5000, { signal: ac.signal });
  assert.deepEqual(tried, ["a"]);
  assert.equal(r.status, "unavailable");
});
