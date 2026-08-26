// A workspace paused for dormancy comes back when an admin signs in. Nothing else does.
//
// `E-dormancy-resume`. The hosted lifecycle page tells customers "Sign in. That is the whole
// procedure: a workspace suspended for dormancy reactivates on the first successful sign-in
// by an admin." Until this shipped that sentence was prose — the flag was set by an operator
// verb and cleared by an operator verb, and no sign-in went anywhere near it.
//
// ── ⚠️ THE WHOLE FEATURE IS THE DISCRIMINATOR, NOT THE RESUME ───────────────────────────
//
// The same flag pauses a workspace for dormancy, for an acceptable-use takedown, and as part
// of tombstoning a deleted one. A resume that fired on the wrong one would un-take-down a
// phishing page on the strength of its own owner signing in — the one failure in this item
// that reaches people who are not customers. So the tests that matter here are the ones
// where NOTHING HAPPENS: the acceptable-use case, the tombstone, and the reason nobody has
// heard of yet.
//
// That last one is why `DORMANCY_SUSPENSION_REASONS` is an ALLOWLIST. A denylist ("resume
// unless it is `deleted`") would silently start resuming every suspension kind invented
// after it, on the day that kind shipped. The allowlist makes a new reason INERT, and
// `the allowlist is exactly one word` below is what makes growing it a visible act.
//
// ── WHAT IS PROVEN HERE AND WHAT IS NOT ────────────────────────────────────────────────
//
// Two layers, and both are driven rather than described:
//
//   · THE OBJECT (`node:sqlite` behind a storage stub with real transaction semantics, the
//     same harness test/tenant-verbs.test.mjs uses) decides the reason. Every row of the
//     matrix is a real suspend → sign-in → read-back.
//   · THE WORKER drives the real `POST /__auth` through `worker.fetch` — real roster, real
//     PBKDF2, real session cookie — against a real workspace object behind the TENANTS
//     binding. So "an admin signs in" means an admin actually signs in, and "gets the
//     password wrong" means the credential check actually rejects them.
//
// NOT proven here: the Durable Object RUNTIME. `node:sqlite` is not workerd and a storage
// stub is not storage — so the item's VERIFY was also run on a REHEARSAL DEPLOYMENT, and
// what follows is what that did rather than an assurance that it passed. `wrangler dev
// --local` on a config binding `TENANTS` to `TenantStore` (`new_sqlite_classes`), the deploy
// entry as `main`, `dist` as the asset directory with `run_worker_first`, a roster carrying
// real PBKDF2 hashes, `TENANT_HOST_SUFFIX` set, and one extra route holding the namespace
// binding to stand in for the control plane. Seven workspaces, one object each, provisioned
// and suspended over that route and then signed in to over HTTP, a Host header apiece:
//
//   dormant   + admin, right password   503 → 303 → 200. `resumedFrom` the dormancy word,
//                                       `resumedBy` the person id, and the front door had
//                                       stopped serving the holding page by the very next
//                                       request — the cache drop, in a real isolate.
//   dormant   + an editor, then a viewer  both signed in (303); both still 503
//   dormant   + admin, wrong password   401; still 503, nothing recorded
//   acceptable use + admin, right pw    signed in (303); STILL 503, reason intact
//   deleted   + admin, right password   signed in (303); still 503, still deleted
//   unlisted reason + admin, right pw   signed in (303); still 503
//
// Repeat it by binding this class in any wrangler.toml. What that still leaves unproven is
// a deployment on a real account, which is a rehearsal nothing here can stand in for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { TenantStore, DORMANCY_SUSPENSION_REASONS, CONTROL_VERBS } from "../src/tenant-do.js";
import { default as worker, __testables as W } from "../src/_worker.js";

const DORMANT = DORMANCY_SUSPENSION_REASONS[0];

// ── the workspace object ────────────────────────────────────────────────────────────────

/** A DO storage stub with REAL transaction semantics, so a rollback is tested and not mimed. */
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

const ADMIN = "ada@example.test";
const EDITOR = "ed@example.test";
const VIEWER = "vi@example.test";

/** A provisioned workspace, optionally already paused for `reason`. */
async function paused(reason, { at = "2026-01-01T00:00:00.000Z" } = {}) {
  const db = new DatabaseSync(":memory:");
  const ctx = { storage: storage(db), blockConcurrencyWhile: async (f) => f() };
  const store = new TenantStore(ctx, {});
  await store.provision({ workspaceId: "acme", adminEmail: ADMIN });
  if (reason != null) assert.equal(store.suspend(reason, at).changed, true);
  return store;
}

