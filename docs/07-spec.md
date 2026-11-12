# 07. 스펙 v0.1 — pi 플러그인 `llm-router`

> 01~06 문서의 결정을 구현할 수 있는 형태로 고정한다.
> 데이터 계약은 [`spec/schemas/`](../spec/schemas), 실제 설정과 데이터는 [`config/`](../config)와 [`bench/`](../bench)에 있다.
> "v0.1 범위"로 표시한 것만 첫 구현에 포함한다. 나머지는 자리만 잡아 둔다.

## 1. 범위

| 구분 | v0.1 범위 | 이후 |
|---|---|---|
| 결정 단위 | 태스크(세션) 시작 시 1회. 모드 A(엄격 고정) | 모드 B(하향 1회), C(탐색 후 고정) |
| 분석기 | 규칙(1단) + 로컬 소형 모델(2단) | 유사 사례 검색(v1), IRT형(v2) |
| 결정 규칙 | 조회표 v0 + 필수 제약 + 신뢰도 보정 | 보정된 P(성공) ≥ τ |
| 재실행 | `/router escalate` 명령(사용자 주도) | 검증 실패 시 자동 제안 |
| 기록 | 로컬 JSONL, 원문 미저장 | SQLite, 집계 대시보드 |
| 벤치마크 | 시드 케이스 형식, 케이스 검증기, 실행기 스펙 | 실행기 구현, 조회표 자동 갱신 |

비범위는 01 문서와 같다(턴 단위 라우팅, 역할 분담 멀티 에이전트, 서빙 계층 분산).

## 2. 구성과 파일 배치

```
config/
  roster.json               티어 ↔ 물리 모델, 단가, 데이터 정책     (schema: roster)
  taxonomy.json             도메인 × 행위 정의                      (schema: taxonomy)
  sensitivity-rules.json    데이터 민감도·부작용 규칙               (schema: rules)
  routing-table.v0.json     (행위 × 난이도) → (티어, 추론 강도)   (schema: routing-table)
  llm-router.default.json   플러그인 기본 설정                     (schema: plugin-config)
spec/schemas/*.schema.json  데이터 계약 (JSON Schema draft 2020-12 부분집합)
bench/
  fixtures/<fixture>/       합성 저장소 (태스크 실행 대상)
  cases/<case-id>/          실행형 시드 케이스                      (schema: seed-case)
    case.json
    setup/                  모델에게 주기 전 fixture 위에 덮어쓸 파일
    hidden/                 검증할 때만 넣는 테스트 (모델은 볼 수 없음)
    solution/               기준 해답 (케이스 자체 검증용)
    mutants/                test_write 케이스의 돌연변이 코드
  analyzer/gold.jsonl       분석기 정답 세트                        (schema: analyzer-gold)
scripts/
  validate-data.ts          스키마 + 참조 무결성 검사
  check-cases.ts            케이스 건전성 검사 (기준 실패 → 해답 통과)
  check-rules.ts            민감도 규칙의 정답 세트 정확도 검사
  derive-hypotheses.ts      케이스 예상 (티어, 추론 강도)를 현재 조회표로 재계산
src/
  stage1.ts                 1단 규칙 엔진 (§5.2)
  decide.ts                 결정 규칙 v0 (§6), 순수 함수
  (index.ts 등)             플러그인 런타임 (§7, 다음 단계)
test/                       stage1, decide 단위 테스트 (node:test)
```

## 3. 티어와 후보 (config/roster.json)

| 티어 | 물리 모델 (primary → fallback) | 단가 (USD/MTok, 입력/출력/캐시읽기) | 데이터 정책 | 추론 강도 | 비고 |
|---|---|---|---|---|---|
| `local` | `simflow/ixi-simflow-codeadvisor` → `lgu-axeng/axengdev/qwen/qwen3-coder-next` | 종량 과금 없음 | 내부 | `off`만 | 128K, 출력 16.4K, 텍스트만 |
| `light` | `anthropic/claude-haiku-5-5` | 0.1 / 0.5 / 0.01 (100K 초과 시 0.5 / 2.5 / 0.05) | 외부 벤더 | off, low ~ max | 1M, 이미지 |
| `standard` | `anthropic/claude-sonnet-5-5` | 2 / 10 / 0.1 | 외부 벤더 | low ~ max | 1M, 이미지 |
| `heavy` | `anthropic/claude-opus-5-5` | 4 / 20 / 0.2 | 외부 벤더 | low ~ max | 1M, 이미지 |

