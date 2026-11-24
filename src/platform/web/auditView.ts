// vendored from second-brain-mcp@d4ba1c5
import type { AuditRow } from "../audit";
import { html, SafeHtml } from "./html";
import { Ctx, ICON, layout, pageHead } from "./views";

export interface AuditFilters {
  credential?: string;
  tool?: string;
}

const scopeOf = (r: AuditRow): string => [r.server, r.stack, r.service].filter(Boolean).join("/");

export function auditView(ctx: Ctx, rows: AuditRow[], nextBefore: number | null, f: AuditFilters): SafeHtml {
  const q = new URLSearchParams();
  if (f.credential !== undefined) q.set("credential", f.credential);
  if (f.tool !== undefined) q.set("tool", f.tool);
  const next = nextBefore === null ? null : `/audit?${new URLSearchParams([...q, ["before", String(nextBefore)]]).toString()}`;
  // One filter removed: same query minus that key.
  const without = (key: "credential" | "tool"): string => {
    const p = new URLSearchParams(q);
    p.delete(key);
    const s = p.toString();
    return `/audit${s ? `?${s}` : ""}`;
  };
  const filtered = f.credential !== undefined || f.tool !== undefined;
  return layout(
    ctx,
    "/audit",
    "Audit",
    html`${pageHead("Audit log", "Every tool call and admin action, newest first. Query text is truncated; results are never stored. Read-only.")}
<form method="get" action="/audit" class="filters">
<label class="sr" for="credential">Token or key name (exact match)</label>
<input class="field" type="text" id="credential" name="credential" maxlength="256" placeholder="Token or key name (exact)" value="${f.credential ?? ""}">
<label class="sr" for="tool">Tool (exact match)</label>
<input class="field" type="text" id="tool" name="tool" maxlength="64" placeholder="Tool, e.g. ops_list_servers" value="${f.tool ?? ""}">
<button class="btn btn-primary" type="submit">Filter</button>
${filtered ? html`<a class="btn btn-ghost" href="/audit">Reset</a>` : ""}
</form>
${
      filtered
        ? html`<div class="row"><span class="hint">Filtered by</span>${f.credential !== undefined ? html`<span class="fchip">credential: ${f.credential}<a href="${without("credential")}" aria-label="Remove credential filter">${ICON.close}</a></span>` : ""}${f.tool !== undefined ? html`<span class="fchip">tool: ${f.tool}<a href="${without("tool")}" aria-label="Remove tool filter">${ICON.close}</a></span>` : ""}</div>`
        : ""
    }
<div class="card clip">
<div class="scroll"><table class="tbl compact">
<thead><tr><th>Time</th><th>Credential</th><th>Tool</th><th>Scope</th><th>Window</th><th>Query</th><th>Result</th><th>Detail</th><th>Bytes</th><th>Client</th></tr></thead>
<tbody>${
      rows.length === 0
        ? html`<tr><td colspan="10"><div class="empty"><strong>No entries</strong></div></td></tr>`
        : rows.map(
            (r) => html`<tr data-id="${r.id}">
<td class="mono small nowrap" title="${r.ts}">${r.ts.slice(0, 19).replace("T", " ")}</td>
<td>${r.credential_name ? html`<span class="trunc" title="${r.credential_name}">${r.credential_name}</span>` : html`<span class="muted">unknown</span>`}</td>
<td><span class="act">${r.tool}</span></td>
<td class="mono small"><span class="trunc" title="${scopeOf(r)}">${scopeOf(r)}</span></td>
<td class="mono small"><span class="trunc" title="${r.window ?? ""}">${r.window ?? ""}</span></td>
<td class="mono small"><span class="trunc" title="${r.query ?? ""}">${r.query ?? ""}</span></td>
<td><span class="badge ${r.result === "ok" ? "ok" : ["denied", "rate_limited", "busy"].includes(r.result) ? "warn" : "err"}">${r.result}</span>${r.truncated ? html` <span class="badge warn">truncated</span>` : ""}</td>
<td><span class="trunc" title="${r.detail ?? ""}">${r.detail ?? ""}</span></td>
<td class="mono small num">${r.result_bytes ?? ""}</td>
<td class="mono small">${r.client_ip ?? ""}</td>
</tr>`,
          )
    }</tbody></table></div>
${next ? html`<div class="foot"><span></span><a class="btn btn-sm" href="${next}">Older entries ${ICON.next}</a></div>` : ""}
</div>`,
  );
}
