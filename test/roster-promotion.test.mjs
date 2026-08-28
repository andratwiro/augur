// Promoting an overlay member into the config file must not delete them.
//
// `B-roster-overlay-promotion`. The roster has two layers and the second DRAINS into the
// first: an Admin invite lands in the overlay immediately, a `roster-update` dispatch
// commits the person to `identity.json`, and the deploy that follows pushes that file back
// over `/__publish/_instance/config`, at which point the overlay entry retires. On a
// deployment binding `TENANTS` that last step used to TOMBSTONE the person instead —
// silently, permanently, and in the one flow the product documents.
//
// The whole of it is an ORDERING inside one call. `rosterWrite` decides each row's `source`
// from the `configUsers` list it is handed and THEN tombstones every `source = 'overlay'`
// row the incoming `add` no longer carries. The config push handed it the config the
// REQUEST was loaded with — the one being replaced — so on the very push that promotes
// somebody, that list did not name them, their row stayed `'overlay'`, the drain had just
// taken them out of `add`, and the orphan clause buried them. The un-tombstone clause below
// revives only `'config'` rows, and the drain that would re-run it is gated on a KV read
// that an object-only tombstone can never move. Nothing outside could repair it.
//
// ── WHAT A GREEN RESULT HERE IS EVIDENCE OF ──────────────────────────────────────────
//
// The two pushes are driven through `worker.fetch` over the real routes, in order, against
// a host-resolved deployment with a real workspace object — an admin invite, a redeemed
// link, a config push with a star token, `/__people`, and a real sign-in. The object's
// `members` row is read after each push, because the bug is entirely in which of two passes
// runs first and a row is the only place that shows.
//
// ── AND WHAT IT IS NOT ───────────────────────────────────────────────────────────────
//
// `node:sqlite` behind a storage stub is not workerd. `scripts/tenant-do-rehearsal.mjs`
// runs this same promotion on the real runtime, and that is where it has to be believed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { TenantStore } from "../src/tenant-do.js";
import * as WORKER from "../src/_worker.js";

const W = WORKER.__testables;

const SUFFIX = ".example.test";
const WS = "alfa";
const ADMIN = "ada@example.test";
const NEWCOMER = "nell@example.test";
const OTHER = "otto@example.test";
const PASSWORD = "a properly long password";
const NEW_PASSWORD = "another properly long password";
const PASS_HASH = await W.hashPassword(PASSWORD);

/** The durable record, as `identity.json` seeds it. The newcomer is deliberately not in it. */
const BASE_USERS = [{ email: ADMIN, name: "Ada", initials: "A", role: "admin", passHash: PASS_HASH }];

const ROUTING = JSON.stringify({
  buildId: "promotion-build", versionMap: {}, publicPrefixes: [], publicSkillPrefixes: [],
  restrictedBases: [], canvasLoaderExtras: "", canvasCatalog: [], canvasTracks: [], mcpAllowlist: [],
  spaces: [{ id: "one", name: "One", badge: "O", default: true, base: "", adminOnly: false }],
  defaultSpace: "one",
});

/** A DO storage stub with REAL transaction semantics. */
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
  return {
    sql,
    transactionSync(cb) {
      db.exec("BEGIN");
      try { const out = cb(); db.exec("COMMIT"); return out; }
      catch (e) { db.exec("ROLLBACK"); throw e; }
    },
  };
}

function memKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async getWithMetadata(k) { return { value: store.has(k) ? store.get(k) : null, metadata: null }; },
    async put(k, v) { store.set(k, typeof v === "string" ? v : Buffer.from(v).toString("utf8")); },
    async delete(k) { store.delete(k); },
    async list({ prefix = "" } = {}) {
      return {
        keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      };
    },
  };
}

function memR2(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async head(k) { return store.has(k) ? { etag: "e" } : null; },
    async get(k) {
      if (!store.has(k)) return null;
      const o = store.get(k);
      return { body: o, etag: "e", text: async () => Buffer.from(o).toString("utf8"), arrayBuffer: async () => Buffer.from(o) };
    },
    async put(k, v) { store.set(k, Buffer.isBuffer(v) || v instanceof ArrayBuffer ? Buffer.from(v) : Buffer.from(String(v))); },
    async delete(k) { store.delete(k); },
    async list({ prefix = "", delimiter } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix));
      if (!delimiter) return { objects: keys.map((key) => ({ key })), truncated: false };
      const p = new Set();
      for (const k of keys) {
        const rest = k.slice(prefix.length);
        const at = rest.indexOf(delimiter);
        if (at >= 0) p.add(prefix + rest.slice(0, at + 1));
      }
      return { objects: [], delimitedPrefixes: [...p], truncated: false };
    },
  };
}

