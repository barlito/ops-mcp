#!/usr/bin/env node
// vendored from second-brain-mcp@d4ba1c5
import { parseArgs as nodeParseArgs } from "node:util";
import { CredentialError } from "../auth/tokens";
import { claudeAddCommand, mcpUrl } from "../mcpCommand";
import { fail, openCli } from "./context";

type Cli = ReturnType<typeof openCli>;

// Returns the text to print; throws Error with a clear message on failure.
export function run(cli: Cli, argv: string[]): string {
  const [command, ...rest] = argv;
  switch (command) {
    case "create": {
      const { values } = nodeParseArgs({ args: rest, options: { name: { type: "string" }, "expires-in-days": { type: "string" } } });
      const days = values["expires-in-days"];
      if (days !== undefined && !/^\d+$/.test(days)) throw new Error("--expires-in-days must be an integer between 1 and 3650");
      let created;
      try {
        created = cli.tokens.create(values.name, { expiresInDays: days === undefined ? undefined : Number(days) });
      } catch (err) {
        if (err instanceof CredentialError) throw new Error(err.message);
        throw err;
      }
      cli.log("admin_token_create", "ok", `${created.id} ${created.name}`);
      // Printed to stdout only (never audited or logged): it embeds the token.
      return [
        "Token created. The plaintext token is shown ONLY ONCE below, store it now:",
        "",
        `  id:    ${created.id}`,
        `  token: ${created.token}`,
        ...(created.expires_at ? [`  expires_at: ${created.expires_at}`] : []),
        "",
        "Register it in Claude Code (never paste it into a chat):",
        "",
        claudeAddCommand(mcpUrl(), `Authorization: Bearer ${created.token}`),
      ].join("\n");
    }
    case "list": {
      const tokens = cli.tokens.list();
      if (tokens.length === 0) return "No tokens.";
      return tokens
        .map((t) =>
          [
            `id=${t.id}`,
            `name=${t.name}`,
            `created_at=${t.created_at}`,
            `revoked_at=${t.revoked_at ?? "-"}`,
            `last_used_at=${t.last_used_at ?? "never"}`,
            `expires_at=${t.expires_at ? t.expires_at + (t.expired ? " (EXPIRED)" : "") : "-"}`,
          ].join("  "),
        )
        .join("\n");
    }
    case "revoke": {
      const { values } = nodeParseArgs({ args: rest, options: { id: { type: "string" } } });
      if (!values.id) throw new Error("--id is required");
      const ok = cli.tokens.revoke(values.id);
      cli.log("admin_token_revoke", ok ? "ok" : "error", ok ? values.id : `${values.id} not found or already revoked`);
      if (!ok) throw new Error(`token ${values.id} not found (or already revoked)`);
      return `Token ${values.id} revoked.`;
    }
    default:
      throw new Error(`unknown command "${command}". Usage: token.js <create --name N [--expires-in-days N] | list | revoke --id ID>`);
  }
}

if (require.main === module) {
  try {
    console.log(run(openCli(), process.argv.slice(2)));
  } catch (err) {
    fail((err as Error).message);
  }
}
