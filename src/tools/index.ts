import type { ToolDefinition } from "./contract";
import { opsGetService } from "./opsGetService";
import { opsListServers } from "./opsListServers";
import { opsListStacks } from "./opsListStacks";
import { opsListTasks } from "./opsListTasks";
import { opsOverview } from "./opsOverview";
import { opsRecentDeploys } from "./opsRecentDeploys";

// Add new tools here (one line each, one file per tool).
export const TOOLS: ToolDefinition[] = [opsListServers, opsOverview, opsListStacks, opsGetService, opsListTasks, opsRecentDeploys];
