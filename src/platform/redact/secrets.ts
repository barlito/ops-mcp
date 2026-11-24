// vendored from second-brain-mcp@d4ba1c5
// Obvious-secret detector: only distinctive prefixes/shapes, linear-time regexes, first hit wins.
const B = String.raw`(?<![\w-])`;
const PATTERNS: [string, RegExp][] = [
  ["GitHub token", new RegExp(String.raw`${B}gh[pousr]_[A-Za-z0-9]{36,}`)],
  ["GitHub token", new RegExp(String.raw`${B}github_pat_[A-Za-z0-9_]{60,}`)],
  ["Anthropic API key", new RegExp(String.raw`${B}sk-ant-[A-Za-z0-9_-]{32,}`)],
  ["OpenAI API key", new RegExp(String.raw`${B}sk-proj-[A-Za-z0-9_-]{32,}`)],
  ["AWS access key id", new RegExp(String.raw`${B}(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])`)],
  ["private key", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/],
  ["Slack token", new RegExp(String.raw`${B}xox[abprs]-[A-Za-z0-9-]{10,}`)],
  ["Google API key", new RegExp(String.raw`${B}AIza[0-9A-Za-z_-]{35}(?![\w-])`)],
  ["Stripe live key", new RegExp(String.raw`${B}(?:sk|rk)_live_[A-Za-z0-9]{20,}`)],
  ["ops-mcp token", new RegExp(String.raw`${B}ops_[A-Za-z0-9_-]{43}(?![\w-])`)],
  ["ops-mcp connector key", new RegExp(String.raw`${B}opsk_[A-Za-z0-9_-]{43}(?![\w-])`)],
  ["JWT", new RegExp(String.raw`${B}eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*`)],
];

// Contextual secrets keep their key and are replaced in place; they run before PATTERNS.
const KEY = String.raw`(?<![A-Za-z0-9])(?:password|passwd|pwd|secret|token)`;
const REPLACERS: [RegExp, string][] = [
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/'"]*):[^\s@/'"]+@/gi, "$1:[REDACTED]@"],
  [/(authorization["']?\s*[:=]\s*["']?(?:bearer|basic)\s+)[^\s"',;]+/gi, "$1[REDACTED]"],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{20,}/gi, "Bearer [REDACTED]"],
  [new RegExp(String.raw`(${KEY}["']?\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s&"',;]+)`, "gi"), "$1[REDACTED]"],
  [new RegExp(String.raw`("(?:[\w.-]*[_.-])?(?:password|passwd|pwd|secret|token)"\s*:\s*)"(?:[^"\\]|\\.)*"`, "gi"), '$1"[REDACTED]"'],
];

export function findSecret(text: string): { kind: string; line: number } | undefined {
  let best: { kind: string; index: number } | undefined;
  for (const [kind, re] of PATTERNS) {
    const m = re.exec(text);
    if (m && (!best || m.index < best.index)) best = { kind, index: m.index };
  }
  if (!best) return undefined;
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < best.index; i = text.indexOf("\n", i + 1)) line++;
  return { kind: best.kind, line };
}

// Replaces every secret-shaped match with a marker; the output is safe to hand to a client.
export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, replacement] of REPLACERS) out = out.replace(re, replacement);
  for (const [kind, re] of PATTERNS) out = out.replace(new RegExp(re.source, `${re.flags}g`), `[REDACTED ${kind}]`);
  return out;
}
