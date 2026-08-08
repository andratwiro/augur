// Unit tests for the pure helpers in src/_worker.js (imported directly — the file's
// top level is all const/function definitions, so importing is side-effect free and
// the build-injected placeholders stay inert empty values). Zero dependencies:
// node --test + node:assert + the global Web Crypto.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

test("placeholders are inert at import time (raw copy gates nothing)", () => {
  assert.equal(W.userByEmail("nobody@example.test"), null); // USERS = []
});

test("hash/verify roundtrip (PBKDF2, random salt)", async () => {
  const h = await W.hashPassword("correct horse battery");
  assert.ok(W.isPassHash(h), "produces a pbkdf2$… string");
  assert.match(h, new RegExp(`^pbkdf2\\$${W.PBKDF2_ITERATIONS}\\$[A-Za-z0-9+/=]+\\$[A-Za-z0-9+/=]+$`));
  assert.equal(await W.verifyPassword("correct horse battery", h), true);
  assert.equal(await W.verifyPassword("wrong horse", h), false);
  assert.equal(await W.verifyPassword("", h), false);
});

test("each hash uses a fresh salt", async () => {
  const a = await W.hashPassword("same password");
  const b = await W.hashPassword("same password");
  assert.notEqual(a, b, "same password hashes differently");
  assert.equal(await W.verifyPassword("same password", a), true);
  assert.equal(await W.verifyPassword("same password", b), true);
});

test("verifyPassword accepts a legacy plaintext value", async () => {
  // TEMPORARY (migration) — this test is removed in the finish step.
  assert.equal(await W.verifyPassword("augur-legacy-2026", "augur-legacy-2026"), true);
  assert.equal(await W.verifyPassword("nope", "augur-legacy-2026"), false);
});

test("verifyPassword rejects malformed hashes without throwing", async () => {
  assert.equal(await W.verifyPassword("x", "pbkdf2$100000$notbase64!!$also!!"), false);
  assert.equal(await W.verifyPassword("x", "pbkdf2$onlythree$parts"), false);
  assert.equal(await W.verifyPassword("x", null), false);
});

test("safeEqual compares without short-circuiting on content", () => {
  assert.equal(W.safeEqual("abc", "abc"), true);
  assert.equal(W.safeEqual("abc", "abd"), false);
  assert.equal(W.safeEqual("abc", "abcd"), false);
  assert.equal(W.safeEqual(null, ""), true);
});

// Minimal in-memory KV mirroring the subset the worker uses.
function memKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
  };
}
const envWith = (kv, extra = {}) => ({ COMMENTS: kv, ...extra });
const USER = { email: "a@example.test", name: "A", role: "admin" };

function cookieRequest(value) {
  return new Request("https://example.test/", { headers: { Cookie: `gv_user=${value}` } });
}

test("session token is an HMAC when SESSION_SECRET is set", async () => {
  const kv = memKV({ "users:secrets": JSON.stringify({ "a@example.test": "pbkdf2$1$AAAA$BBBB" }) });
  const env = envWith(kv, { SESSION_SECRET: "s3cret" });
  const t = await W.userToken(env, USER);
  assert.match(t, /^[0-9a-f]{64}$/, "hex HMAC-SHA-256");
  const same = await W.userToken(env, USER);
  assert.equal(t, same, "deterministic for the same secret");
  const other = await W.userToken(envWith(kv, { SESSION_SECRET: "different" }), USER);
  assert.notEqual(t, other, "keyed by SESSION_SECRET");
});

test("identify accepts a new-derivation cookie", async () => {
  const kv = memKV({ "users:secrets": JSON.stringify({ "a@example.test": "pbkdf2$1$AAAA$BBBB" }) });
  const env = envWith(kv, { SESSION_SECRET: "s3cret" });
  const t = await W.userToken(env, USER);
  const got = await W.identify(cookieRequest(`a@example.test.${t}`), env, [USER]);
  assert.equal(got && got.email, "a@example.test");
});

test("identify also accepts a legacy-derivation cookie", async () => {
  // TEMPORARY (migration) — this test is removed in the finish step.
  const kv = memKV({ "users:secrets": JSON.stringify({ "a@example.test": "pbkdf2$1$AAAA$BBBB" }) });
  const env = envWith(kv, { SESSION_SECRET: "s3cret" });
  const legacy = await W.legacyUserToken(env, USER);
  const got = await W.identify(cookieRequest(`a@example.test.${legacy}`), env, [USER]);
  assert.equal(got && got.email, "a@example.test", "existing sessions survive the deploy");
});

