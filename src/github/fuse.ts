import { z } from "zod";
import { REPO_LABEL } from "../cluster/types";
import type { Registry } from "../registry";
import type { GhDeployment } from "./GitHubClient";

const ROLLBACK_BEFORE_MS = 5 * 60_000;
const ROLLBACK_AFTER_MS = 30 * 60_000;

export const DeployLinkSchema = z.object({
  deployment_id: z.number(),
  kind: z.enum(["deploy", "rollback"]),
  tag: z.string().optional(),
  sha: z.string(),
  status: z.string(),
  run_url: z.string().optional(),
  creator: z.string().optional(),
  created_at: z.string(),
});
export type DeployLink = z.infer<typeof DeployLinkSchema>;

// swarm-deploy runs with --ref vX.Y.Z; swarm-rollback runs on the default branch.
const isTagRef = (ref: string): boolean => /^v\d/.test(ref);
const bareTag = (tag: string): string => tag.replace(/^v/, "");

export interface SwarmFacts {
  at: number;
  // Image tags the update may carry (the restored one and, after a rollback, the failed one).
  tags: string[];
}

// Repo of a service: its fr.barlito.repo label, else the registry's stack_projects entry.
export function resolveRepo(service: { labels: Record<string, string>; stack?: string }, registry: Registry): string | undefined {
  const fromLabel = service.labels[REPO_LABEL];
  if (fromLabel) return fromLabel;
  return service.stack !== undefined && Object.hasOwn(registry.stack_projects, service.stack) ? registry.stack_projects[service.stack] : undefined;
}

export const repoName = (repo: string): string => repo.slice(repo.lastIndexOf("/") + 1);

const nearest = (candidates: GhDeployment[], at: number): GhDeployment | undefined =>
  candidates.reduce<GhDeployment | undefined>((best, d) => (best === undefined || Math.abs(Date.parse(d.created_at) - at) < Math.abs(Date.parse(best.created_at) - at) ? d : best), undefined);

// A tagged deployment whose tag equals an image tag, nearest in time; else, for a rollback (no tag in the
// deployment), the nearest rollback deployment just before the update.
export function matchDeployment(facts: SwarmFacts, deployments: GhDeployment[]): GhDeployment | undefined {
  const tags = new Set(facts.tags.map(bareTag));
  const tagged = nearest(deployments.filter((d) => isTagRef(d.ref) && tags.has(bareTag(d.ref))), facts.at);
  if (tagged) return tagged;
  return nearest(
    deployments.filter((d) => !isTagRef(d.ref) && facts.at - Date.parse(d.created_at) >= -ROLLBACK_BEFORE_MS && facts.at - Date.parse(d.created_at) <= ROLLBACK_AFTER_MS),
    facts.at,
  );
}

export function linkOf(d: GhDeployment, swarmTag?: string): DeployLink {
  const rollback = !isTagRef(d.ref);
  const tag = rollback ? swarmTag : d.ref;
  return {
    deployment_id: d.id,
    kind: rollback ? "rollback" : "deploy",
    ...(tag ? { tag } : {}),
    sha: d.sha.slice(0, 7),
    status: d.status,
    ...(d.run_url ? { run_url: d.run_url } : {}),
    ...(d.creator ? { creator: d.creator } : {}),
    created_at: d.created_at,
  };
}
