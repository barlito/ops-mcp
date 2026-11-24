import type { ToolDefinition } from "./contract";
import { opsListServers } from "./opsListServers";

// Add new tools here (one line each, one file per tool).
export const TOOLS: ToolDefinition[] = [opsListServers];
