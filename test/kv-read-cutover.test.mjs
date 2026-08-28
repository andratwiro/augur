// The reads move onto the workspace object, one family at a time — and each move is
// reversible on its own.
//
// `B-kv-read-cutover`. `B-kv-to-do-migration-tool` left the object holding a COPY that
// nothing read. This is the half that makes the object the thing the instance answers
// from. Two families have moved: `users:invites` and `users:lastseen:`. The rest — the
// roster documents behind `rosterFields`, and the publish-token map — have not, and the
// header of `KV_CUTOVER` in src/_worker.js says which and why.
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
  // number straight over, so the table held `"1788484474092"` where `Date.parse` answers
  // `NaN`. Nothing read the table, so nothing noticed. `identityFromKv` now converts — and
  // `stampMs` still accepts the number, or every row an earlier copy wrote would have gone
  // dead on the day the reads moved. That accommodation is what this pins.
  const d = await deployment({ tenants: true });
  const token = "a-token-an-older-copy-carried";
  d.object.importAll({
    overlay: {},
    identity: {
      invites: [{
        tokenHash: await W.inviteHash(token),
        email: GUEST,
        createdAt: String(Date.now() - 1000),
        expiresAt: String(Date.now() + 60_000),   // epoch ms, as the old copy wrote it
      }],
    },
  });
  assert.equal(Number.isFinite(Date.parse(String(Date.now() + 60_000))), false,
    "the fixture is not actually the broken shape, so this proves nothing");

  const res = await d.fire(`/__invite?t=${encodeURIComponent(token)}`);
  assert.equal(res.status, 200, "a row an earlier copy wrote reads as invalid");
  assert.match(await res.text(), new RegExp(GUEST.replace(".", "\\.")));
});

test("an expired row is still expired — the tolerant read did not make expiry optional", async () => {
  const d = await deployment({ tenants: true });
  const token = "a-token-that-has-run-out";
  d.object.importAll({
    overlay: {},
    identity: [{}] && {
      invites: [{
        tokenHash: await W.inviteHash(token),
        email: GUEST,
        createdAt: new Date(Date.now() - 90_000).toISOString(),
        expiresAt: String(Date.now() - 60_000),
      }],
    },
  });
  const res = await d.fire(`/__invite?t=${encodeURIComponent(token)}`);
  assert.equal(res.status, 400);
});

// ═══ THE FAMILIES THAT DID NOT MOVE ══════════════════════════════════════════════════

test("a publish token minted before the cut still publishes after it", async () => {
  // `publish:tokens` has NOT been cut — see the finding recorded in KV_CUTOVER's header —
  // so this is the regression check that moving its neighbours left it alone. Minted on a
  // deployment with no object, presented to one with an object bound.
  const before = await deployment({ tenants: false });
  const res = await before.fire("/__admin/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await before.cookieFor(ADMIN)) },
    body: JSON.stringify({ space: "one", label: "backup" }),
  });
  const minted = await res.text();
  assert.equal(res.status, 200, minted);
  const token = JSON.parse(minted).token;
  assert.ok(token, "the fixture minted no token");

  const after = await deployment({ tenants: true, kv: Object.fromEntries(before.kv.store) });
  const auth = await W.publishAuthDetailed(
    { tenantId: after.id, USERS: ROSTER },
    new Request(`${ORIGIN}/__publish/one/check`, { headers: { Authorization: `Bearer ${token}` } }),
    after.env, "one", false,
  );
  assert.equal(auth.refusal, null, `a token minted before the cut stopped publishing: ${auth.refusal}`);
  assert.equal(auth.entry.space, "one", "the token's SCOPE did not survive");
});

test("the roster still answers from KV — this item did not move it, and says so", async () => {
  // Named rather than left implicit. `rosterFields` still spends its six KV reads per tick;
  // KV_CUTOVER carries no `roster` key, and a day when it does is a day this assertion
  // fails and somebody reads the header.
  assert.deepEqual(Object.keys(W.KV_CUTOVER).sort(), ["invites", "lastseen"]);
  assert.equal(Object.isFrozen(W.KV_CUTOVER), true);
  const d = await deployment({ tenants: true });
  d.kv.gets.length = 0;
  await d.fire("/__people?names=Grace");
  assert.ok(d.kv.gets.includes("users:roster"), "the roster stopped reading KV without being cut over");
});

