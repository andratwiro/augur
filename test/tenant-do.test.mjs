// The workspace Durable Object's schema, executed rather than eyeballed.
//
// `B-do-schema-core`. The schema is run against a REAL SQLite engine (`node:sqlite`), so
// "the migration is clean" is something this test finds out rather than asserts. A schema
// test that only pattern-matches its own source proves the source is spelled the way it is
// spelled.
//
// Two properties matter more than the tables:
//   · one workspace's storage cannot be read from another's, structurally;
//   · no credential is in here, and that is CHECKED against what SQLite actually built.
//
// WHAT THIS DOES NOT PROVE, and how that gap was closed. `node:sqlite` is not workerd:
// it says the SQL is valid, not that a Durable Object namespace accepts it. So the same
// class was run under `wrangler dev --local` with a real `new_sqlite_classes` migration —
// two workspace ids, a member written into one, the other reading zero, each object
// reporting its own id — and the migration re-applied cleanly over populated storage on a
// cold object after a restart. Repeat it by binding this class in any wrangler.toml; the
// commented block in templates/shell/wrangler.example.toml is the shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  TENANT_SCHEMA, TENANT_SCHEMA_VERSION, FORBIDDEN_COLUMNS,
  applyTenantSchema, TenantStore,
} from "../src/tenant-do.js";

/** A stand-in for a Durable Object's SQLite handle, backed by a real in-memory database. */
function sqlHandle(db) {
  return {
    exec(stmt, ...params) {
      if (params.length) { db.prepare(stmt).run(...params); return []; }
      // A SELECT has rows to hand back; DDL does not.
      if (/^\s*SELECT/i.test(stmt)) return db.prepare(stmt).all();
      db.exec(stmt);
      return [];
    },
  };
}

/** A whole workspace object, with its own database — which is the isolation being tested. */
function workspace(id) {
  const db = new DatabaseSync(":memory:");
  const ctx = { storage: { sql: sqlHandle(db) }, blockConcurrencyWhile: async (f) => f() };
  return { db, store: new TenantStore(ctx, {}), id };
}

// ── the schema is real SQL ───────────────────────────────────────────────────

test("every statement executes against a real SQLite engine", () => {
  const db = new DatabaseSync(":memory:");
  for (const stmt of TENANT_SCHEMA) db.exec(stmt); // throws on invalid SQL
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(tables, ["blobs", "counters", "invites", "lastseen", "members", "meta", "overlay", "publish_tokens", "publish_versions", "quotas", "settings", "signing_keys"]);
});

test("applying it twice changes nothing — a migration is idempotent or it is a hazard", () => {
  const db = new DatabaseSync(":memory:");
  const sql = sqlHandle(db);
  applyTenantSchema(sql, "acme");
  applyTenantSchema(sql, "acme");
  assert.equal(db.prepare("SELECT v FROM meta WHERE k='schema_version'").get().v, String(TENANT_SCHEMA_VERSION));
  assert.equal(db.prepare("SELECT COUNT(*) c FROM meta").get().c, 2);
});

test("the workspace id is written once and never overwritten", () => {
  // An object that could be told it is a different workspace is an object that can be
  // pointed at somebody else's data.
  const db = new DatabaseSync(":memory:");
  const sql = sqlHandle(db);
  applyTenantSchema(sql, "acme");
  applyTenantSchema(sql, "somebody-else");
  assert.equal(db.prepare("SELECT v FROM meta WHERE k='workspace'").get().v, "acme");
});

test("the role column refuses a value that is not a role", () => {
  const db = new DatabaseSync(":memory:");
  applyTenantSchema(sqlHandle(db), "acme");
  db.prepare("INSERT INTO members (email, role, added_at) VALUES (?,?,?)").run("a@b.test", "editor", "t");
  assert.throws(
    () => db.prepare("INSERT INTO members (email, role, added_at) VALUES (?,?,?)").run("c@d.test", "superuser", "t"),
    /CHECK|constraint/i,
    "the schema accepted a role that does not exist",
  );
});

// ── the isolation, structurally ──────────────────────────────────────────────

test("A MEMBER WRITTEN INTO ONE WORKSPACE IS INVISIBLE FROM ANOTHER", async () => {
  // The item's VERIFY, and the reason the whole DO model was chosen: there is no key you
  // can construct in workspace A that reads workspace B, because there is no shared
  // namespace to construct it in. Contrast the KV design this replaces, where
  // `users:roster` is one document for every workspace an isolate serves.
  const a = workspace("alpha");
  const b = workspace("beta");
  await a.store.init("alpha");
  await b.store.init("beta");

  a.db.prepare("INSERT INTO members (email, role, added_at) VALUES (?,?,?)").run("only-in-alpha@example.test", "admin", "t");

  assert.equal(a.db.prepare("SELECT COUNT(*) c FROM members").get().c, 1);
  assert.equal(b.db.prepare("SELECT COUNT(*) c FROM members").get().c, 0, "a member written into alpha was visible in beta");
  assert.equal(b.db.prepare("SELECT COUNT(*) c FROM members WHERE email = ?").get("only-in-alpha@example.test").c, 0);

  // And each object knows which one it is, from its own storage rather than from a request.
  assert.equal(a.store.workspaceId(), "alpha");
  assert.equal(b.store.workspaceId(), "beta");
});

