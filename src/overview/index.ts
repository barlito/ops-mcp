import { alertsSection } from "./alertsSection";
import { logsSection } from "./logsSection";
import { metricsSection } from "./metricsSection";
import type { OverviewSection } from "./section";
import { swarmSection } from "./swarmSection";

// Each phase adds its section here (one line).
export const OVERVIEW_SECTIONS: OverviewSection<any>[] = [swarmSection, logsSection, metricsSection, alertsSection];
