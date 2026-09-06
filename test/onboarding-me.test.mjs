// /__onboarding/me — the member's own gate, and the pairing stamp that feeds it.
//
// `notePairing` writes `members.paired_at` on the workspace object when a device pairing
// is approved (see pairApi's approve branch); `onboardingMeApi` reads it back, plus the
// welcome flags, for the welcome flow the seeded start-here page polls. Driven directly
// against the exported functions, the way test/unit-api.test.mjs drives worker functions
// with an explicit `me` — no cookie parsing or session gate sits in front of either one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { __testables as W } from "../src/_worker.js";
import { TenantStore } from "../src/tenant-do.js";
import { makeEnv, ctxFor, cookieFor, ADA_MEMBER, VERA, manifestOf, remember } from "./fixtures/unit-env.mjs";

// A DO storage stub with REAL transaction semantics — copied from
// test/first-publish-signal.test.mjs so this file drives the same real TenantStore.
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

let SEQ = 0;

/**
 * A workspace object provisioned and rostered with `users`, wired behind `env.TENANTS`,
 * plus the worker `tctx` that names it — everything `notePairing`/`onboardingMeApi` touch,
 * with none of the HTTP/host-resolution plumbing this task's tests never exercise.
 */
async function wired(users, { live } = {}) {
  const tenantId = `onboarding-me-${++SEQ}`;
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
  const env = await makeEnv({ live: live || manifestOf(1, {}) });
  env.TENANTS = {
    idFromName: (n) => n,
    get: (n) => ({ fetch: (input, init) => object.fetch(new Request(input, init)) }),
  };
  const ctx = ctxFor(tenantId, users);
  return { env, ctx, object, tenantId };
}

const me = async (env, ctx, user, init = {}) => {
  const req = new Request("https://acme.example/__onboarding/me", {
    ...init,
    headers: { cookie: await cookieFor(env, user), "content-type": "application/json", ...(init.headers || {}) },
  });
  const res = await W.onboardingMeApi(ctx, req, new URL(req.url), env, user);
  return { status: res.status, json: await res.json() };
};

test("a viewer is never gated; an editor is gated until done or later", async () => {
  const { env, ctx } = await wired([ADA_MEMBER, VERA]);
  assert.equal((await me(env, ctx, VERA)).json.gated, false);
  const a = await me(env, ctx, ADA_MEMBER);
  assert.deepEqual([a.json.gated, a.json.paired, a.json.landed, a.json.backing], [true, false, false, "workspace-object"]);
  await me(env, ctx, ADA_MEMBER, { method: "POST", body: JSON.stringify({ later: true }) });
  assert.equal((await me(env, ctx, ADA_MEMBER)).json.gated, false);
});

test("approving a pairing stamps the member, and the status flips", async () => {
  const { env, ctx } = await wired([ADA_MEMBER]);
  await W.notePairing(env, ctx, ADA_MEMBER.email);
  const a = await me(env, ctx, ADA_MEMBER);
  assert.equal(a.json.paired, true);
  assert.ok(a.json.pairedAt);
});

test("no tenant object: backing none, never gated", async () => {
  const env = await makeEnv({ live: manifestOf(1, {}) });
  const ctx = ctxFor("t-none", [ADA_MEMBER]);
  const a = await me(env, ctx, ADA_MEMBER);
  assert.deepEqual([a.json.backing, a.json.gated], ["none", false]);
});
