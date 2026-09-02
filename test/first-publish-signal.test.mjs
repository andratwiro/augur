// The onboarding completion signal: the server's own account of the first REAL publish.
//
// `C-first-publish-signal`. Onboarding confirms success from the server, never from the
// CLI's exit code or an agent's report of itself — and "success" is a publish that is not
// the seed pack the platform wrote on the person's behalf. Every case here drives the real
// worker over HTTP: a host-resolved deployment, a workspace object provisioned with one
// admin, a live manifest that is the provisioning write and nothing else, and publishes
// that arrive as `POST /__publish/<space>/commit` with a bearer token, exactly as `augur
// publish` sends them.
//
// ── WHAT IS PINNED ────────────────────────────────────────────────────────────────────
//
//   · A seed-only workspace reads `connected: false`.
//   · The first real publish flips it, with a timestamp, and the commit response says so.
//   · A second real publish neither resets nor duplicates it — the stamp is the FIRST.
//   · A seed-stamped publish never flips it, on a fresh workspace or a connected one.
//   · A publisher whose actor was stripped of the reserved namespace is REAL: what the
//     signal asks is `isSeedSource()`, and a stripped actor does not answer to it.
//   · The member half: the token's resolved actor is stamped once; a second person's
//     first publish is a second conversion; a CI token with no address stamps nobody.
//   · The role half: a viewer becoming an editor (or an admin) counts; nothing else does.
//   · The auth: a stranger gets 401 and learns nothing; any signed-in member reads it.
//   · Degradation: no `TENANTS` binding is `backing: "none"` and a commit still lands;
//     an unreadable object is a 503, never a false "not connected".
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { TenantStore } from "../src/tenant-do.js";
import { seedSource, sanitizeActor, SEED_ACTOR } from "../src/provenance.mjs";
import * as WORKER from "../src/_worker.js";

const W = WORKER.__testables;

const SUFFIX = ".example.test";
let SEQ = 0;
const ADMIN = "first@example.test";
const NEWCOMER = "nell@example.test";
const VIEWER = "vera@example.test";
const PASSWORD = "a properly long password";

const ROUTING = JSON.stringify({
  buildId: "first-publish-build", versionMap: {}, publicPrefixes: [], publicSkillPrefixes: [],
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

const sha256 = async (s) => Buffer.from(await crypto.subtle.digest("SHA-256", Buffer.from(s))).toString("hex");

/** One authored page under `/proto/`, the smallest thing a real publish ships. */
async function page(text) {
  const bytes = Buffer.from(`<!doctype html><title>${text}</title>`);
  const h = await sha256(bytes.toString("utf8"));
  return { h, bytes, entry: { h, ct: "text/html", s: bytes.length } };
}

/**
 * The signup shape, one step on: a host-resolved deployment whose workspace object was
 * provisioned with one admin, and whose store holds exactly ONE version — the seed pack,
 * written by the platform and stamped `seedSource()`. Nothing a person did.
 */
async function deployment() {
  const ws = `signal${++SEQ}`;
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
    SESSION_SECRET: "first-publish-fixed-session-secret",
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
  // The provisioning write: the seed pack, version 1, and the ONLY thing live.
  const seed = await page("seed");
  await r2.put(`blobs/${seed.h}`, seed.bytes);
  await r2.put(W.bundleKey("spaces/one/manifest.json", ws), Buffer.from(JSON.stringify({
    id: "one", version: 1, space: { id: "one", default: true },
    source: seedSource({ sha: "seed000" }),
    files: { "/proto/index.html": seed.entry },
    routing: { publicPrefixes: ["/proto/"], versionMap: {} },
  })));
  await r2.put(W.bundleKey("spaces/one/versions/1.json", ws), r2.store.get(W.bundleKey("spaces/one/manifest.json", ws)));

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
  const redeem = async (token, password) => {
    const res = await fire("/__invite", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, password }).toString(),
    });
    const cookie = (res.headers.get("Set-Cookie") || "").split(";")[0];
    return { status: res.status, cookie: cookie ? { Cookie: cookie } : null, text: res.status === 303 ? "" : await res.text() };
  };
  const arrive = async () => {
    const r = await redeem(await mintOnObject(ADMIN), PASSWORD);
    assert.equal(r.status, 303, `the first admin could not redeem their own invite: ${r.text.slice(0, 200)}`);
    return r.cookie;
  };
  const invite = async (cookie, email, name, role) => {
    const res = await fire("/__admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...cookie },
      body: JSON.stringify({ op: "invite", email, name, ...(role ? { role } : {}) }),
    });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    return new URL(JSON.parse(text).url).searchParams.get("t");
  };
  const setRole = async (cookie, email, role) => {
    const res = await fire("/__admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...cookie },
      body: JSON.stringify({ op: "role", email, role }),
    });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  /** A publish token, labelled with the address it is FOR — what `augur login` mints. */
  const token = async (cookie, { space = "one", label } = {}) => {
    const res = await fire("/__admin/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...cookie },
      body: JSON.stringify({ op: "mint", space, label }),
    });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    return JSON.parse(text).token;
  };
  /** `POST /__publish/one/commit` — a new page, and whatever `source` the publisher claims. */
  const commit = async (bearer, { text, source }) => {
    const p = await page(text);
    const res = await fire("/__publish/one/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({
        id: "one", space: { id: "one", default: true }, source,
        files: { "/proto/index.html": p.entry },
        routing: { publicPrefixes: ["/proto/"], versionMap: {} },
        blobs: { [p.h]: p.bytes.toString("base64") },
      }),
    });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const status = async (cookie) => {
    const res = await fire("/__onboarding/status", { headers: cookie || {} });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const liveVersion = () => JSON.parse(r2.store.get(W.bundleKey("spaces/one/manifest.json", ws)).toString("utf8")).version;
  return { ws, env, kv, r2, object, fire, mintOnObject, redeem, arrive, invite, setRole, token, commit, status, liveVersion };
}

