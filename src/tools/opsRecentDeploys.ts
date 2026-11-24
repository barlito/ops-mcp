import { z } from "zod";
import { imageLabel, timeOf } from "../cluster/swarm";
import type { ServiceSummary } from "../cluster/types";
import { type GhDeployment } from "../github/GitHubClient";
import { DeployLinkSchema, linkOf, matchDeployment, repoName, resolveRepo, type SwarmFacts } from "../github/fuse";
import { ToolError, defineTool, envelopeSchema, limitParam, resolveServers, resolveWindow, scopeShape } from "./contract";
import { failureNote, fanOut } from "./fanOut";

const ItemSchema = z.object({
  server: z.string(),
  service: z.string(),
  stack: z.string().optional(),
  at: z.string(),
  state: z.string().optional(),
  message: z.string().optional(),
  image: z.string().optional(),
  previous_image: z.string().optional(),
  failed_image: z.string().optional(),
  github: DeployLinkSchema.optional(),
  github_only: z.literal(true).optional(),
});
type Item = z.infer<typeof ItemSchema>;

const LOOKBACK_MS = 3_600_000;
const MAX_REPOS = 20;

interface Repo {
  server: string;
  stack?: string;
}

const gh = (d: Item["github"]): string => (d ? ` [github #${d.deployment_id} ${d.kind} ${d.tag ?? "?"} ${d.sha} ${d.status}${d.creator ? ` by ${d.creator}` : ""}${d.run_url ? ` ${d.run_url}` : ""}]` : "");