- `local`의 기본 모델은 ixi-simflow다. 사용자 평가로 qwen3-coder-next보다 우수하고, 도구 호출을 확인했다(2턴 왕복 1.9초, 2026-11-11). lgu-axeng는 티어 안의 대체 모델이다. 2026-11-11 현재 네트워크에서 503(사이트 차단)을 돌려준다.
- 측정 전용 후보(라우팅 대상 아님): `anthropic/claude-fable-5-2`(8 / 40 / 0.2, 최상위 후보), `lgu-axeng/axengdev/openai/gpt-oss-120b`. 시드 벤치마크에서 독립적 이득이 보이면 티어로 승격한다(06 §5.2).
- 제외한 모델: Anthropic 4.x 세대와 sonnet-5, opus-5. 같은 급의 5.5보다 단가가 같거나 높다(예: opus-5는 5 / 25 / 0.5, opus-5-5는 4 / 20 / 0.2).
- 분석기 모델: `simflow/ixi-simflow-codeadvisor`(기본, local 티어와 겸용), `lgu-axeng/…/gemma-4-e4b`, `…/gemma-4-e2b`(대체). 모두 사내 모델이므로 민감도 판정 전에 호출해도 된다.
- 티어 순서(비용 오름차순): `local < light < standard < heavy`. 상향은 이 순서를 따른다. 단, 민감 태스크는 `local`에서 더 올라가지 않는다(§6.3).
- 추론 강도는 카탈로그의 `thinkingLevelMap` 기준이다(`null` = 미지원). 네 외부 모델 모두 `supportsMidConvoEffort`가 켜져 있다(§13 S6).
- 단가는 pi 카탈로그(1.5.2) 값이다. 실제 비용은 항상 응답의 `usage`로 다시 계산한다.

## 4. 분류 체계 (config/taxonomy.json)

- **도메인 6개**: `backend`, `frontend`, `data`, `infra`, `docs`, `general`
- **행위 10개**: `explain`, `code_modify`, `implement`, `debug`, `refactor`, `test_write`, `review`, `design`, `docs_write`, `data_transform`
- 각 항목에는 자연어 설명, 포함 예, **제외 기준**(인접 항목과 경계)을 둔다. Arch-Router의 한계(설명이 겹치면 임의로 고름)를 피하기 위해서다.
- 행위가 모호하면 도메인만 확정하고 `action: null`로 둔다. 조회표는 `action: "*"` 행으로 처리한다.
- CodeRouterBench 10개 차원과의 대응은 `taxonomy.json`의 `crb_mapping`에 적는다.

## 5. 분석기

### 5.1 처리 순서 (외부 호출 금지 구간 포함)

```
사용자 첫 메시지
 │
 ① 1단 규칙 (결정적, 외부 호출 없음, 목표 < 20ms)
 │   - 민감도: 비밀정보 / 개인정보 / 내부 표식 / 사용자 명시
 │   - 부작용: 배포·마이그레이션·원격 쓰기·삭제 표현
 │   - 필요 능력: 이미지 첨부, 예상 컨텍스트 크기
 │   - 컨텍스트 신호: 쿼리의 경로·심볼로 rg 검색 → 매치 파일 수, 대상 파일 크기
 │
 ② 2단 로컬 분석 (사내 모델: ixi-simflow, 실패 시 gemma, 목표 < 3s)
 │   - 태스크 유형(도메인, 행위), 차원 점수, 난이도 분석 문장, 신뢰도
 │   - 규칙이 "민감 아님"으로 판정했더라도 로컬 모델이 민감 의심을 내면 민감으로 올린다(OR 결합)
 │
 ③ 분석 결과 = analysis (schema: analysis)
```

