# llm-router

pi용 모델 라우터 플러그인. 사용자 쿼리마다 요청을 분석해 **충분히 잘하는 가장 싼 (모델 티어, 추론 강도)** 에 배정한다.

- **쿼리마다 결정한다.** 한 쿼리 안의 도구 루프와 재시도는 그 쿼리의 결정 모델을 유지한다(프롬프트 캐시 보존).
- **판단은 두 단계다.** 1단은 결정적 규칙(민감 데이터, 되돌릴 수 없는 작업, 필요 능력)이고, 2단은 판단 모델이 행위·난이도 등을 매긴다. 판단 모델은 로컬 모델을 설정했으면 로컬 모델, 아니면 쓸 수 있는 Claude 모델에서 자동으로 고른다.
- **로컬 모델은 선택 사항이다.** 설정하지 않으면 Claude 모델만으로 동작한다. 직접 실행하는 모델(내 PC, 개인·공용 서버 등)이 있으면 함께 쓸 수 있다.
- **로컬 전용 데이터는 외부 API로 보내지 않는다.** 개인정보, 기밀 표식, `#local` 표시가 있는 쿼리를 말한다. 로컬 모델이 있으면 로컬로 처리하고, 없으면 차단한다.
- **비밀 값은 어떤 모델에도 보내지 않는다.** 모든 모델 호출에서 비밀 값을 `[[MASKED n 이름]]`으로 가리고, 도구 실행 직전에 원래 값으로 되돌린다.

## 설치