const REAL = (marker) => ({ sha: `${marker}sha`, dirty: false, actor: marker });

// ═══ THE WORKSPACE HALF ═══════════════════════════════════════════════════════════════

test("a seed-only workspace reads connected:false — and a stranger reads nothing at all", async () => {
  const d = await deployment();
  // No cookie: 401, and no field of the answer says anything about the workspace.
  const anon = await d.status(null);
  assert.equal(anon.status, 401);
  assert.deepEqual(Object.keys(anon.body), ["error"], "a stranger was told something about the workspace");

  const cookie = await d.arrive();
  const s = await d.status(cookie);
  assert.equal(s.status, 200);
  assert.equal(s.body.connected, false, "the seed pack counted as a publish");
  assert.equal(s.body.firstPublishAt, null);
  assert.equal(s.body.backing, "workspace-object", "the object was not the store answering");
  assert.deepEqual(s.body.members, { converted: 0, active: 1 });
  assert.equal(s.body.viewersBecameEditors, 0);
  assert.deepEqual(s.body.me, { firstPublishAt: null });
});

test("the first real publish flips it with a timestamp, and the commit says so", async () => {
  const d = await deployment();
  const cookie = await d.arrive();
  const bearer = await d.token(cookie, { label: ADMIN });

  const before = Date.now();
  const r = await d.commit(bearer, { text: "mine", source: REAL("first") });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.firstPublish, true, "the publish that connected the workspace did not say so");
  assert.equal(d.liveVersion(), 2);

  const s = await d.status(cookie);
  assert.equal(s.body.connected, true, "a real publish did not connect the workspace");
  const at = Date.parse(s.body.firstPublishAt);
  assert.ok(Number.isFinite(at) && at >= before - 1000 && at <= Date.now() + 1000,
    `firstPublishAt is not a timestamp of now: ${s.body.firstPublishAt}`);
  // The person who published is converted; they are the one member.
  assert.deepEqual(s.body.members, { converted: 1, active: 1 });
  assert.equal(s.body.me.firstPublishAt, s.body.firstPublishAt);
  // And the operator's view carries the same stamp, so connected workspaces can be counted.
  assert.equal(d.object.status().firstPublishAt, s.body.firstPublishAt);
});

