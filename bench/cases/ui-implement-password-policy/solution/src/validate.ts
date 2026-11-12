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

/** 비밀번호 정책. 위반 코드를 정해진 순서대로 모두 반환한다. */
export function validatePassword(pw: string): FieldError[] {
  const codes: string[] = [];
  const len = [...pw].length;
  if (len < 10) codes.push("TOO_SHORT");
  if (len > 64) codes.push("TOO_LONG");
  if (!/[A-Za-z]/.test(pw)) codes.push("NO_LETTER");
  if (!/[0-9]/.test(pw)) codes.push("NO_DIGIT");
  if (!/[^A-Za-z0-9\s]/.test(pw)) codes.push("NO_SYMBOL");
  if (/\s/.test(pw)) codes.push("HAS_SPACE");
  if (/(.)\1{3,}/u.test(pw)) codes.push("REPEATED_CHAR");
  return codes.map((code) => ({ field: "password", code }));
}
