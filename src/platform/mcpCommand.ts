// vendored from second-brain-mcp@d4ba1c5

export const DEFAULT_MCP_URL = "https://ops.barlito.fr/mcp";

// PUBLIC_MCP_URL when it is a clean http(s) URL, else the default (with a warning).
export function mcpUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.PUBLIC_MCP_URL?.trim();
  if (!raw) return DEFAULT_MCP_URL;
  try {
    const u = new URL(raw);
    if ((u.protocol === "http:" || u.protocol === "https:") && !/[\s"'`\\]/.test(raw)) return raw;
  } catch {
    /* falls through */
  }
  console.error(`warning: PUBLIC_MCP_URL is not a valid http(s) URL; using ${DEFAULT_MCP_URL}`);
  return DEFAULT_MCP_URL;
}

// `header` is the full `Name: value` pair, e.g. `Authorization: Bearer <token>` or `x-api-key: <key>`.
export function claudeAddCommand(url: string, header: string): string {
  return `claude mcp add --scope user --transport http ops '${url}' --header "${header}"`;
}
