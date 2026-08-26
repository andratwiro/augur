// Deleting a workspace, without taking bytes another workspace is serving.
//
// `E-gdpr-delete-tenant`. Two operations, deliberately separate, and the separation IS the
// safety property rather than a scheduling convenience.
//
// A workspace's own R2 prefix and its own object's storage are bounded to it and neither
// can reach a neighbour. Its BLOBS are not: `blobs/<sha256>` is one object however many
// workspaces published the same file, so "delete the blobs this workspace referenced" is
// wrong in the one direction that matters. Knowing a blob is orphaned means reading every
// remaining manifest and every retained version of every workspace — a full-bucket walk.
// Doing that inside a delete request means either a slow delete or a partial scan, and a
// partial scan concludes that a blob it did not manage to read about is unreferenced.
//
// So the delete records what it MIGHT have orphaned, and the sweep decides later with the
// whole picture — and refuses to conclude anything from an incomplete one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { __testables as W } from "../src/_worker.js";
import { TenantStore } from "../src/tenant-do.js";

function memR2(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async head(k) { return store.has(k) ? { etag: "e" } : null; },
    async get(k) { const o = store.get(k); return o == null ? null : { body: o, etag: "e", text: async () => o }; },
    async put(k, v) { store.set(k, typeof v === "string" ? v : JSON.stringify(v)); },
    async delete(k) { store.delete(k); },
    async list({ prefix = "", delimiter, cursor } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      if (delimiter) {
        const prefixes = new Set();
        for (const k of keys) {
          const rest = k.slice(prefix.length);
          const at = rest.indexOf(delimiter);
          if (at >= 0) prefixes.add(prefix + rest.slice(0, at + 1));
        }
        return { objects: [], delimitedPrefixes: [...prefixes], truncated: false };
      }
      return { objects: keys.map((key) => ({ key })), truncated: false, cursor };
    },
  };
}
function namespace() {
  const objects = new Map();
  return {
    objects,
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

const SHARED = "5".repeat(64);   // published by both workspaces
const ONLY_A = "a".repeat(64);   // only ever referenced by A
const ONLY_B = "b".repeat(64);
const HISTORIC_A = "9".repeat(64); // referenced only by an OLD version of A

const manifest = (id, hashes, version = 3) => JSON.stringify({
  id, version, format: 1,
  files: Object.fromEntries(hashes.map((h, i) => [`/p/${i}.html`, { h, ct: "text/html", s: 10 }])),
  routing: { publicPrefixes: ["/p/"], unitSources: { "/p/": { sha: "abc", dirty: false } } },
  publishedAt: "2026-08-20T00:00:00.000Z",
});

/** Two workspaces, one shared blob, one blob each, and one only in A's history. */
function twoWorkspaces() {
  return {
    BUNDLES: memR2({
      "spaces/a/manifest.json": manifest("a", [SHARED, ONLY_A]),
      "spaces/a/versions/1.json": manifest("a", [HISTORIC_A], 1),
      "spaces/a/versions/3.json": manifest("a", [SHARED, ONLY_A]),
      "spaces/b/manifest.json": manifest("b", [SHARED, ONLY_B]),
      "spaces/b/versions/3.json": manifest("b", [SHARED, ONLY_B]),
      [`blobs/${SHARED}`]: "shared",
      [`blobs/${ONLY_A}`]: "a-only",
      [`blobs/${ONLY_B}`]: "b-only",
      [`blobs/${HISTORIC_A}`]: "a-history",
    }),
    TENANTS: namespace(),
  };
}
const ctxFor = (id) => Object.freeze({ tenantId: id });

// ── the drill the item asks for ──────────────────────────────────────────────

test("DELETING ONE WORKSPACE LEAVES THE OTHER'S CONTENT ENTIRELY ALONE", async () => {
  const env = twoWorkspaces();
  const ns = env.TENANTS;
  await ns.get(ns.idFromName("a")).store.provision({ workspaceId: "a", adminEmail: "a@x.test" });
  await ns.get(ns.idFromName("b")).store.provision({ workspaceId: "b", adminEmail: "b@x.test" });

  const r = await W.deleteWorkspace(ctxFor("a"), env, { confirm: "a", dryRun: false });
  assert.equal(r.ok, true);

  // A's published prefix is gone, every object of it.
  assert.deepEqual([...env.BUNDLES.store.keys()].filter((k) => k.startsWith("spaces/a/")), []);
  // B's is untouched.
  assert.ok(env.BUNDLES.store.has("spaces/b/manifest.json"));
  assert.ok(env.BUNDLES.store.has("spaces/b/versions/3.json"));

  // A's object has no storage left; B's is exactly as it was.
  assert.deepEqual(ns.get(ns.idFromName("a")).store.status(), { provisioned: false, hasStoredData: false });
  assert.equal(ns.get(ns.idFromName("b")).store.status().provisioned, true);

  // ⛔ AND NOT ONE BLOB HAS BEEN TOUCHED YET. This is the whole design: the delete does not
  // know what is orphaned, and acting as if it did is how a shared blob disappears.
  for (const h of [SHARED, ONLY_A, ONLY_B, HISTORIC_A]) {
    assert.ok(env.BUNDLES.store.has(`blobs/${h}`), `blobs/${h.slice(0, 8)} was deleted by the delete`);
  }
  assert.deepEqual([...r.maybeOrphaned].sort(), [SHARED, ONLY_A, HISTORIC_A].sort());
});

test("THE SWEEP RECLAIMS WHAT A IS GONE FROM, AND KEEPS WHAT B STILL SERVES", async () => {
  const env = twoWorkspaces();
  await W.deleteWorkspace(ctxFor("a"), env, { confirm: "a", dryRun: false });

  const gc = await W.blobGc(env, { dryRun: false });
  assert.equal(gc.ok, true);
  assert.equal(gc.reclaimed, 2, `reclaimed ${gc.reclaimed}: ${gc.keys}`);

  assert.ok(env.BUNDLES.store.has(`blobs/${SHARED}`), "the SHARED blob was reclaimed — B is now serving a hole");
  assert.ok(env.BUNDLES.store.has(`blobs/${ONLY_B}`));
  assert.equal(env.BUNDLES.store.has(`blobs/${ONLY_A}`), false, "A's own blob was not reclaimed");
  assert.equal(env.BUNDLES.store.has(`blobs/${HISTORIC_A}`), false,
    "a blob only A's history referenced was not reclaimed");
});

test("a blob only a RETAINED VERSION references is not an orphan", async () => {
  // Rollback reaches any past publish, so a blob no live manifest names is still load
  // bearing. Reading only live manifests would silently make every rollback point beyond
  // the current one unrecoverable.
  const env = twoWorkspaces();
  const gc = await W.blobGc(env, { dryRun: true });
  assert.equal(gc.ok, true);
  assert.equal(gc.reclaimed, 0, `nothing should be orphaned yet, got ${gc.keys}`);
  assert.equal(gc.referenced, 4);
});

// ── the refusals ─────────────────────────────────────────────────────────────

test("A SWEEP THAT COULD NOT LOOK REFUSES, rather than reporting everything as orphaned", async () => {
  // The single worst outcome available here, and the one this must never reach.
  const env = twoWorkspaces();
  const real = env.BUNDLES.get.bind(env.BUNDLES);
  env.BUNDLES.get = async (k) => (k.startsWith("spaces/") ? null : real(k));
  const gc = await W.blobGc(env, { dryRun: true });
  assert.equal(gc.ok, false);
  assert.equal(gc.reason, "no-manifests-read");
  env.BUNDLES.get = real;
  assert.equal(env.BUNDLES.store.size, 9, "a refused sweep deleted something");
});

test("a truncated listing it cannot walk is also a refusal", async () => {
  const env = twoWorkspaces();
  const real = env.BUNDLES.list.bind(env.BUNDLES);
  env.BUNDLES.list = async (opts) => {
    const page = await real(opts);
    // Truncated with no cursor to continue from: the picture cannot be completed.
    return (opts.prefix || "").startsWith("blobs/") ? { ...page, truncated: true, cursor: null } : page;
  };
  const gc = await W.blobGc(env, { dryRun: false });
  assert.equal(gc.ok, false);
  assert.equal(gc.reason, "incomplete-listing");
  assert.ok(env.BUNDLES.store.has(`blobs/${SHARED}`));
});

test("A DELETE WITHOUT THE WORKSPACE'S OWN NAME IS A DRY RUN, and deletes nothing", async () => {
  // Not ceremony. A star-scope token can already overwrite everything a workspace has
  // published and rollback undoes that; this is the one verb no rollback reaches.
  const env = twoWorkspaces();
  const dry = await W.deleteWorkspace(ctxFor("a"), env, {});
  assert.equal(dry.ok, true);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.objects, 3, "the dry run did not count what it would remove");
  assert.equal(dry.maybeOrphaned, 3);
  assert.ok(env.BUNDLES.store.has("spaces/a/manifest.json"), "a dry run deleted something");

  const wrong = await W.deleteWorkspace(ctxFor("a"), env, { confirm: "b", dryRun: false });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, "confirm-mismatch");
  assert.equal(wrong.expected, "a");
  assert.ok(env.BUNDLES.store.has("spaces/a/manifest.json"));
});

