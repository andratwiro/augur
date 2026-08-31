// The reads move onto the workspace object, one family at a time — and each move is
// reversible on its own.
//
// `B-kv-read-cutover`. `B-kv-to-do-migration-tool` left the object holding a COPY that
// nothing read. This is the half that makes the object the thing the instance answers
// from. Four families have moved: `users:invites`, `users:lastseen:`, `publish:tokens`
// (with its authorization SCOPE, which is the whole of why it could not move before), and
// the four roster documents behind `rosterFields`. What is left is `users:spaces`, which
// the inventory DROPS rather than migrates, and `spaces:icons`, which has no copy into the
// object's `settings` table yet — the header of `KV_CUTOVER` in src/_worker.js says so.
//
// ── WHAT A GREEN RESULT HERE IS EVIDENCE OF ──────────────────────────────────────────
//
// Every case below drives the REAL worker through `worker.fetch`, over the same HTTP
// endpoint, against two deployments that differ in exactly one thing: whether `TENANTS` is
// bound. Nothing is asserted by reading a store — the stores are read only to SET UP a
// case and, once, to COUNT what a request asked for. A test that compared the two stores
// instead of the two answers would pass on a worker that read the right rows and served the
// wrong page.
//
// ── AND WHAT IT IS NOT ───────────────────────────────────────────────────────────────
//
// `node:sqlite` behind a storage stub is not workerd, and a stub namespace is not a Durable
// Object namespace. What this proves is the SEAM — which store answers, what happens when it
// cannot, and that the two answers agree. A deployment on a real account is a rehearsal
// nothing in a test file can stand in for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TenantStore } from "../src/tenant-do.js";
import { identityFromKv } from "../src/kv-identity.mjs";
import * as WORKER from "../src/_worker.js";

const worker = WORKER.default;
const W = WORKER.__testables;

const ORIGIN = "https://example.test";
const ADMIN = "ada@example.test";
const GUEST = "grace@example.test";
const PASSWORD = "a properly long password";
const PASS_HASH = await W.hashPassword(PASSWORD);

const ROSTER = [
  { email: ADMIN, name: "Ada", initials: "A", role: "admin", passHash: PASS_HASH },
  { email: GUEST, name: "Grace", initials: "G", role: "editor", passHash: PASS_HASH },
];

const CONFIG = {
  "/__config/instance.json": JSON.stringify({
    users: ROSTER, engineVersion: "1.0.0-cutover", updateFeed: "",
    mcpHostSuffixes: [], mcpHostAllowlistUrl: "", vanityRedirects: {}, rtOrigin: "", sentinels: [],
  }),
  "/__config/routing.json": JSON.stringify({
    buildId: "cutover-build", versionMap: {}, publicPrefixes: [], publicSkillPrefixes: [],
    restrictedBases: [], canvasLoaderExtras: "", canvasCatalog: [], canvasTracks: [], mcpAllowlist: [],
    spaces: [{ id: "one", name: "One", badge: "O", default: true, base: "", adminOnly: false }],
    defaultSpace: "one",
  }),
};

/** A DO storage stub with REAL transaction semantics — the harness the other DO files use. */
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

/** A KV binding that COUNTS what it was asked for, so "zero reads" is measured. */
function memKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  const gets = [];
  return {
    store, gets,
    async get(k) { gets.push(k); return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
    async list({ prefix = "" } = {}) {
      return {
        keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      };
    },
  };
}

let seq = 0;

/**
 * One deployment of the real worker.
 *
 * `tenants: false` is every self-hosted instance — no workspace object, so `identityFor`
 * answers null and every family stays on KV. `tenants: true` is the hosted worker. The two
 * are otherwise identical, which is the whole point: the same fixture, the same routes, and
 * the difference is one binding.
 *
 * `workerModule` is a whole MODULE NAMESPACE, not a default export: the reverted copy has
 * its own per-isolate memo and its own config tick, and priming this file's copy instead is
 * how the revert case first failed. It lets a case drive a DIFFERENT copy of the worker —
 * which is how the revert is RUN rather than read.
 */
async function deployment({ tenants = true, kv: seed = {}, workerModule = WORKER, tenantId } = {}) {
  const id = tenantId || `ws-${++seq}`;
  const db = new DatabaseSync(":memory:");
  const object = new TenantStore({ storage: storage(db), blockConcurrencyWhile: async (f) => f() }, {});
  await object.provision({ workspaceId: id, adminEmail: ADMIN });
  const kv = memKV(seed);
  let broken = false;
  const pending = [];
  const env = {
    COMMENTS: kv,
    SESSION_SECRET: "cutover-fixed-session-secret",
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
  if (tenants) {
    env.TENANTS = {
      idFromName: (n) => n,
      get: (n) => {
        assert.equal(n, id, "the worker reached for another workspace's object");
        return {
          fetch: (input, init) => {
            const url = new URL(typeof input === "string" ? input : input.url);
            // THE BREAK. Not "unbind the store" — that is the failure mode the item warns
            // is the one that fails OPEN — but the store answering an error, which is what
            // an outage actually looks like from in here.
            if (broken && url.pathname.startsWith("/identity/")) {
              return Promise.resolve(Response.json({ error: "storage-unavailable" }, { status: 500 }));
            }
            return object.fetch(new Request(input, init));
          },
        };
      },
    };
  }
  // The test hooks of the module BEING DRIVEN, never of the one this file imported. The
  // memo and the config tick are per-module state, so priming the wrong copy leaves the
  // reverted worker resolving `default` — which is how the revert case failed the first
  // time it ran.
  const T = workerModule.__testables;
  const fire = async (path, init) => {
    T.__setTenantTestState({ memo: { at: Date.now(), tenantId: id } });
    T.__setConfigTestState({ cfgAt: 0, cfgGoodAt: 0, roster: null, manifests: null, storage: null });
    const res = await workerModule.default.fetch(new Request(ORIGIN + path, init), env, {
      waitUntil: (p) => pending.push(p),
    });
    await Promise.all(pending.splice(0));
    return res;
  };
  const cookieFor = async (email) => {
    const u = ROSTER.find((r) => r.email === email);
    const secret = await T.effectiveSecret(env, u);
    assert.ok(secret, "the fixture gave this person no resolvable secret");
    return { Cookie: `__Host-augur_user=${email}.${await T.userToken(env, u, secret)}` };
  };
  return {
    id, env, kv, object, fire, cookieFor,
    break: () => { broken = true; },
    restore: () => { broken = false; },
  };
}

/** Mint an invite through the ADMIN ROUTE, which is the only way a person ever gets one. */
async function inviteVia(d, email) {
  const res = await d.fire("/__admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await d.cookieFor(ADMIN)) },
    body: JSON.stringify({ op: "reset", email }),
  });
  // The body is read ONCE and then asserted on: `assert(x, await res.text())` evaluates its
  // message eagerly, so it consumes the very body the success path then wants.
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return new URL(JSON.parse(text).url).searchParams.get("t");
}

