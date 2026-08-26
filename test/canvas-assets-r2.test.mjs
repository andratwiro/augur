// A pasted canvas image is bytes, and bytes do not go in a Durable Object.
//
// `B-migrate-canvas-assets-to-r2`. Every other KV family moved into the workspace's own
// object. This one cannot: a Durable Object's SQLite caps a single stored value around 2MB
// — the realtime worker's own NODE_CHUNK constant documents that ceiling — and a pasted
// screenshot is routinely bigger. So the bytes go to the same content-addressed R2 the
// published blobs already use, and the workspace keeps a row saying the image exists, what
// it is and how big.
//
// THE READ FALLBACK IS THE PART THAT MATTERS TODAY. Every image pasted on a live instance
// before this is a `basset:<hash>` value in KV. A read tries R2 and then KV, so nothing has
// to migrate for a board to keep rendering, and the fallback drains on its own as boards
// are re-pasted. A board that half-renders is worse than one that cannot grow.
//
// AND THE WRITE SWITCH IS THE WORKSPACE STORE, NOT THE BUNDLE STORE. Every live instance
// binds R2 already, so keying the write on that would move every new pasted image out of
// KV today — and out of the nightly KV backup with it, while the store backup walks
// `blobs/` and would not see `assets/` either. New images would be in neither copy,
// silently, which is what the canvas-image backup test exists because of. The bytes move
// when the workspace moves, and the export endpoints that cover `assets/` belong to that
// migration rather than to something this change quietly needs first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { __testables as W } from "../src/_worker.js";
import { TenantStore } from "../src/tenant-do.js";

const CTX = Object.freeze({ tenantId: "acme" });

function memKv(initial = {}) {
  const store = new Map(Object.entries(initial));
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
    async put(k, v, opts) {
      store.set(k, { bytes: v instanceof ArrayBuffer ? new Uint8Array(v) : v, metadata: (opts || {}).metadata });
    },
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
    async head(k) { return store.has(k) ? { size: store.get(k).body.byteLength } : null; },
    async get(k) {
      if (!store.has(k)) return null;
      const o = store.get(k);
      return { body: o.body, httpMetadata: o.httpMetadata, arrayBuffer: async () => o.body };
    },
    async put(k, v, opts) { store.set(k, { body: v, httpMetadata: (opts || {}).httpMetadata }); },
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
        objects.set(id.name, new TenantStore({ storage: { sql }, blockConcurrencyWhile: async (f) => f() }, {}));
      }
      const store = objects.get(id.name);
      return { id, fetch: (u, init) => store.fetch(new Request(u, init)) };
    },
  };
}

const upload = (env, bytes, ct = "image/png") => W.assetApi(
  CTX,
  new Request("https://x.test/__asset", { method: "POST", headers: { "content-type": ct }, body: bytes }),
  new URL("https://x.test/__asset"), env);
const serve = (env, hash) => W.assetApi(
  CTX, new Request(`https://x.test/__asset/${hash}`), new URL(`https://x.test/__asset/${hash}`), env);

/** A PNG header followed by filler, so the size is real and the type is honest. */
const png = (bytes) => {
  const out = new Uint8Array(bytes);
  const header = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < Math.min(header.length, bytes); i++) out[i] = header[i];
  for (let i = header.length; i < bytes; i++) out[i] = i & 0xff;
  return out;
};

// ── the item's VERIFY ────────────────────────────────────────────────────────

test("A 3.5MB PNG UPLOADS, SERVES FROM R2, AND HAS ITS ROW", async () => {
  // The size is the point: it is over the ~2MB a Durable Object can hold in one value and
  // under the 4MB this endpoint accepts, so it is exactly the image that forced the split.
  const env = { COMMENTS: memKv(), BUNDLES: memR2(), TENANTS: namespace() };
  const bytes = png(3.5 * 1024 * 1024);
  const { url } = await (await upload(env, bytes)).json();
  const hash = url.slice("/__asset/".length);
  assert.match(hash, /^[0-9a-f]{40}$/);

  // The bytes are in R2, under the content-addressed key, and NOT in KV.
  assert.ok(env.BUNDLES.store.has(W.ASSET_R2_PREFIX + hash), "the image is not in the bundle store");
  assert.equal(env.COMMENTS._store.has(W.ASSET_PREFIX + hash), false, "megabytes went into KV as well");

  // The row says what it is and how big, which is what a quota and a GC pass will read.
  const rows = await W.overlayFor(env, CTX).read("assets");
  assert.deepEqual(Object.keys(rows), [hash]);
  assert.equal(rows[hash].ct, "image/png");
  assert.equal(rows[hash].bytes, bytes.byteLength);
  assert.match(rows[hash].at, /^\d{4}-\d\d-\d\dT/);

  // And it serves, correctly typed and immutable.
  const res = await serve(env, hash);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.match(res.headers.get("cache-control"), /immutable/);
  assert.equal((await res.arrayBuffer()).byteLength, bytes.byteLength);
});

