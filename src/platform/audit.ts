// vendored from second-brain-mcp@d4ba1c5
import type { Db } from "./db";
import { errorMessage, redact } from "./util";

export interface AuditEntry {
  credentialId: string | null;
  credentialName: string | null;
  // Tool name, or the event kind for auth failures and admin actions.
  tool: string;
  server?: string;
  stack?: string;
  service?: string;
  // Raw query text (truncated) and its hash; never the tool result.
  query?: string;
  queryHash?: string;
  window?: string;
  resultBytes?: number;
  truncated?: boolean;
  // "ok" or an error code.
  result: string;
  detail?: string;
  clientIp?: string;
}

export interface AuditRow {
  id: number;
  ts: string;
  credential_id: string | null;
  credential_name: string | null;
  tool: string;
  server: string | null;
  stack: string | null;
  service: string | null;
  query: string | null;
  query_hash: string | null;
  window: string | null;
  result_bytes: number | null;
  truncated: number | null;
  result: string;
  detail: string | null;
  client_ip: string | null;
}

// Caps attacker-controllable free text so it can't bloat the DB.
export const MAX_FIELD_LEN = 256;
export const MAX_PRUNE_DAYS = 36500;
export const AUDIT_PAGE_SIZE = 50;

function cap(v: string | null | undefined): string | null {
  if (v == null) return null;
  return v.length > MAX_FIELD_LEN ? v.slice(0, MAX_FIELD_LEN) : v;
}

const COLUMNS =
  'id, ts, credential_id, credential_name, tool, server, stack, service, query, query_hash, "window", result_bytes, truncated, result, detail, client_ip';

export class AuditLog {
  private readonly insert;
  private readonly pruneStmt;

  constructor(private readonly db: Db) {
    this.insert = db.prepare(
      `INSERT INTO audit_log (ts, credential_id, credential_name, tool, server, stack, service, query, query_hash, "window", result_bytes, truncated, result, detail, client_ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.pruneStmt = db.prepare("DELETE FROM audit_log WHERE ts < ?");
  }

  log(e: AuditEntry): void {
    this.insert.run(
      new Date().toISOString(),
      cap(e.credentialId),
      cap(e.credentialName),
      cap(e.tool),
      cap(e.server),
      cap(e.stack),
      cap(e.service),
      cap(e.query),
      cap(e.queryHash),
      cap(e.window),
      e.resultBytes ?? null,
      e.truncated === undefined ? null : e.truncated ? 1 : 0,
      cap(e.result),
      cap(e.detail),
      cap(e.clientIp),
    );
  }

  // An audit failure must never turn into a client-visible failure: log it and carry on.
  safeLog(e: AuditEntry): void {
    try {
      this.log(e);
    } catch (err) {
      console.error(`audit write failed (tool=${e.tool} result=${e.result}): ${redact(errorMessage(err))}`);
    }
  }

  // Records a failed authentication attempt (no credential identity).
  logAuthFailure(opts: { clientIp?: string; reason: string }): void {
    this.log({ credentialId: null, credentialName: null, tool: "auth", result: "denied", clientIp: opts.clientIp, detail: opts.reason });
  }

  // Deletes audit rows older than N days; returns the number deleted.
  prune(olderThanDays: number): number {
    if (!Number.isFinite(olderThanDays) || olderThanDays < 0 || olderThanDays > MAX_PRUNE_DAYS) {
      throw new Error(`olderThanDays must be between 0 and ${MAX_PRUNE_DAYS}`);
    }
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    return this.pruneStmt.run(cutoff).changes;
  }

  // Newest first, keyset-paginated on id: one extra row tells whether another page exists.
  query(f: { before?: number; credentialName?: string; tool?: string }): { rows: AuditRow[]; nextBefore: number | null } {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (f.before !== undefined) {
      where.push("id < ?");
      args.push(f.before);
    }
    if (f.credentialName !== undefined) {
      where.push("credential_name = ?");
      args.push(f.credentialName);
    }
    if (f.tool !== undefined) {
      where.push("tool = ?");
      args.push(f.tool);
    }
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM audit_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`)
      .all(...args, AUDIT_PAGE_SIZE + 1) as unknown as AuditRow[];
    const more = rows.length > AUDIT_PAGE_SIZE;
    const page = more ? rows.slice(0, AUDIT_PAGE_SIZE) : rows;
    return { rows: page, nextBefore: more ? page[page.length - 1]!.id : null };
  }
}
