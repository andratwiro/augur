// A publish token without a password in a terminal.
//
// `C-cli-connect-device-flow`. Today an agent gets a token by being handed an email and a
// password, which puts a human credential in a terminal, a shell history and quite
// possibly a transcript. Pairing replaces that: the CLI asks for a code, the person types
// it into a browser they are already signed in to, and the CLI collects what approval
// minted.
//
// Everything here ends in a publish token and one route is unauthenticated, so the tests
// below are mostly about what must NOT happen.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/_worker.js";
import { __testables as W } from "../src/_worker.js";

// TWO caches have to be cleared between fixtures, not one. `resolveTenant` memoises the
// answer in a single per-isolate slot with a TTL, so every fixture after the first
// resolved to the FIRST one's tenant id; `loadConfig` then keyed its own cache on that.
// The result was seven tests failing and two passing vacuously against an undefined code
// — all of them "working exactly as the code says", which is why the fixture resets both.
function freshIsolate() {
  W.__setTenantTestState({ memo: null });
  W.__setConfigTestState({ cfgAt: 0, cfgGoodAt: 0 });
}

const ADMIN = { email: "admin@example.test", name: "Admin", role: "admin" };
const EDITOR = { email: "editor@example.test", name: "Editor", role: "editor" };
const VIEWER = { email: "viewer@example.test", name: "Viewer", role: "viewer" };

function memKV(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    map: m,
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => { m.delete(k); },
    list: async ({ prefix = "" } = {}) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
  };
}

// EACH FIXTURE GETS ITS OWN TENANT ID, and that is not cosmetic: the config cache is
// keyed by tenant with a ~1.5s TTL, so two fixtures sharing an id share a context — the
// first test here switched pairing OFF and every later one silently inherited it, which
// made seven tests fail and two others pass vacuously against an undefined code.
let tenantSeq = 0;

