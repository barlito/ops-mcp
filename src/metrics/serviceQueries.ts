import type { TimeWindow } from "../tools/contract";
import { anyOf, eq } from "./labels";

// Traefik names its services after the traefik.http.services.<name> label: match the Swarm service name,
// its stack prefix (carapp_php -> carapp) or the auto-generated name (carapp-php).
export function traefikScope(server: string, service: string): { matcher: string; stack?: string } {
  const stack = service.includes("_") ? service.slice(0, service.indexOf("_")) : undefined;
  const names = [...new Set([service, ...(stack ? [stack] : []), service.replace(/[^a-zA-Z0-9]/g, "-")])];
  return { matcher: `${eq("server", server)},${anyOf("service", names, "@.+")}`, stack };
}

export const requestsSeries = (matcher: string): string => `traefik_service_requests_total{${matcher}}`;

// True when every matched Traefik service is the stack-level one, so the series are shared by the whole stack.
export const stackLevelOnly = (stack: string | undefined, matched: string[]): boolean => stack !== undefined && matched.length > 0 && matched.every((m) => m.split("@")[0] === stack);

export const spanSeconds = (window: TimeWindow): number => Math.round((window.to.getTime() - window.from.getTime()) / 1000);

// Containers of the service that started inside the window (instant query at window.to).
export function containerStartsQuery(server: string, service: string, window: TimeWindow): string {
  const started = `max_over_time(container_start_time_seconds{${eq("server", server)},${eq("service_name", service)}}[${spanSeconds(window)}s])`;
  return `count(${started} > ${Math.floor(window.from.getTime() / 1000)}) or (count(${started}) * 0)`;
}
