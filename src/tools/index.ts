import type { ToolDefinition } from "./contract";
import { opsAlerts } from "./opsAlerts";
import { opsGetService } from "./opsGetService";
import { opsHostMetrics } from "./opsHostMetrics";
import { opsListServers } from "./opsListServers";
import { opsListStacks } from "./opsListStacks";
import { opsListTasks } from "./opsListTasks";
import { opsLogsContext } from "./opsLogsContext";
import { opsLogsQuery } from "./opsLogsQuery";
import { opsLogsQueryRaw } from "./opsLogsQueryRaw";
import { opsLogsSummary } from "./opsLogsSummary";
import { opsMetricsQuery } from "./opsMetricsQuery";
import { opsOverview } from "./opsOverview";
import { opsRecentDeploys } from "./opsRecentDeploys";
import { opsServiceMetrics } from "./opsServiceMetrics";

// Add new tools here (one line each, one file per tool).
export const TOOLS: ToolDefinition[] = [opsListServers, opsOverview, opsListStacks, opsGetService, opsListTasks, opsRecentDeploys, opsLogsSummary, opsLogsQuery, opsLogsContext, opsLogsQueryRaw, opsServiceMetrics, opsHostMetrics, opsMetricsQuery, opsAlerts];
