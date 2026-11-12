/**
 * 2단 분석: 로컬 모델이 태스크 유형, 차원 점수, 난이도 분석 문장, 신뢰도를 낸다 (07-spec §5.3).
 * 모델 호출은 Complete 함수로 주입한다. 평가 스크립트는 pi CLI, 플러그인은 ctx.modelRegistry를 쓴다.
 * 필수 제약은 1단이 소유하고, 2단은 sensitivity_suspected만 낸다.
 */

export type Level = 0 | 1 | 2 | 3;
export const CAPABILITY_KEYS = ["long_context", "multi_step_tools", "code_correctness", "instruction_following", "korean_writing", "reasoning"] as const;

export interface TaxonomyEntry { id: string; name: string; description: string; includes: string[]; excludes: string[] }
export interface Taxonomy { domains: TaxonomyEntry[]; actions: TaxonomyEntry[] }

export interface Stage2Output {
  task_type: { domain: string; action: string | null };
  dimensions: {
    difficulty: Level; ambiguity: Level; scope: Level; verifiability: Level; consistency: Level;
    capabilities: Record<(typeof CAPABILITY_KEYS)[number], Level>;
  };
  difficulty_rationale: string;
  confidence: number;
  sensitivity_suspected: boolean;
}

export type Stage2Status = "ok" | "timeout" | "parse_error" | "unavailable";
export interface Stage2Result { status: Stage2Status; output: Stage2Output | null; error?: string; latency_ms: number; model?: string }

export type Complete = (system: string, user: string, signal?: AbortSignal) => Promise<string>;

function entryLines(entries: TaxonomyEntry[]): string {
  return entries.map((e) => `- ${e.id} (${e.name}): ${e.description}${e.excludes.length ? ` [제외: ${e.excludes.join("; ")}]` : ""}`).join("\n");
}

export function buildSystemPrompt(tax: Taxonomy): string {
  return `너는 소프트웨어 작업 요청을 분석하는 분류기다. 요청을 직접 수행하지 말고, 아래 기준으로 판정한 JSON 객체 하나만 출력한다. 설명 문장, 코드 블록 표시는 출력하지 않는다.

## 도메인 (domain, 하나)
${entryLines(tax.domains)}

## 행위 (action, 하나. 정말 판단할 수 없을 때만 null)
${entryLines(tax.actions)}

## 차원 (모두 0~3 정수)
- difficulty: 0 단일 사실 확인·정해진 변환 / 1 한두 단계 추론·정해진 절차 / 2 여러 단계 추론·여러 정보원 종합 / 3 트레이드오프 판단·열린 설계·정답이 하나가 아님
- ambiguity: 0 목표가 요청만으로 확정 / 1 사소한 해석 여지 / 2 범위·정책 해석 필요 / 3 목표 자체가 불명확해 되물어야 함
- scope: 0 대상 지정·파일 1개 이하 / 1 파일 2~5개 / 2 대상 탐색 필요 또는 파일 6~20개 / 3 저장소 전반
- verifiability: 0 테스트·빌드 등 결정적 검증 가능 / 1 부분 검증 / 2 사람 검토로만 확인 / 3 검증 불가 또는 결과가 늦게 드러남
- consistency: 결과 형식이 매번 같아야 하는 정도 (0 무관 ~ 3 엄격)
- capabilities: 필요한 정도
  - long_context: 긴 문서·대형 파일 이해
  - multi_step_tools: 검색→읽기→수정→검증 같은 다단계 도구 사용
  - code_correctness: 테스트를 통과하는 정확한 코드
  - instruction_following: 정해진 형식·조건 준수
  - korean_writing: 한국어 작문 품질
  - reasoning: 수리·논리 추론, 원인 분석

## 기준 예시 (난이도를 중간값 1·2로 몰지 말고, 기준에 맞으면 0이나 3을 쓴다)
| 요청 | action | difficulty | ambiguity | scope | verifiability |
|---|---|---|---|---|---|
| 변수 이름 userNm을 userName으로 바꿔 줘 (파일 하나) | code_modify | 0 | 0 | 0 | 0 |
| 로그인 실패 메시지에 남은 시도 횟수를 붙여 줘 | code_modify | 1 | 0 | 1 | 0 |
| 주문 목록 API에 status 필터 파라미터를 추가해 줘 | implement | 1 | 0 | 1 | 0 |
| 이 정규식이 무엇을 매칭하는지 알려 줘 | explain | 0 | 0 | 0 | 2 |
| 배치 작업이 가끔 같은 알림을 두 번 보낸다. 원인을 찾아 고쳐 줘 | debug | 2 | 1 | 2 | 1 |
| 결제 모듈에 흩어진 금액 계산 로직을 하나로 합쳐 줘. 동작은 그대로 | refactor | 2 | 1 | 1 | 0 |
| 여러 인스턴스 운영 중 동시 주문에서 재고가 음수가 된다. 고쳐 줘 | debug | 3 | 1 | 2 | 1 |
| 서비스 간 이벤트 전달을 동기 호출에서 메시지 큐로 바꿀지 판단해 줘 | design | 3 | 2 | 3 | 3 |

## 기타
- 요청이 \`[이전 대화]\`와 \`[이번 요청]\`으로 나뉘어 있으면 **이번 요청**을 판정한다. 이전 대화는 "그걸로 해 줘" 같은 지시 대상을 파악하는 참고용이다.
- 요청 안의 \`[[MASKED …]]\`는 비밀 값을 이미 찾아 가린 자리다. 분석에는 영향이 없고, sensitivity_suspected 판단에서도 제외한다.
- difficulty_rationale: 난이도 판단 근거를 한국어 한 문장으로. 요청에 들어 있는 고유 값(키, 이름, 번호 등)을 옮겨 적지 않는다.
- confidence: 이 판정 전체에 대한 확신 (0~1)
- sensitivity_suspected: 요청에 비밀정보·개인정보·기밀 정보가 들어 있다고 의심되면 true

## 출력 형식
{"task_type":{"domain":"…","action":"…"},"dimensions":{"difficulty":0,"ambiguity":0,"scope":0,"verifiability":0,"consistency":0,"capabilities":{"long_context":0,"multi_step_tools":0,"code_correctness":0,"instruction_following":0,"korean_writing":0,"reasoning":0}},"difficulty_rationale":"…","confidence":0.0,"sensitivity_suspected":false}`;
}