const redeem = (d, token, password = "another long enough password") => d.fire("/__invite", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ token, password }).toString(),
});

// ═══ THE LOGIN GATE, FIRST ═══════════════════════════════════════════════════════════
//
// The item's order, not a preference: `identify()` runs on every cookie-bearing request,
// and while it is wrong nobody signs in and there is no in-app recovery. A run that cannot
// demonstrate the refusal has demonstrated nothing, so the break below is real and both
// directions are asserted.

test("GATE 1 — an existing session survives the object's identity store failing", async () => {
  // `identify()` reads `users:secrets`, which is NOT in this item: a credential is
  // account-level and `effectiveSecret` moving belongs to B-cross-workspace-signin. So the
  // property to prove is that cutting these two families did not put the session on the
  // object's critical path. Sign in, break it, and the same cookie still resolves.
  const d = await deployment({ tenants: true });
  const signIn = await d.fire("/__auth", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: ADMIN, password: PASSWORD, redirect: "/" }).toString(),
  });
  assert.equal(signIn.status, 303, "the fixture could not sign in at all");
  const cookie = (signIn.headers.get("Set-Cookie") || "").split(";")[0];
  assert.match(cookie, /^__Host-augur_user=/);

  const before = await d.fire("/__me", { headers: { Cookie: cookie } });
  assert.equal((await before.json()).user.email, ADMIN);

  d.break();
  const during = await d.fire("/__me", { headers: { Cookie: cookie } });
  assert.equal(during.status, 200);
  assert.equal((await during.json()).user.email, ADMIN,
    "cutting invites and lastseen put the session on the object's critical path");

  d.restore();
  const after = await d.fire("/__me", { headers: { Cookie: cookie } });
  assert.equal((await after.json()).user.email, ADMIN, "the same session stopped resolving");
});

test("GATE 2 — THE REFUSAL: with the object's read broken, a session is not ISSUED", async () => {
  // ⚠️ THIS IS THE ONE THAT MATTERS. `/__invite` is one of the two places this engine mints
  // a session, and its gate is now the object's `invites` table. Break the read and the
  // question is which way it fails: refusing a live link is an inconvenience, admitting
  // somebody on an unreadable one is a way in. It must refuse, and it must refuse WITHOUT
  // issuing a cookie — a 400 that still hands out a session would look like a refusal in a
  // status code and be an admission in a header.
  const d = await deployment({ tenants: true });
  const token = await inviteVia(d, GUEST);

  d.break();
  const blocked = await redeem(d, token);
  assert.ok(blocked.status >= 400, `expected a refusal, got ${blocked.status}`);
  assert.equal(blocked.headers.get("Set-Cookie"), null,
    "CRITICAL: a session was issued while the store that decides who may have one was unreadable");
  assert.equal(d.kv.store.get("users:secrets") == null
    || !JSON.parse(d.kv.store.get("users:secrets"))[GUEST],
    true, "a password was set for an invite that could not be verified");

  // And it is a refusal, not a wedge: the same link works the moment the store does.
  d.restore();
  const ok = await redeem(d, token);
  assert.equal(ok.status, 303, ok.status === 303 ? "" : await ok.text());
  assert.match(ok.headers.get("Set-Cookie") || "", /^__Host-augur_user=/);
});

test("GATE 3 — the break is real: without it the very same request is ADMITTED", async () => {
  // A refusal proves nothing if the fixture refuses everything. Same deployment shape, same
  // link, no break — and it goes through. This is what makes GATE 2 a measurement.
  const d = await deployment({ tenants: true });
  const token = await inviteVia(d, GUEST);
  const res = await redeem(d, token);
  assert.equal(res.status, 303);
  assert.match(res.headers.get("Set-Cookie") || "", /^__Host-augur_user=/);
});

// ═══ ONE ANSWER, TWO BACKINGS ════════════════════════════════════════════════════════

test("the invite page answers identically with TENANTS bound and unbound", async () => {
  // The same HTTP endpoint, and the comparison is the RESPONSE — never either store.
  const answers = [];
  for (const tenants of [true, false]) {
    const d = await deployment({ tenants });
    const token = await inviteVia(d, GUEST);
    const res = await d.fire(`/__invite?t=${encodeURIComponent(token)}`);
    // The token is per-mint random, so it is normalised out; everything else is compared
    // byte for byte, including the address the page names back at the recipient.
    answers.push([res.status, (await res.text()).split(token).join("<TOKEN>")]);
  }
  assert.equal(answers[0][0], 200);
  assert.deepEqual(answers[0], answers[1], "the object and KV render two different pages");
  assert.match(answers[0][1], new RegExp(GUEST.replace(".", "\\.")), "the page names nobody, so it proves nothing");
});

test("the admin user list answers identically with TENANTS bound and unbound", async () => {
  // `lastSeen` is the column this family feeds. `/__me` is what stamps it.
  const answers = [];
  for (const tenants of [true, false]) {
    const d = await deployment({ tenants });
    const cookie = await d.cookieFor(ADMIN);
    await d.fire("/__me", { headers: cookie });
    const res = await d.fire("/__admin/users", { headers: cookie });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    const body = JSON.parse(text);
    // The stamp is a clock, so it is compared as PRESENT-or-ABSENT per person rather than
    // by value — an equality on the instant would be a test of two `Date.now()` calls.
    answers.push(body.users.map((u) => `${u.email}/${u.role}/${u.state}/${u.lastSeen ? "seen" : "-"}`));
  }
  assert.deepEqual(answers[0], answers[1]);
  assert.ok(answers[0].some((r) => r.endsWith("/seen")), "nobody was stamped, so the column proves nothing");
});

