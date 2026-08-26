// A viewer can never come away with a publish token, by either door.
//
// `C-viewer-no-publish-token`. The viewer role exists for accounts whose password is
// PUBLIC KNOWLEDGE — a demo instance prints its own credentials on its login form. Such an
// account may look around, comment and drive a board, and must never be able to overwrite
// what is published.
//
// There are two doors that end in a token: the self-serve exchange (`augur login`, an
// email and a password) and device pairing (`augur connect`, a browser session approving a
// code). Both existed before this test and both already refused; what was missing was
// anything that would notice if one of them stopped. A rule enforced in two places and
// checked in neither is a rule with a half-life.
//
// Anonymous share-link viewing needs no check of its own by construction: it is
// browser-only and issues no CLI credential at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/_worker.js";
import { __testables as W } from "../src/_worker.js";
import { readFileSync } from "node:fs";

const ADMIN = { email: "admin@example.test", name: "Ad", role: "admin" };
const EDITOR = { email: "editor@example.test", name: "Ed", role: "editor" };
const VIEWER = { email: "viewer@example.test", name: "Vi", role: "viewer" };
const ROSTER = [ADMIN, EDITOR, VIEWER];
const PASSWORD = "correct-horse-battery";

let seq = 0;

/** An instance whose roster all share one password, so role is the only variable. */
async function instance({ pairing = true } = {}) {
  // Both caches are per-isolate with a TTL: resolveTenant memoises its answer and
  // loadConfig keys on it, so fixtures that share a tenant id share a context.
  W.__setTenantTestState({ memo: null });
  W.__setConfigTestState({ cfgAt: 0, cfgGoodAt: 0 });
  const tenantId = `viewer-token-${++seq}`;
  const m = new Map();
  const kv = {
    map: m,
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => { m.delete(k); },
    list: async () => ({ keys: [], list_complete: true }),
  };
  // One real hash, so every role authenticates identically and only the ROLE differs.
  const hash = await W.hashPassword(PASSWORD);
  m.set("users:secrets", JSON.stringify(Object.fromEntries(ROSTER.map((u) => [u.email, hash]))));
  const env = {
    COMMENTS: kv,
    // `publishApi` refuses outright without a BUNDLES BINDING, and `_login/token` lives
    // under it — so a fixture lacking one measures "the API is off", not "the role was
    // refused". But do NOT set GV_ASSET_SOURCE with it: that switches the instance into
    // bundle mode, where config comes from the STORE and this ASSETS stub is ignored,
    // which loads an empty roster and turns every role check into "no such user".
    BUNDLES: { get: async () => null, put: async () => {}, list: async () => ({ objects: [], truncated: false }) },
    ASSETS: {
      fetch: async (req) => {
        const p = new URL(typeof req === "string" ? req : req.url).pathname;
        if (p === "/__config/instance.json") {
          return new Response(JSON.stringify({ users: ROSTER, devicePairing: pairing, tenantId }),
            { headers: { "content-type": "application/json" } });
        }
        if (p === "/__config/routing.json") {
          return new Response(JSON.stringify({ spaces: [{ id: "acme", default: true }], publicPrefixes: [] }),
            { headers: { "content-type": "application/json" } });
        }
        return new Response("nf", { status: 404 });
      },
    },
  };
  return { env, kv };
}

async function call(env, path, { body, cookie } = {}) {
  const headers = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  const orig = console.log; console.log = () => {};
  try {
    const res = await worker.fetch(new Request(`https://acme.example${path}`, {
      method: "POST", headers, body: JSON.stringify(body || {}),
    }), env, {});
    let json = null;
    try { json = await res.clone().json(); } catch (e) {}
    return { status: res.status, json };
  } finally { console.log = orig; }
}

const session = async (env, u) => `__Host-augur_user=${u.email}.${await W.userToken(env, u)}`;

// ── door one: the password exchange (`augur login`) ──────────────────────────

test("a VIEWER is refused the self-serve token exchange", async () => {
  const { env, kv } = await instance();
  const r = await call(env, "/__publish/_login/token", { body: { email: VIEWER.email, password: PASSWORD } });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, "viewer-role");
  assert.match(r.json.message, /look around/, "the refusal does not say what the account CAN do");
  assert.equal(r.json.token, undefined);
  assert.equal(kv.map.get("publish:tokens"), undefined, "a token was written despite the refusal");
});

