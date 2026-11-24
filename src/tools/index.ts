import type { ToolDefinition } from "./contract";
import { opsListServers } from "./opsListServers";
import { opsLogsContext } from "./opsLogsContext";
import { opsLogsQuery } from "./opsLogsQuery";
import { opsLogsQueryRaw } from "./opsLogsQueryRaw";
import { opsLogsSummary } from "./opsLogsSummary";

// Add new tools here (one line each, one file per tool).
export const TOOLS: ToolDefinition[] = [opsListServers, opsLogsSummary, opsLogsQuery, opsLogsContext, opsLogsQueryRaw];
