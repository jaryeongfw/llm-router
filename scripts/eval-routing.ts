/**
 * 라우팅 판단 평가 (외부 벤더 호출 없음, 로컬 판단 모델만 사용).
 *  - 시드 케이스: 1단 → 2단 → decide 결과를 "사람 라벨로 계산한 결정"과 비교
 *  - 정답 세트: 행위·난이도·모호성·민감도 판정 정확도
 *  - 같은 뜻의 변형(prompt / rewrite0 / rewrite1) 간 결정 안정성
 * 측정 대상은 분석기 충실도다. 라벨 결정이 최적이라는 뜻은 아니다(조회표는 prior).
 *
 * 사용: node scripts/eval-routing.ts [--analyzer policy|<model-ref>] [--concurrency 3] [--timeout-ms 60000] [--reps 1] [--only cases|gold]
 *   --analyzer policy: 플러그인과 같은 규칙으로 판단 모델을 고른다 (기본: local → Claude 자동, 로컬 전용은 local만)
 *   --analyzer <ref>:  모든 요청을 그 모델 하나로 분석한다 (비교용. internal_only 요청도 보낸다)
 *   --rescore <raw.jsonl>: 모델을 다시 호출하지 않고 저장된 2단 결과를 현재 규칙·조회표로 다시 채점한다
 * 출력: bench/results/routing-eval-<날짜>.md (요약), bench/results/raw/*.jsonl (원시, git 제외)
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeStages } from "../src/analyze.ts";
import { decide, THINKING_LADDER, type AnalysisInput, type DecideConfig, type Decision, type Roster, type RoutingTable } from "../src/decide.ts";
import { compileRules, maskSecrets, runStage1Safe, type RulesFile } from "../src/stage1.ts";
import { runStage2, type Complete, type Stage2Result, type Taxonomy } from "../src/stage2.ts";
import { loadConfig } from "../src/config.ts";
import { resolveAnalyzers, resolveRoster } from "../src/models.ts";
import { cliCatalog } from "./lib/catalog.ts";
import { fillTemplate } from "./lib/fake.ts";
import { hypothesisFor } from "./lib/hypothesis.ts";

const ROOT = join(import.meta.dirname, "..");
const rd = (p: string) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};

const roster = rd("config/roster.json") as Roster & { analyzers: { ref: string }[] };
const table = rd("config/routing-table.v0.json") as RoutingTable;
const loaded = loadConfig();
const cfg = loaded.cfg;
type Route = { ref: string; thinking?: string }[];
const catalog = cliCatalog();
const resolvedAnalyzers = resolveAnalyzers(cfg.analyzer, resolveRoster(loaded.roster, cfg.local_models, catalog), catalog);
const tax = rd("config/taxonomy.json") as Taxonomy;
const rules = compileRules(rd("config/sensitivity-rules.json") as RulesFile);
const ANALYZER = arg("analyzer", "policy");
const MODEL = ANALYZER === "policy" ? `policy(외부 허용: ${resolvedAnalyzers.external_ok.map((r) => r.ref).join(" → ") || "없음"} | 로컬 전용: ${resolvedAnalyzers.internal_only.map((r) => r.ref).join(" → ") || "없음"})` : ANALYZER;
const CONCURRENCY = Number(arg("concurrency", "3"));
const TIMEOUT_MS = Number(arg("timeout-ms", "60000"));
const REPS = Number(arg("reps", "1"));
const ONLY = arg("only", "all");
const RESCORE = arg("rescore", "");

// ---- pi CLI로 로컬 모델 호출 (도구·확장·세션 없음)
const promptDir = mkdtempSync(join(tmpdir(), "llm-router-eval-"));
const completeVia = (ref: string, thinking?: string): Complete => (system, user, signal) => new Promise((resolve, reject) => {
  const sysFile = join(promptDir, "system.txt");
  writeFileSync(sysFile, system);
  const child = spawn("pi", ["-p", "--no-session", "-ne", "-ns", "-np", "-nc", "--no-mcp", "--no-tools", "--system-prompt", sysFile, "--model", ref, ...(thinking ? ["--thinking", thinking] : []), user], { cwd: promptDir, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  signal?.addEventListener("abort", () => child.kill("SIGKILL"));
  child.on("close", (code) => (code === 0 && out.trim() ? resolve(out) : reject(new Error(`pi 종료 ${code}: ${err.slice(0, 200)}`))));
});
const routeModels = (r: Route) => r.map((x) => ({ ref: x.ref, complete: completeVia(x.ref, x.thinking) }));
const fixedModels = ANALYZER === "policy" ? null : [{ ref: ANALYZER, complete: completeVia(ANALYZER, ANALYZER.startsWith("anthropic/") ? "off" : undefined) }];
/** 1단 판정으로 분석기를 고르고, 비밀정보는 가린 텍스트를 보낸다 (07-spec §5.1). */
async function stage2For(text: string, attachments: "image"[]): Promise<Stage2Result & { masked: boolean }> {
  const s1 = runStage1Safe(rules, { text, attachments });
  const route = s1.hard_constraints.data_sensitivity === "internal_only" ? resolvedAnalyzers.internal_only : resolvedAnalyzers.external_ok;
  const m = cfg.analyzer.mask_secrets ? maskSecrets(rules, text) : { text, masked: 0 };
  const r = await runStage2(m.text, tax, fixedModels ?? routeModels(route), TIMEOUT_MS);
  return { ...r, masked: m.masked > 0 };
}

