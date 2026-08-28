// Deleting a workspace, without taking bytes another workspace is serving.
//
// `E-gdpr-delete-tenant`. Two operations, deliberately separate, and the separation IS the
// safety property rather than a scheduling convenience.
//
// A workspace's own object storage is bounded to it and cannot reach a neighbour. Its
// published CONTENT is not bounded by anything in the key: `spaces/<spaceId>/…` names a
// SPACE, and a space id is not a workspace id. So which spaces an erasure may touch is a
// question the store cannot answer, and it is asked of the workspace itself.
//
// Its BLOBS are a third case: `blobs/<sha256>` is one object however many workspaces
// published the same file, so "delete the blobs this workspace referenced" is wrong in the
// one direction that matters. Knowing a blob is orphaned means reading every remaining
// manifest and every retained version of every workspace — a full-bucket walk. Doing that
// inside a delete request means either a slow delete or a partial scan, and a partial scan
// concludes that a blob it did not manage to read about is unreferenced.
//
// So the delete records what it MIGHT have orphaned, and the sweep decides later with the
// whole picture — and refuses to conclude anything from an incomplete one.
//
// ⚠️ THE FIXTURE'S NAMES ARE PART OF THE TEST. Every workspace id here differs from every
// space id, because the suite that covered this for months did not: it built a workspace
// "a" holding a space named "a", which is the single arrangement in which conflating the
// two ids is invisible. The filter matched by coincidence, the drill below passed, and the
// erasure deleted nothing on any deployment where the names differ — which is every real
// one. A fixture where the two ids can be confused is the thing that hid this.
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

// Two workspaces, and NOT ONE of their ids is the id of a space either of them published.
const ONE = "wk-4f21c8";   // holds the spaces `site` and `docs`
const TWO = "wk-9ab03e";   // holds the space `brand`

const SHARED = "5".repeat(64);     // published by a space of each workspace
const ONLY_SITE = "a".repeat(64);  // only ever referenced by ONE's `site`
const ONLY_DOCS = "d".repeat(64);  // only ever referenced by ONE's second space
const ONLY_BRAND = "b".repeat(64); // only ever referenced by TWO
const HISTORIC_SITE = "9".repeat(64); // referenced only by an OLD version of `site`
const ENGINE_BLOB = "e".repeat(64);   // the shared chrome bundle's

const manifest = (id, hashes, version = 3) => JSON.stringify({
  id, version, format: 1,
  files: Object.fromEntries(hashes.map((h, i) => [`/p/${i}.html`, { h, ct: "text/html", s: 10 }])),
  routing: { publicPrefixes: ["/p/"], unitSources: { "/p/": { sha: "abc", dirty: false } } },
  publishedAt: "2026-08-20T00:00:00.000Z",
});

/**
 * The live shape: two workspaces, three authored spaces between them, the shared `_engine`
 * pseudo-space, one blob both workspaces reference, one blob each, and one that only a
 * retained version still names.
 */
function twoWorkspaces() {
  return {
    BUNDLES: memR2({
      "spaces/site/manifest.json": manifest("site", [SHARED, ONLY_SITE]),
      "spaces/site/versions/1.json": manifest("site", [HISTORIC_SITE], 1),
      "spaces/site/versions/3.json": manifest("site", [SHARED, ONLY_SITE]),
      "spaces/docs/manifest.json": manifest("docs", [ONLY_DOCS], 2),
      "spaces/docs/versions/2.json": manifest("docs", [ONLY_DOCS], 2),
      "spaces/brand/manifest.json": manifest("brand", [SHARED, ONLY_BRAND]),
      "spaces/brand/versions/3.json": manifest("brand", [SHARED, ONLY_BRAND]),
      "spaces/_engine/manifest.json": manifest("_engine", [ENGINE_BLOB], 5),
      "spaces/_engine/versions/5.json": manifest("_engine", [ENGINE_BLOB], 5),
      [`blobs/${SHARED}`]: "shared",
      [`blobs/${ONLY_SITE}`]: "site-only",
      [`blobs/${ONLY_DOCS}`]: "docs-only",
      [`blobs/${ONLY_BRAND}`]: "brand-only",
      [`blobs/${HISTORIC_SITE}`]: "site-history",
      [`blobs/${ENGINE_BLOB}`]: "chrome",
    }),
    TENANTS: namespace(),
  };
}
const ctxFor = (id) => Object.freeze({ tenantId: id });

