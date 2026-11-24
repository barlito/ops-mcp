import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { testStores, type TestStores } from "../../test-support/fixtures";
import type { TrustedProxy } from "../http";
import { createWebAdminApp, csrfToken, csrfValid, PROXY_HEADER } from "./web";

const SECRET = "test-secret";
const PROXY_SECRET = "p".repeat(40);
const SESSION = "session-one";
const ADMIN = { "remote-user": "barlito", "remote-groups": "admins,dev", [PROXY_HEADER]: PROXY_SECRET, cookie: `authelia_session=${SESSION}` };

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let stores: TestStores;
let server: http.Server;
let port: number;
let trusted = true;

const request = (method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Res> =>
  new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let b = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
    });
    r.on("error", reject);
    r.end(body);
  });

const get = (path: string, headers: Record<string, string> = ADMIN) => request("GET", path, headers);

// One-time nonce of the form posting to `action`, taken from the page that renders it.
async function nonceFor(action: string, page = "/tokens"): Promise<string> {
  const r = await get(page);
  const m = new RegExp(`action="${action}"[^>]*>\\s*<input type="hidden" name="csrf" value="[^"]*"><input type="hidden" name="nonce" value="([0-9a-f]{32})"`).exec(r.body);
  assert.ok(m, `form ${action} on ${page}`);
  return m[1]!;
}

async function post(path: string, fields: Record<string, string>, over: { origin?: string | null; csrf?: string | null; nonce?: string | null; nonceAction?: string } = {}): Promise<Res> {
  const f = { ...fields };
  const t = over.csrf === undefined ? csrfToken(SECRET, "barlito", SESSION) : over.csrf;
  if (t !== null) f.csrf = t;
  const n = over.nonce === undefined ? await nonceFor(over.nonceAction ?? path) : over.nonce;
  if (n !== null) f.nonce = n;
  const headers: Record<string, string> = { ...ADMIN, "content-type": "application/x-www-form-urlencoded", host: `127.0.0.1:${port}` };
  if (over.origin !== null) headers.origin = over.origin ?? `http://127.0.0.1:${port}`;
  return request("POST", path, headers, new URLSearchParams(f).toString());
}

// Follows the 303 to the one-time page and returns it.
async function follow(r: Res): Promise<Res> {
  assert.equal(r.status, 303);
  return get(r.headers.location as string);
}

