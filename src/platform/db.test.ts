import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { MIGRATIONS, openDb, runMigrations } from "./db";

test("openDb creates the schema and is idempotent", () => {
  const db = openDb(":memory:");
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((t) => t.name).sort();
  assert.deepEqual(tables, ["audit_log", "connector_keys", "tokens"]);
  assert.equal(db.pragma("user_version", { simple: true }), MIGRATIONS.length);
  runMigrations(db);
  assert.equal(db.pragma("user_version", { simple: true }), MIGRATIONS.length);
});

test("audit_log has the documented columns", () => {
  const db = openDb(":memory:");
  const cols = (db.prepare("PRAGMA table_info(audit_log)").all() as Array<{ name: string }>).map((c) => c.name);
  for (const c of ["ts", "credential_id", "tool", "server", "stack", "service", "query_hash", "window", "result_bytes", "truncated", "result", "client_ip"]) {
    assert.ok(cols.includes(c), c);
  }
});

test("a database from a newer build is refused", () => {
  const db = new Database(":memory:");
  db.pragma(`user_version = ${MIGRATIONS.length + 1}`);
  assert.throws(() => runMigrations(db), /newer than this build supports/);
});

test("migrations apply in order and only once", () => {
  const db = new Database(":memory:");
  const log: number[] = [];
  const migrations = [1, 2, 3].map((n) => ({ tables: [], up: () => void log.push(n) }));
  runMigrations(db, migrations);
  runMigrations(db, migrations);
  assert.deepEqual(log, [1, 2, 3]);
});
