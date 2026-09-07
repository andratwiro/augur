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
import { personIdFor } from "../src/purge.mjs";
import { siteModel, isWelcomeUnit } from "../src/galleries.mjs";
import { makeEnv, ctxFor, cookieFor, ADA_MEMBER, VERA, manifestOf, remember, sha } from "./fixtures/unit-env.mjs";

// The member's page is keyed by the member id, not the local part of the address — see
// src/welcome-unit.mjs. Computed once here rather than hard-coded, so a change to the id
// format fails this file's own math instead of a stale literal.
const ADA_UNIT = `/start-here/${personIdFor(ADA_MEMBER.email)}/`;

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
 *
 * `pairing` defaults ON because `gated` now answers the same two questions the redirect on
 * `/` does, and the first of them is `welcomeFlow(tctx)`: with device pairing off there is
 * no `/__welcome` to be sent to, so nobody is gated however owed they are. The one test
 * below that turns it off is the one that pins exactly that.
 */
async function wired(users, { live, pairing = true, welcomeFlow = pairing } = {}) {
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
  const ctx = { ...ctxFor(tenantId, users), DEVICE_PAIRING: pairing, WELCOME_FLOW: welcomeFlow };
  return { env, ctx, object, tenantId };
}

/** What a redeemed invite does — the ONE thing that makes the welcome flow owed. */
const owe = (env, ctx, user) => W.noteInviteRedeemed(env, ctx, user.email);

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

// The same shape as `rejecting`, but the object ANSWERS — with a 500. That is the half a
// try/catch cannot reach, and the half a real Durable Object produces when a statement
// throws inside it.
function refusing(env, pathname) {
  const realGet = env.TENANTS.get;
  env.TENANTS.get = (n) => {
    const real = realGet(n);
    return {
      fetch: (input, init) => {
        const path = new URL(typeof input === "string" ? input : input.url).pathname;
        if (path === pathname) return Promise.resolve(new Response("boom", { status: 500 }));
        return real.fetch(input, init);
      },
    };
  };
}

test("an editor with a member row is NOT gated until a redeemed invite owes them the flow", async () => {
  // ⚠️ THE REGRESSION THIS FILE EXISTS TO PIN SINCE 9a. `gated` used to be "editor or
  // admin, and neither flag set", which is true of every member a workspace already had —
  // deployed onto a real roster it held the entire existing team at the door. A member
  // row is not a reason to be owed an onboarding flow; redeeming an invite is.
  const { env, ctx } = await wired([ADA_MEMBER, VERA]);
  const before = await me(env, ctx, ADA_MEMBER);
  assert.deepEqual([before.json.gated, before.json.paired, before.json.landed, before.json.backing],
    [false, false, false, "workspace-object"], "a pre-existing editor is never gated");

  await owe(env, ctx, ADA_MEMBER);
  assert.equal((await me(env, ctx, ADA_MEMBER)).json.gated, true, "owed by the redemption");
});

test("a viewer is never gated, owed or not", async () => {
  const { env, ctx } = await wired([ADA_MEMBER, VERA]);
  assert.equal((await me(env, ctx, VERA)).json.gated, false);
  // Even if something did stamp the column, the role decides first — the same rule the
  // whole flow follows, and the one global constraint it may never break.
  await W.noteInviteRedeemed(env, ctx, VERA.email);
  assert.equal((await me(env, ctx, VERA)).json.gated, false);
});

test("an owed editor is gated until done or later", async () => {
  const { env, ctx } = await wired([ADA_MEMBER, VERA]);
  await owe(env, ctx, ADA_MEMBER);
  assert.equal((await me(env, ctx, ADA_MEMBER)).json.gated, true);
  await me(env, ctx, ADA_MEMBER, { method: "POST", body: JSON.stringify({ later: true }) });
  assert.equal((await me(env, ctx, ADA_MEMBER)).json.gated, false);
});

