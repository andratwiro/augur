// Serving policy for the shared chrome bundle (P1) + service worker (P0).
//
// The chrome bundle carries a content hash in its name, so it must be promoted to
// immutable (like a ?v= or font asset) — otherwise the whole win is lost to
// revalidation round-trips. sw.js must NOT be immutable: a stuck-immutable worker
// could never be updated or killed. And both must bypass the login gate, since
// they load by absolute path from every page and the SW update check is cookieless.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

function ccOf(pathname) {
  const res = new Response("x", { headers: { "Cache-Control": "public, no-cache", "Content-Type": "application/javascript" } });
  const out = W.withAssetCache(res, new URL("https://x.test" + pathname));
  return out.headers.get("Cache-Control");
}

test("the content-hashed chrome bundle is served immutable", () => {
  assert.match(ccOf("/_chrome.1.13.a570b7c3.js"), /immutable/);
  assert.match(ccOf("/_chrome.1.13.d174ff9a.css"), /max-age=31536000/);
});

test("sw.js is NOT immutable (it must stay updatable / killable)", () => {
  const cc = ccOf("/sw.js");
  assert.ok(!/immutable/.test(cc), "sw.js must revalidate, got: " + cc);
});

test("chrome bundle and sw.js bypass the login gate (public paths)", () => {
  // An empty routing table on purpose: these doors are fixed engine paths and must not
  // depend on what any workspace published. The context is what isPublicPath reads now.
  const ctx = W.applyDerivedRouting({});
  assert.equal(W.isPublicPath(ctx, "/sw.js"), true);
  assert.equal(W.isPublicPath(ctx, "/_chrome.1.13.a570b7c3.js"), true);
  assert.equal(W.isPublicPath(ctx, "/_chrome.1.13.d174ff9a.css"), true);
  // A normal gated content page is still gated.
  assert.equal(W.isPublicPath(ctx, "/delta/"), false);
});
