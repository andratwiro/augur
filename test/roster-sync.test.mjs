// Roster write-back: an Admin-panel invite/removal must not create a second,
// diverging record. The KV overlay makes the change LIVE instantly; these tests
// pin the two halves that make it DURABLE as one record:
//   1. invite/remove fire a `roster-update` repository_dispatch at the deploy
//      shell (same channel "Delete forever" uses), so a workflow commits the
//      identity file — best-effort, never blocking the invite itself;
//   2. when the next config push arrives (the deploy that follows the commit),
//      the worker DRAINS overlay entries the config now supersedes — the
//      transitional record removes itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

function memKV() {
  const store = new Map();
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, String(v)); },
    async delete(k) { store.delete(k); },
    async list({ prefix = "" } = {}) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}
function memR2() {
  const store = new Map();
  return {
    store,
    async get(k) { return store.has(k) ? { text: async () => store.get(k), body: store.get(k) } : null; },
    async put(k, v) { store.set(k, typeof v === "string" ? v : JSON.stringify(v)); },
    async head(k) { return store.has(k) ? {} : null; },
    async list({ prefix = "" } = {}) {
      return { objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false };
    },
  };
}

const ME = { email: "admin@x.test", name: "Admin", role: "admin" };
const adminReq = (body) => new Request("https://x.test/__admin/users", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const usersUrl = new URL("https://x.test/__admin/users");

function withStubbedFetch(responder) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return responder ? responder() : new Response(null, { status: 204 });
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const DISPATCH_ENV = {
  DELETE_DISPATCH_URL: "https://api.github.test/repos/o/shell/dispatches",
  DELETE_DISPATCH_TOKEN: "ghp_x",
};

test("an invite fires a roster-update dispatch carrying the durable record", async () => {
  const env = { COMMENTS: memKV(), ...DISPATCH_ENV };
  const { calls, restore } = withStubbedFetch();
  try {
    const res = await W.adminUsersApi(adminReq({ op: "invite", email: "new@x.test", name: "New Person" }),
      usersUrl, env, ME, [ME], [ME]);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.fileSync, "dispatched");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, DISPATCH_ENV.DELETE_DISPATCH_URL);
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.event_type, "roster-update");
    assert.equal(sent.client_payload.action, "add");
    assert.equal(sent.client_payload.by, ME.email);
    const u = sent.client_payload.user;
    assert.equal(u.email, "new@x.test");
    assert.equal(u.name, "New Person");
    assert.ok(u.initials && u.color, "the durable record carries the same derived fields the overlay got");
  } finally { restore(); }
});

test("no dispatch config → invite still works, marked unconfigured, nothing fetched", async () => {
  const env = { COMMENTS: memKV() };
  const { calls, restore } = withStubbedFetch();
  try {
    const res = await W.adminUsersApi(adminReq({ op: "invite", email: "new@x.test" }),
      usersUrl, env, ME, [ME], [ME]);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.fileSync, "unconfigured");
    assert.equal(calls.length, 0);
  } finally { restore(); }
});

test("a failing dispatch never blocks the invite — the overlay half already worked", async () => {
  const env = { COMMENTS: memKV(), ...DISPATCH_ENV };
  const { restore } = withStubbedFetch(() => new Response("boom", { status: 500 }));
  try {
    const res = await W.adminUsersApi(adminReq({ op: "invite", email: "new@x.test" }),
      usersUrl, env, ME, [ME], [ME]);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.fileSync, "failed");
  } finally { restore(); }
});

test("a removal fires the symmetric dispatch", async () => {
  const gone = { email: "old@x.test", name: "Old", role: "user" };
  const env = { COMMENTS: memKV(), ...DISPATCH_ENV };
  const { calls, restore } = withStubbedFetch();
  try {
    const res = await W.adminUsersApi(adminReq({ op: "remove", email: "old@x.test" }),
      usersUrl, env, ME, [ME, gone], [ME, gone]);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.fileSync, "dispatched");
    const sent = JSON.parse(calls.at(-1).init.body);
    assert.equal(sent.event_type, "roster-update");
    assert.deepEqual(sent.client_payload, { action: "remove", email: "old@x.test", by: ME.email });
  } finally { restore(); }
});

test("a config push drains overlay entries the new config supersedes", async () => {
  const kv = memKV();
  await kv.put("users:roster", JSON.stringify({
    add: {
      "lydie@x.test": { email: "lydie@x.test", name: "Lydie" }, // now in config → drain
      "fresh@x.test": { email: "fresh@x.test", name: "Fresh" }, // not yet in config → keep
    },
    remove: [
      "gone@x.test",     // config no longer names them → the entry's job is done → drain
      "hidden@x.test",   // config still names them → the removal must keep hiding → keep
    ],
  }));
  const env = { BUNDLES: memR2(), COMMENTS: kv, PUBLISH_BOOTSTRAP_TOKEN: "tok" };
  const config = JSON.stringify({ users: [
    { email: "lydie@x.test", name: "Lydie" },
    { email: "hidden@x.test", name: "Hidden" },
  ] });
  const res = await W.publishApi(
    new Request("https://x.test/__publish/_instance/config", {
      method: "POST",
      headers: { Authorization: "Bearer tok", "content-type": "application/json" },
      body: config,
    }),
    new URL("https://x.test/__publish/_instance/config"), env);
  assert.equal(res.status, 200);
  const after = JSON.parse(await kv.get("users:roster"));
  assert.deepEqual(Object.keys(after.add), ["fresh@x.test"]);
  assert.deepEqual(after.remove, ["hidden@x.test"]);
});
