import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { parseRegistry, type Registry } from "../registry";
import type { RawNode, RawService, RawTask } from "../cluster/sanitize";

const FIXTURES = join(__dirname, "..", "cluster", "fixtures");
const load = <T>(name: string): T => JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as T;

export const rawFixtures = {
  nodes: load<RawNode[]>("nodes.json"),
  services: load<RawService[]>("services.json"),
  inspect: load<RawService>("service-inspect.json"),
  tasks: load<RawTask[]>("tasks.json"),
};

// Strings that must never appear in any output derived from the fixtures.
export const FIXTURE_SECRETS = [
  "fake-db-password",
  "fake-app-secret",
  "fakehash",
  "fake-sentry-key",
  "fake-secret-id",
  "fake-config-id",
  "fake-cli-password",
  "fake-cli-token",
  "fake-amqp-password",
  "FAKETRUSTROOT",
  "PUBLICKEY",
  "fake-proxy-secret",
  "X-Proxy-Secret",
  "internal.note",
];

type Filters = Record<string, string[]>;

// Serves the fixtures like docker-socket-proxy would, applying the filters the source sends.
export async function startDockerStub(): Promise<{ url: string; requests: string[]; close: () => Promise<void> }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    const url = new URL(req.url ?? "/", "http://stub");
    const filters = JSON.parse(url.searchParams.get("filters") ?? "{}") as Filters;
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    };
    const serviceName = (s: RawService): string => s.Spec?.Name ?? "";
    if (url.pathname === "/version") return send(200, { Version: "29.9.2" });
    if (url.pathname === "/info") return send(200, { Swarm: { LocalNodeState: "active" } });
    if (url.pathname === "/nodes") return send(200, rawFixtures.nodes);
    if (url.pathname === "/services") {
      const list = rawFixtures.services.filter(
        (s) =>
          (filters.id ?? [s.ID]).includes(s.ID) &&
          (filters.name ?? [""]).some((n) => serviceName(s).includes(n)) &&
          (filters.label ?? []).every((l) => l === `com.docker.stack.namespace=${s.Spec?.Labels?.["com.docker.stack.namespace"]}`),
      );
      return send(200, list);
    }
    if (url.pathname.startsWith("/services/")) {
      const key = decodeURIComponent(url.pathname.slice("/services/".length));
      const found = rawFixtures.services.find((s) => s.ID === key || serviceName(s) === key);
      if (!found) return send(404, { message: "service not found" });
      return send(200, found.ID === rawFixtures.inspect.ID ? rawFixtures.inspect : found);
    }
    if (url.pathname === "/tasks") return send(200, rawFixtures.tasks.filter((t) => (filters.service ?? [t.ServiceID]).includes(t.ServiceID ?? "")));
    return send(403, { message: "forbidden" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `tcp://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export function stubRegistry(url: string): Registry {
  return parseRegistry(`
tenants: [{slug: barlito}]
servers:
  - { slug: ovh-prod-1, env: production, kind: swarm, tenant: barlito, source: { type: local, url: "${url}" } }
  - { slug: lab, env: development, kind: compose, tenant: barlito, source: { type: agent } }
stack_projects:
  obs: observability-stack
`);
}