const isPaused = (store) => store.status().suspended;

// ── the six cases the item's VERIFY names ───────────────────────────────────────────────

test("1. DORMANT + an admin signs in → it comes back, and the resume is recorded", async () => {
  const store = await paused(DORMANT, { at: "2026-01-01T00:00:00.000Z" });
  assert.equal(isPaused(store), true, "the fixture was not actually paused");
  const out = store.resumeOnSignIn({ role: "admin", by: "abc123" }, "2026-01-01T02:00:00.000Z");

  assert.equal(out.resumed, true);
  assert.equal(out.reason, DORMANT);
  assert.equal(out.suspendedMs, 2 * 60 * 60 * 1000, "how long it was dark is the number somebody planned around");

  const s = store.status();
  assert.equal(s.suspended, false, "the workspace is still paused after its admin signed in");
  assert.equal(s.suspendedReason, null);
  assert.equal(s.suspendedAt, null);
  // THE RECORD. resume() clears the reason and the date, so without these three nothing
  // afterwards can say the workspace was ever paused or who lifted it.
  assert.equal(s.resumedAt, "2026-01-01T02:00:00.000Z");
  assert.equal(s.resumedFrom, DORMANT);
  assert.equal(s.resumedBy, "abc123");
});

test("2. DORMANT + an editor, and DORMANT + a viewer → it stays paused", async () => {
  // Signing in is activity, which touchActivity already records. It is not a decision to
  // put the public site back on the air, and the page says "by an admin".
  for (const role of ["editor", "viewer"]) {
    const store = await paused(DORMANT);
    const out = store.resumeOnSignIn({ role, by: "who" });
    assert.equal(out.resumed, false, role);
    assert.equal(out.why, "not-an-admin", role);
    assert.equal(isPaused(store), true, `a ${role} un-paused a workspace`);
    assert.equal(store.status().resumedAt, null, `a ${role} left a resume record`);
  }
  // And nothing else either — a role nobody defined is not an admin.
  for (const role of ["", null, undefined, "owner", "ADMIN", "admin ", "administrator", "*"]) {
    const store = await paused(DORMANT);
    assert.equal(store.resumeOnSignIn({ role }).resumed, false, JSON.stringify(role));
    assert.equal(isPaused(store), true, JSON.stringify(role));
  }
});

test("4. ⚠️ ACCEPTABLE USE + an admin signs in successfully → IT STAYS PAUSED", async () => {
  // The test that matters. An admin proving they are the admin is not an appeal, and a
  // takedown that its own subject can lift is not a takedown.
  for (const reason of [
    "aup: phishing page",
    "acceptable-use",
    "abuse",
    "aup",
    "malware",
  ]) {
    const store = await paused(reason);
    const out = store.resumeOnSignIn({ role: "admin", by: "abc123" });
    assert.equal(out.resumed, false, reason);
    assert.equal(out.why, "reason-not-in-allowlist", reason);
    assert.equal(out.reason, reason);
    assert.equal(isPaused(store), true, `an admin lifted a takedown reading "${reason}"`);
    assert.equal(store.status().suspendedReason, reason, reason);
    assert.equal(store.status().resumedAt, null, reason);
  }
});

test("5. DELETED + an admin signs in successfully → it stays paused, and stays deleted", async () => {
  // A tombstone is not a pause. deleteWorkspace() suspends with the reason `deleted`, so
  // this is refused twice over — by the tombstone check and by the allowlist.
  const store = await paused(null);
  assert.equal(store.deleteWorkspace("2026-01-01T00:00:00.000Z").changed, true);
  const out = store.resumeOnSignIn({ role: "admin", by: "abc123" });
  assert.equal(out.resumed, false);
  assert.equal(out.why, "deleted");
  const s = store.status();
  assert.equal(s.suspended, true, "an admin signing in undeleted a tombstoned workspace");
  assert.equal(s.deleted, true);
  assert.equal(s.suspendedReason, "deleted");
  assert.equal(s.resumedAt, null);
  // Deleted, then re-labelled with the dormancy word by hand: STILL refused, because the
  // tombstone is read from `deleted_at` and not from the reason column.
  store.writeMeta("suspended_reason", DORMANT);
  assert.equal(store.resumeOnSignIn({ role: "admin" }).why, "deleted");
  assert.equal(isPaused(store), true);
});

