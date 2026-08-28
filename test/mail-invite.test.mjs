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
import { readFileSync } from "node:fs";
import { __testables as W } from "../src/_worker.js";

// The workspace whose admin panel this is. adminUsersApi defaults its roster, config
// list and workspace list off the context now; every case here passes its own lists
// explicitly, so this only has to be a real context, not a populated one.
const CTX = W.applyDerivedRouting({});

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
  W.adminUsersApi(CTX, adminReq({ op: "invite", email: "new@x.test", name: "New Person" }), usersUrl, env, ME, roster, roster);
const reset = (env) =>
  W.adminUsersApi(CTX, adminReq({ op: "reset", email: THEM.email }), usersUrl, env, ME, [ME, THEM], [ME, THEM]);

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
    assert.equal(await W.readInvite(null, env, token), THEM.email, "the minted token resolves, mail or no mail");
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
    assert.equal(await W.readInvite(null, env, token), "new@x.test");
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
    await W.adminUsersApi(CTX, adminReq({ op: "invite", email: "a@x.test" }), usersUrl, env, ME, [ME], [ME],
      [{ id: "ds", name: "Design System", default: true }]);
    assert.match(named.calls[0].body.subject, /Design System/);
  } finally { named.restore(); }
  const bare = withStubbedFetch();
  try {
    await W.adminUsersApi(CTX, adminReq({ op: "invite", email: "b@x.test" }), usersUrl, env, ME, [ME], [ME], []);
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
    assert.equal(await W.readInvite(null, env, token), "new@x.test", "the invite itself completed");
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
    assert.equal(await W.readInvite(null, env, token), THEM.email, "and the link it hands back is live");
  } finally { restore(); }
});

// ---- what the admin actually sees ---------------------------------------------------------
// The API's verdict is only useful if the panel shows it. build.js exports nothing, so
// showLink is lifted out of the admin page's inline script and run for real against a
// stub of the strip it writes into (same technique as membership-ui.test.mjs).

const BUILD_SRC = readFileSync(new URL("../build.js", import.meta.url), "utf8");

function liftBalanced(src, decl) {
  const start = src.indexOf(decl);
  assert.notEqual(start, -1, `${decl} was found in build.js`);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces after ${decl}`);
}

function runShowLink(mail) {
  const el = () => ({ textContent: "", className: "", value: "", focus() {}, select() {} });
  const nodes = {
    "[data-link-who]": el(), "[data-link-note]": el(),
    "[data-link-url]": el(), "[data-link-msg]": el(),
  };
  const linkbox = { hidden: true, querySelector: (s) => nodes[s] };
  const fn = new Function("linkbox", `${liftBalanced(BUILD_SRC, "function showLink(")}\nreturn showLink;`)(linkbox);
  fn("new@x.test", "https://x.test/__invite?t=abc", mail);
  return { strip: linkbox, ...nodes };
}

test("no provider: the strip reads exactly as it did before mail existed", () => {
  const seen = runShowLink({ ok: false, reason: "unconfigured", note: "" });
  assert.equal(seen["[data-link-note]"].textContent, "Send it to them yourself.");
  assert.equal(seen["[data-link-note]"].className, "aulink__note", "nothing is flagged");
  assert.equal(seen["[data-link-url]"].value, "https://x.test/__invite?t=abc");
  assert.equal(seen.strip.hidden, false);
});

test("a send that worked says so, and still shows the link", () => {
  const seen = runShowLink({ ok: true, reason: "sent", note: "Emailed to new@x.test." });
  assert.equal(seen["[data-link-note]"].textContent, "Emailed to new@x.test.");
  assert.equal(seen["[data-link-note]"].className, "aulink__note");
  assert.equal(seen["[data-link-url]"].value, "https://x.test/__invite?t=abc");
});

test("a send that failed is flagged in the panel, with the link still in front of them", () => {
  const seen = runShowLink({ ok: false, reason: "failed", note: "Couldn't email them (503). Send the link yourself." });
  assert.match(seen["[data-link-note]"].textContent, /Couldn't email them/);
  assert.match(seen["[data-link-note]"].className, /is-warn/, "the admin has something to do");
  assert.equal(seen["[data-link-url]"].value, "https://x.test/__invite?t=abc");
});

test("a caller that passes no verdict at all still gets a usable strip", () => {
  const seen = runShowLink(undefined);
  assert.equal(seen["[data-link-note]"].textContent, "Send it to them yourself.");
  assert.equal(seen["[data-link-url]"].value, "https://x.test/__invite?t=abc");
});

test("the panel hands the API's verdict to the strip rather than dropping it", () => {
  assert.match(BUILD_SRC, /showLink\(who, d\.url, d\.mail\)/, "reset passes the verdict");
  assert.match(BUILD_SRC, /showLink\(d\.email, d\.url, d\.mail\)/, "invite passes the verdict");
});
