// Who made this board, and who made this prototype's status row.
//
// `B-resource-owner-schema-basis`. The only place in the engine that asks "is this person
// allowed to touch this SPECIFIC thing, rather than this workspace" is the comment-thread
// removal check — an admin, or the thread's own author, matched against a `by` field the
// server stamped at creation and has never trusted from a request body. Nowhere else has
// it. The canvas registry stamps `by` for display and nothing reads it; a board document
// carries no owner at all.
//
// This adds the DATA and no enforcement. Nothing reads `owner` to decide anything, on
// purpose: the point is that trustworthy ownership already exists in the schema by the time
// `canEditResource` is written, so that item is a wiring change rather than a second
// migration through everybody's live data.
//
// THREE RULES, and each is a way this goes wrong if it is missed:
//   · stamped from the SESSION, never from the body — or an ACL is a field you can type;
//   · stamped at CREATION and never moved — or a board belongs to whoever saved it last,
//     which is the opposite of what an owner is;
//   · ABSENT is a valid answer — the board route is unauthenticated by design, so an
//     anonymous save must leave it empty rather than inventing an owner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { __testables as W } from "../src/_worker.js";
import { TenantStore } from "../src/tenant-do.js";

const CTX = Object.freeze({ tenantId: "acme", SPACES: [{ id: "alpha", default: true }] });
const A = { email: "a@example.test", name: "Ada", role: "editor" };
const B = { email: "b@example.test", name: "Bo", role: "editor" };

function memKv() {
  const store = new Map();
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async getWithMetadata(k) { return { value: store.get(k) ?? null, metadata: null }; },
    async put(k, v) { store.set(k, typeof v === "string" ? v : JSON.stringify(v)); },
    async delete(k) { store.delete(k); },
    async list({ prefix = "" } = {}) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}
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
      return { id, store, fetch: (u, init) => store.fetch(new Request(u, init)) };
    },
  };
}
const withStore = () => ({ COMMENTS: memKv(), BUNDLES: { async head() { return null; }, async put() {}, async get() { return null; } }, TENANTS: namespace() });

const boardUrl = (p) => new URL(`https://x.test/__board?path=${p}`);
const putBoard = (env, p, nodes, me) => W.boardApi(CTX, new Request(boardUrl(p), {
  method: "PUT", headers: { "content-type": "application/json" },
  // A body that tries to say who the owner is. It must make no difference at all.
  body: JSON.stringify({ doc: { nodes }, owner: "someone-else@example.test", ownerEmail: "nope@example.test" }),
}), boardUrl(p), env, me);

const statusUrl = new URL("https://x.test/__status");
const setStatus = (env, key, status, me) => W.statusApi(CTX, new Request(statusUrl, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ key, status, owner: "someone-else@example.test" }),
}), statusUrl, env, me);

const canvasUrl = new URL("https://x.test/__canvases");
const createCanvas = (env, name, me) => W.canvasesApi(CTX, new Request(canvasUrl, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ dir: "/boards/", name, by: "someone-else@example.test" }),
}), canvasUrl, { ...env, ASSETS: { fetch: async () => new Response("nf", { status: 404 }) } }, me);

const ownerOf = (env, family, k) => W.overlayFor(env, CTX).owner(family, "", k);

// ── the VERIFY ───────────────────────────────────────────────────────────────

test("A BOARD AND A CANVAS ARE OWNED BY THE AUTHENTICATED CALLER, whatever the body says", async () => {
  const env = withStore();
  assert.equal((await putBoard(env, "/b/one/", [{ id: "n" }], A)).status, 200);
  const board = await ownerOf(env, "boards", "/b/one/");
  assert.equal(board.owner, A.email, "the board's owner is not the caller");
  assert.equal(board.acl, null, "an ACL appeared without anybody setting one");

  const created = await createCanvas(env, "Shared", A);
  assert.equal(created.status, 200);
  const canvas = await ownerOf(env, "canvases", "/boards/shared/");
  assert.equal(canvas.owner, A.email);
});

test("a prototype's status row is owned by whoever first set it", async () => {
  const env = withStore();
  assert.equal((await setStatus(env, "/p/", "dev-ready", A)).status, 200);
  assert.equal((await ownerOf(env, "statuses", "/p/")).owner, A.email);
});