test("6. A REASON THAT IS IN NO ALLOWLIST → inert, not open. A future reason cannot resume", async () => {
  // The failure mode of a suspension kind invented next year. A denylist would resume on
  // every one of these the day it shipped; the allowlist means somebody has to come and
  // add it on purpose.
  for (const reason of [
    "non-payment",                 // the paid-plan case the lifecycle page already describes
    "chargeback",
    "legal-hold",
    "operator-request",
    "",                            // suspend() with no reason at all
    "dormancy",                    // near miss: the noun, not the word the allowlist holds
    `${DORMANT} `,                 // near miss: a trailing space
    ` ${DORMANT}`,
    DORMANT.toUpperCase(),         // near miss: case
    `${DORMANT}-account-abuse`,    // near miss: a PREFIX match would have let this through
    `aup: ${DORMANT}-looking site`, // near miss: a SUBSTRING match would have let this through
  ]) {
    const store = await paused(reason);
    const out = store.resumeOnSignIn({ role: "admin", by: "abc123" });
    assert.equal(out.resumed, false, JSON.stringify(reason));
    assert.equal(out.why, "reason-not-in-allowlist", JSON.stringify(reason));
    assert.equal(isPaused(store), true, `"${reason}" resumed on an admin sign-in`);
    assert.equal(store.status().resumedAt, null, JSON.stringify(reason));
  }
});

test("the allowlist is exactly one word, and this test is what makes growing it deliberate", () => {
  assert.deepEqual([...DORMANCY_SUSPENSION_REASONS], ["dormant"]);
  assert.equal(Object.isFrozen(DORMANCY_SUSPENSION_REASONS), true);
  // ⚠️ It is NOT a control verb. CONTROL_VERBS is what an OPERATOR may be granted over a
  // workspace; resuming on a sign-in is the request path asking the workspace about itself,
  // and nobody should be able to be granted it.
  assert.equal(CONTROL_VERBS.includes("resume-on-sign-in"), false);
});

test("⚠️ /__auth IS THE ONLY SIGN-IN A PAUSED WORKSPACE CAN REACH — the resume is complete", () => {
  // THE COMPLETENESS QUESTION, and the trap it is here to spring. This engine mints a
  // session in exactly TWO places — `/__auth` and `/__invite` (accepting an invite sets a
  // password and signs you straight in) — and the resume is wired into only the first. That
  // is correct TODAY and only because of this list: the suspension gate runs before the
  // router, and `/__invite` is not on it, so on a paused workspace an invite acceptance
  // never reaches its session mint at all. There is no second success branch to wire.
  //
  // It stops being correct the moment somebody adds a sign-in path to SUSPENDED_ALLOWED,
  // and NOTHING ELSE WOULD SAY SO — the new path would sign an admin in and quietly not
  // resume. So this pins the list from the resume's side: if it fails, do not just widen
  // the array, decide whether the new path also has to call resumeAfterDormancy.
  assert.deepEqual([...W.SUSPENDED_ALLOWED], [
    "/__auth",                    // the sign-in. THE ONE the resume rides.
    "/__logout",                  // mints nothing
    "/__publish/_login/token",    // runs the same credential check and mints a PUBLISH
                                  // token, not a session. Deliberately no resume: a token
                                  // login is not "a sign-in by an admin", it carries no
                                  // role, and a backup script must not un-pause anything.
    "/__publish/_state/export",   // mints nothing; the "if you came back to leave" promise
  ]);
});

// ── the rest of the object's own refusals ───────────────────────────────────────────────

test("a workspace that is not paused at all is left alone, and no record is invented", async () => {
  const store = await paused(null);
  const out = store.resumeOnSignIn({ role: "admin", by: "abc123" });
  assert.equal(out.resumed, false);
  assert.equal(out.why, "not-suspended");
  assert.equal(store.status().resumedAt, null, "a resume was recorded for a pause that never happened");
});

