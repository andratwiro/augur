// Two people editing two different things do not overwrite each other.
//
// `B-do-schema-content-overlay`. Four families remember things ABOUT published content
// rather than in it: a prototype's dev status, a card's display-name override, the boards
// created from a folder index, and a person's pins. Each was one KV document holding the
// whole map, read and written back on every edit.
//
// SO TWO EDITS TO DIFFERENT KEYS LOSE ONE. The second write is computed from a map that
// predates the first, and there is no error and nothing to see — a status simply does not
// stick and the person clicks it again. The first test below reproduces exactly that,
// because a fix is worth nothing if the bug was hypothetical.
//
// One row per key in the workspace's Durable Object makes concurrent edits to different
// keys independent by construction. The KV backing stays, verbatim, because no instance
// binds TENANTS yet and every one of them keeps the exact documents it has now.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { __testables as W } from "../src/_worker.js";
import { TenantStore } from "../src/tenant-do.js";

/** A KV stub that YIELDS on read, so a read-compute-write genuinely interleaves. */
function slowKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return {
    store,
    async get(k) { await tick(); return store.has(k) ? store.get(k) : null; },
    async put(k, v) { await tick(); store.set(k, v); },
    async delete(k) { await tick(); store.delete(k); },
    // The listing the keyed families' whole-set read needs. Real KV pages; one page here
    // is enough, because what is being tested is that the accessor asks for the set at all
    // rather than that it walks a cursor.
    async list({ prefix = "" } = {}) {
      await tick();
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}

/** A TENANTS namespace whose objects are real TenantStores over real SQLite. */
function namespace() {
  const objects = new Map();
  return {
    idFromName(name) { return { name }; },
    get(id) {
      if (!objects.has(id.name)) {
        const db = new DatabaseSync(":memory:");
        const sql = {
          exec(stmt, ...params) {
            if (params.length) return db.prepare(stmt).all(...params);
            if (/^\s*SELECT/i.test(stmt)) return db.prepare(stmt).all();
            db.exec(stmt);
            return [];
          },
        };
        objects.set(id.name, new TenantStore({
          storage: {
            sql,
            transactionSync(cb) {
              db.exec("BEGIN");
              try { const o = cb(); db.exec("COMMIT"); return o; }
              catch (e) { db.exec("ROLLBACK"); throw e; }
            },
          },
          blockConcurrencyWhile: async (f) => f(),
        }, {}));
      }
      const store = objects.get(id.name);
      return { id, fetch: (u, init) => store.fetch(new Request(u, init)) };
    },
  };
}

const CTX = Object.freeze({ tenantId: "acme" });
const statusUrl = new URL("https://x.test/__status");
const post = (body) => new Request(statusUrl, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

// ── the bug, and the fix, through the real route ─────────────────────────────

test("THE BUG, REPRODUCED: on KV, parallel status writes to different keys lose some", async () => {
  const env = { COMMENTS: slowKV() };
  const keys = Array.from({ length: 12 }, (_, i) => `/p/${i}/`);
  await Promise.all(keys.map((k) => W.statusApi(CTX, post({ key: k, status: "dev-ready" }), statusUrl, env)));
  const map = JSON.parse(env.COMMENTS.store.get("statuses") || "{}");
  assert.ok(Object.keys(map).length < keys.length,
    `all ${keys.length} writes survived; the fixture is not interleaving, so this proves nothing`);
});

test("WITH THE WORKSPACE STORE, ALL N LAND", async () => {
  // The VERIFY. Same route, same requests, one row per key.
  const env = { COMMENTS: slowKV(), TENANTS: namespace() };
  const keys = Array.from({ length: 12 }, (_, i) => `/p/${i}/`);
  await Promise.all(keys.map((k) => W.statusApi(CTX, post({ key: k, status: "dev-ready" }), statusUrl, env)));
  const final = await (await W.statusApi(CTX, new Request(statusUrl), statusUrl, env)).json();
  assert.deepEqual(Object.keys(final.map).sort(), [...keys].sort());
  for (const k of keys) assert.equal(final.map[k], "dev-ready");
});

test("two writes to the SAME key still resolve to one of them, not to a merge", async () => {
  // Worth pinning: per-key rows fix concurrent edits to DIFFERENT keys. Two people
  // setting the same status at once is last-writer-wins, which is what it should be — the
  // alternative would be inventing a conflict where a person just picked a value.
  const env = { COMMENTS: slowKV(), TENANTS: namespace() };
  await Promise.all([
    W.statusApi(CTX, post({ key: "/p/", status: "dev-ready" }), statusUrl, env),
    W.statusApi(CTX, post({ key: "/p/", status: "in-progress" }), statusUrl, env),
  ]);
  const final = await (await W.statusApi(CTX, new Request(statusUrl), statusUrl, env)).json();
  assert.ok(["dev-ready", "in-progress"].includes(final.map["/p/"]));
  assert.equal(Object.keys(final.map).length, 1);
});

// ── the two backings answer the same questions ───────────────────────────────

const backings = () => [
  ["kv", { COMMENTS: slowKV() }],
  ["do", { COMMENTS: slowKV(), TENANTS: namespace() }],
];

test("a status round-trips, and only a known status is accepted", async () => {
  for (const [name, env] of backings()) {
    const ok = await W.statusApi(CTX, post({ key: "/a/", status: "reviewed" }), statusUrl, env);
    assert.equal((await ok.json()).map["/a/"], "reviewed", name);
    const bad = await W.statusApi(CTX, post({ key: "/a/", status: "invented" }), statusUrl, env);
    assert.equal(bad.status, 400, name);
    const after = await (await W.statusApi(CTX, new Request(statusUrl), statusUrl, env)).json();
    assert.equal(after.map["/a/"], "reviewed", `${name}: the refused write changed the map`);
  }
});

test("AN EMPTY NAME CLEARS THE OVERRIDE on both backings", async () => {
  // The one place the accessor's `null` means something a caller relies on: an empty name
  // reverts a card to its build-time default rather than storing an empty string.
  const url = new URL("https://x.test/__name");
  const send = (env, body) => W.nameApi(CTX, new Request(url, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), url, env);
  for (const [name, env] of backings()) {
    await send(env, { key: "/a/", name: "Renamed" });
    const set = await (await W.nameApi(CTX, new Request(url), url, env)).json();
    assert.equal(set.map["/a/"], "Renamed", name);
    await send(env, { key: "/a/", name: "" });
    const cleared = await (await W.nameApi(CTX, new Request(url), url, env)).json();
    assert.equal("/a/" in cleared.map, false, `${name}: an empty name stored something`);
  }
});

test("pins are PER PERSON on both backings, and the empty guard still holds", async () => {
  const url = new URL("https://x.test/__pins");
  const send = (env, user, body) => W.pinsApi(CTX, new Request(url, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), url, env, user);
  const read = async (env, user) => (await (await W.pinsApi(CTX, new Request(url), url, env, user)).json()).map;
  const one = { email: "one@example.test" };
  const two = { email: "two@example.test" };

  for (const [name, env] of backings()) {
    await send(env, one, { set: { "/a/": { label: "A", href: "/a/" } } });
    await send(env, two, { set: { "/b/": { label: "B", href: "/b/" } } });
    assert.deepEqual(Object.keys(await read(env, one)), ["/a/"], `${name}: one's pins`);
    assert.deepEqual(Object.keys(await read(env, two)), ["/b/"], `${name}: two's pins`);

    // The empty guard: a wipe to nothing is refused unless the client says it means it.
    const guarded = await (await send(env, one, { set: {} })).json();
    assert.equal(guarded.skipped, "empty-guard", name);
    assert.deepEqual(Object.keys(await read(env, one)), ["/a/"], `${name}: the guard let a wipe through`);
    await send(env, one, { set: {}, allowEmpty: true });
    assert.deepEqual(await read(env, one), {}, `${name}: an explicit clear was refused`);
  }
});

test("A CREATE THAT LOSES A RACE IS TOLD, on the workspace store", async () => {
  // Creating a board reads the map, checks the slug is free, then writes — two steps, so
  // two creates of one name both pass the check and the second takes the first's board.
  // `insert` is one statement in one object, and the loser gets a 409 rather than a board
  // somebody else is drawing on.
  const url = new URL("https://x.test/__canvases");
  const body = { dir: "/boards/", name: "Shared" };
  const env = { COMMENTS: slowKV(), TENANTS: namespace(), ASSETS: { fetch: async () => new Response("nf", { status: 404 }) } };
  const both = await Promise.all([
    W.canvasesApi(CTX, new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), url, env, { email: "a@x.test" }),
    W.canvasesApi(CTX, new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), url, env, { email: "b@x.test" }),
  ]);
  const codes = both.map((r) => r.status).sort();
  assert.deepEqual(codes, [200, 409], "both creates were accepted, so one board was taken over");
  const map = await (await W.canvasesApi(CTX, new Request(url), url, env, null)).json();
  assert.deepEqual(Object.keys(map.map), ["/boards/shared/"]);
});

