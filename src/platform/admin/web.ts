// vendored from second-brain-mcp@d4ba1c5
// Identity headers are trusted only from a TRUSTED_PROXY peer that presents the Traefik-injected proxy secret.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import express, { Express, NextFunction, Request, Response } from "express";
import type { AuditLog } from "../audit";
import { CONNECTOR_HEADER, ConnectorKeyStore } from "../auth/connectorKeys";
import { CredentialError, TokenStore } from "../auth/tokens";
import type { Lifecycle, TrustedProxy } from "../http";
import { listen } from "../listen";
import { claudeAddCommand, mcpUrl } from "../mcpCommand";
import { errorMessage, readSecret } from "../util";
import { redactAll } from "../redact/secrets";
import type { SafeHtml } from "../web/html";
import { CSS, ICON_SVG, JS, THEME_JS } from "../web/assets";
import { auditView } from "../web/auditView";
import { connectorKeyCreatedView, credentialsView, tokenCreatedView } from "../web/tokenViews";
import { Banner, Ctx, errorView } from "../web/views";
import { OneTimeStore } from "./onetime";

export const DEFAULT_WEB_PORT = 3002;
export const DEFAULT_ADMIN_GROUP = "admins";
export const MIN_PROXY_SECRET = 32;
export const PROXY_HEADER = "x-ops-admin-proxy";
export const DEFAULT_SESSION_COOKIE = "authelia_session";

const BUCKET_MS = 4 * 3_600_000;
const FLASH_TTL_MS = 5 * 60_000;
const NONCE_TTL_MS = 30 * 60_000;

export function webPort(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.ADMIN_WEB_PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_WEB_PORT;
}

export interface WebAdminOptions {
  tokens: TokenStore;
  connectorKeys: ConnectorKeyStore;
  audit: AuditLog;
  trustedProxy: TrustedProxy;
  lifecycle?: Lifecycle;
  adminGroup?: string;
  // CSRF key and sealing key of the connector keys (ADMIN_WEB_SECRET).
  secret?: string;
  // Shared secret Traefik injects (X-Ops-Admin-Proxy) after Authelia; required, >= 32 chars.
  proxySecret: string;
  sessionCookie?: string;
  // Public MCP endpoint shown in the post-creation `claude mcp add` command (default: PUBLIC_MCP_URL).
  mcpUrl?: string;
}

const sha256 = (v: string): Buffer => createHash("sha256").update(v).digest();

// Constant-time string compare (digests first, so lengths do not leak).
export const safeEqual = (a: string, b: string): boolean => timingSafeEqual(sha256(a), sha256(b));

// ---- CSRF ------------------------------------------------------------------

// Bound to the user and to the Authelia session cookie: a new login invalidates old tokens.
export function csrfToken(secret: string, user: string, session: string, now = Date.now()): string {
  return createHmac("sha256", secret)
    .update(`${user}\0${sha256(session).toString("hex")}\0${Math.floor(now / BUCKET_MS)}`)
    .digest("hex");
}

// Accepts the current and the previous 4-hour bucket.
export function csrfValid(secret: string, user: string, session: string, given: unknown, now = Date.now()): boolean {
  if (!session || typeof given !== "string" || given.length !== 64) return false;
  return [now, now - BUCKET_MS].some((t) => safeEqual(csrfToken(secret, user, session, t), given));
}

function cookieValue(req: Request, name: string): string {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}

function sameOrigin(req: Request): boolean {
  const host = req.headers.host;
  if (!host) return false;
  const src = req.headers.origin ?? req.headers.referer;
  if (typeof src !== "string") return false;
  try {
    return new URL(src).host === host;
  } catch {
    return false;
  }
}

// ---- helpers ---------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FLASH_RE = /^[0-9a-f]{32}$/;
const AUDIT_TOOL_RE = /^[a-z0-9_]{1,64}$/;
const AUDIT_ID_RE = /^[1-9]\d{0,14}$/;

type Flash =
  | { kind: "banner"; banner: Banner }
  | { kind: "ckey"; created: { id: string; name: string; key: string } }
  | { kind: "token"; created: { id: string; name: string; token: string; expires_at: string | null } };

const str = (v: unknown): string => (typeof v === "string" ? v : "");

// ---- app -------------------------------------------------------------------