// ═══ AN INVITE ALREADY IN SOMEBODY'S INBOX ═══════════════════════════════════════════

test("a link minted BEFORE the cut is redeemed AFTER it, and refused the second time", async () => {
  // The KV path mints it — that is what "before the cut" means — and the same KV document
  // is then handed to a deployment reading from the object. The object has never heard of
  // this token, so only the FALLBACK can answer, which is exactly the case the item says
  // must not die silently.
  const before = await deployment({ tenants: false });
  const token = await inviteVia(before, GUEST);
  const carried = Object.fromEntries(before.kv.store);

  const after = await deployment({ tenants: true, kv: carried });
  const first = await redeem(after, token);
  assert.equal(first.status, 303,
    first.status === 303 ? "" : `a link minted before the cut died on it: ${await first.text()}`);

  const second = await redeem(after, token, "yet another long password");
  assert.equal(second.status, 400, "a single-use link was accepted twice");
  assert.equal(second.headers.get("Set-Cookie"), null);
});

test("THE HASH CONTRACT — a link the COPY carried is redeemed off the object", async () => {
  // ⚠️ The contract this item inherits: `inviteHash` is `tokenFor("inv:" + token)` in the
  // worker, and `identityFromKv` hashes an outstanding token on the way in. Spelled
  // differently in either place, every invite already sitting in an inbox stops working on
  // the day the reads move, and nothing before that day would notice. So this runs the REAL
  // copy over the REAL KV document and redeems the link off the object alone — the KV
  // fallback is emptied first, so a green result cannot be the fallback's.
  const before = await deployment({ tenants: false });
  const token = await inviteVia(before, GUEST);
  const kvInvites = JSON.parse(before.kv.store.get(W.USER_INVITES_KEY));

  const after = await deployment({ tenants: true, kv: Object.fromEntries(before.kv.store) });
  const { identity } = await identityFromKv({ "users:invites": kvInvites }, {
    configUsers: ROSTER, hashInvite: W.inviteHash,
  });
  after.object.importAll({ overlay: {}, identity });
  // The fallback is removed, so the object is the only thing that can answer.
  after.kv.store.delete(W.USER_INVITES_KEY);

  const res = await redeem(after, token);
  assert.equal(res.status, 303,
    res.status === 303 ? "" : `the copy and the redemption path do not hash alike: ${await res.text()}`);
  assert.match(res.headers.get("Set-Cookie") || "", /^__Host-augur_user=/);
});

test("A ROW AN OLDER COPY WROTE IS STILL REDEEMABLE — the epoch-vs-ISO expiry", async () => {
  // ⚠️ THE BUG THIS ITEM FOUND. KV stores an invite's expiry as epoch MILLISECONDS; every
  // timestamp column in the object's schema is an ISO-8601 string. The copy handed the
  // number straight over, so the table held a number in a text column where `Date.parse`
  // answers `NaN`. Nothing read the table, so nothing noticed. `identityFromKv` now
  // converts — and `stampMs` still accepts the number, or every row an earlier copy wrote
  // would have gone dead on the day the reads moved. That accommodation is what this pins.
  //
  // ⚠️ AND THE FIXTURE IS THE NUMBER, NOT A STRING OF IT. `mintInvite` writes
  // `{expires: <number>}` into KV and the pre-fix `identityFromKv` passed that value
  // through, so `writeIdentity` BOUND a number — which SQLite converts through TEXT
  // affinity from a double, into `"…092.0"`. Writing `String(n)` here instead spells a row
  // the copy has never produced: it holds `"…092"`, matches a digits-only accommodation,
  // and passes while every real row is refused. That is exactly how this fixture read green
  // against a shape that does not exist, so the stored value is asserted below rather than
  // assumed — see `stampMs` in src/tenant-do.js, and the run that found it,
  // `scripts/tenant-do-rehearsal.mjs`.
  const d = await deployment({ tenants: true });
  const token = "a-token-an-older-copy-carried";
  d.object.importAll({
    overlay: {},
    identity: {
      invites: [{
        tokenHash: await W.inviteHash(token),
        email: GUEST,
        createdAt: Date.now() - 1000,
        expiresAt: Date.now() + 60_000,   // epoch ms, AS A NUMBER, as the old copy wrote it
      }],
    },
  });
  const stored = [...d.object.sql.exec(
    `SELECT expires_at FROM invites WHERE token_hash = ?`, await W.inviteHash(token))][0].expires_at;
  assert.equal(Number.isFinite(Date.parse(String(stored))), false,
    `the fixture is not actually the broken shape (${JSON.stringify(stored)}), so this proves nothing`);

  const res = await d.fire(`/__invite?t=${encodeURIComponent(token)}`);
  assert.equal(res.status, 200, `a row an earlier copy wrote reads as invalid (stored ${JSON.stringify(stored)})`);
  assert.match(await res.text(), new RegExp(GUEST.replace(".", "\\.")));
});

test("an expired row is still expired — the tolerant read did not make expiry optional", async () => {
  // Both spellings of the number, because the accommodation now accepts both and "tolerant"
  // must not have quietly become "unexpiring". The bound-number one is the shape the copy
  // wrote; the string one is what a fixture writes by hand.
  for (const expiresAt of [Date.now() - 60_000, String(Date.now() - 60_000)]) {
    const d = await deployment({ tenants: true });
    const token = `a-token-that-has-run-out-${typeof expiresAt}`;
    d.object.importAll({
      overlay: {},
      identity: {
        invites: [{
          tokenHash: await W.inviteHash(token),
          email: GUEST,
          createdAt: new Date(Date.now() - 90_000).toISOString(),
          expiresAt,
        }],
      },
    });
    const res = await d.fire(`/__invite?t=${encodeURIComponent(token)}`);
    assert.equal(res.status, 400, `an expired row spelled as a ${typeof expiresAt} was accepted`);
  }
});

