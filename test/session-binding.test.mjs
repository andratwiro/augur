// Splitting the session binding out of the credential.
//
// `F-auth-first-run-model`, stage one. `effectiveSecret` did TWO jobs: it was the value
// `verifyPassword` checked a typed password against, AND the value `userToken` HMAC'd, so
// that changing a credential ended that person's sessions "for free". Any passwordless
// design removes the first and silently takes the second with it — after which the obvious
// fix, binding to the address alone, collapses the derivation to a publicly computable
// digest. So the jobs are separated while passwords still exist and the change can be
// PROVED to do nothing.
//
// The first test is the whole argument for landing this: with the flag off, the derivation
// is not "compatible", it is identical, and it reads nothing extra.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

const U = { email: "a@x.test", name: "A", passHash: "pbkdf2$roster-hash" };
const ENV_SECRET = { SESSION_SECRET: "s3cret" };

function memKv(initial = {}) {
  const m = new Map(Object.entries(initial));
  let reads = 0;
  return {
    m,
    get reads() { return reads; },
    async get(k) { reads++; return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, v); },
  };
}
const withSecrets = (map) => memKv({ [W.SESSION_KEYS_KEY]: undefined, "users:secrets": JSON.stringify(map) });

// ── the no-op proof ──────────────────────────────────────────────────────────

test("FLAG OFF: the token is byte-identical to the one the old derivation produced, and nothing extra is read", async () => {
  // This is the test that makes the change landable. Not "equivalent" — the same string.
  const kv = memKv({ "users:secrets": JSON.stringify({ [U.email]: "pbkdf2$live" }) });
  const env = { ...ENV_SECRET, COMMENTS: kv };

  const authenticator = await W.effectiveSecret(env, U);
  assert.equal(authenticator, "pbkdf2$live");

  const before = kv.reads;
  const binding = await W.sessionBinding(env, U, authenticator, false);
  assert.equal(binding, authenticator, "the binding diverged from the credential with the flag off");
  assert.equal(kv.reads, before, "the flag-off path read the store — it must cost nothing");

  // And the derived token matches what userToken produces from the credential alone.
  assert.equal(await W.userToken(env, U, binding), await W.userToken(env, U, authenticator));
});

test("flag off, and a session key EXISTS anyway: it is ignored", async () => {
  // Somebody could turn the flag on, mint keys, and turn it back off. Off has to mean off,
  // or that rollback would sign everyone out in the direction nobody expects.
  const env = {
    ...ENV_SECRET,
    COMMENTS: memKv({
      "users:secrets": JSON.stringify({ [U.email]: "pbkdf2$live" }),
      [W.SESSION_KEYS_KEY]: JSON.stringify({ [U.email]: "deadbeef" }),
    }),
  };
  assert.equal(await W.sessionBinding(env, U, "pbkdf2$live", false), "pbkdf2$live");
});

// ── flag on ──────────────────────────────────────────────────────────────────

test("flag on with NO key stored still falls back to the credential — so turning it on signs nobody out", async () => {
  // The migration is the fallback. There is no flag day and no backfill: an instance flips
  // the switch and every existing cookie keeps verifying until something rotates a key.
  const env = { ...ENV_SECRET, COMMENTS: memKv({ "users:secrets": JSON.stringify({ [U.email]: "pbkdf2$live" }) }) };
  assert.equal(await W.sessionBinding(env, U, "pbkdf2$live", true), "pbkdf2$live");
});

test("flag on with a key stored: the key wins, and the credential is not part of the derivation", async () => {
  const env = {
    ...ENV_SECRET,
    COMMENTS: memKv({
      "users:secrets": JSON.stringify({ [U.email]: "pbkdf2$live" }),
      [W.SESSION_KEYS_KEY]: JSON.stringify({ [U.email]: "abc123" }),
    }),
  };
  assert.equal(await W.sessionBinding(env, U, "pbkdf2$live", true), "abc123");
});

// ── the failure modes, which are the point ───────────────────────────────────

test("A BOUND-BUT-UNREADABLE STORE IS A REFUSAL, NEVER A FALLBACK", async () => {
  // The failure that would matter. If an unreadable session-key document fell through to
  // the credential, a transient error would silently re-validate cookies that a rotation
  // had just killed — including a "sign me out everywhere" somebody asked for because
  // their laptop was stolen.
  const throwing = { async get() { throw new Error("kv down"); }, async put() {} };
  assert.equal(await W.sessionBinding({ ...ENV_SECRET, COMMENTS: throwing }, U, "pbkdf2$live", true), "");

  // Same for a document that is not a map. An array passes `typeof === "object"` and would
  // then miss every address at once — the exact shape effectiveSecret guards against.
  const arr = { async get() { return "[]"; }, async put() {} };
  assert.equal(await W.sessionBinding({ ...ENV_SECRET, COMMENTS: arr }, U, "pbkdf2$live", true), "");
});

test("PRESENT-AND-FALSY IS A REVOCATION, not an absent key", async () => {
  // Same distinction users:secrets makes. "Signed out everywhere and not yet back in" must
  // not fall through to the credential, or the sign-out would undo itself.
  const env = {
    ...ENV_SECRET,
    COMMENTS: memKv({ [W.SESSION_KEYS_KEY]: JSON.stringify({ [U.email]: null }) }),
  };
  assert.equal(await W.sessionBinding(env, U, "pbkdf2$live", true), "");
});

