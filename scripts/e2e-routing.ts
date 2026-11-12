/**
 * 쿼리별 분배 종단 간 검증 (실제 pi RPC 세션 하나에 여러 쿼리).
 * 확인:
 *   1) 쿼리마다 결정이 새로 내려진다 (결정 로그 = 쿼리 수)
 *   2) 쿼리별로 실제 응답한 물리 모델·추론 강도가 그 쿼리의 결정과 같다
 *   3) 한 쿼리 안의 도구 루프(continuation)는 같은 모델을 유지한다
 * 사용: node scripts/e2e-routing.ts [--scope query|session] [--no-local]
 *   --no-local: local 모델이 없는 환경. 판단 모델은 Claude 자동 선택, 개인정보 쿼리는 차단되어야 한다
 * 판단 모델·local 모델은 사용자 설정(~/.pi/agent/llm-router.json)을 따른다. 결정 로그는 임시 디렉터리에 쓴다.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { userConfigPath } from "../src/config.ts";
import { fillTemplate } from "./lib/fake.ts";

const ROOT = join(import.meta.dirname, "..");
const scopeArg = process.argv.indexOf("--scope");
const SCOPE = scopeArg > 0 ? process.argv[scopeArg + 1] : "query";
const NO_LOCAL = process.argv.includes("--no-local");

const QUERIES = [
  { label: "쉬운 설명", text: "TCP와 UDP의 차이를 한 문장으로 알려 줘." },
  { label: "도구 사용", text: "bash로 현재 디렉터리의 파일 목록을 확인하고, 각 파일이 무엇인지 한 줄씩 설명해 줘." },
  { label: "어려운 설계", text: "주문·결제·재고가 한 서비스에 있는 모놀리스를 서비스별로 분리할지, 이벤트 기반으로 갈지 트레이드오프를 비교하고 하나를 권고해 줘. 세 문단 이내로." },
  { label: "개인정보 포함", blockedWithoutLocal: true, text: fillTemplate("고객 연락처 {{FAKE_PHONE}}로 보낼 배송 지연 안내 문구를 한 줄 써 줘.", 7) },
];

const work = mkdtempSync(join(tmpdir(), "router-e2e-"));
writeFileSync(join(work, "README.md"), "# 예제\n주문 서비스 예제 저장소\n");
writeFileSync(join(work, "orders.ts"), "export function total(items: number[]) { return items.reduce((a, b) => a + b, 0); }\n");
const logDir = join(work, ".router-log");
const base = existsSync(userConfigPath()) ? JSON.parse(readFileSync(userConfigPath(), "utf8")) : {};
const cfgPath = join(work, "router-config.json");
writeFileSync(cfgPath, JSON.stringify({ ...base, log_dir: logDir, pin_scope: SCOPE, ...(NO_LOCAL ? { local_models: [] } : {}) }));

const child = spawn("pi", ["--mode", "rpc", "--no-session", "-ne", "-ns", "-np", "-nc", "--no-mcp", "--tools", "read,bash", "-e", join(ROOT, "src/index.ts"), "--model", "router/auto:medium"],
  { cwd: work, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, LLM_ROUTER_CONFIG: cfgPath } });
let buf = "";
const listeners: ((e: any) => void)[] = [];
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    try {
      const e = JSON.parse(line);
      for (const l of listeners) l(e);
    } catch {}
  }
});
child.stderr.on("data", () => {});

function ask(text: string, id: string): Promise<{ models: { model: string; thinking?: string; stop?: string; err?: string }[]; tools: string[]; ms: number }> {
  return new Promise((resolve) => {
    const models: { model: string; thinking?: string; stop?: string; err?: string }[] = [];
    const tools: string[] = [];
    const started = Date.now();
    const l = (e: any) => {
      if (e.type === "message_end" && e.message?.role === "assistant") models.push({ model: `${e.message.provider}/${e.message.model}`, thinking: e.message.thinkingLevel, stop: e.message.stopReason, err: e.message.errorMessage?.slice(0, 120) });
      if (e.type === "tool_execution_start") tools.push(e.toolName);
      if (e.type === "agent_settled") {
        listeners.splice(listeners.indexOf(l), 1);
        resolve({ models, tools, ms: Date.now() - started });
      }
    };
    listeners.push(l);
    child.stdin.write(JSON.stringify({ id, type: "prompt", message: text }) + "\n");
  });
}

const results = [];
for (const [i, q] of QUERIES.entries()) {
  process.stderr.write(`  쿼리 ${i + 1}: ${q.label}\n`);
  results.push({ q, r: await ask(q.text, `q${i + 1}`) });
}
child.stdin.end();
child.kill();

const decisions = existsSync(join(logDir, "decisions.jsonl")) ? readFileSync(join(logDir, "decisions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
let failed = 0;
console.log(`pin_scope=${SCOPE}${NO_LOCAL ? ", local 없음" : ""}, 쿼리 ${QUERIES.length}건, 결정 기록 ${decisions.length}건\n`);
console.log("| # | 쿼리 | 결정 (티어 · 모델 · 추론) | 조회표 / 보정 | 판단 모델 (지연) | 실제 응답 모델 (호출 수) | 도구 | 결과 |");
console.log("|---|---|---|---|---|---|---|---|");
const blocked = (q: (typeof QUERIES)[number]) => NO_LOCAL && "blockedWithoutLocal" in q;
const expectedDecisions = SCOPE === "query" ? QUERIES.filter((q) => !blocked(q)).length : 1;
let di = 0;
results.forEach(({ q, r }, i) => {
  if (blocked(q)) {
    const err = r.models.find((m) => m.stop === "error")?.err ?? "";
    const ok = /티어가 없습니다/.test(err) && r.models.every((m) => m.stop === "error");
    if (!ok) failed++;
    console.log(`| ${i + 1} | ${q.label} | 차단 (기대) | - | - | ${r.models.length}회 오류 응답 | - | ${ok ? "✓" : "✗"} ${err.slice(0, 60)} |`);
    return;
  }
  const d = SCOPE === "query" ? decisions[di++] : decisions[0];
  const used = [...new Set(r.models.map((m) => `${m.model}:${m.thinking ?? "-"}`))];
  const want = d ? `${d.decision.model}:${d.decision.thinking}` : "?";
  const errs = r.models.filter((m) => m.stop === "error").map((m) => m.err);
  const ok = !!d && used.length === 1 && used[0] === want && errs.length === 0;
  if (!ok) failed++;
  console.log(`| ${i + 1} | ${q.label} | ${d ? `${d.decision.tier} · ${d.decision.model.split("/").pop()} · ${d.decision.thinking}` : "-"} | ${d ? `${d.decision.cell ?? "-"}${d.decision.adjustments.length ? ` / ${d.decision.adjustments.join("+")}` : ""}` : "-"} | ${d ? `${(d.analyzer ?? "없음").split("/").pop()} (${d.latency_ms.total}ms)` : "-"} | ${used.join(", ")} (${r.models.length}) | ${r.tools.join(",") || "-"} | ${ok ? "✓" : `✗${errs.length ? ` ${errs[0]}` : ""}`} |`);
});
if (decisions.length !== expectedDecisions) {
  failed++;
  console.log(`\n✗ 결정 기록 ${decisions.length}건 (기대 ${expectedDecisions}건)`);
}
const distinct = new Set(results.map(({ r }) => r.models[0]?.model)).size;
for (const d of decisions) if (d.stage2 !== "ok") console.log(`  2단 ${d.query}: ${d.stage2} ${d.analyzer ?? ""} ${d.stage2_error ?? ""}`);
console.log(`\n쿼리별 응답 모델 종류: ${distinct}개`);
rmSync(work, { recursive: true, force: true });
if (failed) {
  console.error(`실패 ${failed}건`);
  process.exit(1);
}
console.log("통과");
void homedir;
