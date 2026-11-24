import { test } from "node:test";
import assert from "node:assert/strict";
import { testStores } from "../../test-support/fixtures";
import { CONNECTOR_HEADER } from "./connectorKeys";
import { CredentialError, resolveExpiry } from "./tokens";
import { seal, unseal } from "./sealed";

test("create returns a usable token that check accepts", () => {
  const { tokens } = testStores();
  const created = tokens.create("laptop");
  assert.match(created.token, /^ops_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(tokens.check(created.token), { status: "ok", id: created.id, name: "laptop" });
});

test("unknown, garbage and revoked tokens are invalid", () => {
  const { tokens } = testStores();
  const created = tokens.create("t");
  assert.equal(tokens.check("garbage").status, "invalid");
  assert.equal(tokens.check("ops_" + "a".repeat(43)).status, "invalid");
  assert.equal(tokens.revoke(created.id), true);
  assert.equal(tokens.revoke(created.id), false);
  assert.equal(tokens.check(created.token).status, "invalid");
});

test("the plaintext token is never stored", () => {
  const { db, tokens } = testStores();
  const created = tokens.create("t");
  const row = db.prepare("SELECT * FROM tokens").get() as Record<string, unknown>;
  assert.ok(!JSON.stringify(row).includes(created.token));
});

test("an expired token is reported as expired, not invalid", () => {
  const { db, tokens } = testStores();
  const created = tokens.create("t", { expiresInDays: 1 });
  db.prepare("UPDATE tokens SET expires_at = ?").run(new Date(Date.now() - 1000).toISOString());
  assert.equal(tokens.check(created.token).status, "expired");
  assert.equal(tokens.list()[0]?.expired, true);
  assert.equal(tokens.countActive(), 0);
});

test("an unparseable expiry fails closed", () => {
  const { db, tokens } = testStores();
  const created = tokens.create("t");
  db.prepare("UPDATE tokens SET expires_at = 'not-a-date'").run();
  assert.equal(tokens.check(created.token).status, "expired");
});

test("last_used_at is written once per throttle window", () => {
  const { db, tokens } = testStores();
  const created = tokens.create("t");
  const last = () => (db.prepare("SELECT last_used_at FROM tokens").get() as { last_used_at: string | null }).last_used_at;
  assert.equal(last(), null);
  tokens.check(created.token);
  const first = last();
  assert.ok(first);
  tokens.check(created.token);
  assert.equal(last(), first);
});

test("list reports revoked and active tokens, countActive skips revoked", () => {
  const { tokens } = testStores();
  const a = tokens.create("a");
  tokens.create("b");
  tokens.revoke(a.id);
  assert.equal(tokens.list().length, 2);
  assert.equal(tokens.countActive(), 1);
});

test("names are validated", () => {
  const { tokens, connectorKeys } = testStores();
  for (const bad of ["", "   ", "x".repeat(65), "a\nb", "a‮b", 42, undefined]) {
    assert.throws(() => tokens.create(bad), CredentialError);
    assert.throws(() => connectorKeys.create(bad), CredentialError);
  }
  assert.equal(tokens.create("  padded  ").name, "padded");
});

test("resolveExpiry validates days and timestamps", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(resolveExpiry({}, now), null);
  assert.equal(resolveExpiry({ expiresInDays: 1 }, now), "2026-01-02T00:00:00.000Z");
  assert.equal(resolveExpiry({ expiresAt: "2026-02-01T00:00:00Z" }, now), "2026-02-01T00:00:00.000Z");
  for (const bad of [{ expiresInDays: 0 }, { expiresInDays: 3651 }, { expiresInDays: 1.5 }, { expiresAt: "2026-02-01T00:00:00" }, { expiresAt: "2025-01-01T00:00:00Z" }, { expiresAt: "2040-01-01T00:00:00Z" }, { expiresAt: "2026-02-01T00:00:00Z", expiresInDays: 1 }]) {
    assert.throws(() => resolveExpiry(bad, now), CredentialError, JSON.stringify(bad));
  }
});

test("connector key: create, check, revoke", () => {
  const { connectorKeys } = testStores();
  const k = connectorKeys.create("claude-ai", "s3cret");
  assert.match(k.key, /^opsk_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(connectorKeys.check(k.key), { id: k.id, name: "claude-ai" });
  assert.equal(connectorKeys.check("nope-nope-nope"), null);
  assert.equal(connectorKeys.check(undefined), null);
  assert.equal(connectorKeys.check("x".repeat(201)), null);
  assert.equal(connectorKeys.revoke(k.id), true);
  assert.equal(connectorKeys.revoke(k.id), false);
  assert.equal(connectorKeys.check(k.key), null);
  assert.equal(CONNECTOR_HEADER, "x-api-key");
});

test("connector key: reveal decrypts with the same secret only", () => {
  const { connectorKeys } = testStores();
  const k = connectorKeys.create("a", "s3cret");
  assert.deepEqual(connectorKeys.reveal({ id: k.id }, "s3cret"), { status: "ok", id: k.id, name: "a", key: k.key });
  assert.deepEqual(connectorKeys.reveal({ name: "a" }, "s3cret"), { status: "ok", id: k.id, name: "a", key: k.key });
  assert.equal(connectorKeys.reveal({ id: k.id }, "other").status, "undecryptable");
  assert.equal(connectorKeys.reveal({ id: k.id }).status, "undecryptable");
  assert.equal(connectorKeys.reveal({ id: "missing" }, "s3cret").status, "missing");
  const noSecret = connectorKeys.create("b");
  assert.equal(connectorKeys.reveal({ id: noSecret.id }, "s3cret").status, "undecryptable");
  assert.ok(connectorKeys.check(noSecret.key));
  connectorKeys.create("a", "s3cret");
  assert.equal(connectorKeys.reveal({ name: "a" }, "s3cret").status, "ambiguous");
  connectorKeys.revoke(k.id);
  assert.equal(connectorKeys.reveal({ id: k.id }, "s3cret").status, "missing");
});

test("sealed values are bound to secret, label and aad", () => {
  const blob = seal("hello", "id-1", "secret", "label");
  assert.equal(unseal(blob, "id-1", "secret", "label"), "hello");
  assert.equal(unseal(blob, "id-2", "secret", "label"), null);
  assert.equal(unseal(blob, "id-1", "other", "label"), null);
  assert.equal(unseal(blob, "id-1", "secret", "other"), null);
  assert.equal(unseal("AAAA", "id-1", "secret", "label"), null);
});