test("REMOVING SOMEBODY KILLS THEIR OUTSTANDING LINK IN BOTH STORES", async () => {
  // ⚠️ Redeeming an invite calls `setUserSecret`, which REPLACES the `users:secrets`
  // tombstone that removal writes. So a link that survives a removal is a way back in for
  // the person who was just removed — and with the object as the read, a revocation that
  // reached only KV would leave exactly that. Both are emptied; the link is dead either way
  // the read goes.
  const d = await deployment({ tenants: true });
  const token = await inviteVia(d, GUEST);
  const res = await d.fire("/__admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await d.cookieFor(ADMIN)) },
    body: JSON.stringify({ op: "remove", email: GUEST }),
  });
  const text = await res.text();
  assert.equal(res.status, 200, text);

  const dead = await redeem(d, token);
  assert.equal(dead.status, 400, "a removed person's outstanding link still redeemed");
  assert.equal(dead.headers.get("Set-Cookie"), null);
  // And not merely because one store forgot it: the fallback has nothing either.
  assert.deepEqual(JSON.parse(d.kv.store.get(W.USER_INVITES_KEY) || "{}"), {});
});

// ═══ THE FAMILIES THAT DID NOT MOVE ══════════════════════════════════════════════════

/** Ask the real resolver about a token, over the real Authorization header. */
const authFor = (d, token, spaceId = "one") => W.publishAuthDetailed(
  { tenantId: d.id, USERS: ROSTER },
  new Request(`${ORIGIN}/__publish/${spaceId}/check`, { headers: { Authorization: `Bearer ${token}` } }),
  d.env, spaceId, false,
);

/** Mint through the admin route, which is the only door a person mints one at. */
async function tokenVia(d, space, label) {
  const res = await d.fire("/__admin/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await d.cookieFor(ADMIN)) },
    body: JSON.stringify({ space, label }),
  });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  const token = JSON.parse(text).token;
  assert.ok(token, "the fixture minted no token");
  return token;
}

test("a publish token minted before the cut still publishes after it, at its own scope", async () => {
  // ⚠️ THE CLAUSE THE `scope` COLUMN EARNS ITS PLACE ON. Two tokens minted on a deployment
  // with no object — one scoped to a space, one star — carried into a deployment that reads
  // from the object. The space-scoped one must not be WIDENED to star, and the star one must
  // not be REFUSED: those are the two inventions a read with no column would have had to
  // choose between, and each is wrong in a way nobody sees until afterwards.
  const before = await deployment({ tenants: false });
  const scoped = await tokenVia(before, "one", "backup");
  const star = await tokenVia(before, "*", "ci");

  const after = await deployment({ tenants: true, kv: Object.fromEntries(before.kv.store) });
  const a1 = await authFor(after, scoped);
  assert.equal(a1.refusal, null, `a token minted before the cut stopped publishing: ${a1.refusal}`);
  assert.equal(a1.entry.space, "one", "the token's SCOPE did not survive");
  const a2 = await authFor(after, star);
  assert.equal(a2.refusal, null, `a star token minted before the cut was refused: ${a2.refusal}`);
  assert.equal(a2.entry.space, "*", "a star token came back narrowed");

  // And the scope is an authorization, not a label: the space-scoped one is refused
  // elsewhere, on the object path, exactly as it was on the KV one.
  const elsewhere = await authFor(after, scoped, "two");
  assert.equal(elsewhere.refusal, "wrong-space", "a space-scoped token was widened by the move");
});

test("a token minted AFTER the cut answers off the object alone, and revocation reaches both", async () => {
  // Non-vacuous in the way the item asks for: the KV document is emptied, so only the
  // object can answer. Then the token is revoked through the panel and is dead on both.
  const d = await deployment({ tenants: true });
  const scoped = await tokenVia(d, "one", "backup");
  const star = await tokenVia(d, "*", "ci");
  const kvMap = JSON.parse(d.kv.store.get(W.PUBLISH_TOKENS_KEY));
  assert.equal(Object.keys(kvMap).length, 2, "the dual write did not reach KV, so the flag is not a revert");

  d.kv.store.delete(W.PUBLISH_TOKENS_KEY);
  assert.equal((await authFor(d, scoped)).entry.space, "one", "the object cannot answer without KV");
  assert.equal((await authFor(d, star)).entry.space, "*");
  assert.equal((await authFor(d, scoped, "two")).refusal, "wrong-space");

  d.kv.store.set(W.PUBLISH_TOKENS_KEY, JSON.stringify(kvMap));
  const hash = Object.keys(kvMap).find((h) => kvMap[h].label === "backup");
  const del = await d.fire("/__admin/tokens", {
    method: "DELETE",
    headers: { "Content-Type": "application/json", ...(await d.cookieFor(ADMIN)) },
    body: JSON.stringify({ hash }),
  });
  assert.equal(del.status, 200, await del.text());
  assert.equal((await authFor(d, scoped)).refusal, "unknown-token", "a revoked token still publishes");
  assert.equal(JSON.parse(d.kv.store.get(W.PUBLISH_TOKENS_KEY))[hash], undefined,
    "the revocation reached the object and not KV — the fallback would resurrect it");
});

test("GATE 5 — a broken object REFUSES a publish rather than falling through to KV", async () => {
  // Same shape as GATE 2, on the other credential. The KV row is left live, so a
  // fall-through would succeed — which is what makes the refusal a measurement.
  const d = await deployment({ tenants: true });
  const scoped = await tokenVia(d, "one", "backup");
  assert.equal((await authFor(d, scoped)).refusal, null);
  assert.ok(JSON.parse(d.kv.store.get(W.PUBLISH_TOKENS_KEY)), "KV holds no row, so nothing could fall through");

  d.break();
  assert.equal((await authFor(d, scoped)).refusal, "no-store",
    "CRITICAL: an unreadable workspace store fell through to KV and authorized a publish");

  d.restore();
  assert.equal((await authFor(d, scoped)).refusal, null, "the refusal was a wedge, not an outage");
});

test("the cut families are exactly these four, and the constant is frozen", async () => {
  // Named rather than left implicit, so adding a fifth is a deliberate act that fails a
  // test and sends somebody to the header before they write the code.
  assert.deepEqual(Object.keys(W.KV_CUTOVER).sort(),
    ["invites", "lastseen", "publishTokens", "roster"]);
  assert.equal(Object.isFrozen(W.KV_CUTOVER), true);
});

