// Creating a workspace either happens or does not happen.
//
// `B-provisioning-atomic`. Provisioning writes four things — the workspace's id, its first
// admin, its own session-signing key, its quota ceilings. A half-written workspace is the
// worst outcome available here, and every version of it is quiet: a workspace with no
// admin nobody can get into, a workspace with no signing key whose sessions cannot be
// verified, a workspace with no ceilings that has no limits.
//
// So `provisioned_at` is written LAST and is the only row anything else reads to decide
// whether this workspace exists. A crash above it leaves the flag unset and the workspace
// unresolvable — correct by ordering, before any transaction is involved. The transaction
// is the belt on top of that brace, and the tests below check both separately, because a
// runtime that lacks `transactionSync` must still get the right answer.
//
// THE SECRET THAT IS DELIBERATELY HERE. `signing_keys` holds the workspace's own HMAC key.
// Today that is `env.SESSION_SECRET`, ONE value for the whole Worker — fine while a Worker
// serves one workspace, and forgeable across every workspace the moment it serves several.
// The distinction this file pins is the one the schema's header states: nothing here
// authenticates a PERSON. A password is a person's, reused elsewhere, reachable by whoever
// administers any workspace they belong to. A signing key is the workspace's own, used
// nowhere else, and reading it reaches exactly the workspace whose storage it came from.
//
// THE TRANSACTION STUB BELOW IS MINE, so it was checked against the real thing. Under
// `wrangler dev --local` with a real Durable Object namespace: `ctx.storage.transactionSync`
// exists, a throw inside it left NOTHING behind (not provisioned, no member, no signing
// key), a subsequent provision of that same object completed cleanly, a second provision of
// an already-provisioned workspace kept the first admin, and `crypto.getRandomValues` in a
// DO produced the 64-hex key. Repeat it by binding this class in any wrangler.toml.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  applyTenantSchema, applyProvisioning, newSigningKey, TenantStore, FORBIDDEN_COLUMNS,
} from "../src/tenant-do.js";
import { PLANS, QUOTA_FIELDS } from "../src/tenant-quotas.mjs";

/** A DO storage stub with REAL transaction semantics, so rollback is tested and not mimed. */
function storage(db) {
  const sql = {
    exec(stmt, ...params) {
      if (params.length) { db.prepare(stmt).run(...params); return []; }
      if (/^\s*SELECT/i.test(stmt)) return db.prepare(stmt).all();
      db.exec(stmt);
      return [];
    },
  };
  return {
    sql,
    transactionSync(cb) {
      db.exec("BEGIN");
      try { const out = cb(); db.exec("COMMIT"); return out; }
      catch (e) { db.exec("ROLLBACK"); throw e; }
    },
  };
}
function workspace({ transactions = true } = {}) {
  const db = new DatabaseSync(":memory:");
  const st = storage(db);
  if (!transactions) delete st.transactionSync;
  const ctx = { storage: st, blockConcurrencyWhile: async (f) => f() };
  return { db, store: new TenantStore(ctx, {}) };
}

const ADMIN = "first@example.test";
// node:sqlite hands back null-prototype rows; deepStrictEqual counts the prototype.
const plain = (rows) => rows.map((r) => ({ ...r }));

// ── the happy path ───────────────────────────────────────────────────────────

test("A PROVISIONED WORKSPACE HAS ALL FOUR THINGS, and says so", async () => {
  const { db, store } = workspace();
  const r = await store.provision({ workspaceId: "acme", adminEmail: ADMIN, adminName: "First" });
  assert.equal(r.created, true);
  assert.ok(store.isProvisioned());
  assert.equal(store.workspaceId(), "acme");
  assert.deepEqual(plain(store.members()), [{ email: ADMIN, role: "admin", name: "First" }]);
  assert.equal(store.usersActive(), true);
  assert.match(store.sessionKey(), /^[0-9a-f]{64}$/);
  for (const f of QUOTA_FIELDS) assert.equal(store.quotas()[f], PLANS.free[f], f);
  assert.equal(db.prepare("SELECT v FROM meta WHERE k='created_at'").get().v, r.provisionedAt);
});

