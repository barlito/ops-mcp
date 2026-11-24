import { test } from "node:test";
import assert from "node:assert/strict";
import { BodyTooLargeError, readCapped } from "./readCapped";

test("readCapped returns the body when it fits and aborts when it does not", async () => {
  assert.equal(await readCapped(new Response("héllo"), 100), "héllo");
  assert.equal(await readCapped(new Response(null), 100), "");
  await assert.rejects(readCapped(new Response("x".repeat(101)), 100), BodyTooLargeError);
  const streamed = new Response(new ReadableStream({ start(c) { for (let i = 0; i < 20; i++) c.enqueue(new Uint8Array(10)); c.close(); } }));
  await assert.rejects(readCapped(streamed, 100), BodyTooLargeError);
  await assert.rejects(readCapped(new Response("x", { headers: { "content-length": "5000" } }), 100), BodyTooLargeError);
});

test("readCapped stops when the signal is aborted", async () => {
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(readCapped(new Response("abc"), 100, ctl.signal));
});