test("A SIGN-IN AGAINST A NAME NOBODY PROVISIONED CREATES NOTHING", async () => {
  // Same property every control verb has, and for the same reason: the workspace id comes
  // from a hostname somebody typed, and a typo that provisioned would leave a workspace
  // nobody knows exists.
  const db = new DatabaseSync(":memory:");
  const store = new TenantStore({ storage: storage(db), blockConcurrencyWhile: async (f) => f() }, {});
  const res = await store.fetch(new Request("https://tenant.invalid/resume-on-sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: "typo", role: "admin" }),
  }));
  assert.deepEqual(await res.json(), { resumed: false, why: "not-provisioned" });
  assert.deepEqual(
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all(),
    [], "a sign-in against an unprovisioned name built a workspace",
  );
});

test("A REFUSAL IS A 200 — this rides a sign-in, and a sign-in must not fail over it", async () => {
  // The opposite of controlResult's rule, and deliberately: an operator verb's verdict is
  // read off the status line into an audit log; this one is dropped by its caller.
  const store = await paused("aup: phishing page");
  const res = await store.fetch(new Request("https://tenant.invalid/resume-on-sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role: "admin", by: "abc123" }),
  }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).resumed, false);
  assert.equal(isPaused(store), true);
});

test("an empty or unparseable body refuses rather than defaulting to admin", async () => {
  for (const body of [undefined, "", "{", "null", "[]", JSON.stringify({})]) {
    const store = await paused(DORMANT);
    const res = await store.fetch(new Request("https://tenant.invalid/resume-on-sign-in", {
      method: "POST", headers: { "content-type": "application/json" }, body,
    }));
    assert.equal((await res.json()).why, "not-an-admin", JSON.stringify(body));
    assert.equal(isPaused(store), true, JSON.stringify(body));
  }
});

test("a second dormancy round trip overwrites the record — a snapshot, not a log", async () => {
  const store = await paused(DORMANT, { at: "2026-01-01T00:00:00.000Z" });
  store.resumeOnSignIn({ role: "admin", by: "first" }, "2026-01-01T01:00:00.000Z");
  assert.equal(store.status().resumedBy, "first");
  store.suspend(DORMANT, "2026-06-01T00:00:00.000Z");
  store.resumeOnSignIn({ role: "admin", by: "second" }, "2026-06-02T00:00:00.000Z");
  const s = store.status();
  assert.equal(s.resumedBy, "second");
  assert.equal(s.resumedAt, "2026-06-02T00:00:00.000Z");
  assert.equal(s.suspended, false);
});

// ── through the real front door ─────────────────────────────────────────────────────────
//
// Everything above drives the object directly. This drives `POST /__auth` on the real
// worker, with a real roster, real PBKDF2 and a real workspace object behind the TENANTS
// binding — so "an admin signs in" and "gets the password wrong" are the actual credential
// check answering, not a flag a test set.

const ORIGIN = "https://example.test";
const PASSWORD = "a properly long password";
const PASS_HASH = await W.hashPassword(PASSWORD);

const ROSTER = [
  { email: ADMIN, name: "Ada", initials: "A", role: "admin", passHash: PASS_HASH },
  { email: EDITOR, name: "Ed", initials: "E", role: "editor", passHash: PASS_HASH },
  { email: VIEWER, name: "Vi", initials: "V", role: "viewer", passHash: PASS_HASH },
];

const CONFIG = {
  "/__config/instance.json": JSON.stringify({
    users: ROSTER, engineVersion: "1.0.0-dormancy", updateFeed: "",
    mcpHostSuffixes: [], mcpHostAllowlistUrl: "", vanityRedirects: {}, rtOrigin: "", sentinels: [],
  }),
  "/__config/routing.json": JSON.stringify({
    buildId: "dormancy-build", versionMap: {}, publicPrefixes: [], publicSkillPrefixes: [],
    restrictedBases: [], canvasLoaderExtras: "", canvasCatalog: [], canvasTracks: [], mcpAllowlist: [],
    spaces: [{ id: "one", name: "One", badge: "O", default: true, base: "", adminOnly: false }],
    defaultSpace: "one",
  }),
};

function memKV() {
  const store = new Map();
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
  };
}

/**
 * One deployment: the real worker, one real workspace object, one workspace id.
 *
 * A FRESH ID PER CASE, because the worker's suspension answer is cached per workspace for
 * SUSPENSION_TTL_MS. Two cases sharing an id would read each other's cached flag, and the
 * second would pass or fail on the first one's fixture.
 */