test("the address is folded the way an address is folded", async () => {
  // The first admin signs in with whatever case their mail client sends. A row stored
  // verbatim is a workspace whose only admin cannot get in.
  const { store } = workspace();
  await store.provision({ workspaceId: "acme", adminEmail: "  First@Example.TEST " });
  assert.equal(store.members()[0].email, "first@example.test");
});

test("a workspace can be provisioned straight onto a paid plan", async () => {
  const { store } = workspace();
  await store.provision({ workspaceId: "acme", adminEmail: ADMIN, plan: "paid" });
  assert.equal(store.quotas().plan, "paid");
  assert.equal(store.quotas().editorSeatLimit, PLANS.paid.editorSeatLimit);
});

// ── the half-state that must not exist ───────────────────────────────────────

test("A CRASH MID-PROVISION LEAVES NOTHING BEHIND — the transaction rolls back", async () => {
  // The VERIFY's first half, simulated where it can actually happen: the storage throws
  // partway through the write. Everything above the throw must be gone.
  const db = new DatabaseSync(":memory:");
  const st = storage(db);
  applyTenantSchema(st.sql, "acme");
  const real = st.sql.exec.bind(st.sql);
  let calls = 0;
  st.sql.exec = (stmt, ...p) => {
    // Die after the signing key and the admin are in, before the flag.
    if (++calls === 4) throw new Error("the isolate went away");
    return real(stmt, ...p);
  };
  assert.throws(() => st.transactionSync(() => applyProvisioning(st.sql, { workspaceId: "acme", adminEmail: ADMIN })));
  st.sql.exec = real;

  assert.equal(db.prepare("SELECT COUNT(*) c FROM meta WHERE k='provisioned_at'").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM members").get().c, 0, "an admin survived a rolled-back provision");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM signing_keys").get().c, 0, "a signing key survived a rolled-back provision");
});

