# 평가 결과

> local 모델: 측정 당시 사용자 설정의 첫 번째 local 모델(사내 호스팅 코딩 모델, 추론형). 대체 모델: 같은 설정의 다음 local 모델.

| 파일 | 분석기 | 프롬프트 | 결정 규칙 | 원시 기록 (로컬 전용, git 제외) |
|---|---|---|---|---|
| `1-baseline-local-{cases,gold}.md` | local 모델 | 앵커 없음 | v1 (난이도 4단계 조회표) | `raw/routing-eval-2026-11-12T00-47-19.jsonl`, `…T00-55-40.jsonl` |
| `2-rules-v2-local-noanchor-{cases,gold}.md` | local 모델 | 앵커 없음 | v2 (구간 조회표, verifiable_down d0) | 1과 같음 (다시 채점) |
| `3-rules-v2-local-anchor.md` | local 모델 | 앵커 있음 | v2 | `raw/routing-eval-2026-11-12T01-29-34.jsonl` (다시 채점) |
| `4-rules-v2-policy-haiku.md` | 정책: external_ok → haiku-5-5, internal_only → local 모델 | 앵커 있음 | v2 | `raw/routing-eval-2026-11-12T01-11-07.jsonl` (다시 채점) |

해석은 [docs/08-routing-eval.md](../../docs/08-routing-eval.md). 재현: `node scripts/eval-routing.ts --analyzer <policy|모델> [--rescore raw/<파일>]`.
