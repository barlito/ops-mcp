import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanLine, fingerprint, groupPatterns, type LogEntry } from "./fingerprint";

test("lines differing by ids, addresses, numbers and timestamps share a pattern", () => {
  const lines = [
    '2026-06-01T12:00:01.123Z level=error msg="payment failed" order=1234 user=8f14e45f-ceea-467a-9575-1f2d2a6ab6ba ip=10.0.0.5:4431 trace=deadbeefcafe0001',
    '2026-06-01T12:05:09Z level=error msg="payment failed" order=99 user=00000000-0000-4000-8000-000000000000 ip=192.168.1.20:80 trace=0123456789abcdef',
  ];
  assert.equal(fingerprint(lines[0]!), fingerprint(lines[1]!));
  assert.match(fingerprint(lines[0]!), /<ts>.*<uuid>.*<ip>.*<hex>/);
});

test("IPv6, quoted tokens and plain numbers are normalised, messages with spaces are kept", () => {
  assert.equal(fingerprint('conn from 2001:db8::ff00:42:8329 user="bob" retry 3'), 'conn from <ip> user="<str>" retry <n>');
  assert.equal(fingerprint('{"level":"error","msg":"db is down"}'), '{"<str>":"<str>","<str>":"db is down"}');
  assert.notEqual(fingerprint("disk full on /var"), fingerprint("cache miss on /var"));
});

test("cleanLine redacts before truncating at 400 characters", () => {
  const out = cleanLine(`${"x".repeat(390)} password=hunter2hunter2`);
  assert.ok(out.length <= 400);
  assert.ok(!out.includes("hunter2"));
  assert.equal(cleanLine("y".repeat(1000)).length, 400);
  assert.ok(cleanLine("y".repeat(1000)).endsWith("…"));
  assert.equal(cleanLine("short"), "short");
});

test("groupPatterns counts, tracks first/last seen and keeps the latest redacted example", () => {
  const e = (ns: bigint, line: string, service = "carapp_php"): LogEntry => ({ ns, server: "s", service, level: "error", line });
  const groups = groupPatterns([
    e(30n, "order 3 failed token=abc12345"),
    e(10n, "order 1 failed token=zzz99999"),
    e(20n, "order 2 failed token=qqq77777"),
    e(15n, "order 2 failed token=qqq77777", "other"),
  ]);
  assert.equal(groups.length, 2);
  const g = groups.find((x) => x.service === "carapp_php")!;
  assert.deepEqual([g.count, g.first, g.last], [3, 10n, 30n]);
  assert.equal(g.example, "order 3 failed token=[REDACTED]");
  assert.equal(g.pattern, "order <n> failed token=[REDACTED]");
});
