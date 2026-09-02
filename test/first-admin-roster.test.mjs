// A fresh workspace's first admin must be visible to the roster read — and must SURVIVE the
// first invite the workspace ever sends.
//
// `B-first-admin-roster-visibility`. Found by running a signup flow end to end, twice, and
// the two findings are one defect family: a workspace born in the object (no KV era, no
// published config) was treated as if the overlay were illegitimate.
//
//   FACET 1 · `applyProvisioning` used to write the first admin with `source = 'config'`, and
//   `rosterRead` emits only `'overlay'` rows into the `add` document — the `'config'` rows
//   are the MIRROR of a config file, and the file is what serves them. A provisioned
//   workspace has no file naming anybody, so its admin existed in the table and nowhere the
//   serving path looks: `/__people` did not resolve them, the people list was empty, and the
//   invite consume refused them as "no longer valid".
//
//   FACET 2 · the write path's read-modify-write base was KV — `readRoster` read the KV
//   document even where the SERVING read is the object. Any overlay row the object held that
//   KV never saw was an orphan to the next mirror: the first `/__admin/users` invite read an
//   empty KV document, wrote `{add: {invitee}}`, and the orphan clause tombstoned the admin
//   who had just sent it.
//
// ── THE DECISION ─────────────────────────────────────────────────────────────────────
//
// ONE source of truth: the first admin is an OVERLAY row, because `source` records where the
// membership came from and it did not come from a file — it came from provisioning, the
// first invitation a workspace ever issues. That row is served through the same `add`
// document every invite is, promoted to `'config'` by the same config push that promotes
// anybody, and drained by the same drain. And where the object is the roster's record
// (`seeded`), it is the record for WRITES too: `readRoster` takes the base of every
// read-modify-write from the object, so what a write mirrors back is what was being served.
//
// The alternative — teaching `rosterRead` to emit `'config'` rows — was rejected on the
// evidence in `test/roster-promotion.test.mjs`: a `'config'` row is a mirror and carries no
// tombstone when the file stops naming somebody, so emitting it would keep serving a person
// the config had dropped, which is exactly the property "the push AFTER it" pins.
//
// ── WHAT A GREEN RESULT HERE IS EVIDENCE OF ──────────────────────────────────────────
//
// The fixture is the signup shape and nothing else: a host-resolved deployment, a workspace
// object provisioned with one admin, NO `config/instance.json` in the store, and the admin's
// only way in an invite minted on the object the way the control plane mints it. Every step
// is driven over the real routes; the object's row is read after each write because
// `source` and `removed_at` are the only place the two facets show.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { TenantStore, applyProvisioning, applyTenantSchema } from "../src/tenant-do.js";
import * as WORKER from "../src/_worker.js";

const W = WORKER.__testables;

const SUFFIX = ".example.test";
const WS = "fresh";
let SEQ = 0;
const ADMIN = "first@example.test";
const NEWCOMER = "nell@example.test";
const OTHER = "otto@example.test";
const PASSWORD = "a properly long password";
const NEW_PASSWORD = "another properly long password";