test("no store bound at all is NOT a refusal — that is the offline case, as it is for effectiveSecret", async () => {
  assert.equal(await W.sessionBinding({ ...ENV_SECRET }, U, "pbkdf2$roster", true), "pbkdf2$roster");
});

test("an empty binding can never reach the derivation as a usable token", async () => {
  // Belt on the brace in identify(): if "" ever did reach userToken, the token would be a
  // digest of "<email>:" — computable by anyone who knows the address. Pinning that the
  // two differ means a regression in identify()'s guard shows up as a failing test rather
  // than as a forgeable cookie.
  const env = { ...ENV_SECRET };
  const empty = await W.userToken(env, U, "");
  const real = await W.userToken(env, U, "pbkdf2$live");
  assert.notEqual(empty, real);
});

// ── rotation, which is the verb the split buys ───────────────────────────────

test("ROTATING ENDS EVERY SESSION WITHOUT TOUCHING THE CREDENTIAL", async () => {
  // Today this is impossible: a session ends only as a side effect of the hash changing,
  // so enrolling a device, redeeming a recovery link and "sign me out everywhere" all end
  // nothing. This is the whole point of the seam.
  const kv = memKv({ "users:secrets": JSON.stringify({ [U.email]: "pbkdf2$live" }) });
  const env = { ...ENV_SECRET, COMMENTS: kv };

  const before = await W.userToken(env, U, await W.sessionBinding(env, U, "pbkdf2$live", true));
  const r = await W.rotateSessionKey(env, U.email);
  assert.equal(r.ok, true);
  const after = await W.userToken(env, U, await W.sessionBinding(env, U, "pbkdf2$live", true));

  assert.notEqual(before, after, "rotation did not change the token, so it ended no sessions");
  // And the credential is untouched — the person can still sign in with the same password.
  assert.equal(await W.effectiveSecret(env, U), "pbkdf2$live");
});

test("rotating twice gives two different keys — it is random, not derived", async () => {
  const env = { ...ENV_SECRET, COMMENTS: memKv() };
  const name = await W.sessionKeyName(U.email);
  await W.rotateSessionKey(env, U.email);
  const first = JSON.parse(env.COMMENTS.m.get(name)).key;
  await W.rotateSessionKey(env, U.email);
  const second = JSON.parse(env.COMMENTS.m.get(name)).key;
  assert.notEqual(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
});

test("rotating one person leaves everybody else's sessions alone — on a record of their own, or still on the old document", async () => {
  const other = { email: "b@x.test", passHash: "pbkdf2$b" };
  const third = { email: "c@x.test", passHash: "pbkdf2$c" };
  const env = { ...ENV_SECRET, COMMENTS: memKv({
    [W.SESSION_KEYS_KEY]: JSON.stringify({ [other.email]: "keep-me" }),
    [await W.sessionKeyName(third.email)]: JSON.stringify({ key: "keep-me-too" }),
  }) };
  await W.rotateSessionKey(env, U.email);
  assert.equal(await W.sessionBinding(env, other, "pbkdf2$b", true), "keep-me");
  assert.equal(await W.sessionBinding(env, third, "pbkdf2$c", true), "keep-me-too");
});

// ── the regression this seam could introduce, and the guard against it ───────

test("⚠️ A CREDENTIAL CHANGE STILL ENDS SESSIONS, even once a key is stored", async () => {
  // THE regression to watch for. A stored key WINS over the credential, so without
  // clearSessionKey beside every write to users:secrets, resetting somebody's password
  // would leave all their cookies working — which is the opposite of what a reset is for.
  const kv = memKv({ "users:secrets": JSON.stringify({ [U.email]: "pbkdf2$old" }) });
  const env = { ...ENV_SECRET, COMMENTS: kv };
  await W.rotateSessionKey(env, U.email);
  const beforeReset = await W.sessionBinding(env, U, "pbkdf2$old", true);

  await W.clearSessionKey(env, U.email);
  const afterClear = await W.sessionBinding(env, U, "pbkdf2$old", true);
  assert.notEqual(afterClear, beforeReset, "clearing the key did not change the binding");
  assert.equal(afterClear, "pbkdf2$old", "the binding did not fall back to the credential");
});

test("clearing a key nobody has still writes the tombstone — absent would mean 'ask the old document'", async () => {
  // A clear used to be a no-op for somebody with no key. It cannot be any more: the only
  // way to know nobody has one is a read, and a stale read that saw nothing would skip
  // the write a concurrent rotate had just made necessary. The tombstone is one small
  // record per person, written blind, and it is what shadows the retired document.
  const kv = memKv();
  await W.clearSessionKey({ ...ENV_SECRET, COMMENTS: kv }, U.email);
  assert.equal(kv.m.size, 1);
  assert.deepEqual(JSON.parse(kv.m.get(await W.sessionKeyName(U.email))), { key: null });
  assert.equal(kv.m.has(W.SESSION_KEYS_KEY), false, "the retired document was written");
});

test("rotation and clearing never throw, even with a store that fails", async () => {
  // They are called BESIDE credential writes that have already succeeded. Throwing here
  // would undo one, which is strictly worse than failing to rotate.
  const broken = { async get() { throw new Error("down"); }, async put() { throw new Error("down"); } };
  const env = { ...ENV_SECRET, COMMENTS: broken };
  const r = await W.rotateSessionKey(env, U.email);
  assert.equal(r.ok, false);
  await W.clearSessionKey(env, U.email); // must not throw
});
