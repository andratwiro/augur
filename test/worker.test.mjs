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

test("verifyPassword rejects malformed hashes without throwing", async () => {
  assert.equal(await W.verifyPassword("x", "pbkdf2$100000$notbase64!!$also!!"), false);
  assert.equal(await W.verifyPassword("x", "pbkdf2$onlythree$parts"), false);
  assert.equal(await W.verifyPassword("x", null), false);
});

test("verifyPassword rejects a non-hash stored value outright, never by string comparison", async () => {
  assert.equal(await W.verifyPassword("augur-legacy-2026", "augur-legacy-2026"), false);
  assert.equal(await W.verifyPassword("nope", "augur-legacy-2026"), false);
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

// ---- CRITICAL: a user with NO effective secret must have no valid session.
// With no secret, userToken's own no-SESSION_SECRET fallback collapses to a publicly
// computable digest: tokenFor("<email>:") = SHA-256("gv:<email>:") — no secret in it
// at all. Anyone who knows an email could mint that and be signed in as them,
// including an admin who has been reset but not yet redeemed.

test("identify refuses a secretless forgery for a tombstoned user", async () => {
  const LEAKY = { email: "leaky@example.test", name: "Leaky", pass: "leaked-seed-2026" };
  const kv = memKV({ "users:secrets": JSON.stringify({ "leaky@example.test": null }) });
  const env = envWith(kv, { SESSION_SECRET: "s3cret" });
  assert.equal(await W.effectiveSecret(env, LEAKY), "", "precondition: reset left no secret");
  const forged = await W.tokenFor(LEAKY.email + ":"); // needs no credential whatsoever
  assert.equal(
    await W.identify(cookieRequest(`${LEAKY.email}.${forged}`), env, [LEAKY]),
    null,
    "a reset user must not be impersonable with a publicly computable digest"
  );
});

test("identify refuses a secretless forgery for a never-invited admin", async () => {
  const PENDING = { email: "pending@example.test", name: "Pending", role: "admin" };
  const env = envWith(memKV(), { SESSION_SECRET: "s3cret" }); // no users:secrets at all
  assert.equal(await W.effectiveSecret(env, PENDING), "", "precondition: never invited");
  const forged = await W.tokenFor(PENDING.email + ":");
  assert.equal(
    await W.identify(cookieRequest(`${PENDING.email}.${forged}`), env, [PENDING]),
    null,
    "knowing an email must not grant the admin API and admin-only spaces"
  );
});

test("identify refuses the secretless forgery with SESSION_SECRET unset too", async () => {
  // userToken's own fallback has the identical shape and carries no TEMPORARY
  // marker, so deleting the marked migration paths would NOT close this.
  const PENDING = { email: "pending@example.test", name: "Pending" };
  const env = envWith(memKV()); // no SESSION_SECRET
  const forged = await W.tokenFor(PENDING.email + ":");
  assert.equal(forged, await W.userToken(env, PENDING), "precondition: userToken's own fallback matches");
  assert.equal(await W.identify(cookieRequest(`${PENDING.email}.${forged}`), env, [PENDING]), null);
});

// ---- effectiveSecret must FAIL CLOSED on a KV failure. A blanket catch that falls
// through to the roster makes every tombstone evaporate at once and puts every leaked
// roster password back in service on a transient read error.

test("effectiveSecret fails closed when the KV read throws", async () => {
  const kv = memKV();
  kv.get = async () => { throw new Error("simulated KV outage"); };
  const env = envWith(kv);
  const result = await W.effectiveSecret(env, { email: "a@example.test", pass: "leaked-seed" });
  assert.equal(result, "", "a read failure must never resurrect a revoked credential");
  assert.notEqual(result, "leaked-seed", "must NOT fall back to the roster password");
});

test("effectiveSecret fails closed on a corrupt users:secrets value", async () => {
  const env = envWith(memKV({ "users:secrets": "{not json" }));
  const result = await W.effectiveSecret(env, { email: "a@example.test", pass: "leaked-seed" });
  assert.equal(result, "");
  assert.notEqual(result, "leaked-seed", "must NOT fall back to the roster password");
});

test("effectiveSecret fails closed when users:secrets parses to a non-object", async () => {
  const env = envWith(memKV({ "users:secrets": "42" }));
  assert.equal(await W.effectiveSecret(env, { email: "a@example.test", pass: "leaked-seed" }), "");
});

test("effectiveSecret still falls back to the roster with NO KV binding at all", async () => {
  // Offline and raw engine builds have no KV and legitimately depend on this.
  assert.equal(await W.effectiveSecret({}, { email: "a@example.test", pass: "roster" }), "roster");
  assert.equal(await W.effectiveSecret(undefined, { email: "a@example.test", pass: "roster" }), "roster");
  assert.equal(
    await W.effectiveSecret({}, { email: "a@example.test", passHash: "pbkdf2$x", pass: "roster" }),
    "pbkdf2$x"
  );
});

// ---- typeof [] === "object", so an array value sails through a bare typeof check,
// hasOwnProperty then misses every email and EVERY user falls through to the roster
// password — the exact fail-open the corruption guard exists to prevent.

test("effectiveSecret fails closed when users:secrets is an array", async () => {
  const env = envWith(memKV({ "users:secrets": JSON.stringify([{ "a@example.test": "x" }]) }));
  assert.equal(
    await W.effectiveSecret(env, { email: "a@example.test", pass: "leaked-seed" }), "",
    "an array is corrupt, not empty — it must not fall through to the roster password"
  );
  const env2 = envWith(memKV({ "users:secrets": "[]" }));
  assert.equal(await W.effectiveSecret(env2, { email: "a@example.test", pass: "leaked-seed" }), "");
});

// ---- identify must bind the secret it GUARDED on to the secret it DERIVES from.
// Two separate effectiveSecret call sites (the guard, and userToken's own resolution)
// mean a truthy read can pass the guard while a later read returns "" — and
// tokenFor(email + ":") is publicly computable.

test("identify resolves the effective secret once, so a mid-request change cannot forge a session", async () => {
  const hash = await W.hashPassword("a properly long password");
  let n = 0;
  const kv = {
    get gets() { return n; },
    async get(k) {
      if (k !== "users:secrets") return null;
      n++;
      // First read: a live secret (passes the guard). Every later read: a tombstone.
      return JSON.stringify(n === 1 ? { "a@example.test": hash } : { "a@example.test": null });
    },
    async put() {}, async delete() {},
  };
  const env = envWith(kv, { SESSION_SECRET: "s3cret" });
  const forged = await W.tokenFor("a@example.test:"); // the secretless, publicly computable token
  const got = await W.identify(cookieRequest(`a@example.test.${forged}`), env, [USER]);
  assert.equal(got, null, "CRITICAL: a forged secretless cookie must never identify a user");
  assert.equal(kv.gets, 1, "and the secret is read exactly once per identify");
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

// ---- reset-vs-wrong-password messaging -----------------------------------------

test("the gate distinguishes a reset account from a wrong password", async () => {
  const RESET = { email: "reset@example.test", name: "Reset", pass: "old-leaked-pass" };
  const kv = memKV({ "users:secrets": JSON.stringify({ "reset@example.test": null }) });
  const env = envWith(kv);
  // Tombstoned => no effective secret => the page must say so, not "incorrect password".
  assert.equal(await W.effectiveSecret(env, RESET), "");
  const page = W.loginPage("/", W.RESET_NOTICE);
  assert.match(page, /This account was reset/);
  assert.ok(!/Incorrect email or password/.test(page), "the generic message is replaced, not appended");
  // An unknown email must still get the generic message — no enumeration of non-users.
  assert.match(W.loginPage("/", true), /Incorrect email or password/);
});

test("the reset notice is html-escaped into the page", () => {
  const page = W.loginPage("/", '<script>alert(1)</script>');
  assert.ok(!page.includes("<script>alert(1)</script>"), "escaped, not injected");
  assert.match(page, /&lt;script&gt;/);
});

// ---- Runtime roster overlay: invite + remove without a config commit ---------
// The overlay is a convenience layer; the SECURITY boundary for a removal is the
// users:secrets tombstone (which fails closed), not the list. These tests pin both.

const ADMIN_URL = new URL("https://example.test/__admin/users");
const callAdmin = (req, env, users, config = []) =>
  W.adminUsersApi(req, ADMIN_URL, env, ADMIN, users, config);

test("mergeRoster: config wins over an add of the same address", () => {
  const config = [{ email: "a@example.test", name: "Config A", role: "admin" }];
  const merged = W.mergeRoster(config, { add: { "a@example.test": { email: "a@example.test", name: "Overlay A" } }, remove: [] });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].name, "Config A");
});

test("mergeRoster: remove hides a config user and an invited one alike", () => {
  const config = [{ email: "a@example.test", name: "A" }];
  const roster = { add: { "b@example.test": { email: "b@example.test", name: "B" } }, remove: ["a@example.test", "b@example.test"] };
  assert.deepEqual(W.mergeRoster(config, roster), []);
});

test("mergeRoster: matching is case-insensitive in both directions", () => {
  const config = [{ email: "Mixed@Example.test", name: "M" }];
  assert.deepEqual(W.mergeRoster(config, { add: {}, remove: ["mixed@example.test"] }), []);
  const added = W.mergeRoster([], { add: { x: { email: "New@Example.test", name: "N" } }, remove: ["new@example.test"] });
  assert.deepEqual(added, []);
});

test("readRoster degrades to an empty overlay on junk, never throws", async () => {
  for (const junk of ["not json", "[]", "null", '"a string"', "42"]) {
    const env = envWith(memKV({ "users:roster": junk }));
    assert.deepEqual(await W.readRoster(env), { add: {}, remove: [] });
  }
});

test("invite adds the address to the overlay and returns its single-use link", async () => {
  const kv = memKV();
  const env = envWith(kv);
  const res = await callAdmin(adminPost({ op: "invite", email: "New.Person@Example.test" }), env, [ADMIN], [ADMIN]);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.email, "new.person@example.test", "stored lowercased");
  const roster = JSON.parse(await kv.get("users:roster"));
  assert.equal(roster.add["new.person@example.test"].name, "New Person", "name derived from the address");
  assert.equal(roster.add["new.person@example.test"].role, "user", "no silent admin escalation");
  const token = new URL(body.url).searchParams.get("t");
  assert.equal(await W.readInvite(env, token), "new.person@example.test");
});

test("invite refuses a malformed address and an existing user", async () => {
  const env = envWith(memKV());
  assert.equal((await callAdmin(adminPost({ op: "invite", email: "nope" }), env, [ADMIN], [ADMIN])).status, 400);
  assert.equal((await callAdmin(adminPost({ op: "invite", email: ADMIN.email }), env, [ADMIN], [ADMIN])).status, 409);
  assert.equal(await env.COMMENTS.get("users:roster"), null, "nothing written on a rejected invite");
});

test("inviting an address that carries a stale hash revokes it first", async () => {
  // Otherwise the new person arrives "accepted", holding the previous owner's password.
  const hash = await W.hashPassword("the old occupant's password");
  const kv = memKV({ "users:secrets": JSON.stringify({ "reused@example.test": hash }) });
  const env = envWith(kv);
  await callAdmin(adminPost({ op: "invite", email: "reused@example.test" }), env, [ADMIN], [ADMIN]);
  const secrets = JSON.parse(await kv.get("users:secrets"));
  assert.ok(Object.prototype.hasOwnProperty.call(secrets, "reused@example.test"), "tombstone present, not deleted");
  assert.equal(secrets["reused@example.test"], null);
  assert.equal(await W.effectiveSecret(env, { email: "reused@example.test" }), "");
});

test("remove drops a config user via the list AND tombstones their credential", async () => {
  const VICTIM = { email: "gone@example.test", name: "Gone", pass: "legacy-roster-password" };
  const hash = await W.hashPassword("legacy-roster-password");
  const kv = memKV({ "users:secrets": JSON.stringify({ "gone@example.test": hash }) });
  const env = envWith(kv);
  const res = await callAdmin(adminPost({ op: "remove", email: "gone@example.test" }),
    env, [ADMIN, VICTIM], [ADMIN, VICTIM]);
  assert.equal((await res.json()).ok, true);
  const roster = JSON.parse(await kv.get("users:roster"));
  assert.deepEqual(roster.remove, ["gone@example.test"]);
  assert.deepEqual(W.mergeRoster([ADMIN, VICTIM], roster).map((u) => u.email), [ADMIN.email]);
  // The list is only half of it: even reading the roster as empty, the tombstone holds.
  assert.equal(await W.effectiveSecret(env, VICTIM), "", "must not fall back to the roster pass");
  assert.equal(await W.identify(cookieRequest("gone@example.test." + (await W.tokenFor("gone@example.test:legacy-roster-password"))), env, [ADMIN, VICTIM]), null);
});

test("removing an invited user drops the add entry instead of growing the remove list", async () => {
  const kv = memKV();
  const env = envWith(kv);
  await callAdmin(adminPost({ op: "invite", email: "temp@example.test" }), env, [ADMIN], [ADMIN]);
  const invited = W.mergeRoster([ADMIN], JSON.parse(await kv.get("users:roster")));
  await callAdmin(adminPost({ op: "remove", email: "temp@example.test" }), env, invited, [ADMIN]);
  const roster = JSON.parse(await kv.get("users:roster"));
  assert.deepEqual(roster.add, {});
  assert.deepEqual(roster.remove, [], "no tombstone needed for someone the config never named");
});

test("remove revokes an outstanding invite link", async () => {
  const kv = memKV();
  const env = envWith(kv);
  const invited = await (await callAdmin(adminPost({ op: "invite", email: "half@example.test" }), env, [ADMIN], [ADMIN])).json();
  const token = new URL(invited.url).searchParams.get("t");
  assert.equal(await W.readInvite(env, token), "half@example.test");
  const list = W.mergeRoster([ADMIN], JSON.parse(await kv.get("users:roster")));
  await callAdmin(adminPost({ op: "remove", email: "half@example.test" }), env, list, [ADMIN]);
  assert.equal(await W.readInvite(env, token), null, "the link they already hold stops working");
});

test("an admin cannot remove themselves", async () => {
  const env = envWith(memKV());
  const res = await callAdmin(adminPost({ op: "remove", email: ADMIN.email }), env, [ADMIN], [ADMIN]);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "cannot-remove-self");
});

