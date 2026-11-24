import { after, test } from "node:test";
import assert from "node:assert/strict";
import { cleanup, writeTemp } from "../test-support/fixtures";
import { readSecret } from "./util";

after(cleanup);

test("readSecret prefers the file, trims it, and falls back to the plain variable", () => {
  const file = writeTemp("secret", "from-file\n");
  assert.equal(readSecret("X", { X_FILE: file, X: "from-env" }), "from-file");
  assert.equal(readSecret("X", { X: " from-env " }), "from-env");
  assert.equal(readSecret("X", {}), undefined);
  assert.equal(readSecret("X", { X_FILE: writeTemp("empty", "\n") }), undefined);
  assert.throws(() => readSecret("X", { X_FILE: "/nonexistent/secret" }));
});
