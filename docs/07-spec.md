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
  routing-table.v0.json     (행위 × 난이도 구간) → (티어, 추론 강도)   (schema: routing-table)
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
  eval-routing.ts           라우팅 판단 평가 (2단 실제 호출 또는 저장 결과 다시 채점)
  e2e-secret-guard.ts       비밀 값 가림 종단 간 검증 (실제 pi 실행, 공급자 요청 본문 검사)
src/
  stage1.ts                 1단 규칙 엔진, 비밀정보 가림 (§5.2)
  stage2.ts                 2단 분석기 프롬프트·파싱·대체 모델 (§5.3)
  analyze.ts                1·2단 병합 (§5.1)
  secrets.ts                복원 가능한 비밀 값 가림 (§6.5)
  secret-guard.ts           pi 훅: context 가림, tool_call 복원, 지침 (§6.5)
  index.ts                  pi 확장 진입점
  decide.ts                 결정 규칙 v0 (§6), 순수 함수
  (index.ts 등)             플러그인 런타임 (§7, 다음 단계)
test/                       stage1, stage2, analyze, decide 단위 테스트 (node:test)
```

## 3. 티어와 후보 (config/roster.json)

용어:
- **로컬 모델**: 사용자가 직접 실행하거나 운영하는 모델(내 PC, 개인·공용 서버 등). 선택 사항이며 사용자 설정 `local_models`로 지정한다. 코드에서는 `data_policy: "internal"`이다.
- **외부 모델**: API 공급자의 모델(현재 Anthropic Claude).
- **로컬 전용 데이터**: 외부 모델로 보내지 않을 데이터. 개인정보, 기밀 표식(`internal_markers`, "대외비" 등), 사용자의 `#local` 표시가 해당한다. 코드에서는 `data_sensitivity: "internal_only"`이다.
- **비밀 값**: 키·토큰·비밀번호. 로컬 전용 데이터와 별개로, 어떤 모델에도 보내지 않고 가린다(§6.5).

| 티어 | 물리 모델 (primary → fallback) | 단가 (USD/MTok, 입력/출력/캐시읽기) | 데이터 정책 | 추론 강도 | 비고 |
|---|---|---|---|---|---|
| `local` | 사용자 설정 `local_models` (앞에서부터 primary → fallback) | 종량 과금 없음 | 로컬 | `off` (모델별로 지정 가능) | 선택 사항 |
| `light` | `anthropic/claude-haiku-5-5` | 0.1 / 0.5 / 0.01 (100K 초과 시 0.5 / 2.5 / 0.05) | 외부 벤더 | off, low ~ max | 1M, 이미지 |
| `standard` | `anthropic/claude-sonnet-5-5` | 2 / 10 / 0.1 | 외부 벤더 | low ~ max | 1M, 이미지 |
| `heavy` | `anthropic/claude-opus-5-5` | 4 / 20 / 0.2 | 외부 벤더 | low ~ max | 1M, 이미지 |

- `local` 티어는 저장소 기본 설정에 **자리표시(`local/default`)만** 있다. 런타임이 사용자 설정 `local_models` 중 지금 쓸 수 있는 모델로 바꾼다.
  - 목록이 비었거나 모두 쓸 수 없으면 local 티어는 비어 있다.
  - 그러면 로컬 전용 데이터(개인정보·기밀 표식)가 든 요청은 배정할 티어가 없어 차단된다(§6.2-6).
