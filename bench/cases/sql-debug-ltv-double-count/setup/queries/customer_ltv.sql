-- 고객별 누적 결제 금액 (결제 내역 기준)과 구매 수량
SELECT c.id AS customer_id,
       COALESCE(SUM(p.amount), 0) AS ltv,
       COALESCE(SUM(oi.qty), 0) AS items
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id AND o.status = 'PAID'
LEFT JOIN payments p ON p.order_id = o.id
LEFT JOIN order_items oi ON oi.order_id = o.id
GROUP BY c.id
ORDER BY c.id;
