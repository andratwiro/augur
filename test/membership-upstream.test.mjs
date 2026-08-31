// Membership notify: when a workspace's roster changes, the engine tells the
// control-plane account store — `B-cross-workspace-signin`'s write half, `/__enter`
// being the read half — so the cross-workspace switcher (`/workspaces`) lists the right
// workspaces for a person. `noteMembershipUpstream` is the helper; `adminUsersApi`'s
// invite and remove branches call it, and `reconcile-membership` backfills a workspace
// whose memberships predate it.
//
// CONTRACT (verified from the control plane's own source): `POST
// ${ACCOUNT_ORIGIN}/__account/index`, `Authorization: Bearer <accountKey>`, body
// `{verb: "joined"|"left", email, at, label}` — `at` a millisecond timestamp, `label`
// the workspace's display name for "joined" and null for "left".
//
// PRESENTATION-ONLY, so this file's other job is proving the negative: it must never
// fail or delay the admin operation that triggered it, with or without an accountKey,
// with or without ACCOUNT_ORIGIN, and whether the account store answers, errors, or
// never answers at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";
import { emptyTenantContext, withTenantFields } from "../src/tenant-context.mjs";

const ACCOUNT_ORIGIN = "https://accounts.example.test";
const ACCOUNT_KEY = "workspace-bearer-abc123";
const TENANT_ID = "membership-upstream-workspace";

const SPACES = [{ id: "main", name: "Acme Workspace", default: true, base: "" }];
const ME = { email: "admin@x.test", name: "Admin", role: "admin" };

const CTX = (accountOrigin = ACCOUNT_ORIGIN) =>
  withTenantFields(emptyTenantContext(TENANT_ID), { ACCOUNT_ORIGIN: accountOrigin });

function memKV() {
  const store = new Map();
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, String(v)); },
    async delete(k) { store.delete(k); },
    async list({ prefix = "" } = {}) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}

// A minimal workspace-object stub. `/account-key` is the one path this file cares about;
// every `/identity/*` op the invite/remove flow also happens to touch (invite mint/revoke,
// roster mirror, lastseen forget) is answered `ok:true` so THIS file stays about the
// notify and not about re-proving the object's own identity protocol — that is
// kv-read-cutover.test.mjs's and roster-promotion.test.mjs's job.
function fakeTenants({ accountKey, hang = false } = {}) {
  return {
    idFromName: (n) => n,
    get: () => ({
      async fetch(input) {
        const path = new URL(typeof input === "string" ? input : input.url).pathname;
        if (path === "/account-key") {
          if (hang) return new Promise(() => {}); // never resolves
          return accountKey ? Response.json({ accountKey }) : Response.json({});
        }
        if (path.startsWith("/identity/")) return Response.json({ ok: true, map: {}, entry: null });
        return new Response("not found", { status: 404 });
      },
    }),
  };
}

