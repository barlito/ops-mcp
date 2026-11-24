import { test } from "node:test";
import assert from "node:assert/strict";
import { AUDIT_PAGE_SIZE, MAX_FIELD_LEN } from "./audit";
import { testStores } from "../test-support/fixtures";

type Row = Record<string, string | number | null>;
const last = (db: ReturnType<typeof testStores>["db"]) => db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 1").get() as Row;

test("log stores the documented columns", () => {
  const { db, audit } = testStores();
  audit.log({
    credentialId: "k1", credentialName: "claude-ai", tool: "ops_list_servers", server: "ovh-prod-1", stack: "obs", service: "obs_loki",
    query: "{a=\"b\"}", queryHash: "abc", window: "2026-01-01T00:00:00.000Z/2026-01-01T01:00:00.000Z", resultBytes: 1234, truncated: true, result: "ok", clientIp: "1.2.3.4",
  });
  const r = last(db);
  assert.equal(r.credential_id, "k1");
  assert.equal(r.tool, "ops_list_servers");
  assert.equal(r.server, "ovh-prod-1");
  assert.equal(r.stack, "obs");
  assert.equal(r.service, "obs_loki");
  assert.equal(r.query_hash, "abc");
  assert.equal(r.window, "2026-01-01T00:00:00.000Z/2026-01-01T01:00:00.000Z");
  assert.equal(r.result_bytes, 1234);
  assert.equal(r.truncated, 1);
  assert.equal(r.result, "ok");
  assert.equal(r.client_ip, "1.2.3.4");
  assert.match(String(r.ts), /^\d{4}-\d\d-\d\dT/);
});

test("logAuthFailure writes a credential-less denied row", () => {
  const { db, audit } = testStores();
  audit.logAuthFailure({ clientIp: "9.9.9.9", reason: "bad token" });
  const r = last(db);
  assert.equal(r.tool, "auth");
  assert.equal(r.result, "denied");
  assert.equal(r.credential_id, null);
  assert.equal(r.detail, "bad token");
});

test("free-text fields are truncated", () => {
  const { db, audit } = testStores();
  const big = "x".repeat(10_000);
  audit.log({ credentialId: "t", credentialName: "t", tool: "t", server: big, stack: big, service: big, query: big, detail: big, result: "ok" });
  const r = last(db);
  for (const k of ["server", "stack", "service", "query", "detail"]) assert.equal(String(r[k]).length, MAX_FIELD_LEN, k);
});

test("safeLog swallows write failures", () => {
  const { db, audit } = testStores();
  db.exec("DROP TABLE audit_log");
  const prev = console.error;
  console.error = () => {};
  try {
    assert.doesNotThrow(() => audit.safeLog({ credentialId: null, credentialName: null, tool: "t", result: "ok" }));
  } finally {
    console.error = prev;
  }
});

test("prune deletes only old rows and validates the range", () => {
  const { db, audit } = testStores();
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  for (let i = 0; i < 2; i++) db.prepare("INSERT INTO audit_log (ts, tool, result) VALUES (?, 'old', 'ok')").run(old);
  audit.log({ credentialId: "t", credentialName: "t", tool: "new", result: "ok" });
  assert.equal(audit.prune(30), 2);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM audit_log").get() as { c: number }).c, 1);
  assert.throws(() => audit.prune(-1), /between 0 and/);
  assert.throws(() => audit.prune(999_999_999), /between 0 and 36500/);
  assert.equal(audit.prune(36500), 0);
});

test("query paginates newest first and filters", () => {
  const { audit } = testStores();
  for (let i = 0; i < AUDIT_PAGE_SIZE + 5; i++) audit.log({ credentialId: "t", credentialName: i % 2 ? "odd" : "even", tool: "t", result: "ok" });
  const p1 = audit.query({});
  assert.equal(p1.rows.length, AUDIT_PAGE_SIZE);
  assert.ok(p1.nextBefore);
  assert.ok(p1.rows[0]!.id > p1.rows[1]!.id);
  const p2 = audit.query({ before: p1.nextBefore! });
  assert.equal(p2.rows.length, 5);
  assert.equal(p2.nextBefore, null);
  assert.ok(audit.query({ credentialName: "odd" }).rows.every((r) => r.credential_name === "odd"));
  assert.equal(audit.query({ tool: "nope" }).rows.length, 0);
});
