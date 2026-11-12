/**
 * 비밀 값 가림 종단 간 검증 (실제 pi 실행).
 * 임시 저장소에 가짜 비밀 값이 든 .env를 만들고, 검사용 확장으로 공급자 요청 본문에 비밀 값이 있는지 매번 확인한다.
 *   S1 읽기: .env를 읽고 키 이름만 답하기       → 요청 본문에 비밀 값 없음
 *   S2 사용: 토큰 값을 인자로 check.mjs 실행     → 도구에는 원래 값이 전달되어 TOKEN_OK
 *   S2b 복원: 값을 명령에 직접 적게 함            → 모델은 자리표시를 쓰고, 실행 직전 복원되어 TOKEN_OK
 *   S3 수정: LOG_LEVEL만 변경                    → 파일의 비밀 값 줄이 그대로
 *   대조:   가림 없이 S1                          → 유출이 검출되어야 함 (검사 장치 확인)
 * 출력에는 비밀 값을 넣지 않는다.
 * 사용: node scripts/e2e-secret-guard.ts [--models a,b] [--no-control]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fillTemplate } from "./lib/fake.ts";

const ROOT = join(import.meta.dirname, "..");
const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const MODELS = arg("models", "anthropic/claude-haiku-5-5,simflow/ixi-simflow-codeadvisor").split(",");
const CONTROL = !process.argv.includes("--no-control");

const AWS = fillTemplate("{{FAKE_AWS_KEY}}", 101);
const TOKEN = fillTemplate("{{FAKE_SK_KEY}}", 102);
const SECRETS = [AWS, TOKEN];

const PROBE = `
import { appendFileSync } from "node:fs";
export default function (pi) {
  const secrets = Buffer.from(process.env.PROBE_SECRETS, "base64").toString("utf8").split("\\n");
  pi.on("before_provider_request", (event) => {
    const body = JSON.stringify(event.payload);
    const leaked = secrets.filter((s) => s && body.includes(s)).length;
    appendFileSync(process.env.PROBE_LOG, (leaked ? "LEAK" : "CLEAN") + "\\n");
  });
}
`;

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "secret-guard-e2e-"));
  writeFileSync(join(dir, ".env"), `APP_NAME=orders\nAWS_ACCESS_KEY_ID=${AWS}\nAPI_TOKEN=${TOKEN}\nLOG_LEVEL=info\n`);
  writeFileSync(join(dir, "check.mjs"), `import { readFileSync } from "node:fs";
const env = Object.fromEntries(readFileSync(new URL(".env", import.meta.url), "utf8").trim().split("\\n").map((l) => l.split(/=(.*)/s).slice(0, 2)));
console.log(process.argv[2] === env.API_TOKEN ? "TOKEN_OK" : "TOKEN_MISMATCH");
`);
  writeFileSync(join(dir, "probe.mjs"), PROBE);
  mkdirSync(join(dir, ".git"));
  return dir;
}

interface RunOut { code: number | null; events: any[]; probe: string[]; ms: number }
function runPi(dir: string, model: string, prompt: string, guard: boolean): Promise<RunOut> {
  const log = join(dir, `probe-${Date.now()}.log`);
  const args = ["--mode", "json", "--no-session", "-ne", "-ns", "-np", "-nc", "--no-mcp", "--tools", "read,bash,edit",
    ...(guard ? ["-e", join(ROOT, "src/index.ts")] : []), "-e", join(dir, "probe.mjs"), "--model", model,
    ...(model.startsWith("anthropic/") ? ["--thinking", "low"] : []), prompt];
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn("pi", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PROBE_LOG: log, PROBE_SECRETS: Buffer.from(SECRETS.join("\n")).toString("base64") } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", () => {});
    const timer = setTimeout(() => child.kill("SIGKILL"), 240_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const events = out.split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
      const probe = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
      resolve({ code, events, probe, ms: Date.now() - started });
    });
  });
}

function summarize(r: RunOut) {
  const toolStarts = r.events.filter((e) => e.type === "tool_execution_start").map((e) => e.toolName);
  const bashArgs = r.events.filter((e) => e.type === "tool_execution_start" && e.toolName === "bash").map((e) => String(e.args?.command ?? "")).join("\n");
  const toolOut = r.events.filter((e) => e.type === "tool_execution_end").map((e) => JSON.stringify(e.result ?? "")).join("\n");
  const last = r.events.filter((e) => e.type === "message_end" && e.message?.role === "assistant").at(-1)?.message;
  const text = (last?.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ");
  const err = last?.errorMessage ? String(last.errorMessage).slice(0, 80).replace(/\s+/g, " ") : "";
  return { toolStarts, bashArgs, toolOut, text, err, stop: last?.stopReason };
}

const clean = (s: string) => SECRETS.reduce((t, x) => t.split(x).join("<비밀값>"), s).replace(/\s+/g, " ").slice(0, 90);

const scenarios = [
  { id: "S1 읽기", prompt: ".env 파일을 read 도구로 읽고, 정의된 변수 이름만 쉼표로 나열해 줘. 값은 말하지 마.",
    check: (_d: string, s: ReturnType<typeof summarize>) => /API_TOKEN/.test(s.text) && /AWS_ACCESS_KEY_ID/.test(s.text) },
  { id: "S2 사용", prompt: ".env의 API_TOKEN 값을 인자로 넣어 `node check.mjs <값>`을 bash로 실행하고, 출력된 한 단어를 그대로 알려 줘.",
    check: (_d: string, s: ReturnType<typeof summarize>) => /TOKEN_OK/.test(s.toolOut) },
  { id: "S2b 복원", prompt: "먼저 .env를 read로 읽어. 그다음 읽은 API_TOKEN 값을 명령에 직접 써서 `node check.mjs <값>`을 bash로 실행해 (grep이나 변수 치환 쓰지 말고 값을 그대로 적어). 출력된 한 단어를 알려 줘.",
    check: (_d: string, s: ReturnType<typeof summarize>) => /TOKEN_OK/.test(s.toolOut) && /\[\[MASKED \d+ sk_api_key\]\]/.test(s.bashArgs) },
  { id: "S3 수정", prompt: ".env에서 LOG_LEVEL 값을 debug로 바꿔 줘. 다른 줄은 절대 건드리지 마. edit 도구를 써.",
    check: (d: string) => {
      const env = readFileSync(join(d, ".env"), "utf8");
      return env.includes(`AWS_ACCESS_KEY_ID=${AWS}\n`) && env.includes(`API_TOKEN=${TOKEN}\n`) && env.includes("LOG_LEVEL=debug") && !env.includes("MASKED");
    } },
];

const rows: string[] = [];
let failed = 0;
const record = (model: string, id: string, guard: boolean, r: RunOut, ok: boolean, want: "clean" | "leak") => {
  const s = summarize(r);
  const leaks = r.probe.filter((p) => p === "LEAK").length;
  const leakOk = want === "clean" ? leaks === 0 && r.probe.length > 0 : leaks > 0;
  const pass = ok && leakOk;
  if (!pass) failed++;
  rows.push(`| ${model.split("/").at(-1)} | ${id}${guard ? "" : " (가림 없음, 대조)"} | ${pass ? "✓" : "✗"} | 요청 ${r.probe.length} / 유출 ${leaks} | ${ok ? "통과" : "실패"} | ${s.toolStarts.join(",") || "-"} | ${(r.ms / 1000).toFixed(1)}s | ${clean(s.err || s.text)} |`);
};

for (const model of MODELS) {
  for (const sc of scenarios) {
    const dir = makeRepo();
    const r = await runPi(dir, model, sc.prompt, true);
    record(model, sc.id, true, r, sc.check(dir, summarize(r)), "clean");
    rmSync(dir, { recursive: true, force: true });
    process.stderr.write(`  ${model} ${sc.id} 완료\n`);
  }
}
if (CONTROL) {
  const dir = makeRepo();
  const r = await runPi(dir, MODELS[0], scenarios[0].prompt, false);
  record(MODELS[0], scenarios[0].id, false, r, true, "leak");
  rmSync(dir, { recursive: true, force: true });
}

console.log("| 모델 | 시나리오 | 결과 | 공급자 요청 / 비밀 값 포함 | 작업 확인 | 도구 호출 | 시간 | 마지막 응답 (비밀 값은 치환) |");
console.log("|---|---|---|---|---|---|---|---|");
for (const r of rows) console.log(r);
if (failed) {
  console.error(`\n실패 ${failed}건`);
  process.exit(1);
}
console.log("\n통과");
