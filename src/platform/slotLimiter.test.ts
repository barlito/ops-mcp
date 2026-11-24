import { test } from "node:test";
import assert from "node:assert/strict";
import { SlotLimiter } from "./slotLimiter";

test("global cap", () => {
  const s = new SlotLimiter(2);
  const a = s.acquire([["x", 5]]);
  const b = s.acquire([["y", 5]]);
  assert.ok(a && b);
  assert.equal(s.acquire([["z", 5]]), undefined);
  a();
  assert.ok(s.acquire([["z", 5]]));
});

test("per-key cap", () => {
  const s = new SlotLimiter(10);
  const a = s.acquire([["ip", 1]]);
  assert.ok(a);
  assert.equal(s.acquire([["ip", 1]]), undefined);
  assert.ok(s.acquire([["other", 1]]));
  a();
  assert.ok(s.acquire([["ip", 1]]));
});

test("release is idempotent", () => {
  const s = new SlotLimiter(1);
  const a = s.acquire([["k", 1]])!;
  a();
  a();
  assert.ok(s.acquire([["k", 1]]));
  assert.equal(s.acquire([["k", 1]]), undefined);
});