// ---- 분석 → 결정
function analyze(text: string, s2: Stage2Result, attachments: "image"[] = []): { analysis: AnalysisInput; decision: Decision | null; error?: string; sensitiveBy: string[] } {
  const s1 = runStage1Safe(rules, { text, attachments });
  const { analysis, sensitiveBy } = mergeStages(s1, s2);
  try {
    return { analysis, decision: decide(analysis, roster, table, cfg, "balanced"), sensitiveBy };
  } catch (e) {
    return { analysis, decision: null, error: (e as Error).message, sensitiveBy };
  }
}

// ---- 작업 목록
interface Job { kind: "case" | "gold"; id: string; variant: string; rep: number; text: string; attachments?: "image"[] }
const jobs: Job[] = [];
const casesDir = join(ROOT, "bench/cases");
const cases = new Map<string, any>();
if (ONLY !== "gold") for (const id of readdirSync(casesDir).sort()) {
  const c = JSON.parse(readFileSync(join(casesDir, id, "case.json"), "utf8"));
  cases.set(id, c);
  for (let rep = 1; rep <= REPS; rep++) {
    jobs.push({ kind: "case", id, variant: "prompt", rep, text: c.prompt });
    c.rewrites.forEach((t: string, i: number) => jobs.push({ kind: "case", id, variant: `rewrite${i}`, rep, text: t }));
  }
}
const gold = new Map<string, any>();
if (ONLY !== "cases") for (const line of readFileSync(join(ROOT, "bench/analyzer/gold.jsonl"), "utf8").trim().split("\n")) {
  const g = JSON.parse(line);
  gold.set(g.id, g);
  for (let rep = 1; rep <= REPS; rep++) jobs.push({ kind: "gold", id: g.id, variant: "template", rep, text: fillTemplate(g.prompt_template, rep), attachments: g.attachments });
}

// ---- 실행
interface Row { job: Omit<Job, "text">; s2: Omit<Stage2Result, "output"> & { output: Stage2Result["output"] }; analysis: AnalysisInput; decision: Decision | null; error?: string; sensitiveBy: string[] }
const rows: Row[] = [];
let done = 0;
const started = Date.now();
async function worker(queue: Job[]) {
  for (let job = queue.shift(); job; job = queue.shift()) {
    const s2 = await stage2For(job.text, job.attachments ?? []);
    const r = analyze(job.text, s2, job.attachments ?? []);
    const { text: _t, ...jobMeta } = job;
    // 정답 세트는 가짜 민감 값이 들어간 프롬프트라 근거 문장을 저장하지 않는다
    if (job.kind === "gold" && s2.output) s2.output.difficulty_rationale = "";
    rows.push({ job: jobMeta, s2, ...r });
    if (++done % 10 === 0 || done === jobs.length) process.stderr.write(`  ${done}/${jobs.length} (${((Date.now() - started) / 1000).toFixed(0)}s)\n`);
  }
}
if (RESCORE) {
  const saved = new Map<string, Stage2Result>();
  for (const line of readFileSync(RESCORE, "utf8").trim().split("\n")) {
    const r = JSON.parse(line);
    saved.set(`${r.job.kind}|${r.job.id}|${r.job.variant}|${r.job.rep}`, r.s2);
  }
  for (const job of jobs) {
    const s2 = saved.get(`${job.kind}|${job.id}|${job.variant}|${job.rep}`);
    if (!s2) continue;
    const r = analyze(job.text, s2, job.attachments ?? []);
    const { text: _t, ...jobMeta } = job;
    rows.push({ job: jobMeta, s2, ...r });
  }
  process.stderr.write(`다시 채점: ${RESCORE} (${rows.length}건)\n`);
} else {
  process.stderr.write(`분석기 ${MODEL}, 작업 ${jobs.length}건, 동시 ${CONCURRENCY}\n`);
  const queue = [...jobs];
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));
}

