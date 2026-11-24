import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolError } from "../tools/contract";
import { anyOf, eq, escapeLabelValue } from "./labels";

test("escapes backslash, quote and newline", () => {
  assert.equal(escapeLabelValue('a\\b"c\nd'), 'a\\\\b\\"c\\nd');
});

test("a quote cannot close the matcher: injection stays inside the string", () => {
  assert.equal(eq("server", 'x"} or vector(1) #'), 'server="x\\"} or vector(1) #"');
  assert.equal(eq("service_name", 'x\\"} or up{a="'), 'service_name="x\\\\\\"} or up{a=\\""');
});

test("rejects control characters and oversized values", () => {
  for (const bad of ["a\tb", "a\rb", "a\u0000b", "a\u001bb", "a\u007fb", "x".repeat(201)]) {
    assert.throws(() => eq("host_name", bad), (e) => e instanceof ToolError && e.code === "invalid_parameter", JSON.stringify(bad));
  }
});

test("regex alternatives escape metacharacters, then the string", () => {
  assert.equal(anyOf("service", ["a.b", "c|d"], "@.+"), 'service=~"(a\\\\.b|c\\\\|d)@.+"');
  assert.equal(anyOf("service", ['q"(']), 'service=~"(q\\\\\\"\\\\()"');
  assert.equal(anyOf("service", ["carapp_php-é"]), 'service=~"(carapp_php\\\\-é)"');
});
