// A backup of a workspace, not just of what it published.
//
// `MIG-export-endpoints`. The publish routes cover the BUNDLE STORE — manifests, versions,
// blobs — and `augur export` walks them. Nothing covered the rest: the roster, the invites,
// the publish tokens, the statuses, the card names, the boards, the comment threads, the
// pins, the images pasted onto a canvas. A backup was a copy of what a workspace had
// published and nothing about who could publish it or what anybody had said about it.
//
// IT IS DRIVEN BY THE INVENTORY. `src/state-inventory.mjs` is the checked-and-gated account
// of what exists; the export walks it rather than carrying a second list, so a family added
// there is backed up without anybody remembering to do it twice — and a family that is NOT
// there fails the build rather than quietly missing a backup.
//
// ⛔ AND THE CREDENTIAL IS EXCLUDED BY CONSTRUCTION. The walk takes entries destined for the
// WORKSPACE; `users:secrets` is destined for the account store, so it is not reachable from
// this route at all. That is worth more than a denylist, which has to be remembered, and
// what it would be protecting is every password on the instance.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { __testables as W } from "../src/_worker.js";
import { TenantStore } from "../src/tenant-do.js";
import { STATE_INVENTORY } from "../src/state-inventory.mjs";

const CTX = Object.freeze({ ...W.applyInstance({ users: [] }), tenantId: "acme" });

function memKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async getWithMetadata(k) { return { value: store.get(k) ?? null, metadata: null }; },
    async head(k) { return store.has(k) ? {} : null; },
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
    async head(k) { return store.has(k) ? {} : null; },
    async get(k) {
      if (!store.has(k)) return null;
      const o = store.get(k);
      return { body: o.body, httpMetadata: o.httpMetadata, text: async () => o.body };
    },
    async put(k, v, opts) { store.set(k, { body: v, httpMetadata: (opts || {}).httpMetadata }); },
    async delete(k) { store.delete(k); },
    async list() { return { objects: [], truncated: false }; },
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
      // `store` is exposed so a test can reach INTO the object — to break its writes, or to
      // read a table directly. Nothing in the worker uses it.
      return { id, store, fetch: (u, init) => store.fetch(new Request(u, init)) };
    },
  };
}

/** A workspace with something of every family in it. */
function seededKv() {
  return memKv({
    "users:roster": JSON.stringify({ add: { "a@x.test": { email: "a@x.test", role: "editor" } }, remove: [] }),
    "users:roles": JSON.stringify({ "a@x.test": "editor" }),
    "users:names": JSON.stringify({ "a@x.test": "Ada" }),
    "users:avatars": JSON.stringify({ "a@x.test": "deadbeef" }),
    "users:invites": JSON.stringify({ tok1: { email: "b@x.test", expires: 1 } }),
    "users:lastseen:a@x.test": JSON.stringify("2026-08-01T00:00:00.000Z"),
    "avatar:deadbeef": JSON.stringify("data:image/png;base64,AAAA"),
    "publish:tokens": JSON.stringify({ hash1: { space: "alpha", label: "ci" } }),
    "spaces:icons": JSON.stringify({ acme: "iconhash" }),
    "spaceicon:iconhash": JSON.stringify("data:image/png;base64,BBBB"),
    "mail:suppressed": JSON.stringify(["bounced@x.test"]),
    statuses: JSON.stringify({ "/p/": "dev-ready" }),
    names: JSON.stringify({ "/p/": "Prototype" }),
    canvases: JSON.stringify({ "/b/one/": { name: "One", by: "a@x.test", t: 1 } }),
    pins: JSON.stringify({ "/p/": { label: "P", href: "/p/" } }),
    "pins:a@x.test": JSON.stringify({ "/q/": { label: "Q", href: "/q/" } }),
    "c:/p/": JSON.stringify([{ id: "t1", messages: [{ author: "Ada", body: "hello" }] }]),
    "board:/b/one/": JSON.stringify({ nodes: [{ id: "n1" }] }),
    "pt:view": JSON.stringify({ path: "/p/", ts: 1 }),
    "pt:remarks": JSON.stringify([{ id: 1, path: "/p/", text: "hi", ts: 1 }]),
    ["basset-meta:" + "a".repeat(40)]: JSON.stringify({ ct: "image/png", bytes: 12, at: "2026-08-01T00:00:00.000Z" }),
    // Deliberately present and deliberately NOT exportable.
    "users:secrets": JSON.stringify({ "a@x.test": "pbkdf2$100000$salt$hash" }),
    // Transient, and equally not exportable.
    "rl:login:ip:1.2.3.4": "3",
  });
}

