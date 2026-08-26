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
  // rename here would look like every status, name, board and pin vanishing at once.
  assert.equal(W.overlayKvKey("statuses", ""), "statuses");
  assert.equal(W.overlayKvKey("names", ""), "names");
  assert.equal(W.overlayKvKey("canvases", ""), "canvases");
  assert.equal(W.overlayKvKey("pins", ""), "pins");
  assert.equal(W.overlayKvKey("pins", "who@example.test"), "pins:who@example.test");
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
