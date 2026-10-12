// test/admin-own-page.test.mjs — every write under /__admin/ answers only the workspace's
// own page. The session cookie is SameSite=Lax and sibling workspaces on one apex are the
// same site to a browser, so the cookie alone lets a page on a neighbour write as the admin
// who opened it. Driven through the router: the guard sits there, ahead of every handler.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/_worker.js";
import { __testables as W } from "../src/_worker.js";

const HOST = "https://acme.example";
const ADMIN = { email: "admin@example.test", name: "Ad", role: "admin" };
const PASSWORD = "correct-horse-battery";
let seq = 0;

async function instance() {
  W.__setTenantTestState({ memo: null });
  W.__setConfigTestState({ cfgAt: 0, cfgGoodAt: 0 });
  const tenantId = `admin-own-page-${++seq}`;
  const m = new Map();
  const kv = {
    map: m,
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => { m.delete(k); },
    list: async () => ({ keys: [], list_complete: true }),
  };
  m.set("users:secrets", JSON.stringify({ [ADMIN.email]: await W.hashPassword(PASSWORD) }));
  const env = {
    COMMENTS: kv,
    ASSETS: {
      fetch: async (req) => {
        const p = new URL(typeof req === "string" ? req : req.url).pathname;
        const json = (o) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
        if (p === "/__config/instance.json") return json({ users: [ADMIN], tenantId });
        if (p === "/__config/routing.json") return json({ spaces: [{ id: "acme", default: true }], publicPrefixes: [] });
        return new Response("nf", { status: 404 });
      },
    },
  };
  return { env, kv, cookie: `__Host-augur_user=${ADMIN.email}.${await W.userToken(env, ADMIN)}` };
}

async function ask(env, path, { method = "POST", headers = {}, body = {} } = {}) {
  const orig = console.log; console.log = () => {};
  try {
    const res = await worker.fetch(new Request(HOST + path, {
      method, headers, ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
    }), env, {});
    let json = null;
    try { json = await res.clone().json(); } catch (e) {}
    return { status: res.status, json };
  } finally { console.log = orig; }
}
const JSON_CT = "application/json";
const WRITES = [
  ["/__admin/tokens", "POST", { space: "acme", label: "x" }],
  ["/__admin/tokens", "DELETE", { hash: "0".repeat(64) }],
  ["/__admin/users", "POST", { op: "invite", email: "new@example.test", role: "admin" }],
  ["/__admin/space-icon", "POST", { space: "acme", icon: "data:image/png;base64,AAAA" }],
  ["/__admin/space-icon", "DELETE", { space: "acme" }],
  ["/__admin/storage", "POST", {}],
  ["/__admin/anything-added-later", "PUT", {}],
];

test("a signed-in admin's browser, asked by another page: every write under /__admin/ is refused and nothing is written", async () => {
  const { env, kv, cookie } = await instance();
  const before = JSON.stringify([...kv.map]);
  for (const [path, method, body] of WRITES) {
    for (const [headers, status, error] of [
      [{ "content-type": JSON_CT, origin: "https://demo.example" }, 403, "cross-origin"],
      [{ "content-type": JSON_CT, origin: "https://acme.example.evil.test" }, 403, "cross-origin"],
      [{ "content-type": JSON_CT, origin: "http://acme.example" }, 403, "cross-origin"],
      [{ "content-type": JSON_CT, origin: "null" }, 403, "cross-origin"],
      [{ "content-type": JSON_CT }, 403, "cross-origin"],
      [{ "content-type": "text/plain", origin: HOST }, 415, "bad-content-type"],
      [{ "content-type": "application/x-www-form-urlencoded", origin: HOST }, 415, "bad-content-type"],
    ]) {
      const r = await ask(env, path, { method, headers: { ...headers, cookie }, body });
      assert.equal(r.status, status, `${method} ${path} ${JSON.stringify(headers)}`);
      assert.equal(r.json.error, error, `${method} ${path}`);
    }
  }
  assert.equal(JSON.stringify([...kv.map]), before, "a refused write wrote something");
});

test("the workspace's own page still writes, and reads ask for nothing new", async () => {
  const { env, kv, cookie } = await instance();
  const own = { "content-type": "application/json; charset=utf-8", origin: HOST, cookie };
  const minted = await ask(env, "/__admin/tokens", { headers: own, body: { space: "acme", label: "x" } });
  assert.equal(minted.status, 200);
  assert.match(minted.json.token, /^[0-9a-f]{64}$/);
  assert.ok(kv.map.get("publish:tokens"), "the token was stored");
  const hash = Object.keys(JSON.parse(kv.map.get("publish:tokens")))[0];
  assert.equal((await ask(env, "/__admin/tokens", { method: "DELETE", headers: own, body: { hash } })).status, 200);
  // A plain GET carries no Origin from a browser's own navigation or same-origin fetch.
  for (const path of ["/__admin/users", "/__admin/tokens", "/__admin/version"]) {
    assert.equal((await ask(env, path, { method: "GET", headers: { cookie } })).status, 200, path);
  }
});

test("the guard is ahead of the session check, so it holds for whoever asks", async () => {
  const { env } = await instance();
  const foreign = await ask(env, "/__admin/users", { headers: { "content-type": JSON_CT, origin: "https://demo.example" } });
  assert.deepEqual([foreign.status, foreign.json.error], [403, "cross-origin"]);
  // From its own page a signed-out caller meets the route's own refusal, as before.
  const own = await ask(env, "/__admin/users", { headers: { "content-type": JSON_CT, origin: HOST } });
  assert.notEqual(own.json && own.json.error, "cross-origin");
  assert.ok(own.status === 401 || own.status === 403 || own.status === 303 || own.status === 302, `signed out got ${own.status}`);
});