const exportVia = (env) => W.exportState(CTX, env);

// ── the walk ─────────────────────────────────────────────────────────────────

test("EVERY WORKSPACE FAMILY IN THE INVENTORY IS EXPORTED, and nothing else is", async () => {
  const env = { COMMENTS: seededKv(), BUNDLES: memR2() };
  const doc = await exportVia(env);
  const expected = STATE_INVENTORY.filter((e) => e.to === "workspace").map((e) => e.id).sort();
  assert.deepEqual([...Object.keys(doc.families), ...doc.absent].sort(), expected,
    "the export and the inventory disagree about what a workspace holds");
  assert.deepEqual(doc.failed, []);
  assert.equal(doc.format, 1);
});

test("⛔ THE PASSWORD HASHES ARE NOT IN IT, and could not be", async () => {
  // Not a filter — the walk takes entries destined for the WORKSPACE, and a credential is
  // destined for the account store, so this route cannot reach one.
  const env = { COMMENTS: seededKv(), BUNDLES: memR2() };
  const doc = await exportVia(env);
  assert.equal("users:secrets" in doc.families, false);
  assert.ok(!doc.absent.includes("users:secrets"), "it was reached and found empty, rather than never reached");
  assert.ok(!JSON.stringify(doc).includes("pbkdf2"), "a hash leaked into the document some other way");
});

test("transient state is not exported, so a restore does not carry somebody's rate limit", async () => {
  const env = { COMMENTS: seededKv(), BUNDLES: memR2() };
  const doc = await exportVia(env);
  for (const id of ["rl:login:ip:", "rl:login:em:", "rl:mail:", "pair:", "rebake:sent:", "engine:update-check", "users:spaces"]) {
    assert.equal(id in doc.families, false, `${id} was exported`);
  }
});

test("AN ABSENT DOCUMENT IS REPORTED, not omitted — and an empty SET is not absent", async () => {
  // A document that is empty and a document that could not be read look identical in a
  // blob, and a restore that cannot tell them apart is a restore that silently deletes.
  // A prefix family is a different question: a set with nothing in it is empty rather than
  // missing, and there is no third state the store could report.
  const env = { COMMENTS: memKv({ statuses: JSON.stringify({ "/p/": "ignore" }) }), BUNDLES: memR2() };
  const doc = await exportVia(env);
  const byId = Object.fromEntries(STATE_INVENTORY.map((e) => [e.id, e]));
  assert.ok(doc.absent.includes("users:roster"), "a missing document was not reported absent");
  for (const id of doc.absent) {
    assert.equal(byId[id].kind, "key", `${id} is a prefix family and cannot be "absent"`);
    assert.equal(id in doc.families, false, `${id} is reported both absent and present`);
  }
  for (const [id, value] of Object.entries(doc.families)) {
    if (id === "statuses") continue;
    assert.deepEqual(value, {}, `${id} should read empty on a bare workspace`);
  }
  assert.deepEqual(doc.families.statuses, { "/p/": "ignore" });
});

test("the image hashes ride along, so a restore knows what bytes to fetch", async () => {
  const env = { COMMENTS: seededKv(), BUNDLES: memR2() };
  const doc = await exportVia(env);
  assert.deepEqual(doc.assets, ["a".repeat(40)]);
});

// ── the round trip ───────────────────────────────────────────────────────────

test("EVERY FAMILY ROUND-TRIPS BYTE-IDENTICAL through export → import → export", async () => {
  // The VERIFY. A copy that is not identical is a copy nobody can check, and the second
  // export is the only thing that says so without a human reading two blobs.
  const from = { COMMENTS: seededKv(), BUNDLES: memR2() };
  const first = await exportVia(from);

  const to = { COMMENTS: memKv(), BUNDLES: memR2() };
  const put = await W.importState(CTX, to, { ...first, format: 1 });
  assert.equal(put.ok, true, JSON.stringify(put));
  assert.deepEqual(put.skipped, []);

  const second = await W.exportState(CTX, to);
  assert.deepEqual(second.families, first.families, "the copy differs from the original");
  assert.deepEqual(second.absent.sort(), first.absent.sort());
});

