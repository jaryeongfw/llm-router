import assert from "node:assert/strict";
import { test } from "node:test";
import { formatKRW, relativeTime } from "../src/format.ts";

test("formatKRW 기본", () => {
  assert.equal(formatKRW(0), "₩0");
  assert.equal(formatKRW(1234567), "₩1,234,567");
});

test("relativeTime 방금 전과 분", () => {
  const now = new Date("2026-01-10T12:00:00Z");
  assert.equal(relativeTime(now, new Date("2026-01-10T11:59:30Z")), "방금 전");
  assert.equal(relativeTime(now, new Date("2026-01-10T11:55:00Z")), "5분 전");
});
