// vendored from second-brain-mcp@d4ba1c5
import { test } from "node:test";
import assert from "node:assert/strict";
import { REDACTION_CASES } from "../../test-support/redactionCases";
import { findSecret, redactAll, redactSecrets } from "./secrets";

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

test("redactSecrets: DSN passwords, bearer/basic credentials and JWTs are replaced, context kept", () => {
  assert.equal(redactSecrets("dial postgres://app:S3cretPass@db:5432/app failed"), "dial postgres://app:[REDACTED]@db:5432/app failed");
  assert.equal(redactSecrets("amqp://:onlypass@mq/ and redis://cache:6379"), "amqp://:[REDACTED]@mq/ and redis://cache:6379");
  assert.equal(redactSecrets("Authorization: Bearer abc.def-ghi_jkl"), "Authorization: Bearer [REDACTED]");
  assert.equal(redactSecrets('authorization="Basic dXNlcjpwYXNz"'), 'authorization="Basic [REDACTED]"');
  assert.equal(redactSecrets(`got Bearer ${"a1".repeat(15)} here`), "got Bearer [REDACTED] here");
  assert.equal(redactSecrets("Bearer authentication is required, basic setup"), "Bearer authentication is required, basic setup");
  const jwt = `eyJ${"a".repeat(20)}.eyJ${"b".repeat(20)}.${"c".repeat(20)}`;
  assert.equal(redactSecrets(`jwt ${jwt} end`), "jwt [REDACTED JWT] end");
});

test("redactSecrets: password/secret/token pairs in query strings, key=value and JSON", () => {
  assert.equal(redactSecrets("GET /cb?code=1&token=abc123&x=2"), "GET /cb?code=1&token=[REDACTED]&x=2");
  assert.equal(redactSecrets('password="two words" pwd=hunter2 passwd=x'), 'password=[REDACTED] pwd=[REDACTED] passwd=[REDACTED]');
  assert.equal(redactSecrets("DB_PASSWORD=abc client_secret=xyz"), "DB_PASSWORD=[REDACTED] client_secret=[REDACTED]");
  assert.equal(redactSecrets('{"user":"bob","password":"p\\"w","api_token": "t0k"}'), '{"user":"bob","password":"[REDACTED]","api_token": "[REDACTED]"}');
  assert.equal(redactSecrets("token=ghp_" + "a".repeat(36)), "token=[REDACTED]");
  assert.equal(redactSecrets("tokens=5 passwordless login"), "tokens=5 passwordless login");
});

test("redactAll strips URL credentials and secret-shaped strings", () => {
  const gh = "ghp_" + "a".repeat(36);
  assert.equal(redactAll(`GET https://user:pw@host/x with ${gh}`), "GET https://***@host/x with [REDACTED GitHub token]");
});

test("redactSecrets: colon pairs, uppercase prefixes, api keys, Token scheme and passwords containing @", () => {
  assert.equal(redactSecrets("password: hunter2 access_token: abc"), "password: [REDACTED] access_token: [REDACTED]");
  assert.equal(redactSecrets("PGPASSWORD=foo MYSQL_ROOT_PASSWORD=bar"), "PGPASSWORD=[REDACTED] MYSQL_ROOT_PASSWORD=[REDACTED]");
  assert.equal(redactSecrets("api_key=k1 X-Api-Key: k2 apikey=k3"), "api_key=[REDACTED] X-Api-Key: [REDACTED] apikey=[REDACTED]");
  assert.equal(redactSecrets("Authorization: Token abcdef123"), "Authorization: Token [REDACTED]");
  assert.equal(redactSecrets("dsn mysql://u:p@ss@h/db and amqp://guest:g@h:5672"), "dsn mysql://u:[REDACTED]@h/db and amqp://guest:[REDACTED]@h:5672");
  assert.equal(redactSecrets('{"password":"[REDACTED]"}'), '{"password":"[REDACTED]"}');
  assert.equal(redactSecrets("tokens=5 passwordless login mypassword=1"), "tokens=5 passwordless login mypassword=1");
});

test("redaction stays linear on 64 KB adversarial inputs", () => {
  const n = 64 * 1024;
  const inputs = [
    "a.".repeat(n / 2),
    `eyJ${"a".repeat(n)}`,
    "eyJaaaaaaaaa.".repeat(n / 14),
    "eyJaaaaaaaaa.eyJaaaaaaaaa.".repeat(n / 26),
    "password=".repeat(n / 9),
    'password="'.repeat(n / 10),
    "://".repeat(n / 3),
    "a://u:".repeat(n / 6),
    "bearer ".repeat(n / 7),
    "Authorization: ".repeat(n / 15),
    '"password": "'.repeat(n / 13),
    "Cookie: ".repeat(n / 8),
    "auth_".repeat(n / 5),
    "DB_PASS_pass".repeat(n / 12),
    "session=".repeat(n / 8),
    "x".repeat(n),
  ];
  // Best of three: the first pass pays for regex compilation and a busy CI box.
  const runs = [0, 1, 2].map(() => {
    const t = performance.now();
    for (const input of inputs) redactAll(input);
    return performance.now() - t;
  });
  const ms = Math.min(...runs);
  assert.ok(ms < 50, `took ${ms.toFixed(0)} ms`);
});

test("redactAll and redactSecrets satisfy the shared redaction table", () => {
  for (const c of REDACTION_CASES) {
    for (const fn of [redactAll, redactSecrets]) {
      const out = fn(c.input);
      for (const leak of c.leaks) assert.ok(!out.includes(leak), `${c.input} -> ${out}`);
      for (const keep of c.keeps ?? []) assert.ok(out.includes(keep), `${c.input} -> ${out}`);
    }
  }
});