test("with device pairing off nobody is gated, however owed — `gated` agrees with the redirect", async () => {
  // welcomeFlow(tctx) is the redirect's first question and now this route's too. With
  // pairing off there is no /__welcome standing in the slot, so a `gated: true` here was
  // the page telling a member about a door that does not exist.
  const { env, ctx } = await wired([ADA_MEMBER], { pairing: false });
  await owe(env, ctx, ADA_MEMBER);
  const a = await me(env, ctx, ADA_MEMBER);
  assert.equal(a.status, 200, "the member's own onboarding read is unconditional, pairing or not");
  assert.equal(a.json.gated, false);
});

// The park. Pairing on is the ordinary hosted state; the flow stands in its slot only where
// the instance also spells `welcomeFlow: true`, and nothing in the config does today.
test("with pairing on and the welcome flow unspoken — the default — nobody is gated, however owed", async () => {
  const { env, ctx } = await wired([ADA_MEMBER], { pairing: true, welcomeFlow: false });
  await owe(env, ctx, ADA_MEMBER);
  const a = await me(env, ctx, ADA_MEMBER);
  assert.equal(a.status, 200);
  assert.equal(a.json.gated, false, "an invited editor lands in the workspace, not on a parked flow");
  assert.equal(W.welcomeFlow({ DEVICE_PAIRING: true, FIRST_RUN: false }), false, "unspoken is off");
  assert.equal(W.welcomeFlow({ DEVICE_PAIRING: true, FIRST_RUN: false, WELCOME_FLOW: "true" }), false, "a string is a typo, not a yes");
  assert.equal(W.welcomeFlow({ DEVICE_PAIRING: true, FIRST_RUN: false, WELCOME_FLOW: true }), true);
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
  // The unit sub-route is a WRITE (it lands published content); a deployment with no
  // tenant object cannot record who owns that write, so it must refuse rather than
  // answer 200 while landing nothing — the same wording it already uses when BUNDLES
  // is missing.
  const u = await me(env, ctx, ADA_MEMBER, { method: "POST", url: "/__onboarding/me/unit" });
  assert.equal(u.status, 501);
  assert.equal(u.json.error, "units-not-configured");
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
  await owe(env, ctx, ADA_MEMBER);   // owed BEFORE the store breaks: the gate is what this asserts about
  rejecting(env, "/onboarding/welcome-set");
  const a = await me(env, ctx, ADA_MEMBER, { method: "POST", body: JSON.stringify({ later: true }) });
  assert.equal(a.status, 200);
  assert.equal(a.json.later, false);
  assert.equal(a.json.gated, true);
  assert.equal(a.json.saved, false, "the write is reported as the failure it was");
});