test("a publish token in one workspace is not a token in another", async () => {
  const a = workspace("alpha");
  const b = workspace("beta");
  await a.store.init("alpha");
  await b.store.init("beta");
  a.db.prepare("INSERT INTO publish_tokens (token_hash, label, created_at) VALUES (?,?,?)").run("hash-1", "ci", "t");
  assert.equal(b.db.prepare("SELECT COUNT(*) c FROM publish_tokens WHERE token_hash=?").get("hash-1").c, 0);
});

// ── the credential that must not be here ─────────────────────────────────────

test("NO TABLE STORES A PASSWORD, A HASH OF ONE, OR ANY REUSABLE SECRET", () => {
  // Read off the tables SQLite actually built, not off the schema text — a check that
  // greps its own source proves the source is spelled the way it is spelled.
  //
  // The reason this is a test and not a comment: a workspace that could reset a credential
  // could reach every other workspace that address opens. A workspace admin would silently
  // become an admin of a colleague's unrelated workspace by resetting a shared password.
  const db = new DatabaseSync(":memory:");
  applyTenantSchema(sqlHandle(db), "acme");
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  const offences = [];
  for (const t of tables) {
    for (const col of db.prepare(`PRAGMA table_info(${t})`).all()) {
      const name = String(col.name).toLowerCase();
      for (const bad of FORBIDDEN_COLUMNS) {
        // Whole-word-ish: `token_hash` is fine and must stay fine, `pass_hash` is not.
        if (name === bad || name.startsWith(bad + "_") || name.endsWith("_" + bad)) {
          offences.push(`${t}.${col.name}`);
        }
      }
    }
  }
  assert.deepEqual(offences, [], "the workspace store grew a credential column");
});

test("what IS stored of a token is only its hash", () => {
  // Invites and publish tokens both. A read of this storage — a backup, an export, an
  // operator looking — must not be able to redeem or publish.
  const db = new DatabaseSync(":memory:");
  applyTenantSchema(sqlHandle(db), "acme");
  for (const t of ["invites", "publish_tokens"]) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    assert.ok(cols.includes("token_hash"), `${t} has no token_hash`);
    assert.ok(!cols.includes("token"), `${t} stores a token in the clear`);
  }
});

// ── the shape the settled architecture asks for ──────────────────────────────

test("a member has ONE role, because a workspace is the only tier", () => {
  // `users:spaces` mapped an address to a role per space, because a deployment used to
  // mount several. Anyone reinstating that should put it in the membership model rather
  // than resurrect the map.
  const db = new DatabaseSync(":memory:");
  applyTenantSchema(sqlHandle(db), "acme");
  const cols = db.prepare("PRAGMA table_info(members)").all().map((c) => c.name);
  assert.ok(cols.includes("role"));
  assert.ok(!cols.some((c) => /spaces?$/.test(c)), "the per-space role map came back");
});

test("removal is a tombstone, not a deleted row", () => {
  // The KV design learned this on the credential side: a removal that merely deletes is
  // undone by any fallback, and a re-invited address must not inherit the last person's role.
  const db = new DatabaseSync(":memory:");
  applyTenantSchema(sqlHandle(db), "acme");
  assert.ok(db.prepare("PRAGMA table_info(members)").all().some((c) => c.name === "removed_at"));
});

test("the store exposes no read or write verb it does not yet need", () => {
  // The schema is what this item is for; the verbs arrive with the families that move onto
  // them. Speculative methods would be guesses at call sites that do not exist. `quotas`
  // is here because B-quota-schema put ceilings in this object and every enforcement point
  // to come reads them from one place — see test/tenant-quotas.test.mjs. The rest arrived
  // with B-provisioning-atomic, which needs to create a workspace and to answer whether it
  // exists — see test/tenant-provisioning.test.mjs. The four operator verbs and the three
  // `meta` accessors they share arrived with B-control-plane-verbs — see
  // test/tenant-verbs.test.mjs, and note that `deleteWorkspace` is a TOMBSTONE while
  // `destroy` is the erasure primitive it does not call.
  const names = Object.getOwnPropertyNames(TenantStore.prototype).filter((n) => n !== "constructor");
  assert.deepEqual(names.sort(), [
    "bumpCounter", "clearMeta", "controlResult", "deleteWorkspace", "destroy", "fetch",
    "hasMeta", "importOverlay", "init", "isProvisioned", "members",
    "nextPublishVersion",
    "overlayCas", "overlayInsert", "overlayOwner", "overlayRead", "overlayReadRev",
    "overlayReplace", "overlaySet", "provision",
    "quotas", "readCounter", "readMeta", "resume", "rotate", "schemaVersion", "sessionKey",
    "sql", "status", "suspend", "touchActivity",
    "usersActive", "workspaceId", "writeMeta",
  ]);
});
