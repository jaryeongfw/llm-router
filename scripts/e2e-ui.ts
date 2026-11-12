/**
 * 화면 기능 종단 간 확인 (실제 pi RPC 세션).
 *   - 쿼리마다 카드 항목(llm-router-query)이 세션 파일에 저장되는가, 카드의 모델 = 실제 응답 모델인가
 *   - 상태줄(setStatus) 갱신 내용
 *   - /router stats, /router status 출력
 * 대화형 화면의 카드 그림은 RPC에서 보이지 않으므로, 카드 렌더러 출력은 저장된 카드 데이터로 다시 그려 보여 준다.
 * 사용: node scripts/e2e-ui.ts
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { userConfigPath } from "../src/config.ts";
import { cardLines, plainTheme, type QueryCard } from "../src/report.ts";
import { CARD_TYPE } from "../src/ui.ts";

const ROOT = join(import.meta.dirname, "..");
const QUERIES = [
  "TCP와 UDP의 차이를 한 문장으로 알려 줘.",
  "bash로 현재 디렉터리의 파일 목록을 확인하고, 각 파일이 무엇인지 한 줄씩 설명해 줘.",
  "주문·결제·재고가 한 서비스에 있는 모놀리스를 서비스별로 분리할지, 이벤트 기반으로 갈지 트레이드오프를 비교하고 하나를 권고해 줘. 세 문단 이내로.",
];

const work = mkdtempSync(join(tmpdir(), "router-ui-e2e-"));
writeFileSync(join(work, "README.md"), "# 예제\n주문 서비스 예제 저장소\n");
writeFileSync(join(work, "orders.ts"), "export function total(items: number[]) { return items.reduce((a, b) => a + b, 0); }\n");
const sessions = join(work, ".sessions");
const base = existsSync(userConfigPath()) ? JSON.parse(readFileSync(userConfigPath(), "utf8")) : {};
const cfgPath = join(work, "router-config.json");
writeFileSync(cfgPath, JSON.stringify({ ...base, log_dir: join(work, ".router-log") }));

const child = spawn("pi", ["--mode", "rpc", "--session-dir", sessions, "-ne", "-ns", "-np", "-nc", "--no-mcp", "--tools", "read,bash", "-e", join(ROOT, "src/index.ts"), "--model", "router/auto:medium"],
  { cwd: work, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, LLM_ROUTER_CONFIG: cfgPath } });
let buf = "";
const listeners: ((e: any) => void)[] = [];
const statuses: string[] = [];
const notes: string[] = [];
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    try {
      const e = JSON.parse(line);
      if (e.type === "extension_ui_request" && e.method === "setStatus" && e.statusKey === "llm-router" && e.statusText) statuses.push(strip(e.statusText));
      if (e.type === "extension_ui_request" && e.method === "notify") notes.push(strip(e.message));
      for (const l of listeners) l(e);
    } catch {}
  }
});
child.stderr.on("data", () => {});

const send = (o: object) => child.stdin.write(JSON.stringify(o) + "\n");
const until = (pred: (e: any) => boolean, ms = 300_000) => new Promise<void>((resolve) => {
  const timer = setTimeout(done, ms);
  function done() {
    clearTimeout(timer);
    listeners.splice(listeners.indexOf(l), 1);
    resolve();
  }
  const l = (e: any) => { if (pred(e)) done(); };
  listeners.push(l);
});

for (const [i, q] of QUERIES.entries()) {
  process.stderr.write(`  쿼리 ${i + 1}\n`);
  const settled = until((e) => e.type === "agent_settled");
  send({ id: `q${i}`, type: "prompt", message: q });
  await settled;
}
for (const cmd of ["/router stats", "/router status"]) {
  const n = notes.length;
  send({ id: cmd, type: "prompt", message: cmd });
  await until(() => notes.length > n, 10_000);
}
child.stdin.end();
child.kill();
await new Promise((r) => setTimeout(r, 300));

// 세션 파일에서 카드와 응답 모델 읽기
const files = existsSync(sessions) ? readdirSync(sessions, { recursive: true }).map(String).filter((f) => f.endsWith(".jsonl")) : [];
const entries = files.flatMap((f) => readFileSync(join(sessions, f), "utf8").trim().split("\n").map((l) => JSON.parse(l)));
const cards = entries.filter((e) => e.type === "custom" && e.customType === CARD_TYPE).map((e) => e.data as QueryCard);
const userIdx = entries.map((e, i) => (e.type === "message" && e.message?.role === "user" ? i : -1)).filter((i) => i >= 0);
let failed = 0;
const check = (ok: boolean, label: string) => {
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${label}`);
};

check(cards.length === QUERIES.length, `카드 ${cards.length}개 저장 (쿼리 ${QUERIES.length}개)`);
cards.forEach((c, i) => {
  const from = userIdx[i], to = userIdx[i + 1] ?? entries.length;
  const used = new Set(entries.slice(from, to).filter((e) => e.type === "message" && e.message?.role === "assistant").map((e) => `${e.message.provider}/${e.message.model}`));
  check(used.size === 1 && used.has(c.model) && c.usage.calls > 0, `쿼리 ${i + 1} 카드 모델 = 실제 응답 모델 (${c.tier} · ${c.model.split("/").pop()} · 호출 ${c.usage.calls}회)`);
});
check(statuses.length >= QUERIES.length, `상태줄 갱신 ${statuses.length}회`);
check(notes.some((n) => n.includes(`라우팅 쿼리 ${QUERIES.length}건`)), "/router stats 출력");
check(notes.some((n) => n.includes("◆ router")), "/router status 출력");

console.log("\n--- 카드 (저장된 데이터를 렌더러로 다시 그림, 색 없음)");
for (const c of cards) console.log(cardLines(c, 100, plainTheme).join("\n") + "\n");
console.log("--- 상태줄 (마지막)\n" + (statuses.at(-1) ?? "(없음)"));
console.log("\n--- /router stats\n" + (notes.find((n) => n.includes("라우팅 쿼리")) ?? "(없음)"));
console.log("\n--- /router status\n" + (notes.find((n) => n.includes("◆ router")) ?? "(없음)"));

rmSync(work, { recursive: true, force: true });
if (failed) {
  console.error(`\n실패 ${failed}건`);
  process.exit(1);
}
console.log("\n통과");
