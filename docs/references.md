# 참고 문헌

검토 수준: **초록** = arXiv 초록만 읽음 / **제목** = 제목만 확인 / **본문** = 본문 정독.
날짜는 arXiv 최초 게시일. 링크: `https://arxiv.org/abs/<ID>`

## 서베이

| ID | 제목 | 게시 | 검토 |
|---|---|---|---|
| 2603.04445 | Dynamic Model Routing and Cascading for Efficient LLM Inference: A Survey | 2026-02 | 초록 |
| 2502.00409 | Doing More with Less: A Survey on Routing Strategies for Resource Optimisation in Large Language Model-Based Systems | 2025-02 | 초록 |

## 판단 신호별

| ID | 제목 | 게시 | 핵심 신호 | 검토 |
|---|---|---|---|---|
| 2506.16655 | Arch-Router: Aligning LLM Routing with Human Preferences | 2025-06 | 도메인 × 행위 분류 | 본문 |
| 2308.11601 | Tryage: Real-time, intelligent Routing of User Prompts to Large Language Models | 2023-08 | 프롬프트 분류 | 제목 |
| 2404.14618 | Hybrid LLM: Cost-Efficient and Quality-Aware Query Routing | 2024-04 | 난이도 + 목표 품질 | 초록 |
| 2607.18098 | VDAR-Router: Adaptive LLMs Routing via Verbalized Query Difficulty Analysis Retrieval | 2026-07 | 난이도 분석 문장 + 검색 | 본문 |
| 2506.01048 | IRT-Router: Effective and Interpretable Multi-LLM Routing via Item Response Theory | 2025-06 | 난이도 × 능력 (IRT) | 본문 |
| 2602.02386 | Trust by Design: Skill Profiles for Transparent, Cost-Aware LLM Routing (BELLA) | 2026-02 | 역량 프로필 | 초록 |
| 2606.22902 | Agent-as-a-Router: Agentic Model Routing for Coding Tasks | 2026-06 | 차원별 성적 + 실행 경험 | 본문 |
| 2604.07494 | Triage: Routing Software Engineering Tasks to Cost-Effective LLM Tiers via Code Quality Signals | 2026-04 | 코드 건강도 (**제안만, 결과 없음**) | 본문 |
| 2607.00053 | SWE-Router: Routing in Multi-turn Agentic Software Engineering Tasks | 2026-06 | 부분 궤적 (대조) | 본문 |
| 2605.07180 | Learning Agent Routing From Early Experience (BoundaryRouter) | 2026-05 | 경험 기억 | 초록 |
| 2603.13612 | LLM Routing as Reasoning: A MaxSAT View | 2026-03 | 필수/선호 제약 | 초록 |
| 2406.18665 | RouteLLM: Learning to Route LLMs with Preference Data | 2024-06 | 선호 데이터 학습 | 초록 |
| 2502.08773 | Universal Model Routing for Efficient LLM Inference (UniRoute) | 2025-02 | 모델 = 대표 세트 성적 벡터 | 초록 |
| 2609.37362 | Pretrain Once, Route Anywhere: Towards a Foundation Model for LLM Routing (RouteFM) | 2026-09 | 행동 맥락 기반 능력 추론 | 초록 |
| 2409.19886 | RouterDC: Query-Based Router by Dual Contrastive Learning for Assembling Large Language Models | 2024-09 | 대조학습 | 제목 |
| 2410.03834 | GraphRouter: A Graph-based Router for LLM Selections | 2024-10 | 그래프 | 제목 |
| 2410.02223 | EmbedLLM: Learning Compact Representations of Large Language Models | 2024-10 | 모델 임베딩 | 제목 |
| 2502.18482 | MixLLM: Dynamic Routing in Mixed Large Language Models | 2025-02 | — | 제목 |
| 2506.09033 | Router-R1: Teaching LLMs Multi-Round Routing and Aggregation via Reinforcement Learning | 2025-06 | RL 다회 라우팅 | 제목 |

## 캐스케이드

| ID | 제목 | 게시 | 검토 |
|---|---|---|---|
| 2305.05176 | FrugalGPT: How to Use Large Language Models While Reducing Cost and Improving Performance | 2023-05 | 초록 |
| 2310.12963 | AutoMix: Automatically Mixing Language Models | 2023-10 | 초록 |

## 멀티턴·세션

| ID | 제목 | 게시 | 검토 |
|---|---|---|---|
| 2610.23239 | Response-Informed Value Estimation for Cost-Aware Multi-Turn LLM Routing (RIVET) | 2026-10 | 초록 |
| 2604.23530 | MTRouter: Cost-Aware Multi-Turn LLM Routing with History-Model Joint Embeddings | 2026-04 | 제목 |
| 2610.17431 | VeriRouter: Towards Verifiable LLM Routing | 2026-10 | 초록 |

## 벤치마크·평가

| ID | 제목 | 게시 | 검토 |
|---|---|---|---|
| 2601.07206 | LLMRouterBench: A Massive Benchmark and Unified Framework for LLM Routing | 2026-01 | 본문 |
| 2606.06924 | From Sampled Outcomes to Capability Distributions: Rethinking Supervision for LLM Routing (DARS) | 2026-06 | 본문 |
| 2403.12031 | RouterBench: A Benchmark for Multi-LLM Routing System | 2024-03 | 제목 |
| 2503.10657 | RouterEval: A Comprehensive Benchmark for Routing LLMs to Explore Model-level Scaling Up in LLMs | 2025-03 | 제목 |