- local 모델은 도구 호출을 지원해야 한다. 추론형 모델(사고 과정을 먼저 출력)이면 `analyzer.max_tokens`를 넉넉히 둔다(08 §8).
- 측정 전용 후보(라우팅 대상 아님): `anthropic/claude-fable-5-2`(8 / 40 / 0.2, 최상위 후보). 시드 벤치마크에서 독립적 이득이 보이면 티어로 승격한다(06 §5.2).
- 제외한 모델: Anthropic 4.x 세대와 sonnet-5, opus-5. 같은 급의 5.5보다 단가가 같거나 높다(예: opus-5는 5 / 25 / 0.5, opus-5-5는 4 / 20 / 0.2).
- 판단 모델(2단 분석기)은 §5.1의 순서로 자동 선택한다. 기본은 local 모델이다.
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
 │   - 필요 능력: 이미지 첨부, 예상 컨텍스트 크기 (대화 전체를 문자 수로 추정: src/runtime.ts estimateTokens)
 │   - 컨텍스트 신호: 쿼리의 경로·심볼로 rg 검색 → 매치 파일 수, 대상 파일 크기
 │
 ② 2단 분석 (목표 < 3s). 분석기는 1단 민감도 판정으로 고른다
 │   - external_ok   → [analyzer.model] → local 모델들 → Claude 자동 선택 (analyzer.prefer = "claude"면 Claude 먼저)
 │   - internal_only → [analyzer.model이 local이면] → local 모델들만. 없으면 2단을 건너뛴다
 │   - 비밀정보는 [[MASKED 이름]]으로 가린 텍스트를 보낸다 (로컬 모델 서버가 비밀정보 요청을 거부할 수 있다)
 │   - 출력: 태스크 유형(도메인, 행위), 차원 점수, 난이도 분석 문장, 신뢰도
 │   - 2단이 민감 의심을 내면 민감으로 올린다(OR 결합). 단, 비밀정보를 이미 가린 요청이면 반영하지 않는다(src/analyze.ts)
 │   - local 모델이 없으면 2단 의심만으로는 막지 않고 쿼리 카드에 경고한다(analyzer.suspicion_without_local: "warn").
 │     외부 판단 모델이 의심을 냈다면 요청은 이미 외부로 나갔고, 막아도 보호 효과 없이 작업만 멈추기 때문이다. "block"이면 이전처럼 차단한다
 │
 ③ 분석 결과 = analysis (schema: analysis)
```

- 1단은 외부 호출을 하지 않는다. **2단은 1단이 internal_only로 판정한 요청을 외부 모델에 보내지 않는다.** 외부 classifier(Jev 등)는 v0.1에서 쓰지 않는다.
- **Claude 자동 선택** (`analyzer.claude_auto`, `src/models.ts` `pickClaudeAnalyzer`)
  - 쓸 수 있는(자격 증명이 있는) 모델 중 haiku 계열 최신 버전을 고른다. 날짜 없는 별칭과 `anthropic` 공급자를 우선한다.
  - haiku가 없으면 입력 단가가 가장 싼 Claude 모델을 고른다. thinking은 off다.
- 판단 모델이 시간 상한(`analyzer.timeout_ms`, 기본 12초)을 넘거나, 호출에 실패하거나, 형식이 맞지 않으면 다음 후보로 넘어간다. 본문 없이 출력 상한에 걸린 응답도 실패로 본다. 같은 모델로 다시 시도하지는 않는다.
- 지연 참고(08 §6, §8): local 판단 모델은 2단 한 번에 수 초(측정한 로컬 모델 p50 약 6~7초)가 걸렸다. Claude haiku는 약 1.5~2초였다. **판단은 쿼리마다 한 번** 일어나므로 이 지연이 쿼리마다 첫 응답 앞에 붙는다. 지연이 중요하면 `analyzer.prefer: "claude"`로 바꾼다.
- 2단이 실패하면(시간 초과, 파싱 실패, 서버 불가) 1단 결과만으로 진행한다. 차원은 모두 `null`, `confidence = 0`으로 둔다.
- 1단 민감도 판정 자체가 예외로 실패하면 **민감으로 간주**한다.

### 5.2 1단 규칙 (config/sensitivity-rules.json)

| 그룹 | 예 (패턴 이름) | 결과 |
|---|---|---|
| `secret` | private key 블록, 클라우드 액세스 키 형식, `sk-` 계열 API 키, JWT, `password=` 대입, 접속 문자열 | `secret_present = true` → §6.5 비밀정보 정책 |
| `pii` | 주민등록번호 형식, 휴대전화 번호 형식, 이메일 주소, 카드번호(Luhn 통과) | `internal_only` |
| `internal_marker` | 사용자 설정 내부 도메인·경로, "대외비", "고객 정보", "confidential" | `internal_only` |
| `user_explicit` | `#local`, "외부로 보내지 마" | `internal_only` |
| `side_effect` | "운영에 배포", "마이그레이션 실행", `git push`, "DB 삭제", `rm -rf` | `irreversible_side_effects = true` |
| `capability` | 이미지 첨부, 컨텍스트 추정 > 100K | `required_capabilities`에 추가 |

