// Inviting someone, and resetting them, can now put the link in their inbox — without
// ever taking the link away from the admin.
//
// The whole point of these tests is the degrade path. An invite used to be a link the
// admin copied out of the panel and sent themselves; that is still exactly what happens
// when no provider is configured, when the provider is half-configured, when it is down,
// and when the per-address cap has been reached. Every case below asserts the same two
// things: the response still carries `url`, and the verdict is reported rather than
// swallowed.
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

// The worker calls the ambient fetch, so the provider is stubbed there. No deploy
// dispatch is configured in these envs, so every call recorded here is a mail send.
function withStubbedFetch(responder) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: init && init.body ? JSON.parse(init.body) : null });
    return responder ? responder() : new Response(JSON.stringify({ emails: [{ id: "m1" }] }), { status: 200 });
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const MAIL_ENV = {
  MAIL_PROVIDER: "scaleway",
  MAIL_FROM: "Example <noreply@example.org>",
  MAIL_API_KEY: "k",
  MAIL_PROJECT_ID: "p",
  MAIL_REGION: "eu-west",
};

const ME = { email: "admin@x.test", name: "Ada Admin", role: "admin" };
const THEM = { email: "them@x.test", name: "Them", role: "editor" };
const usersUrl = new URL("https://x.test/__admin/users");
const adminReq = (body) => new Request("https://x.test/__admin/users", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

const invite = (env, roster = [ME]) =>
  W.adminUsersApi(adminReq({ op: "invite", email: "new@x.test", name: "New Person" }), usersUrl, env, ME, roster, roster);
const reset = (env) =>
  W.adminUsersApi(adminReq({ op: "reset", email: THEM.email }), usersUrl, env, ME, [ME, THEM], [ME, THEM]);

// ---- no provider: exactly what happened before mail existed ---------------------------

test("with no provider configured an invite is a link, and says no mail was sent", async () => {
  const env = { COMMENTS: memKV() };
  const { calls, restore } = withStubbedFetch();
  try {
    const body = await (await invite(env)).json();
    assert.equal(body.ok, true);
    assert.match(body.url, /^https:\/\/x\.test\/__invite\?t=/);
    assert.equal(body.mail.ok, false);
    assert.equal(body.mail.reason, "unconfigured");
    assert.equal(body.mail.note, "", "the panel says nothing extra — it looks untouched");
    assert.equal(calls.length, 0, "nothing is fetched");
  } finally { restore(); }
});

test("with no provider configured a reset is a link too, and the link still works", async () => {
  const env = { COMMENTS: memKV() };
  const { restore } = withStubbedFetch();
  try {
    const body = await (await reset(env)).json();
    assert.equal(body.mail.reason, "unconfigured");
    const token = new URL(body.url).searchParams.get("t");
    assert.equal(await W.readInvite(env, token), THEM.email, "the minted token resolves, mail or no mail");
  } finally { restore(); }
});

// ---- provider configured: the mail carries the same link ------------------------------

test("an invite is emailed, and the message carries the very link the panel shows", async () => {
  const env = { COMMENTS: memKV(), ...MAIL_ENV };
  const { calls, restore } = withStubbedFetch();
  try {
    const body = await (await invite(env)).json();
    assert.equal(body.mail.ok, true);
    assert.equal(body.mail.reason, "sent");
    assert.match(body.mail.note, /Emailed to new@x\.test/);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /transactional-email/);
    const sent = calls[0].body;
    assert.deepEqual(sent.to, [{ email: "new@x.test" }]);
    assert.ok(sent.text.includes(body.url), "the emailed link IS the returned link");
    assert.ok(sent.text.includes("Ada Admin"), "the invite names the admin who sent it");
    // The token in the message is the one the invite flow will actually accept.
    const token = new URL(body.url).searchParams.get("t");
    assert.equal(await W.readInvite(env, token), "new@x.test");
  } finally { restore(); }
});

test("a reset is emailed with the reset wording, not the invite wording", async () => {
  const env = { COMMENTS: memKV(), ...MAIL_ENV };
  const { calls, restore } = withStubbedFetch();
  try {
    const body = await (await reset(env)).json();
    assert.equal(body.mail.ok, true);
    const sent = calls[0].body;
    assert.match(sent.subject, /new password/i);
    assert.ok(sent.text.includes(body.url));
  } finally { restore(); }
});

test("the message names the workspace when the deployment has one, the host when it does not", async () => {
  const env = { COMMENTS: memKV(), ...MAIL_ENV };
  const named = withStubbedFetch();
  try {
    await W.adminUsersApi(adminReq({ op: "invite", email: "a@x.test" }), usersUrl, env, ME, [ME], [ME],
      [{ id: "ds", name: "Design System", default: true }]);
    assert.match(named.calls[0].body.subject, /Design System/);
  } finally { named.restore(); }
  const bare = withStubbedFetch();
  try {
    await W.adminUsersApi(adminReq({ op: "invite", email: "b@x.test" }), usersUrl, env, ME, [ME], [ME], []);
    assert.match(bare.calls[0].body.subject, /x\.test/);
  } finally { bare.restore(); }
});

// ---- the provider is down --------------------------------------------------------------

test("a provider outage degrades: the admin sees the error AND still gets the link", async () => {
  const env = { COMMENTS: memKV(), ...MAIL_ENV };
  const { restore } = withStubbedFetch(() => new Response('{"message":"service unavailable"}', { status: 503 }));
  try {
    const res = await invite(env);
    assert.equal(res.status, 200, "a dead mail provider never fails the invite");
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.match(body.url, /__invite\?t=/);
    assert.equal(body.mail.ok, false);
    assert.equal(body.mail.reason, "failed");
    assert.match(body.mail.note, /Couldn't email them/);
    assert.match(body.mail.note, /Send the link yourself/);
    const token = new URL(body.url).searchParams.get("t");
    assert.equal(await W.readInvite(env, token), "new@x.test", "the invite itself completed");
  } finally { restore(); }
});

test("a provider that throws is a verdict on the response, never a 500", async () => {
  const env = { COMMENTS: memKV(), ...MAIL_ENV };
  const { restore } = withStubbedFetch(() => { throw new Error("network down"); });
  try {
    const res = await invite(env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.mail.reason, "failed");
    assert.ok(body.url);
  } finally { restore(); }
});

test("mail switched on but unfinished names the setting that is missing", async () => {
  const env = { COMMENTS: memKV(), MAIL_PROVIDER: "scaleway" };
  const { calls, restore } = withStubbedFetch();
  try {
    const body = await (await invite(env)).json();
    assert.equal(body.mail.reason, "misconfigured");
    assert.match(body.mail.note, /MAIL_API_KEY/);
    assert.ok(body.url);
    assert.equal(calls.length, 0);
  } finally { restore(); }
});

// ---- the reset cap ------------------------------------------------------------------------

test("resetting the same person repeatedly caps the MAIL, never the reset", async () => {
  const env = { COMMENTS: memKV(), ...MAIL_ENV };
  const { calls, restore } = withStubbedFetch();
  try {
    let last = null;
    for (let i = 0; i < 5; i++) last = await (await reset(env)).json();
    assert.equal(last.ok, true, "the reset itself is never refused");
    assert.equal(last.mail.reason, "rate-limited");
    assert.match(last.mail.note, /Send the link yourself/);
    assert.ok(calls.length < 5, "the provider stopped being called");
    const token = new URL(last.url).searchParams.get("t");
    assert.equal(await W.readInvite(env, token), THEM.email, "and the link it hands back is live");
  } finally { restore(); }
});
