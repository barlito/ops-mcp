import { type ImageRef, type ServiceSummary, type StackInfo } from "./types";

export const timeOf = (iso: string): number => Date.parse(iso) || 0;

export const imageLabel = (image: ImageRef): string => (image.tag ? `${image.name}:${image.tag}` : image.name);

// Job modes finish by design, so running < desired is not a fault there.
export const isDegraded = (s: ServiceSummary): boolean => (s.mode === "replicated" || s.mode === "global") && s.running < s.desired;

export function groupStacks(services: ServiceSummary[]): StackInfo[] {
  const stacks = new Map<string, ServiceSummary[]>();
  for (const s of services) {
    if (s.stack === undefined) continue;
    stacks.set(s.stack, [...(stacks.get(s.stack) ?? []), s]);
  }
  return [...stacks].map(([name, list]) => ({ name, services: list })).sort((a, b) => a.name.localeCompare(b.name));
}
