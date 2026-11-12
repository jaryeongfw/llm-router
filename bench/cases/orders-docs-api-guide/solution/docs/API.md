# orders-service API

`OrderService`는 재고(`Inventory`)와 저장소(`OrderRepository`)를 받아 주문을 생성·취소한다. 금액은 원 단위 정수이며 계산 규칙은 [가격 정책](pricing-policy.md)을 따른다.

```ts
import { Inventory, OrderRepository, OrderService } from "./src/index.ts";

const service = new OrderService(new Inventory({ PEN: 10 }), new OrderRepository());
const order = service.placeOrder({
  customer: { id: "C1", tier: "GOLD" },
  lines: [{ sku: "PEN", unitPrice: 1_500, qty: 2 }],
  coupon: null,
});
```

## placeOrder

`placeOrder(input: PlaceOrderInput): Order`

1. 입력을 검증한다. 라인이 비어 있거나, 수량이 1~99 정수가 아니거나, 단가가 0 이상 정수가 아니면 `ValidationError`.
2. 라인 순서대로 재고를 예약한다. 도중에 재고가 부족하면 이미 예약한 라인을 모두 해제하고 `OutOfStockError`를 던진다.
3. 가격을 계산하고 상태 `PLACED`로 저장한 뒤 주문을 반환한다. 주문 ID는 `O-0001`부터 순서대로 붙는다.

## cancelOrder

`cancelOrder(orderId: string): Order`

`PLACED` 상태인 주문만 취소할 수 있다. 모든 라인의 재고를 해제하고 상태를 `CANCELLED`로 바꾼다. 다른 상태면 `InvalidStateError`.

## getOrder

`getOrder(orderId: string): Order` — 저장된 주문의 복사본을 반환한다. 없으면 `NotFoundError`.

## 오류

| 클래스 | 발생 조건 |
|---|---|
| `ValidationError` | 입력 형식·범위 오류 |
| `OutOfStockError` | 재고 부족. `sku`, `requested`, `available` 필드 제공 |
| `InvalidStateError` | 현재 상태에서 허용되지 않는 작업 |
| `NotFoundError` | 주문 ID 없음 |