- 1단과 2단 모두 **외부 벤더 호출을 하지 않는다.** 외부 classifier(Jev 등)는 v0.1에서 쓰지 않는다.
- 2단이 실패하면(시간 초과, 파싱 실패, 서버 불가) 1단 결과만으로 진행한다. 차원은 모두 `null`, `confidence = 0`으로 둔다.
- 1단 민감도 판정 자체가 예외로 실패하면 **민감으로 간주**한다.

### 5.2 1단 규칙 (config/sensitivity-rules.json)

| 그룹 | 예 (패턴 이름) | 결과 |
|---|---|---|
| `secret` | private key 블록, 클라우드 액세스 키 형식, `sk-` 계열 API 키, JWT, `password=` 대입 | `data_sensitivity = internal_only` |
| `pii` | 주민등록번호 형식, 휴대전화 번호 형식, 이메일 주소, 카드번호(Luhn 통과) | `internal_only` |
| `internal_marker` | 사용자 설정 내부 도메인·경로, "대외비", "고객 정보", "confidential" | `internal_only` |
| `user_explicit` | `#local`, "외부로 보내지 마" | `internal_only` |
| `side_effect` | "운영에 배포", "마이그레이션 실행", `git push`, "DB 삭제", `rm -rf` | `irreversible_side_effects = true` |
| `capability` | 이미지 첨부, 컨텍스트 추정 > 100K | `required_capabilities`에 추가 |

- 규칙은 **재현율 우선**이다. 오탐(괜히 로컬로 가는 것)은 비용·품질 손실이고, 미탐은 유출이기 때문이다.
- 목표: 정답 세트 기준 `secret`·`pii` 재현율 1.0, 민감도 정밀도 ≥ 0.8.

### 5.3 2단 출력 계약

로컬 모델에는 JSON만 출력하도록 지시하고, `analysis` 스키마의 `task_type`, `dimensions`, `difficulty_rationale`, `confidence`만 채우게 한다. 필수 제약은 1단이 소유하며, 2단은 민감 의심(`sensitivity_suspected: bool`)만 낸다.

## 6. 결정 규칙 v0

### 6.1 조회표 (config/routing-table.v0.json)

- 키: `(action, difficulty)`.
- 값: 최저 티어, 그 티어의 **추론 강도**, 근거(`prior` | `measured`), 표본 수 n, 관측 성공률.
- 같은 티어 안에서도 난이도에 따라 추론 강도를 다르게 둔다. 예: debug/1 = `light:medium`, debug/2 = `standard:high`.
- 추론 강도는 티어 기본 모델이 지원하는 값이어야 한다. `npm run validate`가 검사한다.
- v0.1 출하 값은 **전부 `prior`(가설)**이다. 시드 벤치마크 측정 후 n ≥ 30인 칸만 `measured`로 바꾼다(06 §5.7).

### 6.2 결정 절차

구현: `src/decide.ts`의 `decide()`(순수 함수, 테스트 `test/decide.test.ts`). 아래는 요약이며, 차이가 있으면 코드가 기준이다.

```
입력: analysis, roster, table, config, operating_point
1. 후보 = roster.tiers
2. 필수 제약 필터
   - internal_only → 후보 = {data_policy == internal}
   - required_capabilities ⊄ 티어 능력 → 제외
   - 예상 컨텍스트 > 티어 컨텍스트 × 0.8 → 제외
3. 기본 티어 = table[(action, difficulty)] (없으면 table[("*", difficulty)], 그것도 없으면 config.default_tier)
4. 보정 (순서대로, 각각 최대 한 단계)
   a. irreversible_side_effects → 기본 티어를 최소 config.side_effect_floor(기본 heavy)로
   b. scope ≥ 3 또는 matched_files > 20 → +1
   c. confidence < config.low_confidence (기본 0.5) → +1
   d. verifiability == 0 이고 difficulty ≤ 1 → −1 (검증 가능하면 싸게 시도, 03 §3.6)
      단, a가 적용됐거나 운영점이 quality면 하지 않는다
5. 후보 중 "목표 티어 이상인 가장 싼 티어" 선택. 티어 안에서는 primary, 쓸 수 없으면 fallback 모델
6. 그런 티어가 없으면 (예: 민감 + heavy 필요)
   → 후보 중 가장 높은 티어를 선택하고 decision.capped = true, 사용자에게 경고
   → 외부 벤더로 대체하지 않는다 (fail-closed, RouteBR)
   → 후보가 하나도 없으면 (예: 민감 + 이미지 입력) 결정 실패. 사용자에게 사유를 알린다
7. 추론 강도 (§6.4)
8. ambiguity == 3 → 라우팅은 하되 decision.ask_user = true (되묻기 안내)
```