## 2026-11 추가 ([06 문서](06-literature-update-pi-plugin.md))

| ID | 제목 | 게시 | 주제 | 검토 |
|---|---|---|---|---|
| 2610.19292 | Whose turn is it? Context-guided model routing for stateful agents | 2026-10 | 세션 이력, 전환 캐시 비용 비대칭 | 본문 일부 |
| 2610.15093 | TurnCost: Turns, Not Observations: Cache-Aware Loop Engineering for Coding Agents | 2026-10 | 캐시 인지 비용, 턴 수 | 본문 일부 |
| 2611.13176 | SHADOWPREFILL: Keeping Your Next Model Warm for Per-Step Model Routing in Agentic LLM Serving | 2026-11 | 전환 시 캐시 적중률 실측 | 초록 |
| 2611.10848 | MultiTurnRoute: A Platform for Building and Evaluating Multi-Turn LLM Routers | 2026-11 | 프리픽스 인지 멀티턴 라우팅 | 초록 |
| 2610.02762 | Dynamic LLM Routers are Often Misguided | 2026-10 | 상용 라우터 vs 2모델 무작위 | 초록 |
| 2606.07587 | The Routing Plateau: Understanding the Accuracy Limits of LLM Routers | 2026-05 | 라우터 정확도 정체 | 초록 |
| 2609.22951 | AgentRouter: Heterogeneous Model Routing for Cost-Optimal Multi-Step Agentic Workflows | 2026-09 | 단계별 라우팅 (대조) | 초록 |
| 2609.34712 | RSI-Router: Evolving Subtask-Level LLM Routing and Skills for Cost-Efficient Agents | 2026-09 | 하위 태스크 라우팅 (대조) | 초록 |
| 2605.18796 | UCCI: Calibrated Uncertainty for Cost-Optimal LLM Cascade Routing | 2026-05 | 등위 회귀 보정 | 초록 |
| 2603.06616 | RACER: Risk-Aware Calibrated Efficient Routing for Large Language Models | 2026-02 | 위험 통제, 기권 | 초록 |
| 2606.19376 | Cost-Optimal LLM Routing with Limited User Feedback under User Satisfaction Guarantees (SLARouter) | 2026-06 | 한쪽 피드백 온라인 학습 | 초록 |
| 2602.02061 | Learning to Route and Schedule LLMs from User Retrials via Contextual Queueing Bandits | 2026-02 | 재시도 = 암묵 피드백 | 초록 |
| 2508.12631 | Beyond GPT-5: Making LLMs Cheaper and Better via Performance-Efficiency Optimized Routing (Avengers-Pro) | 2025-08 | 군집 조회표 | 초록 |
| 2606.31163 | ComplianceGate: Classifier-Gated Multi-Tier LLM Routing for Inference in Regulated Industries | 2026-06 | 추론 전 민감도 분류 | 초록 |
| 2610.09981 | Sensitive-Topic Leakage Through LLM Routing Metadata: Measurement and Mitigation | 2026-10 | 라우팅 로그 누출 | 초록 |
| 2611.07534 | Route Before Response: Fail-Closed Routing for LLM-Enabled Customer-Service Software (RouteBR) | 2026-11 | 제안/집행 분리 | 초록 |
| 2610.10610 | Code Understanding is a Bottleneck for Coding Agents (CABRA) | 2026-10 | 탐색량이 난이도 예측 | 초록 |
| 2601.02200 | Code for Machines, Not Just Humans: Quantifying AI-Friendliness with Code Health Metrics | 2026-01 | Triage 비대칭의 원 출처 | 초록 |
| 2608.06867 | LLMRouter: Unified Infrastructure for Developing, Evaluating, and Deploying LLM Routers | 2026-08 | 오픈소스 라우터 16종 | 초록 |

## pi 플랫폼과 선행 구현 (논문 아님)

| 출처 | 내용 | 검토 |
|---|---|---|
| pi-coding-agent 1.5.2 `docs/virtual-models.md`, `docs/extensions.md`, `docs/models.md` | `registerVirtualModel`, route reason/state, classifier API, 이벤트 | 본문 |
| pi `examples/extensions/jev-router.ts` | 계획→구현 하향 1회 전환 라우터 | 코드 |
| npm `pi-smart-router`, `@alexeiled/pi-model-router`, `pi-cuttle`, `@jangmanj/pi-router`, `@metaharness/router`, `@nredd/pi-subscription-router` | 기존 pi 라우터 | README / 공개 이슈 |

## 인접 참고 (논문 아님)

| 출처 | 내용 |
|---|---|
| NVIDIA Agent Skills — `docs/evaluating-agent-skills.mdx`, 각 스킬 `BENCHMARK.md` | 평가 차원 5개, 판정 임계값, 부정 케이스 |
| NVIDIA Agent Skills — `skills/tao-token-efficient-execution` | 강한 모델이 정형 지시 작성 / 작은 모델 실행, 모델 크기별 실행 하한, pi 어댑터 |
