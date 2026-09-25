// (harness copied from the passwordless sign-in test)
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


// ── /__report: the failure reporter's sink ───────────────────────────────────────────
// One anonymous log line per report, from a closed vocabulary. Nothing the request carried
// (cookie, address, headers) can reach the line, and a cross-site post writes nothing.

function capture() {
  const lines = []; const real = console.log;
  console.log = (l) => { try { const j = JSON.parse(l); if (j.event === "client-report") lines.push(j); } catch (e) {} };
  return { lines, restore: () => { console.log = real; } };
}
const reportPost = (body, headers = {}) => ({ method: "POST", headers: { "content-type": "application/json", Origin: ORIGIN, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

test("a report becomes one anonymous log line, whoever is signed in", async () => {
  const { fetch_, tenantId } = await deployment();
  const c = capture();
  try {
    const res = await fetch_("/__report", reportPost([
      { kind: "action-failed", action: "comment.add", status: 403, tab: "ab12cd34", path: "/opp/x/?email=ada@example.test" },
      { kind: "js-error", msg: "boom for ada@example.test", src: "/__canvas/canvas.js?v=3", line: 42, tab: "ab12cd34" },
    ], { Cookie: "__Host-augur_user=member@example.test.deadbeef" }));
    assert.equal(res.status, 204);
    assert.equal(c.lines.length, 2);
    assert.deepEqual(c.lines[0], { level: "warn", event: "client-report", tenant: tenantId, kind: "action-failed", action: "comment.add", status: 403, path: "/opp/x/", tab: "ab12cd34" });
    assert.equal(c.lines[1].msg, "boom for <address>");
    assert.equal(c.lines[1].src, "/__canvas/canvas.js");
    const all = JSON.stringify(c.lines);
    for (const bad of ["member@example.test", "ada@example.test", "deadbeef", "Cookie"]) assert.ok(!all.includes(bad), `leaked ${bad}`);
  } finally { c.restore(); }
});

test("unknown kinds, a cross-site post, an oversized body and a GET write nothing", async () => {
  const { fetch_ } = await deployment();
  const c = capture();
  try {
    assert.equal((await fetch_("/__report", reportPost([{ kind: "anything", msg: "x" }]))).status, 204);
    assert.equal((await fetch_("/__report", reportPost([{ kind: "js-error", msg: "x" }], { Origin: "https://evil.test" }))).status, 204);
    assert.equal((await fetch_("/__report", reportPost("x".repeat(5000)))).status, 413);
    assert.equal((await fetch_("/__report")).status, 405);
    assert.equal(c.lines.length, 0);
  } finally { c.restore(); }
});

test("at most ten reports per request", async () => {
  const { fetch_ } = await deployment();
  const c = capture();
  try {
    await fetch_("/__report", reportPost(Array.from({ length: 30 }, () => ({ kind: "rejection", msg: "r" }))));
    assert.equal(c.lines.length, 10);
  } finally { c.restore(); }
});

test("the reporter script is public, and the overlay and the chrome both load it", async () => {
  const fs = await import("node:fs");
  const W2 = await import("../src/_worker.js");
  const ctx = W2.__testables.applyDerivedRouting({});
  assert.equal(W2.__testables.isPublicPath(ctx, "/__review/reporter.js"), true, "a gated reporter would load the login page instead");
  const build = fs.readFileSync(new URL("../build.js", import.meta.url), "utf8");
  assert.match(build, /__review\/reporter\.js\?v=' \+ UI_VERSION/, "the build-time overlay block");
  assert.match(build, /CHROME_MARK_END\}\\n  <script src="\/__review\/reporter\.js/, "the app chrome");
  const worker = fs.readFileSync(new URL("../src/_worker.js", import.meta.url), "utf8");
  assert.match(worker, /\$\{REPORTER_SRC\}\?v=/, "the serve-time overlay");
});