test("a welcome-set the object REFUSES answers 200 with later:false — a 500 is not a throw", async () => {
  // ⚠️ THE CASE THE `catch` CANNOT SEE. `stub.fetch` rejects only when the object is
  // unreachable; an object that answered 500 resolves, so an unchecked `await` calls a
  // failed write a success. The page navigates on the flag coming back true, so a `later`
  // still false here is what keeps somebody off `/` — where the gate would send them
  // straight back to this page, for ever.
  const { env, ctx } = await wired([ADA_MEMBER]);
  await owe(env, ctx, ADA_MEMBER);
  refusing(env, "/onboarding/welcome-set");
  const a = await me(env, ctx, ADA_MEMBER, { method: "POST", body: JSON.stringify({ later: true }) });
  assert.equal(a.status, 200, "a failed write is never a failed request");
  assert.equal(a.json.later, false);
  assert.equal(a.json.saved, false);
  assert.equal(a.json.gated, true, "and the gate is still up, because nothing was written");

  // The same route with the object answering normally: the flag comes back true, which is
  // the only answer the page leaves on — so the assertion above is not a blanket false.
  const { env: env2, ctx: ctx2 } = await wired([ADA_MEMBER]);
  await owe(env2, ctx2, ADA_MEMBER);
  const b = await me(env2, ctx2, ADA_MEMBER, { method: "POST", body: JSON.stringify({ later: true }) });
  assert.equal(b.json.later, true);
  assert.equal(b.json.saved, true);
  assert.equal(b.json.gated, false);
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
  assert.equal(first.json.unit, ADA_UNIT);
  assert.equal(first.json.url, `https://acme.example${ADA_UNIT}`);
  assert.equal(first.json.backing, "workspace-object");
  const live = await liveManifest(env);
  assert.ok(live.files[`${ADA_UNIT}index.html`]);
  assert.ok(live.files["/toolkit/a/index.html"], "the rest of the manifest is untouched");
  assert.equal(live.version, 4);
  assert.ok(live.routing.unitSources && live.routing.unitSources[ADA_UNIT], "stamped as platform-made");
  assert.equal(isSeedSource(live.routing.unitSources[ADA_UNIT]), true);
  // …and stamped as the WELCOME kind, which is what keeps one card per member off the
  // derived gallery (src/galleries.mjs `isWelcomeUnit`). It rides on the seed sentinel,
  // so the assertion above is unaffected by it.
  assert.equal(live.routing.unitSources[ADA_UNIT].kind, "welcome");
  assert.equal(isWelcomeUnit(live.routing.unitSources[ADA_UNIT]), true);
  assert.equal(siteModel({ manifest: live }).units.some((u) => u.unit === ADA_UNIT), false,
    "the page is served at its URL and listed on no derived page");
  assert.equal(live.publishedBy, SEED_ACTOR, "the platform landed it, never the person");
  assert.notEqual(live.files[`${ADA_UNIT}index.html`].by, W.personId(ADA_MEMBER.email));
  assert.ok(live.routing.publicPrefixes.includes(ADA_UNIT), "and it is served");
  const blob = await env.BUNDLES.get(`blobs/${live.files[`${ADA_UNIT}index.html`].h}`);
  assert.match(await blob.text(), /data-line="greeting"/, "the bytes were stored before the landing");

  const again = await me(env, ctx, ADA_MEMBER, { method: "POST", url: "/__onboarding/me/unit" });
  assert.equal(again.json.unit, ADA_UNIT);
  assert.equal((await liveManifest(env)).version, 4, "idempotent");

  // The start unit is the member's, so a plain GET reports it without landing anything.
  const g = await me(env, ctx, ADA_MEMBER);
  assert.equal(g.json.unit, ADA_UNIT);

  // Landing the platform's own page is never a person's publish: the first-publish signal
  // stays unflipped until a real one happens.
  const status = await (await W.onboardingStatusApi(ctx, new Request("https://acme.example/__onboarding/status"), env, ADA_MEMBER)).json();
  assert.equal(status.connected, false, "the platform landing never flips the first-publish signal");
});

test("the unit object adopts the platform's landing on the next open", async () => {
  const { env, ctx } = await wired([ADA_MEMBER], { live: manifestOf(3, {}) });
  await me(env, ctx, ADA_MEMBER, { method: "POST", url: "/__onboarding/me/unit" });
  const o = await openUnit(env, ctx, ADA_UNIT);
  assert.equal(o.status, 200, JSON.stringify(o.body));
  assert.ok(o.body.table[`${ADA_UNIT}index.html`], "sync-main adopted the landing");
});

// ── the member's own landing must not erase the welcome stamp (Task 9c) ────────────────
//
// The welcome flow REQUIRES the member to land on their page (step 3) — so if `land`
// stripped `kind: "welcome"` off `routing.unitSources[unit]`, every member's page would
// reappear on the derived gallery the moment they finished the flow that was supposed to
// keep it off. `writeUnitLanding`'s default stamp now carries the prior entry's `kind`
// forward when the caller passes no `unitSource` of its own — exactly the ordinary `land`
// path, unlike the platform's own write to `/__onboarding/me/unit`, which always hands one.
const unitCall = (env, ctx, verb, body) => W.unitApi(ctx, new Request(`https://acme.example/__unit/${verb}`, {
  method: "POST",
  headers: { Authorization: "Bearer tok", "content-type": "application/json", "X-Augur-Session": "welcome" },
  body: JSON.stringify(body),
}), new URL(`https://acme.example/__unit/${verb}`), env).then(async (r) => ({ status: r.status, body: await r.json() }));

