# sales-reports

리포트 SQL 모음 (합성 데이터). SQLite(`node:sqlite`) 메모리 DB에 `db/schema.sql`, `db/seed.sql`을 적재해 실행한다.

```
npm run query -- queries/top_customers.sql
npm test
```

## 스키마 요약
- `customers(id, signup_date, segment)`
- `categories(id, name)`, `products(id, category_id, name, price)`
- `orders(id, customer_id, ordered_at, status)` — status: `PAID` | `CANCELLED`
- `order_items(order_id, product_id, qty, unit_price)`
- `payments(id, order_id, amount, paid_at)` — 한 주문이 **여러 번 나눠 결제**될 수 있다. 취소 주문은 결제 없음.

## 용어
- 매출: 취소되지 않은 주문의 `Σ qty × unit_price`
- 날짜는 `YYYY-MM-DD` 텍스트