export function createWebAdminApp(opts: WebAdminOptions): Express {
  const { tokens, connectorKeys, audit, trustedProxy, lifecycle, proxySecret } = opts;
  if (typeof proxySecret !== "string" || proxySecret.length < MIN_PROXY_SECRET) {
    throw new Error(`ADMIN_PROXY_SECRET must be at least ${MIN_PROXY_SECRET} characters`);
  }
  const adminGroup = opts.adminGroup || DEFAULT_ADMIN_GROUP;
  const sessionCookie = opts.sessionCookie || DEFAULT_SESSION_COOKIE;
  const publicMcpUrl = opts.mcpUrl ?? mcpUrl();
  // Without ADMIN_WEB_SECRET the CSRF tokens reset on restart (forms must be reloaded).
  const secret = opts.secret || randomBytes(32).toString("hex");
  // Encryption secret of the stored keys: ADMIN_WEB_SECRET only (a per-boot random key would lose them).
  const keySecret = opts.secret || undefined;
  const flash = new OneTimeStore<Flash>(FLASH_TTL_MS, 200);
  const nonces = new OneTimeStore<true>(NONCE_TTL_MS, 5000);

  const app = express();
  app.disable("x-powered-by");

  // Tracked like /mcp requests so shutdown waits for them; new ones refused once it began.
  app.use((_req, res, next) => {
    if (lifecycle) {
      if (lifecycle.shuttingDown) {
        res.setHeader("Connection", "close");
        res.status(503).type("text/plain").send("server is shutting down");
        return;
      }
      lifecycle.enter(res);
    }
    next();
  });

  app.use((_req, res, next) => {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
    );
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  // Identity: the direct peer must be a trusted proxy AND carry the secret Traefik injects after
  // Authelia; only then are the Remote-* headers believed.
  app.use((req, res, next) => {
    const peer = req.socket.remoteAddress;
    const proxyHeader = req.headers[PROXY_HEADER];
    if (!peer || !trustedProxy.trust(peer) || typeof proxyHeader !== "string" || !safeEqual(proxyHeader, proxySecret)) {
      res.status(401).type("text/plain").send("unauthorized");
      return;
    }
    const user = req.headers["remote-user"];
    if (typeof user !== "string" || user.length < 1 || user.length > 64 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(user)) {
      res.status(401).type("text/plain").send("unauthorized");
      return;
    }
    const groups = String(req.headers["remote-groups"] ?? "")
      .split(",")
      .map((g) => g.trim());
    if (!groups.includes(adminGroup)) {
      res.status(403).type("text/plain").send("forbidden");
      return;
    }
    res.locals.user = user;
    res.locals.actor = `admin:${user}`;
    res.locals.session = cookieValue(req, sessionCookie);
    next();
  });

  const userOf = (res: Response): string => res.locals.user as string;
  const ctxOf = (res: Response): Ctx => {
    const user = userOf(res);
    return { user, csrf: csrfToken(secret, user, res.locals.session as string), nonce: () => nonces.put(true, user) };
  };
  const send = (res: Response, view: SafeHtml, status = 200): void => void res.status(status).type("html").send(view.value);

  // Post-Redirect-Get: the outcome lives in a one-time flash shown once on the target page.
  const redirectWithFlash = (res: Response, to: string, value: Flash): void => {
    res.redirect(303, `${to}${to.includes("?") ? "&" : "?"}flash=${flash.put(value, userOf(res))}`);
  };
  const takeBanner = (req: Request, res: Response): Banner | undefined => {
    const f = FLASH_RE.test(str(req.query.flash)) ? flash.take(req.query.flash, userOf(res)) : undefined;
    return f?.kind === "banner" ? f.banner : undefined;
  };
  const tokensBanner = (res: Response, banner: Banner): void => redirectWithFlash(res, "/tokens", { kind: "banner", banner });

  app.get("/static/style.css", (_req, res) => void res.type("text/css").send(CSS));
  app.get("/static/app.js", (_req, res) => void res.type("application/javascript").send(JS));
  app.get("/static/theme.js", (_req, res) => void res.type("application/javascript").send(THEME_JS));
  app.get("/static/icon.svg", (_req, res) => void res.type("image/svg+xml").send(ICON_SVG));

  // State-changing requests: same-host Origin/Referer, session-bound CSRF token, then a one-time form
  // nonce (a replayed or duplicate POST is refused).
  app.use(express.urlencoded({ extended: false, limit: "32kb" }));
  app.use((req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD") return next();
    if (req.method !== "POST") return void res.status(405).type("text/plain").send("method not allowed");
    if (!sameOrigin(req)) return void res.status(403).type("text/plain").send("forbidden: cross-origin request");
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!csrfValid(secret, userOf(res), res.locals.session as string, body.csrf)) {
      return void res.status(403).type("text/plain").send("forbidden: invalid or missing CSRF token (reload the page)");
    }
    if (!nonces.take(body.nonce, userOf(res))) {
      return void send(res, errorView(ctxOf(res), 409, "This form was already submitted (or has expired). Reload the page and try again."), 409);
    }
    next();
  });

  const auditAdmin = (res: Response, tool: string, result: "ok" | "error", detail: string): void => {
    const actor = res.locals.actor as string;
    audit.safeLog({ credentialId: actor, credentialName: actor, tool, result, detail });
  };

  app.get("/", (_req, res) => void res.redirect(302, "/tokens"));

  // ---- tokens and connector keys ----

  const idParam = (_req: Request, res: Response, next: NextFunction, id: string): void => {
    if (!UUID_RE.test(id)) return void send(res, errorView(ctxOf(res), 400, "invalid id"), 400);
    next();
  };

  const tokensRouter = express.Router();
  tokensRouter.param("id", idParam);

  app.get("/tokens", (req, res, next) => {
    try {
      send(res, credentialsView(ctxOf(res), tokens.list(), connectorKeys.list(), takeBanner(req, res)));
    } catch (err) {
      next(err);
    }
  });

  // The plaintext is reachable only through this one-time flash, never rendered by the POST.
  tokensRouter.get("/created/:flashId", (req, res) => {
    const fid = req.params.flashId as string;
    const f = FLASH_RE.test(fid) ? flash.take(fid, userOf(res)) : undefined;
    if (f?.kind !== "token") {
      const msg = "This page was already shown or has expired. A token cannot be retrieved again; revoke it and create a new one if it was lost.";
      return void send(res, errorView(ctxOf(res), 404, msg), 404);
    }
    send(res, tokenCreatedView(ctxOf(res), f.created, claudeAddCommand(publicMcpUrl, `Authorization: Bearer ${f.created.token}`)));
  });

  tokensRouter.post("/", (req, res) => {
    const body = req.body as Record<string, unknown>;
    const days = str(body.expires_in_days).trim();
    try {
      if (days && !/^\d{1,4}$/.test(days)) throw new CredentialError("Expires in (days) must be an integer between 1 and 3650.");
      const created = tokens.create(str(body.name), { expiresInDays: days ? Number(days) : undefined });
      // Flash first: nothing after the token exists may lose the one chance to show it.
      const to = `/tokens/created/${flash.put({ kind: "token", created }, userOf(res))}`;
      auditAdmin(res, "admin_token_create", "ok", `${created.id} ${created.name}`);
      res.redirect(303, to);
    } catch (err) {
      if (err instanceof CredentialError) return tokensBanner(res, { kind: "err", title: err.message });
      throw err;
    }
  });

  tokensRouter.post("/:id/revoke", (req, res) => {
    const id = req.params.id as string;
    if (tokens.revoke(id)) {
      auditAdmin(res, "admin_token_revoke", "ok", id);
      tokensBanner(res, { kind: "ok", title: `Token ${id} revoked.` });
    } else {
      auditAdmin(res, "admin_token_revoke", "error", `${id} not found or already revoked`);
      tokensBanner(res, { kind: "err", title: "Token not found or already revoked." });
    }
  });
  app.use("/tokens", tokensRouter);

  const keysRouter = express.Router();
  keysRouter.param("id", idParam);
  const claudeKeyCommand = (key: string): string => claudeAddCommand(publicMcpUrl, `${CONNECTOR_HEADER}: ${key}`);

  // The plaintext key is reachable only through this one-time flash.
  keysRouter.get("/created/:flashId", (req, res) => {
    const fid = req.params.flashId as string;
    const f = FLASH_RE.test(fid) ? flash.take(fid, userOf(res)) : undefined;
    if (f?.kind !== "ckey") return void send(res, errorView(ctxOf(res), 404, "This page was already shown or has expired. Reveal the key from the Tokens page, or revoke it and create a new one."), 404);
    send(res, connectorKeyCreatedView(ctxOf(res), f.created, claudeKeyCommand(f.created.key)));
  });

  keysRouter.post("/", (req, res) => {
    try {
      const c = connectorKeys.create(str((req.body as Record<string, unknown>).name), keySecret);
      // Flash first, so nothing after the key exists can lose the one chance to show it.
      const to = `/keys/created/${flash.put({ kind: "ckey", created: c }, userOf(res))}`;
      auditAdmin(res, "admin_connector_key_create", "ok", `${c.id} ${c.name}`);
      res.redirect(303, to);
    } catch (err) {
      if (err instanceof CredentialError) return tokensBanner(res, { kind: "err", title: err.message });
      throw err;
    }
  });

  keysRouter.post("/:id/reveal", (req, res) => {
    const r = connectorKeys.reveal({ id: req.params.id as string }, keySecret);
    // The value is never audited, only the fact that it was shown.
    auditAdmin(res, "connector_key_reveal", r.status === "ok" ? "ok" : "error", `${req.params.id} ${r.status}`);
    if (r.status !== "ok") {
      return tokensBanner(res, { kind: "err", title: r.status === "missing" || r.status === "ambiguous" ? "Key not found or revoked." : "Cannot decrypt this key (the secret changed or it predates it): create a new key. It still works as is." });
    }
    res.setHeader("Cache-Control", "no-store");
    send(res, connectorKeyCreatedView(ctxOf(res), r, claudeKeyCommand(r.key), true));
  });

  keysRouter.post("/:id/revoke", (req, res) => {
    const id = req.params.id as string;
    const ok = connectorKeys.revoke(id);
    auditAdmin(res, "admin_connector_key_revoke", ok ? "ok" : "error", ok ? id : `${id} not found or already revoked`);
    tokensBanner(res, ok ? { kind: "ok", title: "Key revoked." } : { kind: "err", title: "Key not found or already revoked." });
  });
  app.use("/keys", keysRouter);

  // ---- audit log (read-only) ----

  app.get("/audit", (req, res) => {
    const bad = (m: string): void => send(res, errorView(ctxOf(res), 400, m), 400);
    // Empty form fields mean "no filter"; anything else must validate.
    const opt = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
    if (["before", "credential", "tool"].some((k) => req.query[k] !== undefined && typeof req.query[k] !== "string")) return bad("invalid filter");
    const before = opt(req.query.before);
    const credential = opt(req.query.credential);
    const tool = opt(req.query.tool);
    if (before !== undefined && !AUDIT_ID_RE.test(before)) return bad("invalid before id");
    if (tool !== undefined && !AUDIT_TOOL_RE.test(tool)) return bad("invalid tool filter");
    if (credential !== undefined && (credential.length > 256 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(credential))) return bad("invalid credential filter");
    const { rows, nextBefore } = audit.query({ before: before === undefined ? undefined : Number(before), credentialName: credential, tool });
    send(res, auditView(ctxOf(res), rows, nextBefore, { credential, tool }));
  });

  app.use((_req, res) => void send(res, errorView(ctxOf(res), 404, "Page not found."), 404));
  // Never leak internals; the real reason goes to the log only.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(`web admin error: ${redactAll(errorMessage(err))}`);
    if (res.headersSent) return;
    const e = err as { type?: string };
    if (e.type === "entity.too.large") return void send(res, errorView(ctxOf(res), 413, "Request too large."), 413);
    send(res, errorView(ctxOf(res), 500, "Internal error."), 500);
  });
  return app;
}