before(async () => {
  stores = testStores();
  const trustedProxy: TrustedProxy = { trust: () => trusted, refresh: async () => {}, stop: () => {} };
  const app = createWebAdminApp({ ...stores, trustedProxy, secret: SECRET, proxySecret: PROXY_SECRET, mcpUrl: "https://ops.example/mcp" });
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

after(() => new Promise<void>((r) => server.close(() => r())));

test("the proxy secret and a trusted peer are both required", async () => {
  assert.equal((await request("GET", "/tokens", { "remote-user": "x", "remote-groups": "admins" })).status, 401);
  assert.equal((await get("/tokens", { ...ADMIN, [PROXY_HEADER]: "wrong".repeat(10) })).status, 401);
  trusted = false;
  assert.equal((await get("/tokens")).status, 401);
  trusted = true;
  assert.equal((await get("/tokens")).status, 200);
});

test("identity headers: user required, admins group required", async () => {
  assert.equal((await get("/tokens", { ...ADMIN, "remote-user": "" })).status, 401);
  assert.equal((await get("/tokens", { ...ADMIN, "remote-user": "x".repeat(65) })).status, 401);
  assert.equal((await get("/tokens", { ...ADMIN, "remote-groups": "dev,ops" })).status, 403);
  assert.equal((await get("/tokens", { ...ADMIN, "remote-groups": "" })).status, 403);
});

test("the admin refuses to be built without a strong proxy secret", () => {
  assert.throws(() => createWebAdminApp({ ...stores, trustedProxy: { trust: () => true, refresh: async () => {}, stop: () => {} }, proxySecret: "short" }), /ADMIN_PROXY_SECRET/);
});

test("security headers: strict CSP, frame, referrer, on every response", async () => {
  for (const r of [await get("/tokens"), await get("/nope"), await request("GET", "/tokens", {}), await get("/static/style.css")]) {
    const csp = String(r.headers["content-security-policy"]);
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    assert.equal(r.headers["x-frame-options"], "DENY");
    assert.equal(r.headers["referrer-policy"], "same-origin");
    assert.equal(r.headers["x-content-type-options"], "nosniff");
  }
});

test("pages carry no inline style, inline script or inline event handlers (CSP)", async () => {
  const t = await follow(await post("/tokens", { name: "csp-token", expires_in_days: "30" }));
  const k = await follow(await post("/keys", { name: "csp-key" }, { nonceAction: "/keys" }));
  stores.audit.log({ credentialId: "c", credentialName: "csp", tool: "ops_list_servers", result: "ok", query: "<script>alert(1)</script>", window: "2026-01-01T00:00:00.000Z/2026-01-01T01:00:00.000Z", detail: "detail-marker" });
  const pages = [(await get("/tokens")).body, (await get("/audit")).body, (await get("/audit?tool=ops_list_servers&credential=csp")).body, (await get("/nope")).body, t.body, k.body];
  assert.match(pages[0]!, /csp-token/);
  assert.match(pages[1]!, /ops_list_servers/);
  assert.match(pages[1]!, /2026-01-01T00:00:00.000Z\/2026-01-01T01:00:00.000Z/);
  assert.match(pages[1]!, /detail-marker/);
  assert.match(pages[1]!, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  for (const body of pages) {
    assert.ok(body.length > 200);
    assert.doesNotMatch(body, /\sstyle\s*=/i);
    assert.doesNotMatch(body, /\son[a-z]+\s*=/i);
    assert.doesNotMatch(body, /<script(?![^>]*\ssrc=)/i);
    assert.doesNotMatch(body, /javascript:/i);
  }
});

test("static assets are served, dark mode included, no PWA surface", async () => {
  const css = await get("/static/style.css");
  assert.match(css.headers["content-type"] ?? "", /text\/css/);
  assert.match(css.body, /prefers-color-scheme: dark/);
  assert.match((await get("/static/app.js")).headers["content-type"] ?? "", /javascript/);
  assert.match((await get("/static/theme.js")).body, /ops-theme/);
  assert.equal((await get("/static/icon.svg")).status, 200);
  assert.equal((await get("/manifest.webmanifest")).status, 404);
  assert.equal((await get("/sw.js")).status, 404);
  assert.equal((await get("/static/style.css", { "x-ops-admin-proxy": PROXY_SECRET })).status, 401);
});

test("/ redirects to the tokens page", async () => {
  const r = await get("/");
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, "/tokens");
});

test("creating a token shows it once, then never again, and it authenticates", async () => {
  const created = await follow(await post("/tokens", { name: "from-admin", expires_in_days: "7" }));
  assert.equal(created.status, 200);
  const token = /(ops_[A-Za-z0-9_-]{43})/.exec(created.body)?.[1];
  assert.ok(token);
  assert.match(created.body, /Authorization: Bearer ops_/);
  assert.match(created.body, /https:\/\/ops\.example\/mcp/);
  assert.equal(stores.tokens.check(token).status, "ok");
  const row = stores.db.prepare("SELECT * FROM audit_log WHERE tool = 'admin_token_create'").get() as Record<string, string>;
  assert.equal(row.credential_name, "admin:barlito");
  assert.ok(!JSON.stringify(row).includes(token));
  assert.ok(!(await get("/tokens")).body.includes(token));
});

test("the one-time page cannot be replayed", async () => {
  const r = await post("/tokens", { name: "once" });
  const loc = r.headers.location as string;
  assert.equal((await get(loc)).status, 200);
  assert.equal((await get(loc)).status, 404);
});

test("revoking a token", async () => {
  const t = stores.tokens.create("to-revoke");
  const r = await post(`/tokens/${t.id}/revoke`, {}, { nonceAction: `/tokens/${t.id}/revoke` });
  assert.equal(r.status, 303);
  assert.equal(stores.tokens.check(t.token).status, "invalid");
  assert.equal((await get("/tokens/not-a-uuid/revoke")).status, 404);
  assert.equal((await post("/tokens/not-a-uuid/revoke", {}, { nonce: "x" })).status, 409);
});

test("connector keys: create, reveal (audited, value never audited), revoke", async () => {
  const created = await follow(await post("/keys", { name: "claude-ai" }, { nonceAction: "/keys" }));
  const key = /(opsk_[A-Za-z0-9_-]{43})/.exec(created.body)?.[1];
  assert.ok(key);
  assert.match(created.body, /x-api-key/);
  const entry = stores.connectorKeys.list().find((k) => k.name === "claude-ai")!;
  assert.deepEqual(stores.connectorKeys.check(key), { id: entry.id, name: "claude-ai" });

  const revealed = await post(`/keys/${entry.id}/reveal`, {}, { nonceAction: `/keys/${entry.id}/reveal` });
  assert.equal(revealed.status, 200);
  assert.ok(revealed.body.includes(key));
  const reveals = stores.db.prepare("SELECT * FROM audit_log WHERE tool = 'connector_key_reveal'").all();
  assert.equal(reveals.length, 1);
  assert.ok(!JSON.stringify(reveals).includes(key));

  const revoked = await post(`/keys/${entry.id}/revoke`, {}, { nonceAction: `/keys/${entry.id}/revoke` });
  assert.equal(revoked.status, 303);
  assert.equal(stores.connectorKeys.check(key), null);
});

test("POSTs need a same-origin request, a valid CSRF token and a fresh nonce", async () => {
  assert.equal((await post("/tokens", { name: "x" }, { origin: "http://evil.example" })).status, 403);
  assert.equal((await post("/tokens", { name: "x" }, { origin: null })).status, 403);
  assert.equal((await post("/tokens", { name: "x" }, { csrf: null })).status, 403);
  assert.equal((await post("/tokens", { name: "x" }, { csrf: "0".repeat(64) })).status, 403);
  assert.equal((await post("/tokens", { name: "x" }, { csrf: csrfToken(SECRET, "someone-else", SESSION) })).status, 403);
  assert.equal((await post("/tokens", { name: "x" }, { nonce: null })).status, 409);
  const nonce = await nonceFor("/tokens");
  assert.equal((await post("/tokens", { name: "once-only" }, { nonce })).status, 303);
  assert.equal((await post("/tokens", { name: "once-only" }, { nonce })).status, 409, "replayed nonce");
  assert.equal((await request("PUT", "/tokens", ADMIN)).status, 405);
});

test("invalid input is reported in a banner, not as a crash", async () => {
  const r = await post("/tokens", { name: "" });
  assert.equal(r.status, 303);
  assert.match((await get(r.headers.location as string)).body, /name must be 1-64 characters/);
  const days = await post("/tokens", { name: "x", expires_in_days: "99999" });
  assert.match((await get(days.headers.location as string)).body, /between 1 and 3650/);
});

test("audit filters are validated", async () => {
  for (const q of ["before=abc", "before=0", "tool=Bad Tool", "credential=" + "x".repeat(300), "tool=a&tool=b"]) {
    assert.equal((await get(`/audit?${q.replace(" ", "%20")}`)).status, 400, q);
  }
  assert.equal((await get("/audit?before=5&tool=&credential=")).status, 200);
});

test("CSRF tokens are bound to user and session and expire after two buckets", () => {
  const now = Date.now();
  const t = csrfToken(SECRET, "u", "s", now);
  assert.ok(csrfValid(SECRET, "u", "s", t, now));
  assert.ok(csrfValid(SECRET, "u", "s", t, now + 4 * 3_600_000));
  assert.ok(!csrfValid(SECRET, "u", "s", t, now + 9 * 3_600_000));
  assert.ok(!csrfValid(SECRET, "v", "s", t, now));
  assert.ok(!csrfValid(SECRET, "u", "other", t, now));
  assert.ok(!csrfValid(SECRET, "u", "", t, now));
});