/**
 * One host-resolved deployment with one workspace object — the hosted shape, and the only
 * shape this item is about. `tenants: false` is the same fixture with the binding removed:
 * every self-hosted instance, where `identityFor` answers null and there is no object at
 * all. Both are driven over the same routes, which is what makes "additive" measurable.
 */
async function deployment({ tenants = true } = {}) {
  const kv = memKV();
  const r2 = memR2();
  const db = new DatabaseSync(":memory:");
  const object = new TenantStore({ storage: storage(db), blockConcurrencyWhile: async (f) => f() }, {});
  await object.provision({ workspaceId: WS, adminEmail: ADMIN });
  const pending = [];
  const env = {
    COMMENTS: kv,
    BUNDLES: r2,
    GV_ASSET_SOURCE: "r2",
    SESSION_SECRET: "promotion-fixed-session-secret",
    ASSETS: {
      async fetch(req) {
        const p = new URL(typeof req === "string" ? req : req.url).pathname;
        if (p === "/__config/routing.json") {
          return new Response(ROUTING, { headers: { "Content-Type": "application/json; charset=utf-8" } });
        }
        return new Response("Not Found", { status: 404 });
      },
    },
  };
  // The workspace comes from the Host only on the bound shape. Unbound, the deployment is
  // the single-workspace one every instance runs today and the id comes off the config.
  if (tenants) {
    env.TENANT_HOST_SUFFIX = SUFFIX;
    env.TENANTS = {
      idFromName: (n) => n,
      get: (n) => ({ fetch: (input, init) => object.fetch(new Request(input, init)) }),
    };
  }
  const configKey = () => W.bundleKey("config/instance.json", tenants ? WS : "");
  const putConfig = async (users) => {
    await r2.put(configKey(), Buffer.from(JSON.stringify({ tenantId: WS, users })));
  };
  await putConfig(BASE_USERS);
  await r2.put(W.bundleKey("spaces/one/manifest.json", tenants ? WS : ""), Buffer.from(JSON.stringify({
    version: 1, space: "one", files: {}, routing: { publicPrefixes: [], versionMap: {} },
  })));
  const T = WORKER.__testables;
  const fire = async (p, init) => {
    T.__setTenantTestState({ memo: tenants ? null : { at: Date.now(), tenantId: WS } });
    T.__setConfigTestState({ cfgAt: 0, cfgGoodAt: 0, roster: null, manifests: null, storage: null });
    const req = new Request(`https://${WS}${SUFFIX}${p}`, {
      ...(init || {}),
      headers: { ...((init && init.headers) || {}), host: `${WS}${SUFFIX}` },
    });
    const res = await WORKER.default.fetch(req, env, { waitUntil: (x) => pending.push(x) });
    await Promise.all(pending.splice(0));
    return res;
  };
  const cookieFor = async (email, passHash = PASS_HASH) => {
    const u = { email, passHash };
    const secret = await T.effectiveSecret(env, u);
    assert.ok(secret, "the fixture gave this person no resolvable secret");
    return { Cookie: `__Host-augur_user=${email}.${await T.userToken(env, u, secret, false, { tenantId: WS })}` };
  };
  /** The workspace object's own row for an address — the only place `source` shows. */
  const memberRow = (email) => {
    if (!tenants) return null;
    const rows = [...object.sql.exec(
      `SELECT email, source, removed_at FROM members WHERE email = ?`, email,
    )];
    return rows.length ? rows[0] : null;
  };
  return { env, kv, r2, object, fire, cookieFor, memberRow, putConfig, configKey, tenants };
}

/** Invite through the ADMIN ROUTE — the only way anybody ever lands in the overlay. */
async function invite(d, email, name) {
  const res = await d.fire("/__admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await d.cookieFor(ADMIN)) },
    body: JSON.stringify({ op: "invite", email, name }),
  });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return new URL(JSON.parse(text).url).searchParams.get("t");
}

/** Mint a STAR-scope publish token — what a deploy shell pushes the instance config with. */
async function starToken(d) {
  const res = await d.fire("/__admin/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await d.cookieFor(ADMIN)) },
    body: JSON.stringify({ op: "mint", space: "*", label: "shell-deploy" }),
  });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  const body = JSON.parse(text);
  const token = body.token || body.value || (body.entry && body.entry.token);
  assert.ok(token, text);
  return token;
}

/** The deploy pushing `identity.json` back — the step the bug lived in. */
async function pushConfig(d, token, users) {
  const res = await d.fire("/__publish/_instance/config", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ tenantId: WS, users }),
  });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  assert.deepEqual(JSON.parse(text), { ok: true });
}

const resolves = async (d, email) => {
  const res = await d.fire(`/__people?ids=${W.personId(email)}`);
  assert.equal(res.status, 200);
  return (await res.json()).people.length === 1;
};

