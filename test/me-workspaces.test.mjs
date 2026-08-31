// GET /__me/workspaces — the cross-workspace switcher's dropdown data
// (`B-cross-workspace-signin`, Task 10). Signed-in users only, and always the CALLER'S
// OWN email — there is no email parameter, the same rule every other `/__me/*` route
// follows. Proxies `POST ${ACCOUNT_ORIGIN}/__account/workspaces` (Task 9) with THIS
// workspace's own accountKey (the same bearer `/__enter` and `noteMembershipUpstream`
// use), and marks the CURRENT workspace in the mapped result.
//
// Best-effort and inert like both of those siblings: no accountKey, no ACCOUNT_ORIGIN,
// or the account store erroring/throwing/timing out all answer `{workspaces: []}` rather
// than an error — a deployment that has not wired central sign-in must never have its
// dropdown betray the seam, and the dropdown degrades to "current workspace only".
//
// Same lightweight harness as test/membership-upstream.test.mjs: call the handler
// directly with a fake TENANTS stub rather than driving the whole worker, because the
// worker-level wiring (routing, the auth gate) is not what this task is proving.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";
import { emptyTenantContext, withTenantFields } from "../src/tenant-context.mjs";

const ACCOUNT_ORIGIN = "https://accounts.example.test";
const ACCOUNT_KEY = "workspace-bearer-abc123";
const TENANT_ID = "me-workspaces-workspace";
const ME = { email: "member@x.test", name: "Member", role: "editor" };

const CTX = (accountOrigin = ACCOUNT_ORIGIN, tenantId = TENANT_ID) =>
  withTenantFields(emptyTenantContext(tenantId), { ACCOUNT_ORIGIN: accountOrigin });

// A minimal workspace-object stub — same shape as membership-upstream's fakeTenants.
// `/account-key` is the one path this file cares about.
function fakeTenants({ accountKey, hang = false } = {}) {
  return {
    idFromName: (n) => n,
    get: () => ({
      async fetch(input) {
        const path = new URL(typeof input === "string" ? input : input.url).pathname;
        if (path === "/account-key") {
          if (hang) return new Promise(() => {});
          return accountKey ? Response.json({ accountKey }) : Response.json({});
        }
        return new Response("not found", { status: 404 });
      },
    }),
  };
}

function envWith(opts = {}) {
  const accountKey = "accountKey" in opts ? opts.accountKey : ACCOUNT_KEY;
  const tenants = "tenants" in opts ? opts.tenants : true;
  return { COMMENTS: null, ...(tenants ? { TENANTS: fakeTenants({ accountKey }) } : {}) };
}

function withStubbedFetch(responder) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return responder ? responder(String(url), init) : Response.json({ ok: true, workspaces: [] });
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const GET_REQ = () => new Request("https://x.test/__me/workspaces");

// ── not signed in ────────────────────────────────────────────────────────────────────

test("not signed in → 401, no data", async () => {
  const env = envWith();
  const { calls, restore } = withStubbedFetch();
  try {
    const res = await W.meWorkspacesApi(CTX(), GET_REQ(), env, null);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.workspaces, undefined, "an unauthenticated caller must not receive a workspace list");
    assert.equal(calls.length, 0, "no outbound call should be made for a signed-out caller");
  } finally { restore(); }
});

// ── the happy path ───────────────────────────────────────────────────────────────────

test("signed-in user → {workspaces:[...]} from the account store, marking THIS workspace current", async () => {
  const env = envWith();
  const responder = async (url, init) => {
    assert.equal(url, `${ACCOUNT_ORIGIN}/__account/workspaces`);
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, `Bearer ${ACCOUNT_KEY}`);
    const body = JSON.parse(init.body);
    assert.equal(body.email, ME.email);
    return Response.json({
      ok: true,
      workspaces: [
        { workspace: TENANT_ID, label: "This One" },
        { workspace: "other-workspace", label: "Other" },
      ],
    });
  };
  const { calls, restore } = withStubbedFetch(responder);
  try {
    const res = await W.meWorkspacesApi(CTX(), GET_REQ(), env, ME);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.workspaces, [
      { workspace: TENANT_ID, label: "This One", current: true },
      {
        workspace: "other-workspace",
        label: "Other",
        current: false,
        href: `${ACCOUNT_ORIGIN}/enter?workspace=other-workspace`,
      },
    ]);
    assert.equal(calls.length, 1);
    // The account key must never leak into the response body.
    assert.ok(!JSON.stringify(body).includes(ACCOUNT_KEY), "the account key leaked into the response body");
  } finally { restore(); }
});

