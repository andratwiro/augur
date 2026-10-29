// test/vouch.test.mjs — POST /__vouch: the workspace vouches for its signed-in member to a
// framed app on another origin, with an Ed25519 ticket only the declared audience accepts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
const ipDigest = (ip) => createHash("sha256").update("augur-vouch-ip:" + ip).digest();
import worker from "../src/_worker.js";
import { __testables as W } from "../src/_worker.js";
import { verifyVouch, vouchKey, clientIpClaim, VOUCH_TTL_S } from "../src/vouch.mjs";

const HOST = "https://acme.example";
const AUD = "https://lab.example.net";
const VIEWER = { email: "viewer@example.test", name: "Vi", role: "viewer" };
let seq = 0;

async function newKey() {
  const k = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const { kty, crv, d, x } = await crypto.subtle.exportKey("jwk", k.privateKey);
  return { kty, crv, d, x };
}

const SESSION_SECRET = "vouch-test-session-secret";
const cookieFor = async (env, u) => `__Host-augur_user=${u.email}.${await W.userToken(env, u)}`;

// `roster` is who this workspace's config lists; `secrets` who holds a password hash in its
// store (a removed member keeps one until something sweeps it).
async function instance(vouchKeys, { roster = [VIEWER], secrets = [VIEWER] } = {}) {
  W.__setTenantTestState({ memo: null });
  W.__setConfigTestState({ cfgAt: 0, cfgGoodAt: 0 });
  const tenantId = `vouch-${++seq}`;
  const m = new Map();
  const kv = {
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => { m.delete(k); },
    list: async () => ({ keys: [], list_complete: true }),
  };
  const hashes = {};
  for (const u of secrets) hashes[u.email] = await W.hashPassword("correct-horse-battery");
  m.set("users:secrets", JSON.stringify(hashes));
  const env = {
    COMMENTS: kv,
    SESSION_SECRET,
    ...(vouchKeys === undefined ? {} : { VOUCH_KEYS: JSON.stringify(vouchKeys) }),
    ASSETS: {
      fetch: async (req) => {
        const p = new URL(typeof req === "string" ? req : req.url).pathname;
        const json = (o) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
        if (p === "/__config/instance.json") return json({ users: roster, tenantId });
        if (p === "/__config/routing.json") return json({ spaces: [{ id: "acme", default: true }], publicPrefixes: [] });
        return new Response("nf", { status: 404 });
      },
    },
  };
  return { env, cookie: await cookieFor(env, VIEWER) };
}