// ── the KV documents keep their names ────────────────────────────────────────

test("EVERY LIVE INSTANCE'S KEYS ARE UNCHANGED", async () => {
  // The straddle. No instance binds TENANTS, so every one of them keeps reading and
  // writing the documents it already has — under exactly the names it already uses. A key
  // rename here would look like every status, name, board, pin and queued remark vanishing
  // at once.
  assert.equal(W.overlayKvKey("statuses", ""), "statuses");
  assert.equal(W.overlayKvKey("names", ""), "names");
  assert.equal(W.overlayKvKey("canvases", ""), "canvases");
  assert.equal(W.overlayKvKey("pins", ""), "pins");
  assert.equal(W.overlayKvKey("pins", "who@example.test"), "pins:who@example.test");
  // The keyed layout: one document per key, and the two names the worker still spells out
  // beside the piti channel itself.
  assert.equal(W.overlayKvKey("piti", "", "view"), W.PITI_VIEW_KEY);
  assert.equal(W.overlayKvKey("piti", "", "remarks"), W.PITI_REMARKS_KEY);
  assert.throws(() => W.overlayKvKey("piti", ""), /one document per key/);
  assert.throws(() => W.overlayKvKey("invented", ""), /unknown overlay family/);

  // And the documents an instance already holds are read as they are.
  const env = { COMMENTS: slowKV({ statuses: JSON.stringify({ "/old/": "dev-ready" }) }) };
  const got = await (await W.statusApi(CTX, new Request(statusUrl), statusUrl, env)).json();
  assert.deepEqual(got.map, { "/old/": "dev-ready" });
});

