// test/review-overlay-serve.test.mjs — the review/comment overlay (Shift+C) is appended at
// SERVE time, not baked by the build.
//
// It used to ride in on build.js's injectReview, which runs inside copyDir — the dist copy
// of a prototype folder. `augur land` uploads a draft folder's bytes verbatim and never
// runs the build, so every prototype landed since drafts-that-land served without the
// overlay and Shift+C did nothing. Appending it in the dressing chain is one definition
// covering landed pages, built pages and every tenant — the same move the draft bar makes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

const URL_OF = (p = "/checkout/flow/") => new URL(`https://x.test${p}`);
const CTX = { BUILD_ID: "bld1", CHROME_POINTER: { ui: "11.2.0" } };
const html = (body, headers = {}) =>
  new Response(body, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", ...headers } });

test("a landed prototype page is served carrying the overlay, before </body>", async () => {
  const res = await W.withReviewOverlay(CTX, html("<!doctype html><title>flow</title><body><p>hi</p></body>"), URL_OF());
  const out = await res.text();
  assert.match(out, /<script src="\/__review\/comments\.js\?v=[^"]+" defer><\/script>/, "the overlay script is on the page");
  assert.match(out, /<!--gv-review-start-->/, "marker-wrapped, so the Download HTML button can strip it");
  assert.match(out, /<!--gv-review-end-->/);
  assert.ok(out.indexOf("gv-review-start") < out.indexOf("</body>"), "appended inside the body");
});

test("the overlay is cache-busted by the engine's UI version, so a pinned tab cannot run a stale copy", async () => {
  const res = await W.withReviewOverlay(CTX, html("<body></body>"), URL_OF());
  assert.match(await res.text(), /comments\.js\?v=11\.2\.0"/);
});

test("a page the build already injected is not given a second copy", async () => {
  const baked = "<body><p>hi</p><!--gv-review-start--><script src=\"/__review/comments.js?v=9\" defer></script><!--gv-review-end--></body>";
  const out = await (await W.withReviewOverlay(CTX, html(baked), URL_OF())).text();
  assert.equal((out.match(/comments\.js/g) || []).length, 1, "one overlay, the one that was baked");
});

test("?raw=1 — the Download HTML button — gets the page clean", async () => {
  const out = await (await W.withReviewOverlay(CTX, html("<body></body>"), URL_OF("/checkout/flow/?raw=1"))).text();
  assert.doesNotMatch(out, /gv-review/);
});

test("a non-HTML response and a non-200 are passed through untouched", async () => {
  const json = new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  assert.equal(await (await W.withReviewOverlay(CTX, json, URL_OF())).text(), "{}");
  const miss = new Response("<body></body>", { status: 404, headers: { "Content-Type": "text/html" } });
  assert.doesNotMatch(await (await W.withReviewOverlay(CTX, miss, URL_OF())).text(), /gv-review/);
});

test("a rewritten page drops the stored blob's ETag and Content-Length", async () => {
  const res = await W.withReviewOverlay(CTX, html("<body></body>", { ETag: "\"abc\"", "Content-Length": "13" }), URL_OF());
  assert.equal(res.headers.get("ETag"), null);
  assert.equal(res.headers.get("Content-Length"), null);
});

// The regression itself, end to end: bytes that went up through `augur land` — never near
// build.js — fetched back over a socket from the real worker's serve path.
test("a page landed into the store, which no build ever touched, comes back carrying the overlay", async () => {
  const { startUnitServer } = await import("./fixtures/unit-server.mjs");
  const { manifestOf, remember } = await import("./fixtures/unit-env.mjs");
  const U = "/checkout/flow/";
  const landed = remember("<!doctype html><title>flow</title><body><h1>flow</h1></body>");
  const s = await startUnitServer({ tenantId: "review-overlay-live", live: manifestOf(4, { [U]: { "index.html": landed } }) });
  try {
    const page = await (await fetch(`${s.origin}${U}`)).text();
    assert.match(page, /\/__review\/comments\.js/, "Shift+C has something to turn on");
    const raw = await (await fetch(`${s.origin}${U}?raw=1`)).text();
    assert.doesNotMatch(raw, /gv-review/, "the Download HTML button still gets the file the editor wrote");
  } finally { await s.close(); }
});
