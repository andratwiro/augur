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

// ---- Revocation tombstone: a PRESENT-but-falsy override entry means "revoked",
// and must never fall through to the roster password baked into identity.json.

test("effectiveSecret: a revocation tombstone yields '' even with a roster pass", async () => {
  const kv = memKV({ "users:secrets": JSON.stringify({ "a@example.test": null }) });
  const env = envWith(kv);
  const result = await W.effectiveSecret(env, { email: "a@example.test", pass: "leaked-seed" });
  assert.equal(result, "");
  assert.notEqual(result, "leaked-seed", "must NOT fall back to the roster password");
});

test("effectiveSecret: an absent key still falls back to the roster pass", async () => {
  const kv = memKV({ "users:secrets": JSON.stringify({ "other@example.test": "override" }) });
  const env = envWith(kv);
  assert.equal(
    await W.effectiveSecret(env, { email: "a@example.test", pass: "roster" }),
    "roster"
  );
});

test("effectiveSecret: a real hash in the map still wins over the roster", async () => {
  const kv = memKV({ "users:secrets": JSON.stringify({ "a@example.test": "pbkdf2$1$AAAA$BBBB" }) });
  const env = envWith(kv);
  assert.equal(
    await W.effectiveSecret(env, { email: "a@example.test", pass: "roster" }),
    "pbkdf2$1$AAAA$BBBB"
  );
});

test("identify cannot authenticate a user holding a tombstone", async () => {
  // Local fixture: a user with a roster password that the buggy code would
  // incorrectly fall back to if the tombstone check were removed.
  const LEAKY = { email: "leaky@example.test", name: "Leaky", pass: "leaked-seed-2026" };

  // Start with the user holding a real override secret (so they are genuinely
  // logged in). When the buggy code runs and the tombstone is present, it should
  // fall through and leak the roster password — but the correct code must never do that.
  const kv = memKV({ "users:secrets": JSON.stringify({ "leaky@example.test": "real-override-secret" }) });
  const env = envWith(kv, { SESSION_SECRET: "s3cret" });

  // Mint a valid token BEFORE the tombstone is written. This token is computed
  // from the real override secret that is currently in KV.
  const tokenBeforeTombstone = await W.userToken(env, LEAKY);

  // Admin reset: revoke by writing a tombstone (null) over the entry.
  await kv.put("users:secrets", JSON.stringify({ "leaky@example.test": null }));

  // The old token should no longer authenticate. It was valid when derived from
  // the real override secret, but now the override is a tombstone (null), so
  // effectiveSecret returns "", producing a different token hash.
  const got = await W.identify(cookieRequest(`leaky@example.test.${tokenBeforeTombstone}`), env, [LEAKY]);
  assert.equal(got, null, "a tombstoned user's pre-existing cookie must not authenticate");

  // Explicit regression check: after revocation, effectiveSecret must return ""
  // and must NOT fall back to the roster password "leaked-seed-2026".
  const secret = await W.effectiveSecret(env, LEAKY);
  assert.equal(secret, "", "tombstone must yield empty string");
  assert.notEqual(secret, "leaked-seed-2026", "must NOT leak the roster password");
});

test("upgradeSecretIfLegacy is a no-op for a tombstoned user", async () => {
  const kv = memKV({ "users:secrets": JSON.stringify({ "a@example.test": null }) });
  const env = envWith(kv);
  await W.upgradeSecretIfLegacy(env, { email: "a@example.test" }, "some-password");
  const stored = JSON.parse(await kv.get("users:secrets"));
  assert.ok(
    Object.prototype.hasOwnProperty.call(stored, "a@example.test"),
    "the tombstone entry must still be present"
  );
  assert.equal(stored["a@example.test"], null, "the tombstone must not be resurrected into a secret");
});