test("A PUBLISH TOKEN'S SCOPE SURVIVES THE COPY, AND IS NEITHER WIDENED NOR REFUSED", async () => {
  // ⚠️ THE BLOCKER THIS SLICE CLEARED. `space` is the authorization scope: `*` is
  // admin-equivalent because a star token pushes the instance config, i.e. the roster.
  // Without a column the read could only invent one, and both inventions are wrong in a
  // direction nobody sees until a publish fails. So: the column exists, the copy fills it
  // verbatim, and a row an OLDER copy wrote — scope null — is treated as no answer at all
  // rather than as a guess.
  const { identity } = await identityFromKv({
    "publish:tokens": {
      "hash-one": { space: "one", label: "backup", createdAt: "2026-01-01T00:00:00.000Z" },
      "hash-star": { space: "*", label: "ci", createdAt: "2026-01-01T00:00:00.000Z" },
    },
  }, { configUsers: ROSTER, hashInvite: W.inviteHash });
  assert.deepEqual(identity.publishTokens.map((t) => t.scope).sort(), ["*", "one"]);

  const db = new DatabaseSync(":memory:");
  const store = new TenantStore({ storage: storage(db), blockConcurrencyWhile: async (f) => f() }, {});
  await store.provision({ workspaceId: "scope-check", adminEmail: ADMIN });
  const cols = db.prepare("PRAGMA table_info(publish_tokens)").all().map((c) => c.name);
  // `caps` is the other authorization field and rides the same rule — see
  // test/token-caps-column.test.mjs, which is where its own no-answer case lives.
  assert.deepEqual(cols.sort(), ["caps", "created_at", "expires_at", "label", "scope", "token_hash"]);

  store.importAll({ overlay: {}, identity });
  assert.equal(store.publishTokenRead("hash-one").space, "one", "a space-scoped token was not widened");
  assert.equal(store.publishTokenRead("hash-star").space, "*", "a star token was not narrowed");

  // The pre-column row: present, and deliberately unanswerable.
  db.prepare("INSERT INTO publish_tokens (token_hash, label, created_at) VALUES ('old', 'legacy', 'x')").run();
  assert.equal(store.publishTokenRead("old"), null,
    "a row whose scope a copy could not carry was answered with an invented one");
});

test("THE ROSTER'S COLUMNS TELL THE FILE FROM THE OVERLAY — the other blocker, cleared", async () => {
  // The second blocker. The copy used to MERGE the config roster into `members`, so `role`
  // and `name` no longer said where they came from — and the serving path needs the
  // difference: `applyNames` drops a config-set `initials` when there IS an override and
  // keeps it when there is not, so one column cannot reproduce both answers. Now there are
  // two columns, plus the `initials` and colour every chip renders.
  const configUsers = [{ email: GUEST, name: "Grace", initials: "GX", color: "#123456", role: "editor" }];
  const { identity } = await identityFromKv({
    "users:roster": { add: {}, remove: [] },
    "users:names": { [GUEST]: { name: "Chosen", at: "2026-01-01T00:00:00.000Z" } },
  }, { configUsers, hashInvite: W.inviteHash });
  const row = identity.members.find((m) => m.email === GUEST);
  assert.equal(row.name, "Grace", "the durable column holds the FILE's name");
  assert.deepEqual(row.nameOverlay, { name: "Chosen", at: "2026-01-01T00:00:00.000Z" });
  assert.equal(row.initials, "GX");
  assert.equal(row.colour, "#123456");
  assert.equal(row.source, "config");

  // …and the aliasing case the merge could not reproduce, run on the real functions: the
  // SAME durable row, one workspace with an override and one without, rendered differently.
  const withOverride = W.applyNames(configUsers, { [GUEST]: { name: "Grace" } });
  const without = W.applyNames(configUsers, {});
  assert.equal(withOverride[0].initials, undefined);
  assert.equal(without[0].initials, "GX");
});

test("THE ROSTER ROUND-TRIPS: four documents in, the same four documents out", async () => {
  // The property that makes "bound and unbound answer the same" structural rather than
  // hoped for. `rosterRead` answers with the KV documents THEMSELVES, so the serving
  // pipeline below it is one pipeline fed from either store — not two that agree today.
  const d = await deployment({ tenants: true });
  const docs = {
    roster: {
      add: { "invited@example.test": {
        email: "invited@example.test", name: "Invited", role: "editor",
        initials: "IN", color: "#abcdef", addedAt: "2026-08-01T00:00:00.000Z", addedBy: ADMIN,
      } },
      remove: [GUEST],
    },
    roles: { [ADMIN]: "editor" },
    // Both live shapes of `users:names`, because only one of them is honoured and the
    // round trip must not quietly convert the ignored one into the honoured one.
    names: { [ADMIN]: { name: "Chosen", at: "2026-08-02T00:00:00.000Z" }, "old@example.test": "Legacy" },
    avatars: { [ADMIN]: { k: "abc123", mime: "image/png", at: "2026-08-03T00:00:00.000Z" } },
  };
  d.object.rosterWrite({ configUsers: ROSTER.map((u) => ({ ...u, passHash: undefined })), ...docs });
  const back = d.object.rosterRead();
  assert.equal(back.seeded, true);
  assert.deepEqual(back.roster.add, docs.roster.add);
  assert.deepEqual(back.roster.remove.sort(), [GUEST].sort());
  assert.deepEqual(back.roles, docs.roles);
  assert.deepEqual(back.names, docs.names);
  assert.deepEqual(back.avatars, docs.avatars);
});

test("AN OBJECT THAT WAS NEVER GIVEN THE ROSTER DEFERS TO KV — empty is not the same as unfilled", async () => {
  // ⚠️ A workspace copied off KV and a workspace whose copy has not run yet both have no
  // rows, and answering the second from the object would silently un-remove everybody
  // `users:roster.remove` names. So the object says which it is.
  const d = await deployment({ tenants: true });
  assert.equal(d.object.rosterRead().seeded, true, "provisioning is a filling: this workspace was born here");

  // The same object with the marker cleared is the un-copied case, and it defers.
  d.object.sql.exec("DELETE FROM meta WHERE k = 'identity_seeded:roster'");
  d.kv.store.set("users:roles", JSON.stringify({ [GUEST]: "viewer" }));
  d.kv.gets.length = 0;
  const docs = await W.readRosterDocs({ tenantId: d.id, CONFIG_USERS: ROSTER }, d.env);
  assert.deepEqual(docs[3], { [GUEST]: "viewer" }, "an unseeded object answered instead of deferring");
  assert.ok(d.kv.gets.includes("users:roles"), "it did not actually read KV");
});

