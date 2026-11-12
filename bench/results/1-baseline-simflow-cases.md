# 라우팅 판단 평가 — 2026-11-12

- 분석기: `simflow/ixi-simflow-codeadvisor` (대체: `lgu-axeng/axengdev/google/gemma-4-e4b`, `lgu-axeng/axengdev/google/gemma-4-e2b`), pi CLI 경유, 운영점 balanced
- 작업: 시드 케이스 30건 × 표현 3가지 × 반복 1 = 90, 정답 세트 0
- 비교 기준: 케이스는 **사람 라벨에 같은 결정 규칙을 적용한 결정**이다. 분석기가 라벨을 얼마나 재현하는지를 잰다. 조회표가 prior라서 라벨 결정이 "최적"이라는 뜻은 아니다.
- 소요: 727초

## 1. 2단 분석기 상태

| 항목 | 값 |
|---|---|
| ok | 100.0% (90/90) |
| 대체 모델 사용 | 0건 |
| 지연 p50 / p95 (CLI 시작 포함) | 6935ms / 16946ms |
| 3초 이내 | 0.0% (0/90) |

## 2. 시드 케이스: 분석 정확도 (라벨 대비)

| 항목 | 일치 | 차이 ≤ 1 |
|---|---|---|
| 도메인 | 98.9% (89/90) | |
| 행위 | 97.8% (88/90) | |
| difficulty | 56.7% (51/90) | 98.9% (89/90) |
| ambiguity | 31.1% (28/90) | 97.8% (88/90) |
| scope | 48.9% (44/90) | 98.9% (89/90) |
| verifiability | 55.6% (50/90) | 100.0% (90/90) |
| capabilities.reasoning | 58.9% (53/90) | 98.9% (89/90) |
| 민감도 오탐 (라벨은 전부 external_ok) | 0.0% (0/90) | |

난이도 편향(분석기 − 라벨) 평균: 0.00 (양수 = 과대 평가)

행위 오분류 (라벨 → 분석기: 건수):
- code_modify → implement: 2

## 3. 시드 케이스: 결정 (라벨 결정 대비)

| 항목 | 값 |
|---|---|
| 티어 일치 | 60.0% (54/90) |
| 과소 배정 (라벨보다 낮은 티어) | 16.7% (15/90) |
| 과대 배정 (라벨보다 높은 티어) | 23.3% (21/90) |
| (티어, 추론 강도) 모두 일치 | 55.6% (50/90) |
| 티어 일치 중 추론 강도 낮음 / 높음 | 1 / 3 |
| 결정 실패 | 0건 |

| 행위 | n | 쌍 일치 | 과소 | 과대 |
|---|---|---|---|---|
| code_modify | 15 | 86.7% (13/15) | 0 | 2 |
| data_transform | 6 | 0.0% (0/6) | 3 | 3 |
| debug | 21 | 66.7% (14/21) | 3 | 4 |
| design | 6 | 50.0% (3/6) | 0 | 0 |
| docs_write | 9 | 66.7% (6/9) | 2 | 1 |
| explain | 9 | 22.2% (2/9) | 0 | 7 |
| implement | 12 | 58.3% (7/12) | 5 | 0 |
| refactor | 3 | 33.3% (1/3) | 1 | 0 |
| review | 3 | 66.7% (2/3) | 1 | 0 |
| test_write | 6 | 33.3% (2/6) | 0 | 4 |

원문(prompt) 기준 티어 불일치:
- ops-modify-dry-run: 라벨 local:off → 분석 light:low (행위 implement, 난이도 1, 신뢰도 0.85, 보정 verifiable_down)
- orders-debug-coupon-policy: 라벨 heavy:xhigh → 분석 standard:high (행위 debug, 난이도 2, 신뢰도 0.9)
- orders-debug-tier-rounding: 라벨 local:off → 분석 standard:high (행위 debug, 난이도 2, 신뢰도 0.9)
- orders-explain-place-flow: 라벨 light:low → 분석 standard:low (행위 explain, 난이도 2, 신뢰도 0.9)
- orders-implement-idempotency: 라벨 heavy:xhigh → 분석 standard:high (행위 implement, 난이도 2, 신뢰도 0.9)
- orders-test-inventory: 라벨 local:off → 분석 standard:low (행위 test_write, 난이도 2, 신뢰도 0.86)
- sql-transform-cohort-retention: 라벨 heavy:xhigh → 분석 standard:high (행위 data_transform, 난이도 2, 신뢰도 0.95)
- sql-transform-monthly-category: 라벨 local:off → 분석 light:medium (행위 data_transform, 난이도 1, 신뢰도 0.9)
- ui-explain-remove-item: 라벨 local:off → 분석 light:low (행위 explain, 난이도 1, 신뢰도 0.9)
- ui-implement-pagination: 라벨 standard:high → 분석 light:low (행위 implement, 난이도 1, 신뢰도 0.95, 보정 verifiable_down)
- ui-test-format: 라벨 local:off → 분석 standard:low (행위 test_write, 난이도 2, 신뢰도 0.94)

## 4. 표현 변형 간 안정성

| 항목 | 값 |
|---|---|
| 세 표현 모두 같은 티어 | 63.3% (19/30) |
| 세 표현 모두 같은 (티어, 추론 강도) | 63.3% (19/30) |

흔들린 케이스:
- general-explain-money-types: prompt=local:off, rewrite0=light:low, rewrite1=light:low
- ops-debug-rotate-keep: prompt=local:off, rewrite0=local:off, rewrite1=light:medium
- ops-docs-disk-runbook: prompt=standard:low, rewrite0=light:low, rewrite1=light:low
- ops-modify-dry-run: prompt=light:low, rewrite0=local:off, rewrite1=light:low
- orders-docs-release-note: prompt=light:low, rewrite0=light:low, rewrite1=standard:low
- orders-explain-place-flow: prompt=standard:low, rewrite0=light:low, rewrite1=standard:low
- orders-refactor-discount-steps: prompt=standard:medium, rewrite0=standard:low, rewrite1=light:low
- orders-review-bulk-cancel: prompt=heavy:medium, rewrite0=standard:medium, rewrite1=heavy:medium
- sql-transform-cohort-retention: prompt=standard:high, rewrite0=light:medium, rewrite1=standard:high
- ui-implement-pagination: prompt=light:low, rewrite0=standard:high, rewrite1=light:low
- ui-test-format: prompt=standard:low, rewrite0=local:off, rewrite1=local:off

## 5. 분석기 정답 세트

| 항목 | 값 |
|---|---|
| 행위 일치 | - |
| 도메인 일치 | - |
| 난이도 차이 ≤ 1 | - |
| 모호성 3 탐지 (되묻기 대상) | - |
| 모호성 3 오탐 | - |
| 민감도 재현율: 1단만 / 1단+2단 | - / - |
| 민감도 정밀도: 1단만 / 1단+2단 | - / - |
| 2단이 추가로 잡은 민감 사례 | 없음 |

## 6. 결정 분포 (시드 케이스, 원문)

| 티어 | 라벨 결정 | 분석기 결정 |
|---|---|---|
| local | 13 | 7 |
| light | 3 | 6 |
| standard | 8 | 14 |
| heavy | 6 | 3 |
