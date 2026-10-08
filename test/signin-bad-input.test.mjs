// A malformed sign-in request is refused with 400, not crashed into a 500, and an empty
// address is never forwarded to the control plane.
//
// Two things the logs showed (engine audit, 8 Oct 2026):
// - 5 Oct 20:29Z, `POST /__signin` 500 "Parsing a Body as FormData requires a Content-Type
//   header": `request.formData()` was unguarded, so a body without a form content type threw
//   and surfaced as a server error.
// - 8 Oct 05:18Z and 05:31Z, control plane `mail-send-failed` with an empty recipient: the
//   code screen's "request a new code" form posts a hidden `email` that is empty when the
//   screen was reached without one, and `signinFromSpace` forwarded "" to the control plane,
//   which asked the mail provider to send to nobody.
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
const ACCOUNT_KEY = "workspace-bearer-abc123";
const ADMIN_EMAIL = "member@example.test";
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
const form = (body) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
const ok = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });

test("POST /__signin with a body that is not a form is a 400, not a 500", async () => {
  const { fetch_ } = await deployment();
  const stub = withStubbedFetch(ok);
  try {
    for (const path of ["/__signin", "/__signin/code"]) {
      const res = await fetch_(path, { method: "POST", body: "email=x" }); // no Content-Type at all
      assert.equal(res.status, 400, `${path}: a bodyless-content-type POST must be refused, not crash`);
      const json = await fetch_(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(json.status, 400, `${path}: a JSON body is not a form`);
    }
    assert.equal(stub.calls.length, 0, "nothing reached the control plane");
  } finally { stub.restore(); }
});

test("POST /__signin with an empty or malformed address never asks the control plane to mail it", async () => {
  const { fetch_ } = await deployment();
  const stub = withStubbedFetch(ok);
  try {
    for (const email of ["", "   ", "not-an-address", "a@b", "@example.test", "x".repeat(250) + "@e.te"]) {
      const res = await fetch_("/__signin", form({ email }));
      assert.equal(res.status, 400, `address ${JSON.stringify(email)} was accepted`);
      const html = await res.text();
      assert.match(html, /action="\/__signin"/, "the sign-in form is shown again");
      assert.match(html, /role="alert"/, "with an error the person can read");
      assert.doesNotMatch(html, /We emailed a 6-digit code/, "and no code screen for a code nobody was sent");
    }
    const missing = await fetch_("/__signin", form({}));
    assert.equal(missing.status, 400, "a form with no email field");
    assert.equal(stub.calls.length, 0, "the control plane was never asked to send to an empty address");
  } finally { stub.restore(); }
});

test("POST /__signin/code with an empty address is a 400 and the control plane is not asked", async () => {
  const { fetch_ } = await deployment();
  const stub = withStubbedFetch(ok);
  try {
    const res = await fetch_("/__signin/code", form({ email: "", code: "123456" }));
    assert.equal(res.status, 400);
    assert.equal(stub.calls.length, 0);
  } finally { stub.restore(); }
});

test("a well-formed address still goes through exactly as before", async () => {
  const { fetch_ } = await deployment();
  const stub = withStubbedFetch(ok);
  try {
    const res = await fetch_("/__signin", form({ email: " Member@Example.test " }));
    assert.equal(res.status, 200);
    assert.equal(stub.calls.length, 1, "one call to signin-link");
    assert.equal(JSON.parse(stub.calls[0].init.body).email, "Member@Example.test", "trimmed, otherwise untouched");
  } finally { stub.restore(); }
});