/**
 * Bring a workspace into being holding the spaces it has published.
 *
 * The ownership is written the way a real publish writes it — `nextPublishVersion`, the
 * counter every commit, rollback and prefix-removal goes through — rather than by poking a
 * table this test invented. If that stops being where a publish records itself, this
 * fixture stops being true and says so.
 */
async function workspaceHolding(env, id, spaces) {
  const ns = env.TENANTS;
  const st = ns.get(ns.idFromName(id)).store;
  await st.provision({ workspaceId: id, adminEmail: `admin@${id}.test` });
  for (const s of spaces) st.nextPublishVersion(s, 0);
  return st;
}

/**
 * Tombstone a workspace and put its purge date in the past, because an erasure now needs
 * the OBJECT'S own agreement that it is due — `purgeDue` in the worker. That is the second
 * key: the caller cannot forge the date, because the object wrote it.
 *
 * Every test below that erases has to come through here, which is the point. Before this
 * guard existed they all erased a live workspace on a `confirm` string the caller already
 * knew, and nothing in the suite noticed that was the whole authorisation.
 */
function tombstoneDue(env, id) {
  const ns = env.TENANTS;
  // graceMs 0 with a past `at` puts purge_after behind us without touching the clock.
  return ns.get(ns.idFromName(id)).store.deleteWorkspace("2026-01-01T00:00:00.000Z", 0);
}

const keysUnder = (env, prefix) => [...env.BUNDLES.store.keys()].filter((k) => k.startsWith(prefix));

// ── the drill the item asks for, on the shape a deployment actually has ──────

test("A WORKSPACE WHOSE ID IS NOT ANY OF ITS SPACE IDS IS ACTUALLY ERASED", async () => {
  // The whole bug in one assertion. The erasure used to select what to remove by matching
  // SPACE ids against the WORKSPACE id — a prefix no key in that bucket has ever carried —
  // so on every deployment where the two names differ it deleted zero objects, destroyed
  // the workspace object anyway, and answered ok. The control plane erases its own record
  // on that ok, so a right-to-erasure request completed with the record gone and the
  // content still being served, and nothing anywhere reported a problem.
  const env = twoWorkspaces();
  await workspaceHolding(env, ONE, ["site", "docs"]);
  await workspaceHolding(env, TWO, ["brand"]);
  tombstoneDue(env, ONE);

  const r = await W.deleteWorkspace(ctxFor(ONE), env, { confirm: ONE, dryRun: false });
  assert.equal(r.ok, true, `the erasure refused: ${r.reason}`);
  assert.equal(r.objects, 5, "the erasure reported removing a different number of objects than it should");

  // BOTH of its spaces are gone, every object of each.
  assert.deepEqual(keysUnder(env, "spaces/site/"), []);
  assert.deepEqual(keysUnder(env, "spaces/docs/"), []);

  // Its object has no storage left.
  assert.deepEqual(env.TENANTS.get(env.TENANTS.idFromName(ONE)).store.status(),
    { provisioned: false, hasStoredData: false });
});

test("THE NEIGHBOUR IS COMPLETELY INTACT — manifest, versions and blobs", async () => {
  // Deleting too much is far worse than deleting too little: this runs on real customer
  // content and a widened selection erases somebody else's. So the neighbour is asserted
  // object by object rather than by "the delete said 5".
  const env = twoWorkspaces();
  await workspaceHolding(env, ONE, ["site", "docs"]);
  await workspaceHolding(env, TWO, ["brand"]);
  tombstoneDue(env, ONE);

  const before = keysUnder(env, "spaces/brand/");
  const r = await W.deleteWorkspace(ctxFor(ONE), env, { confirm: ONE, dryRun: false });
  assert.equal(r.ok, true);

  assert.deepEqual(keysUnder(env, "spaces/brand/"), before, "the neighbour lost an object");
  assert.equal(env.BUNDLES.store.get("spaces/brand/manifest.json"), manifest("brand", [SHARED, ONLY_BRAND]),
    "the neighbour's live manifest was rewritten");
  assert.ok(env.BUNDLES.store.has("spaces/brand/versions/3.json"), "the neighbour's history was pruned");
  assert.ok(env.BUNDLES.store.has(`blobs/${ONLY_BRAND}`), "the neighbour's own blob was deleted");

  // And its object is exactly as it was, still holding the space it published.
  const neighbour = env.TENANTS.get(env.TENANTS.idFromName(TWO)).store;
  assert.equal(neighbour.status().provisioned, true);
  assert.deepEqual(neighbour.publishedSpaces().spaces, ["brand"]);
});