### 6.4 추론 강도

추론 강도는 티어와 함께 **태스크마다 정하고, 태스크 동안 고정**한다.

결정 순서 (단계 = `off < minimal < low < medium < high < xhigh < max`):
1. 기본값 = 조회표 칸의 `thinking`. 난이도를 모르면 기본 티어 모델의 `default_thinking`.
2. `capabilities.reasoning ≥ thinking_rules.reasoning_up_at`(기본 3) → +1 (`reasoning_up`)
3. 운영점 보정: economy −1, balanced 0, quality +1 (`operating_point_shift`)
4. 상한 `thinking_rules.max_thinking`(기본 xhigh). `max`는 사용자가 `/router pin`으로만 고를 수 있다.
5. 선택한 모델이 지원하지 않는 값이면 가장 가까운 지원 값으로 맞춘다. 거리가 같으면 높은 쪽을 고른다(`clamped_to_model`). 사내 모델은 항상 `off`(`local_off`).

추가 규칙:
- 티어 보정(§6.2-4)으로 티어가 바뀌어도 추론 강도 이름은 그대로 두고, 5번에서 새 모델에 맞춘다.
- 어느 쪽이 나은지는 측정으로 정한다(§10.3). "티어를 올리는 것"(예: sonnet:high → opus:medium)과 "추론 강도를 올리는 것"(예: sonnet:medium → sonnet:high)이 대상이다.

### 6.3 상향 순서

- 비민감: `local → light → standard → heavy`.
  - `local`이 선택되는 것은 조회표가 `local`을 가리키거나 §6.2-4d로 한 단계 내려왔을 때뿐이다. 종량 과금이 없다고 기본값으로 쓰지 않는다. 지연과 서버 용량 문제가 있기 때문이다.
  - `/router escalate`는 다음 티어로 올리고, 추론 강도는 유지한다(새 모델에 맞춤).
  - `heavy`에서는 추론 강도를 한 단계 올린다(최대 max).
  - `/router escalate --thinking`은 티어를 유지하고 추론 강도만 올린다.
- 민감: `local`에서 상향하지 않는다. 상향을 요청하면 거부 사유를 보여 준다. 티어 안의 대체 모델 전환은 상향이 아니다.

## 7. 런타임 (pi virtual model)

### 7.1 등록

- `provider: "router"`, `id: "auto"`. 선택: `/model router/auto`.
- `thinkingLevels: ["low", "medium", "high"]`. 사용자가 고른 레벨은 물리 모델에 그대로 전달하지 않는다. **운영점**으로 해석한다(`config.virtual_levels`).
  - low = economy, medium = balanced(기본), high = quality
  - 물리 모델의 추론 강도는 §6.4에 따라 태스크마다 라우터가 정한다.
  - 하단 표시줄에는 `auto • medium → claude-sonnet-5-5 • high`처럼 선택과 실제가 함께 보인다.
- `contextWindow: 128_000`(가장 작은 티어 기준, 1차 응답 전 표시용).

### 7.2 상태 (schema: router-state)

```json
{ "v": 1, "task_id": "t_…", "tier": "standard", "model": "anthropic/claude-sonnet-5-5",
  "thinking": "high", "operating_point": "balanced",
  "decided_at": "…", "decision_ref": "d_…", "mode": "A", "pinned_by": "router" }
```

- 사용자가 태스크 도중에 virtual 레벨(운영점)을 바꿔도 현재 태스크의 고정값은 바뀌지 않는다. 다음 태스크부터 적용한다.

- `pinned_by`: `router` | `user`(`/router pin`) | `escalation`.

### 7.3 `route(request)` 처리

