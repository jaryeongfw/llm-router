/** 금액 표시: 천 단위 쉼표 + "원". 음수는 앞에 "-". */
export function formatKRW(amount: number): string {
  if (!Number.isInteger(amount)) throw new RangeError("정수 금액만 지원합니다");
  const sign = amount < 0 ? "-" : "";
  const digits = Math.abs(amount).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${digits}원`;
}

const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** 용량 표시: 1024 단위, 소수 첫째 자리까지(정수면 소수점 생략). */
export function formatBytes(bytes: number): string {
  if (bytes < 0) throw new RangeError("음수 용량");
  let value = bytes;
  let unit = 0;
  while (value > 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)} ${UNITS[unit]}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 상대 시간: 방금 전 / N분 전 / N시간 전 / N일 전 / 날짜(YYYY-MM-DD). 경과 시간은 내림. */
export function relativeTime(now: Date, then: Date): string {
  const diff = now.getTime() - then.getTime();
  if (diff < MINUTE) return "방금 전";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}분 전`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}시간 전`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}일 전`;
  return then.toISOString().slice(0, 10);
}