test("re-inviting a removed address lifts the removal", async () => {
  const VICTIM = { email: "back@example.test", name: "Back" };
  const kv = memKV();
  const env = envWith(kv);
  await callAdmin(adminPost({ op: "remove", email: VICTIM.email }), env, [ADMIN, VICTIM], [ADMIN, VICTIM]);
  assert.deepEqual(JSON.parse(await kv.get("users:roster")).remove, [VICTIM.email]);
  await callAdmin(adminPost({ op: "invite", email: VICTIM.email }), env, [ADMIN], [ADMIN, VICTIM]);
  assert.deepEqual(JSON.parse(await kv.get("users:roster")).remove, []);
});

test("an unknown op still changes nothing", async () => {
  const env = envWith(memKV());
  const res = await callAdmin(adminPost({ op: "promote", email: "u@example.test" }), env, [ADMIN], [ADMIN]);
  assert.equal(res.status, 400);
  assert.equal(await env.COMMENTS.get("users:roster"), null);
});

// ---- Content ownership: the store is the only source of space content --------
// These cover the invariant the publish-only cutover rests on. The bug they
// prevent is subtle: an artifact that LOOKS like shared chrome but is derived
// from a space gets republished by CI from a pinned checkout, silently reverting
// whatever the space published directly. Four files were in that state.