test("no store at all answers exactly as it always did", async () => {
  // A raw engine build with no bindings. The warning is what the client keys on.
  const body = await (await W.statusApi(CTX, new Request(statusUrl), statusUrl, {})).json();
  assert.deepEqual(body, { map: {}, warning: "no-kv-binding" });
  assert.equal(W.overlayFor({}, CTX), null);
  assert.equal(W.overlayFor({ COMMENTS: slowKV() }, CTX).backing, "kv");
  assert.equal(W.overlayFor({ COMMENTS: slowKV(), TENANTS: namespace() }, CTX).backing, "do");
});

test("the workspace store wins over KV when both are bound", async () => {
  // Not an accident of ordering: a deployment that has moved a workspace onto its object
  // must not keep answering from the document the migration left behind.
  const env = { COMMENTS: slowKV({ statuses: JSON.stringify({ "/stale/": "ignore" }) }), TENANTS: namespace() };
  const got = await (await W.statusApi(CTX, new Request(statusUrl), statusUrl, env)).json();
  assert.deepEqual(got.map, {}, "the KV document answered for a workspace with its own store");
});

// ── the keyed family ─────────────────────────────────────────────────────────

test("THE PITI CHANNEL ROUND-TRIPS ON BOTH BACKINGS, and a poll does not read the view", async () => {
  // Two unrelated singletons that share a prefix, not a map. Modelling them as one map
  // would put the view on the wire on every poll of the remarks — and the poll is the hot
  // path, taken by every open tab on a public prototype.
  const url = (q) => new URL(`https://x.test/__piti${q}`);
  const send = (env, body) => W.pitiApi(CTX, new Request(url("?key=s3cret"), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), url("?key=s3cret"), env);

  for (const [name, base] of backings()) {
    const env = { ...base, REVIEW_EXPORT_KEY: "s3cret" };
    assert.equal((await send(env, { type: "view", path: "/p/", screen: "one", w: 1, h: 1 })).status, 200, name);
    const view = await (await W.pitiApi(CTX, new Request(url("?type=view&key=s3cret")), url("?type=view&key=s3cret"), env)).json();
    assert.equal(view.view.path, "/p/", `${name}: the view did not round-trip`);

    assert.equal((await send(env, { type: "remark", path: "/p/", text: "mind the contrast" })).status, 200, name);
    const polled = await (await W.pitiApi(CTX, new Request(url("?path=/p/")), url("?path=/p/"), env)).json();
    assert.equal(polled.remarks.length, 1, `${name}: the remark was not queued`);
    assert.equal(polled.remarks[0].text, "mind the contrast", name);

    assert.equal((await send(env, { type: "clear" })).status, 200, name);
    const after = await (await W.pitiApi(CTX, new Request(url("?path=/p/")), url("?path=/p/"), env)).json();
    assert.deepEqual(after.remarks, [], `${name}: clear left something behind`);
    // The view survives a clear — they are two documents, and always were.
    const stillThere = await (await W.pitiApi(CTX, new Request(url("?type=view&key=s3cret")), url("?type=view&key=s3cret"), env)).json();
    assert.equal(stillThere.view.path, "/p/", `${name}: clearing the queue took the view with it`);
  }
});

