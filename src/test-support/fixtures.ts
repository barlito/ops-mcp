// Shared test fixtures. Excluded from the build via tsconfig "exclude".
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../platform/audit";
import { ConnectorKeyStore } from "../platform/auth/connectorKeys";
import { TokenStore } from "../platform/auth/tokens";
import { type Db, openDb } from "../platform/db";
import { parseRegistry, type Registry } from "../registry";

const dirs: string[] = [];

/** New tracked temp dir; removed by cleanup(). */
export function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `ops-${prefix}-`));
  dirs.push(d);
  return d;
}

export function cleanup(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

export function writeTemp(name: string, content: string): string {
  const path = join(tmp("file"), name);
  writeFileSync(path, content);
  return path;
}

export interface TestStores {
  db: Db;
  audit: AuditLog;
  tokens: TokenStore;
  connectorKeys: ConnectorKeyStore;
}

export function testStores(): TestStores {
  const db = openDb(":memory:");
  return { db, audit: new AuditLog(db), tokens: new TokenStore(db), connectorKeys: new ConnectorKeyStore(db) };
}

export const REGISTRY_YAML = `
tenants:
  - slug: barlito
servers:
  - slug: ovh-prod-1
    env: production
    kind: swarm
    tenant: barlito
    source: { type: local, url: "tcp://dockerproxy-ops:2375" }
  - slug: lab
    env: development
    kind: compose
    tenant: barlito
    source: { type: agent }
stack_projects:
  obs: observability-stack
`;

export function testRegistry(): Registry {
  return parseRegistry(REGISTRY_YAML);
}