test("the member's own landing on step 3 keeps the page off the gallery, and `land` carries the stamp for any ordinary unit", async () => {
  const { env, ctx } = await wired([ADA_MEMBER], { live: manifestOf(3, {}) });
  const made = await me(env, ctx, ADA_MEMBER, { method: "POST", url: "/__onboarding/me/unit" });
  assert.equal(made.status, 200, JSON.stringify(made.json));

  // Step 3: the member opens their own page, changes something, and lands it — the same
  // three calls `augur open`/`save`/`land` make for any prototype.
  const o = await unitCall(env, ctx, "open", { unit: ADA_UNIT });
  assert.equal(o.status, 200, JSON.stringify(o.body));
  const baseHash = o.body.table[`${ADA_UNIT}index.html`].h;
  const newBody = "<h1>my page, edited</h1>";
  await env.BUNDLES.put(`blobs/${sha(newBody)}`, newBody);
  const s = await unitCall(env, ctx, "save", {
    unit: ADA_UNIT, draftId: o.body.draftId, draftRevision: 0,
    changes: [{ path: `${ADA_UNIT}index.html`, h: sha(newBody), ct: "text/html; charset=utf-8", s: newBody.length, baseHash }],
  });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const l = await unitCall(env, ctx, "land", { unit: ADA_UNIT, draftId: o.body.draftId, baseRevision: o.body.baseRevision, note: "my edit" });
  assert.equal(l.status, 200, JSON.stringify(l.body));

  const live = await liveManifest(env);
  assert.equal(live.files[`${ADA_UNIT}index.html`].h, sha(newBody), "the member's edit really landed");
  assert.equal(live.routing.unitSources[ADA_UNIT].kind, "welcome", "the stamp survives the member's own landing");
  assert.equal(isWelcomeUnit(live.routing.unitSources[ADA_UNIT]), true);
  assert.equal(siteModel({ manifest: live }).units.some((u) => u.unit === ADA_UNIT), false,
    "still off every derived page after the member finished the flow");

  // An ORDINARY unit, with no prior `kind` at all, is unaffected: `land` still stamps the
  // plain shape it always has, with no `kind` field invented for it.
  const U = "/checkout/flow/";
  const { env: env2, ctx: ctx2 } = await wired([ADA_MEMBER], { live: manifestOf(5, { [U]: { "index.html": remember("<h1>flow</h1>") } }) });
  const o2 = await unitCall(env2, ctx2, "open", { unit: U });
  const body2 = "<h1>flow v2</h1>";
  await env2.BUNDLES.put(`blobs/${sha(body2)}`, body2);
  await unitCall(env2, ctx2, "save", {
    unit: U, draftId: o2.body.draftId, draftRevision: 0,
    changes: [{ path: `${U}index.html`, h: sha(body2), ct: "text/html; charset=utf-8", s: body2.length, baseHash: o2.body.table[`${U}index.html`].h }],
  });
  const l2 = await unitCall(env2, ctx2, "land", { unit: U, draftId: o2.body.draftId, baseRevision: o2.body.baseRevision, note: "v2" });
  assert.equal(l2.status, 200, JSON.stringify(l2.body));
  const live2 = await liveManifest(env2);
  assert.equal("kind" in live2.routing.unitSources[U], false, "no kind field appears out of nowhere");
});

test("a viewer is never handed a page to make", async () => {
  const { env, ctx } = await wired([ADA_MEMBER, VERA], { live: manifestOf(3, {}) });
  const r = await me(env, ctx, VERA, { method: "POST", url: "/__onboarding/me/unit" });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, "viewer-role");
  assert.equal((await liveManifest(env)).version, 3, "nothing was landed");
});