test("the piti documents an instance already holds are read as they are", async () => {
  // The straddle again, from the other side: a live instance's `pt:remarks` array is
  // picked up unchanged by the KV backing.
  //
  // Its OWN workspace id, because the remark cache is per-isolate and keyed by workspace:
  // reusing the one the test above cleared would read that cleared list back, and the
  // assertion would fail for a reason that has nothing to do with what it is checking.
  const ctx = Object.freeze({ tenantId: "acme-with-history" });
  const env = {
    COMMENTS: slowKV({ "pt:remarks": JSON.stringify([{ id: 1, path: "/p/", text: "from before", ts: Date.now() }]) }),
    REVIEW_EXPORT_KEY: "s3cret",
  };
  const u = new URL("https://x.test/__piti?path=/p/");
  const got = await (await W.pitiApi(ctx, new Request(u), u, env)).json();
  assert.equal(got.remarks[0].text, "from before");
});

// ── the two families whose VALUE is a document ───────────────────────────────
//
// `B-do-schema-comments-boards`. Per-key rows fix two edits to two keys. They do nothing
// for two edits to ONE key, which is what a page's comment threads and a board's nodes
// are: the worker reads the whole document, changes part of it and puts it back. So those
// rows carry a REVISION, and the write matches on it — a mismatch is a retry rather than a
// silent overwrite.
//
// The two want OPPOSITE things and that is the point of testing them together. A comment
// add and a comment delete must BOTH land. Two board PUTs must NOT merge: a board document
// is the client's whole canvas, reconciled in the realtime room before it ever gets here,
// and a server-side merge would produce a canvas neither person drew.

const reviewUrl = (p) => new URL(`https://x.test/__review/api?path=${encodeURIComponent(p)}`);
const reviewPost = (env, path, op, ctx = CTX) => W.reviewApi(
  Object.freeze({ USERS: [], ...ctx }),
  new Request(reviewUrl(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(op) }),
  reviewUrl(path), env, undefined);
const reviewRead = async (env, path, ctx = CTX) => (await (await W.reviewApi(
  Object.freeze({ USERS: [], ...ctx }), new Request(reviewUrl(path)), reviewUrl(path), env, undefined)).json()).threads;

