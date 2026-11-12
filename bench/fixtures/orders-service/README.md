# orders-service

주문 생성·취소와 가격 계산을 담당하는 합성 예제 서비스. 외부 의존성 없음 (Node 22, TypeScript 타입 제거 실행).

- `src/service.ts` — 주문 생성(`placeOrder`), 취소(`cancelOrder`)
- `src/pricing.ts` — 등급 할인, 쿠폰, 배송비 계산
- `src/inventory.ts` — 재고 예약·해제
- `src/repository.ts` — 메모리 저장소
- `docs/pricing-policy.md` — 가격 정책 (기준 문서)

```
npm test
```
