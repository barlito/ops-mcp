import type { ToolDefinition } from "./contract";
import { opsGetService } from "./opsGetService";
import { opsListServers } from "./opsListServers";
import { opsLogsContext } from "./opsLogsContext";
import { opsLogsQuery } from "./opsLogsQuery";
import { opsLogsQueryRaw } from "./opsLogsQueryRaw";
import { opsLogsSummary } from "./opsLogsSummary";
import { opsListStacks } from "./opsListStacks";
import { opsListTasks } from "./opsListTasks";
import { opsOverview } from "./opsOverview";
import { opsRecentDeploys } from "./opsRecentDeploys";

// Add new tools here (one line each, one file per tool).
export const TOOLS: ToolDefinition[] = [opsListServers, opsOverview, opsListStacks, opsGetService, opsListTasks, opsRecentDeploys, opsLogsSummary, opsLogsQuery, opsLogsContext, opsLogsQueryRaw];