const ROUTING = JSON.stringify({
  buildId: "first-admin-build", versionMap: {}, publicPrefixes: [], publicSkillPrefixes: [],
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
 * The signup shape: a host-resolved deployment whose workspace object was provisioned with
 * one admin, and whose store holds NO instance config — nothing has ever been pushed to it.
 * `withConfig` puts an EMPTY roster there instead, the other config-userless shape, so both
 * "absent" and "present and naming nobody" are driven.
 */
async function deployment({ withConfig = false } = {}) {
  // Its OWN label: the worker keeps one context slot per isolate, keyed by workspace, and a
  // store with no config document keeps the previous context's fields — so two cases sharing
  // a label would read each other's pushed roster. Nothing a live workspace can do.
  const ws = `${WS}${++SEQ}`;
  const kv = memKV();
  const r2 = memR2();
  const db = new DatabaseSync(":memory:");
  const object = new TenantStore({ storage: storage(db), blockConcurrencyWhile: async (f) => f() }, {});
  await object.provision({ workspaceId: ws, adminEmail: ADMIN, adminName: "" });
  const pending = [];
  const env = {
    COMMENTS: kv,
    BUNDLES: r2,
    GV_ASSET_SOURCE: "r2",
    SESSION_SECRET: "first-admin-fixed-session-secret",
    TENANT_HOST_SUFFIX: SUFFIX,
    TENANTS: {
      idFromName: (n) => n,
      get: (n) => ({ fetch: (input, init) => object.fetch(new Request(input, init)) }),
    },
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
  const configKey = () => W.bundleKey("config/instance.json", ws);
  const putConfig = async (users) => {
    await r2.put(configKey(), Buffer.from(JSON.stringify({ tenantId: ws, users })));
  };
  if (withConfig) await putConfig([]);
  await r2.put(W.bundleKey("spaces/one/manifest.json", ws), Buffer.from(JSON.stringify({
    version: 1, space: "one", files: {}, routing: { publicPrefixes: [], versionMap: {} },
  })));
  const T = WORKER.__testables;
  const fire = async (p, init) => {
    T.__setTenantTestState({ memo: null });
    T.__setConfigTestState({ cfgAt: 0, cfgGoodAt: 0, roster: null, manifests: null, storage: null });
    const req = new Request(`https://${ws}${SUFFIX}${p}`, {
      ...(init || {}),
      headers: { ...((init && init.headers) || {}), host: `${ws}${SUFFIX}` },
    });
    const res = await WORKER.default.fetch(req, env, { waitUntil: (x) => pending.push(x) });
    await Promise.all(pending.splice(0));
    return res;
  };
  /** An invite minted ON THE OBJECT, the way the control plane mints the first admin's. */
  const mintOnObject = async (email) => {
    const token = "t-" + email.replace(/[^a-z]/g, "") + "-" + Math.random().toString(36).slice(2);
    const res = await object.fetch(new Request("https://workspace/identity/invite/mint", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: ws, tokenHash: await W.inviteHash(token), email,
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400e3).toISOString(),
        createdBy: "signup",
      }),
    }));
    assert.equal(res.status, 200, "the object refused to mint");
    return token;
  };
  /** Redeem a link: set a password, get the cookie. A 303 is the only success. */
  const redeem = async (token, password) => {
    const res = await fire("/__invite", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, password }).toString(),
    });
    const cookie = (res.headers.get("Set-Cookie") || "").split(";")[0];
    return { status: res.status, cookie: cookie ? { Cookie: cookie } : null, text: res.status === 303 ? "" : await res.text() };
  };
  const memberRow = (email) => {
    const rows = [...object.sql.exec(
      `SELECT email, role, name, initials, colour, source, removed_at FROM members WHERE email = ?`, email,
    )];
    return rows.length ? rows[0] : null;
  };
  const resolves = async (email) => {
    const res = await fire(`/__people?ids=${W.personId(email)}`);
    assert.equal(res.status, 200);
    return (await res.json()).people.length === 1;
  };
  const peopleList = async (cookie) => {
    const res = await fire("/__admin/users", { headers: cookie });
    return { status: res.status, users: res.status === 200 ? JSON.parse(await res.text()).users : null };
  };
  const invite = async (cookie, email, name) => {
    const res = await fire("/__admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...cookie },
      body: JSON.stringify({ op: "invite", email, name }),
    });
    const text = await res.text();
    return { status: res.status, text, token: res.status === 200 ? new URL(JSON.parse(text).url).searchParams.get("t") : null };
  };
  const signIn = async (email, password) => fire("/__auth", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password, redirect: "/" }).toString(),
  });
  const starToken = async (cookie) => {
    const res = await fire("/__admin/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...cookie },
      body: JSON.stringify({ op: "mint", space: "*", label: "shell-deploy" }),
    });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    const body = JSON.parse(text);
    return body.token || body.value || (body.entry && body.entry.token);
  };
  const pushConfig = async (token, users) => {
    const res = await fire("/__publish/_instance/config", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ tenantId: ws, users }),
    });
    assert.equal(res.status, 200, await res.text());
  };
  /** The admin arrives: the whole signup hand-off, as one step. */
  const arrive = async () => {
    const r = await redeem(await mintOnObject(ADMIN), PASSWORD);
    assert.equal(r.status, 303, `the first admin could not redeem their own invite: ${r.text.slice(0, 200)}`);
    assert.ok(r.cookie, "no session cookie on the redemption");
    return r.cookie;
  };
  return {
    ws, env, kv, r2, object, fire, mintOnObject, redeem, memberRow, resolves, peopleList, invite,
    signIn, starToken, pushConfig, arrive,
  };
}