test("bound and unbound serve the SAME roster over the same endpoint", async () => {
  // The VERIFY clause, over `/__people` and `/__admin/users` — never by reading a store.
  // Every change is made through the real admin routes, which dual-write, so the two
  // deployments differ in the binding and in nothing else.
  const answers = [];
  for (const tenants of [true, false]) {
    const d = await deployment({ tenants });
    const headers = { "Content-Type": "application/json", ...(await d.cookieFor(ADMIN)) };
    const invite = await d.fire("/__admin/users", {
      method: "POST", headers,
      body: JSON.stringify({ op: "invite", email: "newcomer@example.test", name: "Newcomer", role: "viewer" }),
    });
    assert.equal(invite.status, 200, await invite.text());
    const role = await d.fire("/__admin/users", {
      method: "POST", headers, body: JSON.stringify({ op: "role", email: GUEST, role: "viewer" }),
    });
    assert.equal(role.status, 200, await role.text());
    const named = await d.fire("/__me/name", {
      method: "POST", headers: { "Content-Type": "application/json", ...(await d.cookieFor(ADMIN)) },
      body: JSON.stringify({ name: "Ada Renamed" }),
    });
    assert.equal(named.status, 200, await named.text());

    const list = await d.fire("/__admin/users", { headers: await d.cookieFor(ADMIN) });
    const body = JSON.parse(await list.text());
    const people = await d.fire("/__people?names=Newcomer");
    answers.push({
      users: body.users.map((u) => `${u.email}/${u.role}/${u.name}/${u.state}`).sort(),
      people: await people.text(),
    });
  }
  assert.deepEqual(answers[0], answers[1], "the object and KV serve two different rosters");
  assert.ok(answers[0].users.some((r) => r.startsWith("newcomer@example.test/viewer/")),
    "the invited person is not in either answer, so this compares nothing");
  assert.ok(answers[0].users.some((r) => r.includes("/Ada Renamed/")), "the name override reached neither");
});

test("A REMOVAL STILL REMOVES on the object path — the tombstone crosses", async () => {
  // The roster overlay is a convenience and `users:secrets` is the boundary, but a removal
  // that stopped hiding somebody from the list would be a visible regression on the exact
  // path this item moved. Removal is a CONFIG user, so it is the `remove` list that carries it.
  for (const tenants of [true, false]) {
    const d = await deployment({ tenants });
    const res = await d.fire("/__admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await d.cookieFor(ADMIN)) },
      body: JSON.stringify({ op: "remove", email: GUEST }),
    });
    assert.equal(res.status, 200, await res.text());
    const list = await d.fire("/__admin/users", { headers: await d.cookieFor(ADMIN) });
    const users = JSON.parse(await list.text()).users.map((u) => u.email);
    assert.equal(users.includes(GUEST), false, `a removed person is still on the roster (tenants=${tenants})`);
  }
});

test("GATE 4 — THE REFUSAL, ON THE ROSTER: a broken object does not admit an overlay", async () => {
  // ⚠️ The roster's failure mode is deliberately NOT the invite's. `readRoster` and
  // `rosterFields` fail OPEN to the config roster on purpose — the item says so, and the
  // reason is that the `users:secrets` tombstone and not this overlay is the security
  // boundary. So what has to be proved here is that the fail-open is to the CONFIG LIST and
  // never to a fall-through onto KV, and that a promotion recorded only in the overlay does
  // NOT survive the object being unreadable.
  const d = await deployment({ tenants: true });
  const promote = await d.fire("/__admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await d.cookieFor(ADMIN)) },
    body: JSON.stringify({ op: "role", email: GUEST, role: "admin" }),
  });
  assert.equal(promote.status, 200, await promote.text());
  const before = await d.fire("/__admin/users", { headers: await d.cookieFor(GUEST) });
  assert.equal(before.status, 200, "the promotion did not take, so the case proves nothing");

  d.break();
  const during = await d.fire("/__admin/users", { headers: await d.cookieFor(GUEST) });
  assert.equal(during.status, 403,
    "CRITICAL: an overlay-granted admin role survived the store that grants it being unreadable");

  d.restore();
  const after = await d.fire("/__admin/users", { headers: await d.cookieFor(GUEST) });
  assert.equal(after.status, 200, "the promotion did not come back — the outage was a wedge, not a refusal");
});

// ═══ THE READ VOLUME, MEASURED ═══════════════════════════════════════════════════════

test("on the cut-over path these families read KV zero times", async () => {
  // The read volume is why this is urgent, so it is a number and not a claim. Both
  // directions: the object path must not touch these KV keys, and the KV path must — or
  // the measurement is of a route that reads nothing either way.
  const touched = (d, ...prefixes) =>
    d.kv.gets.filter((k) => prefixes.some((p) => k === p || k.startsWith(p)));
  const CUT = [W.USER_INVITES_KEY, W.LASTSEEN_PREFIX, W.PUBLISH_TOKENS_KEY,
    "users:roster", "users:roles", "users:names", "users:avatars"];

  const on = await deployment({ tenants: true });
  const token = await inviteVia(on, GUEST);
  const pub = await tokenVia(on, "one", "backup");
  on.kv.gets.length = 0;
  await on.fire(`/__invite?t=${encodeURIComponent(token)}`);
  await on.fire("/__me", { headers: await on.cookieFor(ADMIN) });
  await on.fire("/__admin/users", { headers: await on.cookieFor(ADMIN) });
  await on.fire("/__people?names=Grace");
  await authFor(on, pub);
  assert.deepEqual(touched(on, ...CUT), [],
    "the object path is still reading KV for a family it has taken over");

  const off = await deployment({ tenants: false });
  const token2 = await inviteVia(off, GUEST);
  const pub2 = await tokenVia(off, "one", "backup");
  off.kv.gets.length = 0;
  await off.fire(`/__invite?t=${encodeURIComponent(token2)}`);
  await off.fire("/__me", { headers: await off.cookieFor(ADMIN) });
  await off.fire("/__admin/users", { headers: await off.cookieFor(ADMIN) });
  await off.fire("/__people?names=Grace");
  await authFor(off, pub2);
  assert.ok(touched(off, ...CUT).length > 0,
    "the KV path reads none of these either, so the zero above measures nothing");
});

