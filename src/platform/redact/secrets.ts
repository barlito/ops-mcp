// vendored from second-brain-mcp@d4ba1c5
// Obvious-secret detector: only distinctive prefixes/shapes, linear-time regexes, first hit wins.
import { redact } from "../util";

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
  ["JWT", new RegExp(String.raw`${B}eyJ[A-Za-z0-9_-]{8,2048}\.eyJ[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{0,2048}`)],
];

// Contextual secrets keep their key and are replaced in place; they run before PATTERNS.
// A keyword starts a name segment (not glued to lowercase letters or digits, so DB_PASS, PGPASSWORD and
// x-api-key match) and is not followed by a lowercase letter (so tokens, passwordless and monkey do not).
const WORDS = String.raw`password|passwd|pass|pwd|secret|token|api[_-]?key|key|auth|dsn|credential|cookie|session`;
const KEYWORD = String.raw`(?-i:(?<![a-z0-9]))(?:${WORDS})(?-i:(?![a-z]))`;
const SUFFIX = String.raw`[\w.-]{0,64}`;
const VALUE = String.raw`(?:"[^"]*"|'[^']*'|[^\s&"',;]+)`;
const SENSITIVE_NAME = new RegExp(KEYWORD, "i");

// Whether a flag or variable name (--api-key, DB_PASS) holds a secret.
export const isSensitiveName = (name: string): boolean => name.length <= 140 && SENSITIVE_NAME.test(name);

const REPLACERS: [RegExp, string][] = [
  // user:password@host, the password may itself contain "@": it ends at the last "@" of the authority.
  [/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/[^\s:@/'"]*):[^\s'"/]+@/gi, "$1:[REDACTED]@"],
  [/(authorization["']?\s*[:=]\s*["']?(?:(?:bearer|basic|token)\s+)?)[^\s"',;]+/gi, "$1[REDACTED]"],
  [/(?<![a-z0-9])bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi, "Bearer [REDACTED]"],
  [/((?<![a-z0-9])(?:set-)?cookie\s*:\s*)[^\r\n]+/gi, "$1[REDACTED]"],
  [new RegExp(String.raw`("[\w.-]{0,40}?${KEYWORD}[\w.-]{0,40}"\s*:\s*)"(?:[^"\\]|\\.)*"`, "gi"), '$1"[REDACTED]"'],
  [new RegExp(String.raw`(${KEYWORD}${SUFFIX}["']?\s*[:=]\s*)(?!["']?\[REDACTED)${VALUE}`, "gi"), "$1[REDACTED]"],
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

// URL credentials and secret-shaped strings: the one function for anything logged, audited or returned.
export function redactAll(text: string): string {
  return redactSecrets(redact(text));
}
