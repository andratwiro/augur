// `/__welcome` — the five-step onboarding flow, and the gate that sends a member to it.
//
// Two halves, and they fail in opposite directions on purpose. The PAGE is a
// self-contained document served to a signed-in editor or admin; a viewer is never shown
// it, because a viewer publishes nothing and has nothing to connect. The GATE is one
// redirect on `/`, and its only job is to be liftable: "do this later" writes a flag and
// the redirect stops, forever, for that person. Everything here drives the real worker
// through `worker.fetch` with a real session cookie and a real `TenantStore` behind
// `env.TENANTS` — the same shape test/first-publish-signal.test.mjs and
// test/onboarding-me.test.mjs use — because a gate asserted about in pieces is a gate
// whose placement in the router is untested, and its placement is the whole risk.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import worker, { __testables as W } from "../src/_worker.js";
import { TenantStore } from "../src/tenant-do.js";
import { memKV, cookieFor, ADA_MEMBER, VERA } from "./fixtures/unit-env.mjs";

const ORIGIN = "https://acme.example";
let SEQ = 0;

// A DO storage stub with REAL transaction semantics — copied from
// test/onboarding-me.test.mjs, which copied it from test/first-publish-signal.test.mjs.
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

// TWO per-isolate caches have to be cleared between fixtures — the tenant memo and the
// config cache — or every fixture after the first answers as the first one. See the same
// note in test/device-pairing.test.mjs, which learned it the hard way.
function freshIsolate() {
  W.__setTenantTestState({ memo: null });
  W.__setConfigTestState({ cfgAt: 0, cfgGoodAt: 0, roster: null, manifests: null, storage: null, suspension: null });
}

/**
 * A provisioned workspace object behind `env.TENANTS`, rostered with `users`, and an
 * instance config naming the same people — everything the gate and the page touch.
 */
async function wired(users) {
  freshIsolate();
  const tenantId = `welcome-${++SEQ}`;
  const db = new DatabaseSync(":memory:");
  const object = new TenantStore({ storage: storage(db), blockConcurrencyWhile: async (f) => f() }, {});
  await object.provision({ workspaceId: tenantId, adminEmail: users[0].email, adminName: users[0].name || "" });
  await object.fetch(new Request("https://workspace/identity/roster/write", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspaceId: tenantId,
      configUsers: users.map((u) => ({ email: u.email, role: u.role, name: u.name })),
    }),
  }));
  const env = {
    SESSION_SECRET: "welcome-page-fixed-secret",
    COMMENTS: memKV(),
    ASSETS: {
      fetch: async (req) => {
        const p = new URL(typeof req === "string" ? req : req.url).pathname;
        if (p === "/__config/instance.json") {
          return new Response(JSON.stringify({ users, tenantId }), { headers: { "content-type": "application/json" } });
        }
        if (p === "/__config/routing.json") {
          return new Response(JSON.stringify({ spaces: [{ id: "acme", default: true }], publicPrefixes: [] }), { headers: { "content-type": "application/json" } });
        }
        return new Response("Not Found", { status: 404 });
      },
    },
    TENANTS: {
      idFromName: (n) => n,
      get: () => ({ fetch: (input, init) => object.fetch(new Request(input, init)) }),
    },
  };
  return { env, object, tenantId };
}

async function fetchAs(env, user, path, init = {}) {
  freshIsolate();
  const headers = { ...(init.headers || {}) };
  if (user) headers.Cookie = await cookieFor(env, user);
  const orig = console.log; console.log = () => {};
  try {
    return await worker.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }), env, { waitUntil() {} });
  } finally { console.log = orig; }
}

test("/ sends a gated editor to /__welcome and leaves a viewer alone", async () => {
  const { env } = await wired([ADA_MEMBER, VERA]);
  const r = await fetchAs(env, ADA_MEMBER, "/");
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/__welcome");
  const v = await fetchAs(env, VERA, "/");
  assert.notEqual(v.status, 303, "a viewer is never gated");
  const later = await fetchAs(env, ADA_MEMBER, "/__onboarding/me", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ later: true }),
  });
  assert.equal(later.status, 200);
  assert.notEqual((await fetchAs(env, ADA_MEMBER, "/")).status, 303, "later lifts the gate");
});

test("/__welcome is one self-contained page with the five steps and the command", async () => {
  const { env } = await wired([ADA_MEMBER]);
  const r = await fetchAs(env, ADA_MEMBER, "/__welcome");
  assert.equal(r.status, 200);
  const html = await r.text();
  for (const s of ['data-step="agent"', 'data-step="install"', 'data-step="connect"', 'data-step="change"', 'data-step="done"']) {
    assert.ok(html.includes(s), s);
  }
  assert.match(html, /npx @augurworks\/augur connect --origin https:\/\/acme\.example/);
  assert.match(html, /\/__onboarding\/me/);
  assert.match(html, /\/__onboarding\/installer\/mac/);
  assert.doesNotMatch(html, /<script src=|<link rel="stylesheet"/, "no external request leaves this page");
  assert.match(html, /do this later/i);
});

test("a viewer asking for /__welcome is sent to /", async () => {
  const { env } = await wired([VERA]);
  const r = await fetchAs(env, VERA, "/__welcome");
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/");
});