test("THE ROSTER TICK: four of its six KV gets are gone, and the two that remain are NAMED", async () => {
  // ⚠️ THE HONEST NUMBER, not a round one. `rosterFields` spent six KV gets per workspace
  // per sixty-second tick and that was the site's dominant KV consumer. Four are now one
  // round trip to the object. The other two are `users:spaces` — which the inventory DROPS
  // rather than migrates, and which the object must not answer `{}` for, because that
  // widens a per-space restriction into somebody's global role — and `spaces:icons`, which
  // has no copy into the object's `settings` table yet. Both are written down in
  // `KV_CUTOVER`, and this is the assertion that fails if either quietly changes.
  const count = async (tenants) => {
    const d = await deployment({ tenants });
    d.kv.gets.length = 0;
    await d.fire("/__people?names=Grace");
    return d.kv.gets.filter((k) => ["users:roster", "users:roles", "users:names",
      "users:avatars", "users:spaces", "spaces:icons"].includes(k));
  };
  assert.deepEqual((await count(false)).sort(),
    ["spaces:icons", "users:avatars", "users:names", "users:roles", "users:roster", "users:spaces"],
    "the KV path no longer reads six documents, so the comparison below measures nothing");
  assert.deepEqual((await count(true)).sort(), ["spaces:icons", "users:spaces"],
    "the roster tick's KV reads are not the two the constant names");
});

// ═══ A BACKUP TAKEN EITHER SIDE RESTORES INTO EITHER ═════════════════════════════════

test("the state export is byte-identical with TENANTS bound and unbound", async () => {
  // ⚠️ THIS IS WHY THE WRITES ARE DOUBLED. The export walks KV for these two families, so a
  // straddle that wrote only to the object would produce a copy missing every invite minted
  // since the cut — and a backup that is quietly incomplete is the failure the whole
  // inventory exists to prevent.
  const docs = [];
  for (const tenants of [true, false]) {
    const d = await deployment({ tenants });
    await inviteVia(d, GUEST);
    await d.fire("/__me", { headers: await d.cookieFor(ADMIN) });
    const out = await W.exportState({ tenantId: d.id }, d.env);
    const fams = out.families || {};
    docs.push({
      invites: Object.values(fams["users:invites"] || {}).map((r) => r && r.email).sort(),
      lastseen: Object.keys(fams["users:lastseen:"] || {}).sort(),
      absent: (out.absent || []).includes("users:invites"),
    });
  }
  assert.deepEqual(docs[0], docs[1], "a backup taken on one backing would not restore into the other");
  assert.deepEqual(docs[0].invites, [GUEST]);
  assert.deepEqual(docs[0].lastseen, [ADMIN]);
});

// ═══ THE REVERT, RUN ═════════════════════════════════════════════════════════════════

/**
 * A COPY of the worker with ONE family's flag flipped back, loaded as its own module.
 *
 * ⚠️ RUN, NOT READ. The revert is one word in `KV_CUTOVER`, so this makes the edit, loads
 * the result and drives the same routes through it. A test that asserted about the diff
 * would pass against a flag nothing consults. Every sibling module is SYMLINKED rather than
 * copied, so the reverted worker runs against the same tenant-do.js and the same everything
 * else — exactly one file differs.
 */