test("mintInvite issues a token that reads back to its email", async () => {
  const kv = memKV(); const env = envWith(kv);
  const t = await W.mintInvite(env, "a@example.test");
  assert.match(t, /^[A-Za-z0-9_-]{20,}$/, "url-safe, high entropy");
  assert.equal(await W.readInvite(env, t), "a@example.test");
});

test("an invite is single-use", async () => {
  const kv = memKV(); const env = envWith(kv);
  const t = await W.mintInvite(env, "a@example.test");
  assert.equal(await W.consumeInvite(env, t), "a@example.test");
  assert.equal(await W.consumeInvite(env, t), null, "second use fails");
  assert.equal(await W.readInvite(env, t), null);
});

test("an invite expires after the TTL", async () => {
  const kv = memKV(); const env = envWith(kv);
  const t0 = 1_000_000_000_000;
  const t = await W.mintInvite(env, "a@example.test", t0);
  assert.equal(await W.readInvite(env, t, t0 + W.INVITE_TTL_MS - 1), "a@example.test");
  assert.equal(await W.readInvite(env, t, t0 + W.INVITE_TTL_MS + 1), null, "expired");
  assert.equal(await W.consumeInvite(env, t, t0 + W.INVITE_TTL_MS + 1), null);
});

test("minting a new invite invalidates that user's outstanding ones", async () => {
  const kv = memKV(); const env = envWith(kv);
  const first = await W.mintInvite(env, "a@example.test");
  const second = await W.mintInvite(env, "a@example.test");
  assert.equal(await W.readInvite(env, first), null, "old link is dead");
  assert.equal(await W.readInvite(env, second), "a@example.test");
});

test("minting for one user leaves another user's invite alone", async () => {
  const kv = memKV(); const env = envWith(kv);
  const a = await W.mintInvite(env, "a@example.test");
  await W.mintInvite(env, "b@example.test");
  assert.equal(await W.readInvite(env, a), "a@example.test");
});

test("unknown tokens read as null", async () => {
  const kv = memKV(); const env = envWith(kv);
  assert.equal(await W.readInvite(env, "nope"), null);
  assert.equal(await W.readInvite(env, ""), null);
});

// Wraps memKV() and counts get() calls per key, so a regression back to the
// two-read form (readInvite + readInvites) is caught by a call-count assertion
// rather than relying on timing/behavior alone.
function countingKV(initial = {}) {
  const inner = memKV(initial);
  const getCounts = new Map();
  return {
    store: inner.store,
    getCounts,
    async get(k) {
      getCounts.set(k, (getCounts.get(k) || 0) + 1);
      return inner.get(k);
    },
    async put(k, v) { return inner.put(k, v); },
    async delete(k) { return inner.delete(k); },
  };
}

test("consumeInvite performs exactly one KV get of users:invites", async () => {
  const kv = countingKV();
  const env = envWith(kv);
  const t = await W.mintInvite(env, "a@example.test");
  kv.getCounts.clear(); // only count gets during consumeInvite itself
  const email = await W.consumeInvite(env, t);
  assert.equal(email, "a@example.test");
  assert.equal(kv.getCounts.get("users:invites"), 1, "consumeInvite must do exactly one get of users:invites");
});

test("a corrupt invites map degrades to no invites instead of throwing", async () => {
  const kv = memKV({ "users:invites": "{not json" });
  const env = envWith(kv);
  await assert.doesNotReject(async () => {
    assert.equal(await W.readInvite(env, "anything"), null);
  });
  await assert.doesNotReject(async () => {
    assert.equal(await W.consumeInvite(env, "anything"), null);
  });
  let token;
  await assert.doesNotReject(async () => {
    token = await W.mintInvite(env, "a@example.test");
  });
  assert.equal(await W.readInvite(env, token), "a@example.test", "mintInvite still produces a usable token");
});

test("an invite is expired exactly at its boundary (nowMs === expires)", async () => {
  const kv = memKV(); const env = envWith(kv);
  const t0 = 1_000_000_000_000;
  const t = await W.mintInvite(env, "a@example.test", t0);
  assert.equal(await W.readInvite(env, t, t0 + W.INVITE_TTL_MS), null, "expires is exclusive: nowMs === expires reads as expired");
});

