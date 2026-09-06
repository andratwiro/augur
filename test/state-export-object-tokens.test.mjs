// A "full" copy carries every publish token that can publish — including the ones the
// workspace OBJECT holds and KV does not.
//
// Since the identity cut-over (`KV_CUTOVER.publishTokens`) a token is read from the object
// first and KV second; a mint writes both, and a row can exist in one store and not the
// other — a copy that ran before the cut, a KV write that failed after the object took the
// row, a token minted straight into the object. The export read `publish:tokens` from KV
// alone, so a `--full` copy taken from a hosted workspace omitted tokens that were live
// and answering, and a restore from it would have dropped them without a word. Found on a
// real workspace on 6 Sep 2026: three tokens minted by pairing, all publishing, none in
// the export.
//
// The rule now: the union of both stores — KV's record verbatim for a hash both hold (it
// is what a restore wrote and what `augur migrate` verifies against; the object's row is a
// projection that stamps fields the record never had), plus every row only the object
// holds. And an object that cannot be asked makes the copy say so — `failed`, which a
// restore refuses — rather than answering from KV alone and calling itself full.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { __testables as W } from "../src/_worker.js";
import { TenantStore } from "../src/tenant-do.js";

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
function namespace({ failing = null } = {}) {
  const objects = new Map();
  return {
    idFromName(name) { return { name, toString: () => `id:${name}` }; },
    get(id) {
      if (!objects.has(id.name)) {
        const db = new DatabaseSync(":memory:");
        const sql = {
          exec(stmt, ...params) {
            if (params.length) return db.prepare(stmt).all(...params);
            if (/^\s*(SELECT|INSERT|UPDATE|DELETE)/i.test(stmt) && /RETURNING/i.test(stmt)) return db.prepare(stmt).all();
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
      return {
        id, store,
        fetch: (u, init) => {
          if (failing && String(u).endsWith(failing)) return Promise.resolve(new Response("boom", { status: 500 }));
          return store.fetch(new Request(u, init));
        },
      };
    },
  };
}

const CTX = Object.freeze({ ...W.applyInstance({ users: [] }), tenantId: "acme" });

/** Mint a token into the object only — the row a divergent store holds. */
async function mintIntoObject(env, rec) {
  const stub = env.TENANTS.get(env.TENANTS.idFromName("acme"));
  const r = await stub.fetch("https://workspace/identity/token/mint", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: "acme", ...rec }),
  });
  assert.equal(r.status, 200);
}

test("A TOKEN THE WORKSPACE OBJECT HOLDS AND KV DOES NOT IS IN THE FULL COPY", async () => {
  const env = { COMMENTS: memKv(), TENANTS: namespace() };
  await mintIntoObject(env, { tokenHash: "h-object", space: "alpha", label: "live editor", createdAt: "2026-09-06T10:00:00.000Z" });

  const doc = await W.exportState(CTX, env);
  assert.equal(doc.failed.length, 0);
  assert.equal(doc.absent.includes("publish:tokens"), false,
    "the family is not absent: the object has a row, and a restore that leaves this family alone drops it");
  assert.deepEqual(doc.families["publish:tokens"], {
    "h-object": { space: "alpha", label: "live editor", createdAt: "2026-09-06T10:00:00.000Z" },
  });
});

test("the copy is the UNION of both stores — KV's record VERBATIM where both hold a hash, the object's rows where KV has none", async () => {
  const env = { COMMENTS: memKv(), TENANTS: namespace() };
  await env.COMMENTS.put("publish:tokens", JSON.stringify({
    "h-kv-only": { space: "alpha", label: "ci", createdAt: "2026-01-01T00:00:00.000Z" },
    "h-both": { space: "alpha", label: "ci" },   // a record from before `createdAt` existed
  }));
  await mintIntoObject(env, { tokenHash: "h-both", space: "alpha", label: "ci", createdAt: "2026-09-06T10:00:00.000Z" });
  await mintIntoObject(env, { tokenHash: "h-object-only", space: "*", label: "paired", createdAt: "2026-09-06T10:00:00.000Z" });

  const doc = await W.exportState(CTX, env);
  const t = doc.families["publish:tokens"];
  assert.deepEqual(Object.keys(t).sort(), ["h-both", "h-kv-only", "h-object-only"]);
  assert.deepEqual(t["h-both"], { space: "alpha", label: "ci" },
    "the object's row is a projection that stamps a createdAt the record never had; a copy that took it stopped verifying after a migration");
  assert.equal(t["h-kv-only"].label, "ci", "a token only KV holds still publishes (the read falls through) and is still copied");
  assert.equal(t["h-object-only"].space, "*");
});

test("the KV shape is unchanged where there is no object: a deployment without TENANTS reads exactly what it always read", async () => {
  const env = { COMMENTS: memKv() };
  await env.COMMENTS.put("publish:tokens", JSON.stringify({ h1: { space: "alpha", label: "ci" } }));
  const doc = await W.exportState(CTX, env);
  assert.deepEqual(doc.families["publish:tokens"], { h1: { space: "alpha", label: "ci" } });

  const empty = await W.exportState(CTX, { COMMENTS: memKv() });
  assert.ok(empty.absent.includes("publish:tokens"), "a document that is not there is absent, as before");
});

test("with an object that has no rows and KV that has no document, the family is still absent — not an invented {}", async () => {
  const env = { COMMENTS: memKv(), TENANTS: namespace() };
  const doc = await W.exportState(CTX, env);
  assert.ok(doc.absent.includes("publish:tokens"),
    "`augur restore` LEAVES an absent family and CLEARS a `{}` one; an empty answer here would be a clear");
});

test("AN OBJECT THAT CANNOT LIST ITS TOKENS MAKES THE COPY SAY SO, and a restore refuses it", async () => {
  const env = { COMMENTS: memKv(), TENANTS: namespace({ failing: "/identity/token/list" }) };
  await env.COMMENTS.put("publish:tokens", JSON.stringify({ h1: { space: "alpha", label: "ci" } }));

  const doc = await W.exportState(CTX, env);
  assert.ok(doc.failed.some((f) => f.id === "publish:tokens"),
    "answering from KV alone here is a copy that calls itself full while missing every object-held token");
  assert.equal("publish:tokens" in doc.families, false);

  const back = await W.importState(CTX, { COMMENTS: memKv(), TENANTS: namespace() }, doc);
  assert.equal(back.ok, false);
  assert.equal(back.reason, "incomplete-export");
});

test("a full copy taken from one workspace object restores every token into another", async () => {
  const from = { COMMENTS: memKv(), TENANTS: namespace() };
  await mintIntoObject(from, { tokenHash: "h-a", space: "alpha", label: "a", createdAt: "2026-09-06T10:00:00.000Z" });
  await mintIntoObject(from, { tokenHash: "h-b", space: "*", label: "b", createdAt: "2026-09-06T10:00:00.000Z", expiresAt: "2027-01-01T00:00:00.000Z" });
  const doc = await W.exportState(CTX, from);

  const to = { COMMENTS: memKv(), TENANTS: namespace() };
  const res = await W.importState(CTX, to, doc);
  assert.equal(res.ok, true);

  const back = await W.exportState(CTX, to);
  assert.deepEqual(back.families["publish:tokens"], doc.families["publish:tokens"],
    "what one object held, the other holds — scope and expiry included");
});
