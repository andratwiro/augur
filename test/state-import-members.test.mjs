// What a state import does to the PEOPLE a workspace object already has, and what it says.
//
// On KV the roster overlay is one document and an import REPLACES it, so anybody the copy
// does not name is gone. On the workspace object the same import upserted the rows the copy
// named and left every other row exactly as it was — and reported `users:roster` under
// `written` as if it had replaced it. Found on 6 Sep 2026: four test people were put on a
// real roster through the import and taken off through it; the export then showed an empty
// overlay while the object still listed one of them as an admin with a working session.
//
// The rule now follows the words the import already uses for content: a plain restore says
// "at least this" and KEEPS members the copy does not name — and names them, so nobody
// mistakes a keep for a replace; `prune` says "exactly this" and REMOVES them, the way the
// admin panel's remove does, tokens and sessions included.
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
      return { id, store, fetch: (u, init) => store.fetch(new Request(u, init)) };
    },
  };
}

const A = "a@x.test", B = "b@x.test", C = "config@x.test";
const CTX = Object.freeze({ ...W.applyInstance({ users: [{ email: C, name: "Config Carla", role: "admin" }] }), tenantId: "acme" });
const call = (env, op, body) => env.TENANTS.get(env.TENANTS.idFromName("acme")).fetch(`https://workspace/identity/${op}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: "acme", ...body }),
}).then((r) => r.json());

/** A workspace whose object holds two invited people and a token each, the way the admin panel leaves it. */
async function workspaceWithAandB() {
  const env = { COMMENTS: memKv(), TENANTS: namespace() };
  await call(env, "roster/write", {
    configUsers: [{ email: C, name: "Config Carla", role: "admin" }],
    roster: { add: { [A]: { email: A, role: "editor", addedAt: "2026-09-01T00:00:00.000Z" }, [B]: { email: B, role: "editor", addedAt: "2026-09-01T00:00:00.000Z" } }, remove: [] },
  });
  await call(env, "token/mint", { tokenHash: "h-a", space: "alpha", label: A, createdAt: "2026-09-01T00:00:00.000Z" });
  await call(env, "token/mint", { tokenHash: "h-b", space: "alpha", label: B, createdAt: "2026-09-01T00:00:00.000Z" });
  return env;
}
const onlyA = () => ({ format: 1, families: { "users:roster": { add: { [A]: { email: A, role: "editor", addedAt: "2026-09-01T00:00:00.000Z" } }, remove: [] } } });
const roster = (env) => call(env, "roster/read", {});

test("A PLAIN RESTORE KEEPS THE PEOPLE THE COPY DOES NOT NAME — and says who", async () => {
  const env = await workspaceWithAandB();
  const res = await W.importState(CTX, env, onlyA());
  assert.equal(res.ok, true);
  assert.ok(res.written.includes("users:roster"));
  assert.deepEqual(res.members, { kept: [B], removed: [] },
    "`written` alone reads as a replace; the import has to say what it did NOT do");

  const r = await roster(env);
  assert.deepEqual(Object.keys(r.roster.add).sort(), [A, B], "a restore says 'at least this': nobody is removed by it");
  assert.deepEqual(r.roster.remove, []);
  assert.deepEqual(Object.keys((await call(env, "token/list", {})).tokens).sort(), ["h-a", "h-b"], "their tokens keep publishing");
});

test("PRUNE REMOVES THEM, the way the admin panel's remove does: a tombstone, no token, no invite", async () => {
  const env = await workspaceWithAandB();
  await env.COMMENTS.put("users:invites", JSON.stringify({ tokB: { email: B, expires: 4e12 } }));
  const res = await W.importState(CTX, env, { ...onlyA(), prune: true });
  assert.equal(res.ok, true);
  assert.deepEqual(res.members, { kept: [], removed: [B] });

  const r = await roster(env);
  assert.deepEqual(Object.keys(r.roster.add), [A]);
  assert.ok(r.roster.remove.includes(B), "the row is a tombstone, so a re-invite cannot inherit the old role");
  assert.deepEqual(Object.keys((await call(env, "token/list", {})).tokens), ["h-a"], "the removed person's token is gone from the object");
  assert.deepEqual(JSON.parse(await env.COMMENTS.get("users:invites")), {}, "an outstanding invite must not let them back in");
});

test("a CONFIG member is never on either list — the durable roster is not the copy's to remove", async () => {
  const env = await workspaceWithAandB();
  const res = await W.importState(CTX, env, { ...onlyA(), prune: true });
  assert.equal(res.members.kept.includes(C), false);
  assert.equal(res.members.removed.includes(C), false);
  const r = await roster(env);
  assert.equal(r.roster.remove.includes(C), false);
});

test("a copy that carries NO roster touches nobody and reports nothing about members", async () => {
  const env = await workspaceWithAandB();
  const res = await W.importState(CTX, env, { format: 1, families: { statuses: { "/p/": "dev-ready" } }, prune: true });
  assert.equal(res.ok, true);
  assert.equal(res.members, undefined);
  assert.deepEqual(Object.keys((await roster(env)).roster.add).sort(), [A, B]);
});

test("a copy that names everybody keeps and removes nobody, prune or not", async () => {
  for (const prune of [false, true]) {
    const env = await workspaceWithAandB();
    const both = { add: { ...onlyA().families["users:roster"].add, [B]: { email: B, role: "editor", addedAt: "2026-09-01T00:00:00.000Z" } }, remove: [] };
    const res = await W.importState(CTX, env, { format: 1, families: { "users:roster": both }, prune });
    assert.deepEqual(res.members, { kept: [], removed: [] }, `prune=${prune}`);
  }
});