// Binds all interfaces (Traefik reaches it over the overlay network); the peer check, the proxy secret
// and the group check above are what protect it. Refuses to start without TRUSTED_PROXY or a strong
// ADMIN_PROXY_SECRET.
export async function startWebAdmin(
  deps: Pick<WebAdminOptions, "tokens" | "connectorKeys" | "audit" | "lifecycle">,
  trustedProxy: TrustedProxy,
  env: NodeJS.ProcessEnv = process.env,
  port = webPort(env),
): Promise<Server | undefined> {
  if (!env.TRUSTED_PROXY?.trim()) {
    console.error("web admin disabled: TRUSTED_PROXY is not set (identity headers cannot be trusted without it)");
    return undefined;
  }
  const proxySecret = readSecret("ADMIN_PROXY_SECRET", env) ?? "";
  if (proxySecret.length < MIN_PROXY_SECRET) {
    console.error(`web admin disabled: ADMIN_PROXY_SECRET must be set (at least ${MIN_PROXY_SECRET} characters)`);
    return undefined;
  }
  try {
    const app = createWebAdminApp({
      ...deps,
      trustedProxy,
      adminGroup: env.ADMIN_GROUP || DEFAULT_ADMIN_GROUP,
      secret: readSecret("ADMIN_WEB_SECRET", env),
      proxySecret,
      sessionCookie: env.AUTHELIA_SESSION_COOKIE || undefined,
    });
    const s = await listen(app, port);
    console.log(`web admin listening on port ${port} (behind Traefik + Authelia only)`);
    return s;
  } catch (err) {
    console.error(`web admin disabled, cannot listen on port ${port}: ${errorMessage(err)}`);
    return undefined;
  }
}
