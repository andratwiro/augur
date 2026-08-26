// The two endpoints a stranger with a link can spend a workspace's money on.
//
// `B-board-write-quota` and `B-asset-upload-quota`. `/__board` PUT is unauthenticated by
// design — the board is the credential — and had no ceiling at all beyond a per-document
// size cap. `/__asset` POST had a per-REQUEST 4MB cap and no throughput ceiling, and no
// collection of images no board refers to any more.
//
// ⚠️ NO STORE, NO CEILING, and that is deliberate rather than incidental. Every instance
// today binds no TENANTS namespace, so neither endpoint grows a limit by taking this
// engine. Inventing one for them would be a behaviour change nobody asked for, applied to
// somebody's live canvas session, in the same release as the machinery that makes it
// correct. A ceiling is per workspace, and it arrives with the workspace.
//
// THE COUNTER FAILS OPEN, unlike the publish counter, and the asymmetry is the point.
// Letting one unmetered board write through costs a fraction of a quota; refusing a canvas
// save because a bookkeeping object hiccuped loses somebody's drawing. On the publish side
// the trade runs the other way — letting one through corrupts the version history — so
// that one refuses. Same machinery, opposite defaults, both stated where they are decided.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { __testables as W } from "../src/_worker.js";
import { TenantStore } from "../src/tenant-do.js";
import { PLANS } from "../src/tenant-quotas.mjs";

const CTX = Object.freeze({ tenantId: "acme" });

function memKv() {
  const store = new Map();
  return {
    _store: store,
    async get(k, opts) {
      const e = store.get(k);
      if (!e) return null;
      return opts && opts.type === "arrayBuffer" ? e.bytes.buffer : e.bytes;
    },
    async getWithMetadata(k) {
      const e = store.get(k);
      return e ? { value: e.bytes, metadata: e.metadata } : { value: null, metadata: null };
    },
    async put(k, v, opts) { store.set(k, { bytes: v instanceof ArrayBuffer ? new Uint8Array(v) : v, metadata: (opts || {}).metadata }); },
    async delete(k) { store.delete(k); },
    async list({ prefix = "" } = {}) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}
function memR2() {
  const store = new Map();
  return {
    store,
    async head(k) { return store.has(k) ? {} : null; },
    async get(k) { const o = store.get(k); return o ? { body: o.body, httpMetadata: o.httpMetadata } : null; },
    async put(k, v, opts) { store.set(k, { body: v, httpMetadata: (opts || {}).httpMetadata }); },
    async delete(k) { store.delete(k); },
  };
}
function namespace({ plan = "free" } = {}) {
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
        const store = new TenantStore({
          storage: {
            sql,
            transactionSync(cb) {
              db.exec("BEGIN");
              try { const o = cb(); db.exec("COMMIT"); return o; }
              catch (e) { db.exec("ROLLBACK"); throw e; }
            },
          },
          blockConcurrencyWhile: async (f) => f(),
        }, {});
        objects.set(id.name, { store, plan });
        store.init(id.name, { plan });
      }
      const { store } = objects.get(id.name);
      return { id, fetch: (u, init) => store.fetch(new Request(u, init)), store };
    },
  };
}

/** Raise or lower one ceiling on a workspace, the way a support request would. */
async function setCeiling(ns, workspace, field, value) {
  const stub = ns.get(ns.idFromName(workspace));
  await stub.store.init(workspace);
  stub.store.sql.exec(`INSERT INTO quotas (k, n) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET n = excluded.n`, field, value);
}

const boardUrl = new URL("https://x.test/__board?path=/b/one/");
const putBoard = (env, nodes = [{ id: "a" }]) => W.boardApi(CTX, new Request(boardUrl, {
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ doc: { nodes } }),
}), boardUrl, env);

const png = (bytes) => {
  const out = new Uint8Array(bytes);
  const header = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < Math.min(header.length, bytes); i++) out[i] = header[i];
  for (let i = header.length; i < bytes; i++) out[i] = (i * 31) & 0xff;
  return out;
};
const upload = (env, bytes) => W.assetApi(CTX,
  new Request("https://x.test/__asset", { method: "POST", headers: { "content-type": "image/png" }, body: bytes }),
  new URL("https://x.test/__asset"), env);

