import type { OverviewSection } from "./section";
import { swarmSection } from "./swarmSection";

// Each phase adds its section here (one line).
export const OVERVIEW_SECTIONS: OverviewSection<any>[] = [swarmSection];