// ═══ THE READ VOLUME, MEASURED ═══════════════════════════════════════════════════════

test("on the cut-over path these families read KV zero times", async () => {
  // The read volume is why this is urgent, so it is a number and not a claim. Both
  // directions: the object path must not touch these KV keys, and the KV path must — or
  // the measurement is of a route that reads nothing either way.
  const touched = (d, ...prefixes) =>
    d.kv.gets.filter((k) => prefixes.some((p) => k === p || k.startsWith(p)));

  const on = await deployment({ tenants: true });
  const token = await inviteVia(on, GUEST);
  on.kv.gets.length = 0;
  await on.fire(`/__invite?t=${encodeURIComponent(token)}`);
  await on.fire("/__me", { headers: await on.cookieFor(ADMIN) });
  await on.fire("/__admin/users", { headers: await on.cookieFor(ADMIN) });
  assert.deepEqual(touched(on, W.USER_INVITES_KEY, W.LASTSEEN_PREFIX), [],
    "the object path is still reading KV for a family it has taken over");

  const off = await deployment({ tenants: false });
  const token2 = await inviteVia(off, GUEST);
  off.kv.gets.length = 0;
  await off.fire(`/__invite?t=${encodeURIComponent(token2)}`);
  await off.fire("/__me", { headers: await off.cookieFor(ADMIN) });
  await off.fire("/__admin/users", { headers: await off.cookieFor(ADMIN) });
  assert.ok(touched(off, W.USER_INVITES_KEY, W.LASTSEEN_PREFIX).length > 0,
    "the KV path reads none of these either, so the zero above measures nothing");
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

test("REVERTING ONE FAMILY restores the KV answer, and touches nothing else", async () => {
  // ⚠️ RUN, NOT READ. The revert is one word in `KV_CUTOVER`, so this makes the edit —
  // `invites: true` → `invites: false` — in a copy of the worker, loads that copy, and
  // drives the same routes through it. A test that asserted about the diff would pass
  // against a flag nothing consults.
  const src = fileURLToPath(new URL("../src/_worker.js", import.meta.url));
  const text = fs.readFileSync(src, "utf8");
  assert.equal(text.split("\n  invites: true,").length, 2, "the flag this revert edits has moved");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "augur-cutover-revert-"));
  let reverted;
  try {
    // Every sibling module is SYMLINKED rather than copied, so the reverted worker runs
    // against the same tenant-do.js and the same everything else. One file differs.
    for (const entry of fs.readdirSync(path.dirname(src))) {
      if (entry === "_worker.js") continue;
      fs.symlinkSync(path.join(path.dirname(src), entry), path.join(dir, entry));
    }
    fs.writeFileSync(path.join(dir, "_worker.js"), text.replace("\n  invites: true,", "\n  invites: false,"));
    reverted = await import(pathToFileURL(path.join(dir, "_worker.js")).href);
  } finally {
    // Left on disk only for as long as the import needs it.
    setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} }, 0).unref?.();
  }
  assert.deepEqual(Object.keys(reverted.__testables.KV_CUTOVER).sort(), ["invites", "lastseen"]);
  assert.equal(reverted.__testables.KV_CUTOVER.invites, false, "the edit did not take");
  assert.equal(reverted.__testables.KV_CUTOVER.lastseen, true, "the revert reached a family it was not for");

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

  // The OTHER family is untouched by the revert: still answering off the object, and still
  // not reading its KV keys.
  back.kv.gets.length = 0;
  await back.fire("/__me", { headers: await back.cookieFor(ADMIN) });
  await back.fire("/__admin/users", { headers: await back.cookieFor(ADMIN) });
  assert.deepEqual(back.kv.gets.filter((k) => k.startsWith(W.LASTSEEN_PREFIX)), [],
    "reverting invites dragged lastseen back to KV with it");
});