test("deleting a workspace that was never provisioned does not create one first", async () => {
  const env = twoWorkspaces();
  const ns = env.TENANTS;
  const r = await W.deleteWorkspace(ctxFor("never-existed"), env, { confirm: "never-existed", dryRun: false });
  assert.equal(r.ok, true);
  assert.equal(r.objects, 0);
  assert.deepEqual(ns.get(ns.idFromName("never-existed")).store.status(),
    { provisioned: false, hasStoredData: false });
});

test("with no store at all it refuses rather than reporting a clean delete", async () => {
  assert.deepEqual(await W.deleteWorkspace(ctxFor("a"), {}, { confirm: "a", dryRun: false }),
    { ok: false, reason: "no-store" });
  assert.deepEqual(await W.blobGc({}, {}), { ok: false, reason: "no-store" });
});

test("a store with no spaces left DOES reclaim, because that is what deleting the last one means", async () => {
  // Worth pinning rather than hedging. Zero spaces after a delete is the honest end state,
  // and refusing there would leave the bytes of a deleted workspace paid for forever.
  const env = { BUNDLES: memR2({ [`blobs/${SHARED}`]: "shared" }) };
  const gc = await W.blobGc(env, { dryRun: false });
  assert.equal(gc.ok, true);
  assert.equal(gc.spaces, 0);
  assert.equal(gc.reclaimed, 1);
  assert.equal(env.BUNDLES.store.size, 0);
});

test("BUT A SPACE LISTING IT COULD NOT COMPLETE IS A REFUSAL", async () => {
  // The dangerous twin of the test above, and the reason it is safe. "No spaces" and "I
  // could not read the spaces" produce identical answers from a listing, and only one of
  // them means every blob is orphaned.
  const env = twoWorkspaces();
  const real = env.BUNDLES.list.bind(env.BUNDLES);
  env.BUNDLES.list = async (opts) => (opts.delimiter
    ? { objects: [], delimitedPrefixes: [], truncated: true, cursor: null }
    : real(opts));
  const gc = await W.blobGc(env, { dryRun: false });
  assert.equal(gc.ok, false);
  assert.equal(gc.reason, "incomplete-listing");
  assert.ok(env.BUNDLES.store.has(`blobs/${SHARED}`), "an unreadable listing reclaimed live blobs");

  const del = await W.deleteWorkspace(ctxFor("a"), env, { confirm: "a", dryRun: false });
  assert.equal(del.ok, false);
  assert.equal(del.reason, "incomplete-listing");
  assert.ok(env.BUNDLES.store.has("spaces/a/manifest.json"), "a partial listing deleted a workspace");
});