test("THE SHARED CHROME BUNDLE SURVIVES AN ERASURE, even though the workspace published it", async () => {
  // `spaces/_engine/` is one worker build's chrome serving every workspace on the
  // deployment, pushed by CI rather than authored by anybody. A workspace's own counter
  // therefore CLAIMS it — it went through the same commit path — and the erasure has to
  // decline it anyway. It survived before this only by the accident of the broken filter,
  // which is not a property anything was keeping.
  const env = twoWorkspaces();
  await workspaceHolding(env, ONE, ["site", "docs", "_engine"]);
  tombstoneDue(env, ONE);

  const r = await W.deleteWorkspace(ctxFor(ONE), env, { confirm: ONE, dryRun: false });
  assert.equal(r.ok, true);
  assert.ok(env.BUNDLES.store.has("spaces/_engine/manifest.json"), "the erasure took the deployment's chrome");
  assert.ok(env.BUNDLES.store.has("spaces/_engine/versions/5.json"));
  assert.equal(r.objects, 5, "_engine was counted as the workspace's own content");
});

test("⛔ AND NOT ONE BLOB HAS BEEN TOUCHED YET", async () => {
  // The whole design: the delete does not know what is orphaned, and acting as if it did
  // is how a blob another workspace is serving disappears.
  const env = twoWorkspaces();
  await workspaceHolding(env, ONE, ["site", "docs"]);
  await workspaceHolding(env, TWO, ["brand"]);
  tombstoneDue(env, ONE);

  const r = await W.deleteWorkspace(ctxFor(ONE), env, { confirm: ONE, dryRun: false });
  for (const h of [SHARED, ONLY_SITE, ONLY_DOCS, ONLY_BRAND, HISTORIC_SITE, ENGINE_BLOB]) {
    assert.ok(env.BUNDLES.store.has(`blobs/${h}`), `blobs/${h.slice(0, 8)} was deleted by the delete`);
  }
  assert.deepEqual([...r.maybeOrphaned].sort(),
    [SHARED, ONLY_SITE, ONLY_DOCS, HISTORIC_SITE].sort());
});

test("THE SWEEP RECLAIMS WHAT THE ERASED WORKSPACE IS GONE FROM, AND KEEPS WHAT THE NEIGHBOUR SERVES", async () => {
  const env = twoWorkspaces();
  await workspaceHolding(env, ONE, ["site", "docs"]);
  await workspaceHolding(env, TWO, ["brand"]);
  tombstoneDue(env, ONE);
  const del = await W.deleteWorkspace(ctxFor(ONE), env, { confirm: ONE, dryRun: false });
  assert.equal(del.ok, true);

  const gc = await W.blobGc(env, { dryRun: false });
  assert.equal(gc.ok, true);
  assert.equal(gc.reclaimed, 3, `reclaimed ${gc.reclaimed}: ${gc.keys}`);

  assert.ok(env.BUNDLES.store.has(`blobs/${SHARED}`),
    "the SHARED blob was reclaimed — the neighbour is now serving a hole");
  assert.ok(env.BUNDLES.store.has(`blobs/${ONLY_BRAND}`));
  assert.ok(env.BUNDLES.store.has(`blobs/${ENGINE_BLOB}`), "the chrome bundle's blob was reclaimed");
  assert.equal(env.BUNDLES.store.has(`blobs/${ONLY_SITE}`), false, "the erased workspace's own blob was not reclaimed");
  assert.equal(env.BUNDLES.store.has(`blobs/${ONLY_DOCS}`), false,
    "the erased workspace's second space's blob was not reclaimed");
  assert.equal(env.BUNDLES.store.has(`blobs/${HISTORIC_SITE}`), false,
    "a blob only the erased workspace's history referenced was not reclaimed");
});

