import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolError } from "../tools/contract";
import { levelFilter, levelsFrom, lineFilters, quote, selector } from "./selector";

test("selector without server matches any server, never an empty selector", () => {
  assert.equal(selector({}), '{server=~".+"}');
  assert.equal(selector({ server: "ovh-prod-1", stack: "carapp", service: "carapp_php" }), '{server="ovh-prod-1", service_namespace="carapp", service_name="carapp_php"}');
});

test("quote escapes backslash, double quote and newline", () => {
  assert.equal(quote('a"b', "x"), '"a\\"b"');
  assert.equal(quote("a\\b", "x"), '"a\\\\b"');
  assert.equal(quote("a\nb", "x"), '"a\\nb"');
  assert.equal(quote('\\"', "x"), '"\\\\\\""');
});

test("an injection attempt stays inside one string literal", () => {
  const s = selector({ server: 'x"} or {server=~".+"} |= "', service: 'a\\"} or {a="b' });
  assert.equal(s, '{server="x\\"} or {server=~\\".+\\"} |= \\"", service_name="a\\\\\\"} or {a=\\"b"}');
  // Unescaped quotes must pair up: only the delimiters remain.
  const unescaped = s.replace(/\\\\/g, "").replace(/\\"/g, "");
  assert.equal((unescaped.match(/"/g) ?? []).length, 4);
});

test("control characters are rejected", () => {
  for (const bad of ["a\u0000b", "a\rb", "a\tb", "a\u001bb", "a\u007fb"]) {
    assert.throws(() => quote(bad, "service"), (e) => e instanceof ToolError && e.code === "invalid_param");
  }
  assert.throws(() => selector({ service: "a\rb" }), ToolError);
});

test("line filters: contains and regex are quoted, empty or oversized are rejected", () => {
  assert.equal(lineFilters({ contains: 'say "hi"', regex: String.raw`\d+\s` }), String.raw`|= "say \"hi\"" |~ "\\d+\\s"`);
  assert.equal(lineFilters({}), "");
  assert.throws(() => lineFilters({ contains: "" }), ToolError);
  assert.throws(() => lineFilters({ regex: "a".repeat(201) }), ToolError);
  assert.doesNotThrow(() => lineFilters({ regex: "a".repeat(200) }));
});

test("regex: constructs RE2 lacks are rejected, linear-time patterns pass", () => {
  for (const bad of ["(?=x)", "(?!x)", "(?<=x)", "(?<!x)", "(?>x)", String.raw`(a)\1`, String.raw`\k<n>`]) {
    assert.throws(() => lineFilters({ regex: bad }), (e) => e instanceof ToolError && e.code === "invalid_param", bad);
  }
  for (const ok of ["(a+)+$", "(a|aa)+", "^(?:foo|bar)\\d{1,3}$", "(?i)error"]) assert.doesNotThrow(() => lineFilters({ regex: ok }), ok);
});

test("level filters use fixed enum values from a minimum", () => {
  assert.deepEqual(levelsFrom("error"), ["error", "critical", "fatal"]);
  assert.equal(levelFilter(levelsFrom("warn")), '| detected_level=~"warn|error|critical|fatal"');
});
