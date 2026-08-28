// The first-run surface: genuinely FIRST, once per person, and only ever an addition.
//
// `FIRST_RUN` moves where a successful invite redemption LANDS — to FIRST_RUN_PATH the
// first time a person ever redeems, "/" every time after — and nothing else. What these
// tests prove is each clause of that sentence over the real routes: the redirect happens
// BEFORE any workspace content is served; the once-only record is the WORKSPACE'S, so a
// second link redeemed from a fresh cookie jar (a second device) does not see the page
// again; an existing member's password sign-in never routes there; and with the flag off
// the surface does not exist — the path answers exactly what it answered before the flag
// did, and no record is ever written.
//
// The copy is deliberately not pinned word-for-word: the page is a PLACEHOLDER slot that
// exists to be rewritten, so the one thing asserted about its content is that it SAYS it
// is a placeholder. Everything else here is routing and record, which are the deliverable.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as WORKER from "../src/_worker.js";
import { instanceFields } from "../src/tenant-context.mjs";

const W = WORKER.__testables;

const WS = "alfa";
const ORIGIN = "https://alfa.example.test";
const ADMIN = "ada@example.test";
const NEWCOMER = "nell@example.test";
const PASSWORD = "a properly long password";
const NEW_PASSWORD = "another properly long password";
const PASS_HASH = await W.hashPassword(PASSWORD);

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
    async list({ prefix = "" } = {}) {
      return { objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false };
    },
  };
}

const ROUTING = JSON.stringify({
  buildId: "first-run-build", versionMap: {}, publicPrefixes: [], publicSkillPrefixes: [],
  restrictedBases: [], canvasLoaderExtras: "", canvasCatalog: [], canvasTracks: [], mcpAllowlist: [],
  spaces: [{ id: "one", name: "One", badge: "O", default: true, base: "", adminOnly: false }],
  defaultSpace: "one",
});

/**
 * One single-workspace bundle-mode deployment — the shape every live instance serves —
 * with the two flags injectable, because "flag off is untouched" is a claim about the
 * same deployment differing in one config word.
 */
async function deployment({ firstRun = true, sessionKeys = true } = {}) {
  const kv = memKV();
  const r2 = memR2();
  const pending = [];
  const env = {
    COMMENTS: kv,
    BUNDLES: r2,
    GV_ASSET_SOURCE: "r2",
    SESSION_SECRET: "first-run-fixed-session-secret",
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
  // The newcomer is deliberately NOT in the config: they arrive by admin invite into the
  // overlay — the exact "invited into an existing workspace" flow this surface is for.
  const users = [
    { email: ADMIN, name: "Ada", initials: "A", role: "admin", passHash: PASS_HASH },
  ];
  await r2.put(W.bundleKey("config/instance.json", ""), Buffer.from(JSON.stringify({
    tenantId: WS, users, sessionKeys, firstRun,
  })));
  await r2.put(W.bundleKey("spaces/one/manifest.json", ""), Buffer.from(JSON.stringify({
    version: 1, space: "one", files: {}, routing: { publicPrefixes: [], versionMap: {} },
  })));
  const fire = async (p, init) => {
    W.__setTenantTestState({ memo: { at: Date.now(), tenantId: WS } });
    W.__setConfigTestState({ cfgAt: 0, cfgGoodAt: 0, roster: null, manifests: null, storage: null });
    const res = await WORKER.default.fetch(new Request(ORIGIN + p, init), env, { waitUntil: (x) => pending.push(x) });
    await Promise.all(pending.splice(0));
    return res;
  };
  /** A real sign-in over the real route — the cookie every later request rides. */
  const signIn = async (email, password) => {
    const res = await fire("/__auth", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email, password }).toString(),
    });
    assert.equal(res.status, 303, "sign-in succeeded");
    return { res, cookie: res.headers.get("Set-Cookie").split(";")[0] };
  };
  /** Mint a link through the admin route — the only way one is ever minted. */
  const mintLink = async (op, email, adminCookie) => {
    const res = await fire("/__admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ op, email }),
    });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    return new URL(JSON.parse(text).url).searchParams.get("t");
  };
  const redeem = (token, extra = {}) => fire("/__invite", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token, ...extra }).toString(),
  });
  return { env, kv, r2, fire, signIn, mintLink, redeem };
}

// ── the flag itself ──────────────────────────────────────────────────────────

test("the flag is explicit `true` only — a typo cannot move where redemption lands", () => {
  assert.equal(instanceFields({ firstRun: true }).FIRST_RUN, true);
  assert.equal(instanceFields({}).FIRST_RUN, false);
  assert.equal(instanceFields({ firstRun: "yes" }).FIRST_RUN, false);
  assert.equal(instanceFields({ firstRun: 1 }).FIRST_RUN, false);
});