- secret 규칙을 먼저 원문에 적용한다. 나머지 규칙은 **비밀 값을 가린 텍스트**에 적용한다. 접속 문자열 `user:pw@host`가 이메일 규칙에 다시 걸려 잘못 차단되는 것을 막기 위해서다.
- 규칙은 **재현율 우선**이다. 오탐(괜히 로컬로 가는 것)은 비용·품질 손실이고, 미탐은 유출이기 때문이다. 다만 local 모델이 없으면 오탐은 차단이므로, 분명한 오탐 유형은 매치 단위 예외로 뺀다.
  - `word_boundary`: 영문 키워드는 식별자 안(`isConfidential`, `PII_FIELD`)에서 매치하지 않는다.
  - `unless_followed_by`: 데이터 종류를 가리키는 말(`internal_marker.data_terms`: 개인정보·고객 정보·PII 등) 뒤에 "마스킹 함수", "탐지 정규식", "보호법" 같은 기능·주제어가 오면 제외한다. "개인정보 마스킹해 줘: …"처럼 처리를 요청하는 말은 그대로 잡는다. "대외비" 같은 표식에는 예외가 없다. 붙여 넣은 실제 값은 `pii` 규칙이 따로 잡는다.
  - `side_effect` 규칙은 부정 표현("git push는 하지 말고", "do not git push")을 제외한다. 다른 실행 요청은 따로 잡는다("push는 하지 말고 운영 배포해 줘" → deploy).
  - 차단 메시지에는 걸린 규칙 이름(값 아님)을 붙여 사용자가 표현을 고칠 수 있게 한다.
- 목표: 정답 세트 기준 `secret`·`pii` 재현율 1.0, 민감도 정밀도 ≥ 0.8.

### 5.3 2단 출력 계약

판단 모델에는 JSON만 출력하도록 지시하고, `analysis` 스키마의 `task_type`, `dimensions`, `difficulty_rationale`, `confidence`만 채우게 한다. 필수 제약은 1단이 소유하며, 2단은 민감 의심(`sensitivity_suspected: bool`)만 낸다.

## 6. 결정 규칙 v0

### 6.1 조회표 (config/routing-table.v0.json)

- 키: `(action, band)`. **band는 난이도 구간이다: easy = 0~1, hard = 2~3** (08 §4 A1).
  - 분석기 난이도는 거의 항상 라벨과 ±1 이내였다(98.9%). 그런데 4단계를 그대로 키로 쓰면 그 1이 티어 차이로 커졌다.
- 값: 최저 티어, 그 티어의 **추론 강도**, 근거(`prior` | `measured`), 표본 수 n, 관측 성공률.
- 세부 난이도(0~3)는 추론 강도에만 쓴다. 구간 상단(1 또는 3)이면 +1이다(§6.4).
  - 예: debug/hard에서 난이도 2는 `standard:high`, 3은 `standard:xhigh`.
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
   - secret_present: mode=heavy면 후보 = {secret_policy.tier}, mode=block이면 결정 실패, mode=mask(기본)면 영향 없음 (§6.5)
3. 기본 티어 = table[(action, band)] (없으면 table[("*", band)], 난이도를 모르면 config.default_tier)
4. 보정 (순서대로, 각각 최대 한 단계)
   a. irreversible_side_effects → 기본 티어를 최소 config.side_effect_floor(기본 heavy)로
   b. scope ≥ 3 또는 matched_files > 20 → +1
   c. confidence < config.low_confidence (기본 0.5) → +1
   d. verifiability == 0 이고 difficulty == 0 → −1 (검증 가능하면 싸게 시도, 03 §3.6)
      단, a가 적용됐거나 운영점이 quality면 하지 않는다
      조건은 config.verifiable_down으로 조정한다. 난이도 1까지 넓히거나 신뢰도 조건을 붙이면
      그 경계에서 결정이 흔들렸다(08 §6: 티어 일치 62~66% 대 74%, 안정성 77% 대 83%)