test("and WITHOUT transactions the answer is still right, because the flag is written last", async () => {
  // A runtime with no transactionSync — and the reason the ordering is not merely tidy.
  // Rows may survive, but nothing reads them: the workspace does not exist until the flag
  // does, and re-provisioning completes it rather than duplicating it.
  const { db, store } = workspace({ transactions: false });
  await store.init("acme");
  const real = store.ctx.storage.sql.exec.bind(store.ctx.storage.sql);
  let calls = 0;
  store.ctx.storage.sql.exec = (stmt, ...p) => {
    if (++calls === 4) throw new Error("the isolate went away");
    return real(stmt, ...p);
  };
  await assert.rejects(store.provision({ workspaceId: "acme", adminEmail: ADMIN }));
  store.ctx.storage.sql.exec = real;

  assert.equal(store.isProvisioned(), false, "a crashed provision looked provisioned");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM meta WHERE k='provisioned_at'").get().c, 0);

  // And the retry finishes the job rather than making a second half.
  const r = await store.provision({ workspaceId: "acme", adminEmail: ADMIN });
  assert.equal(r.created, true);
  assert.equal(store.isProvisioned(), true);
  assert.equal(store.members().length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM signing_keys").get().c, 1);
});

// ── two provisions of one slug ───────────────────────────────────────────────

test("PROVISIONING THE SAME WORKSPACE TWICE IS A NO-OP, key and admin unchanged", async () => {
  // Two concurrent signups on one slug reach the SAME Durable Object, so this is what
  // "overlapping slugs" reduces to once the object is the unit. The second must not mint a
  // second signing key — that would sign the first one's sessions out — and must not
  // replace the first admin.
  const { store } = workspace();
  const first = await store.provision({ workspaceId: "acme", adminEmail: ADMIN, adminName: "First" });
  const key = store.sessionKey();
  const second = await store.provision({ workspaceId: "acme", adminEmail: "someone-else@example.test", adminName: "Later" });
  assert.equal(second.created, false);
  assert.equal(second.provisionedAt, first.provisionedAt);
  assert.equal(store.sessionKey(), key, "a second provision rotated the signing key");
  assert.deepEqual(plain(store.members()), [{ email: ADMIN, role: "admin", name: "First" }]);
});

test("a hundred workspaces provision concurrently and none is left half-seeded", async () => {
  // The VERIFY's fuzz, at the level it means something: each workspace is its own object
  // with its own storage, so what this actually checks is that nothing in the provisioning
  // body depends on shared state — a module-scope key, a cached timestamp, a counter.
  const all = Array.from({ length: 100 }, (_, i) => workspace());
  await Promise.all(all.map(({ store }, i) =>
    store.provision({ workspaceId: `ws-${i}`, adminEmail: `a${i}@example.test` })));
  const keys = new Set();
  all.forEach(({ store }, i) => {
    assert.ok(store.isProvisioned(), `ws-${i} is not provisioned`);
    assert.equal(store.workspaceId(), `ws-${i}`);
    assert.equal(store.members().length, 1, `ws-${i} has ${store.members().length} members`);
    assert.match(store.sessionKey(), /^[0-9a-f]{64}$/, `ws-${i} has no signing key`);
    assert.equal(Object.keys(store.quotas()).length, QUOTA_FIELDS.length + 1);
    keys.add(store.sessionKey());
  });
  assert.equal(keys.size, 100, "two workspaces were given the same signing key");
});

// ── what this path may never write ───────────────────────────────────────────

test("NO PASSWORD IS WRITTEN BY THIS PATH, and there is nowhere to put one", async () => {
  // The VERIFY's last line. Two ways of checking, because they fail differently: the
  // signature has no parameter a caller could pass a secret through, and the tables SQLite
  // built afterwards hold no column that could receive one.
  const { db, store } = workspace();
  await store.provision({
    workspaceId: "acme", adminEmail: ADMIN,
    // Everything a caller might hopefully pass. None of it has anywhere to go.
    password: "hunter2", passHash: "$pbkdf2$...", secret: "nope",
  });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const t of tables) {
    for (const col of db.prepare(`PRAGMA table_info(${t})`).all()) {
      const name = String(col.name).toLowerCase();
      for (const bad of FORBIDDEN_COLUMNS) {
        assert.ok(!(name === bad || name.startsWith(bad + "_") || name.endsWith("_" + bad)),
          `${t}.${col.name} could hold a person's credential`);
      }
    }
  }
  const dump = JSON.stringify(
    tables.map((t) => db.prepare(`SELECT * FROM ${t}`).all()));
  for (const leaked of ["hunter2", "pbkdf2", "nope"]) {
    assert.ok(!dump.includes(leaked), `provisioning stored ${leaked}`);
  }
});

test("the only secret in here is the workspace's own, and there is exactly one of it", async () => {
  const { db, store } = workspace();
  await store.provision({ workspaceId: "acme", adminEmail: ADMIN });
  assert.deepEqual(plain(db.prepare("SELECT purpose FROM signing_keys").all()), [{ purpose: "session" }]);
  // The CHECK is what stops this table quietly becoming a place to keep secrets.
  assert.throws(
    () => db.prepare("INSERT INTO signing_keys (purpose, key, created_at) VALUES ('password','x','t')").run(),
    /CHECK|constraint/i,
    "signing_keys accepted a purpose that is not a signing key",
  );
});

test("a signing key is 32 bytes of CSPRNG, never a value handed in from an env var", async () => {
  // The failure being designed out: env.SESSION_SECRET is ONE value for the whole Worker,
  // so anyone holding it could mint a valid session cookie for a neighbouring workspace.
  const seen = new Set(Array.from({ length: 200 }, () => newSigningKey()));
  assert.equal(seen.size, 200, "the key generator repeats");
  for (const k of seen) assert.match(k, /^[0-9a-f]{64}$/);
  // Deterministic randomness proves the bytes come from the source, not from anywhere else.
  assert.equal(newSigningKey((b) => b.fill(0)), "0".repeat(64));
  assert.equal(newSigningKey((b) => b.fill(255)), "f".repeat(64));
});

test("it refuses to provision a workspace with no id or no admin", async () => {
  // Half the arguments is the other way to get a workspace nobody can get into.
  const { store } = workspace();
  await assert.rejects(store.provision({ adminEmail: ADMIN }), /workspace id/);
  await assert.rejects(store.provision({ workspaceId: "acme" }), /admin address/);
  assert.equal(store.isProvisioned(), false);
});
