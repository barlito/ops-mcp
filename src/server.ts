import type { Server } from "node:http";
import express, { Express, NextFunction, Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { cachedClusterSources } from "./cluster/ClusterSource";
import { grafanaFromEnv } from "./metrics/GrafanaClient";
import { PromClient } from "./metrics/PromClient";
import { createMcpServer } from "./mcp";
import { AuditLog } from "./platform/audit";
import { AuthFailureAudit } from "./platform/authFailure";
import { CONNECTOR_HEADER, ConnectorKeyStore } from "./platform/auth/connectorKeys";
import type { AuthContext } from "./platform/auth/context";
import { TokenStore } from "./platform/auth/tokens";
import { startWebAdmin } from "./platform/admin/web";
import { type Db, openDb } from "./platform/db";
import { dbOk } from "./platform/health";
import { AuthFailureLimiter, createShutdown, createTrustedProxy, jsonRpcError, Lifecycle, type TrustedProxy } from "./platform/http";
import { listen } from "./platform/listen";
import { ipKey, RateLimiter } from "./platform/rateLimit";
import { SlotLimiter } from "./platform/slotLimiter";
import { errorMessage } from "./platform/util";
import { redactAll } from "./platform/redact/secrets";
import { loadRegistry, RegistryError } from "./registry";
import type { ToolDeps, ToolGuard } from "./tools/contract";

export const BODY_LIMIT = "1mb";

export interface AppOptions {
  db: Db;
  tokens: TokenStore;
  connectorKeys: ConnectorKeyStore;
  audit: AuditLog;
  tools: ToolDeps;
  lifecycle?: Lifecycle;
  trustedProxy?: TrustedProxy;
  authLimiter?: AuthFailureLimiter;
  authAudit?: AuthFailureAudit;
  // Tool calls per credential per minute / concurrent tool calls (total, per credential).
  callLimiter?: RateLimiter;
  slots?: SlotLimiter;
  maxConcurrentPerCredential?: number;
}

const posInt = (v: string | undefined, d: number): number => (v && Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : d);

// Login is mandatory: `Authorization: Bearer <token>` or the connector key header. Any authenticated
// client reads everything. No MCP involved on failure.
function makeAuth(opts: AppOptions, limiter: AuthFailureLimiter, authAudit: AuthFailureAudit) {
  // Expired credentials never count toward the 429, but their audit rows are still coalesced per client/minute.
  const expiredAudit = new AuthFailureLimiter(Infinity);
  return (req: Request, res: Response, next: NextFunction): void => {
    // Keyed per client (IPv6 by /64). Failures only throttle failing attempts: a valid credential is
    // checked first and never blocked because someone else fails from the same (e.g. shared) address.
    const ip = ipKey(req.ip);
    // countable=false: not a guessing attempt (expired token), so it skips the brute-force count.
    const fail = (reason: string, countable = true): void => {
      if (countable && limiter.blocked(ip)) {
        jsonRpcError(res, 429, -32000, "Too many failed authentications");
        return;
      }
      const { audit, previous } = countable ? limiter.record(ip) : expiredAudit.record(ip);
      if (audit) authAudit.record(req.ip, previous > 1 ? `${reason} (previous minute: ${previous} failures)` : reason);
      res.status(401).json({ error: reason });
    };

    let ctx: AuthContext;
    const header = req.headers.authorization;
    if (header !== undefined) {
      const match = /^Bearer\s+(.+)$/i.exec(header);
      if (!match) return fail("malformed Authorization header");
      const checked = opts.tokens.check(match[1]!);
      if (checked.status === "expired") return fail("token expired", false);
      if (checked.status !== "ok") return fail("invalid or revoked token");
      ctx = { credentialId: checked.id, name: checked.name, kind: "token", clientIp: req.ip };
    } else {
      const key = req.headers[CONNECTOR_HEADER];
      if (typeof key !== "string") return fail(`missing credentials: send Authorization: Bearer <token> or ${CONNECTOR_HEADER}: <key>`);
      const found = opts.connectorKeys.check(key);
      if (!found) return fail("invalid or revoked connector key");
      ctx = { credentialId: found.id, name: found.name, kind: "connector_key", clientIp: req.ip };
    }
    res.locals.auth = ctx;
    next();
  };
}

export function createApp(opts: AppOptions): Express {
  const lifecycle = opts.lifecycle ?? new Lifecycle();
  const limiter = opts.authLimiter ?? new AuthFailureLimiter();
  const authAudit = opts.authAudit ?? new AuthFailureAudit(opts.audit, posInt(process.env.AUTH_AUDIT_MAX_PER_MIN, 30));
  const calls = opts.callLimiter ?? new RateLimiter(posInt(process.env.MCP_CALLS_PER_MIN, 300), 60_000);
  const slots = opts.slots ?? new SlotLimiter(posInt(process.env.MCP_MAX_CONCURRENT, 16));
  const perCredential = opts.maxConcurrentPerCredential ?? posInt(process.env.MCP_MAX_CONCURRENT_PER_CREDENTIAL, 8);
  const auth = makeAuth(opts, limiter, authAudit);
  const guard: ToolGuard = { calls, slots, maxPerCredential: perCredential, track: () => lifecycle.track() };

  const app = express();
  app.disable("x-powered-by");
  // Trust X-Forwarded-For only from the configured proxies (TRUSTED_PROXY); otherwise req.ip is the socket address.
  const proxy = opts.trustedProxy;
  app.set("trust proxy", proxy ? (addr: string) => proxy.trust(addr) : false);

  // Public: status only. 503 only for a broken DB (restart helps).
  app.get("/health", (_req, res) => {
    const ok = dbOk(opts.db);
    res.status(ok ? 200 : 503).json({ status: ok ? "ok" : "error" });
  });

  // Track in-flight /mcp requests from the very start and refuse new ones once shutdown began.
  app.use("/mcp", (_req, res, next) => {
    if (lifecycle.shuttingDown) {
      res.setHeader("Connection", "close");
      jsonRpcError(res, 503, -32000, "Server is shutting down");
      return;
    }
    lifecycle.enter(res);
    next();
  });

  // Body parsing only after auth.
  const body = express.json({ limit: BODY_LIMIT });
  app.use("/mcp", auth, body);

  // Stateless Streamable HTTP: a fresh McpServer + transport per request.
  app.post("/mcp", async (req, res) => {
    // Batching was removed from the protocol (2025-06-18) and would multiply every per-call limit.
    if (Array.isArray(req.body)) return jsonRpcError(res, 400, -32600, "Invalid Request: JSON-RPC batches are not supported");
    const server = createMcpServer({ ...opts.tools, guard }, res.locals.auth as AuthContext);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    let cleanedUp = false;
    const cleanup = (): void => {
      if (cleanedUp) return;
      cleanedUp = true;
      for (const closer of [transport, server]) {
        try {
          void closer.close();
        } catch (err) {
          console.error("Error closing MCP transport/server:", err);
        }
      }
    };
    res.on("close", cleanup);
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("Error handling MCP request:", err);
      if (!res.headersSent) jsonRpcError(res, 500, -32603, "Internal server error");
      cleanup();
    }
  });

  // Stateless mode doesn't support SSE streams or session termination.
  const notAllowed = (_req: Request, res: Response): void => jsonRpcError(res, 405, -32000, "Method not allowed.");
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);

  // Final error handler: JSON-RPC envelope, never a stack trace.
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const e = err as { type?: string; status?: unknown; statusCode?: unknown; expose?: unknown; message?: unknown };
    const errStatus = e.status ?? e.statusCode;
    let status = 500;
    let code = -32603;
    let message = "Internal server error";
    if (e.type === "entity.too.large") {
      status = 413;
      code = -32600;
      message = "Request too large (max 1 MB)";
    } else if (e.type === "entity.parse.failed") {
      status = 400;
      code = -32700;
      message = "Parse error: invalid JSON";
    } else if (typeof errStatus === "number" && Number.isInteger(errStatus) && errStatus >= 400 && errStatus < 500 && e.expose === true && typeof e.message === "string") {
      // body-parser / raw-body client errors (415 charset/encoding, 400 aborted, ...).
      status = errStatus;
      code = -32600;
      message = e.message;
    }
    if (status === 500) console.error("Unhandled request error:", err);
    const ctx = res.locals.auth as AuthContext | undefined;
    if (ctx) {
      opts.audit.safeLog({ credentialId: ctx.credentialId, credentialName: ctx.name, tool: "http", result: "error", detail: `${status} ${message}`, clientIp: ctx.clientIp ?? req.ip });
    }
    jsonRpcError(res, status, code, message);
  });

  return app;
}

