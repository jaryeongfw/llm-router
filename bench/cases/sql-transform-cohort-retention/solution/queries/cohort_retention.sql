-- 가입 월 코호트별 리텐션: 가입 다음 달(m1), 그다음 달(m2)에 PAID 주문이 1건 이상인 고객 수
WITH cohort AS (
  SELECT id, substr(signup_date, 1, 7) AS cohort,
         strftime('%Y-%m', date(substr(signup_date, 1, 7) || '-01', '+1 month')) AS m1,
         strftime('%Y-%m', date(substr(signup_date, 1, 7) || '-01', '+2 month')) AS m2
  FROM customers
),
active AS (
  SELECT DISTINCT customer_id, substr(ordered_at, 1, 7) AS month
  FROM orders WHERE status = 'PAID'
)
SELECT c.cohort,
       COUNT(*) AS cohort_size,
       SUM(EXISTS (SELECT 1 FROM active a WHERE a.customer_id = c.id AND a.month = c.m1)) AS m1_retained,
       SUM(EXISTS (SELECT 1 FROM active a WHERE a.customer_id = c.id AND a.month = c.m2)) AS m2_retained
FROM cohort c
GROUP BY c.cohort
ORDER BY c.cohort;
