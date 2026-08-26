// What a workspace says about itself, and what it must never say.
//
// `B-tenant-status-payload`. The shape is FORCED rather than chosen: the control plane is
// bound to nothing but its own signup store, and its own test fails the build if that
// changes. So it cannot list a bucket or scan a namespace to compute any of this — the
// workspace computes its own facts and hands them over.
//
// COUNTS AND SCALARS ONLY. This payload is read by an operator-facing isolate, and a
// comment body has no business being anywhere near one. Not even the address a publish
// token is labelled with: it is mapped to a display name exactly the way the public build
// stamp maps it, and for the same reason.
//
// AND IT MUST NOT CREATE A WORKSPACE. `ns.get(ns.idFromName(name))` always hands back a
// live stub, and a Durable Object comes into existence on its first WRITE — so asking for
// the status of a typo or a released slug must read and write nothing, rather than
// springing an empty workspace into being and then reporting it as real.
//
// RUN UNDER REAL WORKERD, and it found something the stub could not. `hasStoredData` first
// asked "does this object have any table at all", which answers TRUE for an object nobody
// has ever written to: a DO's storage carries bookkeeping of its own (`_cf_*` in
// production, `__miniflare_do_name` under a local run). It counts OUR tables now. The same
// run confirmed `doStoredBytes` is null there — `dbstat` is a compile-time SQLite option
// workerd does not carry — which is why the field distinguishes "cannot tell" from zero.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { __testables as W } from "../src/_worker.js";
import { TenantStore } from "../src/tenant-do.js";
import { PLANS } from "../src/tenant-quotas.mjs";

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
function memR2(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    reads: 0,
    async head(k) { return store.has(k) ? { etag: "e" } : null; },
    async get(k) { this.reads++; const o = store.get(k); return o ? { body: o, etag: "e", text: async () => o } : null; },
    async put(k, v) { store.set(k, typeof v === "string" ? v : JSON.stringify(v)); },
    async delete(k) { store.delete(k); },
    // `loadManifests` lists with a delimiter to discover space ids, so the stub has to
    // answer with the prefixes rather than only the objects.
    async list({ prefix = "", delimiter } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix));
      if (!delimiter) return { objects: keys.map((key) => ({ key })), truncated: false };
      const prefixes = new Set();
      for (const k of keys) {
        const rest = k.slice(prefix.length);
        const at = rest.indexOf(delimiter);
        if (at >= 0) prefixes.add(prefix + rest.slice(0, at + 1));
      }
      return { objects: [], delimitedPrefixes: [...prefixes], truncated: false };
    },
  };
}
function namespace() {
  const objects = new Map();
  const created = new Set();
  const ns = {
    created,
    idFromName(name) { return { name }; },
    get(id) {
      if (!objects.has(id.name)) {
        const db = new DatabaseSync(":memory:");
        const sql = {
          exec(stmt, ...params) {
            // A Durable Object comes into existence on its first WRITE. Recording which
            // statements are writes is how the "status must not create one" test can tell.
            if (!/^\s*SELECT/i.test(stmt)) created.add(id.name);
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
  return ns;
}

const ADMIN = { email: "boss@example.test", name: "Boss Person", role: "admin" };
const ctxFor = (id, users = [ADMIN]) => Object.freeze({ ...W.applyInstance({ users }), tenantId: id });

/** A published manifest with a header that already carries its byte sum. */
const manifest = (over = {}) => ({
  id: "alpha", version: 7, format: 1,
  source: { sha: "abc123", dirty: false },
  bytesReferenced: 1_940_000,
  files: {
    "/toolkit/w/index.html": { h: "a".repeat(64), ct: "text/html", s: 1_000_000 },
    "/toolkit/w/again.html": { h: "a".repeat(64), ct: "text/html", s: 1_000_000 }, // same blob twice
    "/toolkit/x/index.html": { h: "b".repeat(64), ct: "text/html", s: 940_000 },
  },
  routing: {
    publicPrefixes: ["/toolkit/w/", "/toolkit/x/"],
    unitSources: { "/toolkit/w/": { sha: "abc123", dirty: false }, "/toolkit/x/": { sha: "abc123", dirty: true } },
  },
  publishedAt: "2026-08-20T10:00:00.000Z",
  publishedBy: ADMIN.email,
  ...over,
});

const envWith = (id = "acme") => ({
  COMMENTS: memKv(),
  BUNDLES: memR2({ "spaces/alpha/manifest.json": JSON.stringify(manifest()) }),
  GV_ASSET_SOURCE: "r2",
  TENANTS: namespace(),
});

// ── the payload ──────────────────────────────────────────────────────────────

test("EVERY NUMBER MATCHES AN INDEPENDENT MEASUREMENT", async () => {
  // A distinct workspace id per test: the manifest view is cached per workspace for a
  // tick, and two tests sharing an id would share a view.
  const env = envWith();
  const ctx = ctxFor("ws-numbers");
  const ns = env.TENANTS;
  await ns.get(ns.idFromName("ws-numbers")).store.provision({ workspaceId: "ws-numbers", adminEmail: ADMIN.email });

  const s = await W.workspaceStatus(ctx, env);
  assert.equal(s.workspace, "ws-numbers");
  assert.equal(s.provisioned, true);
  assert.equal(s.members, 1, "the member count does not match the roster");
  // `prototypes` is the unitSources count, and one of the two came from a tree that was
  // never committed — the only unreproducible state the system has.
  assert.equal(s.prototypes, 2);
  assert.equal(s.spaces.alpha.prototypesFromDirtyTree, 1);
  assert.equal(s.versions, 7);
  // DISTINCT blobs: the same hash referenced twice is one payment, not two.
  assert.equal(s.bytesReferenced, 1_940_000);
  assert.equal(s.plan, "free");
  assert.equal(s.quotas.editorSeatLimit, PLANS.free.editorSeatLimit);
  assert.equal(s.lastPublish.version, 7);
  assert.equal(s.lastPublish.dirty, false);
  assert.equal(s.lastPublish.sha, "abc123");
});

test("NO CUSTOMER CONTENT IS IN IT — not a comment, not a board label, not an address", async () => {
  const env = envWith();
  const ctx = ctxFor("ws-content");
  const ns = env.TENANTS;
  const stub = ns.get(ns.idFromName("ws-content"));
  await stub.store.provision({ workspaceId: "ws-content", adminEmail: ADMIN.email });
  // Something of every kind that must not travel.
  const store = W.overlayFor(env, ctx);
  await store.set("comments", "", "/p/", [{ id: "t", messages: [{ author: "Ada", body: "SECRET-COMMENT-BODY" }] }]);
  await store.set("boards", "", "/b/", { nodes: [{ id: "n", text: "SECRET-BOARD-LABEL" }] });

  const serialized = JSON.stringify(await W.workspaceStatus(ctx, env));
  for (const secret of ["SECRET-COMMENT-BODY", "SECRET-BOARD-LABEL", ADMIN.email, "@example.test"]) {
    assert.equal(serialized.includes(secret), false, `the payload carries ${secret}`);
  }
  // But it does say HOW MANY, which is the whole point.
  const s = JSON.parse(serialized);
  assert.equal(s.threads, 1);
  assert.equal(s.boards, 1);
  // And who published, by name rather than by address.
  assert.equal(s.lastPublish.by, "Boss Person");
});

test("a publisher nobody on the roster answers to is not named by their address either", async () => {
  const env = envWith();
  env.BUNDLES.store.set("spaces/alpha/manifest.json", JSON.stringify(manifest({ publishedBy: "ci-runner@somewhere.test" })));
  const s = await W.workspaceStatus(ctxFor("ws-publisher"), env);
  assert.equal(s.lastPublish.by, "ci-runner");
  assert.equal(JSON.stringify(s).includes("somewhere.test"), false);
});

// ── the trap ─────────────────────────────────────────────────────────────────

test("STATUS ON A SLUG NOBODY PROVISIONED CREATES NOTHING", async () => {
  // The trap the item names. A live stub is handed back for any name, and a Durable Object
  // comes into existence on its first write — so a status call that applied the schema
  // would spring an empty workspace into being and then report it as real.
  const env = envWith();
  const s = await W.workspaceStatus(ctxFor("never-provisioned"), env);
  assert.equal(s.provisioned, false);
  assert.equal(s.hasStoredData, false, "the object was written to");
  assert.equal(env.TENANTS.created.has("never-provisioned"), false,
    "asking about a typo created a workspace");
});

test("a provisioned workspace reports hasStoredData, an empty one does not", async () => {
  const env = envWith();
  const ns = env.TENANTS;
  assert.equal((await W.workspaceStatus(ctxFor("fresh"), env)).hasStoredData, false);
  await ns.get(ns.idFromName("fresh")).store.provision({ workspaceId: "fresh", adminEmail: ADMIN.email });
  const after = await W.workspaceStatus(ctxFor("fresh"), env);
  assert.equal(after.hasStoredData, true);
  assert.equal(after.provisioned, true);
});

test("an instance with no workspace object still answers, with what it can measure", async () => {
  // Every instance today. The published side is real; the object side says it is absent
  // rather than reporting zeros that would read as an empty workspace.
  const env = { COMMENTS: memKv(), BUNDLES: memR2({ "spaces/alpha/manifest.json": JSON.stringify(manifest()) }), GV_ASSET_SOURCE: "r2" };
  const s = await W.workspaceStatus(ctxFor("ws-nostore"), env);
  assert.equal(s.unavailable, true);
  assert.equal(s.provisioned, false);
  assert.equal(s.bytesReferenced, 1_940_000, "the published facts should still be there");
  assert.equal(s.prototypes, 2);
});

// ── the byte sum is precomputed ──────────────────────────────────────────────

test("THE BYTE SUM COMES FROM THE MANIFEST HEADER, not from re-reading the file list", async () => {
  // A status handler that re-summed a file list would reproduce the CPU failure the etag
  // guard in loadManifests exists because of, with the whole fleet as the multiplier. So:
  // if the header disagrees with the files, the header is what is reported.
  const env = envWith();
  env.BUNDLES.store.set("spaces/alpha/manifest.json", JSON.stringify(manifest({ bytesReferenced: 42 })));
  const s = await W.workspaceStatus(ctxFor("ws-header"), env);
  assert.equal(s.bytesReferenced, 42, "the file list was re-summed instead of reading the header");
});

test("a publish writes the byte sum, counting each distinct blob once", async () => {
  // The other end of it. Two files sharing a hash are one payment.
  const kv = memKv();
  await kv.put("publish:tokens", JSON.stringify({ [await W.tokenFor("pub:star")]: { space: "*", label: "ci" } }));
  // The blobs have to already be in the store: commit spot-checks that what a manifest
  // references is actually there, which is a guard worth not defeating with a stub.
  const r2 = memR2({ ["blobs/" + "c".repeat(64)]: "cc", ["blobs/" + "d".repeat(64)]: "dd" });
  const env = { COMMENTS: kv, BUNDLES: r2, PUBLISH_BOOTSTRAP_TOKEN: "tok" };
  const body = {
    id: "alpha", format: 1,
    space: { id: "alpha", default: true },
    files: {
      "/p/a.html": { h: "c".repeat(64), ct: "text/html", s: 300 },
      "/p/b.html": { h: "c".repeat(64), ct: "text/html", s: 300 },
      "/p/c.html": { h: "d".repeat(64), ct: "text/html", s: 700 },
    },
    routing: { publicPrefixes: ["/p/"], versionMap: {} },
  };
  const url = new URL("https://x.test/__publish/alpha/commit");
  const res = await W.publishApi(ctxFor("ws-commit"), new Request(url, {
    method: "POST", headers: { Authorization: "Bearer tok", "content-type": "application/json" },
    body: JSON.stringify(body),
  }), url, env);
  assert.equal(res.status, 200, await res.text());
  const stored = JSON.parse(r2.store.get("spaces/alpha/manifest.json"));
  assert.equal(stored.bytesReferenced, 1000, "300 + 300 + 700 would be 1300; the shared blob is one payment");
});

// ── the activity clock ───────────────────────────────────────────────────────

test("LAST ACTIVITY MOVES ON A PUBLISH, which is the case the per-person clock misses", async () => {
  // `augur publish` carries a bearer token and never touches `/__me`, so a team shipping
  // daily from CI reads as months idle on the browser-session stamp — and a dormancy sweep
  // keyed on that would suspend a workspace somebody uses every day.
  const ns = namespace();
  const stub = ns.get(ns.idFromName("ws-activity"));
  await stub.store.provision({ workspaceId: "ws-activity", adminEmail: ADMIN.email });
  assert.equal(stub.store.status().lastActivityAt, null);

  W.touchWorkspaceActivity({ TENANTS: ns }, ctxFor("ws-activity"), null);
  await new Promise((r) => setTimeout(r, 0));
  assert.match(stub.store.status().lastActivityAt, /^\d{4}-\d\d-\d\dT/);
});

test("it is throttled, so a busy workspace does not write on every request", async () => {
  const ns = namespace();
  const stub = ns.get(ns.idFromName("ws-throttle"));
  await stub.store.provision({ workspaceId: "ws-throttle", adminEmail: ADMIN.email });
  const t0 = Date.parse("2026-08-20T10:00:00.000Z");
  assert.equal(stub.store.touchActivity(t0), true);
  assert.equal(stub.store.touchActivity(t0 + 60_000), false, "a write a minute later was not throttled");
  assert.equal(stub.store.touchActivity(t0 + 16 * 60_000), true, "the throttle never lets go");
  assert.equal(stub.store.status().lastActivityAt, new Date(t0 + 16 * 60_000).toISOString());
});

test("a failing activity write never breaks the thing that triggered it", async () => {
  // A status column is not worth failing a sign-in or a publish over.
  const dead = { idFromName: (n) => ({ name: n }), get: () => ({ fetch: () => Promise.reject(new Error("gone")) }) };
  assert.doesNotThrow(() => W.touchWorkspaceActivity({ TENANTS: dead }, ctxFor("ws-dead"), null));
  await new Promise((r) => setTimeout(r, 0));
});