async function revertedWorker(family, table = "KV_CUTOVER") {
  const src = fileURLToPath(new URL("../src/_worker.js", import.meta.url));
  const text = fs.readFileSync(src, "utf8");
  // ⚠️ THE TABLE IS NAMED, AND IT HAS TO BE. Three constants now carry per-family flags
  // under the SAME family names — `KV_CUTOVER` (which store answers a read),
  // `BUNDLE_TENANCY` and `IDENTITY_TENANCY` (which keys carry a workspace) — and the
  // shared vocabulary is deliberate. So the edit is anchored inside ONE declaration, or
  // a revert aimed at one of them silently reverts another.
  const start = text.indexOf(`const ${table} = Object.freeze({`);
  assert.ok(start >= 0, `no such flag table: ${table}`);
  const end = text.indexOf("\n});", start);
  assert.ok(end > start, `${table} does not close where a flag table should`);
  const block = text.slice(start, end);
  const needle = `\n  ${family}: true,`;
  assert.equal(block.split(needle).length, 2, `the flag this revert edits has moved: ${table}.${family}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `augur-cutover-revert-${family}-`));
  try {
    for (const entry of fs.readdirSync(path.dirname(src))) {
      if (entry === "_worker.js") continue;
      fs.symlinkSync(path.join(path.dirname(src), entry), path.join(dir, entry));
    }
    fs.writeFileSync(path.join(dir, "_worker.js"),
      text.slice(0, start) + block.replace(needle, `\n  ${family}: false,`) + text.slice(start + block.length));
    const mod = await import(pathToFileURL(path.join(dir, "_worker.js")).href);
    const flags = mod.__testables[table];
    assert.equal(flags[family], false, "the edit did not take");
    for (const other of Object.keys(flags)) {
      if (other !== family) assert.equal(flags[other], true, `the revert reached ${other}, which it was not for`);
    }
    return mod;
  } finally {
    setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} }, 0).unref?.();
  }
}

test("REVERTING `invites` restores the KV answer, and touches nothing else", async () => {
  const reverted = await revertedWorker("invites");

  // A link minted while the family WAS cut over is still redeemable after the revert. That
  // is the property the dual write buys, and it is the whole reason one word is a revert.
  const cut = await deployment({ tenants: true });
  const token = await inviteVia(cut, GUEST);

  const back = await deployment({
    tenants: true, kv: Object.fromEntries(cut.kv.store), workerModule: reverted,
  });
  const res = await redeem(back, token);
  assert.equal(res.status, 303,
    res.status === 303 ? "" : `the revert lost an invite minted during the straddle: ${await res.text()}`);

  // …and it really is reading KV again, on a deployment that HAS an object bound.
  back.kv.gets.length = 0;
  const token2 = await inviteVia(back, GUEST);
  await back.fire(`/__invite?t=${encodeURIComponent(token2)}`);
  assert.ok(back.kv.gets.includes(W.USER_INVITES_KEY),
    "the reverted worker still is not asking KV, so the flag is decorative");

  // The OTHER families are untouched by the revert: still answering off the object, and
  // still not reading their KV keys.
  back.kv.gets.length = 0;
  await back.fire("/__me", { headers: await back.cookieFor(ADMIN) });
  await back.fire("/__admin/users", { headers: await back.cookieFor(ADMIN) });
  await back.fire("/__people?names=Grace");
  assert.deepEqual(back.kv.gets.filter((k) => k.startsWith(W.LASTSEEN_PREFIX)), [],
    "reverting invites dragged lastseen back to KV with it");
  assert.deepEqual(back.kv.gets.filter((k) => k === "users:roster"), [],
    "reverting invites dragged the roster back to KV with it");
});

test("REVERTING `publishTokens` restores the KV answer, and touches nothing else", async () => {
  const reverted = await revertedWorker("publishTokens");

  // Minted while the family was cut over, so it lives in BOTH stores — which is what makes
  // the flip a revert rather than a rollback to whenever the cut happened.
  const cut = await deployment({ tenants: true });
  const scoped = await tokenVia(cut, "one", "backup");
  const star = await tokenVia(cut, "*", "ci");

  const back = await deployment({
    tenants: true, kv: Object.fromEntries(cut.kv.store), workerModule: reverted,
  });
  const ask = (token, spaceId = "one") => reverted.__testables.publishAuthDetailed(
    { tenantId: back.id, USERS: ROSTER },
    new Request(`${ORIGIN}/__publish/${spaceId}/check`, { headers: { Authorization: `Bearer ${token}` } }),
    back.env, spaceId, false,
  );
  back.kv.gets.length = 0;
  const a1 = await ask(scoped);
  assert.equal(a1.refusal, null, "the revert lost a token minted during the straddle");
  assert.equal(a1.entry.space, "one", "and its scope with it");
  assert.equal((await ask(star)).entry.space, "*");
  assert.equal((await ask(scoped, "two")).refusal, "wrong-space");
  assert.ok(back.kv.gets.includes(W.PUBLISH_TOKENS_KEY),
    "the reverted worker still is not asking KV, so the flag is decorative");

  // The object still HOLDS the rows — a revert loses no data — and the other families are
  // untouched.
  assert.ok(back.object.publishTokenList().tokens, "the object's rows went with the flag");
  back.kv.gets.length = 0;
  await back.fire("/__me", { headers: await back.cookieFor(ADMIN) });
  await back.fire("/__people?names=Grace");
  assert.deepEqual(back.kv.gets.filter((k) => k === "users:roster" || k.startsWith(W.LASTSEEN_PREFIX)), [],
    "reverting publish tokens dragged another family back to KV with it");
});

test("REVERTING `roster` restores the KV answer, and touches nothing else", async () => {
  const reverted = await revertedWorker("roster");

  // Changed through the real admin routes while the family WAS cut over, so both stores
  // hold it. After the revert KV is the answer, and it is the same answer.
  const cut = await deployment({ tenants: true });
  const headers = { "Content-Type": "application/json", ...(await cut.cookieFor(ADMIN)) };
  const invited = await cut.fire("/__admin/users", {
    method: "POST", headers,
    body: JSON.stringify({ op: "invite", email: "newcomer@example.test", name: "Newcomer", role: "viewer" }),
  });
  assert.equal(invited.status, 200, await invited.text());
  const demoted = await cut.fire("/__admin/users", {
    method: "POST", headers, body: JSON.stringify({ op: "role", email: GUEST, role: "viewer" }),
  });
  assert.equal(demoted.status, 200, await demoted.text());
  const cutList = JSON.parse(await (await cut.fire("/__admin/users", { headers: await cut.cookieFor(ADMIN) })).text())
    .users.map((u) => `${u.email}/${u.role}`).sort();

  const back = await deployment({
    tenants: true, kv: Object.fromEntries(cut.kv.store), workerModule: reverted,
  });
  back.kv.gets.length = 0;
  const list = JSON.parse(await (await back.fire("/__admin/users", { headers: await back.cookieFor(ADMIN) })).text())
    .users.map((u) => `${u.email}/${u.role}`).sort();
  assert.deepEqual(list, cutList, "the revert lost roster changes made during the straddle");
  assert.ok(back.kv.gets.includes("users:roster") && back.kv.gets.includes("users:roles"),
    "the reverted worker still is not asking KV, so the flag is decorative");

  // ⚠️ NOTHING WAS LOST, and the object's own rows are untouched: `cut` still holds them,
  // and the reverted worker writes neither store's copy of this family but KV's. (That the
  // ROWS survive a revert on ONE workspace is a claim about persistence, which this harness
  // cannot make — each deployment here gets a fresh in-memory database. It is
  // `scripts/tenant-do-rehearsal.mjs` that runs three deployments over one persisted store.)
  assert.ok(cut.object.rosterRead().roster.add["newcomer@example.test"],
    "the straddle never wrote the object at all, so there is nothing to revert FROM");
  const seenByReverted = back.object.rosterRead().roster;
  assert.deepEqual(seenByReverted.add, {},
    "the reverted worker is still writing the object for a family it no longer reads");

  // And the other families did not come back with it.
  const token = await inviteVia(back, GUEST);   // the mint DUAL-WRITES, so it reads KV to update it
  back.kv.gets.length = 0;
  await back.fire(`/__invite?t=${encodeURIComponent(token)}`);
  await back.fire("/__me", { headers: await back.cookieFor(ADMIN) });
  assert.deepEqual(back.kv.gets.filter((k) => k === W.USER_INVITES_KEY || k.startsWith(W.LASTSEEN_PREFIX)), [],
    "reverting the roster dragged another family back to KV with it");
});
