// Deleting a comment thread removes another person's words. Until now the only gate
// was "is ANYONE signed in" — so on an instance with a roster, any teammate (or any
// holder of a shared viewer login) could wipe a colleague's thread and the API would
// answer 200. Every message already carries a stable `by` marker stamped from the
// session at creation (sanitizeMsg); nothing read it back on delete.
//
// The rule these tests pin: a op that FULLY REMOVES a thread — `delete`, or `delmsg`
// with index 0 — requires a signed-in caller who is either an admin or the author of
// the thread's ROOT message. A thread with no resolvable root author (anonymous, or
// data predating the field) is admin-only. Deleting a reply (index > 0) keeps the
// older signed-in-only gate; widening it is not this item's scope.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

function memKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
  };
}

const ADMIN = { email: "admin@example.test", name: "Admin", role: "admin" };
const A = { email: "a@example.test", name: "Ada", role: "editor" };
const B = { email: "b@example.test", name: "Bo", role: "editor" };
const ROSTER = [ADMIN, A, B];

// Every roster user needs a live secret, or identify() refuses the cookie outright.
const SECRETS = JSON.stringify(Object.fromEntries(
  ROSTER.map((u) => [u.email, "pbkdf2$1$AAAA$BBBB"]),
));

const PATH = "/prototypes/thing/";
const KEY = "c:" + PATH;

function threadBy(id, user) {
  return {
    id,
    messages: [{ author: user ? user.name : "Anonymous", verified: !!user, body: "hi", at: "now",
      by: user ? W.personId(user.email) : null }],
  };
}

function seed(threads) {
  const kv = memKV({ [KEY]: JSON.stringify(threads), "users:secrets": SECRETS });
  return { kv, env: { COMMENTS: kv, SESSION_SECRET: "s3cret" } };
}

async function post(env, user, op) {
  const headers = { "Content-Type": "application/json" };
  if (user) {
    const token = await W.userToken(env, user);
    headers.Cookie = `__Host-augur_user=${user.email}.${token}`;
  }
  const url = new URL(`https://example.test/__review/api?path=${encodeURIComponent(PATH)}`);
  const request = new Request(url, { method: "POST", headers, body: JSON.stringify(op) });
  // `authed` mirrors what the router passes: true once an instance has a roster.
  return W.reviewApi(request, url, env, true);
}

const idsIn = (kv) => JSON.parse(kv.store.get(KEY)).map((t) => t.id);

test("setup: the roster is live so identify() can resolve a cookie", async () => {
  W.applyInstance({ users: ROSTER });
  const { env } = seed([]);
  const token = await W.userToken(env, A);
  const me = await W.identify(new Request("https://example.test/", {
    headers: { Cookie: `__Host-augur_user=${A.email}.${token}` },
  }), env);
  assert.ok(me, "A's cookie identifies");
  assert.equal(me.email, A.email);
});

test("a teammate cannot delete a thread they did not author", async () => {
  W.applyInstance({ users: ROSTER });
  const { kv, env } = seed([threadBy("t1", A)]);
  const res = await post(env, B, { op: "delete", id: "t1" });
  assert.equal(res.status, 403, "B deleting A's thread must be refused (was: 200, silently deleted)");
  assert.deepEqual(idsIn(kv), ["t1"], "and the thread must still be there");
});

test("an author can delete their own thread", async () => {
  W.applyInstance({ users: ROSTER });
  const { kv, env } = seed([threadBy("t1", A), threadBy("t2", B)]);
  const res = await post(env, B, { op: "delete", id: "t2" });
  assert.equal(res.status, 200);
  assert.deepEqual(idsIn(kv), ["t1"], "only B's own thread went");
});

test("an admin can delete anyone's thread", async () => {
  W.applyInstance({ users: ROSTER });
  const { kv, env } = seed([threadBy("t1", A)]);
  const res = await post(env, ADMIN, { op: "delete", id: "t1" });
  assert.equal(res.status, 200);
  assert.deepEqual(idsIn(kv), []);
});

