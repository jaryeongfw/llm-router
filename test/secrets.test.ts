import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fillTemplate } from "../scripts/lib/fake.ts";
import { MASK_GUIDELINE, registerSecretGuard } from "../src/secret-guard.ts";
import { SecretVault } from "../src/secrets.ts";
import { compileRules, type RulesFile } from "../src/stage1.ts";

const rules = compileRules(JSON.parse(readFileSync(join(import.meta.dirname, "../config/sensitivity-rules.json"), "utf8")) as RulesFile);
const KEY = fillTemplate("{{FAKE_AWS_KEY}}", 11);
const TOKEN = fillTemplate("{{FAKE_SK_KEY}}", 12);

test("가리고 되돌리면 원문과 같다. 같은 값은 같은 번호", () => {
  const v = new SecretVault(rules);
  const text = `A=${KEY}\nB=${TOKEN}\nC=${KEY}`;
  const m = v.maskText(text);
  assert.equal(m.count, 3);
  assert.ok(!m.text.includes(KEY) && !m.text.includes(TOKEN));
  assert.equal(m.text.match(/\[\[MASKED 1 aws_access_key\]\]/g)?.length, 2);
  assert.ok(m.text.includes("[[MASKED 2 sk_api_key]]"));
  assert.equal(v.unmaskText(m.text).text, text);
  assert.equal(v.maskText(m.text).count, 0, "자리표시는 다시 가리지 않는다");
});

test("비밀번호·접속 문자열은 값만 가린다", () => {
  const v = new SecretVault(rules);
  const pw = fillTemplate("{{FAKE_PASSWORD}}", 13);
  const m1 = v.maskText(`password=${pw}`);
  assert.match(m1.text, /^password=\[\[MASKED \d+ password_assign\]\]$/);
  const conn = fillTemplate("{{FAKE_CONN}}", 14);
  const m2 = v.maskText(`DB=${conn}`);
  assert.match(m2.text, /^DB=postgres:\/\/svc_[a-z]+:\[\[MASKED \d+ conn_string\]\]@db\.example\.internal:5432\/app$/);
});

test("개인 키는 블록 전체를 가린다", () => {
  const v = new SecretVault(rules);
  const block = fillTemplate("{{FAKE_PRIVATE_KEY}}", 15);
  const body = block.split("\n")[1];
  const m = v.maskText(`키:\n${block}\n끝`);
  assert.ok(!m.text.includes(body));
  assert.match(m.text, /^키:\n\[\[MASKED \d+ private_key\]\]\n끝$/);
});

test("전화번호·주민번호도 가린다 (mask 규칙). 복원도 된다", () => {
  const v = new SecretVault(rules);
  const phone = fillTemplate("{{FAKE_PHONE}}", 21);
  const rrn = fillTemplate("{{FAKE_RRN}}", 22);
  const text = `연락처 ${phone}, 주민번호 ${rrn}`;
  const m = v.maskText(text);
  assert.equal(m.count, 2);
  assert.ok(!m.text.includes(phone) && !m.text.includes(rrn));
  assert.match(m.text, /\[\[MASKED \d+ phone_kr\]\]/);
  assert.match(m.text, /\[\[MASKED \d+ kr_rrn\]\]/);
  assert.equal(v.unmaskText(m.text).text, text);
});

test("메시지 구조: 사용자·도구 결과·도구 인자는 가리고, thinking과 서명된 텍스트는 그대로", () => {
  const v = new SecretVault(rules);
  const msgs = [
    { role: "user", content: `키 ${KEY} 확인`, timestamp: 1 },
    { role: "assistant", content: [
      { type: "thinking", thinking: "생각", thinkingSignature: "sig" },
      { type: "toolCall", id: "t1", name: "bash", arguments: { command: `node check.mjs ${TOKEN}` } },
    ] },
    { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: `API_TOKEN=${TOKEN}` }], isError: false, timestamp: 2 },
    { role: "assistant", content: [{ type: "text", text: `값 ${KEY}`, textSignature: "s" }] },
  ];
  const before = JSON.stringify(msgs);
  const r = v.maskMessages(msgs);
  assert.equal(r.count, 3);
  const out = JSON.stringify(r.messages);
  assert.ok(!out.slice(0, out.lastIndexOf("textSignature")).includes(TOKEN));
  assert.ok(out.includes('"thinking":"생각"'));
  assert.ok(out.includes(`값 ${KEY}`), "서명된 어시스턴트 텍스트는 바꾸지 않음");
  assert.equal(JSON.stringify(msgs), before, "입력 배열은 바꾸지 않는다");
});

test("바뀐 것이 없으면 같은 배열을 반환", () => {
  const v = new SecretVault(rules);
  const msgs = [{ role: "user", content: "평범한 요청", timestamp: 1 }];
  assert.equal(v.maskMessages(msgs).messages, msgs);
});

test("가드: context는 가리고, tool_call은 되돌리고, 모르는 번호는 막는다", async () => {
  const handlers: Record<string, Function> = {};
  const host = { on: (e: string, h: Function) => { handlers[e] = h; } };
  registerSecretGuard(host as never, rules);
  const ctx = { sessionManager: { getSessionId: () => "s1" } };
  const masked = handlers.context({ messages: [{ role: "user", content: `토큰 ${TOKEN} 으로 호출해` }] }, ctx);
  const text = masked.messages[0].content as string;
  const ph = text.match(/\[\[MASKED \d+ sk_api_key\]\]/)![0];
  const input = { command: `curl -H "Authorization: Bearer ${ph}" https://api.example.com` };
  assert.equal(handlers.tool_call({ toolName: "bash", input }, ctx), undefined);
  assert.equal(input.command, `curl -H "Authorization: Bearer ${TOKEN}" https://api.example.com`);
  const bad = handlers.tool_call({ toolName: "bash", input: { command: "echo [[MASKED 99 sk_api_key]]" } }, ctx);
  assert.equal(bad.block, true);
  const other = handlers.tool_call({ toolName: "bash", input: { command: `echo ${ph}` } }, { sessionManager: { getSessionId: () => "s2" } });
  assert.equal(other.block, true, "다른 세션의 자리표시는 복원하지 않는다");
});

test("가드: 자리표시 사용 지침을 한 번만 넣는다", () => {
  const handlers: Record<string, Function> = {};
  registerSecretGuard({ on: (e: string, h: Function) => { handlers[e] = h; } } as never, rules);
  const opts = { promptGuidelines: ["기존 지침"] };
  handlers.before_agent_start({ systemPromptOptions: opts });
  handlers.before_agent_start({ systemPromptOptions: opts });
  assert.deepEqual(opts.promptGuidelines, ["기존 지침", MASK_GUIDELINE]);
});
