// The canvas surfaces that live in KV: the board DOCUMENT per canvas URL (boardApi),
// the registry of canvases created from a folder index (canvasesApi), and the loader
// the worker serves at a registered path with no repo file behind it (virtualCanvas).
//
// A BASELINE, like test/worker-gate.test.mjs: written before the tenant-context
// refactor threads config through, and before board keys gain a tenant segment. It
// describes today's behaviour so those two changes have to prove they are no-ops.
// The KV key shapes are asserted directly and on purpose — `board:<path>` becoming
// `board:<tenant>:<path>` must be a visible, deliberate diff here, not a silent one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

function memKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
  };
}

// Assets mode (no GV_ASSET_SOURCE=r2), so assetPathExists consults this stub — the
// "never shadow a real shipped file" check is the only thing that reads it.
const envWith = (kv, shipped = []) => ({
  COMMENTS: kv,
  ASSETS: {
    async fetch(req) {
      const p = new URL(req.url).pathname;
      return new Response("", { status: shipped.includes(p) ? 200 : 404 });
    },
  },
});

const ME = { email: "a@example.test", name: "Ada", role: "admin" };
const boardUrl = (path) => new URL(`https://example.test/__board?path=${encodeURIComponent(path)}`);
const post = (url, body) => new Request(url, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

// ---- boardApi: the per-URL board document ----------------------------------

test("a board doc round-trips through KV under board:<path>", async () => {
  const kv = memKV();
  const env = envWith(kv);
  const doc = { nodes: [{ id: "n1", t: "text", v: "hello" }], view: { x: 0, y: 0, z: 1 }, name: "Board" };

  const write = await W.boardApi(post(boardUrl("/playground/b/"), { doc }), boardUrl("/playground/b/"), env);
  assert.equal(write.status, 200);
  assert.deepEqual(await write.json(), { ok: true });
  assert.deepEqual([...kv.store.keys()], ["board:/playground/b/"], "one key, prefixed by path");

  const read = await W.boardApi(new Request(boardUrl("/playground/b/")), boardUrl("/playground/b/"), env);
  assert.deepEqual((await read.json()).doc, doc, "exactly what the client POSTed comes back");
});

test("a board that was never saved reads as null, not as an error", async () => {
  const env = envWith(memKV());
  const res = await W.boardApi(new Request(boardUrl("/nope/")), boardUrl("/nope/"), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { doc: null });
});

test("the write is authoritative full-state — a second POST replaces, never merges", async () => {
  const kv = memKV();
  const env = envWith(kv);
  const u = boardUrl("/b/");
  await W.boardApi(post(u, { doc: { nodes: [{ id: "a" }, { id: "b" }] } }), u, env);
  await W.boardApi(post(u, { doc: { nodes: [{ id: "c" }] } }), u, env);
  const doc = JSON.parse(kv.store.get("board:/b/"));
  assert.deepEqual(doc.nodes, [{ id: "c" }], "no server-side merge — KV eventual consistency would race it");
});

test("boardApi rejects a doc that is not a node list", async () => {
  const kv = memKV();
  const env = envWith(kv);
  const u = boardUrl("/b/");
  for (const bad of [{ doc: null }, { doc: "x" }, { doc: {} }, { doc: { nodes: "no" } }, {}]) {
    const res = await W.boardApi(post(u, bad), u, env);
    assert.equal(res.status, 400, `${JSON.stringify(bad)} must be refused`);
  }
  assert.equal(kv.store.size, 0, "nothing was written");
});

test("boardApi needs a path, refuses bad JSON, and answers 405 to other methods", async () => {
  const env = envWith(memKV());
  const noPath = new URL("https://example.test/__board");
  assert.equal((await W.boardApi(new Request(noPath), noPath, env)).status, 400);

  const u = boardUrl("/b/");
  const badJson = new Request(u, { method: "POST", body: "{not json" });
  assert.equal((await W.boardApi(badJson, u, env)).status, 400);

  const del = new Request(u, { method: "DELETE" });
  assert.equal((await W.boardApi(del, u, env)).status, 405);
});

test("a doc over the size ceiling is refused before it reaches KV", async () => {
  const kv = memKV();
  const env = envWith(kv);
  const u = boardUrl("/b/");
  const huge = new Request(u, { method: "POST", body: "x".repeat(W.BOARD_MAX_BYTES + 1) });
  const res = await W.boardApi(huge, u, env);
  assert.equal(res.status, 413);
  assert.equal(kv.store.size, 0);
});

test("PUT is accepted alongside POST", async () => {
  const kv = memKV();
  const env = envWith(kv);
  const u = boardUrl("/b/");
  const put = new Request(u, { method: "PUT", body: JSON.stringify({ doc: { nodes: [] } }) });
  assert.equal((await W.boardApi(put, u, env)).status, 200);
  assert.equal(kv.store.size, 1);
});

test("with no KV binding the board answers a warning rather than throwing", async () => {
  const res = await W.boardApi(new Request(boardUrl("/b/")), boardUrl("/b/"), {});
  assert.deepEqual(await res.json(), { doc: null, warning: "no-kv-binding" });
});

// ---- canvasesApi: the created-canvas registry ------------------------------

const canvasesUrl = new URL("https://example.test/__canvases");
const create = (kv, body, shipped) =>
  W.canvasesApi(post(canvasesUrl, body), canvasesUrl, envWith(kv, shipped), ME);

test("creating a canvas slugs the name and registers it under the dir", async () => {
  const kv = memKV();
  const res = await create(kv, { dir: "/playground/", name: "My Big Board" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.path, "/playground/my-big-board/");
  assert.equal(body.map["/playground/my-big-board/"].name, "My Big Board", "the display name is kept verbatim");
  assert.equal(body.map["/playground/my-big-board/"].by, ME.email);
});

test("the slug strips apostrophes and collapses everything else to single dashes", async () => {
  const kv = memKV();
  const res = await create(kv, { dir: "/x/", name: "  Rob's — Ideas!!  " });
  assert.equal((await res.json()).path, "/x/robs-ideas/",
    "the apostrophe is deleted BEFORE slugging, so it joins the word rather than splitting it");
  // Curly and straight apostrophes are treated alike, and leading/trailing dashes trim.
  const curly = await create(kv, { dir: "/y/", name: "Rob’s Ideas" });
  assert.equal((await curly.json()).path, "/y/robs-ideas/");
});

test("a name that slugs to nothing is refused", async () => {
  const kv = memKV();
  assert.equal((await create(kv, { dir: "/x/", name: "!!!" })).status, 400);
  assert.equal(kv.store.size, 0);
});

test("only a slug-segment directory is creatable — never the site root", async () => {
  const kv = memKV();
  for (const dir of ["/", "", "/Caps/", "/a b/", "/a/", "/a/b/", "/under_score/", "//"]) {
    const res = await create(kv, { dir, name: "Board" });
    const ok = ["/a/", "/a/b/"].includes(dir);
    assert.equal(res.status, ok ? 200 : 400, `dir ${JSON.stringify(dir)}`);
  }
});

test("a directory must end in a slash to be creatable", async () => {
  const kv = memKV();
  assert.equal((await create(kv, { dir: "/playground", name: "B" })).status, 400);
});

test("creating the same canvas twice is a 409, not a silent overwrite", async () => {
  const kv = memKV();
  await create(kv, { dir: "/x/", name: "Board" });
  const again = await create(kv, { dir: "/x/", name: "Board" });
  assert.equal(again.status, 409);
  assert.equal((await again.json()).error, "exists");
});

test("a canvas may never shadow a real shipped file at the same URL", async () => {
  // Any non-404 counts, redirects included: the registry serves a loader from KV and
  // would otherwise silently take over a published prototype's URL.
  const kv = memKV();
  const res = await create(kv, { dir: "/prototypes/", name: "Garden" }, ["/prototypes/garden/"]);
  assert.equal(res.status, 409);
  assert.equal(kv.store.size, 0, "nothing registered");
});

test("rename changes the display name and keeps the path, so the board doc survives", async () => {
  const kv = memKV();
  await create(kv, { dir: "/x/", name: "Old" });
  const res = await create(kv, { rename: true, path: "/x/old/", name: "New Name" });
  assert.equal(res.status, 200);
  const map = (await res.json()).map;
  assert.equal(map["/x/old/"].name, "New Name");
  assert.ok(map["/x/old/"], "the path — and so board:<path> — is untouched");
});

test("rename refuses an unknown path or an empty name", async () => {
  const kv = memKV();
  await create(kv, { dir: "/x/", name: "Old" });
  assert.equal((await create(kv, { rename: true, path: "/nope/", name: "N" })).status, 400);
  assert.equal((await create(kv, { rename: true, path: "/x/old/", name: "   " })).status, 400);
});

test("remove drops the registry entry but deliberately LEAVES the board doc", async () => {
  const kv = memKV();
  await create(kv, { dir: "/x/", name: "Board" });
  const u = boardUrl("/x/board/");
  await W.boardApi(post(u, { doc: { nodes: [{ id: "keep" }] } }), u, envWith(kv));

  const res = await create(kv, { remove: true, path: "/x/board/" });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).map, {}, "the registry entry is gone");
  assert.ok(kv.store.has("board:/x/board/"),
    "the doc stays — recreating the same name restores the work, so a mis-click destroys nothing");
});