test("delmsg index 0 removes the whole thread, so it carries the same ownership rule", async () => {
  W.applyInstance({ users: ROSTER });
  const { kv, env } = seed([threadBy("t1", A)]);

  const refused = await post(env, B, { op: "delmsg", id: "t1", index: 0 });
  assert.equal(refused.status, 403, "delmsg 0 is a thread delete by another name");
  assert.deepEqual(idsIn(kv), ["t1"]);

  const allowed = await post(env, A, { op: "delmsg", id: "t1", index: 0 });
  assert.equal(allowed.status, 200);
  assert.deepEqual(idsIn(kv), []);
});

test("an anonymously-authored thread (no `by`) is admin-only to delete", async () => {
  W.applyInstance({ users: ROSTER });
  const anon = threadBy("t1", null);
  {
    const { kv, env } = seed([anon]);
    const res = await post(env, B, { op: "delete", id: "t1" });
    assert.equal(res.status, 403, "a signed-in non-admin cannot claim an anonymous thread");
    assert.deepEqual(idsIn(kv), ["t1"]);
  }
  {
    const { kv, env } = seed([anon]);
    const res = await post(env, ADMIN, { op: "delete", id: "t1" });
    assert.equal(res.status, 200, "an admin still can");
    assert.deepEqual(idsIn(kv), []);
  }
});

test("a thread predating the `by` field is admin-only, not free-for-all", async () => {
  W.applyInstance({ users: ROSTER });
  const legacy = { id: "t1", messages: [{ author: "Ada", verified: true, body: "old", at: "then" }] };
  const { kv, env } = seed([legacy]);
  const res = await post(env, A, { op: "delete", id: "t1" });
  assert.equal(res.status, 403, "no stable marker means no ownership claim, even by the displayed name");
  assert.deepEqual(idsIn(kv), ["t1"]);
});

test("a signed-out caller is still refused outright", async () => {
  W.applyInstance({ users: ROSTER });
  const { kv, env } = seed([threadBy("t1", A)]);
  const url = new URL(`https://example.test/__review/api?path=${encodeURIComponent(PATH)}`);
  const request = new Request(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ op: "delete", id: "t1" }),
  });
  const res = await W.reviewApi(request, url, env, false);
  assert.equal(res.status, 401, "the pre-existing signed-out gate is unchanged");
  assert.deepEqual(idsIn(kv), ["t1"]);
});

test("deleting a REPLY keeps the older signed-in-only rule (not this item's scope)", async () => {
  W.applyInstance({ users: ROSTER });
  const t = threadBy("t1", A);
  t.messages.push({ author: "Bo", verified: true, body: "reply", at: "now", by: W.personId(B.email) });
  const { kv, env } = seed([t]);
  const res = await post(env, B, { op: "delmsg", id: "t1", index: 1 });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(kv.store.get(KEY))[0].messages.length, 1);
});

// A raw engine clone has no roster: `authed` arrives undefined and there is nobody to
// be an admin. Requiring ownership there would make comments undeletable in every
// open build and in `augur dev`. Openness is the documented posture for that mode.
test("an open build with no roster stays open", async () => {
  W.applyInstance({ users: [] });
  const kv = memKV({ [KEY]: JSON.stringify([threadBy("t1", null)]) });
  const env = { COMMENTS: kv };
  const url = new URL(`https://example.test/__review/api?path=${encodeURIComponent(PATH)}`);
  const request = new Request(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ op: "delete", id: "t1" }),
  });
  const res = await W.reviewApi(request, url, env, undefined);
  assert.equal(res.status, 200);
  assert.deepEqual(idsIn(kv), []);
});

// reviewExport is the privileged moderation path: gated by its own REVIEW_EXPORT_KEY
// secret and calling applyOp with no `me`. The ownership check must not reach it.
test("applyOp itself is unchanged — the check lives in the API, not the reducer", () => {
  const threads = [threadBy("t1", A)];
  assert.deepEqual(W.applyOp(threads, { op: "delete", id: "t1" }).map((t) => t.id), [],
    "the moderation path (reviewExport) still deletes with no session at all");
});
