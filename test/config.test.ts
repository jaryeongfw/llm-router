import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";

const dir = mkdtempSync(join(tmpdir(), "router-cfg-"));
const load = (body: string) => {
  const p = join(dir, `c${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, body);
  return loadConfig({ userPath: p });
};

test("사용자 설정이 없거나 올바르면 문제 없음", () => {
  assert.deepEqual(loadConfig({ userPath: null }).configIssues, []);
  assert.deepEqual(loadConfig({ userPath: join(dir, "없음.json") }).configIssues, []);
  const l = load('{"$comment":"메모","local_models":["a/b"],"analyzer":{"prefer":"claude"}}');
  assert.deepEqual(l.configIssues, []);
  assert.deepEqual([l.cfg.local_models, l.cfg.analyzer.prefer, l.cfg.analyzer.timeout_ms], [["a/b"], "claude", 12000]);
});

test("깨진 JSON은 로딩을 막지 않고 기본값을 쓴다", () => {
  const l = load("{ nope");
  assert.equal(l.configIssues.length, 1);
  assert.match(l.configIssues[0], /읽을 수 없어 기본값/);
  assert.equal(l.cfg.pin_scope, "query");
  assert.match(load("[]").configIssues[0], /JSON 객체/);
});

test("오타 항목과 잘못된 값은 그 항목만 버리고 나머지는 적용한다", () => {
  const l = load('{"local_modells":["a/b"],"pin_scope":"forever","analyzer":{"timeout_ms":-5},"local_models":["x/y"],"tool_result_policy":"off"}');
  assert.equal(l.configIssues.length, 3);
  assert.ok(l.configIssues.some((i) => i.includes("'local_modells'") && i.includes("오타")));
  assert.ok(l.configIssues.some((i) => i.includes("'pin_scope'")));
  assert.ok(l.configIssues.some((i) => i.includes("'analyzer'")));
  assert.deepEqual([l.cfg.pin_scope, l.cfg.analyzer.timeout_ms, l.cfg.local_models, l.cfg.tool_result_policy], ["query", 12000, ["x/y"], "off"]);
});
