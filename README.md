# llm-router

태스크(쿼리)를 분석해 **충분히 잘하는 가장 싼 (모델 티어, 추론 강도)** 에 배정하는 pi 플러그인을 설계·구현하는 프로젝트.

- 한 태스크는 처음부터 끝까지 한 모델과 한 추론 강도로 처리한다 (session-pinned routing).
- 라우터는 태스크 시작 전에 쿼리와 값싼 컨텍스트 신호만으로 판단한다.
- 모델 쪽 역량과 쿼리 쪽 요구를 **같은 차원(평가 차원)** 으로 표현해, 측정 결과가 곧 라우팅 근거가 되게 한다.

## 문서

| 문서 | 내용 |
|---|---|
| [docs/01-problem-and-premise.md](docs/01-problem-and-premise.md) | 문제 정의, 세션 고정 전제, 목표와 비목표 |
| [docs/02-literature-map.md](docs/02-literature-map.md) | 문헌 지도: 라우터가 무엇을 보고 판단하는가 |
| [docs/03-query-analysis-criteria.md](docs/03-query-analysis-criteria.md) | 쿼리 분석 기준 초안: 필수 제약 + 선호 차원 |
| [docs/04-routing-architecture.md](docs/04-routing-architecture.md) | 라우팅 파이프라인, 데이터 스키마, 평가 계획 초안 |
| [docs/05-lessons-and-open-questions.md](docs/05-lessons-and-open-questions.md) | 문헌에서 얻은 교훈, 열린 질문, 다음 단계 |
| [docs/06-literature-update-pi-plugin.md](docs/06-literature-update-pi-plugin.md) | 본문 정독 결과, 신규 문헌, pi API 대응, 기존 pi 라우터, 설계 변경 제안 |
| [docs/07-spec.md](docs/07-spec.md) | **스펙 v0.1**: 티어, 분석기, 결정 규칙, 런타임, 기록, 시드 벤치마크, 수용 기준 |
| [docs/references.md](docs/references.md) | 참고 문헌 목록과 검토 수준 |

## 저장소 구성

| 경로 | 내용 |
|---|---|
| `config/` | 티어 구성(roster), 분류 체계, 민감도 규칙, 조회표 v0, 플러그인 기본 설정 |
| `spec/schemas/` | 데이터 계약 (JSON Schema) |
| `src/` | `stage1.ts`(1단 규칙 엔진), `decide.ts`(결정 규칙) |
| `bench/fixtures/` | 합성 저장소 4개: orders-service, ui-utils, sales-reports, ops-scripts |
| `bench/cases/` | 실행형 시드 케이스 30건 (setup / hidden / solution / mutants) |
| `bench/analyzer/gold.jsonl` | 분석기 정답 세트 44건 (민감 값은 템플릿) |
| `scripts/` | 데이터 검증, 케이스 건전성 검사, 규칙 정확도 검사, 예상값 재계산 |

티어: `local`(ixi-simflow → lgu-axeng 대체) < `light`(haiku-5-5) < `standard`(sonnet-5-5) < `heavy`(opus-5-5). 측정 전용: fable-5-2.

## 명령

Node 22.18 이상, 외부 의존성 없음.

```
npm test              # stage1, decide 단위 테스트
npm run validate      # 스키마 + 참조 무결성 + 조회표·케이스 일관성
npm run check:rules   # 민감도 규칙 정확도 (정답 세트)
npm run check:cases   # 시드 케이스 건전성 (기준 실패 → 해답 통과, 돌연변이 제거)
npm run check         # 위 세 가지 전부
npm run derive        # 조회표 변경 후 케이스 예상 (티어, 추론 강도) 재계산
```

## 상태

- 단계: 스펙 v0.1과 시드 데이터 완성. 다음은 플러그인 런타임(`registerVirtualModel`)과 시드 벤치마크 실행기다.
- 조회표는 전부 가설값(prior)이다. 시드 벤치마크로 측정해 교체한다.
- 핵심 논문 8편은 본문을 검토했고, 나머지는 arXiv 초록 기준이다. 검토 수준은 `docs/references.md`에 표시했다.