// ---- 집계 도우미
const rankOf = (id: string) => roster.tiers.find((t) => t.id === id)!.rank;
const tIdx = (t: string) => THINKING_LADDER.indexOf(t as never);
const pct = (a: number, b: number) => (b === 0 ? "-" : `${((100 * a) / b).toFixed(1)}% (${a}/${b})`);
const quant = (xs: number[], q: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const out: string[] = [];
const P = (s = "") => out.push(s);

const caseRows = rows.filter((r) => r.job.kind === "case");
const goldRows = rows.filter((r) => r.job.kind === "gold");
const ok = (rs: Row[]) => rs.filter((r) => r.s2.status === "ok");

P(`# 라우팅 판단 평가 — ${new Date().toISOString().slice(0, 10)}`);
P();
P(`- 분석기: \`${MODEL}\`, pi CLI 경유, 운영점 balanced, 비밀정보 가림 ${cfg.analyzer.mask_secrets ? "켬" : "끔"}`);
P(`- 작업: 시드 케이스 ${cases.size}건 × 표현 3가지 × 반복 ${REPS} = ${caseRows.length}, 정답 세트 ${goldRows.length}`);
P(`- 비교 기준: 케이스는 **사람 라벨에 같은 결정 규칙을 적용한 결정**이다. 분석기가 라벨을 얼마나 재현하는지를 잰다. 조회표가 prior라서 라벨 결정이 "최적"이라는 뜻은 아니다.`);
P(RESCORE ? `- 다시 채점: \`${RESCORE.split("/").at(-1)}\` (모델 재호출 없음, 현재 규칙·조회표 적용)` : `- 소요: ${((Date.now() - started) / 1000).toFixed(0)}초`);
P();

// 2단 상태
const statusCount = new Map<string, number>();
for (const r of rows) statusCount.set(r.s2.status, (statusCount.get(r.s2.status) ?? 0) + 1);
const primaries = new Set(fixedModels ? [ANALYZER] : [resolvedAnalyzers.external_ok[0]?.ref, resolvedAnalyzers.internal_only[0]?.ref].filter(Boolean));
const usedFallback = rows.filter((r) => r.s2.model && !primaries.has(r.s2.model)).length;
const byModel = new Map<string, number>();
for (const r of rows) if (r.s2.model) byModel.set(r.s2.model, (byModel.get(r.s2.model) ?? 0) + 1);
const lat = ok(rows).map((r) => r.s2.latency_ms);
P(`## 1. 2단 분석기 상태`);
P();
P(`| 항목 | 값 |`);
P(`|---|---|`);
for (const [k, v] of statusCount) P(`| ${k} | ${pct(v, rows.length)} |`);
P(`| 대체 모델 사용 | ${usedFallback}건 |`);
P(`| 분석기별 처리 | ${[...byModel].map(([m, n]) => `${m} ${n}`).join(", ")} |`);
P(`| 비밀정보 가림 | ${rows.filter((r) => (r.s2 as { masked?: boolean }).masked).length}건 |`);
P(`| 지연 p50 / p95 (CLI 시작 포함) | ${quant(lat, 0.5)}ms / ${quant(lat, 0.95)}ms |`);
P(`| 3초 이내 | ${pct(lat.filter((x) => x <= 3000).length, lat.length)} |`);
const parseErrors = rows.filter((r) => r.s2.status === "parse_error").map((r) => `${r.job.id}/${r.job.variant}: ${r.s2.error}`);
if (parseErrors.length) P(`\n형식 오류: ${parseErrors.slice(0, 8).join("; ")}`);
P();

// 2. 케이스: 분석 정확도
P(`## 2. 시드 케이스: 분석 정확도 (라벨 대비)`);
P();
const cOk = ok(caseRows);
const lab = (r: Row) => cases.get(r.job.id);
const eq = (f: (r: Row) => [unknown, unknown]) => cOk.filter((r) => { const [a, b] = f(r); return a === b; }).length;
const within1 = (f: (r: Row) => [number | null, number | null]) => cOk.filter((r) => { const [a, b] = f(r); return a !== null && b !== null && Math.abs(a - b) <= 1; }).length;
const dims = ["difficulty", "ambiguity", "scope", "verifiability"] as const;
P(`| 항목 | 일치 | 차이 ≤ 1 |`);
P(`|---|---|---|`);
P(`| 도메인 | ${pct(eq((r) => [r.analysis.task_type.domain, lab(r).task_type.domain]), cOk.length)} | |`);
P(`| 행위 | ${pct(eq((r) => [r.analysis.task_type.action, lab(r).task_type.action]), cOk.length)} | |`);
for (const d of dims) P(`| ${d} | ${pct(eq((r) => [r.analysis.dimensions[d], lab(r).labels.dimensions[d]]), cOk.length)} | ${pct(within1((r) => [r.analysis.dimensions[d], lab(r).labels.dimensions[d]]), cOk.length)} |`);
P(`| capabilities.reasoning | ${pct(eq((r) => [r.analysis.dimensions.capabilities.reasoning, lab(r).labels.dimensions.capabilities.reasoning]), cOk.length)} | ${pct(within1((r) => [r.analysis.dimensions.capabilities.reasoning, lab(r).labels.dimensions.capabilities.reasoning]), cOk.length)} |`);
P(`| 민감도 오탐 (라벨은 전부 external_ok) | ${pct(cOk.filter((r) => r.analysis.hard_constraints.data_sensitivity === "internal_only").length, cOk.length)} | |`);
P();
// 난이도 편향
const diffBias = cOk.map((r) => (r.analysis.dimensions.difficulty ?? 0) - lab(r).labels.dimensions.difficulty);
P(`난이도 편향(분석기 − 라벨) 평균: ${(diffBias.reduce((a, b) => a + b, 0) / (diffBias.length || 1)).toFixed(2)} (양수 = 과대 평가)`);
P();
// 행위 혼동
const conf = new Map<string, Map<string, number>>();
for (const r of cOk) {
  const want = lab(r).task_type.action;
  const got = r.analysis.task_type.action ?? "null";
  if (want === got) continue;
  const m = conf.get(want) ?? new Map();
  m.set(got, (m.get(got) ?? 0) + 1);
  conf.set(want, m);
}
if (conf.size) {
  P(`행위 오분류 (라벨 → 분석기: 건수):`);
  for (const [want, m] of conf) P(`- ${want} → ${[...m].map(([g, n]) => `${g}: ${n}`).join(", ")}`);
  P();
}

// 3. 케이스: 결정 일치
P(`## 3. 시드 케이스: 결정 (라벨 결정 대비)`);
P();
const dec = cOk.filter((r) => r.decision);
let tierEq = 0, under = 0, over = 0, thinkEq = 0, pairEq = 0, thinkUnder = 0, thinkOver = 0;
const byAction = new Map<string, { n: number; pair: number; under: number; over: number }>();
const mismatches: string[] = [];
for (const r of dec) {
  const h = hypothesisFor(lab(r));
  const d = r.decision!;
  const dr = rankOf(d.tier) - rankOf(h.tier);
  const dt = tIdx(d.thinking) - tIdx(h.thinking);
  if (dr === 0) tierEq++; else if (dr < 0) under++; else over++;
  if (dr === 0 && dt === 0) pairEq++;
  if (d.thinking === h.thinking) thinkEq++;
  if (dr === 0 && dt < 0) thinkUnder++;
  if (dr === 0 && dt > 0) thinkOver++;
  const a = lab(r).task_type.action;
  const s = byAction.get(a) ?? { n: 0, pair: 0, under: 0, over: 0 };
  s.n++;
  if (dr === 0 && dt === 0) s.pair++;
  if (dr < 0) s.under++;
  if (dr > 0) s.over++;
  byAction.set(a, s);
  if (dr !== 0 && r.job.variant === "prompt" && r.job.rep === 1) mismatches.push(`${r.job.id}: 라벨 ${h.tier}:${h.thinking} → 분석 ${d.tier}:${d.thinking} (행위 ${r.analysis.task_type.action}, 난이도 ${r.analysis.dimensions.difficulty}, 신뢰도 ${r.analysis.confidence}${d.adjustments.length ? `, 보정 ${d.adjustments.join("+")}` : ""})`);
}
P(`| 항목 | 값 |`);
P(`|---|---|`);
P(`| 티어 일치 | ${pct(tierEq, dec.length)} |`);
P(`| 과소 배정 (라벨보다 낮은 티어) | ${pct(under, dec.length)} |`);
P(`| 과대 배정 (라벨보다 높은 티어) | ${pct(over, dec.length)} |`);
P(`| (티어, 추론 강도) 모두 일치 | ${pct(pairEq, dec.length)} |`);
P(`| 티어 일치 중 추론 강도 낮음 / 높음 | ${thinkUnder} / ${thinkOver} |`);
P(`| 결정 실패 | ${caseRows.filter((r) => !r.decision).length}건 |`);
const confMatched = dec.filter((r) => hypothesisFor(lab(r), r.analysis.confidence).tier === r.decision!.tier).length;
P(`| 티어 일치 (라벨 결정에 분석기 신뢰도 적용) | ${pct(confMatched, dec.length)} |`);
const crossBand = dec.filter((r) => {
  const a = r.analysis.dimensions.difficulty, b = lab(r).labels.dimensions.difficulty;
  return a !== null && (a <= 1) !== (b <= 1);
}).length;
P(`| 난이도 구간(쉬움/어려움)이 라벨과 다름 | ${pct(crossBand, dec.length)} |`);
P();
P(`| 행위 | n | 쌍 일치 | 과소 | 과대 |`);
P(`|---|---|---|---|---|`);
for (const [a, s] of [...byAction].sort()) P(`| ${a} | ${s.n} | ${pct(s.pair, s.n)} | ${s.under} | ${s.over} |`);
P();
if (mismatches.length) {
  P(`원문(prompt) 기준 티어 불일치:`);
  for (const m of mismatches) P(`- ${m}`);
  P();
}

// 4. 안정성
P(`## 4. 표현 변형 간 안정성`);
P();
let sameTier = 0, samePair = 0, groups = 0;
const unstable: string[] = [];
for (const id of cases.keys()) for (let rep = 1; rep <= REPS; rep++) {
  const g = caseRows.filter((r) => r.job.id === id && r.job.rep === rep && r.decision);
  if (g.length < 3) continue;
  groups++;
  const tiers = new Set(g.map((r) => r.decision!.tier));
  const pairs = new Set(g.map((r) => `${r.decision!.tier}:${r.decision!.thinking}`));
  if (tiers.size === 1) sameTier++;
  if (pairs.size === 1) samePair++;
  else if (rep === 1) unstable.push(`${id}: ${g.map((r) => `${r.job.variant}=${r.decision!.tier}:${r.decision!.thinking}`).join(", ")}`);
}
P(`| 항목 | 값 |`);
P(`|---|---|`);
P(`| 세 표현 모두 같은 티어 | ${pct(sameTier, groups)} |`);
P(`| 세 표현 모두 같은 (티어, 추론 강도) | ${pct(samePair, groups)} |`);
P();
if (unstable.length) {
  P(`흔들린 케이스:`);
  for (const u of unstable) P(`- ${u}`);
  P();
}

// 5. 정답 세트
P(`## 5. 분석기 정답 세트`);
P();
const gOk = ok(goldRows);
const gl = (r: Row) => gold.get(r.job.id).expected;
const hasT = gOk.filter((r) => gl(r).task_type);
const hasD = gOk.filter((r) => gl(r).difficulty !== undefined);
const hasA = gOk.filter((r) => gl(r).ambiguity !== undefined);
const sens = { s1: { tp: 0, fp: 0, fn: 0 }, both: { tp: 0, fp: 0, fn: 0 } };
for (const r of goldRows) {
  const want = gl(r).data_sensitivity === "internal_only";
  const s1 = r.sensitiveBy.includes("stage1");
  const both = r.analysis.hard_constraints.data_sensitivity === "internal_only";
  for (const [k, got] of [["s1", s1], ["both", both]] as const) {
    if (want && got) sens[k].tp++;
    else if (!want && got) sens[k].fp++;
    else if (want && !got) sens[k].fn++;
  }
}
const rec = (c: { tp: number; fn: number }) => pct(c.tp, c.tp + c.fn);
const prec = (c: { tp: number; fp: number }) => pct(c.tp, c.tp + c.fp);
P(`| 항목 | 값 |`);
P(`|---|---|`);
P(`| 행위 일치 | ${pct(hasT.filter((r) => r.analysis.task_type.action === gl(r).task_type.action).length, hasT.length)} |`);
P(`| 도메인 일치 | ${pct(hasT.filter((r) => r.analysis.task_type.domain === gl(r).task_type.domain).length, hasT.length)} |`);
P(`| 난이도 차이 ≤ 1 | ${pct(hasD.filter((r) => r.analysis.dimensions.difficulty !== null && Math.abs((r.analysis.dimensions.difficulty as number) - gl(r).difficulty) <= 1).length, hasD.length)} |`);
P(`| 모호성 3 탐지 (되묻기 대상) | ${pct(hasA.filter((r) => gl(r).ambiguity === 3 && r.analysis.dimensions.ambiguity === 3).length, hasA.filter((r) => gl(r).ambiguity === 3).length)} |`);
P(`| 모호성 3 오탐 | ${pct(hasA.filter((r) => gl(r).ambiguity !== 3 && r.analysis.dimensions.ambiguity === 3).length, hasA.filter((r) => gl(r).ambiguity !== 3).length)} |`);
P(`| 민감도 재현율: 1단만 / 1단+2단 | ${rec(sens.s1)} / ${rec(sens.both)} |`);
P(`| 민감도 정밀도: 1단만 / 1단+2단 | ${prec(sens.s1)} / ${prec(sens.both)} |`);
P(`| 2단이 추가로 잡은 민감 사례 | ${goldRows.filter((r) => r.sensitiveBy.join() === "stage2").map((r) => r.job.id).join(", ") || "없음"} |`);
P();
const gWrong = hasT.filter((r) => r.analysis.task_type.action !== gl(r).task_type.action).map((r) => `${r.job.id}: ${gl(r).task_type.action} → ${r.analysis.task_type.action}`);
if (gWrong.length) P(`행위 불일치: ${gWrong.join("; ")}\n`);

// 결정 분포
P(`## 6. 결정 분포 (시드 케이스, 원문)`);
P();
const dist = new Map<string, [number, number]>();
for (const r of caseRows.filter((r) => r.job.variant === "prompt" && r.job.rep === 1)) {
  const h = hypothesisFor(lab(r));
  const k1 = `${h.tier}`;
  const e = dist.get(k1) ?? [0, 0];
  e[0]++;
  dist.set(k1, e);
  if (r.decision) {
    const e2 = dist.get(r.decision.tier) ?? [0, 0];
    e2[1]++;
    dist.set(r.decision.tier, e2);
  }
}
P(`| 티어 | 라벨 결정 | 분석기 결정 |`);
P(`|---|---|---|`);
for (const t of roster.tiers.map((t) => t.id)) P(`| ${t} | ${dist.get(t)?.[0] ?? 0} | ${dist.get(t)?.[1] ?? 0} |`);

// ---- 저장
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
mkdirSync(join(ROOT, "bench/results/raw"), { recursive: true });
if (!RESCORE) writeFileSync(join(ROOT, `bench/results/raw/routing-eval-${stamp}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
const tag = (RESCORE ? "rescore-" : "") + (ANALYZER === "policy" ? "policy" : ANALYZER.split("/").at(-1));
const mdPath = join(ROOT, `bench/results/routing-eval-${stamp.slice(0, 10)}-${ONLY}-${tag}.md`);
writeFileSync(mdPath, out.join("\n") + "\n");
console.log(out.join("\n"));
process.stderr.write(`\n저장: ${mdPath}\n`);