// ═══ FACET 1 · THE FIRST ADMIN IS VISIBLE ════════════════════════════════════════════

test("provisioning then `rosterRead`: the seeded admin is in the `add` document, with a stable source", async () => {
  // The item's own unit: no routes, no worker — the object's read straight after its write.
  const db = new DatabaseSync(":memory:");
  const o = new TenantStore({ storage: storage(db), blockConcurrencyWhile: async (f) => f() }, {});
  await o.provision({ workspaceId: WS, adminEmail: ADMIN, adminName: "" });

  const docs = o.rosterRead();
  assert.equal(docs.seeded, true, "a provisioned workspace is the record for its own roster");
  const rec = docs.roster.add[ADMIN];
  assert.ok(rec, `the provisioned admin is not in the roster read: ${JSON.stringify(docs.roster)}`);
  assert.equal(rec.role, "admin");
  assert.ok(rec.name, "the admin has no name at all — the people list would show a blank");
  assert.ok(rec.initials && rec.color, "the admin's chip fields are missing — every other row carries them");
  assert.deepEqual(docs.roster.remove, []);

  const row = [...o.sql.exec(`SELECT source, removed_at FROM members WHERE email = ?`, ADMIN)][0];
  assert.equal(row.source, "overlay", "the membership came from provisioning, not from a file");
  assert.equal(row.removed_at, null);

  // Stable: reading again changes nothing, and provisioning again is a no-op on the row.
  await o.provision({ workspaceId: WS, adminEmail: "later@example.test" });
  assert.equal([...o.sql.exec(`SELECT source FROM members WHERE email = ?`, ADMIN)][0].source, "overlay");
  assert.deepEqual(Object.keys(o.rosterRead().roster.add), [ADMIN]);
});