// A space's manifest as the store holds it: content plus the routing fragment the
// worker merges to derive site-wide state.
const manifestOf = (id, { def = false, catalog = [], tracks = [], ...rest } = {}) => ({
  id, format: 1, files: {},
  space: { id, default: def },
  routing: { publicPrefixes: [], versionMap: {}, canvasCatalog: catalog, canvasTracks: tracks },
  ...rest,
});

test("canvas catalog merges every space's slice, not just the last publisher's", async () => {
  W.applyDerivedRouting({
    _engine: { id: "_engine", routing: { canvasLoaderExtras: "<!--x-->" } },
    alpha: manifestOf("alpha", { def: true, catalog: [{ url: "/a/", title: "A" }], tracks: [{ id: "t1" }] }),
    beta: manifestOf("beta", { catalog: [{ url: "/beta/b/", title: "B" }] }),
  });
  const merged = await W.canvasAggregate("catalog").json();
  assert.deepEqual(merged.map((e) => e.url), ["/a/", "/beta/b/"],
    "both spaces contribute — publishing one must not blank the other");
  assert.deepEqual((await W.canvasAggregate("tracks").json()).map((t) => t.id), ["t1"]);
});

test("a space that has never published contributes nothing rather than erasing others", async () => {
  W.applyDerivedRouting({
    alpha: manifestOf("alpha", { def: true, catalog: [{ url: "/a/" }] }),
    beta: { id: "beta", format: 1, files: {}, space: { id: "beta" } }, // no routing at all
  });
  assert.deepEqual((await W.canvasAggregate("catalog").json()).map((e) => e.url), ["/a/"]);
});

