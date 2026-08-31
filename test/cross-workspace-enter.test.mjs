// GET /__enter?handoff=<token> — the cross-workspace switcher's landing point
// (`B-cross-workspace-signin`). This is the CORE security boundary: the control plane
// proves WHO (an email, already authenticated on its side), and this workspace decides
// WHAT (whether that email is on ITS OWN roster). A hand-off is never sufficient by
// itself.
//
// ── WHAT IS PROVEN HERE ──────────────────────────────────────────────────────────────
//
// Same harness as test/dormancy-resume.test.mjs's END TO END cases: the real worker via
// `worker.fetch`, driving a real `TenantStore` (`node:sqlite` behind a storage stub with
// real transaction semantics) behind a `TENANTS` binding, ASSETS-mode config. Not
// workerd — see that file's header for what a stub cannot prove and why the item's own
// VERIFY still needs a rehearsal deployment for the wire format this stands in for
// (`/__account/handoff` on the control plane's own account store, stubbed here as
// `globalThis.fetch`).
//
// ── THE ONE ASSERTION THAT MATTERS MOST ──────────────────────────────────────────────
//
// A non-member's valid hand-off must not merely 404 — it must answer BYTE-IDENTICAL to
// what a stranger with no hand-off at all gets (`unknownHostResponse()`, status AND
// body), so nothing about the response can tell a caller "that email exists, just not
// on this workspace's roster". Every other refusal on this path is held to the same bar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { TenantStore } from "../src/tenant-do.js";

const { default: worker, __testables: W } = await import("../src/_worker.js");

