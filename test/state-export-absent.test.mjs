// What `absent` is allowed to mean in a copy, and which families may say it.
//
// A `--full` export reports a family it could not find as ABSENT rather than omitting it,
// because empty and unreadable look identical in a JSON blob and a restore that cannot tell
// them apart is a restore that silently deletes. Everything downstream reads that word:
// `augur restore` LEAVES a family reported absent and CLEARS one handed over as `{}`, and
// `augur migrate` treats absent as empty for a whole-document family and refuses to for a
// set-of-documents one.
//
// So `absent` carries a promise, and this file is that promise:
//
//   A `key` FAMILY MAY BE ABSENT. It is one document; it is there or it is not, and not
//   being there is exactly holding nothing.
//
//   A `prefix` FAMILY MAY NOT, wherever there is a store holding it. It is a set of
//   documents and an empty set is `{}`. Absent from a prefix family can only mean the export
//   failed to enumerate it — which is a copy nobody can judge, and the reason `migrate`
//   refuses on one rather than reading it as empty.
//
// ⚠️ THE PROMISE WAS BROKEN, WHICH IS WHY IT IS A TEST AND NOT A COMMENT. `pins:` — the one
// family stored under a SCOPE rather than a key prefix — reported absent from the
// workspace-object backing whether it held two people's sidebars or none, because the
// accessor could read a named scope and could not ask which scopes existed. Two failures came
// out of that one gap: every KV→workspace migration refused to verify on correct data, and an
// export taken FROM that backing carried nobody's sidebar while reporting itself complete.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { __testables as W } from "../src/_worker.js";
import { TenantStore } from "../src/tenant-do.js";
import { STATE_INVENTORY } from "../src/state-inventory.mjs";

function memKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async getWithMetadata(k) { return { value: store.get(k) ?? null, metadata: null }; },
    async put(k, v) { store.set(k, typeof v === "string" ? v : JSON.stringify(v)); },
    async delete(k) { store.delete(k); },
    async list({ prefix = "" } = {}) {
      return {
        keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      };
    },
  };
}

/** A TENANTS namespace whose objects are real TenantStores over real SQLite. */
function namespace() {
  const objects = new Map();
  return {
    idFromName(name) { return { name, toString: () => `id:${name}` }; },
    get(id) {
      if (!objects.has(id.name)) {
        const db = new DatabaseSync(":memory:");
        const sql = {
          exec(stmt, ...params) {
            if (params.length) return db.prepare(stmt).all(...params);
            if (/^\s*(SELECT|INSERT|UPDATE)/i.test(stmt) && /RETURNING/i.test(stmt)) return db.prepare(stmt).all();
            if (/^\s*SELECT/i.test(stmt)) return db.prepare(stmt).all();
            db.exec(stmt);
            return [];
          },
        };
        objects.set(id.name, new TenantStore({ storage: { sql }, blockConcurrencyWhile: async (f) => f() }, {}));
      }
      const store = objects.get(id.name);
      return { id, store, fetch: (u, init) => store.fetch(new Request(u, init)) };
    },
  };
}

const CTX = Object.freeze({ ...W.applyInstance({ users: [] }), tenantId: "acme" });
const PREFIX_FAMILIES = STATE_INVENTORY
  .filter((e) => e.to === "workspace" && e.kind === "prefix")
  .map((e) => e.id);

// ── the invariant, on both backings a migration runs between ─────────────────

test("NO SET-OF-DOCUMENTS FAMILY REPORTS ABSENT, on either backing, empty or not", async () => {
  // The two shapes `augur migrate` runs between: shared KV, and a workspace object with KV
  // still bound underneath it (which is what a KV→object move produces, because the identity
  // families are copied to BOTH until the read cutover lands).
  const kvOnly = { COMMENTS: memKv() };
  const workspace = { COMMENTS: memKv(), TENANTS: namespace() };

  for (const [what, env] of [["shared KV", kvOnly], ["the workspace object", workspace]]) {
    const doc = await W.exportState(CTX, env);
    for (const id of PREFIX_FAMILIES) {
      assert.equal(doc.absent.includes(id), false,
        `${id} reported ABSENT from ${what}. A set of documents with nothing in it is {}; `
        + `absent says the export could not enumerate the family, and every reader downstream `
        + `believes it — restore leaves it alone and migrate refuses to verify.`);
      assert.deepEqual(doc.families[id], {},
        `${id} should be an empty set on ${what}`);
    }
  }
});

