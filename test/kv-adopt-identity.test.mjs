// Adopting KV's identity families into the workspace object — the copy, not the cutover.
//
// `B-kv-to-do-migration-tool`. `importOverlay` already lands the content families in one
// transaction. The identity families — the roster, the invites, the publish tokens, the
// last-seen stamps, the small blobs — had tables and no write path, so `importState` in
// the worker skipped them and `replayFamilies` put them back into KV.
//
// NOTHING READS WHAT THIS WRITES. Cutting the reads over is `B-kv-read-cutover`. The value
// of the split is that this half cannot take an instance down: the object gains a second
// copy, KV stays authoritative, and a run that goes wrong is fixed by running it again.
//
// WHY A REAL TRANSACTION IN THE HARNESS. The other DO tests hand `ctx.storage` only a `sql`
// handle, so `transactionSync` is absent and the code takes its documented non-atomic path.
// That is fine for testing what gets written and useless for testing what happens when a row
// halfway through is refused — which is the property this file exists for. So this harness
// gives `transactionSync` a real BEGIN/COMMIT/ROLLBACK.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { TenantStore } from "../src/tenant-do.js";

function sqlHandle(db) {
  return {
    exec(stmt, ...params) {
      if (params.length) { db.prepare(stmt).run(...params); return []; }
      if (/^\s*SELECT/i.test(stmt)) return db.prepare(stmt).all();
      db.exec(stmt);
      return [];
    },
  };
}

function workspace(id = "ws-adopt") {
  const db = new DatabaseSync(":memory:");
  const storage = {
    sql: sqlHandle(db),
    transactionSync(body) {
      db.exec("BEGIN");
      try { const out = body(); db.exec("COMMIT"); return out; }
      catch (e) { db.exec("ROLLBACK"); throw e; }
    },
  };
  const store = new TenantStore({ storage, blockConcurrencyWhile: async (f) => f() }, {});
  return { db, store, id };
}

const rows = (db, sql) => db.prepare(sql).all();

/** A believable shape of what the worker hands over, already hashed and already translated. */
function identityFixture() {
  return {
    members: [
      { email: "owner@example.com", role: "admin", name: "Owner", addedAt: "2026-08-01T00:00:00.000Z" },
      { email: "viewer@example.com", role: "viewer", name: "Vee", addedAt: "2026-08-02T00:00:00.000Z" },
      // A removal is a tombstone, never an absent row: re-inviting an address must not
      // inherit the last person's role.
      { email: "gone@example.com", role: "editor", name: "Gone", addedAt: "2026-08-01T00:00:00.000Z", removedAt: "2026-08-10T00:00:00.000Z" },
    ],
    invites: [
      { tokenHash: "hash-of-invite-1", email: "new@example.com", createdAt: "2026-08-20T00:00:00.000Z", expiresAt: "2026-08-27T00:00:00.000Z", createdBy: null },
    ],
    publishTokens: [
      { tokenHash: "hash-of-pub-1", label: "owner@example.com", createdAt: "2026-08-05T00:00:00.000Z", expiresAt: null },
    ],
    lastseen: [{ email: "owner@example.com", at: "2026-08-26T09:00:00.000Z" }],
    blobs: [{ key: "av1", mime: "image/png", body: "data:image/png;base64,AAA", at: "2026-08-03T00:00:00.000Z" }],
  };
}

test("every identity family lands in its own table", async () => {
  const w = workspace();
  await w.store.init(w.id);
  const out = w.store.importAll({ identity: identityFixture(), at: "2026-08-26T10:00:00.000Z" });

  assert.equal(out.atomic, true, "a runtime with transactionSync must report an atomic write");

  const members = rows(w.db, "SELECT email, role, name, removed_at FROM members ORDER BY email");
  assert.equal(members.length, 3);
  assert.equal(members.find((m) => m.email === "owner@example.com").role, "admin");
  assert.equal(members.find((m) => m.email === "gone@example.com").removed_at, "2026-08-10T00:00:00.000Z");

  assert.equal(rows(w.db, "SELECT * FROM invites")[0].token_hash, "hash-of-invite-1");
  assert.equal(rows(w.db, "SELECT * FROM publish_tokens")[0].label, "owner@example.com");
  assert.equal(rows(w.db, "SELECT * FROM lastseen")[0].at, "2026-08-26T09:00:00.000Z");
  assert.equal(rows(w.db, "SELECT * FROM blobs")[0].key, "av1");
});

