import { logsSection } from "./logsSection";
import type { OverviewSection } from "./section";

// Each phase adds its section here (one line).
export const OVERVIEW_SECTIONS: OverviewSection<any>[] = [logsSection];
