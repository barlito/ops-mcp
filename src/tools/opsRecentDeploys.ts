import { z } from "zod";
import { imageLabel, timeOf } from "../cluster/swarm";
import type { ServiceSummary } from "../cluster/types";
import { type GhDeployment, RequestBudget } from "../github/GitHubClient";
import { bareTag, DeployLinkSchema, isTagRef, linkOf, matchDeployment, resolveRepo, type SwarmFacts } from "../github/fuse";
import { ToolError, defineTool, envelopeSchema, limitParam, resolveServers, resolveWindow, scopeShape } from "./contract";
import { failureNote, fanOut } from "./fanOut";

const ItemSchema = z.object({
  server: z.string(),
  service: z.string().optional(),
  repo: z.string().optional(),
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
const GITHUB_REQUEST_BUDGET = 30;
const FAILED_STATUSES = new Set(["failure", "error"]);

interface Repo {
  server: string;
  stack?: string;
  recent: boolean;
}

interface Looked {
  item: Item;
  repo?: string;
  matchTags: string[];
  reachedTags: string[];
}

const gh = (d: Item["github"]): string => (d ? ` [github #${d.deployment_id} ${d.kind} ${d.tag ?? "?"} ${d.sha} ${d.status}${d.creator ? ` by ${d.creator}` : ""}${d.run_url ? ` ${d.run_url}` : ""}]` : "");

export const opsRecentDeploys = defineTool({
  name: "ops_recent_deploys",
  description:
    "List the services updated in the window (newest first) with their update state (completed, rollback_completed, paused), message, and the image before and after. Use it to answer 'what changed recently' when something started failing. Swarm keeps only the last update of each service. After an automatic rollback Swarm restores the old spec and forgets the failed one: image is then the restored version and failed_image the version that failed, taken from recent failed tasks. previous_image is the image before the update otherwise (also after a manual rollback). When GitHub Deployments are configured, each update carries the matching production deployment in `github` (deployment_id for ops_deploy_impact, tag, short sha, status, run_url, creator; kind rollback when the deployment was a swarm-rollback run, whose tag comes from Swarm), and production deployments of the window with no matching current Swarm update are listed after the Swarm updates with github_only, `repo` and no image or service: Swarm keeps only the last update of a service, so an older successful deploy also appears there; look at the status (failure or error means the deploy itself failed, possibly before reaching Swarm).",
  inputSchema: z.object({ server: scopeShape.server, since: scopeShape.since, until: scopeShape.until, limit: limitParam(10, 20) }),
  outputSchema: envelopeSchema(ItemSchema),
  formatItem: (d: Item) => `${d.at} ${d.server} ${d.service ?? d.repo} ${d.previous_image ? `${d.previous_image} -> ` : ""}${d.image ?? "(no matching current Swarm update)"}${d.state ? ` ${d.state}` : ""}${d.failed_image ? ` (failed: ${d.failed_image})` : ""}${d.message ? ` "${d.message}"` : ""}${gh(d.github)}`,
  async handler(args, ctx) {
    const window = resolveWindow(args, ctx.now());
    const { ok, failed } = await fanOut(ctx, resolveServers(ctx.registry, args.server), (source) => source.listServices({}, { signal: ctx.signal }));
    const inWindow = (updatedAt: string): boolean => timeOf(updatedAt) >= window.from.getTime() && timeOf(updatedAt) <= window.to.getTime();
    const recent = ok
      .flatMap(({ server, value }) => value.filter((s) => inWindow(s.updated_at)).map((s) => ({ server, service: s })))
      .sort((a, b) => timeOf(b.service.updated_at) - timeOf(a.service.updated_at) || a.service.name.localeCompare(b.service.name));
    const settled = await Promise.allSettled(
      recent.slice(0, args.limit).map(async ({ server, service }): Promise<Looked> => {
        const update = await ctx.cluster(server).serviceUpdateHistory(service.id, { signal: ctx.signal });
        const item: Item = {
          server: server.slug,
          service: update.service,
          ...(update.stack === undefined ? {} : { stack: update.stack }),
          at: update.updated_at,
          ...(update.update_status ? { state: update.update_status.state } : {}),
          ...(update.update_status?.message ? { message: update.update_status.message } : {}),
          image: imageLabel(update.image),
          ...(update.previous_image ? { previous_image: imageLabel(update.previous_image) } : {}),
          ...(update.failed_image ? { failed_image: imageLabel(update.failed_image) } : {}),
        };
        const tag = (t?: string): string[] => (t ? [t] : []);
        const matchTags = [...tag(update.image.tag), ...tag(update.failed_image?.tag)];
        return { item, repo: resolveRepo(service, ctx.registry), matchTags, reachedTags: [...matchTags, ...tag(update.previous_image?.tag)] };
      }),
    );
    // A service removed since the listing is simply gone from the deploys.
    const looked = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    const lookupFailures = settled.filter((r) => r.status === "rejected" && !(r.reason instanceof ToolError && r.reason.code === "not_found")).length;

    let items: Item[] = looked.map((l) => l.item);
    const githubOnly: Item[] = [];
    let githubNote = "";
    if (ctx.github) {
      const repos = new Map<string, Repo>();
      const collect = (recentOnly: boolean): void => {
        for (const { server, value } of ok) {
          for (const s of value) {
            const repo = resolveRepo(s, ctx.registry);
            const isRecent = inWindow(s.updated_at);
            if (repo !== undefined && !repos.has(repo) && isRecent === recentOnly) repos.set(repo, { server: server.slug, stack: s.stack, recent: recentOnly });
          }
        }
      };
      // Repos with a Swarm update in the window first: the others only matter for deployments that failed before reaching Swarm.
      collect(true);
      collect(false);
      const names = [...repos.keys()].slice(0, MAX_REPOS);
      const skipped = repos.size - names.length;
      const budget = new RequestBudget(GITHUB_REQUEST_BUDGET);
      const ghWindow = { from: new Date(window.from.getTime() - LOOKBACK_MS), to: window.to };
      const results = await Promise.allSettled(names.map((repo) => ctx.github!.recentDeployments(repo, ghWindow, { signal: ctx.signal, budget })));
      const cancelled = results.find((r) => r.status === "rejected" && r.reason instanceof ToolError && r.reason.code === "cancelled");
      if (cancelled) throw (cancelled as PromiseRejectedResult).reason;
      const byRepo = new Map<string, GhDeployment[]>();
      const errors = new Set<string>();
      results.forEach((r, i) => {
        if (r.status === "fulfilled") byRepo.set(names[i]!, r.value);
        else errors.add(r.reason instanceof ToolError ? r.reason.code : "error");
      });
      githubNote = `${errors.size ? `; GitHub unavailable (${[...errors].join(", ")})` : ""}${budget.exhausted ? `; GitHub request budget (${GITHUB_REQUEST_BUDGET}) reached, results partial` : ""}${skipped > 0 ? `; ${skipped} repositories not queried (limit ${MAX_REPOS})` : ""}`;

      const matchTags = new Map(looked.map((l) => [`${l.item.server}/${l.item.service}`, l.matchTags]));
      const reached = new Map<string, Set<string>>();
      const markReached = (repo: string | undefined, tags: string[]): void => {
        if (repo === undefined) return;
        const set = reached.get(repo) ?? new Set<string>();
        for (const t of tags) set.add(bareTag(t));
        reached.set(repo, set);
      };
      for (const { service: s } of recent) markReached(resolveRepo(s, ctx.registry), s.image.tag ? [s.image.tag] : []);
      for (const l of looked) markReached(l.repo, l.reachedTags);

      const matched = new Set<number>();
      const links = new Map(
        recent.map(({ server, service: s }) => {
          const repo = resolveRepo(s, ctx.registry);
          const deployments = repo === undefined ? undefined : byRepo.get(repo);
          const key = `${server.slug}/${s.name}`;
          const facts: SwarmFacts = { at: timeOf(s.updated_at), tags: matchTags.get(key) ?? (s.image.tag ? [s.image.tag] : []) };
          const d = deployments && matchDeployment(facts, deployments);
          if (!d) return [key, undefined] as const;
          matched.add(d.id);
          return [key, linkOf(d, s.image.tag)] as const;
        }),
      );
      items = items.map((i) => {
        const github = links.get(`${i.server}/${i.service}`);
        return github ? { ...i, github } : i;
      });
      for (const [repo, deployments] of byRepo) {
        for (const d of deployments) {
          if (matched.has(d.id) || !inWindow(d.created_at) || (isTagRef(d.ref) && reached.get(repo)?.has(bareTag(d.ref)))) continue;
          const { server, stack } = repos.get(repo)!;
          githubOnly.push({ server, repo, ...(stack === undefined ? {} : { stack }), at: d.created_at, github: linkOf(d), github_only: true });
        }
      }
      githubOnly.sort((a, b) => timeOf(b.at) - timeOf(a.at));
    }
    const failedDeploys = githubOnly.filter((i) => FAILED_STATUSES.has(i.github?.status ?? "")).length;
    return {
      summary: `${recent.length} service update${recent.length === 1 ? "" : "s"} in the window${githubOnly.length ? `, ${githubOnly.length} GitHub deployment${githubOnly.length === 1 ? "" : "s"} without a matching Swarm update${failedDeploys ? ` (${failedDeploys} failed)` : ""}` : ""}${failureNote(failed)}${lookupFailures ? `; ${lookupFailures} lookup${lookupFailures === 1 ? "" : "s"} failed` : ""}${githubNote}`,
      items: [...items, ...githubOnly.slice(0, args.limit)],
      truncated: recent.length > args.limit || githubOnly.length > args.limit,
      window,
    };
  },
});