5. 후보 중 "목표 티어 이상인 가장 싼 티어" 선택. 티어 안에서는 primary, 쓸 수 없으면 fallback 모델
6. 그런 티어가 없으면 (예: 민감 + heavy 필요)
   → 후보 중 가장 높은 티어를 선택하고 decision.capped = true, 사용자에게 경고
   → 외부 벤더로 대체하지 않는다 (fail-closed, RouteBR)
   → 후보가 하나도 없으면 (예: 민감 + 이미지 입력) 결정 실패. 사용자에게 사유를 알린다
7. 추론 강도 (§6.4)
8. ambiguity == 3 → 라우팅은 하되 decision.ask_user = true (되묻기 안내)
```

### 6.3 상향 순서

- 비민감: `local → light → standard → heavy`.
  - `local`이 선택되는 것은 조회표가 `local`을 가리키거나 §6.2-4d로 한 단계 내려왔을 때뿐이다. 종량 과금이 없다고 기본값으로 쓰지 않는다. 지연과 서버 용량 문제가 있기 때문이다.
  - `/router escalate`는 다음 티어로 올리고, 추론 강도는 유지한다(새 모델에 맞춤).
  - `heavy`에서는 추론 강도를 한 단계 올린다(최대 max).
  - `/router escalate --thinking`은 티어를 유지하고 추론 강도만 올린다.
- 민감: `local`에서 상향하지 않는다. 상향을 요청하면 거부 사유를 보여 준다. 티어 안의 대체 모델 전환은 상향이 아니다.

### 6.4 추론 강도

추론 강도는 티어와 함께 **태스크마다 정하고, 태스크 동안 고정**한다.

결정 순서 (단계 = `off < minimal < low < medium < high < xhigh < max`):
1. 기본값 = 조회표 칸의 `thinking`. 난이도를 모르면 기본 티어 모델의 `default_thinking`.
2. 난이도가 구간 상단(easy의 1, hard의 3)이면 +1 (`difficulty_up`)
3. `capabilities.reasoning ≥ thinking_rules.reasoning_up_at`(기본 3) → +1 (`reasoning_up`)
4. 운영점 보정: economy −1, balanced 0, quality +1 (`operating_point_shift`)
5. 상한 `thinking_rules.max_thinking`(기본 xhigh). `max`는 사용자가 `/router pin`으로만 고를 수 있다.
6. 선택한 모델이 지원하지 않는 값이면 가장 가까운 지원 값으로 맞춘다. 거리가 같으면 높은 쪽을 고른다(`clamped_to_model`). 로컬 모델은 항상 `off`(`local_off`).

추가 규칙:
- 티어 보정(§6.2-4)으로 티어가 바뀌어도 추론 강도 이름은 그대로 두고, 6번에서 새 모델에 맞춘다.
- 어느 쪽이 나은지는 측정으로 정한다(§10.3). "티어를 올리는 것"(예: sonnet:high → opus:medium)과 "추론 강도를 올리는 것"(예: sonnet:medium → sonnet:high)이 대상이다.

### 6.5 비밀정보 정책

측정에 쓴 로컬 모델 서버는 비밀정보 형식이 든 요청을 403으로 거부했다(08 §3.2). 비밀 값은 로컬이든 외부든 모델이 알 필요가 없으므로, **비밀 값을 어떤 모델에도 보내지 않는다**(2026-11-12 결정, 08 §7).

**구현** (`src/secrets.ts`, `src/secret-guard.ts`, `src/index.ts`)

| pi 이벤트 | 동작 |
|---|---|
| `context` | 모델 호출 직전마다 메시지 사본의 비밀 값을 `[[MASKED n 이름]]`으로 바꾼다. 대상은 사용자 메시지, 도구 결과, 어시스턴트 텍스트, 도구 호출 인자다. 세션 파일의 원본은 그대로 둔다 |
| `tool_call` | 도구 인자의 자리표시를 실제 값으로 되돌린 뒤 실행한다. 모르는 번호면 실행을 막는다 |
| `before_agent_start` | 자리표시를 도구 인자에 그대로 쓰면 된다는 지침을 넣는다. 이 지침이 없으면 모델이 작업을 멈췄다 |

- 원래 값과 자리표시의 대응은 세션별 메모리에만 둔다. 같은 값은 같은 번호를 받는다(프롬프트 캐시 유지).
- 가림 범위:
  - 규칙에 이름 있는 그룹 `v`/`w`가 있으면 값만 가린다. 비밀번호 대입, 접속 문자열의 비밀번호가 해당된다.
  - 개인 키는 블록 전체를 가린다.
- 바꾸지 않는 것: thinking 블록(서명), 서명된 어시스턴트 텍스트, 이미지, 시스템 프롬프트(§13 S12).
- 2단 분석기 입력도 가린다(번호 없는 `[[MASKED 이름]]`, 복원 불필요).
- 할 수 없는 작업: 모델이 값의 내용을 직접 봐야 하는 작업. 예: 토큰 디코딩.

**결정 규칙의 동작** (`config.secret_policy.mode`)

| mode | 동작 |
|---|---|
| `mask` (기본) | 티어에 영향 없음. 위 가림으로 처리 |
| `heavy` | `secret_policy.tier`만 후보. 원문을 그 모델에 보낸다고 가정한다. 가림 훅을 끈 환경용 |
| `block` | 결정하지 않고 사용자에게 비밀정보를 지우라고 알린다 |

**검증** (`node scripts/e2e-secret-guard.ts`, 08 §7)
- Claude haiku와 local 모델 모두 `.env` 읽기, 값을 써야 하는 명령 실행, 파일 수정에서 공급자 요청 본문에 비밀 값이 0회 들어갔다.
- 가림 없는 대조군에서는 유출이 검출됐다.

### 6.6 도구 결과의 개인정보·기밀 표식 (정책: 경고)

쿼리 텍스트는 1단 규칙이 검사하지만, 같은 쿼리의 도구 루프에서 읽은 파일·명령 출력에 개인정보가 섞여 들어올 수 있다. 이 경우 요청은 이미 진행 중이고 대화 기록 전체가 외부 모델로 나간다.
- 정책은 **경고**다(`tool_result_policy: "warn"`, 기본). 막거나 값을 가리지 않는다. 코드 예시의 이메일처럼 오탐이 흔하고, 가리면 작업이 깨지기 때문이다. `"off"`면 검사하지 않는다.
- `route()`가 요청마다 새 도구 결과(`role: toolResult`의 텍스트)에 `pii`·`internal_marker` 규칙을 적용한다. 비밀 값은 §6.5 훅이 맡으므로 보지 않는다.
- 라우팅된 모델이 `local_models`가 아닐 때만 `ctx.ui.notify`로 경고한다. 로컬 모델로 갈 때는 경고를 미루고, 나중에 외부 모델로 바뀌면 그때 경고한다(기록이 함께 나가므로).
- 같은 도구 결과(`toolCallId`)는 한 번만 경고한다. 결정 로그에는 `kind: "tool_result_warning"`으로 도구 이름과 규칙 id만 남기고 값은 남기지 않는다. 쿼리 카드에 건수와 규칙이 표시된다.
- `"confirm"`: 보내기 전에 `ctx.ui.confirm`으로 묻는다. 허용하면 진행(로그에 `confirmed`), 거부하거나 `hasUI`가 없으면 `route()`가 던져 요청이 끝난다. 거부한 도구 결과는 다음 요청에서 다시 묻는다. `analyzer.suspicion_without_local: "confirm"`도 같은 방식이다.
- 한계: `warn`은 전송 직전이라 사용자가 중단하지 않으면 그대로 나간다.
- **후속 요청** (`analyzer.followup_max_chars`): 짧은 요청은 직전 사용자 메시지 2개(각 300자)와 직전 어시스턴트 답변 끝 400자를 `[이전 대화]`로 붙여 판단 모델에 보내고, 1단 규칙도 이 텍스트 전체에 적용한다.
- **재시도 전환**: `reason: "retry"`에서 오류가 공급자 일시 장애(`isProviderFault`)면 같은 티어의 다른 모델로 넘긴다(캐시 포기, 데이터 정책 동일). 컨텍스트 초과는 제외한다.

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
{ "v": 1, "task_id": "t_…", "query_id": "q_…", "scope": "query", "tier": "standard", "model": "anthropic/claude-sonnet-5-5",
  "thinking": "high", "operating_point": "balanced",
  "decided_at": "…", "decision_ref": "d_…", "mode": "A", "pinned_by": "router" }
```