let seq = 0;
async function deployment(reason, { at = "2026-01-01T00:00:00.000Z" } = {}) {
  const tenantId = `wired-${++seq}`;
  const store = await paused(reason, { at });
  const pending = [];
  const env = {
    COMMENTS: memKV(),
    SESSION_SECRET: "dormancy-fixed-session-secret",
    TENANTS: {
      idFromName: (n) => n,
      // One object, and it answers only for its own name — a call for anybody else would
      // be a bug this fixture should not paper over.
      get: (n) => {
        assert.equal(n, tenantId, "the worker reached for another workspace's object");
        return { fetch: (input, init) => store.fetch(new Request(input, init)) };
      },
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
  const signIn = async (email, password) => {
    const res = await worker.fetch(new Request(`${ORIGIN}/__auth`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email, password, redirect: "/" }).toString(),
    }), env, { waitUntil: (p) => pending.push(p) });
    // The resume rides waitUntil, exactly like the activity stamp: the sign-in must not
    // wait on it. Draining it here is what a real runtime does after the response.
    await Promise.all(pending.splice(0));
    return res;
  };
  return { tenantId, store, env, signIn };
}

test("END TO END — a dormant workspace's admin signs in, and the site comes back", async () => {
  const { store, signIn, env } = await deployment(DORMANT);
  // Before: the front door really is serving the holding page.
  const before = await worker.fetch(new Request(`${ORIGIN}/`, { headers: { Accept: "text/html" } }),
    env, { waitUntil() {} });
  assert.equal(before.status, 503);
  assert.match(await before.text(), /paused/i);

  const res = await signIn(ADMIN, PASSWORD);
  assert.equal(res.status, 303, "the admin was not signed in");
  assert.match(res.headers.get("Set-Cookie") || "", /__Host-augur_user=/);

  const s = store.status();
  assert.equal(s.suspended, false, "the workspace did not come back");
  assert.equal(s.resumedFrom, DORMANT);
  // Recorded as the one-way person id the rest of the engine stamps provenance with, and
  // never as the address — status() reads out to an operator console.
  assert.equal(s.resumedBy, W.personId(ADMIN));
  assert.ok(!JSON.stringify(s).includes(ADMIN), "the record carries an address");

  // And the front door has stopped serving the holding page — IMMEDIATELY, which is the
  // assertion. This request lands milliseconds later, far inside SUSPENSION_TTL_MS, so a
  // resume that had not dropped this isolate's cached "paused" would answer 503 here for
  // another ten seconds. (A hint, not a guarantee: every OTHER isolate still waits the TTL
  // out, and that is the number to quote to somebody refreshing the page.)
  const after = await worker.fetch(new Request(`${ORIGIN}/`, { headers: { Accept: "text/html" } }),
    env, { waitUntil() {} });
  assert.notEqual(after.status, 503, "the front door still served the paused page after the resume");
});

test("3. ⚠️ END TO END — a dormant workspace's admin gets the PASSWORD WRONG → still paused", async () => {
  // The failed-attempt case, and the reason the call sits inside the success branch: without
  // that, knowing an admin's ADDRESS would be enough to bring a workspace back.
  const { store, signIn } = await deployment(DORMANT);
  const res = await signIn(ADMIN, "not the password");
  assert.equal(res.status, 401, "a wrong password signed somebody in");
  assert.equal(store.status().suspended, true, "a failed sign-in resumed a dormant workspace");
  assert.equal(store.status().resumedAt, null);
});

test("END TO END — an address that is on no roster does not resume anything", async () => {
  const { store, signIn } = await deployment(DORMANT);
  assert.equal((await signIn("stranger@example.test", PASSWORD)).status, 401);
  assert.equal(store.status().suspended, true);
});

test("2. END TO END — a dormant workspace's editor and viewer sign in → it stays paused", async () => {
  for (const email of [EDITOR, VIEWER]) {
    const { store, signIn } = await deployment(DORMANT);
    const res = await signIn(email, PASSWORD);
    assert.equal(res.status, 303, `${email} was not signed in, so nothing was proved`);
    assert.equal(store.status().suspended, true, `${email} un-paused the workspace`);
    assert.equal(store.status().resumedAt, null, email);
  }
});

test("4. ⚠️ END TO END — an acceptable-use takedown survives its own admin signing in", async () => {
  const { store, signIn } = await deployment("aup: phishing page");
  const res = await signIn(ADMIN, PASSWORD);
  assert.equal(res.status, 303, "the admin was not signed in, so nothing was proved");
  const s = store.status();
  assert.equal(s.suspended, true, "⚠️ AN ADMIN SIGNING IN LIFTED A TAKEDOWN");
  assert.equal(s.suspendedReason, "aup: phishing page");
  assert.equal(s.resumedAt, null);
});