test("a second real publish neither resets nor duplicates the stamp", async () => {
  const d = await deployment();
  const cookie = await d.arrive();
  const bearer = await d.token(cookie, { label: ADMIN });
  assert.equal((await d.commit(bearer, { text: "one", source: REAL("first") })).status, 200);
  const first = (await d.status(cookie)).body.firstPublishAt;

  await new Promise((r) => setTimeout(r, 5)); // a later clock, so an overwrite would be visible
  const again = await d.commit(bearer, { text: "two", source: REAL("second") });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal("firstPublish" in again.body, false, "a second publish claimed to be the first");
  assert.equal(d.liveVersion(), 3, "the second publish did not land");

  const s = await d.status(cookie);
  assert.equal(s.body.firstPublishAt, first, "the stamp moved on a later publish");
  assert.deepEqual(s.body.members, { converted: 1, active: 1 }, "one person's second publish was a second conversion");
  assert.equal(s.body.me.firstPublishAt, first);
  // One row in meta, not two — the stamp is a key, and a key cannot duplicate.
  const rows = [...d.object.sql.exec(`SELECT COUNT(*) AS n FROM meta WHERE k = 'first_publish_at'`)];
  assert.equal(Number(rows[0].n), 1);
});

test("a seed-stamped publish never flips it — fresh, or already connected", async () => {
  const d = await deployment();
  const cookie = await d.arrive();
  // The platform's own write travels on a star token (it is not a person), stamped with
  // the sentinel — whatever the provisioning path turns out to send, THIS is what the
  // version's `source` carries, and it is what the signal reads.
  const star = await d.token(cookie, { space: "*", label: "provisioning" });
  const seeded = await d.commit(star, { text: "more seed", source: seedSource({ sha: "seed111" }) });
  assert.equal(seeded.status, 200, JSON.stringify(seeded.body));
  assert.equal("firstPublish" in seeded.body, false, "a seed write announced a first publish");
  assert.equal(d.liveVersion(), 2, "the seed write did not land — the case is vacuous");
  let s = await d.status(cookie);
  assert.equal(s.body.connected, false, "a seed-stamped publish connected the workspace");
  assert.equal(s.body.firstPublishAt, null);

  // The actor alone, without the belt-and-braces flag, is still the sentinel.
  const byActor = await d.commit(star, { text: "seed by actor", source: { sha: "seed222", actor: SEED_ACTOR } });
  assert.equal(byActor.status, 200);
  assert.equal((await d.status(cookie)).body.connected, false, "the actor form of the sentinel was not recognised");

  // Now a person publishes, then the platform writes again: the stamp is the person's.
  const bearer = await d.token(cookie, { label: ADMIN });
  assert.equal((await d.commit(bearer, { text: "mine", source: REAL("first") })).status, 200);
  const at = (await d.status(cookie)).body.firstPublishAt;
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await d.commit(star, { text: "seed again", source: seedSource({ sha: "seed333" }) })).status, 200);
  s = await d.status(cookie);
  assert.equal(s.body.connected, true);
  assert.equal(s.body.firstPublishAt, at, "a seed write after the first real publish moved the stamp");
});

