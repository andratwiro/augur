// The space's OWN passwordless login (`B-passwordless-space-sign-in`): "Sign in with email"
// on the workspace's own gate, the "we emailed you a code" screen, and the two POSTs that run
// the flow FROM the space over its own account-store bearer. Same harness as
// test/cross-workspace-enter.test.mjs — the real worker via worker.fetch, a real TenantStore
// behind TENANTS, ASSETS-mode config, and the outbound call to the control plane stubbed as
// globalThis.fetch (the one seam src/_worker.js offers for an outbound call).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { TenantStore } from "../src/tenant-do.js";

const { default: worker, __testables: W } = await import("../src/_worker.js");

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
const control = (store, verb, body) =>
  store.fetch(new Request(`https://tenant.invalid/__control/${verb}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}),
  }));

const ORIGIN = "https://example.test";
const ACCOUNT_ORIGIN = "https://accounts.example.test";
const ADMIN_EMAIL = "member@example.test";
const ACCOUNT_KEY = "workspace-bearer-abc123";
const ROSTER = [{ email: ADMIN_EMAIL, name: "Mem Ber", initials: "M", role: "admin" }];

function memKV() {
  const store = new Map();
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
  };
}
function configFor({ accountOrigin }) {
  return {
    "/__config/instance.json": JSON.stringify({
      users: ROSTER, engineVersion: "1.0.0-pwl", updateFeed: "",
      mcpHostSuffixes: [], mcpHostAllowlistUrl: "", vanityRedirects: {}, rtOrigin: "", sentinels: [],
      accountOrigin, sessionKeys: true,
    }),
    "/__config/routing.json": JSON.stringify({
      buildId: "pwl-build", versionMap: {}, publicPrefixes: [], publicSkillPrefixes: [],
      restrictedBases: [], canvasLoaderExtras: "", canvasCatalog: [], canvasTracks: [], mcpAllowlist: [],
      spaces: [{ id: "one", name: "One", badge: "O", default: true, base: "", adminOnly: false }],
      defaultSpace: "one",
    }),
  };
}

let seq = 0;
async function deployment({ accountOrigin = ACCOUNT_ORIGIN, withAccountKey = true } = {}) {
  const tenantId = `pwl-${++seq}`;
  const store = freshStore();
  await store.provision({ workspaceId: tenantId, adminEmail: ADMIN_EMAIL });
  if (withAccountKey) {
    const set = await control(store, "account-key", { accountKey: ACCOUNT_KEY });
    assert.equal(set.status, 200, "fixture could not deliver the account key");
  }
  const CONFIG = configFor({ accountOrigin });
  const pending = [];
  const env = {
    COMMENTS: memKV(),
    SESSION_SECRET: "pwl-fixed-session-secret",
    TENANTS: {
      idFromName: (n) => n,
      get: (n) => { assert.equal(n, tenantId); return { fetch: (i, init) => store.fetch(new Request(i, init)) }; },
    },
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
  const fetch_ = (path, init) => worker.fetch(new Request(`${ORIGIN}${path}`, init), env, { waitUntil: (p) => pending.push(p) });
  const drain = () => Promise.all(pending.splice(0));
  return { tenantId, env, fetch_, drain };
}

function withStubbedFetch(responder) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return responder(String(url), init); };
  return { calls, restore: () => { globalThis.fetch = real; } };
}
const post = (body) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });

// ── the login gate renders passwordless when there is an account store ───────────────

test("signed-out gate is passwordless (Sign in with email, POST /__signin) when ACCOUNT_ORIGIN is set", async () => {
  const { fetch_ } = await deployment();
  const res = await fetch_("/");
  const html = await res.text();
  assert.match(html, /Sign in with email/);
  assert.match(html, /action="\/__signin"/);
  assert.doesNotMatch(html, /type="password"/, "no password field in passwordless mode");
});

test("signed-out gate keeps email+password when there is NO account store", async () => {
  const { fetch_ } = await deployment({ accountOrigin: "" });
  const html = await (await fetch_("/")).text();
  assert.match(html, /type="password"/);
  assert.match(html, /action="\/__auth"/);
  assert.doesNotMatch(html, /Sign in with email/);
});

// ── POST /__signin: proxy the send to the control plane, render the code screen ──────

test("POST /__signin asks the control plane to mail a code+link for THIS workspace, then shows the code screen", async () => {
  const { fetch_, drain } = await deployment();
  const stub = withStubbedFetch(async (url, init) => {
    assert.equal(url, `${ACCOUNT_ORIGIN}/__account/signin-link`);
    assert.equal(init.headers.Authorization, `Bearer ${ACCOUNT_KEY}`, "authenticated as this workspace");
    assert.deepEqual(JSON.parse(init.body), { email: "member@example.test" });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  });
  try {
    const res = await fetch_("/__signin", post({ email: "member@example.test" }));
    await drain();
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /emailed you a code/i);
    assert.match(html, /name="code"/);
    assert.equal(stub.calls.length, 1, "exactly one outbound call, to signin-link");
  } finally { stub.restore(); }
});

// ── POST /__signin/code: verify, then bounce to /enter-by-code ───────────────────────

test("POST /__signin/code bounces to /enter-by-code on the control plane when the code verifies", async () => {
  const { fetch_ } = await deployment();
  const stub = withStubbedFetch(async (url, init) => {
    assert.equal(url, `${ACCOUNT_ORIGIN}/__account/verify-code`);
    assert.equal(init.headers.Authorization, `Bearer ${ACCOUNT_KEY}`);
    assert.deepEqual(JSON.parse(init.body), { email: "member@example.test", code: "123456" });
    return new Response(JSON.stringify({ ok: true, ticket: "TICKET123" }), { status: 200, headers: { "content-type": "application/json" } });
  });
  try {
    const res = await fetch_("/__signin/code", post({ email: "member@example.test", code: "123456" }));
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), `${ACCOUNT_ORIGIN}/enter-by-code?ticket=TICKET123`);
  } finally { stub.restore(); }
});

test("POST /__signin/code re-renders the code screen with an error when the code is wrong", async () => {
  const { fetch_ } = await deployment();
  const stub = withStubbedFetch(async () =>
    new Response(JSON.stringify({ ok: false, error: "bad-code" }), { status: 401, headers: { "content-type": "application/json" } }));
  try {
    const res = await fetch_("/__signin/code", post({ email: "member@example.test", code: "000000" }));
    assert.equal(res.status, 401);
    const html = await res.text();
    assert.match(html, /name="code"/, "still the code screen");
    assert.match(html, /didn.t work|try again|new one/i, "with an error");
  } finally { stub.restore(); }
});

test("the sign-in doors are POST-only", async () => {
  const { fetch_ } = await deployment();
  assert.equal((await fetch_("/__signin")).status, 405);
  assert.equal((await fetch_("/__signin/code")).status, 405);
});