test("no refCount is written, because nothing maintains one", () => {
  // Stated as a test because the item asks for a refCount and this deliberately does not
  // ship one: the pass that would keep it correct is its own item, and a counter nobody
  // increments is worse than none — the first thing that reads it deletes an image
  // somebody is looking at.
  const env = { COMMENTS: memKv(), BUNDLES: memR2(), TENANTS: namespace() };
  return upload(env, png(64)).then((r) => r.json()).then(async ({ url }) => {
    const rows = await W.overlayFor(env, CTX).read("assets");
    assert.equal("refCount" in rows[url.slice("/__asset/".length)], false);
  });
});

// ── the straddle ─────────────────────────────────────────────────────────────

test("AN IMAGE PASTED BEFORE THIS STILL RENDERS, from KV", async () => {
  // The one that matters on the live instances today. Nothing migrates; the board keeps
  // working; the fallback drains as boards are re-pasted.
  const bytes = png(1024);
  const kv = memKv();
  const hash = "a".repeat(40);
  await kv.put(W.ASSET_PREFIX + hash, bytes, { metadata: { ct: "image/webp" } });
  const env = { COMMENTS: kv, BUNDLES: memR2() };
  const res = await serve(env, hash);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/webp", "the stored type was lost on the way out");
});

test("R2 is asked first, so a re-pasted image stops costing a KV read", async () => {
  const bytes = png(512);
  const env = { COMMENTS: memKv(), BUNDLES: memR2(), TENANTS: namespace() };
  const { url } = await (await upload(env, bytes)).json();
  const hash = url.slice("/__asset/".length);
  let kvReads = 0;
  const realGet = env.COMMENTS.getWithMetadata.bind(env.COMMENTS);
  env.COMMENTS.getWithMetadata = (k) => { kvReads++; return realGet(k); };
  assert.equal((await serve(env, hash)).status, 200);
  assert.equal(kvReads, 0, "the R2 hit still went on to read KV");
});

test("EVERY INSTANCE TODAY STILL WRITES TO KV, because the switch is the workspace store", async () => {
  // The one that decides whether this is safe to deploy. Every live instance binds R2
  // already; if that were the switch, every new pasted image would leave KV today — and
  // leave the nightly KV backup with it, while the store backup walks `blobs/` and would
  // not see `assets/` either. New images would be in neither copy, silently.
  const env = { COMMENTS: memKv(), BUNDLES: memR2() };
  const bytes = png(256);
  const { url } = await (await upload(env, bytes)).json();
  const hash = url.slice("/__asset/".length);
  assert.ok(env.COMMENTS._store.has(W.ASSET_PREFIX + hash), "the image left KV without the workspace store");
  assert.equal(env.BUNDLES.store.size, 0, "the bytes went to R2 on an instance whose backups do not cover it");
  assert.equal((await serve(env, hash)).status, 200);
});

test("with no bundle store at all it is exactly what it always was", async () => {
  // A raw or offline build. The bytes go to KV under the same key, with the same metadata.
  const env = { COMMENTS: memKv() };
  const bytes = png(256);
  const { url } = await (await upload(env, bytes)).json();
  const hash = url.slice("/__asset/".length);
  assert.ok(env.COMMENTS._store.has(W.ASSET_PREFIX + hash));
  const res = await serve(env, hash);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
});

// ── the rules that did not move ──────────────────────────────────────────────

test("a re-paste of the same image writes nothing twice", async () => {
  const env = { COMMENTS: memKv(), BUNDLES: memR2(), TENANTS: namespace() };
  const bytes = png(4096);
  await upload(env, bytes);
  let puts = 0;
  const realPut = env.BUNDLES.put.bind(env.BUNDLES);
  env.BUNDLES.put = (...a) => { puts++; return realPut(...a); };
  await upload(env, bytes);
  assert.equal(puts, 0, "content addressing stopped working — the same image was stored twice");
  assert.equal(env.BUNDLES.store.size, 1);
});

test("the ceiling and the type check are unchanged", async () => {
  const env = { COMMENTS: memKv(), BUNDLES: memR2(), TENANTS: namespace() };
  assert.equal((await upload(env, png(W.ASSET_MAX_BYTES + 1))).status, 413);
  assert.equal((await upload(env, png(0))).status, 413);
  assert.equal((await upload(env, png(64), "application/pdf")).status, 415);
  assert.equal((await upload(env, png(64), "text/html")).status, 415);
  assert.equal(env.BUNDLES.store.size, 0, "a refused upload stored something");
});

test("a hash that is not a hash is refused, and a missing one is a 404", async () => {
  const env = { COMMENTS: memKv(), BUNDLES: memR2(), TENANTS: namespace() };
  assert.equal((await serve(env, "../secrets")).status, 400);
  assert.equal((await serve(env, "z".repeat(40))).status, 400);
  assert.equal((await serve(env, "b".repeat(40))).status, 404);
});

test("no store at all answers the same refusal it always did", async () => {
  const res = await W.assetApi(CTX, new Request("https://x.test/__asset/" + "a".repeat(40)),
    new URL("https://x.test/__asset/" + "a".repeat(40)), {});
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, "no-kv-binding");
});
