// vendored from second-brain-mcp@d4ba1c5
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Db } from "../db";

export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialError";
  }
}

// Only re-write last_used_at when the stored value is older than this.
export const LAST_USED_THROTTLE_MS = 60_000;
const MAX_EXPIRY_DAYS = 3650;

export const sha256Hex = (v: string): string => createHash("sha256").update(v).digest("hex");

// Names end up in the audit log and the admin UI.
export function cleanName(name: unknown): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (trimmed.length < 1 || trimmed.length > 64) throw new CredentialError("name must be 1-64 characters");
  if (/\p{Cc}|\p{Cf}|\p{Zl}|\p{Zp}/u.test(trimmed)) {
    throw new CredentialError("name must not contain control, format or newline characters");
  }
  return trimmed;
}

export interface CreateTokenOptions {
  expiresAt?: string; // ISO 8601 with Z/offset, in the future, at most 3650 days ahead
  expiresInDays?: number; // integer 1-3650; not combinable with expiresAt
}

// Returns the normalised ISO expiry, or null for "never". Throws CredentialError.
export function resolveExpiry(opts: CreateTokenOptions = {}, now = Date.now()): string | null {
  const { expiresAt, expiresInDays } = opts;
  if (expiresAt !== undefined && expiresInDays !== undefined) {
    throw new CredentialError("use either expiresAt or expiresInDays, not both");
  }
  if (expiresInDays !== undefined) {
    if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > MAX_EXPIRY_DAYS) {
      throw new CredentialError("expiresInDays must be an integer between 1 and 3650");
    }
    return new Date(now + expiresInDays * 86_400_000).toISOString();
  }
  if (expiresAt !== undefined) {
    // Explicit zone required: a zone-less string would be read in the server's local time.
    const ok =
      typeof expiresAt === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(expiresAt);
    const ms = ok ? Date.parse(expiresAt) : NaN;
    if (Number.isNaN(ms)) {
      throw new CredentialError("expiresAt must be ISO 8601 with an explicit Z or offset, e.g. 2027-01-31T00:00:00Z");
    }
    if (ms <= now) throw new CredentialError("expiresAt must be in the future");
    if (ms > now + MAX_EXPIRY_DAYS * 86_400_000) {
      throw new CredentialError(`expiresAt must be at most ${MAX_EXPIRY_DAYS} days ahead`);
    }
    return new Date(ms).toISOString();
  }
  return null;
}

export interface CreatedToken {
  id: string;
  name: string;
  token: string;
  expires_at: string | null;
}

export interface TokenListEntry {
  id: string;
  name: string;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  expires_at: string | null;
  expired: boolean;
}

export type TokenCheck = { status: "ok"; id: string; name: string } | { status: "expired" } | { status: "invalid" };

// The one expiry rule: stored value is canonical UTC ISO, compared chronologically via
// julianday. An unparseable value is expired (fail closed).
const EXPIRED_SQL =
  "(expires_at IS NOT NULL AND (julianday(expires_at) IS NULL OR julianday(expires_at) <= julianday('now')))";

export class TokenStore {
  private readonly insert;
  private readonly byHash;
  private readonly touch;
  private readonly revokeStmt;
  private readonly all;
  private readonly countActiveStmt;

  constructor(private readonly db: Db) {
    this.insert = db.prepare("INSERT INTO tokens (id, name, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)");
    this.byHash = db.prepare(`SELECT id, name, last_used_at, revoked_at, ${EXPIRED_SQL} AS expired FROM tokens WHERE token_hash = ?`);
    this.touch = db.prepare("UPDATE tokens SET last_used_at = ? WHERE id = ?");
    this.revokeStmt = db.prepare("UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL");
    this.all = db.prepare(
      `SELECT id, name, created_at, revoked_at, last_used_at, expires_at, ${EXPIRED_SQL} AS expired FROM tokens ORDER BY created_at, rowid`,
    );
    this.countActiveStmt = db.prepare(`SELECT COUNT(*) AS n FROM tokens WHERE revoked_at IS NULL AND NOT ${EXPIRED_SQL}`);
  }

  create(name: unknown, opts?: CreateTokenOptions): CreatedToken {
    const clean = cleanName(name);
    const expiresAt = resolveExpiry(opts);
    const id = randomUUID();
    const token = `ops_${randomBytes(32).toString("base64url")}`;
    this.insert.run(id, clean, sha256Hex(token), new Date().toISOString(), expiresAt);
    return { id, name: clean, token, expires_at: expiresAt };
  }

  // "expired" = known, non-revoked hash past its expiry; unknown and revoked are "invalid".
  check(plaintext: string): TokenCheck {
    const row = this.byHash.get(sha256Hex(plaintext)) as
      | { id: string; name: string; last_used_at: string | null; revoked_at: string | null; expired: number }
      | undefined;
    if (!row || row.revoked_at) return { status: "invalid" };
    if (row.expired) return { status: "expired" };

    // Throttled: avoid a synchronous write on every request.
    const now = Date.now();
    const last = row.last_used_at ? Date.parse(row.last_used_at) : NaN;
    // last > now: clock stepped back, treat as stale.
    if (Number.isNaN(last) || last > now || now - last >= LAST_USED_THROTTLE_MS) {
      // Best effort: a DB locked for longer than busy_timeout must not turn a valid request into a 500.
      try {
        this.touch.run(new Date(now).toISOString(), row.id);
      } catch (err) {
        console.error(`last_used_at update failed for token ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { status: "ok", id: row.id, name: row.name };
  }

  revoke(id: string): boolean {
    return this.revokeStmt.run(new Date().toISOString(), id).changes > 0;
  }

  list(): TokenListEntry[] {
    return (this.all.all() as Array<Omit<TokenListEntry, "expired"> & { expired: number }>).map((t) => ({ ...t, expired: t.expired === 1 }));
  }

  countActive(): number {
    return (this.countActiveStmt.get() as { n: number }).n;
  }
}