| 조건 | 동작 |
|---|---|
| `reason == "direct"` | `config.direct_tier`(기본 `local`, 민감 세션이 아니면 `light`)의 모델. 상태 반환 안 함 |
| `reason == "retry"` 이고 `failed` 있음 | `failed.model` 그대로. 단, 오류가 컨텍스트 초과면 같은 데이터 정책 안에서 더 큰 컨텍스트 티어로 |
| `reason == "continuation"` | `previous.model`과 `previous.thinkingLevel`, 없으면 `state.model`과 `state.thinking` |
| `reason == "user"` 이고 `state` 없음 | **분석 → 결정 → 새 상태 반환** |
| `reason == "user"` 이고 `state` 있음 | `state.model` 유지(같은 태스크로 간주). 새 태스크는 `/router new-task`나 새 세션으로만 시작(06 §5.5 선택지 1) |
| `state.model`이 더 이상 자격 증명 없음 | 같은 티어의 대체 모델, 없으면 한 단계 상위(같은 데이터 정책 안). 결정 로그에 `fallback_reason` |

- `route()`는 예외를 던지지 않는다. 내부 오류는 `config.default_tier`로 처리하고 기록한다. 단, 민감 세션이면 `local`로 처리한다.
- 분석과 결정에 걸리는 시간 상한은 `config.decision_timeout_ms`(기본 4000)이다. 넘으면 1단 결과만으로 결정한다.

### 7.4 명령

| 명령 | 동작 |
|---|---|
| `/router status` | 현재 티어, 모델, 결정 이유, 분석 요약, 누적 비용 |
| `/router pin <tier>[:<thinking>]` | 고정 티어와 추론 강도를 바꾼다. 추론 강도만 바꾸려면 `/router pin :high`. 민감 세션에서 외부 티어는 거부. 하향은 즉시, **상향은 경고 후 확인**(캐시 손실, 06 §2.1) |
| `/router new-task` | 상태를 지워 다음 사용자 메시지에서 다시 분석 |
| `/router escalate [--thinking]` | §6.3의 다음 단계를 정한다. 첫 사용자 메시지 앞에서 fork하고, 그 단계를 고정한 상태로 같은 프롬프트를 다시 보낸다. 작업 트리 변경이 있으면 먼저 확인을 받는다(git stash 또는 체크포인트) |
| `/router feedback good\|bad [메모]` | 결과 라벨 기록 |

## 8. 기록과 프라이버시

- 위치: `~/.pi/agent/llm-router/decisions.jsonl`, `outcomes.jsonl`(로컬 전용, 외부 전송 기능 없음).
- 결정 로그(schema: decision-log)에는 **쿼리 원문, 파일 내용, 매치된 민감 문자열을 저장하지 않는다.**
  - `prompt_hash`: 로컬 비밀 솔트로 만든 HMAC-SHA256(첫 16바이트).
  - 민감도 근거는 **규칙 이름만** 저장한다(예: `pii.phone_kr`). 매치된 값은 저장하지 않는다.
  - `difficulty_rationale`은 로컬 모델이 생성한 문장이라 원문 일부가 들어갈 수 있다. 민감 세션이면 저장하지 않는다.
- 결과 로그(schema: outcome-log)의 암묵 라벨: `escalated`, `user_pinned_up`, `user_pinned_down`, `verify_exit_code`, `tool_error_loop`, `aborted`, `feedback`(06 §5.7).
- 라우팅 결정 자체가 주제를 드러낼 수 있으므로(2610.09981), 로그를 사용자 단위로 집계해 공유하지 않는다.

## 9. 설정 (schema: plugin-config)

```json
{
  "roster": "config/roster.json",
  "taxonomy": "config/taxonomy.json",
  "rules": "config/sensitivity-rules.json",
  "routing_table": "config/routing-table.v0.json",
  "mode": "A",
  "default_tier": "heavy",
  "direct_tier": "light",
  "side_effect_floor": "heavy",
  "low_confidence": 0.5,
  "decision_timeout_ms": 4000,
  "analyzer": { "model": "simflow/ixi-simflow-codeadvisor",
                "fallbacks": ["lgu-axeng/axengdev/google/gemma-4-e4b", "lgu-axeng/axengdev/google/gemma-4-e2b"],
                "timeout_ms": 3000 },
  "virtual_levels": { "low": "economy", "medium": "balanced", "high": "quality" },
  "operating_points": {
    "economy":  { "thinking_shift": -1, "allow_verifiable_down": true,  "tier_shift": 0 },
    "balanced": { "thinking_shift": 0,  "allow_verifiable_down": true,  "tier_shift": 0 },
    "quality":  { "thinking_shift": 1,  "allow_verifiable_down": false, "tier_shift": 0 }
  },
  "thinking_rules": { "reasoning_up_at": 3, "max_thinking": "xhigh" },
  "internal_markers": { "domains": [], "path_prefixes": [], "keywords": [] },
  "log_dir": "~/.pi/agent/llm-router"
}
```