const ROSTER = [{ email: "a@example.test", name: "A" }];

function invitePostRequest(token, password) {
  const body = new URLSearchParams({ token, password });
  return new Request("https://example.test/__invite", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

test("redeeming an invite stores a hash and signs the user in", async () => {
  const kv = memKV(); const env = envWith(kv, { SESSION_SECRET: "s3cret" });
  const t = await W.mintInvite(env, "a@example.test");
  const res = await W.invitePost(invitePostRequest(t, "a good long password"), new URL("https://example.test/__invite"), env, ROSTER);
  assert.equal(res.status, 303);
  const cookie = res.headers.get("Set-Cookie") || "";
  assert.match(cookie, /^gv_user=a%40example\.test\.|^gv_user=a@example\.test\./, "session cookie issued");
  const stored = JSON.parse(await kv.get("users:secrets"))["a@example.test"];
  assert.ok(W.isPassHash(stored), "stored as a hash, never plaintext");
  assert.equal(await W.verifyPassword("a good long password", stored), true);
});

test("an invite cannot be redeemed twice", async () => {
  const kv = memKV(); const env = envWith(kv, { SESSION_SECRET: "s3cret" });
  const t = await W.mintInvite(env, "a@example.test");
  await W.invitePost(invitePostRequest(t, "a good long password"), new URL("https://example.test/__invite"), env, ROSTER);
  const again = await W.invitePost(invitePostRequest(t, "another long password"), new URL("https://example.test/__invite"), env, ROSTER);
  assert.equal(again.status, 400);
  assert.equal(await W.verifyPassword("a good long password", JSON.parse(await kv.get("users:secrets"))["a@example.test"]), true, "first password still stands");
});

test("a short password is rejected and nothing is stored", async () => {
  const kv = memKV(); const env = envWith(kv, { SESSION_SECRET: "s3cret" });
  const t = await W.mintInvite(env, "a@example.test");
  const res = await W.invitePost(invitePostRequest(t, "short"), new URL("https://example.test/__invite"), env, ROSTER);
  assert.equal(res.status, 400);
  assert.equal(await kv.get("users:secrets"), null, "no secret written");
  assert.equal(await W.readInvite(env, t), "a@example.test", "token survives a failed attempt");
});

test("a token for an unknown roster entry is refused", async () => {
  const kv = memKV(); const env = envWith(kv, { SESSION_SECRET: "s3cret" });
  const t = await W.mintInvite(env, "ghost@example.test");
  const res = await W.invitePost(invitePostRequest(t, "a good long password"), new URL("https://example.test/__invite"), env, ROSTER);
  assert.equal(res.status, 400);
});

// ---- Finding 1: invitePost must key users:secrets by the roster's canonical
// u.email, not the invite's raw-case email — effectiveSecret's reader does an
// exact-case hasOwnProperty lookup on u.email, so any case mismatch means the
// hash lands under a key nothing reads and effectiveSecret falls through to
// the roster's `pass`, which during this migration is the leaked seed password.

test("invitePost stores the secret under the roster's canonical email, not the invite's raw case", async () => {
  const kv = memKV(); const env = envWith(kv, { SESSION_SECRET: "s3cret" });
  const rosterUser = { email: "mixed@example.test", name: "Mixed", pass: "leaked-seed" };
  const roster = [rosterUser];
  const t = await W.mintInvite(env, "Mixed@Example.test"); // invite minted with different case
  const res = await W.invitePost(
    invitePostRequest(t, "a good long password"),
    new URL("https://example.test/__invite"),
    env,
    roster
  );
  assert.equal(res.status, 303);

  const secret = await W.effectiveSecret(env, rosterUser);
  assert.ok(W.isPassHash(secret), "effectiveSecret must return the pbkdf2 hash the user just set");
  assert.equal(await W.verifyPassword("a good long password", secret), true);
  assert.notEqual(secret, "leaked-seed", "must NOT fall through to the leaked roster password");
});

// ---- Finding 2: a KV failure after consumeInvite must fail cleanly (500),
// never leak the exception and never leave the user with a burned token and
// no way to know what happened.

test("a KV failure after the token is consumed fails cleanly instead of throwing", async () => {
  const kv = memKV(); const env = envWith(kv, { SESSION_SECRET: "s3cret" });
  const t = await W.mintInvite(env, "a@example.test");
  const realPut = kv.put.bind(kv);
  kv.put = async (k, v) => {
    if (k === "users:secrets") throw new Error("simulated KV outage");
    return realPut(k, v);
  };
  const res = await W.invitePost(invitePostRequest(t, "a good long password"), new URL("https://example.test/__invite"), env, ROSTER);
  assert.equal(res.status, 500);
  assert.equal(await W.readInvite(env, t), null, "the token was already consumed and is not restored");
});

// ---- Finding 3: the most exposed endpoint in the codebase — cookie hardening
// and HTML-escaping — had no direct test coverage.

test("invitePost success sets a hardened cookie: Path=/, HttpOnly, Secure, SameSite=Lax, <email>.<token> shape", async () => {
  const kv = memKV(); const env = envWith(kv, { SESSION_SECRET: "s3cret" });
  const t = await W.mintInvite(env, "a@example.test");
  const res = await W.invitePost(invitePostRequest(t, "a good long password"), new URL("https://example.test/__invite"), env, ROSTER);
  const cookie = res.headers.get("Set-Cookie") || "";
  assert.match(cookie, /Path=\//, "Path=/ present");
  assert.match(cookie, /HttpOnly/, "HttpOnly present");
  assert.match(cookie, /Secure/, "Secure present");
  assert.match(cookie, /SameSite=Lax/, "SameSite=Lax present");
  const rawValue = cookie.split(";")[0].slice("gv_user=".length);
  const value = decodeURIComponent(rawValue);
  assert.match(value, /^a@example\.test\.[0-9a-fA-F]+$/, "<email>.<token> shape");
});

test("invitePage escapes a hostile token so it cannot break out of value=\"...\"", () => {
  const hostile = `"><script>alert(1)</script>&`;
  const html = W.invitePage(hostile, null);
  const attrMatch = html.match(/name="token" value="([^"]*)"\s*\/>/);
  assert.ok(attrMatch, "the hidden input still parses as a single well-formed attribute");
  assert.equal(attrMatch[1].includes('"'), false, "no raw quote breaks out of the value attribute");
  assert.match(attrMatch[1], /&quot;.*&lt;script&gt;.*&amp;/s, "hostile content is HTML-escaped in place");
});

// ---- Task 6: admin API manages people, not credentials ----------------------

const ADMIN = { email: "admin@example.test", name: "Admin", role: "admin" };
const PLAIN = { email: "u@example.test", name: "U" };

function adminGet() { return new Request("https://example.test/__admin/users"); }
function adminPost(body) {
  return new Request("https://example.test/__admin/users", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

test("admin GET never returns a password or hash", async () => {
  const h = await W.hashPassword("a good long password");
  const kv = memKV({ "users:secrets": JSON.stringify({ "u@example.test": h }) });
  const env = envWith(kv);
  const res = await W.adminUsersApi(adminGet(), new URL("https://example.test/__admin/users"), env, ADMIN, [ADMIN, PLAIN]);
  const body = await res.json();
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes("pbkdf2$"), "no hash in the response");
  assert.ok(!/"pass"/.test(serialized), "no pass field at all");
  const u = body.users.find((x) => x.email === "u@example.test");
  assert.equal(u.state, "accepted");
  assert.equal(body.users.find((x) => x.email === "admin@example.test").state, "pending");
});

test("admin GET is forbidden to non-admins", async () => {
  const env = envWith(memKV());
  const res = await W.adminUsersApi(adminGet(), new URL("https://example.test/__admin/users"), env, PLAIN, [ADMIN, PLAIN]);
  assert.equal(res.status, 403);
});

test("reset clears the secret and returns a fresh invite link", async () => {
  const h = await W.hashPassword("a good long password");
  const kv = memKV({ "users:secrets": JSON.stringify({ "u@example.test": h }) });
  const env = envWith(kv);
  const res = await W.adminUsersApi(adminPost({ op: "reset", email: "u@example.test" }),
    new URL("https://example.test/__admin/users"), env, ADMIN, [ADMIN, PLAIN]);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.match(body.url, /^https:\/\/example\.test\/__invite\?t=/);
  const secrets = JSON.parse(await kv.get("users:secrets"));
  assert.ok(!secrets["u@example.test"], "old secret cleared — the password dies now");
  const token = new URL(body.url).searchParams.get("t");
  assert.equal(await W.readInvite(env, token), "u@example.test");
});

test("the password-setting endpoint is gone", async () => {
  const env = envWith(memKV());
  const res = await W.adminUsersApi(adminPost({ email: "u@example.test", pass: "hunter2hunter2" }),
    new URL("https://example.test/__admin/users"), env, ADMIN, [ADMIN, PLAIN]);
  assert.equal(res.status, 400, "no op:reset → rejected; admins cannot set passwords");
  assert.equal(await env.COMMENTS.get("users:secrets"), null);
});

test("reset writes a tombstone, not a deletion, so the password cannot leak via fallback", async () => {
  // The most critical invariant: when a user with a roster password is reset,
  // the override map must contain {email: null} (a tombstone), not an absent key.
  // If a key is absent, effectiveSecret falls back to u.pass — the revoked password.
  const LEAKY = { email: "leaky@example.test", name: "Leaky", pass: "leaked-seed-2026" };
  const rosterWithLeaky = [ADMIN, LEAKY];

  // Seed the user with a real hash so they start as "accepted".
  const hash = await W.hashPassword("leaked-seed-2026");
  const kv = memKV({ "users:secrets": JSON.stringify({ "leaky@example.test": hash }) });
  const env = envWith(kv);

  // Verify the user starts in "accepted" state (has a secret).
  const beforeSecret = await W.effectiveSecret(env, LEAKY);
  assert.equal(await W.verifyPassword("leaked-seed-2026", beforeSecret), true);

  // Call reset.
  const res = await W.adminUsersApi(adminPost({ op: "reset", email: "leaky@example.test" }),
    new URL("https://example.test/__admin/users"), env, ADMIN, rosterWithLeaky);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);

  // ---- Regression assertion 1: effectiveSecret must return "" not the password ----
  const afterSecret = await W.effectiveSecret(env, LEAKY);
  assert.equal(afterSecret, "", "reset must revoke by yielding empty string");
  assert.notEqual(afterSecret, "leaked-seed-2026", "CRITICAL: must NOT leak the roster password");

  // ---- Regression assertion 2: the key must exist in the map (tombstone, not deleted) ----
  const secrets = JSON.parse(await kv.get("users:secrets"));
  assert.ok(
    Object.prototype.hasOwnProperty.call(secrets, "leaky@example.test"),
    "the email key must exist in the secrets map (as a tombstone)"
  );
  assert.equal(secrets["leaky@example.test"], null, "the value at that key must be null");

  // ---- Regression assertion 3: follow-up GET reports state as "pending" ----
  const getRes = await W.adminUsersApi(adminGet(),
    new URL("https://example.test/__admin/users"), env, ADMIN, rosterWithLeaky);
  const getBody = await getRes.json();
  const leakyUser = getBody.users.find((u) => u.email === "leaky@example.test");
  assert.equal(leakyUser.state, "pending", "after reset, the user must be in pending state");
});
