-- 월별·카테고리별 매출 (취소 주문 제외)
SELECT substr(o.ordered_at, 1, 7) AS month,
       c.name AS category,
       SUM(oi.qty * oi.unit_price) AS revenue
FROM orders o
JOIN order_items oi ON oi.order_id = o.id
JOIN products p ON p.id = oi.product_id
JOIN categories c ON c.id = p.category_id
WHERE o.status = 'PAID'
GROUP BY month, c.name
ORDER BY month, c.name;