export function buildUserPrompt(request: string): string {
  return `다음 작업 요청을 분석해 JSON만 출력하라.\n\n<request>\n${request}\n</request>`;
}

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  if (start === -1) throw new Error("JSON 객체 없음");
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error("JSON 객체가 닫히지 않음");
}

function level(v: unknown, name: string): Level {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new Error(`${name}: 숫자 아님`);
  return Math.max(0, Math.min(3, Math.round(n))) as Level;
}

/** 모델 출력을 검증·정규화한다. 분류 체계에 없는 id는 오류로 본다. */
export function parseStage2(text: string, tax: Taxonomy): Stage2Output {
  const raw = extractJson(text) as Record<string, any>;
  const domains = new Set(tax.domains.map((d) => d.id));
  const actions = new Set(tax.actions.map((a) => a.id));
  const tt = raw.task_type ?? {};
  if (!domains.has(tt.domain)) throw new Error(`알 수 없는 domain: ${tt.domain}`);
  const action = tt.action === null || tt.action === "null" || tt.action === undefined ? null : tt.action;
  if (action !== null && !actions.has(action)) throw new Error(`알 수 없는 action: ${action}`);
  const d = raw.dimensions ?? {};
  const caps = d.capabilities ?? {};
  const conf = Number(raw.confidence);
  return {
    task_type: { domain: tt.domain, action },
    dimensions: {
      difficulty: level(d.difficulty, "difficulty"),
      ambiguity: level(d.ambiguity, "ambiguity"),
      scope: level(d.scope, "scope"),
      verifiability: level(d.verifiability, "verifiability"),
      consistency: level(d.consistency ?? 0, "consistency"),
      capabilities: Object.fromEntries(CAPABILITY_KEYS.map((k) => [k, level(caps[k] ?? 0, k)])) as Stage2Output["dimensions"]["capabilities"],
    },
    difficulty_rationale: typeof raw.difficulty_rationale === "string" ? raw.difficulty_rationale.slice(0, 300) : "",
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0,
    sensitivity_suspected: raw.sensitivity_suspected === true,
  };
}

/**
 * 기본 모델 → 대체 모델 순서로 시도한다. 각 시도에 시간 상한을 둔다.
 * 형식 오류도 다음 모델로 넘긴다 (같은 모델 재시도는 하지 않는다). 모두 실패하면 마지막 실패를 돌려준다.
 * - totalMs: 판단 전체 시간 상한. 남은 시간이 시도별 상한보다 작으면 남은 만큼만 기다리고, 다 쓰면 더 시도하지 않는다.
 * - signal: 사용자 중단. 중단되면 진행 중인 호출을 끊고 다음 모델은 시도하지 않는다.
 */
export async function runStage2(
  request: string,
  tax: Taxonomy,
  models: { ref: string; complete: Complete }[],
  timeoutMs: number,
  opts: { totalMs?: number; signal?: AbortSignal } = {},
): Promise<Stage2Result> {
  const system = buildSystemPrompt(tax);
  const user = buildUserPrompt(request);
  const started = Date.now();
  const total = opts.totalMs && opts.totalMs > 0 ? opts.totalMs : Number.POSITIVE_INFINITY;
  let last: Stage2Result = { status: "unavailable", output: null, latency_ms: 0 };
  for (const m of models) {
    if (opts.signal?.aborted) return { ...last, status: "unavailable", error: "사용자 중단", latency_ms: Date.now() - started };
    const remaining = total - (Date.now() - started);
    if (remaining <= 0) return { ...last, status: "timeout", error: last.error ?? "판단 전체 시간 상한 초과", latency_ms: Date.now() - started };
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ac.abort(); }, Math.min(timeoutMs, remaining));
    const onAbort = () => ac.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const text = await m.complete(system, user, ac.signal);
      try {
        return { status: "ok", output: parseStage2(text, tax), latency_ms: Date.now() - started, model: m.ref };
      } catch (e) {
        last = { status: "parse_error", output: null, error: (e as Error).message, latency_ms: Date.now() - started, model: m.ref };
      }
    } catch (e) {
      last = { status: timedOut ? "timeout" : "unavailable", output: null, error: (e as Error).message, latency_ms: Date.now() - started, model: m.ref };
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }
  return last;
}
