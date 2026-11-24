// vendored from second-brain-mcp@d4ba1c5
// x-api-key is the only header name claude.ai connectors accept.
import { randomBytes, randomUUID } from "node:crypto";
import type { Db } from "../db";
import { seal as sealWith, unseal as unsealWith } from "./sealed";
import { cleanName, LAST_USED_THROTTLE_MS, sha256Hex } from "./tokens";

export const CONNECTOR_HEADER = "x-api-key";

export interface ConnectorKeyEntry {
  id: string;
  name: string;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

export type Reveal = { status: "ok"; id: string; name: string; key: string } | { status: "missing" } | { status: "ambiguous" } | { status: "undecryptable" };

const KEY_INFO = "connector-keys-v1";
const seal = (plain: string, id: string, secret: string): string => sealWith(plain, id, secret, KEY_INFO);
const unseal = (blob: string, id: string, secret: string): string | null => unsealWith(blob, id, secret, KEY_INFO);

export class ConnectorKeyStore {
  constructor(private readonly db: Db) {}

  // `secret` = ADMIN_WEB_SECRET; without it the key still works but cannot be revealed later.
  create(name: unknown, secret?: string): { id: string; name: string; key: string } {
    const n = cleanName(name);
    const id = randomUUID();
    const key = `opsk_${randomBytes(32).toString("base64url")}`;
    this.db
      .prepare("INSERT INTO connector_keys (id, name, key_hash, key_enc, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, n, sha256Hex(key), secret ? seal(key, id, secret) : null, new Date().toISOString());
    return { id, name: n, key };
  }

  // The key's identity when it exists and is not revoked; null otherwise.
  check(plain: unknown): { id: string; name: string } | null {
    if (typeof plain !== "string" || plain.length < 8 || plain.length > 200) return null;
    const row = this.db.prepare("SELECT id, name, revoked_at, last_used_at FROM connector_keys WHERE key_hash = ?").get(sha256Hex(plain)) as
      | { id: string; name: string; revoked_at: string | null; last_used_at: string | null }
      | undefined;
    if (!row || row.revoked_at) return null;
    const now = Date.now();
    const last = row.last_used_at ? Date.parse(row.last_used_at) : NaN;
    if (Number.isNaN(last) || last > now || now - last >= LAST_USED_THROTTLE_MS) {
      try {
        this.db.prepare("UPDATE connector_keys SET last_used_at = ? WHERE id = ?").run(new Date(now).toISOString(), row.id);
      } catch {
        /* best effort */
      }
    }
    return { id: row.id, name: row.name };
  }

  // Decrypts an active key by id or by (unambiguous) name. "undecryptable": the secret changed or the key
  // was created without one; the key itself still authenticates through its hash.
  reveal(ref: { id?: string; name?: string }, secret?: string): Reveal {
    const rows = (
      ref.id !== undefined
        ? this.db.prepare("SELECT id, name, key_enc FROM connector_keys WHERE id = ? AND revoked_at IS NULL").all(ref.id)
        : this.db.prepare("SELECT id, name, key_enc FROM connector_keys WHERE name = ? AND revoked_at IS NULL").all(ref.name ?? "")
    ) as Array<{ id: string; name: string; key_enc: string | null }>;
    if (rows.length !== 1) return { status: rows.length === 0 ? "missing" : "ambiguous" };
    const r = rows[0]!;
    const key = r.key_enc && secret ? unseal(r.key_enc, r.id, secret) : null;
    return key === null ? { status: "undecryptable" } : { status: "ok", id: r.id, name: r.name, key };
  }

  list(): ConnectorKeyEntry[] {
    return this.db.prepare("SELECT id, name, created_at, revoked_at, last_used_at FROM connector_keys ORDER BY created_at, rowid").all() as unknown as ConnectorKeyEntry[];
  }

  revoke(id: string): boolean {
    return this.db.prepare("UPDATE connector_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(new Date().toISOString(), id).changes > 0;
  }
}
