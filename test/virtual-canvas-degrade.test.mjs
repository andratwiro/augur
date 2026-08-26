// virtualCanvas runs on EVERY asset 404 — every gated page an anonymous visitor
// opens, every genuinely missing file — and its registry read was (a) uncached, a
// steady KV read consumer, and (b) uncaught: the day the free-tier KV get() budget
// ran out (2026-08-20), every 404-path route answered error 1101 instead of the
// branded 404/login flow. These pin the repaired shape: the registry read is
// cached per isolate, a throwing KV degrades (stale registry if one was read,
// fallthrough if not) and never throws out of virtualCanvas, and a registry write
// busts the cache so a just-created canvas is live at once on its isolate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

function memKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  const kv = {
    store,
    gets: 0,
    async get(k) { kv.gets += 1; return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
  };
  return kv;
}
const throwingKV = () => ({
  async get() { throw new Error("KV get() limit exceeded for the day."); },
  async put() { throw new Error("KV put() limit exceeded for the day."); },
});
const envWith = (kv) => ({
  COMMENTS: kv,
  ASSETS: { async fetch() { return new Response("", { status: 404 }); } },
});
// The workspace these boards belong to. virtualCanvas renders the loader page for a
// workspace now, so the fixture names one rather than leaving it to module scope.
// A named workspace, because the registry cache is per workspace: a context whose
// tenantId is still null is an UNRESOLVED request, which by construction participates
// in no cache at all — so the cadence these cases pin would never be reached.
const CTX = { ...W.applyDerivedRouting({}), tenantId: "alpha" };
const ME = { email: "a@example.test", name: "Ada", role: "admin" };
const canvasesUrl = new URL("https://example.test/__canvases");
const create = (kv, body) => W.canvasesApi(CTX, new Request(canvasesUrl, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}), canvasesUrl, envWith(kv), ME);
const get = (p) => ({ req: new Request("https://example.test" + p), url: new URL("https://example.test" + p) });

// Order matters: this file's first test needs the cold-cache state of a fresh process.
test("a throwing KV with nothing cached falls through — never a 500", async () => {
  const { req, url } = get("/x/whatever/");
  assert.equal(await W.virtualCanvas(CTX, req, envWith(throwingKV()), url), null);
});

test("repeat lookups inside the TTL cost one registry read, and a write busts", async () => {
  const kv = memKV();
  await create(kv, { dir: "/x/", name: "My Board" });
  const { req, url } = get("/x/my-board/");
  const before = kv.gets;
  assert.equal((await W.virtualCanvas(CTX, req, envWith(kv), url)).status, 200);
  assert.equal((await W.virtualCanvas(CTX, req, envWith(kv), url)).status, 200);
  assert.equal(kv.gets, before + 1, "second lookup rides the cache");
  // A registry write makes the next lookup re-read immediately (no TTL wait).
  await create(kv, { dir: "/x/", name: "Second" });
  const mid = kv.gets;
  const two = get("/x/second/");
  assert.equal((await W.virtualCanvas(CTX, two.req, envWith(kv), two.url)).status, 200, "new canvas live at once");
  assert.ok(kv.gets > mid, "the bust forced a fresh registry read");
});

test("a throwing KV serves the last-read registry rather than erroring", async () => {
  const kv = memKV();
  await create(kv, { dir: "/y/", name: "Stale Survivor" });
  const { req, url } = get("/y/stale-survivor/");
  assert.equal((await W.virtualCanvas(CTX, req, envWith(kv), url)).status, 200); // cache filled
  await create(kv, { dir: "/y/", name: "Buster" }); // bust so the next call must re-read...
  const res = await W.virtualCanvas(CTX, req, envWith(throwingKV()), url); // ...and the re-read throws
  assert.ok(res, "stale registry still serves the board");
  assert.equal(res.status, 200);
});
