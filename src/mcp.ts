import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_INSTRUCTIONS } from "./instructions";
import { APP_VERSION } from "./version";
import type { AuthContext } from "./platform/auth/context";
import { registerTools, type ToolDeps } from "./tools/contract";
import { TOOLS } from "./tools";

// A fresh McpServer is created per HTTP request (stateless Streamable HTTP), bound to the caller.
export function createMcpServer(deps: ToolDeps, auth: AuthContext): McpServer {
  const server = new McpServer({ name: "ops-mcp", version: APP_VERSION }, { instructions: SERVER_INSTRUCTIONS });
  registerTools(server, TOOLS, deps, auth);
  return server;
}
