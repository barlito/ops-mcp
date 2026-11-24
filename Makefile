.DEFAULT_GOAL := help
.PHONY: help install test test.integration typecheck build deploy deploy.prod db.backup db.restore docker.service.update deploy.assert_image smoke.test deploy.prune prune-local-images undeploy restart logs token-create token-list token-revoke connector-key-create connector-key-show connector-key-list connector-key-revoke backup-db prune-audit

stack_name=ops-mcp
service=ops-mcp
svc_full=$(stack_name)_ops-mcp
image_name=barlito/ops-mcp
prod_host=ops.barlito.fr
assert_timeout=180
assert_settle=10
# Service Version.Index + UpdateStatus.StartedAt before a deploy/update: assert-deployed.sh
# ignores update states that predate it (stale rollback_*/completed).
mark_file=.service-mark

# Runs the local container as the host user, so it can read/write the bind-mounted ./data.
export HOST_UID := $(shell id -u)
export HOST_GID := $(shell id -g)

# pipefail so a failing `compose config` aborts the deploy pipeline.
SHELL := bash
.SHELLFLAGS := -o pipefail -ec

# Nothing runs on the host: Node tooling runs in a throwaway container with the repo mounted at the
# same absolute path, as the host user (else node_modules and dist/ end up root-owned).
NODE_IMAGE=node:24.21-alpine
NODE=docker run --rm -u $(HOST_UID):$(HOST_GID) -e HOME=/tmp/home -v $(CURDIR):$(CURDIR) -w $(CURDIR) $(NODE_IMAGE)

# Unique tag per build: `docker stack deploy` then rolls the service by itself
# (Swarm ignores same-tag rebuilds). Fixed once per make run.
ifndef LOCAL_TAG
LOCAL_TAG := local-$(shell git rev-parse --short HEAD 2>/dev/null || echo nogit)-$(shell date +%s)
endif
KEEP_LOCAL_IMAGES ?= 3

# $(1): extra compose args, $(2): extra stack deploy args.
# sed: drop top-level `name:` and unquote secret `mode:` (stack schema wants a
# number; Compose v5 renders it as a string and `docker stack config` rejects it).
define stack_deploy
docker compose $(1) config | sed '/^name:/d; s/mode: "\([0-9]*\)"/mode: \1/g' | docker stack deploy $(2) -c - $(stack_name)
endef

# $(1): command to run inside the running service container.
# The guard runs in the recipe shell (an `exit` inside $(...) would not stop it).
define exec_in_service
cid=$$(docker ps -q --filter label=com.docker.swarm.service.name=$(svc_full) | head -n1); \
[ -n "$$cid" ] || { echo "$(svc_full) is not running (make deploy first)" >&2; exit 1; }; \
docker exec "$$cid" $(1)
endef

help: ## Show this help
	@echo "ops-mcp — available commands:"
	@grep -E '^[a-zA-Z_.-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

node_modules: package.json package-lock.json
	$(NODE) npm ci --ignore-scripts --no-audit --no-fund
	@touch node_modules

install: node_modules ## Install dependencies (in Docker)

typecheck: node_modules ## Typecheck sources and tests (in Docker)
	$(NODE) npm run typecheck

test: node_modules ## Run the test suite (in Docker)
	$(NODE) npm test

# Real Loki in a throwaway compose project (ops-mcp-it-logs), always torn down afterwards.
export ITEST_ROOT := $(CURDIR)
it_compose=docker compose -f test/integration/compose.yaml
test.integration: node_modules ## Run the integration tests against a real Loki (in Docker)
	trap '$(it_compose) down -v --remove-orphans' EXIT; $(it_compose) run --rm tests

build: node_modules ## Compile TypeScript to dist/ (in Docker)
	$(NODE) npm run build

deploy: export IMAGE_TAG := $(LOCAL_TAG)
deploy: ## Build the image and deploy the stack locally (Swarm)
	mkdir -p data
	@# Admin web secrets: generated once (0600, data/ is gitignored), reused on every deploy.
	@umask 077; for f in admin-proxy-secret admin-web-secret; do [ -s data/$$f ] || openssl rand -hex 32 > data/$$f; chmod 600 data/$$f; done
	export ADMIN_PROXY_SECRET=$$(cat data/admin-proxy-secret) ADMIN_WEB_SECRET=$$(cat data/admin-web-secret) CONFIG_VERSION=$$(sha1sum config/registry.local.yaml | cut -c1-10); \
	  docker compose build && $(call stack_deploy,,)
	$(MAKE) prune-local-images