test("`applyProvisioning` on a bare schema writes the same row — the store class adds nothing", () => {
  const db = new DatabaseSync(":memory:");
  const { sql } = storage(db);
  applyTenantSchema(sql, WS);
  applyProvisioning(sql, { workspaceId: WS, adminEmail: "  First@Example.TEST ", adminName: "First Person" });
  const row = [...sql.exec(`SELECT email, role, name, initials, colour, source FROM members`)][0];
  assert.equal(row.email, "first@example.test");
  assert.equal(row.role, "admin");
  assert.equal(row.name, "First Person");
  assert.equal(row.initials, "FP");
  assert.match(row.colour, /^#[0-9a-f]{6}$/);
  assert.equal(row.source, "overlay");
});

for (const withConfig of [false, true]) {
  const shape = withConfig ? "a config naming nobody" : "no config at all";
  test(`with ${shape}: the first admin resolves, redeems, is listed, and can invite`, async () => {
    const d = await deployment({ withConfig });

    // Before anybody has signed in: the serving read must already know them.
    assert.ok(await d.resolves(ADMIN), "the provisioned admin does not resolve through /__people");

    // The hand-off the control plane 303s to. This used to answer "no longer valid".
    const cookie = await d.arrive();
    assert.equal(d.memberRow(ADMIN).source, "overlay", "redeeming changed the row's provenance");

    const me = await d.fire("/__me", { headers: cookie });
    assert.equal(me.status, 200, "the redeemed session does not identify");
    assert.equal((await me.json()).user.role, "admin", "the first admin is not an admin");

    const list = await d.peopleList(cookie);
    assert.equal(list.status, 200, "the admin people list refused its only admin");
    const mine = list.users.find((u) => u.email === ADMIN);
    assert.ok(mine, `the admin people list does not show the first admin: ${JSON.stringify(list.users)}`);
    assert.equal(mine.role, "admin");
    assert.ok(mine.initials, "the first admin's chip has no initials");

    // …and they can mint an invite, which is what a first admin is FOR.
    const sent = await d.invite(cookie, NEWCOMER, "Nell");
    assert.equal(sent.status, 200, `the first admin cannot invite: ${sent.text.slice(0, 200)}`);
    assert.ok(sent.token);
  });
}

// ═══ FACET 2 · THE FIRST INVITE DOES NOT BURY THE FIRST ADMIN ════════════════════════

test("the first invite a config-userless workspace sends does NOT tombstone the admin who sent it", async () => {
  const d = await deployment();
  const cookie = await d.arrive();

  const sent = await d.invite(cookie, NEWCOMER, "Nell");
  assert.equal(sent.status, 200, sent.text);

  // THE ROW. Measured on a live workspace: the orphan clause fired against the admin.
  const row = d.memberRow(ADMIN);
  assert.equal(row.removed_at, null, "the admin's own invite TOMBSTONED them");
  assert.equal(row.source, "overlay");

  // The KV copy now carries them too — the write took its base from the record, so the
  // mirror and the copy agree about who exists.
  const overlay = JSON.parse(await d.kv.get(W.identityKey("users:roster", d.ws)));
  assert.deepEqual(Object.keys(overlay.add).sort(), [ADMIN, NEWCOMER].sort(),
    "the KV document does not carry the admin — the next mirror would orphan them");

  // And the whole point: still served, still an admin, still signed in.
  assert.ok(await d.resolves(ADMIN), "the admin stopped resolving after inviting somebody");
  assert.equal((await d.peopleList(cookie)).status, 200, "the admin lost their session over their own invite");
  const again = await d.signIn(ADMIN, PASSWORD);
  assert.equal(again.status, 303, "the admin can no longer sign in");

  // The invitee redeems, and a SECOND invite must not bury the first invitee either.
  const r = await d.redeem(sent.token, NEW_PASSWORD);
  assert.equal(r.status, 303, r.text.slice(0, 200));
  const second = await d.invite(cookie, OTHER, "Otto");
  assert.equal(second.status, 200, second.text);
  assert.equal(d.memberRow(NEWCOMER).removed_at, null, "the second invite tombstoned the first invitee");
  assert.equal(d.memberRow(ADMIN).removed_at, null, "the second invite tombstoned the admin");
  assert.ok(await d.resolves(NEWCOMER));
});

test("a role change and a removal on that workspace take their base from the record too", async () => {
  const d = await deployment();
  const cookie = await d.arrive();
  const sent = await d.invite(cookie, NEWCOMER, "Nell");
  assert.equal(sent.status, 200, sent.text);
  assert.equal((await d.redeem(sent.token, NEW_PASSWORD)).status, 303);

  const promoted = await d.fire("/__admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...cookie },
    body: JSON.stringify({ op: "role", email: NEWCOMER, role: "admin" }),
  });
  assert.equal(promoted.status, 200, await promoted.text());
  assert.equal(d.memberRow(ADMIN).removed_at, null, "a role change tombstoned the first admin");
  assert.equal(d.memberRow(NEWCOMER).removed_at, null, "a role change tombstoned its own subject");

  // ⛔ A REAL removal still tombstones — the orphan clause is not disarmed, only fed the truth.
  const removed = await d.fire("/__admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...cookie },
    body: JSON.stringify({ op: "remove", email: NEWCOMER }),
  });
  assert.equal(removed.status, 200, await removed.text());
  assert.notEqual(d.memberRow(NEWCOMER).removed_at, null, "an admin removal left no tombstone");
  assert.equal(await d.resolves(NEWCOMER), false, "a removed person still resolves");
  assert.equal(d.memberRow(ADMIN).removed_at, null, "removing somebody else tombstoned the admin");
  assert.ok(await d.resolves(ADMIN));
});