test("a blob only a RETAINED VERSION references is not an orphan", async () => {
  // Rollback reaches any past publish, so a blob no live manifest names is still load
  // bearing. Reading only live manifests would silently make every rollback point beyond
  // the current one unrecoverable.
  const env = twoWorkspaces();
  const gc = await W.blobGc(env, { dryRun: true });
  assert.equal(gc.ok, true);
  assert.equal(gc.reclaimed, 0, `nothing should be orphaned yet, got ${gc.keys}`);
  assert.equal(gc.referenced, 6);
});

// ── where ownership comes from, and what happens when it cannot be had ───────

test("A DRY RUN STILL SAYS WHAT IT WOULD ERASE, and erases nothing", async () => {
  // The number that reads as zero on the broken filter. "What would this erase" has to
  // stay askable before the date arrives — it is how an operator checks the blast radius
  // of a delete they are considering.
  const env = twoWorkspaces();
  await workspaceHolding(env, ONE, ["site", "docs"]);
  await workspaceHolding(env, TWO, ["brand"]);

  const dry = await W.deleteWorkspace(ctxFor(ONE), env, {});
  assert.equal(dry.ok, true);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.objects, 5, "the dry run did not count what it would remove");
  assert.equal(dry.maybeOrphaned, 4);
  assert.deepEqual(dry.spaces, ["docs", "site"], "the dry run did not name the spaces it would erase");
  assert.equal(env.BUNDLES.store.size, 15, "a dry run deleted something");
});

test("WITH NO WORKSPACE BINDING AT ALL every authored space is the one workspace's", async () => {
  // Not an oversight and not a widening. A deployment with no workspace objects resolves
  // exactly one workspace — the id its own build stamped — so an unprefixed key belongs to
  // it by construction, the same reading `kvWorkspaceSegment`'s `legacyIsOurs` makes of an
  // unprefixed KV key. There is no neighbour for the selection to reach.
  //
  // `_engine` is still declined: it is the deployment's chrome, not the workspace's
  // content, and a self-hoster erasing their content should not blank their own site shell.
  const env = twoWorkspaces();
  delete env.TENANTS;
  const r = await W.deleteWorkspace(ctxFor(ONE), env, { confirm: ONE, dryRun: false });
  assert.equal(r.ok, true);
  assert.equal(r.ownership, "single-workspace-deployment");
  assert.deepEqual(keysUnder(env, "spaces/site/"), []);
  assert.deepEqual(keysUnder(env, "spaces/docs/"), []);
  assert.deepEqual(keysUnder(env, "spaces/brand/"), []);
  assert.ok(env.BUNDLES.store.has("spaces/_engine/manifest.json"));
  assert.deepEqual(r.store, { skipped: "no-object" });
});

test("A WORKSPACE THAT CAN ACCOUNT FOR NOTHING IS REFUSED, not reported as a clean erasure", async () => {
  // The exact shape the bug wore: a store holding authored content, a workspace that
  // claims none of it, and an answer of `ok: true, objects: 0`. It cannot be told apart
  // from "this workspace published nothing" while the keys carry no workspace segment, and
  // the two need opposite answers — so it refuses, and the caller's own erasure stalls
  // loudly instead of completing on a fiction.
  //
  // ⏳ This retires itself. Once the store carries a workspace segment, a workspace that
  // published nothing has an empty prefix, there is nothing unattributable in it, and this
  // branch is unreachable.
  const env = twoWorkspaces();
  await workspaceHolding(env, ONE, []);
  await workspaceHolding(env, TWO, ["brand"]);
  tombstoneDue(env, ONE);

  const r = await W.deleteWorkspace(ctxFor(ONE), env, { confirm: ONE, dryRun: false });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "nothing-attributable");
  assert.equal(r.unattributed, 3, "the refusal did not say how much it could not account for");
  assert.equal(env.BUNDLES.store.size, 15, "a refused erasure deleted something");
  // And the object is still there: a refusal must not leave half an erasure behind.
  assert.equal(env.TENANTS.get(env.TENANTS.idFromName(ONE)).store.status().hasStoredData, true);
});