필요: [pi](https://pi.dev) 1.5 이상(1.5.2에서 검증). 외부 npm 의존성은 없다.

### pi 패키지로 설치

```bash
# 전역 설치 (~/.pi/agent/settings.json에 기록)
pi install git:github.com/jaryeongfw/llm-router

# 현재 프로젝트에만 설치 (.pi/settings.json, 프로젝트 신뢰 필요)
pi install -l git:github.com/jaryeongfw/llm-router

# 내려받은 저장소를 경로로 설치 (복사하지 않고 그 경로에서 불러옴)
git clone https://github.com/jaryeongfw/llm-router.git
pi install ./llm-router
```

설치하지 않고 한 번만 써 보려면 `-e`로 불러온다:

```bash
pi -e git:github.com/jaryeongfw/llm-router
pi -e ./llm-router
```

설치 확인과 제거:

```bash
pi list                          # 설치된 패키지
pi --list-models router          # router/auto 가 보이면 정상
pi remove git:github.com/jaryeongfw/llm-router
```

### 설정 (선택)

설정 없이도 동작한다. 로컬 모델을 함께 쓰거나 기본값을 바꾸려면 사용자 설정 파일을 만든다.

#### 로컬 모델 (선택)

로컬 모델은 직접 실행하거나 운영하는 모델이다. 예: Ollama, llama.cpp, vLLM, 개인·공용 서버의 OpenAI 호환 엔드포인트.
pi에 모델로 등록한 뒤(`~/.pi/agent/models.json`, `pi --list-models`로 확인) `local_models`에 적는다.

| | 로컬 모델 없음 (기본) | 로컬 모델 설정 |
|---|---|---|
| 티어 | light < standard < heavy | local < light < standard < heavy |
| 판단 모델 | Claude 자동 선택 (haiku 최신 우선) | 로컬 모델 (실패하거나 늦으면 Claude) |
| 로컬 전용 데이터 (개인정보·기밀 표식·`#local`) | 외부로 보내지 않고 **차단**. 외부로 보내도 되는 내용이면 해당 표현을 빼고 다시 요청한다 | 로컬 모델로만 처리 |
| 비밀 값 (키·토큰·비밀번호) | 모든 모델 호출에서 가림 | 같음 |

#### 사용자 설정 파일

```bash
cp llm-router/config/llm-router.user.example.json ~/.pi/agent/llm-router.json
# 다른 위치를 쓰려면: export LLM_ROUTER_CONFIG=/path/to/llm-router.json
```

```json
{
  "local_models": ["my-provider/my-local-coder", "my-provider/my-local-backup"],
  "analyzer": { "prefer": "local" },
  "internal_markers": { "domains": ["example.internal"], "path_prefixes": [], "keywords": [] }
}
```

| 항목 | 기본값 | 설명 |
|---|---|---|
| `local_models` | `[]` | (선택) local 티어에 넣을 로컬 모델. pi에 등록된 `provider/id`여야 한다(`pi --list-models`로 확인). 앞에서부터 기본 모델이고, 나머지는 대체 모델이다. 도구 호출을 지원해야 한다 |
| `analyzer.prefer` | `"local"` | 외부 전송 가능한 요청의 판단 모델을 먼저 시도할 쪽. `"claude"`로 바꾸면 판단 지연이 줄어든다. 로컬 전용 요청은 항상 local로만 판단한다 |
| `analyzer.model` | `null` | 판단 모델을 직접 지정한다. 쓸 수 없으면 무시한다 |
| `analyzer.claude_auto` | `true` | 쓸 수 있는 Claude 모델 중 판단 모델을 자동 선택한다. haiku 최신 버전을 우선하고, 없으면 가장 싼 Claude 모델을 쓴다 |
| `analyzer.timeout_ms` / `max_tokens` | `12000` / `4096` | 판단 모델 시간 상한과 출력 상한. 추론형 local 모델은 사고 과정이 먼저 나오므로 출력 상한을 넉넉히 둔다 |
| `analyzer.suspicion_without_local` | `"warn"` | 로컬 모델이 없을 때, 규칙에는 안 걸렸는데 판단 모델만 민감 정보를 의심한 경우. `warn`은 막지 않고 쿼리 카드에 경고하고, `confirm`은 보내기 전에 확인을 받고, `block`은 로컬 전용으로 보고 차단한다 |
| `tool_result_policy` | `"warn"` | 도구 결과(파일 읽기, 명령 출력 등)에 개인정보·기밀 표식이 보이고 외부 모델로 보낼 때. `warn`은 경고 알림을 띄우고 쿼리 카드에 남긴다(전송은 막지 않는다). `confirm`은 보내기 전에 확인을 받는다(거부하거나 확인할 화면이 없으면 요청이 끝난다). `off`는 검사하지 않는다 |
| `analyzer.followup_max_chars` | `60` | 이 글자 수 이하의 짧은 요청("응 해줘")은 직전 대화 일부를 판단 모델과 민감도 규칙에 함께 쓴다. 앞 대화가 로컬 전용 데이터면 이번 요청도 로컬로 처리한다. `0`이면 끈다 |
| `pin_scope` | `"query"` | `"query"`는 쿼리마다 다시 결정하고, `"session"`은 세션 첫 쿼리의 결정을 유지한다 |
| `internal_markers` | 빈 목록 | 기밀로 볼 도메인·경로·키워드. 걸리면 로컬 전용 데이터로 본다 |
| `secret_policy.mode` | `"mask"` | `mask`는 모든 호출에서 가리고, `block`은 비밀정보가 보이면 차단한다 |

전체 항목은 `config/llm-router.default.json`과 `spec/schemas/user-config.schema.json`에 있다. 적은 항목만 기본값을 덮어쓴다.

사용자 설정은 스키마로 검사한다. JSON이 깨졌거나 항목 이름·값이 틀리면 플러그인은 그대로 켜지고, 틀린 항목만 버린 채 기본값으로 동작하며, 세션을 시작할 때 무시한 항목과 이유를 알려 준다. (예: `local_modells` 오타 → "알 수 없는 항목". `analyzer` 안의 값 하나가 틀리면 `analyzer` 전체를 무시한다.)

## 실행

```bash
pi --model router/auto            # 시작할 때 선택
pi --model router/auto:high       # 운영점 지정 (아래 표)
```

세션 안에서는 `/model`로 `router/auto`를 고른다. 하단 표시줄에 `auto • medium → claude-sonnet-5-5 • high`처럼 선택한 모델과 실제로 응답한 모델이 함께 보인다.

| router/auto의 추론 레벨 | 운영점 | 의미 |
|---|---|---|
| `low` | economy | 같은 티어에서 추론 강도 한 단계 낮춤 |
| `medium` (기본) | balanced | 조회표 그대로 |
| `high` | quality | 추론 강도 한 단계 높임. 검증 가능하고 쉬운 작업이라도 낮은 티어로 내리지 않음 |

### 어떤 모델을 썼는지 보기

**쿼리 카드**: router/auto로 처리한 쿼리가 끝나면 응답 아래에 카드가 붙는다. 카드는 세션에 저장되지만 모델 입력에는 들어가지 않는다. 펼치면 모델별 내역과 추론 보정이 보인다.

```
◆ router  heavy · claude-opus-5-5 · xhigh  design/hard
  호출 1회 · 입력 3.7K (캐시 2.0K) · 출력 1.5K · $0.040
  판단 local-coder 6.6s
```

- 결정과 다른 모델이 응답했으면(재시도 중 전환 등) 모델별 줄에 `!`로 표시한다.
- 도구 결과에서 민감 정보 규칙이 걸렸으면 `도구 결과 N건에 민감 정보 규칙(pii.email) → 외부 모델로 전송`을 표시한다.
- 판단 모델이 실패해 기본 티어로 갔으면 `판단 실패(형식 오류) → 기본 티어`처럼 경고한다.
- 로컬 모델 없이 판단 모델의 민감 의심을 넘겨 진행했으면 `판단 모델이 민감 정보 의심`을 경고한다.

**상태줄**: 세션 누적 티어별 쿼리 수와 비용이 하단에 보인다. 세션을 다시 열면 카드에서 복원한다.

```
router ▸ local 2 · heavy 1  $0.053
```

**명령**

| 명령 | 동작 |
|---|---|
| `/router` 또는 `/router status` | 마지막 쿼리의 결정과 사용량 (펼친 카드) |
| `/router stats` | 이 세션의 티어별·모델별 막대, 호출 수, 토큰, 비용 |

```
llm-router · 이 세션 라우팅 쿼리 3건 · $0.053

티어별 (router/auto로 처리한 쿼리)
  local     ████████████████  2건   4회    $0
  heavy     ████████░░░░░░░░  1건   1회    $0.053
  추론 강도: off 2 · xhigh 1

모델별 (이 세션의 모든 응답)
  local-coder                ████████████  4회    입력 6.2K    출력 522     $0
  claude-opus-5-5            ███░░░░░░░░░  1회    입력 3.7K    출력 1.5K    $0.053
```

- 티어: `local`(로컬 모델을 설정한 경우) < `light`(haiku-5-5) < `standard`(sonnet-5-5) < `heavy`(opus-5-5). 쓸 수 없는 티어는 건너뛴다.
- 결정 로그: `~/.pi/agent/llm-router/decisions.jsonl`. 쿼리 원문은 남기지 않고 해시와 분석 결과만 남긴다. 소유자만 읽을 수 있고(0600), 5MB를 넘으면 `decisions.1.jsonl`~`.3.jsonl`로 밀어 보관한다.
- 공급자 과부하·속도 제한·5xx·연결 실패로 요청이 실패해 재시도할 때, 같은 티어에 다른 모델(로컬 대체 모델 등)이 있으면 그쪽으로 넘긴다. 컨텍스트 초과나 인증 오류는 같은 모델로 재시도한다.
- 비밀 값 가림은 플러그인이 켜져 있으면 `router/auto`를 고르지 않아도 모든 모델 호출에 적용된다.

### 문제 해결

| 증상 | 원인과 조치 |
|---|---|
| "필수 제약을 만족하는 티어가 없습니다: 로컬 전용 데이터… (걸린 규칙: …)" | 쿼리에 개인정보·기밀 표식·`#local`이 있는데 로컬 모델이 없다. 괄호 안 규칙 이름으로 무엇에 걸렸는지 본다. 외부로 보내도 되는 내용이면 그 표현을 빼고 다시 요청하고, 로컬 모델이 있으면 `local_models`에 지정한다. "개인정보 마스킹 함수", "PII 탐지 정규식"처럼 기능을 만드는 말은 걸리지 않는다 |
| "…local 모델이 필요 능력(long_context_200k) 또는 컨텍스트 크기를 만족하지 않습니다" | 대화가 길어(약 100K 토큰 초과) 로컬 모델로 처리할 수 없다. `/compact`로 줄이거나 새 세션에서 요청한다. 로컬 모델이 긴 컨텍스트를 지원하면 `local_models`에 `{ "ref": …, "context_window": …, "capabilities": ["tool_use", "long_context_200k"] }`로 적는다 |
| (로컬 모델 사용 시) 쿼리마다 첫 응답이 수 초 늦다 | 로컬 판단 모델의 지연이다. `analyzer.prefer: "claude"`로 바꾸면 외부 전송 가능한 요청은 Claude가 판단한다 |
| 판단이 자주 기본값(heavy)으로 간다 | 판단 모델이 실패하거나 시간을 넘긴다. `/router status`에서 판단 모델 상태를 보고, `timeout_ms`·`max_tokens`를 늘린다 |

## 동작 확인

```bash
node scripts/e2e-routing.ts              # 한 세션에 쿼리 4개: 쿼리별 결정과 도구 루프 유지 확인
node scripts/e2e-routing.ts --no-local   # local 없는 환경: Claude 자동 판단, 로컬 전용 쿼리 차단
npm run e2e:secrets                      # 비밀 값이 공급자 요청 본문에 들어가지 않는지 확인 (가짜 값)
npm run e2e:ui                           # 쿼리 카드 저장, 상태줄, /router stats·status 출력 확인
```

실제 모델을 호출하므로 소액의 API 비용이 든다(설계 쿼리 1건이 opus로 간다). 결과는 [docs/08-routing-eval.md §7~8](docs/08-routing-eval.md)에 있다.

## 개발

Node 22.18 이상(TypeScript 타입 제거 실행). 외부 의존성은 없다.

```bash
npm test              # 단위 테스트
npm run validate      # 스키마 + 참조 무결성 + 조회표·케이스 일관성
npm run check:rules   # 민감도 규칙 정확도 (정답 세트)
npm run check:cases   # 시드 케이스 건전성 (기준 실패 → 해답 통과, 돌연변이 제거)
npm run check         # 위 세 가지 전부
npm run derive        # 조회표 변경 후 케이스 예상 (티어, 추론 강도) 재계산
node scripts/eval-routing.ts [--analyzer policy|<모델>] [--rescore bench/results/raw/<파일>]   # 판단 평가
```

| 경로 | 내용 |
|---|---|
| `src/index.ts` | pi 확장 진입점 (`package.json`의 `pi.extensions`) |
| `src/runtime.ts` | `router/auto` virtual model: 쿼리별 결정, 도구 루프 유지, 결정 로그 |
| `src/ui.ts`, `src/report.ts` | 쿼리 카드, 상태줄, `/router status`·`stats` (집계·표시는 순수 함수) |
| `src/config.ts`, `src/models.ts` | 설정 계층(기본값 + 사용자 설정), local 모델·판단 모델 해석, Claude 자동 선택 |
| `src/stage1.ts`, `src/stage2.ts`, `src/analyze.ts`, `src/decide.ts` | 1단 규칙, 2단 판단, 병합, 결정 규칙 |
| `src/secrets.ts`, `src/secret-guard.ts` | 모든 모델 호출의 비밀 값 가림·복원 |
| `config/` | 티어 구성, 분류 체계, 민감도 규칙, 조회표, 기본 설정, 사용자 설정 예시 |
| `spec/schemas/` | 데이터 계약 (JSON Schema) |
| `bench/` | 합성 fixture 4개, 시드 케이스 30건, 판단 정답 세트 47건, 평가 결과 |
| `scripts/` | 검증·평가·종단 간 확인 스크립트 |

## 문서

| 문서 | 내용 |
|---|---|
| [docs/01-problem-and-premise.md](docs/01-problem-and-premise.md) | 문제 정의, 전제, 목표와 비목표 |
| [docs/02-literature-map.md](docs/02-literature-map.md) | 문헌 지도: 라우터가 무엇을 보고 판단하는가 |
| [docs/03-query-analysis-criteria.md](docs/03-query-analysis-criteria.md) | 쿼리 분석 기준: 필수 제약 + 선호 차원 |
| [docs/04-routing-architecture.md](docs/04-routing-architecture.md) | 라우팅 파이프라인, 데이터 스키마, 평가 계획 초안 |
| [docs/05-lessons-and-open-questions.md](docs/05-lessons-and-open-questions.md) | 문헌에서 얻은 교훈, 열린 질문 |
| [docs/06-literature-update-pi-plugin.md](docs/06-literature-update-pi-plugin.md) | 본문 정독, 신규 문헌, pi API 대응, 기존 pi 라우터 |
| [docs/07-spec.md](docs/07-spec.md) | **스펙 v0.1**: 티어, 판단 모델, 결정 규칙, 런타임, 비밀정보, 벤치마크 |
| [docs/08-routing-eval.md](docs/08-routing-eval.md) | 평가: 판단 정확도·안정성·지연, 비밀 값 가림 검증, 쿼리별 분배 검증 |
| [docs/references.md](docs/references.md) | 참고 문헌 |

## 상태

- 동작함: 쿼리별 라우팅, 판단 모델 자동 선택, 로컬 전용 데이터 차단, 비밀 값 가림, 쿼리 카드·상태줄·`/router status`·`stats`, 결정 로그.
- 조회표는 가설값(prior)이다. 고른 티어가 실제로 과제를 성공시키는지는 아직 측정하지 않았다(결과 기준 평가 예정).
- 미구현: `/router pin`·`escalate`·`feedback`, 같은 세션의 새 태스크 감지(스펙 §7.4, §13).
