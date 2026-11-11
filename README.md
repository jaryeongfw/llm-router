# llm-router

태스크(쿼리)를 분석해 **가장 싼데 충분한 모델 부류 하나**에 배정하는 라우터를 설계하는 프로젝트.

- 한 태스크는 처음부터 끝까지 한 모델 부류가 처리한다 (session-pinned routing).
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
| [docs/references.md](docs/references.md) | 참고 문헌 목록과 검토 수준 |

## 상태

- 단계: 문헌 조사와 설계 초안. 구현 대상은 pi virtual model 플러그인이다.
- 핵심 논문 8편은 본문을 검토했고, 나머지는 arXiv 초록 기준이다. 검토 수준은 `docs/references.md`에 표시했다.
``