test("the build stamp reports publish provenance, and flags a working-tree publish", () => {
  const stamp = W.synthBuildStamp({
    _engine: { id: "_engine", version: 27, publishedAt: "2026-08-09T08:00:00.000Z", source: { sha: "e".repeat(40) } },
    alpha: {
      id: "alpha", version: 15, publishedAt: "2026-08-09T07:00:00.000Z", publishedBy: "rob",
      source: { sha: "a".repeat(40), dirty: true },
    },
  });
  assert.equal(stamp.spaces.alpha.version, 15);
  assert.equal(stamp.spaces.alpha.publishedBy, "rob");
  assert.equal(stamp.spaces.alpha.dirty, true, "a dirty publish must never be silent");
  assert.equal(stamp.engine.version, 27);
  assert.equal(stamp.builtAt, "2026-08-09T08:00:00.000Z", "newest publish across the store");
});

test("a clean publish carries no dirty flag at all (absent, not false)", () => {
  const stamp = W.synthBuildStamp({ alpha: { id: "alpha", version: 2, source: { sha: "a".repeat(40) } } });
  assert.equal("dirty" in stamp.spaces.alpha, false);
});

// ---- Delete forever actually deletes ----------------------------------------

test("repo path → live URL prefix, per space base", () => {
  W.applyDerivedRouting({
    alpha: manifestOf("alpha", { def: true }),
    beta: manifestOf("beta"),
  });
  assert.equal(W.deleteUrlPrefix("alpha", "onboarding/prototypes/signup"), "/onboarding/signup/",
    "the default space serves at the root and drops the prototypes/ segment");
  assert.equal(W.deleteUrlPrefix("beta", "onboarding/prototypes/signup"), "/beta/onboarding/signup/");
  assert.equal(W.deleteUrlPrefix("alpha", "playground/sketch"), "/playground/sketch/");
  assert.equal(W.deleteUrlPrefix("nope", "playground/sketch"), null,
    "an unknown space must not fall back to the root form and aim at the default space");
});