# $(1): file to write. "none" only when the service does not exist yet; any other inspect error
# is retried, then aborts the recipe before anything is changed (a bogus "none" would let
# assert-deployed.sh trust a stale UpdateStatus).
define mark_service
for i in 1 2 3; do \
  if out=$$(docker service inspect $(svc_full) --format '{{.Version.Index}}|{{if .UpdateStatus}}{{.UpdateStatus.StartedAt}}{{end}}' 2>&1); then \
    printf '%s\n' "$$out" > $(1); exit 0; \
  fi; \
  case "$$out" in *"o such service"*) echo none > $(1); exit 0;; esac; \
  sleep 2; \
done; \
echo "cannot inspect $(svc_full) to mark it: $$out" >&2; exit 1
endef

# Rolling stack deploy (never `stack rm`: a recreated service has nothing to roll back to).
# Needs TAG + ADMIN_PROXY_SECRET + ADMIN_WEB_SECRET in the env; the image must be published.
# --detach=false waits for convergence (or Swarm's own rollback).
deploy.prod: export IMAGE_TAG := $(TAG)
deploy.prod: ## Deploy the whole prod stack (TAG=<release tag>): backup, stack deploy, assert, smoke, prune
	@test -n "$(TAG)" || { echo "TAG is required (TAG=<tag> make deploy.prod)" >&2; exit 1; }
	$(MAKE) db.backup
	@$(call mark_service,$(mark_file))
	export CONFIG_VERSION=$$(sha1sum config/registry.yaml | cut -c1-10); \
	  $(call stack_deploy,-f docker-compose-prod.yml,--with-registry-auth --detach=false)
	$(MAKE) deploy.assert_image
	$(MAKE) smoke.test
	$(MAKE) deploy.prune

# Skipped silently when the service has no running task (first deploy).
# ids= runs as its own command so a docker error aborts the recipe (no pipe, -e is on).
db.backup: ## Backup the DB if the service is running (skipped on first deploy)
	@ids=$$(docker ps -q --filter label=com.docker.swarm.service.name=$(svc_full)); \
	if [ -n "$$ids" ]; then \
	  $(MAKE) --no-print-directory backup-db; \
	else \
	  echo "no running $(svc_full) task, backup skipped (first deploy?)"; \
	fi

