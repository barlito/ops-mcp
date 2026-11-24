// vendored from second-brain-mcp@d4ba1c5
// Static assets served at /static/*. Kept as strings so the plain `tsc` build ships them.
// JS is vanilla and external (CSP: script-src 'self'); String.raw keeps backslashes literal.
export { CSS } from "./css";

// Loaded synchronously in <head> (no defer) so the stored theme applies before first paint.
export const THEME_JS = String.raw`(function () {
  var d = document.documentElement;
  d.classList.add("js");
  try {
    var t = localStorage.getItem("ops-theme");
    if (t === "light" || t === "dark") d.setAttribute("data-theme", t);
  } catch (e) { /* storage blocked: stay on Auto */ }
})();
})();
`;

export const JS = String.raw`document.addEventListener("submit", function (e) {
  var m = e.target && e.target.getAttribute && e.target.getAttribute("data-confirm");
  if (m && !window.confirm(m)) e.preventDefault();
});

// Copy button: Clipboard API, falling back to select-all + execCommand for non-secure contexts.
document.addEventListener("click", function (e) {
  var b = e.target && e.target.closest ? e.target.closest("[data-copy]") : null;
  if (!b) return;
  var el = document.getElementById(b.getAttribute("data-copy"));
  var st = document.getElementById(b.getAttribute("data-copy") + "-status");
  if (!el) return;
  function say(t) { if (st) st.textContent = t; }
  function fallback() {
    el.focus();
    el.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (err) { ok = false; }
    say(ok ? "Copied." : "Selected: press Ctrl+C (Cmd+C) to copy.");
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(el.value).then(function () { say("Copied."); }, fallback);
  } else {
    fallback();
  }
});

// Theme toggle (Auto / Light / Dark). Hidden without JS; theme.js applies the stored choice early.
(function () {
  var box = document.querySelector("[data-theme-toggle]");
  if (!box) return;
  var root = document.documentElement;
  function current() {
    var t = root.getAttribute("data-theme");
    return t === "light" || t === "dark" ? t : "auto";
  }
  function paint() {
    var c = current();
    box.querySelectorAll("button[data-theme-set]").forEach(function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-theme-set") === c ? "true" : "false");
    });
  }
  box.hidden = false;
  box.addEventListener("click", function (e) {
    var b = e.target && e.target.closest ? e.target.closest("button[data-theme-set]") : null;
    if (!b) return;
    var v = b.getAttribute("data-theme-set");
    if (v === "light" || v === "dark") root.setAttribute("data-theme", v);
    else root.removeAttribute("data-theme");
    try {
      if (v === "auto") localStorage.removeItem("ops-theme");
      else localStorage.setItem("ops-theme", v);
    } catch (err) { /* storage blocked: applies to this page only */ }
    paint();
  });
  paint();
})();

// Token created: "I've copied and stored this token" gates the Done link.
(function () {
  var cb = document.getElementById("stored");
  var done = document.getElementById("done");
  if (!cb || !done) return;
  function sync() {
    if (cb.checked) done.removeAttribute("aria-disabled");
    else done.setAttribute("aria-disabled", "true");
  }
  done.addEventListener("click", function (e) { if (!cb.checked) e.preventDefault(); });
  cb.addEventListener("change", sync);
  sync();
})();
`;

// The brand mark doubles as favicon (CSP img-src 'self' forbids data: URLs).
export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#2456d3" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>`;