test("it round-trips through the WORKSPACE STORE as well as through KV", async () => {
  // The two backings have to agree, or a workspace's backup stops being restorable the day
  // it moves.
  const from = { COMMENTS: seededKv(), BUNDLES: memR2() };
  const first = await exportVia(from);

  const to = { COMMENTS: memKv(), BUNDLES: memR2(), TENANTS: namespace() };
  assert.equal((await W.importState(CTX, to, first)).ok, true);
  const second = await W.exportState(CTX, to);

  // The overlay families are the ones the workspace store owns; the identity documents
  // still live in KV on both sides.
  for (const id of ["statuses", "names", "canvases", "c:", "board:", "pt:view", "pt:remarks"]) {
    assert.deepEqual(second.families[id], first.families[id], id);
  }
});

test("A DOCUMENT THAT REPORTS A FAILED READ IS REFUSED, not half-replayed", async () => {
  // "Restore what we managed to read" is how a bad backup becomes a bad live instance.
  const to = { COMMENTS: memKv() };
  const r = await W.importState(CTX, to, {
    format: 1, families: { statuses: { "/p/": "ignore" } }, failed: [{ id: "users:roster", error: "boom" }],
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "incomplete-export");
  assert.deepEqual(r.failed, ["users:roster"]);
  assert.equal(to.COMMENTS.store.size, 0, "a refused restore wrote something");
});

test("an unknown family in a document is skipped, never replayed", async () => {
  // A restore is the worst possible moment to start trusting a document about where things
  // go, and the document is a file somebody may have edited.
  const to = { COMMENTS: memKv() };
  const r = await W.importState(CTX, to, {
    format: 1, families: { statuses: { "/p/": "ignore" }, "users:secrets": { "a@x.test": "hash" }, invented: { x: 1 } },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.skipped.sort(), ["invented", "users:secrets"]);
  assert.equal(to.COMMENTS.store.has("users:secrets"), false, "a restore wrote password hashes");
  assert.equal(to.COMMENTS.store.has("invented"), false);
  assert.equal(to.COMMENTS.store.has("statuses"), true, "the real family did not land");
});

test("a document of the wrong shape is refused rather than guessed at", async () => {
  const to = { COMMENTS: memKv() };
  for (const bad of [null, {}, { format: 2, families: {} }, { format: 1 }, { format: 1, families: [] }]) {
    const r = await W.importState(CTX, to, bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(r.reason, "bad-document");
  }
});

// ── the routes ───────────────────────────────────────────────────────────────

// The headers are MERGED rather than spread over: a caller passing a content-type would
// otherwise drop the Authorization header and get a 403 that looks like a scope problem.
const call = (env, path, init = {}) => W.publishApi(CTX,
  new Request(`https://x.test${path}`, {
    ...init,
    headers: { Authorization: "Bearer star", ...(init.headers || {}) },
  }),
  new URL(`https://x.test${path}`), env);

test("the export route needs a STAR-SCOPE token, because it answers with the roster", async () => {
  const kv = seededKv();
  await kv.put("publish:tokens", JSON.stringify({
    [await W.tokenFor("pub:star")]: { space: "*", label: "ci" },
    [await W.tokenFor("pub:one")]: { space: "alpha", label: "ci-alpha" },
  }));
  const env = { COMMENTS: kv, BUNDLES: memR2() };
  const withToken = (t) => W.publishApi(CTX,
    new Request("https://x.test/__publish/_state/export", { headers: { Authorization: "Bearer " + t } }),
    new URL("https://x.test/__publish/_state/export"), env);

  const scoped = await withToken("one");
  assert.equal(scoped.status, 403);
  const star = await withToken("star");
  assert.equal(star.status, 200);
  const body = await star.json();
  assert.equal(body.workspace, "acme");
  assert.ok(body.families["users:roster"]);
  assert.match(body.generatedAt, /^\d{4}-\d\d-\d\dT/);
});

test("the asset route hands back the bytes the rows point at", async () => {
  // `/__publish/<space>/blob/<hash>` walks `blobs/` and would never see these, which is
  // exactly the gap moving canvas images to R2 opened.
  const hash = "b".repeat(40);
  const kv = seededKv();
  await kv.put("publish:tokens", JSON.stringify({ [await W.tokenFor("pub:star")]: { space: "*", label: "ci" } }));
  const env = {
    COMMENTS: kv,
    BUNDLES: memR2({ [W.ASSET_R2_PREFIX + hash]: { body: "PNGBYTES", httpMetadata: { contentType: "image/png" } } }),
  };
  const ok = await call(env, `/__publish/_state/asset/${hash}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "image/png");
  assert.equal(await ok.text(), "PNGBYTES");

  assert.equal((await call(env, "/__publish/_state/asset/not-a-hash")).status, 400);
  assert.equal((await call(env, `/__publish/_state/asset/${"c".repeat(40)}`)).status, 404);
});

test("an unknown op under _state is a 400, not a silent 200", async () => {
  const kv = seededKv();
  await kv.put("publish:tokens", JSON.stringify({ [await W.tokenFor("pub:star")]: { space: "*", label: "ci" } }));
  const res = await call({ COMMENTS: kv, BUNDLES: memR2() }, "/__publish/_state/whatever");
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "unknown-op");
});

test("THE ASSET WRITE ROUTE CHECKS THE HASH AGAINST THE BYTES", async () => {
  // A restore is a write path that takes a key from the caller. Content addressing is a
  // guarantee only while the content matches the address — a copy corrupted on its way to
  // disk would otherwise be written back under a name that says it is fine, which is the
  // exact failure the canvas-image backup work was about.
  const kv = seededKv();
  await kv.put("publish:tokens", JSON.stringify({ [await W.tokenFor("pub:star")]: { space: "*", label: "ci" } }));
  const env = { COMMENTS: kv, BUNDLES: memR2() };
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);

  const wrong = await call(env, `/__publish/_state/asset/${"d".repeat(40)}`, { method: "PUT", body: bytes });
  assert.equal(wrong.status, 409);
  assert.equal((await wrong.json()).error, "hash-mismatch");
  assert.equal(env.BUNDLES.store.size, 0, "bytes were stored under a name that does not describe them");

  const right = await call(env, `/__publish/_state/asset/${hash}`, {
    method: "PUT", headers: { "content-type": "image/png" }, body: bytes,
  });
  assert.equal(right.status, 200);
  assert.equal(env.BUNDLES.store.get(W.ASSET_R2_PREFIX + hash).httpMetadata.contentType, "image/png");

  // And it comes straight back out.
  const back = await call(env, `/__publish/_state/asset/${hash}`);
  assert.equal(back.status, 200);
  assert.deepEqual(new Uint8Array(await back.arrayBuffer()), bytes);
});

test("AN IMAGE PASTED BEFORE THE R2 MOVE IS IN THE COPY, and a restore moves it", async () => {
  // The gap found by taking a real backup of a live instance: `basset:<hash>` images live
  // in KV, are destined for R2, and are therefore in neither the state families (which walk
  // workspace-destined entries) nor the R2 asset list. A copy that omitted them would omit
  // every image on every instance that has been running for a while.
  const bytes = new Uint8Array([9, 8, 7, 6]);
  const hash = "e".repeat(40);
  const kv = seededKv();
  await kv.put(W.ASSET_PREFIX + hash, bytes);
  kv.store.set(W.ASSET_PREFIX + hash, bytes); // with no metadata, as the oldest ones are
  await kv.put("publish:tokens", JSON.stringify({ [await W.tokenFor("pub:star")]: { space: "*", label: "ci" } }));
  const env = { COMMENTS: kv, BUNDLES: memR2() };

  const doc = await exportVia(env);
  assert.ok(doc.assets.includes(hash), `the legacy image is not listed: ${doc.assets}`);

  // And its bytes come back through the same route the R2-backed ones do.
  const got = await call(env, `/__publish/_state/asset/${hash}`);
  assert.equal(got.status, 200);
  assert.deepEqual(new Uint8Array(await got.arrayBuffer()), bytes);
});

// ── the import is one transaction, not a family-by-family replay ─────────────
//
// `MIG-do-import-endpoint`. Family by family is survivable for an edit and wrong for a
// restore: a failure halfway leaves a workspace with some families from the copy and some
// from whatever was there before — a state matching no backup and no moment in time, which
// nobody can tell apart from a successful restore by looking.

test("THE IMPORT IS ATOMIC WHEN THERE IS AN OBJECT TO BE ATOMIC IN, and says which", async () => {
  const from = { COMMENTS: seededKv(), BUNDLES: memR2() };
  const doc = await exportVia(from);

  const withStore = { COMMENTS: memKv(), BUNDLES: memR2(), TENANTS: namespace() };
  const a = await W.importState(CTX, withStore, doc);
  assert.equal(a.ok, true);
  assert.equal(a.atomic, true, "an instance with a workspace object did not get a transaction");

  const withoutStore = { COMMENTS: memKv(), BUNDLES: memR2() };
  const b = await W.importState(CTX, withoutStore, doc);
  assert.equal(b.ok, true);
  assert.equal(b.atomic, false, "an instance with no object claimed a guarantee it cannot give");
});

test("A FAILURE PART-WAY LEAVES THE WORKSPACE AS IT WAS", async () => {
  // The property the whole item is for. The object already holds a workspace; a restore
  // dies mid-write; what is there afterwards must be what was there before, not a mixture.
  const ns = namespace();
  const env = { COMMENTS: memKv(), BUNDLES: memR2(), TENANTS: ns };
  await W.importState(CTX, env, {
    format: 1, families: { statuses: { "/before/": "dev-ready" }, names: { "/before/": "Before" } },
  });
  const before = await W.exportState(CTX, env);
  assert.deepEqual(before.families.statuses, { "/before/": "dev-ready" });

  // Break the object's write halfway through the second family.
  const stub = ns.get(ns.idFromName("acme"));
  const real = stub.store.sql.exec.bind(stub.store.sql);
  let writes = 0;
  stub.store.sql.exec = (stmt, ...p) => {
    if (/^\s*INSERT INTO overlay/.test(stmt) && ++writes === 2) throw new Error("the isolate went away");
    return real(stmt, ...p);
  };
  await assert.rejects(W.importState(CTX, env, {
    format: 1, families: { statuses: { "/after/": "ignore" }, names: { "/after/": "After" } },
  }));
  stub.store.sql.exec = real;

  const after = await W.exportState(CTX, env);
  assert.deepEqual(after.families.statuses, before.families.statuses, "a half-written restore landed");
  assert.deepEqual(after.families.names, before.families.names);
});

test("TWO WORKSPACES IMPORTED SIDE BY SIDE HOLD NO TRACE OF EACH OTHER", async () => {
  // The other half of the VERIFY, and it is structural rather than enforced: two
  // workspaces are two objects with two databases, so there is no key one could construct
  // that reads the other.
  const ns = namespace();
  const one = Object.freeze({ ...CTX, tenantId: "one" });
  const two = Object.freeze({ ...CTX, tenantId: "two" });
  const env = { COMMENTS: memKv(), BUNDLES: memR2(), TENANTS: ns };

  await W.importState(one, env, { format: 1, families: { statuses: { "/one/": "dev-ready" }, "c:": { "/p/": [{ id: "one-thread" }] } } });
  await W.importState(two, env, { format: 1, families: { statuses: { "/two/": "reviewed" }, "c:": { "/p/": [{ id: "two-thread" }] } } });

  const outOne = await W.exportState(one, env);
  const outTwo = await W.exportState(two, env);
  assert.deepEqual(outOne.families.statuses, { "/one/": "dev-ready" });
  assert.deepEqual(outTwo.families.statuses, { "/two/": "reviewed" });
  assert.equal(JSON.stringify(outOne.families["c:"]).includes("two-thread"), false, "one workspace holds the other's comments");
  assert.equal(JSON.stringify(outTwo.families["c:"]).includes("one-thread"), false);
});

test("the object is told DO families, never KV document names", async () => {
  // The separation that keeps this sane: the worker does the translation, and the object
  // has never needed to know what anything was called in KV. A restore is a poor moment to
  // teach it.
  const seen = [];
  const ns = namespace();
  const real = ns.get.bind(ns);
  ns.get = (id) => {
    const stub = real(id);
    return { ...stub, fetch: (u, init) => {
      if (String(u).endsWith("/state/import")) seen.push(JSON.parse(init.body).overlay);
      return stub.fetch(u, init);
    } };
  };
  const env = { COMMENTS: memKv(), BUNDLES: memR2(), TENANTS: ns };
  await W.importState(CTX, env, {
    format: 1,
    families: { statuses: { "/p/": "ignore" }, "c:": { "/p/": [] }, "pins:": { "a@x.test": {} }, "pt:view": { path: "/p/" } },
  });
  assert.deepEqual(Object.keys(seen[0]).sort(), ["comments", "pins", "piti", "statuses"]);
  assert.deepEqual(Object.keys(seen[0].pins), ["a@x.test"], "the person's address is the scope, not part of a key");
  assert.deepEqual(Object.keys(seen[0].piti[""]), ["view"]);
  assert.equal(JSON.stringify(seen[0]).includes("basset"), false);
});
