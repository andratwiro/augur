// The front door tells an agent how to get in.
//
// Ask a fresh agent to "connect to this workspace and make a prototype" and it walks
// into a wall: every gated path answers 200 with the sign-in card, whatever the request
// asks for. The agent concludes it needs credentials, finds the seed password in a deploy
// shell's identity file, fires it at production, and then asks the owner for a password.
// The right key — `augur connect`, device pairing — exists; nothing says so.
//
// These tests pin the three machine-facing surfaces (/llms.txt, /.well-known/augur.json,
// the 401 for a programmatic request) and the one contract that must NOT move: a bare
// `Accept: */*` request still gets the HTML gate at 200, because the front-door probe and
// the "unknown path and root are the same page" rule both depend on it.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/_worker.js";
import { __testables as W } from "../src/_worker.js";

function freshIsolate() {
  W.__setTenantTestState({ memo: null });
  W.__setConfigTestState({ cfgAt: 0, cfgGoodAt: 0 });
}

const ADMIN = { email: "admin@example.test", name: "Admin", role: "admin" };

function memKV() {
  const m = new Map();
  return {
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => { m.delete(k); },
    list: async ({ prefix = "" } = {}) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
  };
}

let tenantSeq = 0;
function instance({ pairing = true, engineVersion = "0.15.1" } = {}) {
  freshIsolate();
  const tenantId = `door-fixture-${++tenantSeq}`;
  const env = {
    ASSETS: {
      fetch: async (req) => {
        const p = new URL(typeof req === "string" ? req : req.url).pathname;
        if (p === "/__config/instance.json") {
          return new Response(JSON.stringify({ users: [ADMIN], devicePairing: pairing, tenantId, engineVersion }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (p === "/__config/routing.json") {
          return new Response(JSON.stringify({ spaces: [{ id: "acme", default: true }], publicPrefixes: [] }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response("nf", { status: 404 });
      },
    },
    COMMENTS: memKV(),
  };
  return { env };
}

const ORIGIN = "https://acme.example";

async function get(env, path, headers = {}) {
  const orig = console.log; console.log = () => {};
  try {
    const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { headers }), env, {});
    const body = await res.text();
    let json = null;
    try { json = JSON.parse(body); } catch (e) {}
    return { status: res.status, ct: (res.headers.get("content-type") || "").split(";")[0].trim(), headers: res.headers, body, json };
  } finally { console.log = orig; }
}

// ── /llms.txt ────────────────────────────────────────────────────────────────

test("/llms.txt is public text that names the workspace and the connect command", async () => {
  const { env } = instance();
  const r = await get(env, "/llms.txt");
  assert.equal(r.status, 200);
  assert.equal(r.ct, "text/plain");
  assert.match(r.body, /Augur workspace "acme"/);
  assert.match(r.body, new RegExp(`npx augur connect --origin ${ORIGIN}`));
  assert.match(r.body, /scripts\/cli\.mjs connect/, "names the not-on-npm fallback");
  assert.match(r.body, /signed in/i, "says the owner approves in a signed-in browser");
  assert.match(r.body, /\.well-known\/augur\.json/);
  assert.doesNotMatch(r.body, /example\.test/, "the door names nobody on the roster");
});

test("/llms.txt with pairing off says so and offers no connect command", async () => {
  const { env } = instance({ pairing: false });
  const r = await get(env, "/llms.txt");
  assert.equal(r.status, 200);
  assert.match(r.body, /pairing is switched off/i);
  assert.doesNotMatch(r.body, /npx augur connect/);
  assert.match(r.body, /invite/i, "says what to do instead");
});

// ── /.well-known/augur.json ──────────────────────────────────────────────────

test("/.well-known/augur.json carries the same facts as data", async () => {
  const { env } = instance();
  const r = await get(env, "/.well-known/augur.json");
  assert.equal(r.status, 200);
  assert.equal(r.ct, "application/json");
  assert.equal(r.json.product, "augur");
  assert.equal(r.json.workspace, "acme");
  assert.equal(r.json.origin, ORIGIN);
  assert.equal(r.json.engine.version, "0.15.1");
  assert.deepEqual(r.json.pairing, { enabled: true, start: "/__publish/_pair/start", approve: "/__connect" });
  assert.equal(r.json.connect, `npx augur connect --origin ${ORIGIN}`);
  assert.equal(r.json.docs, "/llms.txt");
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(r.body, /example\.test/);
});

test("pairing off: enabled false and connect null, nothing else changes", async () => {
  const { env } = instance({ pairing: false });
  const r = await get(env, "/.well-known/augur.json");
  assert.equal(r.json.pairing.enabled, false);
  assert.equal(r.json.connect, null);
});

// ── the machine 401 ──────────────────────────────────────────────────────────

test("a signed-out request for an engine path answers 401 JSON with the door in it", async () => {
  const { env } = instance();
  const r = await get(env, "/__api/state");
  assert.equal(r.status, 401);
  assert.equal(r.ct, "application/json");
  assert.equal(r.json.error, "sign-in-required");
  assert.equal(r.json.connect, `npx augur connect --origin ${ORIGIN}`);
  assert.equal(r.headers.get("www-authenticate"), 'Bearer realm="augur"');
});

test("a signed-out request that asks for JSON gets the 401 door, even at the root", async () => {
  const { env } = instance();
  const r = await get(env, "/", { Accept: "application/json" });
  assert.equal(r.status, 401);
  assert.equal(r.json.error, "sign-in-required");
  assert.equal(r.json.docs, "/llms.txt");
});

test("a signed-out request for a gated page that asks for JSON gets the door too", async () => {
  const { env } = instance();
  const r = await get(env, "/projects/thing/", { Accept: "application/json, text/plain" });
  assert.equal(r.status, 401);
  assert.equal(r.json.workspace, "acme");
});

// ── the contract that must not move ──────────────────────────────────────────

test("a bare */* request still gets the HTML gate at 200, now with the pointer", async () => {
  const { env } = instance();
  const r = await get(env, "/", { Accept: "*/*" });
  assert.equal(r.status, 200);
  assert.equal(r.ct, "text/html");
  assert.match(r.body, /^\s*<!doctype html/i);
  assert.match(r.body, /type=["']password["']/);
  assert.match(r.body, /<!-- Agents and scripts: .*\/llms\.txt/);
  assert.equal(r.headers.get("link"), '</llms.txt>; rel="help"');
});

test("a browser request gets the HTML gate at 200 with the pointer", async () => {
  const { env } = instance();
  const r = await get(env, "/projects/thing/", { Accept: "text/html,application/xhtml+xml,*/*;q=0.8" });
  assert.equal(r.status, 200);
  assert.equal(r.ct, "text/html");
  assert.match(r.body, /<!-- Agents and scripts: /);
  assert.equal(r.headers.get("link"), '</llms.txt>; rel="help"');
});

test("the helpers decide 'machine' by path or by an explicit JSON accept only", () => {
  const url = (p) => new URL(`${ORIGIN}${p}`);
  const req = (accept) => new Request(ORIGIN, { headers: accept == null ? {} : { Accept: accept } });
  assert.equal(W.wantsMachineDoor(req("*/*"), url("/")), false);
  assert.equal(W.wantsMachineDoor(req(null), url("/")), false);
  assert.equal(W.wantsMachineDoor(req("text/html"), url("/x/")), false);
  assert.equal(W.wantsMachineDoor(req("application/json"), url("/")), true);
  assert.equal(W.wantsMachineDoor(req("*/*"), url("/__api/state")), true);
});