test("THE OWNER DOES NOT MOVE when somebody else writes", async () => {
  // The rule that makes an owner an owner. A board saved by four people in a session
  // belongs to whoever made it, not to whoever closed the tab last.
  const env = withStore();
  await putBoard(env, "/b/one/", [{ id: "first" }], A);
  await putBoard(env, "/b/one/", [{ id: "second" }], B);
  await putBoard(env, "/b/one/", [{ id: "third" }], B);
  assert.equal((await ownerOf(env, "boards", "/b/one/")).owner, A.email, "the last writer took ownership");

  await setStatus(env, "/p/", "dev-ready", A);
  await setStatus(env, "/p/", "reviewed", B);
  assert.equal((await ownerOf(env, "statuses", "/p/")).owner, A.email);
});

test("AN ANONYMOUS BOARD SAVE LEAVES THE OWNER ABSENT, and does not invent one", async () => {
  // `/__board` is unauthenticated by design — the board is the credential — so "nobody"
  // is a real answer here. Writing a placeholder would be worse than leaving it empty:
  // the enforcement item would then have an owner it could not trust.
  const env = withStore();
  assert.equal((await putBoard(env, "/b/anon/", [{ id: "n" }], null)).status, 200);
  assert.equal((await ownerOf(env, "boards", "/b/anon/")).owner, null);

  // And a later signed-in save DOES take it, because the row had no owner to protect.
  await putBoard(env, "/b/anon/", [{ id: "n2" }], B);
  assert.equal((await ownerOf(env, "boards", "/b/anon/")).owner, B.email);
});

// ── it changes nothing observable ────────────────────────────────────────────

test("NOTHING READS IT TO DECIDE ANYTHING — the responses are identical either way", async () => {
  // The other half of the VERIFY. This item adds data; enforcement is its own item, and
  // the difference matters: shipping a half-enforced check would refuse somebody today.
  const env = withStore();
  await putBoard(env, "/b/one/", [{ id: "n" }], A);
  // B is not the owner, and B's write goes through exactly as A's did.
  const asOther = await putBoard(env, "/b/one/", [{ id: "n2" }], B);
  assert.equal(asOther.status, 200);
  const anon = await putBoard(env, "/b/one/", [{ id: "n3" }], null);
  assert.equal(anon.status, 200, "an anonymous save was refused on a board somebody owns");
  const doc = (await (await W.boardApi(CTX, new Request(boardUrl("/b/one/")), boardUrl("/b/one/"), env, null)).json()).doc;
  assert.deepEqual(doc.nodes, [{ id: "n3" }], "the write did not land");
});

test("the owner is not in what the API hands back, so no client can start depending on it", async () => {
  const env = withStore();
  await putBoard(env, "/b/one/", [{ id: "n" }], A);
  const body = await (await W.boardApi(CTX, new Request(boardUrl("/b/one/")), boardUrl("/b/one/"), env, null)).json();
  assert.deepEqual(Object.keys(body), ["doc"]);
  assert.equal(JSON.stringify(body).includes(A.email), false);

  const statuses = await (await W.statusApi(CTX, new Request(statusUrl), statusUrl, env, A)).json();
  assert.deepEqual(Object.keys(statuses), ["map"]);
});

test("an instance with no workspace object is completely unaffected", async () => {
  // Every instance today. There is nowhere to put a per-row column in a KV map document,
  // and a parallel owner document would be a second record of the same thing that drifts.
  const env = { COMMENTS: memKv() };
  assert.equal((await putBoard(env, "/b/one/", [{ id: "n" }], A)).status, 200);
  assert.equal((await setStatus(env, "/p/", "dev-ready", A)).status, 200);
  const stored = JSON.parse(env.COMMENTS.store.get("statuses"));
  assert.deepEqual(stored, { "/p/": "dev-ready" }, "an owner leaked into the KV value");
  assert.equal(env.COMMENTS.store.get("board:/b/one/"), JSON.stringify({ nodes: [{ id: "n" }] }));
});

test("the ACL column is there, nullable, and nothing writes it yet", async () => {
  // Stated as a test because the absence is deliberate. `acl` absent means "no
  // per-resource restriction, the workspace role decides" — the narrowing-only default the
  // rest of the permission model uses — and a route that could set one before anything
  // enforces it would be a lock with no door.
  const env = withStore();
  await putBoard(env, "/b/one/", [{ id: "n" }], A);
  assert.deepEqual(await ownerOf(env, "boards", "/b/one/"), { owner: A.email, acl: null });

  const ns = env.TENANTS;
  const stub = ns.get(ns.idFromName("acme"));
  const cols = [...stub.store.sql.exec("SELECT * FROM overlay LIMIT 1")].map((r) => Object.keys(r))[0];
  assert.ok(cols.includes("acl"), `overlay columns are ${cols}`);
  assert.ok(cols.includes("owner"));
});
