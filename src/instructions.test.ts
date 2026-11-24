import { test } from "node:test";
import assert from "node:assert/strict";
import { SERVER_INSTRUCTIONS } from "./instructions";
import { INSTRUCTIONS_MAX_CHARS } from "./platform/instructions";
import { UNTRUSTED_DATA_NOTICE } from "./tools/contract";

test("server instructions fit Claude Code's 4096-char limit", () => {
  assert.ok(SERVER_INSTRUCTIONS.length < 4096, String(SERVER_INSTRUCTIONS.length));
  assert.ok(SERVER_INSTRUCTIONS.length <= INSTRUCTIONS_MAX_CHARS);
});

test("essential rules come first", () => {
  const head = SERVER_INSTRUCTIONS.slice(0, 600);
  assert.match(head, /read-only/);
  assert.ok(head.includes(UNTRUSTED_DATA_NOTICE));
});
