// A capability-restricted publish token, once the workspace object is the thing that
// answers for it.
//
// `capabilityRefusal` in src/_worker.js is deny-by-default over a `caps` field on the token
// RECORD, and it is what lets the control plane hold a purge-only bearer instead of a star
// token that could publish over every workspace's content. KV carries that field.
//
// ⚠️ THE OBJECT DID NOT. `publish_tokens` had `token_hash, label, created_at, expires_at,
// scope` and no `caps` column, so a copy of a KV record into the object DROPPED the
// restriction — and `publishAuthDetailed` reads the object FIRST. The narrow credential came
// back from the object as `{space: "*"}` with no `caps` at all, `capabilityRefusal` read
// "absent means unrestricted, exactly as before this existed", and the purge bearer became
// a full star token: the one outcome its whole design exists to prevent. It needed no
// attacker and no bug elsewhere — a `restore --state`, a workspace migration, or an admin
// adding `caps` to a KV record for a token the object already held was enough.
//
// The column is the fix, and the NULL is the load-bearing half of it, exactly as it is for
// `scope`: a row a pre-`caps` copy wrote knows the token exists and does not know what it
// may do, and the only two answers available to invent are both wrong. So it is NO ANSWER
// and falls through to KV, which still holds the field.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  TENANT_SCHEMA_ADDITIONS, TENANT_SCHEMA_VERSION, applyTenantSchema, TenantStore,
} from "../src/tenant-do.js";
import { identityFromKv } from "../src/kv-identity.mjs";
import { __testables as W } from "../src/_worker.js";

/** The storage stub the other DO files use — a real SQLite engine behind a DO's `sql`. */
function storage(db) {
  const sql = {
    exec(stmt, ...params) {
      if (params.length) {
        const s = db.prepare(stmt);
        return /^\s*SELECT|RETURNING/i.test(stmt) ? s.all(...params) : (s.run(...params), []);
      }
      if (/^\s*SELECT/i.test(stmt)) return db.prepare(stmt).all();
      db.exec(stmt);
      return [];
    },
  };
  return { sql, transactionSync: (cb) => cb() };
}

function workspace() {
  const db = new DatabaseSync(":memory:");
  const st = storage(db);
  applyTenantSchema(st.sql, "acme");
  const store = new TenantStore({ storage: st, blockConcurrencyWhile: async (f) => f() }, {});
  store.ready = true;
  return { db, store };
}

const HASH = "h".repeat(32);

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE MIGRATION — an object built before the column gains it
// ─────────────────────────────────────────────────────────────────────────────

test("`caps` is an ADDITION, so an object built at the previous version gains it", () => {
  // ⚠️ `CREATE TABLE IF NOT EXISTS` IS NOT A MIGRATION. A workspace provisioned before this
  // column existed already has a `publish_tokens` table, so the CREATE naming the new column
  // is a no-op on exactly the workspaces that have been running longest — which are the ones
  // whose tokens a restore is most likely to have copied. This drives the real previous DDL
  // and applies today's schema over it.
  const db = new DatabaseSync(":memory:");
  const sql = storage(db).sql;
  sql.exec(`CREATE TABLE publish_tokens (
     token_hash TEXT PRIMARY KEY, label TEXT, created_at TEXT NOT NULL, expires_at TEXT, scope TEXT)`);
  sql.exec(`INSERT INTO publish_tokens (token_hash, label, created_at, scope)
              VALUES ('${HASH}', 'purge-job', '2026-01-01T00:00:00.000Z', '*')`);

  applyTenantSchema(sql, "acme");

  const cols = db.prepare(`PRAGMA table_info(publish_tokens)`).all().map((c) => c.name);
  assert.ok(cols.includes("caps"), "the caps column was not added to an existing table");
  const row = db.prepare(`SELECT * FROM publish_tokens`).all()[0];
  assert.equal(row.token_hash, HASH, "the migration dropped a row it was supposed to widen");
  assert.equal(row.scope, "*");
  assert.equal(row.caps, null, "a new column on an old row is null, never a default nobody chose");
});