// ═══ THE DEFECT ══════════════════════════════════════════════════════════════════════

test("a config push that NAMES an overlay member promotes them — it does not bury them", async () => {
  const d = await deployment({ tenants: true });
  const token = await starToken(d);
  const link = await invite(d, NEWCOMER, "Nell");

  // They redeem the link, which is what gives them a credential. From here on a failure to
  // sign in is a roster answer and not a missing secret — the distinction the live incident
  // needed `/__people` to make for it.
  const redeemed = await d.fire("/__invite", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: link, password: NEW_PASSWORD }).toString(),
  });
  assert.equal(redeemed.status, 303, "the invited person could not redeem their link");
  assert.equal(d.memberRow(NEWCOMER).source, "overlay", "an invite is an overlay entry");
  assert.ok(await resolves(d, NEWCOMER), "the overlay entry does not serve");

  // THE PUSH. `roster-update` has committed them to the identity file and the deploy sends
  // it back. This is the ordinary, documented convergence — and it used to delete them.
  await pushConfig(d, token, [...BASE_USERS, { email: NEWCOMER, name: "Nell", role: "editor" }]);

  const row = d.memberRow(NEWCOMER);
  assert.equal(row.removed_at, null, "the promoting push TOMBSTONED the person it promoted");
  assert.equal(row.source, "config",
    "the durable record now names them, so the row must say so before the orphan clause runs");

  // The overlay half really did retire — this is a promotion, not a second record.
  const overlay = JSON.parse(await d.kv.get(W.identityKey("users:roster", WS)));
  assert.deepEqual(Object.keys(overlay.add), [], "the overlay entry the config superseded is still there");

  assert.ok(await resolves(d, NEWCOMER), "the promoted person no longer resolves through /__people");

  // …and the whole point: they can still sign in. A 200 on /__auth is the login PAGE.
  const signIn = await d.fire("/__auth", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: NEWCOMER, password: NEW_PASSWORD, redirect: "/" }).toString(),
  });
  assert.equal(signIn.status, 303, "the promoted person cannot sign in");
  assert.match(signIn.headers.get("Set-Cookie") || "", /^__Host-augur_user=/);
});

test("and the push AFTER it leaves no tombstone behind either", async () => {
  // The reverse trip: the identity file stops naming them (a revert, or a shell whose
  // checkout predates the commit). They must fall out of the roster the ordinary way — the
  // config no longer names them — and NOT acquire a tombstone, which would outrank the file
  // forever and survive the file naming them again.
  const d = await deployment({ tenants: true });
  const token = await starToken(d);
  await invite(d, NEWCOMER, "Nell");
  await pushConfig(d, token, [...BASE_USERS, { email: NEWCOMER, name: "Nell", role: "editor" }]);
  assert.equal(d.memberRow(NEWCOMER).source, "config");

  await pushConfig(d, token, BASE_USERS);
  const row = d.memberRow(NEWCOMER);
  assert.equal(row.removed_at, null, "dropping somebody from the file wrote a tombstone");
  assert.equal(await resolves(d, NEWCOMER), false,
    "the file no longer names them, so the roster must not either");

  // And the file naming them again brings them straight back, which a tombstone would have
  // made impossible. This is the property the whole item is about.
  await pushConfig(d, token, [...BASE_USERS, { email: NEWCOMER, name: "Nell", role: "editor" }]);
  assert.ok(await resolves(d, NEWCOMER), "a person the file names is still being filtered out");
});

test("an overlay member the pushed config does NOT name stays a live overlay entry", async () => {
  // The orphan clause's neighbour case. One push, two invited people, and only one of them
  // in the file: the promotion must not drag the other one down with it.
  const d = await deployment({ tenants: true });
  const token = await starToken(d);
  await invite(d, NEWCOMER, "Nell");
  await invite(d, OTHER, "Otto");

  await pushConfig(d, token, [...BASE_USERS, { email: NEWCOMER, name: "Nell", role: "editor" }]);

  assert.equal(d.memberRow(OTHER).removed_at, null, "an invite the file has not caught up with was tombstoned");
  assert.equal(d.memberRow(OTHER).source, "overlay");
  assert.ok(await resolves(d, OTHER), "the un-promoted invite stopped serving");
  const overlay = JSON.parse(await d.kv.get(W.identityKey("users:roster", WS)));
  assert.deepEqual(Object.keys(overlay.add), [OTHER], "the wrong overlay entry was drained");
});

// ═══ THE CLAUSE THE FIX MUST NOT DISARM ══════════════════════════════════════════════

