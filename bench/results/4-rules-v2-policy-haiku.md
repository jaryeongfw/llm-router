# 라우팅 판단 평가 — 2026-11-12

- 분석기: `policy(anthropic/claude-haiku-5-5 | local 모델)`, pi CLI 경유, 운영점 balanced, 비밀정보 가림 켬
- 작업: 시드 케이스 30건 × 표현 3가지 × 반복 1 = 90, 정답 세트 44
- 비교 기준: 케이스는 **사람 라벨에 같은 결정 규칙을 적용한 결정**이다. 분석기가 라벨을 얼마나 재현하는지를 잰다. 조회표가 prior라서 라벨 결정이 "최적"이라는 뜻은 아니다.
- 다시 채점: `routing-eval-2026-11-12T01-11-07.jsonl` (모델 재호출 없음, 현재 규칙·조회표 적용)

## 1. 2단 분석기 상태

| 항목 | 값 |
|---|---|
| ok | 100.0% (134/134) |
| 대체 모델 사용 | 0건 |
| 분석기별 처리 | anthropic/claude-haiku-5-5 123, local 모델 11 |
| 비밀정보 가림 | 7건 |
| 지연 p50 / p95 (CLI 시작 포함) | 2056ms / 7817ms |
| 3초 이내 | 89.6% (120/134) |

## 2. 시드 케이스: 분석 정확도 (라벨 대비)

| 항목 | 일치 | 차이 ≤ 1 |
|---|---|---|
| 도메인 | 92.2% (83/90) | |
| 행위 | 97.8% (88/90) | |
| difficulty | 51.1% (46/90) | 98.9% (89/90) |
| ambiguity | 64.4% (58/90) | 100.0% (90/90) |
| scope | 57.8% (52/90) | 97.8% (88/90) |
| verifiability | 54.4% (49/90) | 98.9% (89/90) |
| capabilities.reasoning | 60.0% (54/90) | 98.9% (89/90) |
| 민감도 오탐 (라벨은 전부 external_ok) | 0.0% (0/90) | |

난이도 편향(분석기 − 라벨) 평균: -0.10 (양수 = 과대 평가)

행위 오분류 (라벨 → 분석기: 건수):
- debug → code_modify: 2

## 3. 시드 케이스: 결정 (라벨 결정 대비)

| 항목 | 값 |
|---|---|
| 티어 일치 | 74.4% (67/90) |
| 과소 배정 (라벨보다 낮은 티어) | 14.4% (13/90) |
| 과대 배정 (라벨보다 높은 티어) | 11.1% (10/90) |
| (티어, 추론 강도) 모두 일치 | 54.4% (49/90) |
| 티어 일치 중 추론 강도 낮음 / 높음 | 13 / 5 |
| 결정 실패 | 0건 |
| 티어 일치 (라벨 결정에 분석기 신뢰도 적용) | 74.4% (67/90) |
| 난이도 구간(쉬움/어려움)이 라벨과 다름 | 20.0% (18/90) |

| 행위 | n | 쌍 일치 | 과소 | 과대 |
|---|---|---|---|---|
| code_modify | 15 | 40.0% (6/15) | 2 | 3 |
| data_transform | 6 | 50.0% (3/6) | 1 | 0 |
| debug | 21 | 57.1% (12/21) | 0 | 3 |
| design | 6 | 50.0% (3/6) | 0 | 0 |
| docs_write | 9 | 33.3% (3/9) | 6 | 0 |
| explain | 9 | 66.7% (6/9) | 0 | 3 |
| implement | 12 | 58.3% (7/12) | 2 | 0 |
| refactor | 3 | 33.3% (1/3) | 2 | 0 |
| review | 3 | 100.0% (3/3) | 0 | 0 |
| test_write | 6 | 83.3% (5/6) | 0 | 1 |

원문(prompt) 기준 티어 불일치:
- ops-docs-disk-runbook: 라벨 standard:low → 분석 light:medium (행위 docs_write, 난이도 1, 신뢰도 0.9)
- orders-debug-tier-rounding: 라벨 light:medium → 분석 standard:high (행위 debug, 난이도 2, 신뢰도 0.85)
- orders-docs-api-guide: 라벨 standard:low → 분석 light:medium (행위 docs_write, 난이도 1, 신뢰도 0.85)
- orders-explain-place-flow: 라벨 local:off → 분석 standard:low (행위 explain, 난이도 2, 신뢰도 0.85)
- orders-test-inventory: 라벨 light:medium → 분석 standard:low (행위 test_write, 난이도 2, 신뢰도 0.9)
- sql-transform-cohort-retention: 라벨 standard:xhigh → 분석 light:medium (행위 data_transform, 난이도 1, 신뢰도 0.9)
- ui-implement-pagination: 라벨 standard:medium → 분석 light:medium (행위 implement, 난이도 1, 신뢰도 0.9)
- ui-modify-krw-symbol: 라벨 local:off → 분석 light:medium (행위 code_modify, 난이도 1, 신뢰도 0.9)

## 4. 표현 변형 간 안정성

| 항목 | 값 |
|---|---|
| 세 표현 모두 같은 티어 | 83.3% (25/30) |
| 세 표현 모두 같은 (티어, 추론 강도) | 76.7% (23/30) |

흔들린 케이스:
- ops-debug-rotate-keep: prompt=light:medium, rewrite0=light:medium, rewrite1=light:low
- orders-debug-rollback-stock: prompt=standard:high, rewrite0=standard:xhigh, rewrite1=standard:xhigh
- orders-modify-stock-message: prompt=light:low, rewrite0=local:off, rewrite1=local:off
- orders-refactor-discount-steps: prompt=standard:medium, rewrite0=light:medium, rewrite1=light:medium
- orders-test-inventory: prompt=standard:low, rewrite0=light:medium, rewrite1=light:medium
- sql-transform-cohort-retention: prompt=light:medium, rewrite0=standard:medium, rewrite1=standard:medium
- ui-implement-pagination: prompt=light:medium, rewrite0=standard:medium, rewrite1=light:medium

## 5. 분석기 정답 세트

| 항목 | 값 |
|---|---|
| 행위 일치 | 86.4% (38/44) |
| 도메인 일치 | 75.0% (33/44) |
| 난이도 차이 ≤ 1 | 100.0% (22/22) |
| 모호성 3 탐지 (되묻기 대상) | 100.0% (1/1) |
| 모호성 3 오탐 | 0.0% (0/11) |
| 민감도 재현율: 1단만 / 1단+2단 | 100.0% (10/10) / 100.0% (10/10) |
| 민감도 정밀도: 1단만 / 1단+2단 | 90.9% (10/11) / 83.3% (10/12) |
| 2단이 추가로 잡은 민감 사례 | neg-08 |

행위 불일치: pii-03: debug → data_transform; se-01: code_modify → null; se-02: code_modify → null; se-05: code_modify → null; neg-03: code_modify → null; neg-07: implement → data_transform

## 6. 결정 분포 (시드 케이스, 원문)

| 티어 | 라벨 결정 | 분석기 결정 |
|---|---|---|
| local | 5 | 3 |
| light | 11 | 14 |
| standard | 11 | 10 |
| heavy | 3 | 3 |
