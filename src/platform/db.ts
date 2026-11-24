// vendored from second-brain-mcp@d4ba1c5
import Database from "better-sqlite3";
import { chmodSync, closeSync, existsSync, openSync } from "node:fs";

// Ordered migrations; index + 1 == schema version stored in PRAGMA user_version.
// Never edit a released migration: append a new one.
export interface Migration {
  // Tables the migration modifies; only these are FK-checked afterwards.
  tables: string[];
  up: (d: Database.Database) => void;
}

export const MIGRATIONS: ReadonlyArray<Migration> = [
  {
    tables: [],
    up: (d) => {
      d.exec(`
        CREATE TABLE tokens (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          expires_at TEXT,
          revoked_at TEXT,
          last_used_at TEXT
        );
        CREATE TABLE connector_keys (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          key_hash TEXT NOT NULL UNIQUE,
          key_enc TEXT,
          created_at TEXT NOT NULL,
          revoked_at TEXT,
          last_used_at TEXT
        );
        CREATE TABLE audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL,
          credential_id TEXT,
          credential_name TEXT,
          tool TEXT NOT NULL,
          server TEXT,
          stack TEXT,
          service TEXT,
          query TEXT,
          query_hash TEXT,
          "window" TEXT,
          result_bytes INTEGER,
          truncated INTEGER,
          result TEXT NOT NULL,
          detail TEXT,
          client_ip TEXT
        );
        CREATE INDEX idx_audit_ts ON audit_log(ts);
      `);
    },
  },
];

// Applies migration index `v` under BEGIN IMMEDIATE. user_version is re-read inside the
// write lock so a concurrent process that already applied it makes this a no-op.
export function migrateStep(d: Database.Database, v: number, migrations: ReadonlyArray<Migration> = MIGRATIONS): void {
  d.transaction(() => {
    const cur = d.pragma("user_version", { simple: true }) as number;
    if (cur > v) return;
    migrations[v].up(d);
    d.pragma(`user_version = ${v + 1}`);
    for (const t of migrations[v].tables) {
      const bad = d.pragma(`foreign_key_check(${JSON.stringify(t)})`) as unknown[];
      if (bad.length > 0) throw new Error(`migration ${v + 1} left foreign key violations in ${t}`);
    }
  }).immediate();
}

// Applies pending migrations, each in its own transaction. Idempotent and multi-process safe.
export function runMigrations(d: Database.Database, migrations: ReadonlyArray<Migration> = MIGRATIONS): void {
  const current = d.pragma("user_version", { simple: true }) as number;
  if (current > migrations.length) {
    throw new Error(`DB schema version ${current} is newer than this build supports (${migrations.length})`);
  }
  // foreign_keys can't be toggled inside a transaction; off while rebuilding tables.
  const fkWasOn = d.pragma("foreign_keys", { simple: true }) === 1;
  if (fkWasOn) d.pragma("foreign_keys = OFF");
  try {
    for (let v = current; v < migrations.length; v++) migrateStep(d, v, migrations);
    // Pre-existing violations in untouched tables must not brick startup; just report.
    const bad = d.pragma("foreign_key_check") as unknown[];
    if (bad.length > 0) console.warn(`warning: ${bad.length} pre-existing foreign key violation(s) in DB`);
  } finally {
    if (fkWasOn) d.pragma("foreign_keys = ON");
  }
}

export type Db = Database.Database;

export function openDb(path: string): Db {
  // Create the file 0600 up front so the token-hash DB is never world-readable.
  if (path !== ":memory:") {
    if (!existsSync(path)) closeSync(openSync(path, "a", 0o600));
    try {
      chmodSync(path, 0o600);
    } catch {
      // best effort (e.g. file owned by another user)
    }
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  runMigrations(db);
  return db;
}
