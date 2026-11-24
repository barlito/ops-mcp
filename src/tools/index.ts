import type { ToolDefinition } from "./contract";
import { opsAlerts } from "./opsAlerts";
import { opsHostMetrics } from "./opsHostMetrics";
import { opsListServers } from "./opsListServers";
import { opsMetricsQuery } from "./opsMetricsQuery";
import { opsServiceMetrics } from "./opsServiceMetrics";

// Add new tools here (one line each, one file per tool).
export const TOOLS: ToolDefinition[] = [opsListServers, opsServiceMetrics, opsHostMetrics, opsMetricsQuery, opsAlerts];