// ── board writes ─────────────────────────────────────────────────────────────

test("AN INSTANCE WITH NO WORKSPACE STORE IS UNMETERED, exactly as today", async () => {
  // The one that decides whether this is safe to deploy. Every live instance is this case.
  const env = { COMMENTS: memKv() };
  for (let i = 0; i < 40; i++) {
    assert.equal((await putBoard(env)).status, 200, `write ${i} was refused on an unmetered instance`);
  }
  assert.deepEqual(await W.quotaBump(env, CTX, { key: "x", field: "boardWritesPerMinute", window: "w" }),
    { allowed: true, unmetered: true });
});

test("THE CEILING KICKS IN WITH A 429, and says what reset means", async () => {
  const ns = namespace();
  const env = { COMMENTS: memKv(), TENANTS: ns };
  await setCeiling(ns, "acme", "boardWritesPerMinute", 3);
  for (let i = 0; i < 3; i++) assert.equal((await putBoard(env)).status, 200, `write ${i + 1} of 3`);
  const over = await putBoard(env);
  assert.equal(over.status, 429);
  const body = await over.json();
  assert.equal(body.error, "quota-exceeded");
  assert.equal(body.limit, 3);
  assert.match(body.message, /nothing was lost/);
});

test("NORMAL COLLABORATION STAYS COMFORTABLY UNDER IT", async () => {
  // The other half of the VERIFY, and the half a ceiling is usually wrong about. A canvas
  // board saves on a debounce, not per stroke: four people drawing hard is a handful of
  // writes each per minute, and the free tier's 300 leaves an order of magnitude of room.
  const ns = namespace();
  const env = { COMMENTS: memKv(), TENANTS: ns };
  const busySession = 4 * 15; // four editors, fifteen saves a minute each — a hard session
  assert.ok(busySession < PLANS.free.boardWritesPerMinute / 4,
    `the free ceiling (${PLANS.free.boardWritesPerMinute}) is within 4x of a busy session (${busySession})`);
  for (let i = 0; i < busySession; i++) {
    assert.equal((await putBoard(env)).status, 200, `a busy session was throttled at write ${i}`);
  }
});

test("the window rolls, so a ceiling is a pace and not a wall", async () => {
  const ns = namespace();
  const env = { COMMENTS: memKv(), TENANTS: ns };
  await setCeiling(ns, "acme", "boardWritesPerMinute", 2);
  await putBoard(env); await putBoard(env);
  assert.equal((await putBoard(env)).status, 429);
  // The next minute is a different bucket. Driven through the helper, because the route
  // takes its window from the clock.
  const next = W.quotaMinute(Date.now() + 61_000);
  const verdict = await W.quotaBump(env, CTX, { key: "board-writes", field: "boardWritesPerMinute", window: next });
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.n, 1, "the new window did not start from zero");
});

test("a refused write stores nothing", async () => {
  const ns = namespace();
  const env = { COMMENTS: memKv(), TENANTS: ns };
  await setCeiling(ns, "acme", "boardWritesPerMinute", 1);
  await putBoard(env, [{ id: "kept" }]);
  assert.equal((await putBoard(env, [{ id: "refused" }])).status, 429);
  const doc = (await (await W.boardApi(CTX, new Request(boardUrl), boardUrl, env)).json()).doc;
  assert.deepEqual(doc.nodes, [{ id: "kept" }]);
});

test("a malformed write is refused BEFORE it is metered", async () => {
  // Otherwise a flood of rubbish spends the ceiling that protects the real writes.
  const ns = namespace();
  const env = { COMMENTS: memKv(), TENANTS: ns };
  await setCeiling(ns, "acme", "boardWritesPerMinute", 2);
  for (let i = 0; i < 5; i++) {
    const bad = await W.boardApi(CTX, new Request(boardUrl, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ doc: { notNodes: [] } }),
    }), boardUrl, env);
    assert.equal(bad.status, 400);
  }
  assert.equal((await putBoard(env)).status, 200, "rubbish spent the ceiling");
});