- 결정 단위는 **사용자 쿼리**다(`pin_scope: "query"`, 기본). 쿼리 안의 도구 루프와 재시도는 그 쿼리의 결정을 유지한다. `pin_scope: "session"`이면 세션 첫 쿼리의 결정을 끝까지 유지한다.
- 사용자가 virtual 레벨(운영점)을 바꾸면 다음 쿼리부터 적용된다.

- `pinned_by`: `router` | `user`(`/router pin`) | `escalation`.

### 7.3 `route(request)` 처리

| 조건 | 동작 |
|---|---|
| `reason == "direct"` | `config.direct_tier`(기본 `local`, 민감 세션이 아니면 `light`)의 모델. 상태 반환 안 함 |
| `reason == "retry"` 이고 `failed` 있음 | `failed.model` 그대로. 단, 오류가 컨텍스트 초과면 같은 데이터 정책 안에서 더 큰 컨텍스트 티어로 |
| `reason == "continuation"` | `previous.model`과 `previous.thinkingLevel`, 없으면 `state.model`과 `state.thinking` |
| `reason == "user"` **쿼리마다 분석 → 결정 → 새 상태 반환** (2026-11-12 변경). 단, `pin_scope: "session"`이거나 사용자가 고정(`pinned_by != router`)했으면 `state.model` 유지. **고정 중이라도 1단 규칙은 쿼리마다 검사**하고, 로컬 전용 데이터인데 고정 모델이 local이 아니면 그 쿼리는 다시 결정한다 |
| `state.model`이 더 이상 자격 증명 없음 | 같은 티어의 대체 모델, 없으면 한 단계 상위(같은 데이터 정책 안). 결정 로그에 `fallback_reason` |