test("an EDITOR and an ADMIN still get one, with the scope their role earns", async () => {
  // A guard that refuses everybody is not a guard, it is an outage.
  for (const [u, scope] of [[EDITOR, "acme"], [ADMIN, "*"]]) {
    const { env } = await instance();
    const r = await call(env, "/__publish/_login/token", { body: { email: u.email, password: PASSWORD } });
    assert.equal(r.status, 200, `${u.role} was refused a token`);
    assert.match(r.json.token, /^[0-9a-f]{64}$/);
    assert.equal(r.json.space, scope, `${u.role} got scope ${r.json.space}`);
  }
});

test("the viewer refusal comes AFTER the credential check, so it is not an oracle", async () => {
  // Telling a stranger "that address is a viewer" before verifying the password would
  // answer a question they had no right to ask. A wrong password on a viewer must look
  // like a wrong password on anybody.
  const { env } = await instance();
  const wrong = await call(env, "/__publish/_login/token", { body: { email: VIEWER.email, password: "nope" } });
  const unknown = await call(env, "/__publish/_login/token", { body: { email: "nobody@example.test", password: "nope" } });
  assert.equal(wrong.status, unknown.status);
  assert.equal(wrong.json.error, unknown.json.error);
  assert.notEqual(wrong.json.error, "viewer-role", "a wrong password revealed the account's role");
});

// ── door two: device pairing (`augur connect`) ───────────────────────────────

test("a VIEWER cannot approve a pairing, so the second door refuses too", async () => {
  const { env, kv } = await instance();
  const start = (await call(env, "/__publish/_pair/start")).json;
  assert.match(start.code || "", /^[A-Z2-9]{8}$/, "no pairing started, so this would prove nothing");
  const r = await call(env, "/__publish/_pair/approve", {
    body: { code: start.code }, cookie: await session(env, VIEWER),
  });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, "viewer-role");
  assert.equal(kv.map.get("publish:tokens"), undefined, "approval by a viewer minted a token");
  // And nothing is waiting for the terminal either.
  const claim = await call(env, "/__publish/_pair/claim", { body: { code: start.code, deviceSecret: start.deviceSecret } });
  assert.equal(claim.status, 202, "a viewer's refused approval still left something to claim");
});

test("an EDITOR and an ADMIN can approve, with the scope their role earns", async () => {
  for (const [u, scope] of [[EDITOR, "acme"], [ADMIN, "*"]]) {
    const { env } = await instance();
    const start = (await call(env, "/__publish/_pair/start")).json;
    const r = await call(env, "/__publish/_pair/approve", {
      body: { code: start.code }, cookie: await session(env, u),
    });
    assert.equal(r.status, 200, `${u.role} could not approve a pairing`);
    assert.equal(r.json.space, scope);
    const claim = await call(env, "/__publish/_pair/claim", { body: { code: start.code, deviceSecret: start.deviceSecret } });
    assert.equal(claim.status, 200);
    assert.match(claim.json.token, /^[0-9a-f]{64}$/);
  }
});

// ── the rule itself ──────────────────────────────────────────────────────────

test("the THIRD door — the admin token page — refuses a viewer as well", async () => {
  // Not in this item's scope, because it is admin-only by construction rather than by a
  // role check on the requester's behalf. Asserted anyway: it is the only other route that
  // writes the token map, and "admin-only by construction" is exactly the kind of claim
  // that is true right up until somebody relaxes a gate for an unrelated reason.
  const { env } = await instance();
  for (const u of [VIEWER, EDITOR]) {
    const orig = console.log; console.log = () => {};
    const res = await worker.fetch(new Request("https://acme.example/__admin/tokens", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await session(env, u) },
      body: JSON.stringify({ space: "acme", label: "x" }),
    }), env, {});
    console.log = orig;
    assert.equal(res.status, 403, `${u.role} could reach the admin token page`);
  }
});

// A NOTE ON WHAT IS NOT TESTED HERE, because the attempt is instructive. A source scan for
// "every place that writes the token map has a viewer check above it" looks like the right
// guard against somebody adding a FOURTH door, and it is not: five call sites write that
// map and three of them are REVOCATIONS, which correctly have no role check. Telling mint
// from revoke needs a parser, not a regex, and a guard that fires on correct code is a
// guard somebody deletes. The three doors are covered behaviourally above instead.
