-- 고객별 주문 수와 주문 금액 상위 5명 (취소 주문 제외)
SELECT o.customer_id,
       COUNT(DISTINCT o.id) AS order_count,
       SUM(oi.qty * oi.unit_price) AS amount
FROM orders o
JOIN order_items oi ON oi.order_id = o.id
WHERE o.status = 'PAID'
GROUP BY o.customer_id
ORDER BY amount DESC, o.customer_id
LIMIT 5;
