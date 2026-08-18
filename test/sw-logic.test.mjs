import { test } from "node:test";
import assert from "node:assert/strict";
import { cacheEligible, swDecision } from "../src/sw-logic.mjs";

const NAV = { method: "GET", sameOrigin: true, mode: "navigate" };

test("collab/data/api/realtime paths are never touched", () => {
  for (const p of ["/__status", "/__rt", "/__review/api", "/__board", "/__me", "/__canvases", "/__admin/users"]) {
    assert.equal(swDecision({ ...NAV, mode: "cors", path: p }), "passthrough", p);
    // even a navigation-mode request to a /__ path stays passthrough
    assert.equal(swDecision({ ...NAV, path: p }), "passthrough", p + " (navigate)");
  }
});

test("non-GET requests pass through (never cache a mutation)", () => {
  assert.equal(swDecision({ method: "POST", sameOrigin: true, mode: "navigate", path: "/delta/" }), "passthrough");
  assert.equal(swDecision({ method: "PUT", sameOrigin: true, mode: "cors", path: "/_chrome.x.js" }), "passthrough");
});

test("cross-origin requests pass through", () => {
  assert.equal(swDecision({ method: "GET", sameOrigin: false, mode: "navigate", path: "/delta/" }), "passthrough");
  assert.equal(swDecision({ method: "GET", sameOrigin: false, mode: "no-cors", path: "/_chrome.x.js" }), "passthrough");
});

test("the worker script itself always passes through (so SW updates aren't blocked)", () => {
  assert.equal(swDecision({ method: "GET", sameOrigin: true, mode: "no-cors", path: "/sw.js" }), "passthrough");
});

test("same-origin GET navigations get stale-while-revalidate", () => {
  for (const p of ["/", "/delta/", "/delta/glitch/", "/playground/", "/surtex/home/"]) {
    assert.equal(swDecision({ ...NAV, path: p }), "swr", p);
  }
});

test("the shared chrome bundle and fonts are cache-first", () => {
  assert.equal(swDecision({ method: "GET", sameOrigin: true, mode: "no-cors", path: "/_chrome.1.13.abcd1234.js" }), "cache-first");
  assert.equal(swDecision({ method: "GET", sameOrigin: true, mode: "no-cors", path: "/_chrome.1.13.deadbeef.css" }), "cache-first");
  assert.equal(swDecision({ method: "GET", sameOrigin: true, mode: "no-cors", path: "/fonts/inter-latin-wght-normal.woff2" }), "cache-first");
});

test("other same-origin GET assets (e.g. a prototype's own JS) pass through", () => {
  assert.equal(swDecision({ method: "GET", sameOrigin: true, mode: "no-cors", path: "/surtex/home/three.core.min.js" }), "passthrough");
});

test("cacheEligible: only a 200 without no-store may be cached", () => {
  assert.equal(cacheEligible(200, "public, no-cache"), true, "content page (no-cache) is cacheable");
  assert.equal(cacheEligible(200, "public, max-age=31536000, immutable"), true, "immutable asset is cacheable");
  assert.equal(cacheEligible(200, "no-store"), false, "the login gate (no-store) is NEVER cached");
  assert.equal(cacheEligible(200, "private, no-store, max-age=0"), false);
  assert.equal(cacheEligible(304, "public, no-cache"), false, "a 304 is not a fresh body to store");
  assert.equal(cacheEligible(401, "no-store"), false);
  assert.equal(cacheEligible(500, "public"), false);
  assert.equal(cacheEligible(200, null), true, "missing Cache-Control defaults to cacheable");
});
