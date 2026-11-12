/**
 * 분석기 정답 세트의 {{FAKE_*}} 자리표시자를 실행 시점에 가짜 값으로 채운다.
 * - 저장소에는 비밀정보·개인정보 형식의 완성된 문자열을 두지 않는다. 접두사와 난수를 실행 중에 조합한다.
 * - 생성된 값은 출력하거나 파일로 쓰지 않는다.
 * - 주민번호 형식은 월 자리를 00으로 만들어 실제 존재할 수 없는 값으로 둔다.
 * - 이메일은 예약 도메인(example.com), 카드번호는 공개 테스트 번호(Luhn 통과)를 쓴다.
 */

export function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ALNUM = UPPER + UPPER.toLowerCase() + "0123456789";
const B64 = ALNUM + "+/";

function chars(rnd: () => number, set: string, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += set[Math.floor(rnd() * set.length)];
  return out;
}

function digits(rnd: () => number, n: number): string {
  return chars(rnd, "0123456789", n);
}

function b64url(s: string): string {
  return Buffer.from(s).toString("base64url");
}

type Gen = (rnd: () => number) => string;

const GENERATORS: Record<string, Gen> = {
  AWS_KEY: (r) => ["AK", "IA"].join("") + chars(r, UPPER + "0123456789", 16),
  SK_KEY: (r) => ["sk", "ant", ""].join("-") + chars(r, ALNUM, 40),
  GH_TOKEN: (r) => ["gh", "p_"].join("") + chars(r, ALNUM, 36),
  JWT: (r) => [b64url('{"alg":"HS256","typ":"JWT"}'), b64url(`{"sub":"u${digits(r, 4)}","exp":1900000000}`), chars(r, ALNUM, 43)].join("."),
  PRIVATE_KEY: (r) => {
    const dash = "-".repeat(5);
    const body = Array.from({ length: 4 }, () => chars(r, B64, 64)).join("\n");
    return `${dash}BEGIN ${"PRIVATE"} KEY${dash}\n${body}\n${dash}END ${"PRIVATE"} KEY${dash}`;
  },
  PASSWORD: (r) => chars(r, ALNUM, 10) + "!" + digits(r, 2),
  CONN: (r) => `postgres://svc_${chars(r, "abcdefghijklmnopqrstuvwxyz", 5)}:${chars(r, ALNUM, 14)}@db.example.internal:5432/app`,
  PHONE: (r) => `010-0000-${digits(r, 4)}`,
  RRN: (r) => `${digits(r, 2)}00${digits(r, 2)}-${1 + Math.floor(r() * 4)}${digits(r, 6)}`,
  EMAIL: (r) => `user${digits(r, 3)}@example.com`,
  CARD: () => ["4111", "1111", "1111", "1111"].join(" "),
};

export const FAKE_KEYS = Object.keys(GENERATORS);

/** 템플릿을 채운다. 알 수 없는 자리표시자가 있으면 예외. */
export function fillTemplate(template: string, seed: number): string {
  const rnd = seeded(seed);
  return template.replace(/\{\{FAKE_([A-Z_]+)\}\}/g, (_, key: string) => {
    const gen = GENERATORS[key];
    if (!gen) throw new Error(`알 수 없는 자리표시자: FAKE_${key}`);
    return gen(rnd);
  });
}

export function placeholdersOf(template: string): string[] {
  return [...template.matchAll(/\{\{FAKE_([A-Z_]+)\}\}/g)].map((m) => m[1]);
}