export async function start(): Promise<{ server: Server; shutdown: (signal?: string) => Promise<void> }> {
  const dbPath = process.env.DB_PATH;
  if (!dbPath) {
    console.error("DB_PATH environment variable is required");
    process.exit(1);
  }
  const port = Number(process.env.PORT) || 3000;
  let registry;
  try {
    registry = loadRegistry();
  } catch (err) {
    if (!(err instanceof RegistryError)) throw err;
    console.error(err.message);
    process.exit(1);
  }
  console.log(`registry ok: ${registry.servers.length} server(s), ${registry.tenants.length} tenant(s)`);

  const db = openDb(dbPath);
  const audit = new AuditLog(db);
  const tokens = new TokenStore(db);
  const connectorKeys = new ConnectorKeyStore(db);
  const authAudit = new AuthFailureAudit(audit, posInt(process.env.AUTH_AUDIT_MAX_PER_MIN, 30));
  const trustedProxy = createTrustedProxy(process.env.TRUSTED_PROXY);
  await trustedProxy.refresh();

  const lifecycle = new Lifecycle();
  const app = createApp({ db, tokens, connectorKeys, audit, authAudit, lifecycle, trustedProxy, tools: { registry, audit, cluster: cachedClusterSources(), prom: new PromClient(process.env.PROM_URL || "http://prometheus:9090"), grafana: grafanaFromEnv(process.env) } });
  let server: Server;
  try {
    server = await listen(app, port);
  } catch (err) {
    console.error(`cannot listen on port ${port}: ${errorMessage(err)}`);
    process.exit(1);
  }
  console.log(`ops-mcp listening on port ${port}`);
  const webAdmin = await startWebAdmin({ tokens, connectorKeys, audit, lifecycle }, trustedProxy);

  const shutdown = createShutdown({
    servers: webAdmin ? [server, webAdmin] : [server],
    lifecycle,
    stop: () => trustedProxy.stop(),
    closeDb: () => {
      authAudit.flush();
      db.close();
    },
  });
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  return { server, shutdown };
}

// Guard so this module can be imported for testing without binding a port.
if (require.main === module) {
  start().catch((err) => {
    console.error("fatal:", redactAll(errorMessage(err)));
    process.exit(1);
  });
}