const thread = (id, body) => ({
  op: "add",
  thread: { id, sel: "h1", messages: [{ author: "R", body }] },
});

test("A CONCURRENT ADD AND DELETE ON ONE THREAD BOTH LAND", async () => {
  // The VERIFY. Two reviewers on one public link is the ordinary case, not the exotic one.
  const ctx = Object.freeze({ tenantId: "threads-do" });
  const env = { COMMENTS: slowKV(), TENANTS: namespace() };
  await reviewPost(env, "/p/", thread("keep", "one"), ctx);
  await reviewPost(env, "/p/", thread("doomed", "two"), ctx);

  await Promise.all([
    reviewPost(env, "/p/", thread("fresh", "three"), ctx),
    reviewPost(env, "/p/", { op: "delete", id: "doomed" }, ctx),
  ]);

  const ids = (await reviewRead(env, "/p/", ctx)).map((t) => t.id).sort();
  assert.deepEqual(ids, ["fresh", "keep"],
    "one of the two concurrent ops was lost — the revision check is not doing its job");
});

test("and on KV the same pair loses one, which is why the revision exists", async () => {
  const ctx = Object.freeze({ tenantId: "threads-kv" });
  const env = { COMMENTS: slowKV() };
  await reviewPost(env, "/p/", thread("keep", "one"), ctx);
  await reviewPost(env, "/p/", thread("doomed", "two"), ctx);
  await Promise.all([
    reviewPost(env, "/p/", thread("fresh", "three"), ctx),
    reviewPost(env, "/p/", { op: "delete", id: "doomed" }, ctx),
  ]);
  const ids = (await reviewRead(env, "/p/", ctx)).map((t) => t.id).sort();
  assert.notDeepEqual(ids, ["fresh", "keep"],
    "the KV race did not reproduce; the fixture is not interleaving, so the test above proves nothing");
});

test("TWO BOARD PUTS ARE LAST-WRITE-WINS, never a merge", async () => {
  // The other half of the VERIFY, and the opposite requirement. A board document is the
  // whole canvas; merging two of them produces one neither person drew.
  const url = new URL("https://x.test/__board?path=/b/one/");
  const put = (env, nodes) => W.boardApi(CTX, new Request(url, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ doc: { nodes } }),
  }), url, env);
  for (const [name, base] of backings()) {
    const env = { ...base };
    await Promise.all([put(env, [{ id: "a" }, { id: "b" }]), put(env, [{ id: "c" }])]);
    const doc = (await (await W.boardApi(CTX, new Request(url), url, env)).json()).doc;
    const ids = doc.nodes.map((n) => n.id).sort().join(",");
    assert.ok(ids === "a,b" || ids === "c", `${name}: the two boards were merged into ${ids}`);
  }
});

test("a page's threads and a board live under the keys a live instance already holds", async () => {
  const env = { COMMENTS: slowKV() };
  await reviewPost(env, "/p/", thread("t1", "hello"), Object.freeze({ tenantId: "keys" }));
  assert.ok(env.COMMENTS.store.has("c:/p/"), `wrote ${[...env.COMMENTS.store.keys()]}`);
  assert.equal(W.overlayKvKey("comments", "", "/p/"), "c:/p/");
  assert.equal(W.overlayKvKey("boards", "", "/b/"), "board:/b/");
});

test("the review export reads every page in one call, on both backings", async () => {
  for (const [name, base] of backings()) {
    const ctx = Object.freeze({ tenantId: `export-${name}`, USERS: [] });
    const env = { ...base, REVIEW_EXPORT_KEY: "s3cret" };
    await reviewPost(env, "/one/", thread("a", "x"), ctx);
    await reviewPost(env, "/two/", thread("b", "y"), ctx);
    const u = new URL("https://x.test/__review/export?key=s3cret");
    const out = await (await W.reviewExport(ctx, new Request(u), u, env)).json();
    assert.deepEqual(Object.keys(out.pages).sort(), ["/one/", "/two/"], name);
    assert.equal(out.pages["/one/"][0].id, "a", name);
  }
});
