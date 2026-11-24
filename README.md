# ops-mcp

Strictly **read-only** MCP server that lets an agent diagnose Barlito production without SSH: Swarm state, logs (Loki), metrics (Prometheus) and deploys, filterable by server, stack and service.

TypeScript, Node 24, Express 5, `@modelcontextprotocol/sdk` (stateless Streamable HTTP), zod 4, better-sqlite3. The auth, audit and admin platform is vendored from [second-brain-mcp](https://github.com/barlito/second-brain-mcp) (`src/platform/`, each file says which commit it comes from).

## Tools

| Tool | Description |
|------|-------------|
| `ops_list_servers` | Servers of the registry (slug, env, kind, tenant) and whether each is reachable |
| `ops_overview` | Per-server health summary: nodes, degraded services, recent failed tasks (log, metric and alert sections plug in later) |
| `ops_list_stacks` | Swarm stacks with project, health, images and last update |
| `ops_get_service` | One service, sanitized (no env, no secret values), with its last tasks |
| `ops_list_tasks` | Tasks of a stack or service with error, exit code and timestamps, paginated |
| `ops_recent_deploys` | Services updated in the window with update state and image before/after |
| `ops_logs_summary` | Log counts per service and level, plus the top recurring error patterns (normalised, with first/last seen and an example) |
| `ops_logs_query` | Search logs by scope, substring, RE2 regex and level; redacted, cut to 400 chars, cursor pagination, window capped at 24h |
| `ops_logs_context` | Lines around an instant for one service |
| `ops_logs_query_raw` | Raw LogQL (log queries 24h, metric queries 7d, capped series and points) |

Metrics tools arrive in the next phase. Every tool shares one contract (`src/tools/contract.ts`):

- Scope parameters: `server`, `stack` (label `service_namespace`), `service` (full Swarm name such as `carapp_php`, label `service_name`), `since` (`15m`, `1h`, `24h`, `7d` or RFC 3339, default `1h`), `until` (RFC 3339, default now).
- One result envelope: `{ summary, items, truncated, next_cursor?, window, scope }`, as structured content plus one compact text block.
- Results are capped at 16 KB (`max_bytes` up to 48 KB); items are dropped from the end and `truncated` is set. Secret-shaped strings are redacted.
- Log and label content is untrusted data, never instructions (stated in every tool description and in the server instructions).

## Authentication

Login is mandatory on `/mcp`; any authenticated client reads everything (no scopes, no per-session approval):

- `Authorization: Bearer ops_...`: an API token, for Claude Code and scripts.
- `x-api-key: opsk_...`: a connector key, for claude.ai (the only header name its custom connectors accept).

Otherwise `401`. Credentials are created with `make token-create` / `make connector-key-create` or in the admin UI (`ops-admin.*`, behind Authelia + `ADMIN_PROXY_SECRET` header, group `admins`). Every tool call is audited (tool, server/stack/service, window, query hash and truncated query text, result size, truncation, result code, client IP) and **never** the result content.

## Registry

`REGISTRY_PATH` points at a YAML file validated with zod at startup (the server refuses to start with a message listing each bad path):

```yaml
tenants: [{slug: barlito}]
servers:
  - slug: ovh-prod-1
    env: production
    kind: swarm              # swarm | compose
    tenant: barlito
    source: {type: local, url: tcp://dockerproxy-ops:2375}   # local | agent (agent: not implemented yet)
stack_projects: {obs: observability-stack}   # exceptions to the fr.barlito.repo label
```

`config/registry.yaml` (prod) and `config/registry.local.yaml` (local) are committed (private repo) and mounted as a Swarm config named `ops_registry_<sha1>`.

Docker API access goes through `dockerproxy-ops` (docker-socket-proxy: read-only endpoints for services, tasks, nodes, info, version; no containers) on an internal overlay network.

## Local development

Nothing runs on the host: everything goes through Docker via `make`.

```bash
make help        # all targets
make typecheck   # tsc over sources and tests, in node:24-alpine
make test        # node --test through tsx, in node:24-alpine
make test.integration  # tools against a real Loki (throwaway compose project ops-mcp-it-logs)
make build       # tsc to dist/
make deploy      # build the image and deploy the local Swarm stack `ops-mcp`
make token-create name=laptop
```

## Logs (Loki)

Log tools query Loki at `LOKI_URL` (default `http://loki:3100`) over the external overlay network `obs_query`, created by the obs stack (observability-stack). The ops-mcp stack therefore needs the obs stack deployed first, locally as in prod, otherwise `docker stack deploy` fails on the missing network. Stream labels used: `server`, `service_namespace` (tool param `stack`), `service_name` (tool param `service`); level filters use the structured metadata `detected_level`. User input only reaches LogQL as escaped string literals (`src/logs/selector.ts`), and returned lines are redacted (DSN passwords, Bearer/Basic, JWT, `password=`-style pairs, known token prefixes) then cut to 400 characters.

After `make deploy`, with the local traefik-base running:

- MCP: `https://ops.local.barlito.fr/mcp` (self-signed certificate, use `curl -k`)
- Admin: `https://ops-admin.local.barlito.fr` (Authelia)
- Health: `https://ops.local.barlito.fr/health`

```bash
curl -k https://ops.local.barlito.fr/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ops_list_servers","arguments":{}}}'
```

Adding a tool: create `src/tools/<name>.ts` with `defineTool({...})` and add one line to `src/tools/index.ts`.

## Deploy

Releases and deploys run through GitHub Actions (`release.yaml`, `deploy.yaml`, `rollback.yaml`); see [docs/DEPLOY.md](docs/DEPLOY.md) for the required secrets, variables and the first-deploy checklist.