test("the addition is declared in the list the schema test walks", () => {
  assert.ok(TENANT_SCHEMA_ADDITIONS.some((a) => a.table === "publish_tokens" && a.column === "caps"),
    "publish_tokens.caps is not in TENANT_SCHEMA_ADDITIONS, so old objects never grow it");
  assert.ok(TENANT_SCHEMA_VERSION >= 3, "the schema version did not move with the column");
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. NULL IS NO ANSWER — the half that closes the fail-open
// ─────────────────────────────────────────────────────────────────────────────

test("⚠️ A ROW WITH NO `caps` ANSWER IS NOT AN UNRESTRICTED TOKEN — it is no answer", async () => {
  // The whole bug, at the smallest scale it can be seen. The row exists, its scope is `*`,
  // and the object cannot say whether the token is narrow — because a copy that predates the
  // column wrote it. Answering "unrestricted" here is what promoted a purge bearer to a star
  // token; answering null sends the read to KV, which still holds the field.
  const w = workspace();
  w.db.exec(`INSERT INTO publish_tokens (token_hash, label, created_at, scope)
               VALUES ('${HASH}', 'purge-job', '2026-01-01T00:00:00.000Z', '*')`);
  assert.equal(w.store.publishTokenRead(HASH), null);
});

test("a token this object MINTED answers for itself — the straddle is not permanent", () => {
  // Every mint through the engine produces an unrestricted token, and the object knows that
  // rather than declining to say. Otherwise the column would send every read on a cut
  // deployment back to KV, which is the read volume this family moved to get away from.
  const w = workspace();
  w.store.publishTokenMint({ tokenHash: HASH, space: "*", label: "ci", createdAt: "2026-01-01T00:00:00.000Z" });
  const entry = w.store.publishTokenRead(HASH);
  assert.ok(entry, "the object declined to answer for a token it minted itself");
  assert.equal(entry.space, "*");
  assert.equal("caps" in entry, false, "an unrestricted token carries no caps field, exactly as KV spells it");
  assert.equal(W.capabilityRefusal(entry, "one", "commit"), null);
});

test("a scope this object cannot state is still no answer, caps or not", () => {
  // The pre-existing rule, unchanged: the two nulls are independent and either one alone
  // sends the read to KV.
  const w = workspace();
  w.db.exec(`INSERT INTO publish_tokens (token_hash, label, created_at, caps)
               VALUES ('${HASH}', 'ci', '2026-01-01T00:00:00.000Z', 'null')`);
  assert.equal(w.store.publishTokenRead(HASH), null);
});

test("a `caps` column this build cannot read is no answer, never a guess", () => {
  const w = workspace();
  w.db.exec(`INSERT INTO publish_tokens (token_hash, label, created_at, scope, caps)
               VALUES ('${HASH}', 'ci', '2026-01-01T00:00:00.000Z', '*', 'not json')`);
  assert.equal(w.store.publishTokenRead(HASH), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE COPY CARRIES IT — KV record → translation → object → read
// ─────────────────────────────────────────────────────────────────────────────

test("A PURGE BEARER SURVIVES A ROUND TRIP THROUGH THE OBJECT AS A PURGE BEARER", async () => {
  const kvDoc = {
    [HASH]: { space: "*", label: "purge-job", createdAt: "2026-01-01T00:00:00.000Z", caps: ["purge"] },
    ["s".repeat(32)]: { space: "*", label: "ci", createdAt: "2026-01-01T00:00:00.000Z" },
  };
  const { identity } = await identityFromKv({ "publish:tokens": kvDoc }, {
    configUsers: [], hashInvite: async (t) => "inv:" + t, now: "2026-01-01T00:00:00.000Z",
  });
  const narrow = identity.publishTokens.find((t) => t.tokenHash === HASH);
  assert.deepEqual(narrow.caps, ["purge"], "the translation dropped the capability");

  const w = workspace();
  // Across the wire, exactly as `/__publish/_state/import` sends it.
  w.store.importAll({ identity: JSON.parse(JSON.stringify(identity)), at: "2026-01-01T00:00:00.000Z" });

  const entry = w.store.publishTokenRead(HASH);
  assert.ok(entry, "the object could not answer for a token the copy carried in full");
  assert.deepEqual(entry.caps, ["purge"]);
  assert.equal(W.capabilityRefusal(entry, "_state", "delete"), null, "the purge job lost the two routes it needs");
  assert.equal(W.capabilityRefusal(entry, "one", "commit"), "capability-not-granted",
    "⚠️ the purge bearer came back out of the object able to publish");

  // And the ordinary token beside it is unrestricted, from the same copy.
  const plain = w.store.publishTokenRead("s".repeat(32));
  assert.equal("caps" in plain, false);
  assert.equal(W.capabilityRefusal(plain, "one", "commit"), null);
});

test("a re-run of an OLDER copy cannot blank a capability a newer one carried", () => {
  // The same COALESCE `scope` has, for the same reason: a copy from a source that does not
  // know about the field must leave the field alone rather than widen the token to
  // unrestricted. A copy that ran before this column existed carries no `caps` key at all.
  const w = workspace();
  w.store.importAll({
    identity: { publishTokens: [{ tokenHash: HASH, scope: "*", label: "purge-job", caps: ["purge"] }] },
    at: "2026-01-01T00:00:00.000Z",
  });
  w.store.importAll({
    identity: { publishTokens: [{ tokenHash: HASH, scope: "*", label: "purge-job" }] },
    at: "2026-01-02T00:00:00.000Z",
  });
  assert.deepEqual(w.store.publishTokenRead(HASH).caps, ["purge"]);
});

test("the admin panel's list carries the capability too", () => {
  // The panel shows the union of both stores with the object's rows winning, so a list that
  // dropped the field would show an operator a narrow credential as a full one.
  const w = workspace();
  w.store.importAll({
    identity: { publishTokens: [{ tokenHash: HASH, scope: "*", label: "purge-job", caps: ["purge"] }] },
    at: "2026-01-01T00:00:00.000Z",
  });
  assert.deepEqual(w.store.publishTokenList().tokens[HASH].caps, ["purge"]);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. AND THE SAME THING OVER THE REAL ROUTE
// ─────────────────────────────────────────────────────────────────────────────

function memR2(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async head(k) { return store.has(k) ? { etag: `e${store.get(k).length}` } : null; },
    async get(k) {
      const o = store.get(k);
      return o == null ? null : { body: o, etag: `e${o.length}`, text: async () => o };
    },
    async put(k, v) { store.set(k, typeof v === "string" ? v : Buffer.from(v).toString()); },
    async delete(k) { store.delete(k); },
    async list({ prefix = "", delimiter } = {}) {
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
      return { objects: keys.map((key) => ({ key, size: store.get(key).length })), truncated: false };
    },
  };
}

function memKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
    async list({ prefix = "" } = {}) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}

test("⚠️ THE PURGE BEARER CANNOT PUBLISH THROUGH THE REAL ROUTE ON A CUT DEPLOYMENT", async () => {
  // The failure as it would actually have happened: the token is in KV with its capability,
  // the workspace object also holds the row (a restore, a migration, or a mint followed by
  // an operator adding the field), and `publishAuthDetailed` reads the object first.
  const CTX = W.applyInstance({ users: [] });
  const raw = "purge-bearer-token";
  const hash = await W.tokenFor("pub:" + raw);
  // ⚠️ KV IS SEEDED WITHOUT THE CAPABILITY ON PURPOSE. The object is what the request path
  // reads FIRST, so a KV record that would resolve as unrestricted is what makes this
  // non-vacuous: a 403 here can only have come from the object's own row. It is also the
  // real shape of the straddle, where an operator adds `caps` to one store and the other
  // holds a row it minted.
  const rec = { space: "*", label: "purge-job", createdAt: "2026-01-01T00:00:00.000Z" };
  const doc = JSON.stringify({ [hash]: rec });

  const w = workspace();
  w.store.importAll({
    identity: { publishTokens: [{ tokenHash: hash, scope: "*", label: "purge-job", caps: ["purge"] }] },
    at: "2026-01-01T00:00:00.000Z",
  });

  const env = {
    BUNDLES: memR2({ "t/acme/spaces/one/manifest.json": JSON.stringify({ id: "one", version: 3, files: {}, routing: {} }) }),
    GV_ASSET_SOURCE: "r2",
    COMMENTS: memKV({ "publish:tokens": doc, "t/acme/publish:tokens": doc }),
    TENANT_HOST_SUFFIX: ".example.test",
    TENANTS: { idFromName: (n) => n, get: () => ({ fetch: (i, init) => w.store.fetch(new Request(i, init)) }) },
  };
  const tctx = Object.freeze({ ...CTX, tenantId: "acme" });
  const fire = (path, init = {}) => {
    W.__setConfigTestState({ cfgAt: 0, cfgGoodAt: 0, roster: null, manifests: null, storage: null });
    const url = new URL("https://x.test" + path);
    return W.publishApi(tctx, new Request(url, {
      ...init, headers: { Authorization: "Bearer " + raw, ...(init.headers || {}) },
    }), url, env);
  };

  const check = await fire("/__publish/one/check", { method: "POST", body: JSON.stringify({ files: {} }) });
  assert.equal(check.status, 403, "the purge bearer got past the capability gate");
  assert.equal((await check.json()).reason, "capability-not-granted");

  const profiles = await fire("/__publish/_instance/profiles");
  assert.equal(profiles.status, 403, "the purge bearer read the roster");

  W.applyInstance({ users: [] });
});