test("a workspace with nothing to erase and a store with nothing in it is a clean zero", async () => {
  // The twin of the test above, and the reason it is safe to refuse there. Nothing to
  // account for is not the same as failing to account for something.
  const env = { BUNDLES: memR2({}), TENANTS: namespace() };
  await workspaceHolding(env, ONE, []);
  tombstoneDue(env, ONE);
  const r = await W.deleteWorkspace(ctxFor(ONE), env, { confirm: ONE, dryRun: false });
  assert.equal(r.ok, true);
  assert.equal(r.objects, 0);
  assert.equal(r.unattributed, 0);
});

test("AN OWNERSHIP RECORD THAT CANNOT BE READ IS A REFUSAL, NOT AN EMPTY SELECTION", async () => {
  // Same asymmetry the tombstone guard makes, for the same reason: a transient error must
  // not read as "this workspace owns nothing", because that answer erases nothing and
  // reports success. The dangerous direction is the one that completes.
  const env = twoWorkspaces();
  await workspaceHolding(env, ONE, ["site", "docs"]);
  tombstoneDue(env, ONE);

  const ns = env.TENANTS;
  const realGet = ns.get.bind(ns);
  ns.get = (id) => {
    const s = realGet(id);
    return {
      ...s,
      fetch: async (u, init) => {
        if (String(u).endsWith("/publish-spaces")) throw new Error("workspace unreachable");
        return s.fetch(u, init);
      },
    };
  };

  const r = await W.deleteWorkspace(ctxFor(ONE), env, { confirm: ONE, dryRun: false });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "ownership-unreadable");
  assert.equal(env.BUNDLES.store.size, 15, "an unreadable ownership record let an erasure through");
});

// ── the refusals that were already here ──────────────────────────────────────

test("A SWEEP THAT COULD NOT LOOK REFUSES, rather than reporting everything as orphaned", async () => {
  // The single worst outcome available here, and the one this must never reach.
  const env = twoWorkspaces();
  const real = env.BUNDLES.get.bind(env.BUNDLES);
  env.BUNDLES.get = async (k) => (k.startsWith("spaces/") ? null : real(k));
  const gc = await W.blobGc(env, { dryRun: true });
  assert.equal(gc.ok, false);
  assert.equal(gc.reason, "no-manifests-read");
  env.BUNDLES.get = real;
  assert.equal(env.BUNDLES.store.size, 15, "a refused sweep deleted something");
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
  await workspaceHolding(env, ONE, ["site", "docs"]);
  const wrong = await W.deleteWorkspace(ctxFor(ONE), env, { confirm: TWO, dryRun: false });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, "confirm-mismatch");
  assert.equal(wrong.expected, ONE);
  assert.ok(env.BUNDLES.store.has("spaces/site/manifest.json"));
});

test("deleting a workspace that was never provisioned is REFUSED, and does not create one first", async () => {
  // It used to report a clean delete of nothing. Now the object is asked whether it agrees
  // it is due, and a workspace that does not exist cannot agree — so the answer is a
  // refusal naming why, which is also the answer a typo'd workspace name deserves.
  const env = twoWorkspaces();
  const ns = env.TENANTS;
  const r = await W.deleteWorkspace(ctxFor("never-existed"), env, { confirm: "never-existed", dryRun: false });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "not-tombstoned");
  assert.deepEqual(ns.get(ns.idFromName("never-existed")).store.status(),
    { provisioned: false, hasStoredData: false });
});

