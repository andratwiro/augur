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
  TENANT_SCHEMA, TENANT_SCHEMA_VERSION, TENANT_SCHEMA_ADDITIONS, FORBIDDEN_COLUMNS,
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

test("a table built at an EARLIER version gains its new columns", () => {
  // ⚠️ `CREATE TABLE IF NOT EXISTS` IS NOT A MIGRATION. An object provisioned at schema
  // version 1 already has `members` and `publish_tokens`, so the statements naming the new
  // columns are no-ops on exactly the workspaces that have been running longest — and the
  // difference shows up as a roster read answering `undefined`. This drives the real
  // version-1 DDL and then applies today's schema over it.
  const db = new DatabaseSync(":memory:");
  const sql = sqlHandle(db);
  sql.exec(`CREATE TABLE members (
     email TEXT PRIMARY KEY, role TEXT NOT NULL CHECK (role IN ('admin','editor','viewer')),
     name TEXT, avatar_key TEXT, avatar_mime TEXT, avatar_at TEXT,
     added_at TEXT NOT NULL, removed_at TEXT)`);
  sql.exec(`CREATE TABLE publish_tokens (
     token_hash TEXT PRIMARY KEY, label TEXT, created_at TEXT NOT NULL, expires_at TEXT)`);
  // A row written by the older build, which the migration must not disturb.
  sql.exec(`INSERT INTO members (email, role, name, added_at) VALUES ('old@x.test','admin','Old','2026-01-01')`);

  applyTenantSchema(sql, "acme");

  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name).sort();
  for (const { table, column } of TENANT_SCHEMA_ADDITIONS) {
    assert.ok(cols(table).includes(column), `${table}.${column} was not added to an existing table`);
  }
  const row = db.prepare(`SELECT email, role, name, initials FROM members`).all()[0];
  assert.equal(row.email, "old@x.test", "the migration dropped a row it was supposed to widen");
  assert.equal(row.name, "Old");
  assert.equal(row.initials, null, "a new column on an old row is null, never a default nobody chose");
  assert.equal(Number(db.prepare(`SELECT v FROM meta WHERE k = 'schema_version'`).all()[0].v),
    TENANT_SCHEMA_VERSION, "the version was not moved with the columns");
});

test("every addition is also in the CREATE statement, so a fresh object and a migrated one agree", () => {
  // Two lists that can drift are two schemas. A column added to `TENANT_SCHEMA_ADDITIONS`
  // and not to the CREATE would exist only on old workspaces; the other way round, only on
  // new ones. Both are read from the tables SQLite actually built.
  const db = new DatabaseSync(":memory:");
  applyTenantSchema(sqlHandle(db), "acme");
  for (const { table, column } of TENANT_SCHEMA_ADDITIONS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    assert.ok(cols.includes(column), `${table}.${column} is an addition the CREATE does not name`);
  }
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
  // `destroy` is the erasure primitive it does not call. `suspension` is separate from
  // `status` because it is the one method on the REQUEST PATH — three indexed reads, not
  // five counts and a page total — see B-suspend-check-in-resolver. `importAll` is
  // `importOverlay` plus the identity families, in one transaction, and `importOverlay` is
  // kept as the name its existing callers use — see test/kv-adopt-identity.test.mjs.
  // `resumeOnSignIn` is NOT a fifth operator verb and is deliberately absent from
  // `CONTROL_VERBS`: it is the REQUEST PATH asking the workspace about itself, the side of
  // the line `suspension` and `touchActivity` are on, and nobody should be grantable it —
  // see E-dormancy-resume and test/dormancy-resume.test.mjs.
  // `renameAway` is the CUT-OVER half of F-subdomain-rename-delete-ux: it marks THIS address
  // dead and moves nothing, because a workspace's address is its object's name and moving is
  // a migration — see test/workspace-rename.test.mjs.
  // `overlayScopes` is the one overlay read no PAGE wants: every request-path caller already
  // knows whose scope it is asking about, and a COPY is the caller that cannot. Without it an
  // export off this backing omitted every person's sidebar and called itself complete — see
  // test/state-export-absent.test.mjs.
  // The `invite*` and `lastseen*` verbs are B-kv-read-cutover: two identity families whose
  // reads now come from here, each with exactly the verbs its ONE accessor in the worker
  // wants and no more. `inviteRead` and `inviteConsume` are separate because a page load
  // must be able to ask without burning the link — `invitePost` validates the password
  // first, so a typo does not cost somebody their only way in. `inviteRevoke` and
  // `lastseenForget` exist because removal has to reach BOTH stores for as long as the
  // family is straddled; see KV_CUTOVER in src/_worker.js. There is no `secrets*` verb and
  // there must never be one — a credential is account-level, and `effectiveSecret` moving is
  // B-cross-workspace-signin's, not this item's.
  // `rosterRead`/`rosterWrite` and the four `publishToken*` verbs are the SECOND slice of
  // the same item. `rosterRead` answers with the four KV documents rather than with a
  // roster, so the worker's serving pipeline is one pipeline fed from either store instead
  // of two that have to be kept in agreement; `rosterWrite` takes whole documents for the
  // same reason, because that is the unit the KV path writes and the straddle mirrors.
  // `publishTokenRead` is separate from `publishTokenList` because the request path wants
  // one token and only the admin panel wants all of them, and a request-path read that had
  // to page the whole map would be the KV shape this move is getting away from.
  // `publishedSpaces` is the read side of `nextPublishVersion` and the ONLY record of which
  // spaces are a workspace's: the bundle store keys name a space and carry no workspace
  // segment, so a listing of that bucket cannot say whose anything is. Without it the
  // erasure inferred ownership from a string prefix no key has ever carried, matched
  // nothing, and reported a clean delete of everything — see test/delete-workspace.test.mjs.
  const names = Object.getOwnPropertyNames(TenantStore.prototype).filter((n) => n !== "constructor");
  assert.deepEqual(names.sort(), [
    "bumpCounter", "clearMeta", "controlResult", "deleteWorkspace", "destroy", "fetch",
    "hasMeta", "importAll", "importOverlay", "init",
    "inviteConsume", "inviteMint", "inviteRead", "inviteRevoke",
    "isProvisioned",
    "lastseenForget", "lastseenRead", "lastseenTouch",
    "members",
    "nextPublishVersion",
    "overlayCas", "overlayInsert", "overlayOwner", "overlayRead", "overlayReadRev",
    "overlayReplace", "overlayScopes", "overlaySet", "provision",
    "publishTokenList", "publishTokenMint", "publishTokenRead", "publishTokenRevoke",
    "publishedSpaces",
    "purgeAuthor", "quotas", "readCounter", "readMeta", "renameAway", "resume",
    "resumeOnSignIn", "rosterRead", "rosterWrite", "rotate", "schemaVersion",
    "sessionKey",
    "sql", "status", "suspend", "suspension", "touchActivity",
    "usersActive", "workspaceId", "writeMeta",
  ]);
});