# Replaces ops.db with /data/backups/<file>. The service must be scaled to 0 first. The current
# ops.db, -wal and -shm are copied to *.pre-restore-<ts> before anything is deleted.
# Runs a one-off container of the target image on the volume.
db.restore: ## Restore a DB backup (TAG=<image tag> file=ops-<ts>.db); service must be scaled to 0
	@test -n "$(TAG)" -a -n "$(file)" || { echo "usage: make db.restore TAG=<tag> file=ops-<ts>.db" >&2; exit 1; }
	@case "$(file)" in */*) echo "file must be a bare backup filename" >&2; exit 1;; esac
	@ids=$$(docker ps -q --filter label=com.docker.swarm.service.name=$(svc_full)); \
	[ -z "$$ids" ] || { echo "$(svc_full) is still running: scale it to 0 first" >&2; exit 1; }
	docker run --rm --entrypoint sh -v $(stack_name)_ops-data:/data $(image_name):$(TAG) -ec \
	  'test -f "/data/backups/$(file)"; ts=$$(date -u +%Y%m%dT%H%M%SZ); \
	   for f in ops.db ops.db-wal ops.db-shm; do [ ! -f "/data/$$f" ] || cp -p "/data/$$f" "/data/$$f.pre-restore-$$ts"; done; \
	   rm -f /data/ops.db-wal /data/ops.db-shm; cp "/data/backups/$(file)" /data/ops.db; echo "restored $(file)"'

docker.service.update: ## docker service update with registry auth (args="--image <img> <service>")
	@$(call mark_service,$(mark_file))
	docker service update --with-registry-auth $(args)

# Swarm rollbacks exit 0: fail unless the service really runs $(image_name):$(TAG), healthy
deploy.assert_image: ## Wait until the service runs $(image_name):$(TAG) and is healthy
	@test -n "$(TAG)" || { echo "TAG is required" >&2; exit 1; }
	scripts/assert-deployed.sh $(svc_full) $(image_name):$(TAG) $(assert_timeout) $(assert_settle) $(mark_file)

smoke.test: ## GET /health on the prod host (retries)
	@echo "Smoke test https://$(prod_host)/health"
	@curl -fsS --retry 6 --retry-delay 5 --retry-all-errors --max-time 10 https://$(prod_host)/health \
	  || { echo "Smoke test KO" >&2; exit 1; }
	@echo
	@echo "Smoke test OK"

# Removes the stack's stopped containers (old tasks); never touches running ones
deploy.prune: ## Remove the stack's stopped containers
	docker container prune -f --filter label=com.docker.stack.namespace=$(stack_name)

prune-local-images: ## Remove old ops-mcp:local-* images (keep the newest 3)
	@# `docker image ls` lists newest first; images still in use fail to delete and are skipped.
	docker image ls ops-mcp --format '{{.Tag}}' | { grep '^local-' || true; } | tail -n +$$(($(KEEP_LOCAL_IMAGES)+1)) \
	  | xargs -r -I{} docker rmi ops-mcp:{} || true

undeploy: ## Remove the stack
	docker stack rm $(stack_name)

restart: ## Restart (undeploy then deploy)
	$(MAKE) undeploy
	sleep 5
	$(MAKE) deploy

logs: ## Follow logs (make logs service=ops-mcp)
	docker service logs -f "$(stack_name)_$(service)"

token-create: ## Create an API token (make token-create name=X [expires_in_days=N]); shown once
	@test -n "$(name)" || { echo "name is required (make token-create name=claude-laptop)" >&2; exit 1; }
	@$(call exec_in_service,node dist/platform/cli/token.js create --name "$(name)" $(if $(expires_in_days),--expires-in-days "$(expires_in_days)"))

token-list: ## List tokens
	@$(call exec_in_service,node dist/platform/cli/token.js list)

token-revoke: ## Revoke a token (make token-revoke id=X)
	@test -n "$(id)" || { echo "id is required (make token-revoke id=<id>)" >&2; exit 1; }
	@$(call exec_in_service,node dist/platform/cli/token.js revoke --id "$(id)")

connector-key-create: ## Create a connector key for claude.ai (make connector-key-create name=claude-ai); shown once
	@test -n "$(name)" || { echo "name is required (make connector-key-create name=claude-ai)" >&2; exit 1; }
	@$(call exec_in_service,node dist/platform/cli/connectorKey.js create --name "$(name)")

connector-key-show: ## Show a connector key again (make connector-key-show name=claude-ai); audited
	@test -n "$(name)" || { echo "name is required (make connector-key-show name=claude-ai)" >&2; exit 1; }
	@$(call exec_in_service,node dist/platform/cli/connectorKey.js show --name "$(name)")

connector-key-list: ## List connector keys
	@$(call exec_in_service,node dist/platform/cli/connectorKey.js list)

connector-key-revoke: ## Revoke a connector key (make connector-key-revoke id=<id>)
	@test -n "$(id)" || { echo "id is required (make connector-key-revoke id=<id>)" >&2; exit 1; }
	@$(call exec_in_service,node dist/platform/cli/connectorKey.js revoke --id "$(id)")

backup-db: ## Consistent SQLite backup to /data/backups/ops-<UTC timestamp>.db
	@$(call exec_in_service,node dist/platform/cli/maintenance.js backup "/data/backups/ops-$$(date -u +%Y%m%dT%H%M%SZ).db")

prune-audit: ## Delete audit rows older than N days (make prune-audit days=90)
	@test -n "$(days)" || { echo "days is required (make prune-audit days=90)" >&2; exit 1; }
	@$(call exec_in_service,node dist/platform/cli/maintenance.js prune-audit --days "$(days)")