test("removing an unregistered path is a 404", async () => {
  const kv = memKV();
  assert.equal((await create(kv, { remove: true, path: "/nope/" })).status, 404);
});

test("GET returns the whole registry map", async () => {
  const kv = memKV();
  await create(kv, { dir: "/x/", name: "One" });
  const res = await W.canvasesApi(new Request(canvasesUrl), canvasesUrl, envWith(kv), ME);
  assert.deepEqual(Object.keys((await res.json()).map), ["/x/one/"]);
});

test("canvasesApi answers 405 to other methods and warns with no KV", async () => {
  const kv = memKV();
  const del = new Request(canvasesUrl, { method: "DELETE" });
  assert.equal((await W.canvasesApi(del, canvasesUrl, envWith(kv), ME)).status, 405);
  const res = await W.canvasesApi(new Request(canvasesUrl), canvasesUrl, {}, ME);
  assert.deepEqual(await res.json(), { map: {}, warning: "no-kv-binding" });
});

// ---- virtualCanvas: serving a registered canvas with no repo file ----------

const get = (p) => ({ req: new Request("https://example.test" + p), url: new URL("https://example.test" + p) });

test("a registered path serves the canvas loader, named and noindexed", async () => {
  const kv = memKV();
  await create(kv, { dir: "/x/", name: "My Board" });
  const { req, url } = get("/x/my-board/");
  const res = await W.virtualCanvas(req, envWith(kv), url);
  assert.ok(res, "a response, not a fallthrough");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Type"), /text\/html/);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.match(res.headers.get("X-Robots-Tag"), /noindex/);
  assert.match(await res.text(), /My Board/, "the registered name is rendered");
});