test("⛔ a REAL removal still tombstones — the orphan clause is not widened away", async () => {
  // The reason `rosterWrite` tombstones orphans at all: an invited person removed from the
  // Admin panel leaves NO entry in either half of the KV document, so their row is the only
  // thing that stops a later config file, or a re-invite, quietly restoring their role.
  // Fixing the promotion by reviving every removed row would have undone exactly this.
  const d = await deployment({ tenants: true });
  const token = await starToken(d);
  await invite(d, NEWCOMER, "Nell");

  const removed = await d.fire("/__admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await d.cookieFor(ADMIN)) },
    body: JSON.stringify({ op: "remove", email: NEWCOMER }),
  });
  assert.equal(removed.status, 200, await removed.text());
  assert.notEqual(d.memberRow(NEWCOMER).removed_at, null, "an admin removal left no tombstone");
  assert.equal(await resolves(d, NEWCOMER), false);

  // A config push that does not name them must leave the tombstone standing.
  await pushConfig(d, token, BASE_USERS);
  assert.notEqual(d.memberRow(NEWCOMER).removed_at, null, "a config push resurrected a removed person");
  assert.equal(await resolves(d, NEWCOMER), false, "a removed person came back");
});

test("⛔ the same, one level down: `rosterWrite` buries an orphan the incoming `add` dropped", () => {
  // The clause itself, with no routes in the way, because the case above can only ever
  // exercise it through whatever the admin route happens to write.
  const db = new DatabaseSync(":memory:");
  const o = new TenantStore({ storage: storage(db), blockConcurrencyWhile: async (f) => f() }, {});
  o.provision({ workspaceId: WS, adminEmail: ADMIN });
  const cfg = BASE_USERS.map((u) => ({ email: u.email, name: u.name, role: u.role }));

  o.rosterWrite({ configUsers: cfg, roster: { add: { [OTHER]: { email: OTHER, role: "editor" } }, remove: [] } });
  const live = [...o.sql.exec(`SELECT source, removed_at FROM members WHERE email = ?`, OTHER)][0];
  assert.equal(live.source, "overlay");
  assert.equal(live.removed_at, null);

  // Gone from `add`, and the config still does not name them: a tombstone, as designed.
  o.rosterWrite({ configUsers: cfg, roster: { add: {}, remove: [] } });
  assert.notEqual([...o.sql.exec(`SELECT removed_at FROM members WHERE email = ?`, OTHER)][0].removed_at, null);

  // But the config NAMING them is a promotion, and `configUsers` runs first, so the same
  // shape of call revives them instead. One ordering, both outcomes.
  o.rosterWrite({
    configUsers: [...cfg, { email: OTHER, name: "Otto", role: "editor" }],
    roster: { add: {}, remove: [] },
  });
  const back = [...o.sql.exec(`SELECT source, removed_at FROM members WHERE email = ?`, OTHER)][0];
  assert.equal(back.source, "config");
  assert.equal(back.removed_at, null, "the file naming somebody did not clear their tombstone");
});

// ═══ ADDITIVE FOR A DEPLOYMENT THAT BINDS NO `TENANTS` ═══════════════════════════════

test("a deployment binding no `TENANTS` has no object, no row and no change at all", async () => {
  // Every self-hosted instance running today. `identityFor` answers null, so
  // `mirrorRosterDocs` returns before it reads `configUsers` at all and the parameter this
  // item added is never evaluated. The proof is the SERVED answer over the same routes, plus
  // the KV document, which is the whole of that deployment's roster.
  const d = await deployment({ tenants: false });
  assert.equal(d.env.TENANTS, undefined);
  const token = await starToken(d);
  await invite(d, NEWCOMER, "Nell");
  assert.ok(await resolves(d, NEWCOMER));

  await pushConfig(d, token, [...BASE_USERS, { email: NEWCOMER, name: "Nell", role: "editor" }]);
  assert.ok(await resolves(d, NEWCOMER), "the config push dropped somebody on an unbound deployment");

  // The overlay drained, exactly as it has always done, at the UNSEGMENTED key.
  assert.equal(d.kv.store.has("t/" + WS + "/users:roster"), false, "an unbound deployment wrote a segment");
  const overlay = JSON.parse(await d.kv.get("users:roster"));
  assert.deepEqual(Object.keys(overlay.add), []);
  assert.deepEqual(overlay.remove, []);
});

test("`mirrorRosterDocs` reads no config at all when there is no object to mirror into", async () => {
  // The additive claim as a property rather than an observation: the default parameter is
  // evaluated at the call, and the function returns before touching it. A context whose
  // `CONFIG_USERS` THROWS on access therefore proves the unbound path never looks.
  let touched = false;
  const tctx = { tenantId: WS, get CONFIG_USERS() { touched = true; return []; } };
  await W.mirrorRosterDocs(tctx, { COMMENTS: memKV() }, { roster: { add: {}, remove: [] } });
  assert.equal(touched, false, "the unbound path read the config it has no object to mirror it into");
});
