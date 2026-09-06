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
import { SEED_ACTOR, isSeedSource } from "../src/provenance.mjs";
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
  const { url = "/__onboarding/me", ...rest } = init;
  const req = new Request(`https://acme.example${url}`, {
    ...rest,
    headers: { cookie: await cookieFor(env, user), "content-type": "application/json", ...(rest.headers || {}) },
  });
  const res = await W.onboardingMeApi(ctx, req, new URL(req.url), env, user);
  return { status: res.status, json: await res.json() };
};

// Wrap a wired TENANTS namespace so its stub's `fetch` rejects for exactly `pathname`
// and delegates every other path to the real object — the shape both containment
// tests below share.
function rejecting(env, pathname) {
  const realGet = env.TENANTS.get;
  env.TENANTS.get = (n) => {
    const real = realGet(n);
    return {
      fetch: (input, init) => {
        const path = new URL(typeof input === "string" ? input : input.url).pathname;
        if (path === pathname) return Promise.reject(new Error(`workspace object unreachable for ${pathname}`));
        return real.fetch(input, init);
      },
    };
  };
}

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

test("a workspace-object failure on the pairing stamp never fails the approval", async () => {
  const { env, ctx } = await wired([ADA_MEMBER]);
  rejecting(env, "/onboarding/note-pair");
  await assert.doesNotReject(async () => {
    assert.equal(await W.notePairing(env, ctx, ADA_MEMBER.email), null);
  });
  const a = await me(env, ctx, ADA_MEMBER);
  assert.equal(a.status, 200);
  assert.equal(a.json.paired, false);
});

test("a workspace-object failure on the welcome-set write never fails the request", async () => {
  const { env, ctx } = await wired([ADA_MEMBER]);
  rejecting(env, "/onboarding/welcome-set");
  const a = await me(env, ctx, ADA_MEMBER, { method: "POST", body: JSON.stringify({ later: true }) });
  assert.equal(a.status, 200);
  assert.equal(a.json.later, false);
  assert.equal(a.json.gated, true);
});

// ── The member's own page, landed by the platform ────────────────────────────────────
//
// `POST /__onboarding/me/unit` is the one write in the welcome flow that touches published
// content. It has to land like any other landing (merge-safe, one version, the prefix
// served) while reading as the PLATFORM's work, so the workspace's first-publish signal
// still waits for something a person made.
const openUnit = async (env, ctx, unit) => {
  const u = "https://acme.example/__unit/open";
  const res = await W.unitApi(ctx, new Request(u, {
    method: "POST",
    headers: { Authorization: "Bearer tok", "content-type": "application/json", "X-Augur-Session": "welcome" },
    body: JSON.stringify({ unit }),
  }), new URL(u), env);
  return { status: res.status, body: await res.json() };
};
const liveManifest = async (env) => JSON.parse(await (await env.BUNDLES.get("spaces/alpha/manifest.json")).text());

test("POST /__onboarding/me/unit lands the member's page once, as seed-sourced, and reports it", async () => {
  const { env, ctx } = await wired([ADA_MEMBER], { live: manifestOf(3, { "/toolkit/a/": { "index.html": remember("<h1>a</h1>") } }) });
  const first = await me(env, ctx, ADA_MEMBER, { method: "POST", url: "/__onboarding/me/unit" });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.unit, "/start-here/ada/");
  assert.equal(first.json.url, "https://acme.example/start-here/ada/");
  assert.equal(first.json.backing, "workspace-object");
  const live = await liveManifest(env);
  assert.ok(live.files["/start-here/ada/index.html"]);
  assert.ok(live.files["/toolkit/a/index.html"], "the rest of the manifest is untouched");
  assert.equal(live.version, 4);
  assert.ok(live.routing.unitSources && live.routing.unitSources["/start-here/ada/"], "stamped as platform-made");
  assert.equal(isSeedSource(live.routing.unitSources["/start-here/ada/"]), true);
  assert.equal(live.publishedBy, SEED_ACTOR, "the platform landed it, never the person");
  assert.notEqual(live.files["/start-here/ada/index.html"].by, W.personId(ADA_MEMBER.email));
  assert.ok(live.routing.publicPrefixes.includes("/start-here/ada/"), "and it is served");
  const blob = await env.BUNDLES.get(`blobs/${live.files["/start-here/ada/index.html"].h}`);
  assert.match(await blob.text(), /data-line="greeting"/, "the bytes were stored before the landing");

  const again = await me(env, ctx, ADA_MEMBER, { method: "POST", url: "/__onboarding/me/unit" });
  assert.equal(again.json.unit, "/start-here/ada/");
  assert.equal((await liveManifest(env)).version, 4, "idempotent");

  // The start unit is the member's, so a plain GET reports it without landing anything.
  const g = await me(env, ctx, ADA_MEMBER);
  assert.equal(g.json.unit, "/start-here/ada/");
});

test("the unit object adopts the platform's landing on the next open", async () => {
  const { env, ctx } = await wired([ADA_MEMBER], { live: manifestOf(3, {}) });
  await me(env, ctx, ADA_MEMBER, { method: "POST", url: "/__onboarding/me/unit" });
  const o = await openUnit(env, ctx, "/start-here/ada/");
  assert.equal(o.status, 200, JSON.stringify(o.body));
  assert.ok(o.body.table["/start-here/ada/index.html"], "sync-main adopted the landing");
});

test("a viewer is never handed a page to make", async () => {
  const { env, ctx } = await wired([ADA_MEMBER, VERA], { live: manifestOf(3, {}) });
  const r = await me(env, ctx, VERA, { method: "POST", url: "/__onboarding/me/unit" });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, "viewer-role");
  assert.equal((await liveManifest(env)).version, 3, "nothing was landed");
});