test("an unregistered path falls through to the ordinary routing", async () => {
  const kv = memKV();
  const { req, url } = get("/x/nothing-here/");
  assert.equal(await W.virtualCanvas(req, envWith(kv), url), null);
});

test("/index.html serves the loader directly rather than redirecting", async () => {
  const kv = memKV();
  await create(kv, { dir: "/x/", name: "B" });
  const { req, url } = get("/x/b/index.html");
  const res = await W.virtualCanvas(req, envWith(kv), url);
  assert.equal(res.status, 200);
});

test("the slashless form redirects to the canonical folder URL", async () => {
  const kv = memKV();
  await create(kv, { dir: "/x/", name: "B" });
  const { req, url } = get("/x/b");
  const res = await W.virtualCanvas(req, envWith(kv), url);
  assert.equal(res.status, 301);
  assert.match(res.headers.get("Location"), /\/x\/b\/$/);
});

test("virtualCanvas only answers GET and HEAD", async () => {
  const kv = memKV();
  await create(kv, { dir: "/x/", name: "B" });
  const url = new URL("https://example.test/x/b/");
  const res = await W.virtualCanvas(new Request(url, { method: "POST" }), envWith(kv), url);
  assert.equal(res, null, "a write to a canvas URL is not this route's business");
});

test("a path that is not a slug directory is never a virtual canvas", async () => {
  const kv = memKV({ [W.CANVASES_KEY]: JSON.stringify({ "/Caps/x/": { name: "X" } }) });
  const { req, url } = get("/Caps/x/");
  assert.equal(await W.virtualCanvas(req, envWith(kv), url), null,
    "the path guard runs before the registry lookup, so a bad entry can never be served");
});

test("with no KV, or an empty registry, virtualCanvas falls through", async () => {
  const { req, url } = get("/x/b/");
  assert.equal(await W.virtualCanvas(req, {}, url), null);
  assert.equal(await W.virtualCanvas(req, envWith(memKV()), url), null);
});