test("5. END TO END — a tombstoned workspace survives its own admin signing in", async () => {
  const { store, signIn } = await deployment(null);
  store.deleteWorkspace("2026-01-01T00:00:00.000Z");
  const res = await signIn(ADMIN, PASSWORD);
  assert.equal(res.status, 303, "the admin was not signed in, so nothing was proved");
  const s = store.status();
  assert.equal(s.suspended, true, "an admin signing in undeleted a workspace");
  assert.equal(s.deleted, true);
  assert.equal(s.resumedAt, null);
});

test("6. END TO END — a reason nobody has added to the allowlist stays paused", async () => {
  const { store, signIn } = await deployment("non-payment");
  assert.equal((await signIn(ADMIN, PASSWORD)).status, 303);
  assert.equal(store.status().suspended, true, "a future suspension kind resumed itself");
  assert.equal(store.status().suspendedReason, "non-payment");
});

test("⚠️ END TO END — THE OTHER SESSION MINT IS UNREACHABLE, so there is no second branch", async () => {
  // Driven, not read off the SUSPENDED_ALLOWED pin above. `/__invite` — accepting an invite
  // sets a password and signs you straight in — is the only other place this engine issues
  // a session cookie, and the resume is NOT wired into it. That is right rather than
  // forgotten: on a paused workspace the front-door gate answers before the router, so the
  // handler never runs and there is no un-resumed sign-in hiding behind it.
  const { env, store } = await deployment(DORMANT);
  for (const method of ["GET", "POST"]) {
    const res = await worker.fetch(new Request(`${ORIGIN}/__invite?t=whatever`, {
      method,
      headers: { Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded" },
      body: method === "POST" ? new URLSearchParams({ token: "whatever", password: PASSWORD }).toString() : undefined,
    }), env, { waitUntil() {} });
    assert.equal(res.status, 503, `${method} /__invite ran on a paused workspace`);
    assert.match(await res.text(), /paused/i);
    assert.equal(res.headers.get("Set-Cookie"), null, `${method} /__invite issued a cookie`);
  }
  assert.equal(store.status().suspended, true);
});

test("A LIVE WORKSPACE COSTS NOTHING — a sign-in makes no resume call at all", async () => {
  // The common case by a very wide margin. `paused` is falsy, so the worker never reaches
  // for the object, and this asserts that rather than trusting it.
  const { env, signIn, store } = await deployment(null);
  let asked = 0;
  const inner = env.TENANTS.get;
  env.TENANTS.get = (n) => {
    const stub = inner(n);
    return { fetch: (input, init) => {
      if (String(input).endsWith("/resume-on-sign-in")) asked++;
      return stub.fetch(input, init);
    } };
  };
  assert.equal((await signIn(ADMIN, PASSWORD)).status, 303);
  assert.equal(asked, 0, "a live workspace paid for a resume round trip on every sign-in");
  assert.equal(store.status().suspended, false);
});

test("A SINGLE-WORKSPACE INSTANCE NEVER TAKES THE BRANCH — no binding, no question", () => {
  // Every self-hosted instance and both live ones. `paused` is null because the front door
  // never asked, so there is nothing to resume and no stub to reach for.
  const admin = { email: ADMIN, role: "admin" };
  assert.doesNotThrow(() => W.resumeAfterDormancy({}, { tenantId: "solo" }, admin, null, null));
  assert.doesNotThrow(() => W.resumeAfterDormancy(undefined, { tenantId: "solo" }, admin, null, null));
});

test("⚠️ A NEVER-READ FLAG IS NOT EVIDENCE OF A SUSPENSION, and is not a resume attempt", async () => {
  // `undefined` is the fail-closed answer: this isolate has never managed to read the flag.
  // It refuses to SERVE on it, and it must not act on it either — if the flag was
  // unreadable the object is unreachable anyway, and "I could not tell" is not "dormant".
  let asked = 0;
  const env = {
    TENANTS: { idFromName: (n) => n, get: () => ({ fetch: async () => { asked++; return new Response("{}"); } }) },
  };
  W.resumeAfterDormancy(env, { tenantId: "cold" }, { email: ADMIN, role: "admin" }, undefined, null);
  assert.equal(asked, 0, "an unreadable flag was treated as a dormancy suspension");
});