// ═══ THE FAMILY · THE FIRST ADMIN PROMOTES AND DRAINS LIKE ANYBODY ELSE ══════════════

test("a config push that NAMES the first admin promotes them; one that does not leaves them an overlay entry", async () => {
  const d = await deployment();
  const cookie = await d.arrive();
  const token = await d.starToken(cookie);

  // Named: the ordinary promotion — the row flips to 'config' and nobody is buried.
  await d.pushConfig(token, [{ email: ADMIN, name: "First", role: "admin" }]);
  let row = d.memberRow(ADMIN);
  assert.equal(row.source, "config", "the file names them, so the row must say so");
  assert.equal(row.removed_at, null, "the promoting push tombstoned the first admin");
  assert.ok(await d.resolves(ADMIN));
  assert.equal((await d.signIn(ADMIN, PASSWORD)).status, 303, "the promoted admin cannot sign in");

  // Not named: they drop out the ordinary way, with no tombstone, and a file naming them
  // again brings them straight back — the property the whole family is about.
  await d.pushConfig(token, []);
  row = d.memberRow(ADMIN);
  assert.equal(row.removed_at, null, "dropping the admin from the file wrote a tombstone");
  await d.pushConfig(token, [{ email: ADMIN, name: "First", role: "admin" }]);
  assert.ok(await d.resolves(ADMIN), "a person the file names is still being filtered out");
});

test("a config push naming NOBODY, on a workspace that has only ever had overlay members, buries nobody", async () => {
  // The drain's orphan clause, fed a config that names nobody, against a roster it can see.
  const d = await deployment();
  const cookie = await d.arrive();
  const token = await d.starToken(cookie);
  const sent = await d.invite(cookie, NEWCOMER, "Nell");
  assert.equal(sent.status, 200, sent.text);

  await d.pushConfig(token, []);
  assert.equal(d.memberRow(ADMIN).removed_at, null, "an empty config push tombstoned the admin");
  assert.equal(d.memberRow(NEWCOMER).removed_at, null, "an empty config push tombstoned an invitee");
  assert.ok(await d.resolves(ADMIN));
  assert.ok(await d.resolves(NEWCOMER));
});

// ═══ THE WRITE BASE REFUSES RATHER THAN FALLING THROUGH ══════════════════════════════

test("⚠️ an unreadable object refuses the invite — it does not write an emptied overlay from KV", async () => {
  // The base of a read-modify-write comes from the record. When the record cannot be
  // read, falling through to KV would write a document missing everybody KV never saw and
  // hand the next mirror a roster to orphan them from. So the write refuses instead.
  const d = await deployment();
  const cookie = await d.arrive();
  const real = d.env.TENANTS.get;
  d.env.TENANTS.get = (n) => ({
    fetch: async (input, init) => {
      const req = new Request(input, init);
      if (new URL(req.url).pathname === "/identity/roster/read") return new Response("broken", { status: 500 });
      return real(n).fetch(req);
    },
  });
  const res = await d.fire("/__admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...cookie },
    body: JSON.stringify({ op: "invite", email: NEWCOMER, name: "Nell" }),
  }).then((r) => r, (e) => ({ status: 500, thrown: e }));
  assert.notEqual(res.status, 200, "an invite went through while the roster record was unreadable");
  d.env.TENANTS.get = real;
  assert.equal(await d.kv.get(W.identityKey("users:roster", d.ws)), null,
    "the refused write still wrote a KV document — one that does not carry the admin");
  assert.equal(d.memberRow(ADMIN).removed_at, null);
  assert.ok(await d.resolves(ADMIN), "the admin did not survive the outage");
});