const usersUrl = new URL("https://x.test/__admin/users");
const adminReq = (body) => new Request("https://x.test/__admin/users", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

function withStubbedFetch(responder) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return responder ? responder(String(url), init) : Response.json({ ok: true });
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

function waitingCtx() {
  const pending = [];
  return { ctx: { waitUntil: (p) => pending.push(p) }, drain: () => Promise.all(pending.splice(0)) };
}

// ── invite → "joined" ────────────────────────────────────────────────────────────────

test("an admin invite fires exactly one POST /__account/index, bearer = accountKey, {verb:'joined', email, at, label}", async () => {
  const env = { COMMENTS: memKV(), TENANTS: fakeTenants({ accountKey: ACCOUNT_KEY }) };
  const { calls, restore } = withStubbedFetch();
  const { ctx, drain } = waitingCtx();
  try {
    const res = await W.adminUsersApi(CTX(), adminReq({ op: "invite", email: "new@x.test", name: "New Person" }),
      usersUrl, env, ME, [ME], [ME], SPACES, ctx);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true, "the invite itself must succeed regardless of the notify");
    await drain();

    assert.equal(calls.length, 1, "expected exactly one outbound notify");
    assert.equal(calls[0].url, `${ACCOUNT_ORIGIN}/__account/index`);
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${ACCOUNT_KEY}`,
      "must authenticate as THIS workspace's own bearer");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.verb, "joined");
    assert.equal(body.email, "new@x.test");
    assert.equal(body.label, "Acme Workspace");
    assert.equal(typeof body.at, "number", "`at` must be a millisecond ordering token");
    assert.ok(Math.abs(Date.now() - body.at) < 5000, "`at` should be roughly now");
  } finally { restore(); }
});

// ── remove → "left" ──────────────────────────────────────────────────────────────────

test("a removal fires exactly one POST /__account/index with {verb:'left', email}, no label", async () => {
  const gone = { email: "old@x.test", name: "Old", role: "editor" };
  const env = { COMMENTS: memKV(), TENANTS: fakeTenants({ accountKey: ACCOUNT_KEY }) };
  const { calls, restore } = withStubbedFetch();
  const { ctx, drain } = waitingCtx();
  try {
    const res = await W.adminUsersApi(CTX(), adminReq({ op: "remove", email: gone.email }),
      usersUrl, env, ME, [ME, gone], [ME, gone], SPACES, ctx);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
    await drain();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${ACCOUNT_ORIGIN}/__account/index`);
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${ACCOUNT_KEY}`);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.verb, "left");
    assert.equal(body.email, gone.email);
    assert.equal(body.label ?? null, null, "label is null/omitted for a 'left' notify");
  } finally { restore(); }
});

// ── backwards-compat: no accountKey, no ACCOUNT_ORIGIN ──────────────────────────────

test("no accountKey ever delivered to this workspace → no outbound call, and the invite still succeeds", async () => {
  const env = { COMMENTS: memKV(), TENANTS: fakeTenants({ accountKey: undefined }) };
  const { calls, restore } = withStubbedFetch();
  const { ctx, drain } = waitingCtx();
  try {
    const res = await W.adminUsersApi(CTX(), adminReq({ op: "invite", email: "new@x.test" }),
      usersUrl, env, ME, [ME], [ME], SPACES, ctx);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
    await drain();
    assert.equal(calls.length, 0, "no key to authenticate with — nothing should have been sent");
  } finally { restore(); }
});

test("no ACCOUNT_ORIGIN configured → no outbound call at all, and the invite still succeeds (byte-for-byte prior behavior)", async () => {
  const env = { COMMENTS: memKV(), TENANTS: fakeTenants({ accountKey: ACCOUNT_KEY }) };
  const { calls, restore } = withStubbedFetch();
  const { ctx, drain } = waitingCtx();
  try {
    const res = await W.adminUsersApi(CTX(""), adminReq({ op: "invite", email: "new@x.test" }),
      usersUrl, env, ME, [ME], [ME], SPACES, ctx);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
    await drain();
    assert.equal(calls.length, 0, "a deployment naming no central account store must reach no network at all");
  } finally { restore(); }
});

test("no TENANTS binding at all (a self-hosted, single-workspace instance) → no outbound call, invite still succeeds", async () => {
  const env = { COMMENTS: memKV() }; // no TENANTS
  const { calls, restore } = withStubbedFetch();
  const { ctx, drain } = waitingCtx();
  try {
    const res = await W.adminUsersApi(CTX(), adminReq({ op: "invite", email: "new@x.test" }),
      usersUrl, env, ME, [ME], [ME], SPACES, ctx);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
    await drain();
    assert.equal(calls.length, 0, "tenantAccountKey is null with no TENANTS binding, so this should never reach the network");
  } finally { restore(); }
});

test("adminUsersApi called with no ctx at all (older call shape) → no throw, no call, admin op unaffected", async () => {
  // Mirrors every pre-existing caller of adminUsersApi in this suite, which never passed a
  // ctx. The notify has nowhere to hand its work off to and must simply do nothing.
  const env = { COMMENTS: memKV(), TENANTS: fakeTenants({ accountKey: ACCOUNT_KEY }) };
  const { calls, restore } = withStubbedFetch();
  try {
    const res = await W.adminUsersApi(CTX(), adminReq({ op: "invite", email: "new@x.test" }), usersUrl, env, ME, [ME], [ME]);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
    assert.equal(calls.length, 0);
  } finally { restore(); }
});

// ── best-effort: the account store's own failure must never surface ─────────────────

test("the account store answering 500 does not fail the invite", async () => {
  const env = { COMMENTS: memKV(), TENANTS: fakeTenants({ accountKey: ACCOUNT_KEY }) };
  const { restore } = withStubbedFetch(async () => new Response("boom", { status: 500 }));
  const { ctx, drain } = waitingCtx();
  try {
    const res = await W.adminUsersApi(CTX(), adminReq({ op: "invite", email: "new@x.test" }),
      usersUrl, env, ME, [ME], [ME], SPACES, ctx);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
    await assert.doesNotReject(drain(), "a failing account store must not surface as a rejected waitUntil promise");
  } finally { restore(); }
});

test("a network error reaching the account store does not fail the removal", async () => {
  const gone = { email: "old@x.test", name: "Old", role: "editor" };
  const env = { COMMENTS: memKV(), TENANTS: fakeTenants({ accountKey: ACCOUNT_KEY }) };
  const { restore } = withStubbedFetch(async () => { throw new Error("network down"); });
  const { ctx, drain } = waitingCtx();
  try {
    const res = await W.adminUsersApi(CTX(), adminReq({ op: "remove", email: gone.email }),
      usersUrl, env, ME, [ME, gone], [ME, gone], SPACES, ctx);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
    await assert.doesNotReject(drain());
  } finally { restore(); }
});

// ── the whole point: the notify never sits on the response's critical path ──────────

test("a workspace object that never answers /account-key does not delay the invite's response", async () => {
  const env = { COMMENTS: memKV(), TENANTS: fakeTenants({ hang: true }) };
  const { restore } = withStubbedFetch();
  const { ctx } = waitingCtx();
  try {
    const res = await Promise.race([
      W.adminUsersApi(CTX(), adminReq({ op: "invite", email: "new@x.test" }), usersUrl, env, ME, [ME], [ME], SPACES, ctx),
      new Promise((_, reject) => setTimeout(() => reject(new Error("the admin response waited on the notify's DO read")), 500)),
    ]);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
    // Deliberately never drained — the hung promise is left pending, exactly as it would
    // be on a real isolate, and must not have kept this test waiting to get here.
  } finally { restore(); }
});

// ── reconcile-membership: the backfill ───────────────────────────────────────────────

test("reconcile-membership fires one 'joined' notify per current roster member", async () => {
  const other = { email: "other@x.test", name: "Other", role: "editor" };
  const env = { COMMENTS: memKV(), TENANTS: fakeTenants({ accountKey: ACCOUNT_KEY }) };
  const { calls, restore } = withStubbedFetch();
  const { ctx, drain } = waitingCtx();
  try {
    const res = await W.adminUsersApi(CTX(), adminReq({ op: "reconcile-membership" }),
      usersUrl, env, ME, [ME, other], [ME, other], SPACES, ctx);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.notified, 2);
    await drain();

    assert.equal(calls.length, 2);
    const byEmail = Object.fromEntries(calls.map((c) => [JSON.parse(c.init.body).email, JSON.parse(c.init.body)]));
    assert.equal(byEmail[ME.email].verb, "joined");
    assert.equal(byEmail[other.email].verb, "joined");
    assert.equal(byEmail[ME.email].label, "Acme Workspace");
  } finally { restore(); }
});

test("reconcile-membership is idempotent to call twice — same shape, same count, no throw", async () => {
  const env = { COMMENTS: memKV(), TENANTS: fakeTenants({ accountKey: ACCOUNT_KEY }) };
  const { calls, restore } = withStubbedFetch();
  const { ctx, drain } = waitingCtx();
  try {
    for (let i = 0; i < 2; i++) {
      const res = await W.adminUsersApi(CTX(), adminReq({ op: "reconcile-membership" }),
        usersUrl, env, ME, [ME], [ME], SPACES, ctx);
      assert.equal((await res.json()).notified, 1);
    }
    await drain();
    assert.equal(calls.length, 2, "two runs, one notify each — the account store's own at-CAS is what makes repeats harmless");
  } finally { restore(); }
});
