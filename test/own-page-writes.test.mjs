// test/own-page-writes.test.mjs — the signed-in writes outside /__admin/ answer only the
// workspace's own page, for the same reason /__admin/ does (test/admin-own-page.test.mjs):
// the session cookie is SameSite=Lax and a sibling workspace is the same site. Here the
// Origin alone decides: not every caller sends a JSON body.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/_worker.js";
import { __testables as W } from "../src/_worker.js";

const HOST = "https://acme.example";
const ADMIN = { email: "admin@example.test", name: "Ad", role: "admin" };
let seq = 0;

async function instance() {
  W.__setTenantTestState({ memo: null });
  W.__setConfigTestState({ cfgAt: 0, cfgGoodAt: 0 });
  const tenantId = `own-page-writes-${++seq}`;
  const m = new Map();
  const kv = {
    map: m,
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => { m.delete(k); },
    list: async () => ({ keys: [], list_complete: true }),
  };
  m.set("users:secrets", JSON.stringify({ [ADMIN.email]: await W.hashPassword("correct-horse-battery") }));
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

async function ask(env, path, { method = "POST", headers = {}, body } = {}) {
  const orig = console.log; console.log = () => {};
  try {
    const res = await worker.fetch(new Request(HOST + path, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env, {});
    let json = null;
    try { json = await res.clone().json(); } catch (e) {}
    return { status: res.status, json };
  } finally { console.log = orig; }
}
const WRITES = [
  ["/__me/name", { name: "Mallory" }],
  ["/__me/avatar", { avatar: "data:image/png;base64,AAAA" }],
  ["/__onboarding/me", { installed: true }],
  ["/__onboarding/me/unit", undefined],
  ["/__status", { key: "checkout/flow", status: "done" }],
  ["/__pins", { key: "checkout/flow", pinned: true }],
  ["/__name", { key: "checkout/flow", name: "Renamed" }],
  ["/__canvases", { dir: "checkout", name: "Board" }],
];

test("a signed-in member's browser, asked by another page: each of these writes is refused and nothing is written", async () => {
  const { env, kv, cookie } = await instance();
  const before = JSON.stringify([...kv.map]);
  for (const [path, body] of WRITES) {
    for (const origin of ["https://demo.example", "https://acme.example.evil.test", "http://acme.example", "null", undefined]) {
      // text/plain is what a no-cors fetch from the other page can send; the answer must not depend on it.
      for (const ct of ["application/json", "text/plain"]) {
        const headers = { cookie, "content-type": ct, ...(origin === undefined ? {} : { origin }) };
        const r = await ask(env, path, { headers, body: body === undefined ? {} : body });
        assert.deepEqual([r.status, r.json && r.json.error], [403, "cross-origin"], `${path} from ${origin} as ${ct}`);
      }
    }
  }
  assert.equal(JSON.stringify([...kv.map]), before, "a refused write wrote something");
});

test("the workspace's own page still writes, with or without a body, and reads ask for nothing new", async () => {
  const { env, kv, cookie } = await instance();
  const named = await ask(env, "/__me/name", { headers: { cookie, origin: HOST, "content-type": "application/json" }, body: { name: "Ada L" } });
  assert.equal(named.status, 200, JSON.stringify(named.json));
  assert.match(JSON.stringify([...kv.map]), /Ada L/, "the name was stored");
  for (const [path, body] of WRITES) {
    const headers = { cookie, origin: HOST, ...(body === undefined ? {} : { "content-type": "application/json" }) };
    const r = await ask(env, path, { headers, body });
    assert.notEqual(r.json && r.json.error, "cross-origin", path);
    assert.notEqual(r.status, 415, `${path} must not ask for a content type`);
  }
  for (const path of ["/__status", "/__pins", "/__name", "/__canvases", "/__onboarding/me"]) {
    const r = await ask(env, path, { method: "GET", headers: { cookie } });
    assert.notEqual(r.json && r.json.error, "cross-origin", path);
    assert.ok(r.status < 500, `${path} read answered ${r.status}`);
  }
});

test("what is open by design stays open to another origin: comments, boards, and what a token signs", async () => {
  const { env } = await instance();
  for (const path of ["/__review/api?path=/", "/__board?path=/", "/__publish/acme/commit", "/__report"]) {
    const r = await ask(env, path, { headers: { "content-type": "application/json", origin: "https://demo.example" }, body: {} });
    assert.notEqual(r.json && r.json.error, "cross-origin", path);
  }
});
