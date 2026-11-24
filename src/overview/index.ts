import { alertsSection } from "./alertsSection";
import { metricsSection } from "./metricsSection";
import type { OverviewSection } from "./section";

// Each phase adds its section here (one line).
export const OVERVIEW_SECTIONS: OverviewSection<any>[] = [metricsSection, alertsSection];
