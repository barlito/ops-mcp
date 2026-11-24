// vendored from second-brain-mcp@d4ba1c5
import { CONNECTOR_HEADER, type ConnectorKeyEntry } from "../auth/connectorKeys";
import type { TokenListEntry } from "../auth/tokens";
import { html, raw, SafeHtml } from "./html";
import { Banner, bannerView, csrfField, Ctx, ICON, layout, pageHead, relTime, shortDate } from "./views";

const EXPIRIES: Array<[string, string]> = [["7", "7 days"], ["30", "30 days"], ["90", "90 days · recommended"], ["365", "1 year"], ["", "Never"]];

const statusBadge = (revokedAt: string | null, expired: boolean): SafeHtml =>
  revokedAt
    ? html`<span class="badge" title="Revoked ${revokedAt}">Revoked ${shortDate(revokedAt)}</span>`
    : expired
      ? html`<span class="badge err">Expired</span>`
      : html`<span class="badge ok">Active</span>`;

export function credentialsView(ctx: Ctx, tokens: TokenListEntry[], keys: ConnectorKeyEntry[], banner?: Banner): SafeHtml {
  return layout(
    ctx,
    "/tokens",
    "Tokens",
    html`${pageHead("Tokens", "Every authenticated client reads everything: grant a token or a connector key only to clients you trust.")}
${bannerView(banner)}
<h2>API tokens</h2>
<p class="muted">Sent as <code>Authorization: Bearer &lt;token&gt;</code> (Claude Code, scripts).</p>
<div class="card clip"><div class="scroll"><table class="tbl">
<thead><tr><th>Token</th><th>Last used</th><th>Expires</th><th>Status</th><th><span class="sr">Actions</span></th></tr></thead>
<tbody>${
      tokens.length === 0
        ? html`<tr><td colspan="5"><div class="empty"><strong>No tokens</strong></div></td></tr>`
        : tokens.map(
            (t) => html`<tr class="${t.revoked_at ? "is-revoked" : ""}">
<td><div class="stack g4"><span class="nm"><strong>${t.name}</strong></span><span class="mono muted small" title="${t.id}">${t.id}</span></div></td>
<td><span title="${t.last_used_at ?? ""}">${t.last_used_at ? relTime(t.last_used_at) : "Never used"}</span></td>
<td>${t.expires_at ? html`<span title="${t.expires_at}">${shortDate(t.expires_at)}</span>` : "Never"}</td>
<td>${statusBadge(t.revoked_at, t.expired)}</td>
<td>${t.revoked_at ? "" : html`<form method="post" action="/tokens/${t.id}/revoke" class="inline" data-confirm="Revoke this token? Clients using it will stop working.">${csrfField(ctx)}<button class="btn btn-danger btn-sm" type="submit">Revoke</button></form>`}</td>
</tr>`,
          )
    }</tbody></table></div></div>
<form method="post" action="/tokens" class="card pad stack g12">
${csrfField(ctx)}
<div class="stack"><label class="lbl" for="token-name">New token name <span class="hint">(1-64 characters, e.g. claude-laptop)</span></label>
<input class="field w420" type="text" id="token-name" name="name" maxlength="64" required></div>
<fieldset class="chipset"><legend class="lbl">Expires</legend>${EXPIRIES.map(
      ([v, label]) => html`<label class="chip"><input type="radio" name="expires_in_days" value="${v}"${v === "90" ? raw(" checked") : ""}><span>${label}</span></label>`,
    )}</fieldset>
<div class="actions"><button class="btn btn-primary" type="submit">${ICON.plus}Create token</button></div>
</form>
<h2>Connector keys</h2>
<p class="muted">Sent in the <code>${CONNECTOR_HEADER}</code> header: the claude.ai custom connector "Request headers", or <code>--header</code> in Claude Code.</p>
<div class="card clip"><div class="scroll"><table class="tbl">
<thead><tr><th>Key</th><th>Created</th><th>Last used</th><th>Status</th><th><span class="sr">Actions</span></th></tr></thead>
<tbody>${
      keys.length === 0
        ? html`<tr><td colspan="5"><div class="empty"><strong>No connector keys</strong></div></td></tr>`
        : keys.map(
            (k) => html`<tr class="${k.revoked_at ? "is-revoked" : ""}">
<td><div class="stack g4"><span class="nm"><strong>${k.name}</strong></span><span class="mono muted small" title="${k.id}">${k.id}</span></div></td>
<td class="mono small">${shortDate(k.created_at)}</td>
<td><span title="${k.last_used_at ?? ""}">${k.last_used_at ? relTime(k.last_used_at) : "Never used"}</span></td>
<td>${statusBadge(k.revoked_at, false)}</td>
<td>${k.revoked_at ? "" : html`<div class="row"><form method="post" action="/keys/${k.id}/reveal" class="inline">${csrfField(ctx)}<button class="btn btn-sm" type="submit">Reveal</button></form><form method="post" action="/keys/${k.id}/revoke" class="inline" data-confirm="Revoke this key? Clients using it will stop working.">${csrfField(ctx)}<button class="btn btn-danger btn-sm" type="submit">Revoke</button></form></div>`}</td>
</tr>`,
          )
    }</tbody></table></div></div>
<form method="post" action="/keys" class="card pad stack g12">
${csrfField(ctx)}
<div class="stack"><label class="lbl" for="key-name">New key name <span class="hint">(1-64 characters, e.g. claude-ai)</span></label>
<input class="field w420" type="text" id="key-name" name="name" maxlength="64" required></div>
<div class="actions"><button class="btn btn-primary" type="submit">${ICON.plus}Create key</button></div>
</form>`,
  );
}

