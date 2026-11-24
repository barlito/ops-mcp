import { test } from "node:test";
import assert from "node:assert/strict";
import { GlobalBudget, ipKey, RateLimiter } from "./rateLimit";

test("ipKey keeps IPv4, unwraps mapped IPv4 and buckets IPv6 by /64", () => {
  assert.equal(ipKey("1.2.3.4"), "1.2.3.4");
  assert.equal(ipKey("::ffff:1.2.3.4"), "1.2.3.4");
  assert.equal(ipKey(undefined), "unknown");
  assert.equal(ipKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), ipKey("2001:DB8:1:2::1"));
  assert.notEqual(ipKey("2001:db8:1:2::1"), ipKey("2001:db8:1:3::1"));
});

test("RateLimiter allows max hits per window then resets", () => {
  let t = 0;
  const rl = new RateLimiter(2, 1000, 10, () => t);
  assert.deepEqual([rl.hit("a"), rl.hit("a"), rl.hit("a")], [true, true, false]);
  assert.equal(rl.hit("b"), true);
  t = 1000;
  assert.equal(rl.hit("a"), true);
});

test("RateLimiter evicts the oldest keys beyond its bound", () => {
  let t = 0;
  const rl = new RateLimiter(1, 1000, 2, () => t);
  rl.hit("a");
  rl.hit("b");
  rl.hit("c");
  assert.equal(rl.hit("a"), true, "a was evicted, so its budget is fresh");
  assert.equal(rl.hit("c"), false);
});

test("GlobalBudget caps logs per window and reports what it swallowed once", () => {
  let t = 0;
  const b = new GlobalBudget(2, 1000, () => t);
  assert.deepEqual([b.take().log, b.take().log, b.take().log, b.take().log], [true, true, false, false]);
  t = 1000;
  assert.deepEqual(b.take(), { log: true, summary: 2 });
  assert.deepEqual(b.take(), { log: true, summary: 0 });
  assert.equal(b.drain(), 0);
});