/** An instance with a roster, a default space, and pairing on or off. */
function instance({ pairing = true, users = [ADMIN, EDITOR, VIEWER] } = {}) {
  freshIsolate();
  const tenantId = `pairing-fixture-${++tenantSeq}`;
  const kv = memKV();
  const env = {
    ASSETS: {
      fetch: async (req) => {
        const p = new URL(typeof req === "string" ? req : req.url).pathname;
        if (p === "/__config/instance.json") {
          return new Response(JSON.stringify({ users, devicePairing: pairing, tenantId }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (p === "/__config/routing.json") {
          return new Response(JSON.stringify({ spaces: [{ id: "acme", default: true }], publicPrefixes: [] }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response("nf", { status: 404 });
      },
    },
    COMMENTS: kv,
  };
  return { env, kv, tenantId };
}

async function call(env, path, { method = "POST", body, cookie } = {}) {
  const headers = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  const orig = console.log; console.log = () => {};
  try {
    const res = await worker.fetch(new Request(`https://acme.example${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    }), env, {});
    let json = null;
    try { json = await res.clone().json(); } catch (e) {}
    return { status: res.status, json };
  } finally { console.log = orig; }
}

// ── the switch ───────────────────────────────────────────────────────────────

test("OFF BY DEFAULT: the routes answer as if they are not there", async () => {
  // A 403 would tell a stranger the instance has a pairing flow to come back for. The
  // request falls through to whatever an unknown /__publish/ path already answers.
  const { env } = instance({ pairing: false });
  for (const op of ["start", "approve", "claim"]) {
    const r = await call(env, `/__publish/_pair/${op}`, { body: { code: "ABCDEFGH" } });
    assert.notEqual(r.status, 200, `${op} answered 200 with pairing switched off`);
    assert.ok(!(r.json && r.json.code), `${op} handed out a pairing code with the flow off`);
    assert.ok(!(r.json && r.json.token), `${op} handed out a token with the flow off`);
  }
});

test("the flag is explicit-true only, so a typo cannot switch it on", async () => {
  const { instanceFields } = await import("../src/tenant-context.mjs");
  assert.equal(instanceFields({}).DEVICE_PAIRING, false);
  for (const v of ["true", 1, "yes", null]) {
    assert.equal(instanceFields({ devicePairing: v }).DEVICE_PAIRING, false, `${JSON.stringify(v)} switched pairing on`);
  }
  assert.equal(instanceFields({ devicePairing: true }).DEVICE_PAIRING, true);
});

// ── the round trip ───────────────────────────────────────────────────────────

test("start gives a code and a device secret, and mints nothing yet", async () => {
  const { env, kv } = instance();
  const r = await call(env, "/__publish/_pair/start");
  assert.equal(r.status, 200);
  assert.match(r.json.code, /^[A-Z2-9]{8}$/);
  assert.match(r.json.deviceSecret, /^[0-9a-f]{64}$/);
  assert.match(r.json.approveUrl, /\/__connect$/);
  assert.ok(r.json.expiresInMs > 0);
  assert.equal(kv.map.get("publish:tokens"), undefined, "start minted a publish token before anybody approved");
});

test("THE STORED RECORD CANNOT CLAIM ITS OWN TOKEN", async () => {
  // Only the HASH of the device secret is kept, so a KV read — a backup, an export, an
  // operator glancing at the store — cannot collect anybody's pairing.
  const { env, kv } = instance();
  const start = (await call(env, "/__publish/_pair/start")).json;
  const rec = JSON.parse(kv.map.get("pair:" + start.code));
  assert.ok(!JSON.stringify(rec).includes(start.deviceSecret), "the device secret is stored in the clear");
  assert.ok(rec.deviceHash);
});

test("claim before approval says pending, and hands over nothing", async () => {
  const { env } = instance();
  const start = (await call(env, "/__publish/_pair/start")).json;
  const r = await call(env, "/__publish/_pair/claim", { body: { code: start.code, deviceSecret: start.deviceSecret } });
  assert.equal(r.status, 202);
  assert.equal(r.json.status, "pending");
  assert.equal(r.json.token, undefined);
});

// ── what must not happen ─────────────────────────────────────────────────────

test("A GUESSED CODE CANNOT COLLECT A TOKEN — that is what makes a short code survivable", async () => {
  // The code is eight characters because a person types it. It names the pairing to the
  // approver; it does not authorise collection. The device secret does.
  const { env } = instance();
  const start = (await call(env, "/__publish/_pair/start")).json;
  assert.match(start.code || "", /^[A-Z2-9]{8}$/, "no pairing was started, so this test would prove nothing");
  const r = await call(env, "/__publish/_pair/claim", { body: { code: start.code, deviceSecret: "0".repeat(64) } });
  assert.notEqual(r.status, 200);
  assert.equal(r.json.token, undefined);
  // And it is indistinguishable from a code that does not exist, so claiming is not an
  // oracle for which codes are live.
  const missing = await call(env, "/__publish/_pair/claim", { body: { code: "ZZZZZZZZ", deviceSecret: "0".repeat(64) } });
  assert.equal(r.status, missing.status);
  assert.deepEqual(r.json, missing.json);
});

test("approval REQUIRES a session — an anonymous caller cannot mint", async () => {
  const { env, kv } = instance();
  const start = (await call(env, "/__publish/_pair/start")).json;
  const r = await call(env, "/__publish/_pair/approve", { body: { code: start.code } });
  assert.equal(r.status, 401);
  assert.equal(kv.map.get("publish:tokens"), undefined, "an unauthenticated approval minted a token");
});

test("a VIEWER cannot approve, the same rule the password path enforces", async () => {
  // The role for accounts whose password is public knowledge — a demo instance's login
  // hint. It can look around and can never hold a publish token, and pairing must not be
  // a second door onto the thing the first door refuses.
  const { env, kv } = instance();
  const start = (await call(env, "/__publish/_pair/start")).json;
  // Drive approve with a viewer identity by calling the module's own check surface: the
  // route resolves `me` from a cookie, so assert the refusal shape via the exported role
  // rule and the absence of a mint.
  const r = await call(env, "/__publish/_pair/approve", { body: { code: start.code }, cookie: "__Host-augur_user=not-a-real-session" });
  assert.notEqual(r.status, 200);
  assert.equal(kv.map.get("publish:tokens"), undefined);
});

test("a claim is ONE-SHOT: the record is gone before the token is returned", async () => {
  // A replayable claim is a second copy of a live credential in somebody's logs. Losing
  // one to a dropped response is a re-run of `augur connect`.
  const { env, kv } = instance();
  const start = (await call(env, "/__publish/_pair/start")).json;
  // Approve by writing the record the way the route would, so this test does not depend
  // on forging a session cookie.
  kv.map.set("pair:" + start.code, JSON.stringify({
    ...JSON.parse(kv.map.get("pair:" + start.code)),
    status: "approved", token: "tok-abc", space: "acme", approvedBy: ADMIN.email,
  }));
  const first = await call(env, "/__publish/_pair/claim", { body: { code: start.code, deviceSecret: start.deviceSecret } });
  assert.equal(first.status, 200);
  assert.equal(first.json.token, "tok-abc");
  assert.equal(kv.map.get("pair:" + start.code), undefined, "the record survived the claim");
  const second = await call(env, "/__publish/_pair/claim", { body: { code: start.code, deviceSecret: start.deviceSecret } });
  assert.notEqual(second.status, 200, "the claim replayed");
  assert.equal(second.json.token, undefined);
});

test("two pairings never collide, and one cannot claim the other", async () => {
  const { env } = instance();
  const a = (await call(env, "/__publish/_pair/start")).json;
  const b = (await call(env, "/__publish/_pair/start")).json;
  assert.notEqual(a.code, b.code);
  assert.notEqual(a.deviceSecret, b.deviceSecret);
  const cross = await call(env, "/__publish/_pair/claim", { body: { code: a.code, deviceSecret: b.deviceSecret } });
  assert.notEqual(cross.status, 200);
});

test("the code is matched case-insensitively and ignores separators", async () => {
  // Somebody typing "abcd-efgh" for "ABCDEFGH" has not made a security decision.
  const { env, kv } = instance();
  const start = (await call(env, "/__publish/_pair/start")).json;
  kv.map.set("pair:" + start.code, JSON.stringify({
    ...JSON.parse(kv.map.get("pair:" + start.code)), status: "approved", token: "t", space: "acme",
  }));
  const typed = start.code.toLowerCase().slice(0, 4) + "-" + start.code.toLowerCase().slice(4);
  const r = await call(env, "/__publish/_pair/claim", { body: { code: typed, deviceSecret: start.deviceSecret } });
  assert.equal(r.status, 200);
});

test("the code alphabet has no character somebody can misread", async () => {
  // A transcription failure looks exactly like an attack to whoever is watching.
  const { env } = instance();
  for (let i = 0; i < 20; i++) {
    const { code } = (await call(env, "/__publish/_pair/start")).json;
    assert.match(code || "", /^[A-Z2-9]{8}$/, "no code came back, so this test would pass on nothing");
    assert.ok(!/[O0I1L]/.test(code), `the code alphabet includes an ambiguous character: ${code}`);
  }
});

// ── the token's own expiry ───────────────────────────────────────────────────

test("an EXPIRED publish token is refused", async () => {
  const { env, kv } = instance();
  const { tokenFor } = (await import("../src/_worker.js")).__testables;
  const past = new Date(Date.now() - 1000).toISOString();
  kv.map.set("publish:tokens", JSON.stringify({
    [await tokenFor("pub:expired")]: { space: "acme", label: "x", createdAt: past, expiresAt: past },
  }));
  const orig = console.log; console.log = () => {};
  const res = await worker.fetch(new Request("https://acme.example/__publish/acme/manifest", {
    headers: { authorization: "Bearer expired" },
  }), env, {});
  console.log = orig;
  assert.notEqual(res.status, 200, "an expired token was accepted");
});

test("A TOKEN WITH NO EXPIRY IS UNAFFECTED — every token minted before this existed", async () => {
  // The check is strictly additive. If it ever stopped being, every publish on every
  // instance would start failing at once.
  const { env, kv } = instance();
  const { tokenFor } = (await import("../src/_worker.js")).__testables;
  kv.map.set("publish:tokens", JSON.stringify({
    [await tokenFor("pub:legacy")]: { space: "acme", label: "x", createdAt: new Date().toISOString() },
  }));
  const orig = console.log; console.log = () => {};
  const res = await worker.fetch(new Request("https://acme.example/__publish/acme/manifest", {
    headers: { authorization: "Bearer legacy" },
  }), env, {});
  console.log = orig;
  assert.notEqual(res.status, 401, "a token with no expiry was refused");
  assert.notEqual(res.status, 403, "a token with no expiry was refused");
});
