import assert from "node:assert/strict";
import { test } from "node:test";
import { formatBytes, relativeTime } from "../src/format.ts";

test("formatBytes 단위 경계", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1024), "1 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(1024 ** 2), "1 MB");
  assert.throws(() => formatBytes(-1), RangeError);
});

const now = new Date("2026-03-01T09:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const H = 3_600_000;
const D = 24 * H;

test("relativeTime 시간은 내림", () => {
  assert.equal(relativeTime(now, ago(1.6 * H)), "1시간 전");
});

test("relativeTime 7일 경계", () => {
  assert.equal(relativeTime(now, ago(6.5 * D)), "6일 전");
  assert.equal(relativeTime(now, ago(7 * D)), "2026-02-22");
});
