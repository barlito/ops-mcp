// vendored from second-brain-mcp@d4ba1c5
import { APP_VERSION } from "../../version";
import { html, raw, SafeHtml } from "./html";

export interface Ctx {
  user: string;
  csrf: string;
  // Fresh one-time form nonce (consumed on POST).
  nonce: () => string;
}

export interface Banner {
  kind: "ok" | "err" | "warn";
  title: string;
  lines?: string[];
}

export const bannerView = (b?: Banner): SafeHtml | "" =>
  b
    ? html`<div class="banner ${b.kind}" role="${b.kind === "err" ? "alert" : "status"}"><strong>${b.title}</strong>${
        b.lines?.length ? html`<ul>${b.lines.map((l) => html`<li>${l}</li>`)}</ul>` : ""
      }</div>`
    : "";

// ---- icons (inline SVG, stroke=currentColor, decorative) ---------------------

const svg = (size: number, body: string, sw = 1.75): SafeHtml =>
  raw(`<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`);

export const ICON = {
  brand: svg(16, '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>', 2),
  tokens: svg(16, '<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 20 3"/><path d="m16 7 3 3"/><path d="m14 9 2 2"/>'),
  audit: svg(16, '<path d="M3 12h4l3-8 4 16 3-8h4"/>'),
  plus: svg(16, '<path d="M12 5v14M5 12h14"/>', 2),
  back: svg(14, '<path d="m15 18-6-6 6-6"/>', 2),
  next: svg(14, '<path d="m9 18 6-6-6-6"/>', 2),
  check: svg(20, '<path d="m5 12 5 5 9-10"/>', 2.25),
  eye: svg(12, '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>', 2.25),
  copy: svg(16, '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>', 2),
  close: svg(12, '<path d="M6 6l12 12M18 6 6 18"/>', 2.5),
};

// ---- shared view helpers ---------------------------------------------------

// "2 min ago" / "in 3 days" relative to now; the full timestamp goes in a title attribute.
export function relTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = now - t;
  const m = Math.round(Math.abs(diff) / 60_000);
  const unit = m < 1 ? "" : m < 60 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`;
  if (!unit) return "just now";
  return diff >= 0 ? `${unit} ago` : `in ${unit}`;
}

export const shortDate = (iso: string): string => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : iso);

export const csrfField = (ctx: Ctx): SafeHtml =>
  html`<input type="hidden" name="csrf" value="${ctx.csrf}"><input type="hidden" name="nonce" value="${ctx.nonce()}">`;

// ---- layout ----------------------------------------------------------------

export function layout(ctx: Ctx, active: string, title: string, body: SafeHtml): SafeHtml {
  const nav: Array<[string, string, SafeHtml]> = [
    ["/tokens", "Tokens", ICON.tokens],
    ["/audit", "Audit log", ICON.audit],
  ];
  const initials = ctx.user.replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").map((w) => w[0]).slice(0, 2).join("") || "?";
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<link rel="icon" type="image/svg+xml" href="/static/icon.svg">
<title>${title} - ops-mcp admin</title>
<link rel="stylesheet" href="/static/style.css">
<script src="/static/theme.js"></script>
<script src="/static/app.js" defer></script>
</head>
<body>
<div class="app">
<div class="side">
<a class="brand" href="/"><span class="brand-mark">${ICON.brand}</span><span class="brand-name"><b>ops-mcp</b><span>admin</span></span></a>
<nav class="nav" aria-label="Main">${nav.map(
    ([href, label, icon]) => html`<a href="${href}"${href === active ? raw(' aria-current="page"') : ""}>${icon}<span class="label">${label}</span></a>`,
  )}</nav>
<div class="side-foot">
<div class="theme" data-theme-toggle role="group" aria-label="Theme" hidden>
<button type="button" data-theme-set="auto" aria-pressed="true">Auto</button>
<button type="button" data-theme-set="light" aria-pressed="false">Light</button>
<button type="button" data-theme-set="dark" aria-pressed="false">Dark</button>
</div>
<span class="version" title="Running version">${APP_VERSION}</span>
<div class="who"><span class="avatar" aria-hidden="true">${initials}</span><span class="who-text"><b>${ctx.user}</b><span>Signed in</span></span></div>
</div>
</div>
<main class="main">
<div class="wrap">
${body}
</div>
</main>
</div>
</body>
</html>`;
}

// Page title block: h1, lead text and an action area.
export const pageHead = (title: string, lead?: SafeHtml | string, actions?: SafeHtml | ""): SafeHtml =>
  html`<div class="head"><div class="head-text"><h1>${title}</h1>${lead ? html`<p class="lead">${lead}</p>` : ""}</div>${actions ?? ""}</div>`;

export function errorView(ctx: Ctx, status: number, message: string): SafeHtml {
  return layout(ctx, "", `Error ${status}`, html`<h1>Error ${status}</h1><div class="banner err" role="alert">${message}</div><p><a href="/">Back</a></p>`);
}
