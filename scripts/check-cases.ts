/**
 * 시드 케이스 건전성 검사 (07-spec §12-2).
 *  - fixture 원본: 공개 테스트가 통과해야 한다.
 *  - command / hybrid: fixture + setup + hidden 은 실패, fixture + setup + solution + hidden 은 통과.
 *  - mutation: fixture + setup + solution(테스트) 은 통과, 여기에 각 mutant를 덮으면 실패.
 *  - rubric: 실행 검사 없음 (setup 파일 존재만 확인은 validate-data가 담당).
 * 사용: node scripts/check-cases.ts [케이스 id 일부 ...]
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const CASES = join(ROOT, "bench/cases");
const FIXTURES = join(ROOT, "bench/fixtures");
const CONCURRENCY = 4;

interface RunResult { code: number | null; out: string; timedOut: boolean }

function sh(command: string, cwd: string, timeoutS = 120): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, env: { ...process.env, NODE_NO_WARNINGS: "1", FORCE_COLOR: "0" } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutS * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, timedOut });
    });
  });
}

function workdir(fixture: string, overlays: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "llm-router-case-"));
  cpSync(join(FIXTURES, fixture), dir, { recursive: true });
  for (const o of overlays) if (existsSync(o)) cpSync(o, dir, { recursive: true, force: true });
  return dir;
}

function tail(s: string, n = 6): string {
  return s.trim().split("\n").filter((l) => /fail|error|Error|not ok|✖|assert/i.test(l)).slice(0, n).join("\n    ");
}

type Outcome = { id: string; type: string; ok: boolean; detail: string };

async function checkCase(id: string): Promise<Outcome> {
  const caseDir = join(CASES, id);
  const c = JSON.parse(readFileSync(join(caseDir, "case.json"), "utf8"));
  const v = c.verification;
  const setup = join(caseDir, "setup");
  const hidden = join(caseDir, "hidden");
  const solution = join(caseDir, "solution");
  const dirs: string[] = [];
  const mk = (overlays: string[]) => {
    const d = workdir(c.fixture, overlays);
    dirs.push(d);
    return d;
  };
  try {
    if (v.type === "rubric") return { id, type: v.type, ok: true, detail: "실행 검사 없음" };
    if (v.type === "command" || v.type === "hybrid") {
      const base = await sh(v.command, mk([setup, hidden]), v.timeout_s);
      const solved = await sh(v.command, mk([setup, solution, hidden]), v.timeout_s);
      const problems: string[] = [];
      if (base.code === 0) problems.push("기준 상태에서 검증이 통과함 (버그·요구가 검증되지 않음)");
      if (base.timedOut) problems.push("기준 상태 시간 초과");
      if (solved.code !== 0) problems.push(`해답 적용 후 검증 실패:\n    ${tail(solved.out)}`);
      return { id, type: v.type, ok: problems.length === 0, detail: problems.join("; ") || "기준 실패 → 해답 통과" };
    }
    if (v.type === "mutation") {
      const clean = await sh(v.test_command, mk([setup, solution]), v.timeout_s);
      const problems: string[] = [];
      if (clean.code !== 0) problems.push(`해답 테스트가 원본에서 실패:\n    ${tail(clean.out)}`);
      let killed = 0;
      for (const m of v.mutants) {
        const r = await sh(v.test_command, mk([setup, solution, join(caseDir, m)]), v.timeout_s);
        if (r.code !== 0) killed++;
        else problems.push(`${m} 생존`);
      }
      return { id, type: v.type, ok: problems.length === 0, detail: problems.join("; ") || `mutant ${killed}/${v.mutants.length} 제거` };
    }
    return { id, type: v.type, ok: false, detail: `알 수 없는 검증 유형 ${v.type}` };
  } finally {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

const filters = process.argv.slice(2);
const ids = readdirSync(CASES).filter((d) => statSync(join(CASES, d)).isDirectory()).filter((d) => filters.length === 0 || filters.some((f) => d.includes(f))).sort();

// fixture 원본의 공개 테스트
const fixtures = readdirSync(FIXTURES).filter((d) => statSync(join(FIXTURES, d)).isDirectory());
const fixtureResults = await pool(fixtures, CONCURRENCY, async (f) => {
  const d = workdir(f, []);
  try {
    return { f, r: await sh("npm test", d) };
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

const started = Date.now();
const results = await pool(ids, CONCURRENCY, checkCase);

let failed = 0;
console.log("fixture 공개 테스트:");
for (const { f, r } of fixtureResults) {
  const ok = r.code === 0;
  if (!ok) failed++;
  console.log(`  ${ok ? "✓" : "✗"} ${f}${ok ? "" : `\n    ${tail(r.out)}`}`);
}
console.log(`\n케이스 ${results.length}건 (${((Date.now() - started) / 1000).toFixed(1)}s):`);
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`  ${r.ok ? "✓" : "✗"} ${r.id.padEnd(36)} ${r.type.padEnd(8)} ${r.detail}`);
}
if (failed) {
  console.error(`\n실패 ${failed}건`);
  process.exit(1);
}
console.log("\n통과");
