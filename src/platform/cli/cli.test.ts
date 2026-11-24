import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { AuditLog } from "../audit";
import { ConnectorKeyStore } from "../auth/connectorKeys";
import { TokenStore } from "../auth/tokens";
import { openDb } from "../db";
import { cleanup, testStores, tmp } from "../../test-support/fixtures";
import { backupDb, parseDays } from "./maintenance";
import { run as runConnectorKey } from "./connectorKey";
import { run as runToken } from "./token";

after(cleanup);

function cli() {
  const s = testStores();
  return { ...s, log: (tool: string, result: "ok" | "error", detail: string) => s.audit.safeLog({ credentialId: "cli", credentialName: "cli", tool, result, detail }) };
}

test("token CLI: create prints the token once, list hides it, revoke works, all audited", () => {
  const c = cli();
  const out = runToken(c, ["create", "--name", "laptop", "--expires-in-days", "30"]);
  const token = /ops_[A-Za-z0-9_-]{43}/.exec(out)?.[0];
  assert.ok(token);
  assert.match(out, /claude mcp add --scope user --transport http ops/);
  assert.equal(c.tokens.check(token).status, "ok");
  const list = runToken(c, ["list"]);
  assert.match(list, /name=laptop/);
  assert.ok(!list.includes(token));
  const id = /id=([0-9a-f-]{36})/.exec(list)![1]!;
  assert.match(runToken(c, ["revoke", "--id", id]), /revoked/);
  assert.throws(() => runToken(c, ["revoke", "--id", id]), /not found/);
  assert.equal(c.tokens.check(token).status, "invalid");
  const audited = c.db.prepare("SELECT tool, result, detail FROM audit_log ORDER BY id").all() as Array<{ tool: string; result: string; detail: string }>;
  assert.deepEqual(audited.map((a) => [a.tool, a.result]), [["admin_token_create", "ok"], ["admin_token_revoke", "ok"], ["admin_token_revoke", "error"]]);
  assert.ok(!JSON.stringify(audited).includes(token));
});

test("token CLI: validation errors are clean messages", () => {
  const c = cli();
  assert.throws(() => runToken(c, ["create"]), /name must be 1-64/);
  assert.throws(() => runToken(c, ["create", "--name", "x", "--expires-in-days", "abc"]), /integer between 1 and 3650/);
  assert.throws(() => runToken(c, ["create", "--name", "x", "--expires-in-days", "0"]), /between 1 and 3650/);
  assert.throws(() => runToken(c, ["revoke"]), /--id is required/);
  assert.throws(() => runToken(c, ["nope"]), /unknown command/);
  assert.equal(runToken(c, ["list"]), "No tokens.");
});

test("connector key CLI: create, show again, list, revoke", () => {
  const c = cli();
  const out = runConnectorKey(c, ["create", "--name", "claude-ai"], "secret");
  const key = /opsk_[A-Za-z0-9_-]{43}/.exec(out)?.[0];
  assert.ok(key);
  assert.match(out, /x-api-key: opsk_/);
  assert.ok(c.connectorKeys.check(key));
  assert.match(runConnectorKey(c, ["show", "--name", "claude-ai"], "secret"), new RegExp(key));
  assert.throws(() => runConnectorKey(c, ["show", "--name", "claude-ai"], "other"), /cannot decrypt/);
  assert.throws(() => runConnectorKey(c, ["show", "--name", "ghost"], "secret"), /no such active connector key/);
  assert.throws(() => runConnectorKey(c, ["show"], "secret"), /--name or --id/);
  const list = runConnectorKey(c, ["list"]);
  assert.ok(!list.includes(key));
  const id = /id=([0-9a-f-]{36})/.exec(list)![1]!;
  assert.match(runConnectorKey(c, ["revoke", "--id", id]), /revoked/);
  assert.throws(() => runConnectorKey(c, ["revoke", "--id", id]), /not found/);
  assert.equal(c.connectorKeys.check(key), null);
  const reveals = c.db.prepare("SELECT detail FROM audit_log WHERE tool = 'connector_key_reveal'").all();
  assert.ok(!JSON.stringify(reveals).includes(key));
  assert.equal(reveals.length, 3);
});

test("maintenance: parseDays", () => {
  assert.equal(parseDays("30"), 30);
  assert.throws(() => parseDays(undefined), /non-negative integer/);
  assert.throws(() => parseDays("-1"), /non-negative integer/);
  assert.throws(() => parseDays("99999999"), /at most 36500/);
});

test("maintenance: backup is a consistent 0600 copy and never overwrites", async () => {
  const dir = tmp("backup");
  const db = openDb(join(dir, "ops.db"));
  new TokenStore(db).create("kept");
  new ConnectorKeyStore(db).create("key");
  new AuditLog(db).log({ credentialId: null, credentialName: null, tool: "t", result: "ok" });
  const dest = join(dir, "backups", "b.db");
  assert.equal(await backupDb(db, dest), dest);
  assert.ok(existsSync(dest));
  assert.equal(statSync(dest).mode & 0o777, 0o600);
  const copy = openDb(dest);
  assert.equal((copy.prepare("SELECT COUNT(*) c FROM tokens").get() as { c: number }).c, 1);
  await assert.rejects(backupDb(db, dest), /already exists/);
  assert.equal(statSync(join(dir, "ops.db")).mode & 0o777, 0o600);
});
