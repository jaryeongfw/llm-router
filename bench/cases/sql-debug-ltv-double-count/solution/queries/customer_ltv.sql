-- 고객별 누적 결제 금액 (결제 내역 기준)과 구매 수량
-- payments와 order_items는 주문당 여러 행이므로 각각 먼저 집계한 뒤 붙인다.
WITH paid AS (
  SELECT o.customer_id, SUM(p.amount) AS ltv
  FROM orders o JOIN payments p ON p.order_id = o.id
  WHERE o.status = 'PAID'
  GROUP BY o.customer_id
),
qty AS (
  SELECT o.customer_id, SUM(oi.qty) AS items
  FROM orders o JOIN order_items oi ON oi.order_id = o.id
  WHERE o.status = 'PAID'
  GROUP BY o.customer_id
)
SELECT c.id AS customer_id,
       COALESCE(paid.ltv, 0) AS ltv,
       COALESCE(qty.items, 0) AS items
FROM customers c
LEFT JOIN paid ON paid.customer_id = c.id
LEFT JOIN qty ON qty.customer_id = c.id
ORDER BY c.id;