- `default_tier`이 `heavy`인 이유: 분석이 불가능할 때 품질을 우선한다(과대 지불 쪽으로 틀린다, Triage).
- 내부 도메인·경로 목록은 사용자 설정이다. 저장소에는 빈 값만 둔다.

## 10. 시드 벤치마크

### 10.1 케이스 (schema: seed-case)

- 필드: `id`, `fixture`, `task_type`, `prompt`, `rewrites`(의미가 같은 변형 2개), `labels`(사람이 붙인 분석 정답), `verification`, `budget`.
- 실행 절차:
  1. fixture를 임시 디렉터리로 복사한다.
  2. `setup/`을 덮어쓴다.
  3. `git init`과 커밋으로 기준점을 만든다.
  4. 모델을 실행한다.
  5. `hidden/`을 덮어쓴다.
  6. 검증 명령을 실행한다.
- `hidden/`과 `solution/`은 모델 실행 디렉터리에 절대 복사하지 않는다.

### 10.2 검증 유형

| 유형 | 판정 | 쓰는 행위 |
|---|---|---|
| `command` | 명령의 종료 코드가 0이면 통과 | debug, code_modify, implement, refactor, data_transform |
| `mutation` | 모델이 쓴 테스트가 원본에서 통과하고 **모든 돌연변이에서 실패** | test_write |
| `rubric` | 고정 판정 모델이 체크리스트 항목별로 판정. `must` 항목 전부 + 전체 ≥ 임계값 | explain, review, design, docs_write |
| `hybrid` | `command`(형식 검사)와 `rubric`을 모두 통과 | docs_write 일부 |

- 판정 모델은 `anthropic/claude-sonnet-5-5`로 고정하고 thinking은 `low`로 둔다. 라우팅 후보(haiku, opus)와 다른 모델을 써서 자기 평가 편향을 줄인다.
- 루브릭 판정 출력은 항목별 `{id, pass, evidence}`이고, evidence에는 응답 인용을 넣는다.

### 10.3 실행기 (v0.1은 스펙만)

```
pi --mode json --no-session -ne -ns -np -nc --no-mcp \
   --model <physical-model> --thinking <level> "<prompt>"
```

- cwd는 케이스 임시 디렉터리다. 도구는 기본값(read, bash, edit, write)을 쓴다.
- 측정 단위는 **(모델, 추론 강도) 쌍**이다. 전체 격자는 너무 크다(외부 4모델 × 최대 6단계 + 사내 2모델). 그래서 두 단계로 나눔다.
  1. **이웃 측정**: 케이스마다 예상 쌍(`expected_tier_hypothesis`:`expected_thinking_hypothesis`)과 그 이웃을 돌린다. 이웃은 티어 ±1(같은 추론 강도)과 추론 강도 ±1(같은 티어)이다. 사내 티어는 두 모델 모두 `off`.
  2. **확장 측정**: 이웃들의 성공 여부가 갈린 케이스만 더 넓게 돌린다. 예: `max`, 측정 전용 fable-5-2.
- 반복: 케이스 × 쌍 × 3회. 결과가 갈린 (케이스, 쌍)만 5회로 늘린다(DARS 적응형).
- `rewrites`는 반복 중 1회차는 `prompt`, 2·3회차는 `rewrites[0]`, `rewrites[1]`을 쓴다(입력 쪽 변동 측정).
- 기록(schema: run-record): 토큰(비캐시 입력 / 캐시 읽기 / 캐시 쓰기 / 출력), 턴 수, 소요 시간, 비용(roster 단가로 재계산), 검증 결과.
- 예산: `budget.max_turns`(기본 40), `budget.timeout_s`(기본 900). 초과하면 실패로 본다.