test("A COUNTER THAT CANNOT BE REACHED DOES NOT BECOME A GATE", async () => {
  // Refusing a canvas save because a bookkeeping object hiccuped loses somebody's drawing.
  // The publish counter makes the opposite call, on purpose, because there the cost of
  // letting one through is a corrupted history rather than a fraction of a quota.
  //
  // Only the COUNTING is broken here. A workspace whose whole store is unreachable has
  // nowhere to put the board either, and failing that write is correct rather than a
  // policy choice — so breaking everything would test the wrong thing.
  const ns = namespace();
  await setCeiling(ns, "acme", "boardWritesPerMinute", 1);
  const real = ns.get;
  ns.get = (id) => {
    const stub = real.call(ns, id);
    return { ...stub, fetch: (u, init) => (String(u).endsWith("/quota/bump")
      ? Promise.reject(new Error("gone"))
      : stub.fetch(u, init)) };
  };
  const env = { COMMENTS: memKv(), TENANTS: ns };
  for (let i = 0; i < 5; i++) {
    assert.equal((await putBoard(env)).status, 200, `write ${i} was refused because counting failed`);
  }
});

// ── image uploads ────────────────────────────────────────────────────────────

test("UPLOADING PAST THE DAILY CEILING IS A 429, counted in bytes", async () => {
  // Bytes rather than uploads: what costs a workspace is what it stores, and ten megabytes
  // is ten megabytes however many requests it arrived in.
  const ns = namespace();
  const env = { COMMENTS: memKv(), BUNDLES: memR2(), TENANTS: ns };
  await setCeiling(ns, "acme", "assetUploadDailyBytes", 5000);
  assert.equal((await upload(env, png(3000))).status, 200);
  const over = await upload(env, png(3001));
  assert.equal(over.status, 429);
  assert.equal((await over.json()).what, "daily image upload");
  assert.equal(env.BUNDLES.store.size, 1, "the refused upload stored its bytes anyway");
});

test("a refused image is not metered twice, and a too-large one is not metered at all", async () => {
  const ns = namespace();
  const env = { COMMENTS: memKv(), BUNDLES: memR2(), TENANTS: ns };
  await setCeiling(ns, "acme", "assetUploadDailyBytes", 10_000);
  assert.equal((await W.assetApi(CTX, new Request("https://x.test/__asset", {
    method: "POST", headers: { "content-type": "application/pdf" }, body: png(100),
  }), new URL("https://x.test/__asset"), env)).status, 415);
  assert.equal((await upload(env, png(W.ASSET_MAX_BYTES + 1))).status, 413);
  // The whole ceiling is still there for real images.
  assert.equal((await upload(env, png(9000))).status, 200);
});

// ── collecting what no board refers to ───────────────────────────────────────

const boardWith = (env, path, hashes) => W.boardApi(CTX, new Request(`https://x.test/__board?path=${path}`, {
  method: "PUT", headers: { "content-type": "application/json" },
  body: JSON.stringify({ doc: { nodes: hashes.map((h) => ({ id: h, src: `/__asset/${h}` })) } }),
}), new URL(`https://x.test/__board?path=${path}`), env);

async function seeded() {
  const env = { COMMENTS: memKv(), BUNDLES: memR2(), TENANTS: namespace() };
  const a = (await (await upload(env, png(400))).json()).url.slice("/__asset/".length);
  const b = (await (await upload(env, png(500))).json()).url.slice("/__asset/".length);
  await boardWith(env, "/b/one/", [a]);
  await boardWith(env, "/b/two/", [b]);
  return { env, a, b };
}

test("nothing is collected while a board still refers to it", async () => {
  const { env } = await seeded();
  const r = await W.assetGc(env, CTX, { now: Date.now() + 30 * 24 * 3600_000 });
  assert.deepEqual({ ok: r.ok, deleted: r.deleted, kept: r.kept, referenced: r.referenced },
    { ok: true, deleted: 0, kept: 2, referenced: 2 });
  assert.equal(env.BUNDLES.store.size, 2);
});

