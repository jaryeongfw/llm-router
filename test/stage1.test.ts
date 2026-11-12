import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fillTemplate } from "../scripts/lib/fake.ts";
import { compileRules, krRrnShapeOk, luhnOk, maskSecrets, runStage1, runStage1Safe, type RulesFile } from "../src/stage1.ts";

const rules = compileRules(JSON.parse(readFileSync(join(import.meta.dirname, "../config/sensitivity-rules.json"), "utf8")) as RulesFile);

test("luhn: 공개 테스트 카드번호는 통과, 임의 숫자열은 불통과", () => {
  assert.ok(luhnOk(fillTemplate("{{FAKE_CARD}}", 1)));
  assert.ok(!luhnOk("1234567890123"));
});

test("주민번호 형식: 성별 자리 1~8만", () => {
  // 월 자리 00(존재할 수 없는 날짜)으로 실행 시 조합한다. 저장소에 주민번호 형식 문자열을 두지 않는다.
  const shape = (g: string) => ["99", "00", "01"].join("") + "-" + g + "0".repeat(6);
  assert.ok(krRrnShapeOk(shape("1")));
  assert.ok(!krRrnShapeOk(shape("9")));
});

test("민감 판정은 규칙 id만 남기고 값은 남기지 않는다", () => {
  const text = fillTemplate("키 {{FAKE_AWS_KEY}} 확인", 7);
  const r = runStage1(rules, { text });
  assert.equal(r.hard_constraints.secret_present, true);
  assert.deepEqual(r.rule_hits, ["secret.aws_access_key"]);
  assert.ok(!JSON.stringify(r).includes(text.slice(2, 22)));
});

test("사용자 설정 내부 도메인", () => {
  const r = runStage1(rules, { text: "wiki.corp.test 페이지 요약", internalMarkers: { domains: ["corp.test"], path_prefixes: [], keywords: [] } });
  assert.deepEqual(r.rule_hits, ["internal_marker.domains"]);
});

test("민감 신호 없는 요청은 external_ok", () => {
  const r = runStage1(rules, { text: "이 함수 이름을 calculateTotal로 바꿔 줘" });
  assert.equal(r.hard_constraints.data_sensitivity, "external_ok");
  assert.equal(r.hard_constraints.irreversible_side_effects, false);
});

test("규칙 평가 예외 시 민감으로 간주 (failsafe)", () => {
  const broken = [{ ...rules[0], re: undefined }];
  const r = runStage1Safe(broken as typeof rules, { text: "아무거나" });
  assert.equal(r.failsafe, true);
  assert.equal(r.hard_constraints.data_sensitivity, "internal_only");
});

test("비밀정보는 secret_present로 표시하고 internal_only로 만들지 않는다", () => {
  const r = runStage1(rules, { text: fillTemplate("키 {{FAKE_SK_KEY}} 확인", 2) });
  assert.equal(r.hard_constraints.secret_present, true);
  assert.equal(r.hard_constraints.data_sensitivity, "external_ok");
});

test("maskSecrets: 비밀 값을 규칙 id 자리표시로 바꾼다", () => {
  const text = fillTemplate("키 {{FAKE_AWS_KEY}}, 연락처 {{FAKE_PHONE}}", 4);
  const m = maskSecrets(rules, text);
  assert.equal(m.masked, 1);
  assert.ok(m.text.includes("[[MASKED aws_access_key]]"));
  assert.ok(m.text.includes("010-0000-"), "개인정보는 가리지 않는다(사내 분석기로 보낸다)");
  assert.equal(runStage1(rules, { text: m.text }).hard_constraints.secret_present, false);
});

test("코드 식별자는 비밀번호 대입으로 보지 않는다", () => {
  for (const text of ["const token = getAuthToken();", "{ secret: true, retries: 3 }", "config.secret = process.env.APP_SECRET", "password = input.value"]) {
    assert.equal(runStage1(rules, { text }).hard_constraints.secret_present, false, text);
  }
  assert.equal(runStage1(rules, { text: fillTemplate(["DB_PASSWORD", ': "{{FAKE_PASSWORD}}"'].join(""), 5) }).hard_constraints.secret_present, true);
  assert.equal(runStage1(rules, { text: fillTemplate("password={{FAKE_PASSWORD}}", 6) }).hard_constraints.secret_present, true);
});
