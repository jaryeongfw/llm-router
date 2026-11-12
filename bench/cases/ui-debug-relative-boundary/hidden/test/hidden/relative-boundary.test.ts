import assert from "node:assert/strict";
import { test } from "node:test";
import { relativeTime } from "../../src/format.ts";

const now = new Date("2026-03-01T09:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

test("정확히 1시간 전은 '1시간 전'", () => {
  assert.equal(relativeTime(now, ago(3_600_000)), "1시간 전");
});

test("59분 59초 전은 '59분 전'", () => {
  assert.equal(relativeTime(now, ago(3_599_000)), "59분 전");
});

test("정확히 1일 전은 '1일 전'", () => {
  assert.equal(relativeTime(now, ago(86_400_000)), "1일 전");
});