test("AN IMAGE NO BOARD REFERS TO IS COLLECTED, bytes and row together", async () => {
  const { env, a, b } = await seeded();
  await boardWith(env, "/b/two/", []); // b's board loses its only reference
  const r = await W.assetGc(env, CTX, { now: Date.now() + 30 * 24 * 3600_000 });
  assert.equal(r.deleted, 1);
  assert.deepEqual(r.hashes, [b]);
  assert.equal(env.BUNDLES.store.has(W.ASSET_R2_PREFIX + b), false, "the bytes survived");
  assert.equal(env.BUNDLES.store.has(W.ASSET_R2_PREFIX + a), true, "a referenced image was taken");
  const rows = await W.overlayFor(env, CTX).read("assets");
  assert.deepEqual(Object.keys(rows), [a], "the row survived its bytes");
});

test("THE GRACE WINDOW PROTECTS AN IMAGE THAT IS STILL BEING PLACED", async () => {
  // The moment this exists for: an image is uploaded SECONDS before the board that will
  // reference it is saved. A pass landing in that gap without a window deletes it.
  const env = { COMMENTS: memKv(), BUNDLES: memR2(), TENANTS: namespace() };
  const { url } = await (await upload(env, png(600))).json();
  const hash = url.slice("/__asset/".length);
  const justNow = await W.assetGc(env, CTX, { now: Date.now() + 60_000 });
  assert.equal(justNow.deleted, 0, "an image uploaded a minute ago was collected");
  assert.equal(justNow.kept, 1);
  // And once it is old and still unreferenced, it goes.
  const later = await W.assetGc(env, CTX, { now: Date.now() + W.ASSET_GC_GRACE_MS + 60_000 });
  assert.equal(later.deleted, 1);
});

test("re-pasting an unreferenced image buys it another window", async () => {
  // The VERIFY's last line. A re-paste writes no bytes — the image is already there — but
  // it refreshes the stamp the collector reads, because somebody is evidently using it.
  const env = { COMMENTS: memKv(), BUNDLES: memR2(), TENANTS: namespace() };
  const bytes = png(700);
  const hash = (await (await upload(env, bytes)).json()).url.slice("/__asset/".length);
  const aged = Date.now() + W.ASSET_GC_GRACE_MS + 60_000;

  // Without the re-paste it would go now.
  const wouldGo = await W.assetGc(env, CTX, { now: aged, dryRun: true });
  assert.deepEqual(wouldGo.hashes, [hash]);
  assert.equal(env.BUNDLES.store.size, 1, "a dry run deleted something");

  await upload(env, bytes); // re-pasted; the stamp moves to now
  const survives = await W.assetGc(env, CTX, { now: Date.now() + 60_000 });
  assert.equal(survives.deleted, 0);
  assert.equal(env.BUNDLES.store.has(W.ASSET_R2_PREFIX + hash), true);
});

test("a reference is found wherever it is nested in a node", async () => {
  // Node shapes have changed more than once and will again. The URL has not, so the
  // reference is searched for rather than read out of a field that may be renamed.
  const env = { COMMENTS: memKv(), BUNDLES: memR2(), TENANTS: namespace() };
  const hash = (await (await upload(env, png(800))).json()).url.slice("/__asset/".length);
  const u = new URL("https://x.test/__board?path=/b/deep/");
  await W.boardApi(CTX, new Request(u, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ doc: { nodes: [{ id: "n", frame: { fills: [{ image: { href: `/__asset/${hash}` } }] } }] } }),
  }), u, env);
  const r = await W.assetGc(env, CTX, { now: Date.now() + 30 * 24 * 3600_000 });
  assert.equal(r.deleted, 0, "a reference nested three levels down was missed");
});

test("with no store the collector refuses rather than reporting a clean sweep", async () => {
  // A pass that finds nothing because it could not look is the most dangerous possible
  // report: it reads exactly like a workspace with nothing to collect.
  assert.deepEqual(await W.assetGc({}, CTX), { ok: false, reason: "no-store" });
  assert.deepEqual(await W.assetGc({ COMMENTS: memKv() }, CTX), { ok: false, reason: "no-store" });
});