test("a workspace id needing URL-encoding gets an encoded href", async () => {
  const env = envWith();
  const responder = async () => Response.json({
    ok: true,
    workspaces: [
      { workspace: TENANT_ID, label: "This One" },
      { workspace: "a workspace/with?odd=chars", label: "Odd" },
    ],
  });
  const { restore } = withStubbedFetch(responder);
  try {
    const res = await W.meWorkspacesApi(CTX(), GET_REQ(), env, ME);
    const body = await res.json();
    const odd = body.workspaces.find((w) => w.workspace === "a workspace/with?odd=chars");
    assert.equal(odd.href, `${ACCOUNT_ORIGIN}/enter?workspace=${encodeURIComponent("a workspace/with?odd=chars")}`);
    const here = body.workspaces.find((w) => w.workspace === TENANT_ID);
    assert.equal(here.href, undefined, "the current row must carry no href");
  } finally { restore(); }
});

// ── inert / best-effort cases ────────────────────────────────────────────────────────

test("no accountKey ever delivered to this workspace → {workspaces:[]}, no outbound call", async () => {
  const env = envWith({ accountKey: undefined });
  const { calls, restore } = withStubbedFetch();
  try {
    const res = await W.meWorkspacesApi(CTX(), GET_REQ(), env, ME);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { workspaces: [] });
    assert.equal(calls.length, 0, "no key to authenticate with — nothing should have been sent");
  } finally { restore(); }
});

test("no ACCOUNT_ORIGIN configured → {workspaces:[]}, no outbound call", async () => {
  const env = envWith();
  const { calls, restore } = withStubbedFetch();
  try {
    const res = await W.meWorkspacesApi(CTX(""), GET_REQ(), env, ME);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { workspaces: [] });
    assert.equal(calls.length, 0, "a deployment naming no central account store must reach no network at all");
  } finally { restore(); }
});

test("no TENANTS binding at all (a self-hosted, single-workspace instance) → {workspaces:[]}, no outbound call", async () => {
  const env = envWith({ tenants: false });
  const { calls, restore } = withStubbedFetch();
  try {
    const res = await W.meWorkspacesApi(CTX(), GET_REQ(), env, ME);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { workspaces: [] });
    assert.equal(calls.length, 0);
  } finally { restore(); }
});

test("the account store answers 500 → {workspaces:[]}, never an error page", async () => {
  const env = envWith();
  const { restore } = withStubbedFetch(async () => new Response("boom", { status: 500 }));
  try {
    const res = await W.meWorkspacesApi(CTX(), GET_REQ(), env, ME);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { workspaces: [] });
  } finally { restore(); }
});

test("a network error reaching the account store → {workspaces:[]}, never a thrown error", async () => {
  const env = envWith();
  const { restore } = withStubbedFetch(async () => { throw new Error("network down"); });
  try {
    const res = await W.meWorkspacesApi(CTX(), GET_REQ(), env, ME);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { workspaces: [] });
  } finally { restore(); }
});

test("a malformed 200 body (no workspaces array) → {workspaces:[]}, no oracle, no throw", async () => {
  const env = envWith();
  const { restore } = withStubbedFetch(async () => Response.json({ ok: true }));
  try {
    const res = await W.meWorkspacesApi(CTX(), GET_REQ(), env, ME);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { workspaces: [] });
  } finally { restore(); }
});

// ── method ────────────────────────────────────────────────────────────────────────────

test("a POST is method-not-allowed, not a proxy call", async () => {
  const env = envWith();
  const { calls, restore } = withStubbedFetch();
  try {
    const res = await W.meWorkspacesApi(CTX(), new Request("https://x.test/__me/workspaces", { method: "POST" }), env, ME);
    assert.equal(res.status, 405);
    assert.equal(calls.length, 0);
  } finally { restore(); }
});