// Minimal in-memory R2 mirroring the subset removeFromStore uses.
function memR2(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(k) { return store.has(k) ? { text: async () => store.get(k) } : null; },
    async put(k, v) { store.set(k, typeof v === "string" ? v : JSON.stringify(v)); },
  };
}

test("deleting a prototype removes its files and its routing entries, as a new version", async () => {
  const live = {
    id: "alpha", version: 4, files: {
      "/index.html": { h: "1" },
      "/onboarding/signup/index.html": { h: "2" },
      "/onboarding/signup/preview.webp": { h: "3" },
      "/onboarding/login/index.html": { h: "4" },
    },
    routing: {
      publicPrefixes: ["/onboarding/signup/", "/onboarding/login/"],
      versionMap: { "/onboarding/signup/": "1", "/onboarding/login/": "2" },
      canvasCatalog: [{ url: "/onboarding/signup/" }, { url: "/onboarding/login/" }],
    },
  };
  const env = { BUNDLES: memR2({ "spaces/alpha/manifest.json": JSON.stringify(live) }) };
  const res = await W.removeFromStore(env, "alpha", "/onboarding/signup/", "admin@example.test");
  assert.equal(res.removed, 2);
  assert.equal(res.version, 5);

  const after = JSON.parse(env.BUNDLES.store.get("spaces/alpha/manifest.json"));
  assert.deepEqual(Object.keys(after.files), ["/index.html", "/onboarding/login/index.html"]);
  assert.deepEqual(after.routing.publicPrefixes, ["/onboarding/login/"],
    "the gate must stop advertising a path that now resolves to nothing");
  assert.deepEqual(Object.keys(after.routing.versionMap), ["/onboarding/login/"]);
  assert.deepEqual(after.routing.canvasCatalog, [{ url: "/onboarding/login/" }]);
  assert.ok(env.BUNDLES.store.has("spaces/alpha/versions/5.json"), "rollback must be able to undo it");
});

test("deleting something that isn't there changes nothing (no empty version bump)", async () => {
  const live = { id: "alpha", version: 4, files: { "/index.html": { h: "1" } } };
  const env = { BUNDLES: memR2({ "spaces/alpha/manifest.json": JSON.stringify(live) }) };
  const res = await W.removeFromStore(env, "alpha", "/gone/", "admin@example.test");
  assert.equal(res.removed, 0);
  assert.equal(JSON.parse(env.BUNDLES.store.get("spaces/alpha/manifest.json")).version, 4);
});

// ---- Security hardening pass (2026-08-09) ------------------------------------