test("identify rejects a forged or stale token", async () => {
  const kv = memKV({ "users:secrets": JSON.stringify({ "a@example.test": "pbkdf2$1$AAAA$BBBB" }) });
  const env = envWith(kv, { SESSION_SECRET: "s3cret" });
  assert.equal(await W.identify(cookieRequest("a@example.test.deadbeef"), env, [USER]), null);
  assert.equal(await W.identify(cookieRequest("nosuchdot"), env, [USER]), null);
  assert.equal(await W.identify(new Request("https://example.test/"), env, [USER]), null);
});

test("changing the stored secret invalidates existing cookies", async () => {
  const kv = memKV({ "users:secrets": JSON.stringify({ "a@example.test": "pbkdf2$1$AAAA$BBBB" }) });
  const env = envWith(kv, { SESSION_SECRET: "s3cret" });
  const t = await W.userToken(env, USER);
  await kv.put("users:secrets", JSON.stringify({ "a@example.test": "pbkdf2$1$CCCC$DDDD" }));
  assert.equal(await W.identify(cookieRequest(`a@example.test.${t}`), env, [USER]), null);
});

test("effectiveSecret prefers the KV override over the roster value", async () => {
  const kv = memKV({ "users:secrets": JSON.stringify({ "a@example.test": "override" }) });
  const env = envWith(kv);
  assert.equal(await W.effectiveSecret(env, { email: "a@example.test", pass: "roster" }), "override");
  assert.equal(await W.effectiveSecret(env, { email: "b@example.test", pass: "roster" }), "roster");
  assert.equal(await W.effectiveSecret(env, { email: "b@example.test", passHash: "pbkdf2$x", pass: "roster" }), "pbkdf2$x");
  assert.equal(await W.effectiveSecret(env, { email: "c@example.test" }), "");
});

test("userToken falls back to the legacy derivation when SESSION_SECRET is unset", async () => {
  const kv = memKV({ "users:secrets": JSON.stringify({ "a@example.test": "pbkdf2$1$AAAA$BBBB" }) });
  const env = envWith(kv); // No SESSION_SECRET set
  const fallback = await W.userToken(env, USER);
  const legacy = await W.legacyUserToken(env, USER);
  assert.equal(fallback, legacy, "userToken matches legacyUserToken when SESSION_SECRET is unset");
  // Verify it's different from when SESSION_SECRET is set
  const envWithSecret = envWith(kv, { SESSION_SECRET: "s3cret" });
  const withSecret = await W.userToken(envWithSecret, USER);
  assert.notEqual(fallback, withSecret, "token differs when SESSION_SECRET is added");
});

test("a cookie issued before SESSION_SECRET was set still identifies afterwards", async () => {
  const kv = memKV({ "users:secrets": JSON.stringify({ "a@example.test": "pbkdf2$1$AAAA$BBBB" }) });
  // Issue a token with no SESSION_SECRET
  const envNoSecret = envWith(kv);
  const token = await W.userToken(envNoSecret, USER);
  // Now try to identify with that cookie against an env that has SESSION_SECRET
  const envWithSecret = envWith(kv, { SESSION_SECRET: "s3cret" });
  const got = await W.identify(cookieRequest(`a@example.test.${token}`), envWithSecret, [USER]);
  assert.equal(got && got.email, "a@example.test", "legacy cookie still identifies after SESSION_SECRET is configured");
});

test("a verified legacy plaintext is upgraded to a hash in place", async () => {
  // TEMPORARY (migration) — this test is removed in the finish step.
  const kv = memKV({ "users:secrets": JSON.stringify({ "a@example.test": "augur-legacy-2026" }) });
  const env = envWith(kv);
  const u = { email: "a@example.test" };
  await W.upgradeSecretIfLegacy(env, u, "augur-legacy-2026");
  const stored = JSON.parse(await kv.get("users:secrets"))["a@example.test"];
  assert.ok(W.isPassHash(stored), "rewritten as pbkdf2$…");
  assert.equal(await W.verifyPassword("augur-legacy-2026", stored), true);
});

test("upgrade is a no-op when the stored value is already a hash", async () => {
  const h = await W.hashPassword("pw");
  const kv = memKV({ "users:secrets": JSON.stringify({ "a@example.test": h }) });
  const env = envWith(kv);
  await W.upgradeSecretIfLegacy(env, { email: "a@example.test" }, "pw");
  assert.equal(JSON.parse(await kv.get("users:secrets"))["a@example.test"], h, "untouched");
});