test("a publisher whose actor was stripped of the reserved namespace is REAL", async () => {
  // `sanitizeActor` is what `publish.mjs` runs on `$USER`; a shell that says `augur:seed`
  // arrives here as `seed`, and `seed` is a person's actor like any other. The signal asks
  // `isSeedSource()`, never a string, so the stripped form cannot be mistaken for the
  // sentinel it was stripped of.
  const d = await deployment();
  const cookie = await d.arrive();
  const bearer = await d.token(cookie, { label: ADMIN });
  const actor = sanitizeActor("augur:seed");
  assert.equal(actor, "seed");
  const r = await d.commit(bearer, { text: "mine", source: { sha: "abc", dirty: false, actor } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.firstPublish, true);
  const s = await d.status(cookie);
  assert.equal(s.body.connected, true, "a stripped actor was treated as the seed");
  assert.ok(s.body.firstPublishAt);
});

// ═══ THE MEMBER HALF ══════════════════════════════════════════════════════════════════

test("each member's FIRST publish is their conversion; a token with no address stamps nobody", async () => {
  const d = await deployment();
  const cookie = await d.arrive();
  const t = await d.invite(cookie, NEWCOMER, "Nell");
  assert.equal((await d.redeem(t, "another properly long password")).status, 303);
  assert.deepEqual((await d.status(cookie)).body.members, { converted: 0, active: 2 });

  // A CI token — labelled, but not with anybody's address. The workspace connects; no
  // member converts, because no member published.
  const ci = await d.token(cookie, { space: "*", label: "shell-deploy" });
  assert.equal((await d.commit(ci, { text: "ci", source: REAL("ci") })).status, 200);
  let s = await d.status(cookie);
  assert.equal(s.body.connected, true);
  assert.deepEqual(s.body.members, { converted: 0, active: 2 }, "a CI token converted somebody");
  assert.deepEqual(s.body.me, { firstPublishAt: null });

  // The newcomer's own token, then the admin's. Two people, two conversions, in order.
  const nell = await d.token(cookie, { label: NEWCOMER });
  assert.equal((await d.commit(nell, { text: "nell", source: REAL("nell") })).status, 200);
  s = await d.status(cookie);
  assert.deepEqual(s.body.members, { converted: 1, active: 2 });
  assert.deepEqual(s.body.me, { firstPublishAt: null }, "somebody else's publish converted the caller");

  const mine = await d.token(cookie, { label: ADMIN });
  assert.equal((await d.commit(mine, { text: "admin", source: REAL("admin") })).status, 200);
  s = await d.status(cookie);
  assert.deepEqual(s.body.members, { converted: 2, active: 2 });
  assert.ok(s.body.me.firstPublishAt, "the caller's own conversion is not reported to them");
  // And the workspace stamp is still the CI publish's — the first, not the latest.
  const first = [...d.object.sql.exec(`SELECT v FROM meta WHERE k = 'first_publish_at'`)][0].v;
  assert.equal(s.body.firstPublishAt, first);
  const nellRow = [...d.object.sql.exec(`SELECT first_publish_at FROM members WHERE email = ?`, NEWCOMER)][0];
  assert.ok(nellRow.first_publish_at, "the member row was not stamped");
});

// ═══ THE ROLE HALF ════════════════════════════════════════════════════════════════════

test("a viewer becoming an editor (or an admin) is counted; every other role change is not", async () => {
  const d = await deployment();
  const cookie = await d.arrive();
  const t = await d.invite(cookie, VIEWER, "Vera", "viewer");
  assert.equal((await d.redeem(t, "another properly long password")).status, 303);
  const t2 = await d.invite(cookie, NEWCOMER, "Nell");
  assert.equal((await d.redeem(t2, "another properly long password")).status, 303);
  const n = async () => (await d.status(cookie)).body.viewersBecameEditors;
  assert.equal(await n(), 0);

  assert.equal((await d.setRole(cookie, VIEWER, "editor")).status, 200);
  assert.equal(await n(), 1, "viewer → editor was not counted");
  assert.equal((await d.setRole(cookie, VIEWER, "editor")).body.unchanged, true);
  assert.equal(await n(), 1, "a no-op role change was counted");
  assert.equal((await d.setRole(cookie, VIEWER, "admin")).status, 200);
  assert.equal(await n(), 1, "editor → admin was counted as a conversion");
  assert.equal((await d.setRole(cookie, NEWCOMER, "viewer")).status, 200);
  assert.equal(await n(), 1, "a DEMOTION to viewer was counted");
  assert.equal((await d.setRole(cookie, NEWCOMER, "admin")).status, 200);
  assert.equal(await n(), 2, "viewer → admin was not counted — an admin can publish too");
  assert.equal([...d.object.sql.exec(`SELECT v FROM meta WHERE k = 'viewers_became_editors'`)][0].v, "2");
});

// ═══ DEGRADATION ══════════════════════════════════════════════════════════════════════

test("with no TENANTS binding the signal is a stated no-op: backing 'none', and a commit still lands", async () => {
  // Every self-hosted instance. The commit path is byte-for-byte what it was, and the
  // status route says it keeps no such record rather than pretending to have looked.
  const LIVE = {
    id: "alpha", version: 4, format: 1, space: { id: "alpha", default: true },
    source: { sha: "abc123", dirty: false, actor: "someone" },
    files: { "/toolkit/widgets/index.html": { h: "a".repeat(64), ct: "text/html", s: 10 } },
    routing: { publicPrefixes: ["/toolkit/widgets/"], versionMap: {} },
  };
  const r2 = memR2({ "spaces/alpha/manifest.json": JSON.stringify(LIVE), ["blobs/" + "a".repeat(64)]: "0123456789" });
  const env = { BUNDLES: r2, PUBLISH_BOOTSTRAP_TOKEN: "tok" };
  const ctx = Object.freeze({ ...W.applyInstance({ users: [] }), tenantId: "acme" });
  const res = await W.publishApi(ctx, new Request("https://x.test/__publish/alpha/commit", {
    method: "POST",
    headers: { Authorization: "Bearer tok", "content-type": "application/json" },
    body: JSON.stringify({ ...LIVE, version: undefined, source: { sha: "def", dirty: false, actor: "someone" } }),
  }), new URL("https://x.test/__publish/alpha/commit"), env);
  const text = await res.text();
  assert.equal(res.status, 200, text);
  const body = JSON.parse(text);
  assert.equal(body.version, 5);
  assert.equal("firstPublish" in body, false, "a deployment with no object announced a first publish it cannot have recorded");

  const me = { email: "someone@example.test", role: "editor" };
  const s = await W.onboardingStatusApi(ctx, new Request("https://x.test/__onboarding/status"), env, me);
  assert.equal(s.status, 200);
  assert.deepEqual(await s.json(), {
    connected: false, firstPublishAt: null, members: { converted: 0, active: 0 },
    viewersBecameEditors: 0, me: null, backing: "none",
  });
  // A stranger is still a stranger, object or no object.
  const anon = await W.onboardingStatusApi(ctx, new Request("https://x.test/__onboarding/status"), env, null);
  assert.equal(anon.status, 401);
});

test("an unreadable object is a 503, never a false 'not connected'", async () => {
  const env = {
    TENANTS: { idFromName: (n) => ({ name: n }), get: () => ({ fetch: async () => { throw new Error("gone"); } }) },
  };
  const ctx = Object.freeze({ ...W.applyInstance({ users: [] }), tenantId: "acme" });
  const s = await W.onboardingStatusApi(ctx, new Request("https://x.test/__onboarding/status"), env, { email: "x@example.test" });
  assert.equal(s.status, 503);
  assert.equal((await s.json()).error, "status-unavailable");
});

test("the stamp is refused on a removed member's row, and a re-invite starts unconverted", async () => {
  // A tombstone must not be stamped: `members.first_publish_at` is per PERSON, and the next
  // holder of an address is a different person — the same rule a re-invite's role follows.
  const d = await deployment();
  const cookie = await d.arrive();
  const t = await d.invite(cookie, NEWCOMER, "Nell");
  assert.equal((await d.redeem(t, "another properly long password")).status, 303);
  const removed = await d.fire("/__admin/users", {
    method: "POST", headers: { "Content-Type": "application/json", ...cookie },
    body: JSON.stringify({ op: "remove", email: NEWCOMER }),
  });
  assert.equal(removed.status, 200, await removed.text());
  // The object, asked directly: the address names a tombstone, so nobody is stamped.
  const out = d.object.noteFirstPublish(NEWCOMER);
  assert.equal(out.member.wrote, false, "a removed member's row was stamped");
  assert.ok(out.firstPublishAt, "the workspace half did not stamp");
  const row = [...d.object.sql.exec(`SELECT first_publish_at FROM members WHERE email = ?`, NEWCOMER)][0];
  assert.equal(row.first_publish_at, null);
});