const IP = "203.0.113.7";
const OWN = { origin: HOST, "sec-fetch-site": "same-origin", "content-type": "application/json", "cf-connecting-ip": IP };
async function ask(env, path, { method = "POST", headers = {}, body } = {}) {
  const orig = console.log; console.log = () => {};
  try {
    const res = await worker.fetch(new Request(HOST + path, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env, {});
    let json = null;
    try { json = await res.clone().json(); } catch (e) {}
    return { status: res.status, json, cache: res.headers.get("cache-control") };
  } finally { console.log = orig; }
}

test("a signed-in member on the workspace's own page gets a ticket the audience's public key verifies", async () => {
  const key = await newKey();
  const { env, cookie } = await instance({ [HOST]: { [AUD]: key } });
  const r = await ask(env, "/__vouch", { headers: { ...OWN, cookie }, body: { aud: AUD } });
  assert.equal(r.status, 200);
  assert.equal(r.cache, "no-store");
  const c = await verifyVouch(key.x, r.json.ticket, { iss: HOST, aud: AUD, ip: IP });
  assert.ok(c, "ticket did not verify");
  assert.deepEqual([c.v, c.iss, c.aud, c.sub, c.role, c.exp - c.iat], [1, HOST, AUD, VIEWER.email, "viewer", VOUCH_TTL_S]);
  assert.equal(c.cip, await clientIpClaim(IP));
  assert.match(c.jti, /^[A-Za-z0-9_-]{22}$/);
  // Dead after its minute, for another audience, another issuer, or another key.
  assert.equal(await verifyVouch(key.x, r.json.ticket, { iss: HOST, aud: AUD, ip: IP }, (c.exp + 1) * 1000), null);
  assert.equal(await verifyVouch(key.x, r.json.ticket, { iss: HOST, aud: "https://other.example", ip: IP }), null);
  assert.equal(await verifyVouch(key.x, r.json.ticket, { iss: "https://demo.example", aud: AUD, ip: IP }), null);
  assert.equal(await verifyVouch((await newKey()).x, r.json.ticket, { iss: HOST, aud: AUD, ip: IP }), null);
  // A rewritten payload fails the signature.
  const [p, s] = r.json.ticket.split(".");
  const forged = Buffer.from(JSON.stringify({ ...c, role: "admin" })).toString("base64url");
  assert.notEqual(forged, p);
  assert.equal(await verifyVouch(key.x, `${forged}.${s}`, { iss: HOST, aud: AUD, ip: IP }), null);
  // Two mints never share a jti.
  const r2 = await ask(env, "/__vouch", { headers: { ...OWN, cookie }, body: { aud: AUD } });
  const c2 = await verifyVouch(key.x, r2.json.ticket, { iss: HOST, aud: AUD, ip: IP });
  assert.notEqual(c2.jti, c.jti);
});

test("signed out: 401, and no ticket", async () => {
  const { env } = await instance({ [HOST]: { [AUD]: await newKey() } });
  const r = await ask(env, "/__vouch", { headers: OWN, body: { aud: AUD } });
  assert.deepEqual([r.status, r.json && r.json.error, r.json && r.json.ticket], [401, "signed-out", undefined]);
});

test("only audiences the deployment declared for THIS workspace: 403 otherwise, and a raw engine declares none", async () => {
  const key = await newKey();
  for (const keys of [undefined, {}, { "https://demo.example": { [AUD]: key } }, { [HOST]: { "https://other.example": key } },
    { [HOST]: { [AUD]: { ...key, d: "short" } } }, { [HOST]: { [AUD]: { ...key, crv: "P-256" } } }]) {
    const { env, cookie } = await instance(keys);
    const r = await ask(env, "/__vouch", { headers: { ...OWN, cookie }, body: { aud: AUD } });
    assert.deepEqual([r.status, r.json && r.json.error], [403, "aud-not-declared"], JSON.stringify(keys && Object.keys(keys)));
  }
  const { env, cookie } = await instance({ [HOST]: { [AUD]: key } });
  for (const aud of [AUD + "/", AUD + "/x", "http://lab.example.net", "lab.example.net", 7, null]) {
    const r = await ask(env, "/__vouch", { headers: { ...OWN, cookie }, body: { aud } });
    assert.equal(r.status, 400, String(aud));
  }
});

test("only the workspace's own page may ask: other origins, cross-site fetch metadata, forms and GETs are refused", async () => {
  const { env, cookie } = await instance({ [HOST]: { [AUD]: await newKey() } });
  const cases = [
    [{ ...OWN, origin: "https://demo.example" }, 403],
    [{ ...OWN, origin: AUD }, 403],
    [{ ...OWN, origin: "null" }, 403],
    [{ ...OWN, "sec-fetch-site": "same-site" }, 403],
    [{ ...OWN, "sec-fetch-site": "cross-site" }, 403],
    [{ origin: HOST, "content-type": "application/json" }, 403],
    [{ ...OWN, "content-type": "text/plain" }, 415],
  ];
  for (const [headers, status] of cases) {
    const r = await ask(env, "/__vouch", { headers: { ...headers, cookie }, body: { aud: AUD } });
    assert.equal(r.status, status, JSON.stringify(headers));
    assert.equal(r.json && r.json.ticket, undefined);
  }
  const g = await ask(env, "/__vouch", { method: "GET", headers: { ...OWN, cookie } });
  assert.equal(g.status, 405);
});

test("GET /__vouch/key serves only the public half, to anyone, and 404s an undeclared audience", async () => {
  const key = await newKey();
  const { env } = await instance({ [HOST]: { [AUD]: key } });
  const r = await ask(env, `/__vouch/key?aud=${encodeURIComponent(AUD)}`, { method: "GET" });
  assert.deepEqual(r.json, { iss: HOST, aud: AUD, alg: "Ed25519", x: key.x });
  assert.ok(!JSON.stringify(r.json).includes(key.d));
  const miss = await ask(env, `/__vouch/key?aud=${encodeURIComponent("https://other.example")}`, { method: "GET" });
  assert.equal(miss.status, 404);
  assert.equal(vouchKey({}, HOST, AUD), null);
});

test("one member past 30 mints a minute is refused 429, and the mint log carries the jti but never the ticket or email", async () => {
  const key = await newKey();
  const { env, cookie } = await instance({ [HOST]: { [AUD]: key } });
  const lines = [];
  const orig = console.log;
  let last;
  for (let i = 0; i < 31; i++) {
    console.log = (l) => lines.push(String(l));
    try {
      last = await worker.fetch(new Request(HOST + "/__vouch", { method: "POST",
        headers: { ...OWN, cookie }, body: JSON.stringify({ aud: AUD }) }), env, {});
    } finally { console.log = orig; }
    if (i === 0) {
      const { ticket } = await last.clone().json();
      const minted = lines.filter((l) => l.includes('"vouch-minted"'));
      assert.equal(minted.length, 1);
      const c = await verifyVouch(key.x, ticket, { iss: HOST, aud: AUD, ip: IP });
      assert.ok(minted[0].includes(c.jti));
      assert.ok(!minted[0].includes(ticket.split(".")[1]) && !minted[0].includes(VIEWER.email));
    }
  }
  // The window is the wall-clock minute: a run that straddles it may need up to 30 more.
  for (let i = 0; i < 31 && last.status === 200; i++) {
    console.log = (l) => lines.push(String(l));
    try { last = await worker.fetch(new Request(HOST + "/__vouch", { method: "POST", headers: { ...OWN, cookie }, body: JSON.stringify({ aud: AUD }) }), env, {}); }
    finally { console.log = orig; }
  }
  assert.equal(last.status, 429);
  assert.ok(lines.some((l) => l.includes('"vouch-rate-limited"')));
});

test("a declared key whose halves do not pair answers 503 and logs no key; bad JSON is 400", async () => {
  const a = await newKey(), b = await newKey();
  const { env, cookie } = await instance({ [HOST]: { [AUD]: { ...a, x: b.x } } });
  const lines = [];
  const orig = console.log;
  console.log = (l) => lines.push(String(l));
  let res;
  try {
    res = await worker.fetch(new Request(HOST + "/__vouch", { method: "POST",
      headers: { ...OWN, cookie }, body: JSON.stringify({ aud: AUD }) }), env, {});
  } finally { console.log = orig; }
  assert.equal(res.status, 503);
  assert.ok(lines.some((l) => l.includes('"vouch-key-invalid"')));
  assert.ok(!lines.join("\n").includes(a.d));
  const bad = await worker.fetch(new Request(HOST + "/__vouch", { method: "POST",
    headers: { ...OWN, cookie }, body: "{nope" }), env, {});
  assert.equal(bad.status, 400);
});

test("membership is THIS workspace's roster: a removed member's and another workspace's well-formed cookies get 401, and so does a bearer token", async () => {
  const key = await newKey();
  const keys = { [HOST]: { [AUD]: key } };
  const REMOVED = { email: "removed@example.test", name: "Re", role: "admin" };
  const OTHER = { email: "other@example.test", name: "Ot", role: "admin" };
  // The removed member still has a password hash here, so their cookie is exactly the one
  // they held while listed; only the roster has changed.
  const { env, cookie } = await instance(keys, { roster: [VIEWER], secrets: [VIEWER, REMOVED] });
  const removedCookie = await cookieFor(env, REMOVED);
  // A member of a neighbour workspace on the same deployment (same SESSION_SECRET).
  const other = await instance(keys, { roster: [OTHER], secrets: [OTHER] });
  const otherCookie = await cookieFor(other.env, OTHER);
  const okThere = await ask(other.env, "/__me", { method: "GET", headers: { cookie: otherCookie } });
  assert.equal(okThere.json.user && okThere.json.user.email, OTHER.email, "control: the neighbour's cookie is good at home");
  // A static-branch isolate serves one workspace: forget the neighbour before asking here.
  W.__setTenantTestState({ memo: null });
  W.__setConfigTestState({ cfgAt: 0, cfgGoodAt: 0 });
  // Control: the same construction for a listed member mints.
  const ok = await ask(env, "/__vouch", { headers: { ...OWN, cookie }, body: { aud: AUD } });
  assert.equal(ok.status, 200);
  const cases = [
    ["removed member", { cookie: removedCookie }],
    ["another workspace's member", { cookie: otherCookie }],
    ["bearer, no cookie", { authorization: "Bearer augur_pub_0123456789abcdef0123456789abcdef" }],
    ["no credential", {}],
  ];
  for (const [name, h] of cases) {
    const r = await ask(env, "/__vouch", { headers: { ...OWN, ...h }, body: { aud: AUD } });
    assert.deepEqual([r.status, r.json && r.json.error, r.json && r.json.ticket], [401, "signed-out", undefined], name);
  }
});

test("a ticket is bound to the IP that minted it: same IP verifies, another IP or none is refused, and no CF-Connecting-IP mints nothing", async () => {
  const key = await newKey();
  const { env, cookie } = await instance({ [HOST]: { [AUD]: key } });
  const r = await ask(env, "/__vouch", { headers: { ...OWN, cookie }, body: { aud: AUD } });
  assert.equal(r.status, 200);
  assert.ok(await verifyVouch(key.x, r.json.ticket, { iss: HOST, aud: AUD, ip: IP }));
  for (const ip of ["203.0.113.8", "2001:db8::7", "", undefined, IP + " "]) {
    assert.equal(await verifyVouch(key.x, r.json.ticket, { iss: HOST, aud: AUD, ip }), null, String(ip));
  }
  const { "cf-connecting-ip": _, ...noIp } = OWN;
  const n = await ask(env, "/__vouch", { headers: { ...noIp, cookie }, body: { aud: AUD } });
  assert.deepEqual([n.status, n.json && n.json.error, n.json && n.json.ticket], [400, "no-client-ip", undefined]);
  // Fixed vector, so a receiver's port can check its hash: SHA-256("augur-vouch-ip:203.0.113.7").
  assert.equal(await clientIpClaim(IP), Buffer.from(ipDigest(IP)).toString("base64url"));
});