const copyBlock = (id: string, label: string, value: string, rows: number): SafeHtml =>
  html`<textarea class="field cmd" id="${id}" readonly rows="${rows}" spellcheck="false" aria-label="${label}">${value}</textarea>
<div class="actions"><button type="button" class="btn btn-dark" data-copy="${id}">${ICON.copy}Copy</button><span class="status" id="${id}-status" role="status"></span></div>`;

export function tokenCreatedView(
  ctx: Ctx,
  created: { id: string; name: string; token: string; expires_at: string | null },
  command: string,
): SafeHtml {
  return layout(
    ctx,
    "/tokens",
    "Token created",
    html`<div class="stack g16">
<div class="row g12"><span class="okmark">${ICON.check}</span><div class="stack g4"><h1>${created.name} is ready</h1><span class="hint">Created just now · ${created.expires_at ? html`expires <span title="${created.expires_at}">${shortDate(created.expires_at)}</span>` : "never expires"} · <span class="mono">${created.id}</span></span></div></div>
<section class="card pad stack g12 once">
<div class="row between"><label class="lbl" for="token-value">Your token</label><span class="badge warn">${ICON.eye}Shown only once</span></div>
<div class="row">
<input class="field secret" type="text" id="token-value" readonly spellcheck="false" value="${created.token}">
<button type="button" class="btn btn-dark" data-copy="token-value">${ICON.copy}Copy</button>
</div>
<span class="status" id="token-value-status" role="status"></span>
<p>It is stored hashed, so it can't be shown again. Lost it? Revoke it and create a new one.</p>
</section>
<section class="card pad stack g12">
<h2 class="sm">Claude Code</h2>
<p>Run this in a terminal. Never paste the token into a chat.</p>
${copyBlock("claude-cmd", "Claude Code command", command, 4)}
</section>
<div class="row between g12">
<label class="check"><input type="checkbox" id="stored"><span>I've copied and stored this token</span></label>
<a class="btn btn-primary" id="done" href="/tokens">Done</a>
</div>
</div>`,
  );
}

export function connectorKeyCreatedView(ctx: Ctx, created: { id: string; name: string; key: string }, command: string, revealed = false): SafeHtml {
  return layout(
    ctx,
    "/tokens",
    revealed ? "Connector key" : "Connector key created",
    html`<div class="stack"><a class="back" href="/tokens">${ICON.back}Tokens</a>${pageHead(revealed ? "Connector key" : "Connector key created")}</div>
<div class="banner warn" role="alert"><strong>This is a secret.</strong> Paste it into the connector and do not share it. You can reveal it again from the Tokens page (audited).</div>
<div class="card pad stack g12">
<p>Name: <strong>${created.name}</strong> <span class="muted mono small">(${created.id})</span></p>
<h2 class="sm">claude.ai</h2>
<p>Custom connector: Authentication "No connection", then add a request header (mark it required):</p>
<p>Header name: <code>${CONNECTOR_HEADER}</code></p>
${copyBlock("ckey-value", "Header value", created.key, 2)}
</div>
<div class="card pad stack g12">
<h2 class="sm">Claude Code</h2>
${copyBlock("claude-cmd", "Claude Code command", command, 3)}
</div>`,
  );
}
