// vendored from second-brain-mcp@d4ba1c5
import { test } from "node:test";
import assert from "node:assert/strict";
import { findSecret, redactSecrets } from "./secrets";

const b64 = (n: number): string => "Ab3_-".repeat(Math.ceil(n / 5)).slice(0, n);
const kind = (s: string): string | undefined => findSecret(s)?.kind;

test("findSecret: detects each distinctive shape", () => {
  const cases: [string, string][] = [
    ["GitHub token", "ghp_" + "a".repeat(36)],
    ["GitHub token", "gho_" + "B1".repeat(20)],
    ["GitHub token", "github_pat_" + "a1_".repeat(25)],
    ["Anthropic API key", "sk-ant-" + b64(40)],
    ["OpenAI API key", "sk-proj-" + b64(40)],
    ["AWS access key id", "AKIA" + "A1".repeat(8)],
    ["AWS access key id", "ASIA" + "B2".repeat(8)],
    ["private key", "-----BEGIN " + "PRIVATE KEY-----"],
    ["private key", "-----BEGIN OPENSSH " + "PRIVATE KEY-----"],
    ["private key", "-----BEGIN RSA " + "PRIVATE KEY-----"],
    ["private key", "-----BEGIN EC " + "PRIVATE KEY-----"],
    ["Slack token", "xoxb-" + "1234567890"],
    ["Google API key", "AIza" + b64(35)],
    ["Stripe live key", "sk_" + "live_" + "a".repeat(24)],
    ["Stripe live key", "rk_" + "live_" + "a".repeat(24)],
    ["ops-mcp token", "ops_" + b64(43)],
    ["ops-mcp connector key", "opsk_" + b64(43)],
  ];
  for (const [k, s] of cases) {
    assert.equal(kind(`token = ${s} end`), k, s.slice(0, 12));
    assert.equal(kind(s), k);
  }
});

test("findSecret: placeholders, short values, public keys and prose do not match", () => {
  const clean = [
    "ghp_xxx",
    "ghp_" + "a".repeat(35),
    "ghp_…",
    "sk-ant-...",
    "sk-ant-" + "a".repeat(31),
    "the sk-ant- prefix is for Anthropic keys",
    "-----BEGIN PUBLIC KEY-----",
    "AKIA" + "A".repeat(15),
    "AKIA" + "A".repeat(17),
    "xoxb-short",
    "AIza" + "a".repeat(34),
    "ops_" + b64(42),
    "ops_" + b64(44),
    "opsk_" + b64(44),
    "my_ops_" + b64(43),
    "AKIAIOSFODNN7EXAMPLE_".toLowerCase(),
    "# Title\n\nplain note\n",
  ];
  for (const s of clean) assert.equal(findSecret(s), undefined, s);
});

test("findSecret: reports the line of the first hit", () => {
  const text = "line1\nline2\r\nkey: " + "ghp_" + "a".repeat(36) + "\n" + "AKIA" + "A".repeat(16);
  assert.deepEqual(findSecret(text), { kind: "GitHub token", line: 3 });
  assert.equal(findSecret("AKIA" + "A".repeat(16) + "\n" + "ghp_" + "a".repeat(36))?.line, 1);
});

test("findSecret: stays fast on long adversarial input", () => {
  const t = Date.now();
  findSecret("sk-ant-" + "a-".repeat(200_000) + "\n" + "-----BEGIN " + "A ".repeat(100_000));
  assert.ok(Date.now() - t < 1000);
});

test("redactSecrets replaces every secret-shaped match and leaves the rest alone", () => {
  const gh = "ghp_" + "a".repeat(36);
  const text = `before ${gh} middle AKIA${"A".repeat(16)} after\nsecond ${gh}`;
  const out = redactSecrets(text);
  assert.equal(out, "before [REDACTED GitHub token] middle [REDACTED AWS access key id] after\nsecond [REDACTED GitHub token]");
  assert.equal(redactSecrets("nothing to see"), "nothing to see");
});
