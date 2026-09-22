// The criteria page ("oracle") is engine chrome at /__oracle/, served the way /__canvas/ is:
// a prototype's oracle/index.html loads it by absolute path, so it must bypass the gate,
// revalidate on every load (it is iterated, and carries no cache-buster), and be a path no
// workspace can publish over. Its criteria and results are /__board documents, not files.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { __testables as W } from "../src/_worker.js";

test("the criteria page's two files bypass the gate, and nothing else under /__oracle/ does", () => {
  const ctx = W.applyDerivedRouting({});
  assert.equal(W.isPublicPath(ctx, "/__oracle/oracle.js"), true);
  assert.equal(W.isPublicPath(ctx, "/__oracle/oracle.css"), true);
  assert.equal(W.isPublicPath(ctx, "/__oracle/"), false);
  assert.equal(W.isPublicPath(ctx, "/__oracle/other.json"), false);
});

test("the criteria page revalidates on every load", () => {
  for (const p of ["/__oracle/oracle.js", "/__oracle/oracle.css"]) {
    const res = new Response("x", { headers: { "Cache-Control": "public, max-age=14400" } });
    assert.equal(W.withAssetCache(res, new URL("https://x.test" + p)).headers.get("Cache-Control"), "no-cache");
  }
});

test("the build ships the criteria page as engine chrome", () => {
  const build = fs.readFileSync(new URL("../build.js", import.meta.url), "utf8");
  assert.match(build, /"__oracle\/oracle\.js", "__oracle\/oracle\.css"/);
  for (const f of ["oracle.js", "oracle.css"]) {
    assert.ok(fs.statSync(new URL("../src/oracle/" + f, import.meta.url)).size > 1000, "src/oracle/" + f + " is built");
  }
});