export const opsRecentDeploys = defineTool({
  name: "ops_recent_deploys",
  description:
    "List the services updated in the window (newest first) with their update state (completed, rollback_completed, paused), message, and the image before and after. Use it to answer 'what changed recently' when something started failing. Swarm keeps only the last update of each service. After an automatic rollback Swarm restores the old spec and forgets the failed one: image is then the restored version and failed_image the version that failed, taken from recent failed tasks. previous_image is the image before the update otherwise (also after a manual rollback). When GitHub Deployments are configured, each update carries the matching production deployment in `github` (deployment_id for ops_deploy_impact, tag, short sha, status, run_url, creator; kind rollback when the deployment was a swarm-rollback run, whose tag comes from Swarm), and deployments that never reached Swarm (failed before the update) are listed with github_only and no image.",
  inputSchema: z.object({ server: scopeShape.server, since: scopeShape.since, until: scopeShape.until, limit: limitParam(10, 20) }),
  outputSchema: envelopeSchema(ItemSchema),
  formatItem: (d: Item) => `${d.at} ${d.server} ${d.service} ${d.previous_image ? `${d.previous_image} -> ` : ""}${d.image ?? "(never reached Swarm)"}${d.state ? ` ${d.state}` : ""}${d.failed_image ? ` (failed: ${d.failed_image})` : ""}${d.message ? ` "${d.message}"` : ""}${gh(d.github)}`,
  async handler(args, ctx) {
    const window = resolveWindow(args, ctx.now());
    const { ok, failed } = await fanOut(ctx, resolveServers(ctx.registry, args.server), (source) => source.listServices({}, { signal: ctx.signal }));
    const inWindow = (updatedAt: string): boolean => timeOf(updatedAt) >= window.from.getTime() && timeOf(updatedAt) <= window.to.getTime();
    const recent = ok
      .flatMap(({ server, value }) => value.filter((s) => inWindow(s.updated_at)).map((s) => ({ server, service: s })))
      .sort((a, b) => timeOf(b.service.updated_at) - timeOf(a.service.updated_at) || a.service.name.localeCompare(b.service.name));
    const settled = await Promise.allSettled(
      recent.slice(0, args.limit).map(async ({ server, service }): Promise<Item & { failedTag?: string }> => {
        const update = await ctx.cluster(server).serviceUpdateHistory(service.id, { signal: ctx.signal });
        return {
          server: server.slug,
          service: update.service,
          ...(update.stack === undefined ? {} : { stack: update.stack }),
          at: update.updated_at,
          ...(update.update_status ? { state: update.update_status.state } : {}),
          ...(update.update_status?.message ? { message: update.update_status.message } : {}),
          image: imageLabel(update.image),
          ...(update.previous_image ? { previous_image: imageLabel(update.previous_image) } : {}),
          ...(update.failed_image ? { failed_image: imageLabel(update.failed_image) } : {}),
          ...(update.failed_image?.tag ? { failedTag: update.failed_image.tag } : {}),
        };
      }),
    );
    // A service removed since the listing is simply gone from the deploys.
    const looked = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    const lookupFailures = settled.filter((r) => r.status === "rejected" && !(r.reason instanceof ToolError && r.reason.code === "not_found")).length;

    let items: Item[] = looked.map(({ failedTag: _failedTag, ...item }) => item);
    let githubNote = "";
    let githubOnly = 0;
    if (ctx.github) {
      const repos = new Map<string, Repo>();
      for (const { server, value } of ok) {
        for (const s of value) {
          const repo = resolveRepo(s, ctx.registry);
          if (repo !== undefined && !repos.has(repo)) repos.set(repo, { server: server.slug, stack: s.stack });
        }
      }
      const names = [...repos.keys()].slice(0, MAX_REPOS);
      const since = new Date(window.from.getTime() - LOOKBACK_MS);
      const results = await Promise.allSettled(names.map((repo) => ctx.github!.recentDeployments(repo, since, { signal: ctx.signal })));
      const cancelled = results.find((r) => r.status === "rejected" && r.reason instanceof ToolError && r.reason.code === "cancelled");
      if (cancelled) throw (cancelled as PromiseRejectedResult).reason;
      const byRepo = new Map<string, GhDeployment[]>();
      const errors = new Set<string>();
      results.forEach((r, i) => {
        if (r.status === "fulfilled") byRepo.set(names[i]!, r.value);
        else errors.add(r.reason instanceof ToolError ? r.reason.code : "error");
      });
      if (errors.size) githubNote = `; GitHub unavailable (${[...errors].join(", ")})`;

      const failedTags = new Map(looked.map((i) => [`${i.server}/${i.service}`, i.failedTag]));
      const matched = new Set<number>();
      const linkFor = (server: string, service: ServiceSummary, failedTag?: string): Item["github"] => {
        const repo = resolveRepo(service, ctx.registry);
        const deployments = repo === undefined ? undefined : byRepo.get(repo);
        if (!deployments) return undefined;
        const facts: SwarmFacts = { at: timeOf(service.updated_at), tags: [service.image.tag, failedTag].filter((t): t is string => t !== undefined) };
        const d = matchDeployment(facts, deployments);
        if (!d) return undefined;
        matched.add(d.id);
        return linkOf(d, service.image.tag);
      };
      const links = new Map(recent.map(({ server, service }) => [`${server.slug}/${service.name}`, linkFor(server.slug, service, failedTags.get(`${server.slug}/${service.name}`))]));
      items = items.map((i) => {
        const github = links.get(`${i.server}/${i.service}`);
        return github ? { ...i, github } : i;
      });
      const only: Item[] = [];
      for (const [repo, deployments] of byRepo) {
        for (const d of deployments) {
          if (matched.has(d.id) || !inWindow(d.created_at)) continue;
          const { server, stack } = repos.get(repo)!;
          only.push({ server, service: repoName(repo), ...(stack === undefined ? {} : { stack }), at: d.created_at, github: linkOf(d), github_only: true });
        }
      }
      githubOnly = only.length;
      items = [...items, ...only].sort((a, b) => timeOf(b.at) - timeOf(a.at) || a.service.localeCompare(b.service));
    }
    return {
      summary: `${recent.length} service update${recent.length === 1 ? "" : "s"} in the window${githubOnly ? `, ${githubOnly} GitHub deployment${githubOnly === 1 ? "" : "s"} without a Swarm update` : ""}${failureNote(failed)}${lookupFailures ? `; ${lookupFailures} lookup${lookupFailures === 1 ? "" : "s"} failed` : ""}${githubNote}`,
      items: items.slice(0, args.limit),
      truncated: recent.length > args.limit || items.length > args.limit,
      window,
    };
  },
});