test("a role the schema does not allow is skipped and named, not fatal", async () => {
  // KV's `users:roles` is a free-text map; `members.role` has a CHECK constraint. One bad
  // value must not abort a copy of somebody's whole workspace — but it must not vanish
  // silently either, or the roster arrives quietly short a person.
  const w = workspace();
  await w.store.init(w.id);
  const id = identityFixture();
  id.members.push({ email: "odd@example.com", role: "superuser", name: "Odd", addedAt: "2026-08-01T00:00:00.000Z" });

  const out = w.store.importAll({ identity: id, at: "2026-08-26T10:00:00.000Z" });

  assert.equal(rows(w.db, "SELECT * FROM members").length, 3, "the three valid members still land");
  assert.deepEqual(out.refused, [{ family: "members", key: "odd@example.com", why: "role 'superuser' is not admin, editor or viewer" }]);
});

test("running it twice leaves what running it once left", async () => {
  const w = workspace();
  await w.store.init(w.id);
  const fx = identityFixture();
  w.store.importAll({ identity: fx, at: "2026-08-26T10:00:00.000Z" });
  const first = rows(w.db, "SELECT email, role, name, added_at, removed_at FROM members ORDER BY email");
  w.store.importAll({ identity: fx, at: "2026-08-26T11:00:00.000Z" });
  const second = rows(w.db, "SELECT email, role, name, added_at, removed_at FROM members ORDER BY email");

  assert.deepEqual(second, first, "a re-run is a no-op, so a killed run is fixed by running it again");
  assert.equal(rows(w.db, "SELECT * FROM invites").length, 1);
  assert.equal(rows(w.db, "SELECT * FROM publish_tokens").length, 1);
});

test("the overlay and the identity land in ONE transaction", async () => {
  // The property that makes a failed copy survivable: a workspace never holds some families
  // from the copy and some from before it, which is a state matching no moment in time.
  const w = workspace();
  await w.store.init(w.id);
  const id = identityFixture();
  // A blob with no body violates NOT NULL — a real refusal from SQLite, mid-write.
  id.blobs.push({ key: "broken", mime: "image/png", body: null, at: "2026-08-03T00:00:00.000Z" });

  assert.throws(() => w.store.importAll({
    overlay: { statuses: { "": { "a/b": "done" } } },
    identity: id,
    at: "2026-08-26T10:00:00.000Z",
  }));

  assert.equal(rows(w.db, "SELECT * FROM overlay").length, 0, "the overlay write rolled back with the identity write");
  assert.equal(rows(w.db, "SELECT * FROM members").length, 0, "and so did the members that had already been inserted");
});

test("no credential is written, whatever the caller sends", async () => {
  // `users:secrets` goes to the account store, never here: a workspace that held a password
  // hash could reach every other workspace that address opens. The object refuses rather
  // than trusting the worker to have filtered it.
  const w = workspace();
  await w.store.init(w.id);
  const id = identityFixture();
  id.secrets = { "owner@example.com": "a-credential-shaped-value" };
  id.members[0].secret = "another-credential-shaped-value";

  w.store.importAll({ identity: id, at: "2026-08-26T10:00:00.000Z" });

  const cols = rows(w.db, "PRAGMA table_info(members)").map((c) => c.name);
  assert.ok(!cols.some((c) => /secret|password|hash|pbkdf2/i.test(c)), "members has no credential column");
  const tables = rows(w.db, "SELECT name FROM sqlite_master WHERE type='table'").map((t) => t.name);
  assert.ok(!tables.includes("secrets"), "no secrets table was conjured by a caller sending one");
});