### 10.4 지표와 게이트 (06 §5.6)

- 지표:
  - (티어, 추론 강도)별 성공률
  - 같은 비용대에서 "티어 상향"과 "추론 강도 상향" 중 어느 쪽의 성공률 이득이 큰가
  - 성공 1건당 비용(캐시 반영)
  - 턴 수
  - 조회표 정책의 오라클 대비 후회
  - 과소 배정률, 과대 배정률
- 기준선:
  - 항상 heavy
  - 항상 light / 항상 standard (각 티어 기본 추론 강도)
  - 2티어 무작위(비용 맞춤)
  - Best Single
  - 조회표 v0
  - 사후 오라클
- 게이트(행위별):
  - 비용: `light 성공률 > c_light / c_heavy`
  - 신호: 난이도 0~1 대 2~3 케이스 사이에서 light 성공의 우위 확률 p̂ ≥ 0.56

## 11. 분석기 평가 (bench/analyzer/gold.jsonl)

- 실행형 케이스의 `labels`와 별도로, 분석만 평가하는 프롬프트 모음이다. 민감도, 부작용, 모호성, 능력 요구의 경계 사례를 모았다.
- 민감 사례의 프롬프트는 **템플릿**이다(`{{FAKE_PHONE}}` 등). `scripts/check-rules.ts`가 실행 시 가짜 값으로 채운다. 저장소에는 개인정보나 비밀정보 형식의 문자열을 두지 않는다.
- 지표:
  - 필수 제약: 재현율과 정밀도
  - 행위 분류: 정확도
  - 난이도: 정답과의 차이 ≤ 1인 비율
  - 2단 지연: p50, p95

## 12. v0.1 수용 기준

1. `npm run validate`: 모든 설정과 데이터가 스키마를 통과하고 참조가 일치한다. 조회표의 추론 강도는 티어 모델이 지원하는 값이고, 케이스 예상값은 조회표 결과와 같다.
   `npm test`: stage1·decide 단위 테스트가 통과한다.
2. `npm run check:cases`: 모든 `command` / `mutation` 케이스에서 기준 상태는 실패하고, `solution` 적용 후에는 통과한다. 원래 있던 공개 테스트는 양쪽 모두 통과한다.
3. `npm run check:rules`: 민감도 정답 세트에서 `secret`·`pii` 재현율 1.0, 민감도 정밀도 ≥ 0.8.
4. 플러그인: `router/auto` 선택 후 첫 메시지에 결정이 기록되고, 이후 `continuation`과 `retry`에서 모델이 바뀌지 않는다. 민감 프롬프트는 외부 호출 없이 `local`로 고정된다(네트워크 기록으로 확인).

## 13. 미정 사항

| # | 내용 | 결정 시점 |
|---|---|---|
| S1 | `local` 티어가 비민감 태스크의 최저 티어로 실제로 쓸 만한가 (지연, 동시성) | 시드 벤치마크 후 |
| S2 | 모드 B·C 도입 여부 | 시드 벤치마크 후 (Q10) |
| S3 | 같은 세션의 새 태스크 감지 (Q11) | v0.2 |
| S4 | `/router escalate`의 작업 트리 복원 방식 (stash / 체크포인트 / worktree) | 구현 중 |
| S5 | 루브릭 판정 모델의 신뢰도 (사람 판정과 일치율). 판정 모델(sonnet-5-5)이 standard 티어와 같아 자기 평가 편향을 점검해야 한다 | 첫 측정 후 표본 20건 수동 대조 |
| S6 | 태스크 안에서 추론 강도를 바꿀지(같은 모델 유지). 네 외부 모델 모두 `supportsMidConvoEffort`를 지원한다. 캐시 영향은 실측으로 확인한다 | 시드 벤치마크 후 |
| S7 | lgu-axeng 차단(503) 지속 여부. 차단이 계속되면 local 티어의 대체 모델과 gemma 분석기도 쓸 수 없다 | 네트워크 확인 후 |
| S8 | ixi-simflow를 분석기와 local 티어에 함께 쓸 때 분석 지연(p95 < 3s)과 동시 호출 한도 | 2단 분석기 구현 후 |