test("the page says it is a placeholder, in its copy and on the rendered surface", () => {
  assert.match(W.FIRST_RUN_COPY.placeholder, /placeholder/i, "the copy admits what it is");
  const html = W.firstRunPage(W.applyDerivedRouting({}));
  assert.match(html, /placeholder/i, "the rendered page says so too");
  assert.ok(html.includes(W.FIRST_RUN_COPY.title), "the copy constant is what renders");
  assert.match(html, /noindex/, "never indexed");
});

// ── FLAG ON: the landing is genuinely first, and once ────────────────────────

test("FLAG ON: a redeemed invite lands on the surface BEFORE any workspace content, and the record is written", async () => {
  const d = await deployment();
  const admin = await signInAdmin(d);
  const t = await d.mintLink("invite", NEWCOMER, admin.cookie);

  const res = await d.redeem(t);
  assert.equal(res.status, 303);
  assert.equal(new URL(res.headers.get("Location"), ORIGIN).pathname, W.FIRST_RUN_PATH,
    "the redirect target IS the surface — no workspace content is ever served first");
  const cookie = res.headers.get("Set-Cookie").split(";")[0];

  // Following the redirect, as the browser would: the surface renders for the session.
  const page = await d.fire(W.FIRST_RUN_PATH, { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /placeholder/i);

  // The record is in the WORKSPACE'S store, not in any cookie.
  const seen = JSON.parse(await d.kv.get(W.FIRST_RUN_KEY));
  assert.ok(seen[NEWCOMER], "the landing was recorded durably, keyed by the person");
});

test("FLAG ON: a second link, redeemed with a FRESH cookie jar (a second device), lands on '/' — the record is durable, not cookie-held", async () => {
  const d = await deployment();
  const admin = await signInAdmin(d);
  const first = await d.mintLink("invite", NEWCOMER, admin.cookie);
  assert.equal(new URL((await d.redeem(first)).headers.get("Location"), ORIGIN).pathname, W.FIRST_RUN_PATH);

  // A new single-use link for the same person — how the same human arrives on device two.
  const second = await d.mintLink("reset", NEWCOMER, admin.cookie);
  const res = await d.redeem(second); // no Cookie header at all: a browser that has never been here
  assert.equal(res.status, 303);
  assert.equal(new URL(res.headers.get("Location"), ORIGIN).pathname, "/",
    "the second device is not shown the surface again");
});

test("FLAG ON, SESSION_KEYS OFF: the password path gets the same landing, and signing back in after does NOT show it again", async () => {
  const d = await deployment({ sessionKeys: false });
  const admin = await signInAdmin(d);
  const t = await d.mintLink("invite", NEWCOMER, admin.cookie);

  const res = await d.redeem(t, { password: NEW_PASSWORD });
  assert.equal(res.status, 303);
  assert.equal(new URL(res.headers.get("Location"), ORIGIN).pathname, W.FIRST_RUN_PATH);

  // Sign out and back in with the password just set: /__auth, which never routes here.
  const again = await d.signIn(NEWCOMER, NEW_PASSWORD);
  assert.equal(new URL(again.res.headers.get("Location"), ORIGIN).pathname, "/",
    "a later sign-in lands where sign-in has always landed");
});

test("FLAG ON: an existing member's normal sign-in is untouched", async () => {
  const d = await deployment();
  const { res } = await d.signIn(ADMIN, PASSWORD);
  assert.equal(new URL(res.headers.get("Location"), ORIGIN).pathname, "/");
});

test("FLAG ON: the surface is for members — a stranger is bounced to the gate, and only GET answers", async () => {
  const d = await deployment();
  const anon = await d.fire(W.FIRST_RUN_PATH);
  assert.equal(anon.status, 303);
  assert.equal(new URL(anon.headers.get("Location"), ORIGIN).pathname, "/");
  assert.equal((await d.fire(W.FIRST_RUN_PATH, { method: "POST" })).status, 405);
});

// ── FLAG OFF: the surface does not exist ─────────────────────────────────────

test("FLAG OFF: redemption lands where it always landed, and no record is ever written", async () => {
  const d = await deployment({ firstRun: false });
  const admin = await signInAdmin(d);
  const t = await d.mintLink("invite", NEWCOMER, admin.cookie);
  const res = await d.redeem(t);
  assert.equal(res.status, 303);
  assert.equal(new URL(res.headers.get("Location"), ORIGIN).pathname, "/");
  assert.equal(d.kv.store.has(W.FIRST_RUN_KEY), false, "nothing was recorded — the flag off costs no read and no write");
});

test("FLAG OFF: the path answers exactly what any unknown path answers — the surface is removed entirely", async () => {
  const d = await deployment({ firstRun: false });
  // Anonymous: both get the gate, identically — modulo the requested path, which the
  // gate echoes into the form's redirect field and the og:url (as it always has).
  const a = await d.fire(W.FIRST_RUN_PATH);
  const b = await d.fire("/__no-such-surface");
  assert.equal(a.status, b.status);
  const norm = (s, p) => s.split(p).join("/__x");
  assert.equal(norm(await a.text(), W.FIRST_RUN_PATH), norm(await b.text(), "/__no-such-surface"));
  // Signed in: both fall through to the same not-found handling.
  const admin = await signInAdmin(d);
  const c = await d.fire(W.FIRST_RUN_PATH, { headers: { Cookie: admin.cookie } });
  const e = await d.fire("/__no-such-surface", { headers: { Cookie: admin.cookie } });
  assert.equal(c.status, e.status);
  assert.equal(await c.text(), await e.text());
});

// ── the record's own semantics ───────────────────────────────────────────────

test("the landing fails toward '/': an unreadable record, a failed write, or no store never re-show and never block", async () => {
  const tctx = { ...W.applyDerivedRouting({}), FIRST_RUN: true };

  // Unreadable store — refuse to show rather than risk a second showing.
  const badEnv = { COMMENTS: memKV({ [W.FIRST_RUN_KEY]: "not json at all" }) };
  assert.equal(await W.firstRunLanding(tctx, badEnv, NEWCOMER), "/");

  // A store whose writes fail — nothing is shown that could not first be recorded.
  const kv = memKV();
  kv.put = async () => { throw new Error("kv write refused"); };
  assert.equal(await W.firstRunLanding(tctx, { COMMENTS: kv }, NEWCOMER), "/");

  // No store at all (offline / raw build).
  assert.equal(await W.firstRunLanding(tctx, {}, NEWCOMER), "/");

  // And the flag off does exactly nothing, whatever the store holds.
  assert.equal(await W.firstRunLanding({ ...tctx, FIRST_RUN: false }, { COMMENTS: memKV() }, NEWCOMER), "/");
});

test("the record matches case-insensitively, both ways: a case-shifted roster cannot re-show, and a clear reaches every spelling", async () => {
  const tctx = { ...W.applyDerivedRouting({}), FIRST_RUN: true };
  const env = { COMMENTS: memKV() };
  assert.equal(await W.firstRunLanding(tctx, env, "Nell@Example.Test"), W.FIRST_RUN_PATH);
  assert.equal(await W.firstRunLanding(tctx, env, NEWCOMER), "/", "the same person, spelled differently, is not new");
  await W.clearFirstRunSeen(env.COMMENTS, NEWCOMER);
  assert.deepEqual(JSON.parse(await env.COMMENTS.get(W.FIRST_RUN_KEY)), {}, "the clear found the case-shifted entry");
  assert.equal(await W.firstRunLanding(tctx, env, NEWCOMER), W.FIRST_RUN_PATH, "cleared means the surface shows again");
});

test("REMOVING a person clears their record — a re-invited address is a new person and sees the surface again", async () => {
  const d = await deployment();
  const admin = await signInAdmin(d);
  const t = await d.mintLink("invite", NEWCOMER, admin.cookie);
  assert.equal(new URL((await d.redeem(t)).headers.get("Location"), ORIGIN).pathname, W.FIRST_RUN_PATH);

  const rm = await d.fire("/__admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: admin.cookie },
    body: JSON.stringify({ op: "remove", email: NEWCOMER }),
  });
  assert.equal(rm.status, 200, await rm.text());
  const seen = JSON.parse(await d.kv.get(W.FIRST_RUN_KEY));
  assert.equal(Object.keys(seen).some((k) => k.toLowerCase() === NEWCOMER), false, "the record left with the person");
});

test("an ERASURE takes the record too — the map keys an address, which a purge must not leave behind", async () => {
  const kv = memKV({ [W.FIRST_RUN_KEY]: JSON.stringify({ [NEWCOMER]: "2026-01-01T00:00:00.000Z" }) });
  const store = { backing: "mem", read: async () => ({}), mutate: async () => {} };
  const out = await W.purgeUser(store, null, kv, [{ email: NEWCOMER }], NEWCOMER);
  assert.equal(out.ok, true);
  assert.deepEqual(JSON.parse(await kv.get(W.FIRST_RUN_KEY)), {});
});

// The admin sign-in every fetch-level test above starts from.
async function signInAdmin(d) {
  return d.signIn(ADMIN, PASSWORD);
}
