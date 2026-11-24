import { test } from "node:test";
import assert from "node:assert/strict";
import { isoNs, parseNs, toNs } from "./time";

test("nanosecond timestamps round-trip", () => {
  const ns = 1_780_315_200_123_456_789n;
  assert.equal(isoNs(ns), "2026-06-01T12:00:00.123456789Z");
  assert.equal(parseNs(isoNs(ns)), ns);
  assert.equal(parseNs("2026-06-01T12:00:00Z"), toNs(new Date("2026-06-01T12:00:00Z")));
  assert.equal(parseNs("2026-06-01T14:00:00.5+02:00"), toNs(new Date("2026-06-01T12:00:00.500Z")));
});
