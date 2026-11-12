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
  const r = runStage1(rules, { text: "wiki.example.internal 페이지 요약", internalMarkers: { domains: ["example.internal"], path_prefixes: [], keywords: [] } });
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
  assert.ok(m.text.includes("010-0000-"), "개인정보는 가리지 않는다(로컬 판단 모델로 보낸다)");
  assert.equal(runStage1(rules, { text: m.text }).hard_constraints.secret_present, false);
});

test("코드 식별자는 비밀번호 대입으로 보지 않는다", () => {
  for (const text of ["const token = getAuthToken();", "{ secret: true, retries: 3 }", "config.secret = process.env.APP_SECRET", "password = input.value"]) {
    assert.equal(runStage1(rules, { text }).hard_constraints.secret_present, false, text);
  }
  assert.equal(runStage1(rules, { text: fillTemplate(["DB_PASSWORD", ': "{{FAKE_PASSWORD}}"'].join(""), 5) }).hard_constraints.secret_present, true);
  assert.equal(runStage1(rules, { text: fillTemplate("password={{FAKE_PASSWORD}}", 6) }).hard_constraints.secret_present, true);
});

const sens = (text: string) => runStage1(rules, { text }).hard_constraints.data_sensitivity;
const side = (text: string) => runStage1(rules, { text }).hard_constraints.irreversible_side_effects;

test("민감 키워드: 주제어 용법과 식별자 안은 잡지 않는다", () => {
  for (const t of ["개인정보 마스킹 유틸 함수 만들어 줘", "PII 탐지 정규식 테스트 작성", "개인정보 보호법 요약해 줘", "isConfidential 플래그 이름을 바꿔 줘", "CONFIDENTIAL_FLAG 상수를 지워 줘", "add a PII redaction helper"]) {
    assert.equal(sens(t), "external_ok", t);
  }
});

test("민감 키워드: 데이터를 가리키거나 처리를 요청하면 그대로 잡는다", () => {
  for (const t of ["개인정보 마스킹해 줘: 아래 명단", "고객 정보 테이블 조회 쿼리가 느려요", "PII가 포함된 로그야", "CONFIDENTIAL: Q3 plan 요약", "customer data export 결과 정리", "대외비 마스킹 함수"]) {
    assert.equal(sens(t), "internal_only", t);
  }
});

test("부작용: 부정 표현은 제외, 다른 실행 요청은 그대로", () => {
  for (const t of ["git push는 하지 말고 로컬 커밋까지만 해 줘", "운영 배포는 하지 말고 스테이징까지만", "do not git push", "마이그레이션 실행하지 마", "DB 삭제하면 안 돼"]) assert.equal(side(t), false, t);
  for (const t of ["git push 해 줘", "git push 하지 말고 바로 운영 배포해 줘", "프로덕션 배포까지 해 줘", "마이그레이션 실행해"]) assert.equal(side(t), true, t);
});

test("사용자 설정 키워드·도메인도 단어 경계로 매치한다", () => {
  const m = { domains: ["corp.internal"], path_prefixes: [], keywords: ["atlas"] };
  const hit = (t: string) => runStage1(rules, { text: t, internalMarkers: m }).rule_hits;
  assert.deepEqual(hit("Atlas 프로젝트 일정"), ["internal_marker.user_keywords"]);
  assert.deepEqual(hit("wiki.corp.internal 문서"), ["internal_marker.domains"]);
  assert.deepEqual(hit("atlassian 연동 설정"), []);
  assert.deepEqual(hit("notcorp.internal 문서"), []);
});