// ---- the workspace object: real TenantStore, node:sqlite behind a storage stub --------
// Identical to test/dormancy-resume.test.mjs and test/tenant-verbs.test.mjs — real
// transaction semantics, so a rollback (if this path ever needed one) would be tested and
// not mimed.
function storage(db) {
  const sql = {
    exec(stmt, ...params) {
      if (params.length) {
        const s = db.prepare(stmt);
        return /^\s*SELECT/i.test(stmt) ? s.all(...params) : (s.run(...params), []);
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

function freshStore() {
  const db = new DatabaseSync(":memory:");
  const ctx = { storage: storage(db), blockConcurrencyWhile: async (f) => f() };
  return new TenantStore(ctx, {});
}

const control = (store, verb, body, method = "POST") =>
  store.fetch(new Request(`https://tenant.invalid/__control/${verb}`, {
    method,
    headers: { "content-type": "application/json" },
    body: method === "POST" ? JSON.stringify(body || {}) : undefined,
  }));

// ---- the fixture -----------------------------------------------------------------------

const ORIGIN = "https://example.test";
const ACCOUNT_ORIGIN = "https://accounts.example.test";
const MEMBER_EMAIL = "member@example.test";
// Not on the roster, and never provisioned into the object either — a plain stranger to
// this workspace, the same as somebody who never had a hand-off at all.
const STRANGER_EMAIL = "stranger@example.test";
const ACCOUNT_KEY = "workspace-bearer-abc123";
const HANDOFF_TOKEN = "handoff-token-for-member";

// The provisioned admin IS the roster's only member, mirroring dormancy-resume's fixture
// shape (its ADMIN is both the object's provisioned admin and the config's admin row) —
// the merge between the object's own member row and instance.json's config list is
// already exercised there; duplicating a second shape here would prove nothing new.
const ROSTER = [
  { email: MEMBER_EMAIL, name: "Mem Ber", initials: "M", role: "admin" },
];

function memKV() {
  const store = new Map();
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
  };
}

function configFor({ accountOrigin, sessionKeys }) {
  return {
    "/__config/instance.json": JSON.stringify({
      users: ROSTER, engineVersion: "1.0.0-enter", updateFeed: "",
      mcpHostSuffixes: [], mcpHostAllowlistUrl: "", vanityRedirects: {}, rtOrigin: "", sentinels: [],
      accountOrigin, sessionKeys,
    }),
    "/__config/routing.json": JSON.stringify({
      buildId: "enter-build", versionMap: {}, publicPrefixes: [], publicSkillPrefixes: [],
      restrictedBases: [], canvasLoaderExtras: "", canvasCatalog: [], canvasTracks: [], mcpAllowlist: [],
      spaces: [{ id: "one", name: "One", badge: "O", default: true, base: "", adminOnly: false }],
      defaultSpace: "one",
    }),
  };
}

let seq = 0;

/**
 * One deployment: the real worker, one real workspace object behind `TENANTS` (or none,
 * for the single-workspace case), ASSETS-mode config — same wiring
 * test/dormancy-resume.test.mjs uses to drive real `POST /__auth`, aimed at `GET /__enter`
 * instead.
 *
 * A FRESH ID PER CASE, for the same reason dormancy-resume gives one: several per-isolate
 * caches (config, suspension) are keyed by tenant id and TTL'd, so two cases sharing one
 * id would read each other's cached answer.
 */
async function deployment({
  accountOrigin = ACCOUNT_ORIGIN,
  withAccountKey = true,
  accountKey = ACCOUNT_KEY,
  sessionKeys = true,
  suspend = null,
  tenants = true,
} = {}) {
  const tenantId = `enter-${++seq}`;
  const store = freshStore();
  await store.provision({ workspaceId: tenantId, adminEmail: MEMBER_EMAIL });
  if (withAccountKey) {
    const set = await control(store, "account-key", { accountKey });
    assert.equal(set.status, 200, "fixture could not deliver the account key");
  }
  if (suspend) assert.equal(store.suspend(suspend, "2026-01-01T00:00:00.000Z").changed, true);

  const CONFIG = configFor({ accountOrigin, sessionKeys });
  const pending = [];
  const env = {
    COMMENTS: memKV(),
    SESSION_SECRET: "enter-fixed-session-secret",
    ...(tenants ? {
      TENANTS: {
        idFromName: (n) => n,
        get: (n) => {
          assert.equal(n, tenantId, "the worker reached for another workspace's object");
          return { fetch: (input, init) => store.fetch(new Request(input, init)) };
        },
      },
    } : {}),
    ASSETS: {
      async fetch(req) {
        const p = new URL(typeof req === "string" ? req : req.url).pathname;
        const body = CONFIG[p];
        return body === undefined
          ? new Response("Not Found", { status: 404 })
          : new Response(body, { headers: { "Content-Type": "application/json; charset=utf-8" } });
      },
    },
  };
  W.__setTenantTestState({ memo: { at: Date.now(), tenantId } });
  const enter = (handoff) => worker.fetch(
    new Request(`${ORIGIN}${W.WORKSPACE_ENTER_PATH}${handoff !== undefined ? `?handoff=${encodeURIComponent(handoff)}` : ""}`),
    env, { waitUntil: (p) => pending.push(p) },
  );
  const drain = () => Promise.all(pending.splice(0));
  return { tenantId, store, env, enter, drain };
}

// ---- the account store stub -------------------------------------------------------------
// The worker's outbound POST to `${ACCOUNT_ORIGIN}/__account/handoff` — global `fetch` is
// the only seam src/_worker.js offers for an outbound call (the update-feed check and the
// shell-dispatch caller both use it bare), stubbed and restored per test exactly like
// test/roster-sync.test.mjs's withStubbedFetch.
function withStubbedFetch(responder) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return responder(String(url), init);
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const handoffResponder = (validToken, email) => async (url, init) => {
  assert.equal(url, `${ACCOUNT_ORIGIN}/__account/handoff`, "the worker called the wrong URL");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, `Bearer ${ACCOUNT_KEY}`, "the worker did not authenticate as this workspace");
  const body = JSON.parse(init.body);
  if (body.token !== validToken) return Response.json({ error: "invalid-token" }, { status: 404 });
  return Response.json({ email });
};

// ---- the reference answer: what a stranger gets, computed once from the SAME function -
const STRANGER_RES = W.unknownHostResponse();
const STRANGER_STATUS = STRANGER_RES.status;
const STRANGER_BODY = await STRANGER_RES.text();

async function assertStrangerAnswer(res, why) {
  assert.equal(res.status, STRANGER_STATUS, why);
  assert.equal(await res.text(), STRANGER_BODY, why);
}

// ── the happy path ───────────────────────────────────────────────────────────────────

test("MEMBER + valid hand-off → 303, a session cookie, and a follow-up request identifies them", async () => {
  const { enter, drain, env } = await deployment();
  const { restore } = withStubbedFetch(handoffResponder(HANDOFF_TOKEN, MEMBER_EMAIL));
  try {
    const res = await enter(HANDOFF_TOKEN);
    await drain();
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("Location"), "/");
    assert.equal(res.headers.get("Cache-Control"), "no-store");

    const setCookie = res.headers.get("Set-Cookie") || "";
    assert.match(setCookie, /^__Host-augur_user=member@example\.test\.[0-9a-f]+;/, "the cookie does not name the member");
    assert.match(setCookie, /Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800/);
    assert.ok(!/Domain=/.test(setCookie), "the cookie carries a Domain attribute — __Host- requires none");

    const cookie = setCookie.split(";")[0];
    const me = await worker.fetch(new Request(`${ORIGIN}/__me`, { headers: { Cookie: cookie } }), env, { waitUntil() {} });
    const meBody = await me.json();
    assert.equal(meBody.user && meBody.user.email, MEMBER_EMAIL, "the minted session did not identify as the member");
  } finally { restore(); }
});

// ── the boundary this task exists for ───────────────────────────────────────────────────

test("NON-MEMBER — a valid hand-off for an email not on this workspace's roster is a stranger", async () => {
  const { enter, drain } = await deployment();
  const { restore } = withStubbedFetch(handoffResponder(HANDOFF_TOKEN, STRANGER_EMAIL));
  try {
    const res = await enter(HANDOFF_TOKEN);
    await drain();
    assert.equal(res.headers.get("Set-Cookie"), null, "a non-member was handed a session cookie");
    await assertStrangerAnswer(res, "a non-member's hand-off did not get the stranger's exact answer");
  } finally { restore(); }
});

// ── every other non-success is the same answer ──────────────────────────────────────────

test("a bad/expired hand-off (the account store refuses it) → the same stranger's answer", async () => {
  const { enter, drain } = await deployment();
  const { restore } = withStubbedFetch(async () => Response.json({ error: "expired" }, { status: 404 }));
  try {
    const res = await enter("whatever-token");
    await drain();
    await assertStrangerAnswer(res, "an expired hand-off did not get the stranger's exact answer");
  } finally { restore(); }
});

test("the account store answers 200 with no email → the same stranger's answer (no oracle on a malformed body)", async () => {
  const { enter, drain } = await deployment();
  const { restore } = withStubbedFetch(async () => Response.json({ ok: true }));
  try {
    const res = await enter("whatever-token");
    await drain();
    await assertStrangerAnswer(res);
  } finally { restore(); }
});

test("a network error reaching the account store → the same stranger's answer", async () => {
  const { enter, drain } = await deployment();
  const { restore } = withStubbedFetch(async () => { throw new Error("network down"); });
  try {
    const res = await enter("whatever-token");
    await drain();
    await assertStrangerAnswer(res);
  } finally { restore(); }
});

test("no handoff query param at all → the stranger's answer, and the account store is never called", async () => {
  const { enter, drain } = await deployment();
  const { calls, restore } = withStubbedFetch(handoffResponder(HANDOFF_TOKEN, MEMBER_EMAIL));
  try {
    const res = await enter(undefined);
    await drain();
    await assertStrangerAnswer(res);
    assert.equal(calls.length, 0, "the account store was called with no handoff token at all");
  } finally { restore(); }
});

test("an empty handoff query param → the stranger's answer, and the account store is never called", async () => {
  const { enter, drain } = await deployment();
  const { calls, restore } = withStubbedFetch(handoffResponder(HANDOFF_TOKEN, MEMBER_EMAIL));
  try {
    const res = await enter("");
    await drain();
    await assertStrangerAnswer(res);
    assert.equal(calls.length, 0);
  } finally { restore(); }
});

test("no account-key ever delivered to this workspace → the stranger's answer; route is inert, no outbound call", async () => {
  const { enter, drain } = await deployment({ withAccountKey: false });
  const { calls, restore } = withStubbedFetch(handoffResponder(HANDOFF_TOKEN, MEMBER_EMAIL));
  try {
    const res = await enter(HANDOFF_TOKEN);
    await drain();
    await assertStrangerAnswer(res, "no key delivered yet did not answer exactly like a stranger");
    assert.equal(calls.length, 0, "the worker called the account store with no key to authenticate with");
  } finally { restore(); }
});

test("no ACCOUNT_ORIGIN configured → the stranger's answer; route is inert, no outbound call", async () => {
  const { enter, drain } = await deployment({ accountOrigin: "" });
  const { calls, restore } = withStubbedFetch(handoffResponder(HANDOFF_TOKEN, MEMBER_EMAIL));
  try {
    const res = await enter(HANDOFF_TOKEN);
    await drain();
    await assertStrangerAnswer(res);
    assert.equal(calls.length, 0, "an unconfigured deployment still reached the network");
  } finally { restore(); }
});

test("no TENANTS binding at all (a self-hosted, single-workspace instance) → the stranger's answer", async () => {
  const { enter, drain } = await deployment({ tenants: false });
  const { calls, restore } = withStubbedFetch(handoffResponder(HANDOFF_TOKEN, MEMBER_EMAIL));
  try {
    const res = await enter(HANDOFF_TOKEN);
    await drain();
    await assertStrangerAnswer(res, "a single-workspace instance answered something other than inert");
    assert.equal(calls.length, 0);
  } finally { restore(); }
});

// ── the suspension gate answers first ───────────────────────────────────────────────────

test("a SUSPENDED workspace answers the suspension page, never a session — /__enter never runs", async () => {
  const { enter, drain } = await deployment({ suspend: "dormant" });
  const { calls, restore } = withStubbedFetch(handoffResponder(HANDOFF_TOKEN, MEMBER_EMAIL));
  try {
    const res = await enter(HANDOFF_TOKEN);
    await drain();
    assert.equal(res.status, 503);
    assert.match(await res.text(), /paused/i);
    assert.equal(res.headers.get("Set-Cookie"), null, "a suspended workspace minted a session");
    assert.equal(calls.length, 0, "a suspended workspace's /__enter reached the account store at all");
  } finally { restore(); }
});

// ── shape checks ─────────────────────────────────────────────────────────────────────────

test("WORKSPACE_ENTER_PATH matches the control plane's own spelling", () => {
  assert.equal(W.WORKSPACE_ENTER_PATH, "/__enter");
});

test("/__enter is NOT on SUSPENDED_ALLOWED — the suspension gate must answer before it ever runs", () => {
  assert.ok(!W.SUSPENDED_ALLOWED.includes(W.WORKSPACE_ENTER_PATH));
});

test("a POST to /__enter is Method Not Allowed, not a session mint", async () => {
  const { env } = await deployment();
  const res = await worker.fetch(new Request(`${ORIGIN}${W.WORKSPACE_ENTER_PATH}?handoff=x`, { method: "POST" }), env, { waitUntil() {} });
  assert.equal(res.status, 405);
});
