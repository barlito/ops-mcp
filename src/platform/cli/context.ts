// vendored from second-brain-mcp@d4ba1c5
import { AuditLog } from "../audit";
import { ConnectorKeyStore } from "../auth/connectorKeys";
import { TokenStore } from "../auth/tokens";
import { openDb } from "../db";

// Audit identity for changes made from the command line (the web admin uses admin:<user>).
export const CLI_ACTOR = "cli";

export function openCli() {
  const path = process.env.DB_PATH;
  if (!path) throw new Error("DB_PATH environment variable is required");
  const db = openDb(path);
  const audit = new AuditLog(db);
  return {
    db,
    audit,
    tokens: new TokenStore(db),
    connectorKeys: new ConnectorKeyStore(db),
    log: (tool: string, result: "ok" | "error", detail: string): void =>
      audit.safeLog({ credentialId: CLI_ACTOR, credentialName: CLI_ACTOR, tool, result, detail }),
  };
}

export function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}