- 필수 제약을 만족하는 티어가 없으면 `route()`가 사유를 담아 예외를 던진다. 그러면 그 요청은 오류 응답으로 끝난다(fail-closed). 예: 로컬 전용 데이터가 있는데 local 모델이 없는 경우.
- 2단이 실패하면 1단 결과만으로 결정한다. 이때 난이도를 모르므로 기본 티어(heavy)가 된다.
- 쿼리별 분배의 실제 동작은 `node scripts/e2e-routing.ts [--no-local]`로 확인한다(08 §8).

### 7.4 명령

| 명령 | 동작 |
|---|---|
| `/router status` | 마지막 쿼리의 티어, 모델, 추론 강도, 조회표 칸과 보정, 판단 모델과 지연, 사용량 (구현됨) |
| `/router stats` | 세션의 티어별·모델별 막대, 호출 수, 토큰(캐시 포함), 비용 (구현됨) |
| `/router pin <tier>[:<thinking>]` | 고정 티어와 추론 강도를 바꾼다. 추론 강도만 바꾸려면 `/router pin :high`. 민감 세션에서 외부 티어는 거부. 하향은 즉시, **상향은 경고 후 확인**(캐시 손실, 06 §2.1) |
| `/router new-task` | 상태를 지워 다음 사용자 메시지에서 다시 분석 |
| `/router escalate [--thinking]` | §6.3의 다음 단계를 정한다. 첫 사용자 메시지 앞에서 fork하고, 그 단계를 고정한 상태로 같은 프롬프트를 다시 보낸다. 작업 트리 변경이 있으면 먼저 확인을 받는다(git stash 또는 체크포인트) |
| `/router feedback good\|bad [메모]` | 결과 라벨 기록 |

### 7.5 화면 (src/ui.ts, src/report.ts)

- **쿼리 카드**: `agent_settled`에서 router/auto 쿼리의 결정과 그 쿼리 응답들의 사용량을 `llm-router-query` 항목(`pi.appendEntry`)으로 남긴다. `registerEntryRenderer`로 대화 안에 그린다. 모델 입력에는 들어가지 않는다. 쿼리 원문은 담지 않는다.
  - 새 결정이 없는 쿼리에는 카드를 남기지 않는다. 예외는 세션 고정(`pin_scope: session`)일 때로, 이때는 "이전 결정 유지" 카드를 남긴다.
