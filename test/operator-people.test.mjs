// The platform operator at the members API: `people` (control verb) → a fifteen-minute,
// star-scope token capped to `people` → `/__admin/users` reads it as an admin who is not a
// person. The cases are what that must and must not open.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

const CTX = W.applyDerivedRouting({});

function memKV(init = {}) {
  const store = new Map(Object.entries(init));
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

function withStubbedFetch() {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ emails: [{ id: "m1" }] }), { status: 200 });
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const MAIL_ENV = {
  MAIL_PROVIDER: "scaleway", MAIL_FROM: "Example <noreply@example.org>",
  MAIL_API_KEY: "k", MAIL_PROJECT_ID: "p", MAIL_REGION: "eu-west",
};
const SPACES = [{ id: "workspace", name: "Acme Studio", default: true }];
const ROB = { email: "rob@x.test", name: "Rob", role: "admin" };
const usersUrl = new URL("https://x.test/__admin/users");
const post = (body) => new Request("https://x.test/__admin/users", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const bearer = (t) => new Request("https://x.test/__admin/users", { headers: { Authorization: `Bearer ${t}` } });

async function tokens(map) {
  const doc = {};
  for (const [t, rec] of Object.entries(map)) doc[await W.tokenFor("pub:" + t)] = rec;
  return memKV({ "publish:tokens": JSON.stringify(doc) });
}

test("only a people-capped star token is the operator; every other bearer is nobody", async () => {
  const kv = await tokens({
    people: { space: "*", label: "operator-people", caps: ["people"] },
    star: { space: "*", label: "ci" },
    chrome: { space: "*", label: "chrome-refresh", caps: ["chrome"] },
    scoped: { space: "workspace", label: "operator-people", caps: ["people"] },
    expired: { space: "*", label: "operator-people", caps: ["people"], expiresAt: "2020-01-01T00:00:00.000Z" },
  });
  const env = { COMMENTS: kv };
  const who = async (t) => W.operatorForPeople(CTX, bearer(t), env);
  assert.equal((await who("people")).operator, true);
  assert.equal(await who("star"), null, "an unrestricted star token is not the operator");
  assert.equal(await who("chrome"), null);
  assert.equal(await who("scoped"), null, "a space-scoped token is not the operator");
  assert.equal(await who("expired"), null);
  assert.equal(await who("nope"), null);
});

test("the people capability opens no publish route", () => {
  for (const [space, op] of [["workspace", "commit"], ["_engine", "commit"], ["_state", "delete"], ["_instance", "config"]]) {
    assert.equal(W.capabilityRefusal({ caps: ["people"] }, space, op), "capability-not-granted", `${space}/${op}`);
  }
});

test("the operator invites an admin, and the mail names no inviter", async () => {
  const op = await W.operatorForPeople(CTX, bearer("people"), {
    COMMENTS: await tokens({ people: { space: "*", label: "operator-people", caps: ["people"] } }),
  });
  const env = { COMMENTS: memKV(), ...MAIL_ENV };
  const { calls, restore } = withStubbedFetch();
  try {
    const res = await W.adminUsersApi(CTX, post({ op: "invite", email: "t@x.test", role: "admin" }), usersUrl, env, op, [ROB], [ROB], SPACES);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].body.subject, /You're invited to Acme Studio/);
    assert.match(calls[0].body.text, /You have been invited to Acme Studio\./);
    assert.ok(!/operator/.test(calls[0].body.text), "the pseudo-identity never reaches the mail");
    const roster = JSON.parse(await env.COMMENTS.get("users:roster"));
    assert.equal(roster.add["t@x.test"].role, "admin");
  } finally { restore(); }
});

test("inviting somebody already on the roster who never signed in sends them a fresh link", async () => {
  const env = { COMMENTS: memKV(), ...MAIL_ENV };
  const { calls, restore } = withStubbedFetch();
  try {
    const res = await W.adminUsersApi(CTX, post({ op: "invite", email: "ROB@x.test" }), usersUrl, env, { ...ROB, email: "other@x.test", name: "Ada" }, [ROB], [ROB], SPACES);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.resent, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].body.text, /Ada invited you/);
    const token = new URL(body.url).searchParams.get("t");
    assert.equal(await W.readInvite(null, env, token), "rob@x.test");
  } finally { restore(); }
});

test("inviting somebody who has signed in is still already-a-user", async () => {
  const env = { COMMENTS: memKV({ "users:secrets": JSON.stringify({ "rob@x.test": "hash" }) }) };
  const res = await W.adminUsersApi(CTX, post({ op: "invite", email: "rob@x.test" }), usersUrl, env, { email: "operator", name: "", role: "admin", operator: true }, [ROB], [ROB], SPACES);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "already-a-user");
});

test("the operator may remove anyone, and may not reset or touch per-space membership", async () => {
  const OP = { email: "operator", name: "", role: "admin", operator: true };
  const T = { email: "t@x.test", name: "T", role: "admin" };
  const env = { COMMENTS: memKV() };
  for (const kind of ["reset", "space", "reconcile-membership"]) {
    const res = await W.adminUsersApi(CTX, post({ op: kind, email: ROB.email }), usersUrl, env, OP, [ROB, T], [ROB, T], SPACES);
    assert.equal(res.status, 403, kind);
    assert.equal((await res.json()).error, "operator-not-allowed");
  }
  const res = await W.adminUsersApi(CTX, post({ op: "remove", email: ROB.email }), usersUrl, env, OP, [ROB, T], [ROB, T], SPACES);
  assert.equal(res.status, 200);
});