test("a family stored under a SCOPE survives the round trip that a migration is", async () => {
  // `pins:` is the whole of this case: on KV a person's sidebar is `pins:<address>`, and on
  // the workspace object it is rows under scope `<address>`. The copy has to come back the
  // same object of maps either way, or the copy is not a copy.
  const from = { COMMENTS: memKv() };
  for (const [k, v] of Object.entries({
    pins: { "/open/": { label: "Open" } },              // the signed-out visitor's sidebar
    "pins:a@x.test": { "/one/": { label: "One" } },
    "pins:b@x.test": { "/two/": { label: "Two" } },
  })) await from.COMMENTS.put(k, JSON.stringify(v));

  const doc = await W.exportState(CTX, from);
  assert.deepEqual(doc.families["pins:"], {
    "a@x.test": { "/one/": { label: "One" } },
    "b@x.test": { "/two/": { label: "Two" } },
  });

  const to = { COMMENTS: memKv(), TENANTS: namespace() };
  assert.equal((await W.importState(CTX, to, doc)).ok, true);

  const back = await W.exportState(CTX, to);
  assert.deepEqual(back.families["pins:"], doc.families["pins:"],
    "every person's sidebar landed in the workspace object and the copy could not read one back");
  assert.deepEqual(back.families.pins, doc.families.pins,
    "the signed-out sidebar is the bare `pins` entry and must not be double-counted or lost");
  assert.equal("" in (back.families["pins:"] || {}), false,
    "scope '' is the bare `pins` family — carrying it under `pins:` too would copy it twice");
});

test("the object answers which scopes it holds, and only a copy ever asks", async () => {
  // The one read added for this. Every request-path caller already knows whose scope it
  // wants; a backup is the caller that cannot know, and on this backing the scopes are a
  // column rather than a key prefix, so there is no other way to find out from outside.
  const ns = namespace();
  const stub = ns.get(ns.idFromName("acme"));
  const call = (op, body) => stub.fetch(`https://workspace/overlay/${op}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: "acme", ...body }),
  }).then((r) => r.json());

  assert.deepEqual((await call("scopes", { family: "pins" })).scopes, []);
  await call("set", { family: "pins", scope: "a@x.test", k: "/one/", v: { label: "One" } });
  await call("set", { family: "pins", scope: "a@x.test", k: "/two/", v: { label: "Two" } });
  await call("set", { family: "pins", scope: "b@x.test", k: "/one/", v: { label: "One" } });
  await call("set", { family: "pins", scope: "", k: "/open/", v: { label: "Open" } });

  assert.deepEqual((await call("scopes", { family: "pins" })).scopes, ["", "a@x.test", "b@x.test"],
    "one entry per scope, not one per row");
  assert.deepEqual((await call("scopes", { family: "statuses" })).scopes, [],
    "scopes are per family — another family's rows are not this family's scopes");
});

// ── and the half that stays as it is ─────────────────────────────────────────

test("a whole-document family that was never written still reports ABSENT, on purpose", async () => {
  // The asymmetry `export-adversarial` pins, restated from this side so a later widening of
  // the rule above cannot quietly take it with it. An identity document read straight from
  // KV is absent when it does not exist, and a restore LEAVES the target's alone; an overlay
  // map reads as `{}` and a restore CLEARS it. Same situation, opposite outcomes, both
  // deliberate.
  const doc = await W.exportState(CTX, { COMMENTS: memKv() });
  assert.ok(doc.absent.includes("users:roles"), "an unwritten identity family must report absent");
  assert.ok(doc.absent.includes("mail:suppressed"));
  assert.deepEqual(doc.families.statuses, {}, "an unwritten overlay map must report empty");
  assert.ok(!doc.absent.includes("statuses"));
});
