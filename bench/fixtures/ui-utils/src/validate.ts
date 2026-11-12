export type FieldError = { field: string; code: string };

/** 수량 입력: 1~99 정수 */
export function validateQty(value: string): FieldError[] {
  const n = Number(value);
  if (value.trim() === "" || !Number.isInteger(n)) return [{ field: "qty", code: "NOT_INTEGER" }];
  if (n < 1 || n > 99) return [{ field: "qty", code: "OUT_OF_RANGE" }];
  return [];
}

/** 쿠폰 코드: 영문 대문자·숫자 8~12자 (입력은 대소문자 무관, 앞뒤 공백 허용) */
export function validateCouponCode(value: string): FieldError[] {
  const code = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{8,12}$/.test(code)) return [{ field: "couponCode", code: "INVALID_FORMAT" }];
  return [];
}
