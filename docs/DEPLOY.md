# Deploy runbook

Target: a Docker Swarm manager running the [traefik-base](https://github.com/barlito/traefik-base) stack (network `traefik_traefik_proxy`), serving `https://ops.barlito.fr` (MCP) and `https://ops-admin.barlito.fr` (admin, behind Authelia).

Releases are cut with GitHub Releases and deployed with GitHub Actions. Known gap: no off-host backup automation.

## Release, deploy, rollback (GitHub Actions)

1. **Release**: create a GitHub Release `vX.Y.Z`. `release.yaml` runs the tests, then calls the shared `barlito/ci` `docker-release` workflow, which builds and pushes `barlito/ops-mcp:vX.Y.Z` (and `:latest` when it is the highest stable tag) to Docker Hub with SBOM and provenance (buildcache on ghcr). Tags are immutable: never reuse one.
2. **Deploy**: run the Deploy workflow on that tag (the shared `swarm-deploy` workflow refuses a non-tag ref, a tag that is not `vX.Y.Z[-suffix]`, and a tag whose image is not on Docker Hub, then runs `make deploy.update` or `make deploy.prod`):
   ```bash
   gh workflow run deploy.yaml --ref vX.Y.Z                    # image-only update
   gh workflow run deploy.yaml --ref vX.Y.Z -f re-deploy=true  # full stack deploy
   ```
   - Image-only: `make deploy.update`: `make db.backup`, `docker service update --with-registry-auth --image ...`, `make deploy.assert_image` (waits up to 180 s for the new image to run healthy), `make smoke.test` (`/health`), `make deploy.prune`.
   - `re-deploy=true` applies the whole `docker-compose-prod.yml` (`make deploy.prod`: backup, rolling `docker stack deploy --with-registry-auth`, assert, smoke, prune). **The first deploy needs it**, and so does any compose or `config/registry.yaml` change: the registry is a Swarm config named `ops_registry_<sha1 of the file>`, so a changed file creates a new config and rolls the service.
3. **Rollback**: `gh workflow run rollback.yaml --ref main -f tag=vX.Y.Z [-f restore-db=ops-<ts>.db]` (`make rollback TAG=... RESTORE=...`). It backs up the current DB, optionally restores a backup, switches the image, asserts and smoke-tests.

## Required repo configuration

- Environment `production` (deployment branches: tag pattern `v*` for deploy, the default branch for rollback), with:
  - variable `SERVER_HOST`;
  - secrets `SERVER_USERNAME`, `SERVER_PORT`, `SERVER_HOST_KEY` (full `known_hosts` line pinning the host, e.g. `[1.2.3.4]:3333 ssh-ed25519 AAAA...`; there is no `ssh-keyscan` fallback), `SSH_PRIVATE_KEY`, `DOCKER_HUB_USERNAME`, `DOCKER_HUB_READ_ONLY_ACCESS_TOKEN` (deploy/rollback, no fallback), `ADMIN_PROXY_SECRET`, `ADMIN_WEB_SECRET`;
  - optional secrets `GRAFANA_URL`, `GRAFANA_TOKEN`, `GH_DEPLOYMENTS_TOKEN` (fine-grained read-only token for the deployments history, phase 6) and `AUTHELIA_SESSION_COOKIE` (only if not `authelia_session`). The shared workflow exports secrets only, never variables, hence these being secrets. An empty `GRAFANA_TOKEN` / `GH_DEPLOYMENTS_TOKEN` creates a placeholder Docker secret (`unset`).
- Repository secrets: `DOCKER_HUB_USERNAME`, `DOCKER_HUB_READ_WRITE_DELETE_ACCESS_TOKEN` (release only).
- Each deploy or rollback run creates a GitHub Deployment on `production` (tag, commit, run, status).
- Docker Hub: private or public repository `barlito/ops-mcp`.
- DNS: `ops.barlito.fr` and `ops-admin.barlito.fr` pointing at the Swarm entry point.

## Admin secrets and Authelia

- `ADMIN_PROXY_SECRET` (at least 32 chars, `openssl rand -hex 32`): Traefik's `ops-admin-proxy` headers middleware sets `X-Ops-Admin-Proxy` to this value AFTER Authelia, overwriting any client value. The app only believes `Remote-User`/`Remote-Groups` when this header matches and the peer is in `TRUSTED_PROXY`. Without it the admin listener does not start.
- `ADMIN_WEB_SECRET` (`openssl rand -hex 32`): CSRF key and sealing key of the stored connector keys (so the admin can reveal them again). Rotating it makes existing keys unrevealable (they keep working).
- Authelia (traefik-base) must satisfy: `authelia-auth@file` lists `Remote-User`, `Remote-Groups` in `authResponseHeaders`; an access rule for host `ops-admin.barlito.fr` (and `ops-admin.local.barlito.fr` locally) restricted to `group:admins`; the session cookie is `authelia_session` (else set the `AUTHELIA_SESSION_COOKIE` secret and redeploy with `re-deploy=true`).
- Both are delivered to the app as Docker secrets (`/run/secrets/admin_proxy_secret`, `admin_web_secret`, read through `ADMIN_PROXY_SECRET_FILE` / `ADMIN_WEB_SECRET_FILE`). Swarm secrets are immutable: `scripts/ensure-secret.sh` creates `ops_admin_*_secret_<sha1 of the value>` on deploy, so a rotation is: update the GitHub secret and run the Deploy workflow with `re-deploy=true` (an image-only update keeps the old values). Old versions can be removed with `docker secret rm` once unused.

The MCP route has no Authelia on purpose (claude.ai cannot pass it): it is protected by its own login (Bearer token or `x-api-key` connector key), a per-IP failure limiter and the Traefik rate limit.

## First deploy checklist

- [ ] GitHub secrets and variables above are set; Docker Hub repo `barlito/ops-mcp` exists.
- [ ] DNS records and the Authelia access rule exist.
- [ ] Create the release, then `gh workflow run deploy.yaml --ref vX.Y.Z -f re-deploy=true`.
- [ ] `docker service ps ops-mcp_ops-mcp` and `ops-mcp_dockerproxy-ops` are `Running`; `make logs` shows `registry ok: ...` and `ops-mcp listening on port 3000`.
- [ ] `curl https://ops.barlito.fr/health` returns `{"status":"ok"}`.
- [ ] Create a connector key: `make connector-key-create name=claude-ai` (or in the admin UI), add the claude.ai custom connector (URL `https://ops.barlito.fr/mcp`, Authentication none, request header `x-api-key`), then call `ops_list_servers` from claude.ai.
- [ ] Create a token for Claude Code / scripts: `make token-create name=claude-laptop expires_in_days=90`.
- [ ] `make backup-db`, then copy `/data/backups` off-host (no automation yet):
  ```bash
  CID=$(docker ps -q --filter label=com.docker.swarm.service.name=ops-mcp_ops-mcp | head -n1)
  docker cp "$CID":/data/backups/. ./ops-mcp-backups/
  ```

The `make token-*`, `make connector-key-*` and `make backup-db` targets use `docker exec`, so they work over `DOCKER_HOST=ssh://user@manager` the same way.

## Docker API exposure

`dockerproxy-ops` is the only service that touches `/var/run/docker.sock`. It whitelists `SERVICES`, `TASKS`, `NODES`, `INFO` and `VERSION` read endpoints (Swarm state comes from `/info`; `SWARM` is deliberately off because `GET /swarm` returns the join tokens), refuses every write (`POST=0`), has no `CONTAINERS`, and lives on the internal overlay network `ops_docker` shared only with ops-mcp. Note that `GET /services` returns service environment variables and labels: anything that can reach the proxy can read them. Output redaction does NOT protect these values (it only catches secret-shaped strings in what ops-mcp returns), so: the app secrets (`ADMIN_WEB_SECRET`, `ADMIN_PROXY_SECRET`) are mounted as Docker secret files (`*_FILE` variables), never put in the service environment; `ADMIN_PROXY_SECRET` necessarily remains in the Traefik middleware label, so the phase 2 service tools must allowlist the fields they return (no raw env, no `traefik.*` labels except router name/host). The network is internal for the same reason.

## Rollback by hand

```bash
make db.backup
make docker.service.update args="--replicas 1 --image barlito/ops-mcp:<old> ops-mcp_ops-mcp"
TAG=<old> make deploy.assert_image && make smoke.test
```

**Schema migrations are one-way.** The app upgrades `ops.db` on boot and refuses to start on a database whose `user_version` is newer than the build knows. Rolling back across a migration therefore crash-loops (`deploy.assert_image` fails loudly, the DB is untouched). To roll back across a migration, restore a backup taken before the upgrade:

```bash
docker service scale ops-mcp_ops-mcp=0
make db.restore TAG=<old> file=ops-<ts>.db     # keeps ops.db/-wal/-shm as *.pre-restore-<ts>
make docker.service.update args="--replicas 1 --image barlito/ops-mcp:<old> ops-mcp_ops-mcp"
TAG=<old> make deploy.assert_image && make smoke.test
```

A restore silently **un-revokes** tokens and keys revoked after the backup and drops credentials created after it: re-check `make token-list` and `make connector-key-list` and review the audit log (`admin_token_revoke`, `admin_connector_key_revoke`) for what to redo. `deploy.prod` and the workflows take a backup first, but it is skipped when no task is running (first deploy, crash loop): take one by hand (`make backup-db`) before a risky upgrade.

## Troubleshooting

| Symptom | Likely cause / action |
|---------|-----------------------|
| Container exits at start with `Invalid registry ...` | `config/registry.yaml` failed validation: the message lists each bad path. |
| `401` `missing credentials` | Send `Authorization: Bearer <token>` or `x-api-key: <connector key>`. |
| `401` `invalid or revoked ...` / `token expired` | `make token-list` / `make connector-key-list`; create a new one. |
| `429 Too many failed authentications` | 10 failures from that client within 60 s. Wait a minute (in-memory limiter). If the audit log always shows Traefik's address as client IP, `TRUSTED_PROXY` is not resolving. |
| `ops_list_servers` shows a server `DOWN` | `dockerproxy-ops` not running, or the `source.url` in the registry is wrong; the `error` field says why. |
| Admin UI answers 401 | `ADMIN_PROXY_SECRET` differs between the service and the Traefik label (redeploy with `re-deploy=true`), or the request did not go through Authelia. |
| Permission errors on `/data` | The volume must be writable by uid/gid 10001 (the image pre-creates it so for named volumes). |
| Pull denied / no such image | The tag was not pushed, or the deploying machine is not logged in to Docker Hub. |