- **상태줄**: `ctx.ui.setStatus("llm-router", …)`로 세션 누적 티어별 쿼리 수와 비용을 보인다. `session_start`에서 카드로 복원한다.
- 입력 토큰은 비캐시 입력 + 캐시 읽기 + 캐시 쓰기 합계다. Anthropic은 첫 호출의 입력 대부분을 캐시 쓰기로 집계한다.
- 검증: `npm run e2e:ui` (RPC 세션에서 카드 저장, 카드 모델 = 실제 응답 모델, 상태줄, 명령 출력).

## 8. 기록과 프라이버시

- 위치: `~/.pi/agent/llm-router/decisions.jsonl`, `outcomes.jsonl`(로컬 전용, 외부 전송 기능 없음).
- `decisions.jsonl`의 각 줄은 `kind: "decision"`(쿼리 결정) 또는 `kind: "tool_result_warning"`(§6.6) 기록이며, 둘 다 `decision-log` 스키마를 따른다. 테스트(`test/runtime.test.ts`)가 실제 기록을 스키마로 검사한다.
- 결정 로그(schema: decision-log)에는 **쿼리 원문, 파일 내용, 매치된 민감 문자열을 저장하지 않는다.**
  - `prompt_hash`: 로컬 비밀 솔트로 만든 HMAC-SHA256(첫 16바이트).
  - 파일은 0600, 디렉터리는 0700이다. 5MB를 넘으면 `decisions.{1..3}.jsonl`로 민다.
  - 디버그 출력(`LLM_ROUTER_DEBUG_STAGE2`)은 비밀 값을 가리고, 개인정보·기밀 표식이 보이면 본문을 생략한다(0600).
  - 민감도 근거는 **규칙 이름만** 저장한다(예: `pii.phone_kr`). 매치된 값은 저장하지 않는다.
  - `difficulty_rationale`은 판단 모델이 생성한 문장이라 원문 일부가 들어갈 수 있다. 민감 세션이면 저장하지 않는다.
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
  "pin_scope": "query",
  "local_models": [],
  "analyzer": { "prefer": "local", "model": null, "claude_auto": true, "timeout_ms": 12000, "max_tokens": 4096, "mask_secrets": true },
  "secret_policy": { "mode": "mask", "tier": "heavy" },
  "verifiable_down": { "max_difficulty": 0, "confident_max_difficulty": 0, "min_confidence": 1 },
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
- 측정 단위는 **(모델, 추론 강도) 쌍**이다. 전체 격자는 너무 크다(외부 4모델 × 최대 6단계 + 로컬 모델). 그래서 두 단계로 나눈다.
  1. **이웃 측정**: 케이스마다 예상 쌍(`expected_tier_hypothesis`:`expected_thinking_hypothesis`)과 그 이웃을 돌린다. 이웃은 티어 ±1(같은 추론 강도)과 추론 강도 ±1(같은 티어)이다. local 티어 모델은 `off`.
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
| S7 | local 모델 서버가 막히거나 느릴 때의 동작 → 판단 모델은 Claude로 넘어가고, local 티어는 대체 모델 → 다음 티어 순으로 처리 | 구현됨 |
| S8 | local 판단 모델의 지연이 쿼리마다 붙는다(측정한 로컬 모델 p50 6~7초, 시간 초과 시 Claude로 넘어감). 기본은 local(사용자 결정), 지연이 중요하면 `prefer: "claude"` | 운영 중 판단 |
| S9 | ~~비밀정보 원문을 외부 벤더로 보내도 되는가~~ → 보내지 않는다. 모든 호출에서 가림(§6.5) | 해결 |
| S12 | 시스템 프롬프트(AGENTS.md 등)의 비밀 값은 가리지 않는다. `context_with_system`으로 확장할지 | 런타임 구현 시 |
| S13 | 가림 규칙이 못 잡는 비밀 형식(자체 형식 토큰 등)은 그대로 나간다. 사용자 정의 패턴(config) 추가 | 운영 전 |
| S10 | 로컬 모델 호출 시 403·503은 재시도하지 않기. pi의 에이전트 수준 재시도(기본 3회)가 실패를 30초로 늘렸다. 플러그인은 `ctx.modelRegistry`로 직접 호출하므로 재시도 동작을 따로 확인한다 | 런타임 구현 시 |
| S11 | 난이도 구간 경계(1↔2) 혼동이 여전히 결정 차이의 주원인(구간 불일치 20%) | 결과 기준 평가 후 |
