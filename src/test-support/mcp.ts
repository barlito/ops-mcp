import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ClusterSource, ClusterSourceProvider } from "../cluster/ClusterSource";
import type { PromApi } from "../metrics/PromClient";
import type { AuthContext } from "../platform/auth/context";
import { registerTools, type ToolDefinition, type ToolDeps } from "../tools/contract";
import { testRegistry, testStores, type TestStores } from "./fixtures";

export const TEST_AUTH: AuthContext = { credentialId: "cred-1", name: "test-client", kind: "token", clientIp: "10.0.0.1" };

export const fakeCluster = (impl: (slug: string) => ClusterSource): ClusterSourceProvider => (server) => impl(server.slug);

export const fakeProm = (over: Partial<PromApi> = {}): PromApi => ({
  query: async () => [],
  queryRange: async () => [],
  alerts: async () => [],
  ...over,
});

export async function connect(tools: ToolDefinition[], over: Partial<ToolDeps> = {}) {
  const stores: TestStores = testStores();
  const deps: ToolDeps = {
    registry: testRegistry(),
    audit: stores.audit,
    cluster: fakeCluster(() => ({ info: async () => ({ reachable: true, swarm: true, dockerVersion: "29.0.0" }) })),
    prom: fakeProm(),
    now: () => new Date("2026-06-01T12:00:00.000Z"),
    ...over,
  };
  const server = new McpServer({ name: "test", version: "0" });
  registerTools(server, tools, deps, TEST_AUTH);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "client", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { client, call, stores, deps };
}

export const textOf = (r: CallToolResult): string => (r.content[0] as { text: string }).text;
