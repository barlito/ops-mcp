import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthFailureLimiter, createShutdown, createTrustedProxy, Lifecycle } from "./http";
import { AuthFailureAudit } from "./authFailure";
import { testStores } from "../test-support/fixtures";
import { EventEmitter } from "node:events";
import type { Response } from "express";

test("AuthFailureLimiter blocks after max failures within the window and coalesces audits", () => {
  let t = 0;
  const l = new AuthFailureLimiter(2, 1000, 10, () => t);
  assert.equal(l.blocked("ip"), false);
  assert.deepEqual(l.record("ip"), { audit: true, previous: 0 });
  assert.deepEqual(l.record("ip"), { audit: false, previous: 0 });
  assert.equal(l.blocked("ip"), true);
  assert.equal(l.blocked("other"), false);
  t = 1000;
  assert.equal(l.blocked("ip"), false);
  assert.deepEqual(l.record("ip"), { audit: true, previous: 2 });
});

test("createTrustedProxy trusts fixed IPs, CIDRs and resolved hosts only", async () => {
  const p = createTrustedProxy("10.0.0.1, 192.168.0.0/16, 2001:db8::/32, traefik", async () => ["172.18.0.5"], 3_600_000);
  assert.equal(p.trust("172.18.0.5"), false, "not resolved yet");
  await p.refresh();
  for (const ok of ["10.0.0.1", "::ffff:10.0.0.1", "192.168.4.4", "2001:db8::1", "172.18.0.5"]) assert.equal(p.trust(ok), true, ok);
  for (const no of ["10.0.0.2", "8.8.8.8", "not-an-ip", "2001:db9::1"]) assert.equal(p.trust(no), false, no);
  p.stop();
  assert.equal(createTrustedProxy(undefined).trust("127.0.0.1"), false);
});

test("createTrustedProxy keeps the last good answer when resolution fails", async () => {
  let fail = false;
  const p = createTrustedProxy("host", async () => {
    if (fail) throw new Error("dns down");
    return ["10.1.1.1"];
  }, 3_600_000);
  await p.refresh();
  fail = true;
  const prev = console.error;
  console.error = () => {};
  try {
    await p.refresh();
  } finally {
    console.error = prev;
  }
  assert.equal(p.trust("10.1.1.1"), true);
  p.stop();
});

test("Lifecycle waits for in-flight requests", async () => {
  const lc = new Lifecycle();
  const res = new EventEmitter() as unknown as Response;
  lc.enter(res);
  assert.equal(lc.inFlight, 1);
  let idle = false;
  void lc.waitIdle().then(() => (idle = true));
  await new Promise((r) => setImmediate(r));
  assert.equal(idle, false);
  res.emit("finish");
  res.emit("close");
  await lc.waitIdle();
  assert.equal(lc.inFlight, 0);
});

test("shutdown is graceful once and immediate the second time", async () => {
  const exits: number[] = [];
  const log = console.log;
  const err = console.error;
  console.log = console.error = () => {};
  try {
    let closed = 0;
    let dbClosed = 0;
    const lifecycle = new Lifecycle();
    const shutdown = createShutdown({
      servers: [{ close: (cb) => { closed++; cb?.(); return undefined as never; }, closeAllConnections: () => {} }],
      lifecycle,
      closeDb: () => void dbClosed++,
      exit: (c) => void exits.push(c),
    });
    await shutdown("SIGTERM");
    await shutdown("SIGTERM");
    assert.equal(lifecycle.shuttingDown, true);
    assert.deepEqual([closed, dbClosed, exits], [1, 1, [0, 1]]);
  } finally {
    console.log = log;
    console.error = err;
  }
});

test("AuthFailureAudit caps rows per minute and reports the swallowed count on flush", () => {
  const { db, audit } = testStores();
  const a = new AuthFailureAudit(audit, 2);
  for (let i = 0; i < 5; i++) a.record("1.1.1.1", `fail ${i}`);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM audit_log").get() as { c: number }).c, 2);
  a.flush();
  const last = db.prepare("SELECT detail FROM audit_log ORDER BY id DESC LIMIT 1").get() as { detail: string };
  assert.match(last.detail, /3 further auth failures not logged/);
  a.flush();
  assert.equal((db.prepare("SELECT COUNT(*) c FROM audit_log").get() as { c: number }).c, 3);
});

test("AuthFailureAudit never throws when the DB is broken", () => {
  const { db, audit } = testStores();
  db.exec("DROP TABLE audit_log");
  const prev = console.error;
  console.error = () => {};
  try {
    assert.doesNotThrow(() => new AuthFailureAudit(audit).record("1.1.1.1", "x"));
  } finally {
    console.error = prev;
  }
});
