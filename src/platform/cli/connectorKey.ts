#!/usr/bin/env node
// vendored from second-brain-mcp@d4ba1c5
// Connector key management (direct DB access, like token.ts). The key is printed once, never audited.
import { parseArgs as nodeParseArgs } from "node:util";
import { CONNECTOR_HEADER } from "../auth/connectorKeys";
import { CredentialError } from "../auth/tokens";
import { claudeAddCommand, mcpUrl } from "../mcpCommand";
import { readSecret } from "../util";
import { fail, openCli } from "./context";

type Cli = ReturnType<typeof openCli>;

// Returns the text to print; throws Error with a clear message on failure.
export function run(cli: Cli, argv: string[], secret = readSecret("ADMIN_WEB_SECRET")): string {
  const { values, positionals } = nodeParseArgs({ args: argv, allowPositionals: true, options: { name: { type: "string" }, id: { type: "string" } } });
  switch (positionals[0]) {
    case "create": {
      let c;
      try {
        c = cli.connectorKeys.create(values.name, secret);
      } catch (err) {
        if (err instanceof CredentialError) throw new Error(err.message);
        throw err;
      }
      cli.log("admin_connector_key_create", "ok", `${c.id} ${c.name}`);
      return [
        "Connector key created (`make connector-key-show name=...` shows it again):",
        "",
        `  id:     ${c.id}`,
        `  header: ${CONNECTOR_HEADER}: ${c.key}`,
        "",
        "claude.ai: custom connector, Authentication none, add the request header above (required).",
        "Claude Code:",
        claudeAddCommand(mcpUrl(), `${CONNECTOR_HEADER}: ${c.key}`),
      ].join("\n");
    }
    case "list": {
      const keys = cli.connectorKeys.list();
      if (keys.length === 0) return "No connector keys.";
      return keys.map((k) => `id=${k.id}  name=${k.name}  created_at=${k.created_at}  revoked_at=${k.revoked_at ?? "-"}  last_used_at=${k.last_used_at ?? "never"}`).join("\n");
    }
    case "show": {
      const ref = values.id ? { id: values.id } : values.name ? { name: values.name } : undefined;
      if (!ref) throw new Error("--name or --id is required");
      const r = cli.connectorKeys.reveal(ref, secret);
      cli.log("connector_key_reveal", r.status === "ok" ? "ok" : "error", `${values.id ?? values.name} ${r.status}`);
      if (r.status === "missing") throw new Error("no such active connector key");
      if (r.status === "ambiguous") throw new Error(`several active keys are named "${values.name}": ambiguous name, use --id (see list)`);
      if (r.status === "undecryptable") throw new Error("cannot decrypt this key (ADMIN_WEB_SECRET changed, or it was created without one): create a new key. It still works as is.");
      return `id:     ${r.id}\nheader: ${CONNECTOR_HEADER}: ${r.key}`;
    }
    case "revoke": {
      if (!values.id) throw new Error("--id is required");
      const ok = cli.connectorKeys.revoke(values.id);
      cli.log("admin_connector_key_revoke", ok ? "ok" : "error", ok ? values.id : `${values.id} not found or already revoked`);
      if (!ok) throw new Error(`connector key ${values.id} not found (or already revoked)`);
      return `Connector key ${values.id} revoked.`;
    }
    default:
      throw new Error("usage: connectorKey.js <create --name N | show --name N|--id ID | list | revoke --id ID>");
  }
}

if (require.main === module) {
  try {
    console.log(run(openCli(), process.argv.slice(2)));
  } catch (err) {
    fail((err as Error).message);
  }
}