test("with no store at all it refuses rather than reporting a clean delete", async () => {
  assert.deepEqual(await W.deleteWorkspace(ctxFor(ONE), {}, { confirm: ONE, dryRun: false }),
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
  // them means every blob is orphaned. The erasure keeps the same refusal for the same
  // reason: a partial listing must never become a partial delete.
  const env = twoWorkspaces();
  await workspaceHolding(env, ONE, ["site", "docs"]);
  tombstoneDue(env, ONE);
  const real = env.BUNDLES.list.bind(env.BUNDLES);
  env.BUNDLES.list = async (opts) => (opts.delimiter
    ? { objects: [], delimitedPrefixes: [], truncated: true, cursor: null }
    : real(opts));
  const gc = await W.blobGc(env, { dryRun: false });
  assert.equal(gc.ok, false);
  assert.equal(gc.reason, "incomplete-listing");
  assert.ok(env.BUNDLES.store.has(`blobs/${SHARED}`), "an unreadable listing reclaimed live blobs");

  const del = await W.deleteWorkspace(ctxFor(ONE), env, { confirm: ONE, dryRun: false });
  assert.equal(del.ok, false);
  assert.equal(del.reason, "incomplete-listing");
  assert.ok(env.BUNDLES.store.has("spaces/site/manifest.json"), "a partial listing deleted a workspace");
});

// ── THE SECOND KEY ───────────────────────────────────────────────────────────
//
// `confirm === tenantId` is a fat-finger guard, not an authorisation: whoever calls this
// already knows the id, because they had to address the request to it. On a hosted
// deployment the caller is a scheduled job holding a bearer, and a bearer can be stolen.
// So the workspace object is asked whether IT agrees the purge date has passed — and it
// wrote that date itself, at delete time, which is why the caller cannot forge it.
//
// These four are the whole value of the guard. The three refusals matter more than the
// one success: a guard that only ever says yes is not a guard.

test("A LIVE WORKSPACE IS REFUSED, however correct the confirmation string", async () => {
  const env = twoWorkspaces();
  await workspaceHolding(env, ONE, ["site", "docs"]);
  // No tombstone. This is the case a stolen purge bearer would be used for.
  const r = await W.deleteWorkspace(ctxFor(ONE), env, { confirm: ONE, dryRun: false });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "not-tombstoned");
  assert.ok(env.BUNDLES.store.has("spaces/site/manifest.json"), "a live workspace was erased");
  assert.equal(env.TENANTS.get(env.TENANTS.idFromName(ONE)).store.status().provisioned, true);
});

test("A TOMBSTONE INSIDE ITS GRACE WINDOW IS REFUSED, and says when it will not be", async () => {
  // The thirty days are a published promise, and this is the code that keeps it. Somebody
  // who deletes by mistake has until the date to write in; erasing early takes that away.
  const env = twoWorkspaces();
  const ns = env.TENANTS;
  await workspaceHolding(env, ONE, ["site", "docs"]);
  const t = ns.get(ns.idFromName(ONE)).store.deleteWorkspace(new Date().toISOString());
  assert.ok(t.purgeAfter, "the object did not record a purge date");

  const r = await W.deleteWorkspace(ctxFor(ONE), env, { confirm: ONE, dryRun: false });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "grace-window");
  assert.equal(r.purgeAfter, t.purgeAfter, "the refusal did not carry the date it is waiting for");
  assert.ok(env.BUNDLES.store.has("spaces/site/manifest.json"), "a workspace inside its grace window was erased");
});

test("A WORKSPACE OBJECT THAT CANNOT BE READ IS A REFUSAL, NOT A SKIP", async () => {
  // The failure that would matter. If an unreachable object read as "no object here", a
  // transient error would become permission to erase — and this is the one verb no
  // rollback reaches. Same asymmetry `effectiveSecret` makes: bound-but-broken fails
  // closed, absent-entirely does not.
  const env = twoWorkspaces();
  const ns = env.TENANTS;
  await workspaceHolding(env, ONE, ["site", "docs"]);
  tombstoneDue(env, ONE);

  const realGet = ns.get.bind(ns);
  ns.get = (id) => {
    const s = realGet(id);
    return { ...s, fetch: async () => { throw new Error("workspace unreachable"); } };
  };

  const r = await W.deleteWorkspace(ctxFor(ONE), env, { confirm: ONE, dryRun: false });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "workspace-status-unreadable");
  assert.ok(env.BUNDLES.store.has("spaces/site/manifest.json"), "an unreadable object let an erasure through");
});

test("A DRY RUN IS NEVER REFUSED BY THE TOMBSTONE GUARD, because it removes nothing", async () => {
  const env = twoWorkspaces();
  await workspaceHolding(env, ONE, ["site", "docs"]);
  const dry = await W.deleteWorkspace(ctxFor(ONE), env, {});
  assert.equal(dry.ok, true);
  assert.equal(dry.dryRun, true);
  assert.ok(env.BUNDLES.store.has("spaces/site/manifest.json"));
});