test("login throttle trips after LOGIN_MAX_FAILS and blocks further attempts", async () => {
  const kv = memKV();
  const env = envWith(kv);
  const ids = ["rl:login:em:t@example.test", "rl:login:ip:203.0.113.9"];
  for (let i = 0; i < W.LOGIN_MAX_FAILS; i++) {
    assert.equal(await W.loginThrottled(env, ids), false, `not throttled at attempt ${i}`);
    await W.loginFail(env, ids);
  }
  assert.equal(await W.loginThrottled(env, ids), true, "throttled once the ceiling is hit");
  // A different IP is independent — one target being hammered doesn't lock everyone.
  assert.equal(await W.loginThrottled(env, ["rl:login:ip:198.51.100.1"]), false);
});

test("login throttle no-ops without a KV binding (offline never locks out)", async () => {
  assert.equal(await W.loginThrottled({}, ["rl:login:em:x"]), false);
  await W.loginFail({}, ["rl:login:em:x"]); // must not throw
});

test("dummyHash is a valid pbkdf2 string at the current iteration count", async () => {
  const h = await W.dummyHash();
  assert.ok(W.isPassHash(h));
  assert.ok(h.startsWith("pbkdf2$" + W.PBKDF2_ITERATIONS + "$"), "uses the current cost");
  // Verifying a wrong password against it returns false without throwing — its only
  // job is to make the timing of an unknown email match a known one.
  assert.equal(await W.verifyPassword("anything", h), false);
});

test("revokePublishTokens drops exactly the removed user's tokens", async () => {
  const kv = memKV({ "publish:tokens": JSON.stringify({
    h1: { space: "*", label: "gone@example.test", createdAt: "x" },
    h2: { space: "space-alpha", label: "gone@example.test", createdAt: "y" }, // case-different label handled by lcEmail
    h3: { space: "space-alpha", label: "keep@example.test", createdAt: "z" },
  }) });
  await W.revokePublishTokens(envWith(kv), "GONE@example.test");
  const map = JSON.parse(await kv.get("publish:tokens"));
  assert.deepEqual(Object.keys(map), ["h3"], "only the other user's token survives");
});

test("pathOwnedBySpace: a non-default space owns only its own subtree", () => {
  const spaces = [{ id: "space-alpha", default: true }, { id: "space-beta" }];
  assert.equal(W.pathOwnedBySpace("/space-beta/pages/x/", "space-beta", spaces), true);
  assert.equal(W.pathOwnedBySpace("/departments/x/", "space-beta", spaces), false, "not its base");
  assert.equal(W.pathOwnedBySpace("/admin/index.html", "space-beta", spaces), false, "engine chrome");
});

test("pathOwnedBySpace: the default space owns root EXCEPT engine chrome and other bases", () => {
  const spaces = [{ id: "space-alpha", default: true }, { id: "space-beta" }];
  assert.equal(W.pathOwnedBySpace("/departments/x/", "space-alpha", spaces), true);
  assert.equal(W.pathOwnedBySpace("/__canvas/canvas.js", "space-alpha", spaces), false, "engine internals");
  assert.equal(W.pathOwnedBySpace("/admin/app.js", "space-alpha", spaces), false, "the admin panel");
  assert.equal(W.pathOwnedBySpace("/space-beta/pages/x/", "space-alpha", spaces), false, "the other space");
  assert.equal(W.pathOwnedBySpace("relative", "space-alpha", spaces), false, "must be absolute");
});

test("the redeem page shows the target email read-only, and hides it when unknown", () => {
  const withEmail = W.invitePage("tok", "", "tali@example.test");
  assert.match(withEmail, /tali@example\.test/);
  assert.match(withEmail, /readonly/);
  const without = W.invitePage("tok", "");
  assert.ok(!/readonly/.test(without), "no email field when none is passed");
});

test("the redeem page html-escapes the target email (no attribute breakout)", () => {
  const page = W.invitePage("tok", "", '"><script>alert(1)</script>@x');
  assert.ok(!page.includes('"><script>'), "escaped, not injected");
  assert.match(page, /&quot;&gt;/);
});

test("synthBuildStamp redacts the publisher email to a display name", () => {
  // publishedBy is the token label (an email); the public build stamp must not leak it.
  const manifests = {
    "space-alpha": { source: { sha: "abc" }, version: 3, publishedAt: "2026-08-09T00:00:00Z", publishedBy: "rob@example.test" },
  };
  const stamp = W.synthBuildStamp(manifests);
  const s = JSON.stringify(stamp);
  assert.ok(!s.includes("rob@example.test"), "raw email must not appear");
  // With no roster loaded it falls back to the local-part — still no domain.
  assert.match(stamp.spaces["space-alpha"].publishedBy, /^rob$/);
});
