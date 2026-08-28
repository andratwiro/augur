// Unit tests for the pure helpers in src/_worker.js (imported directly — the file's
// top level is all const/function definitions, so importing is side-effect free and
// the build-injected placeholders stay inert empty values). Zero dependencies:
// node --test + node:assert + the global Web Crypto.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";
import { emptyTenantContext } from "../src/tenant-context.mjs";

// There is no module roster left to be inert: identity belongs to a workspace, and a
// workspace nothing has configured is `emptyTenantContext()` — whose USERS is empty, so
// a raw copy resolves nobody and therefore gates nothing. Same claim as before, asked of
// the value that now holds it rather than of a global.
test("an unconfigured workspace resolves nobody (raw copy gates nothing)", () => {
  assert.deepEqual(emptyTenantContext().USERS, []);
  assert.equal(W.userByEmail("nobody@example.test", emptyTenantContext().USERS), null);
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
  const t = await W.mintInvite(null, env, "a@example.test");
  assert.match(t, /^[A-Za-z0-9_-]{20,}$/, "url-safe, high entropy");
  assert.equal(await W.readInvite(null, env, t), "a@example.test");
});

test("an invite is single-use", async () => {
  const kv = memKV(); const env = envWith(kv);
  const t = await W.mintInvite(null, env, "a@example.test");
  assert.equal(await W.consumeInvite(null, env, t), "a@example.test");
  assert.equal(await W.consumeInvite(null, env, t), null, "second use fails");
  assert.equal(await W.readInvite(null, env, t), null);
});

test("an invite expires after the TTL", async () => {
  const kv = memKV(); const env = envWith(kv);
  const t0 = 1_000_000_000_000;
  const t = await W.mintInvite(null, env, "a@example.test", t0);
  assert.equal(await W.readInvite(null, env, t, t0 + W.INVITE_TTL_MS - 1), "a@example.test");
  assert.equal(await W.readInvite(null, env, t, t0 + W.INVITE_TTL_MS + 1), null, "expired");
  assert.equal(await W.consumeInvite(null, env, t, t0 + W.INVITE_TTL_MS + 1), null);
});

test("minting a new invite invalidates that user's outstanding ones", async () => {
  const kv = memKV(); const env = envWith(kv);
  const first = await W.mintInvite(null, env, "a@example.test");
  const second = await W.mintInvite(null, env, "a@example.test");
  assert.equal(await W.readInvite(null, env, first), null, "old link is dead");
  assert.equal(await W.readInvite(null, env, second), "a@example.test");
});

test("minting for one user leaves another user's invite alone", async () => {
  const kv = memKV(); const env = envWith(kv);
  const a = await W.mintInvite(null, env, "a@example.test");
  await W.mintInvite(null, env, "b@example.test");
  assert.equal(await W.readInvite(null, env, a), "a@example.test");
});

test("unknown tokens read as null", async () => {
  const kv = memKV(); const env = envWith(kv);
  assert.equal(await W.readInvite(null, env, "nope"), null);
  assert.equal(await W.readInvite(null, env, ""), null);
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
  const t = await W.mintInvite(null, env, "a@example.test");
  kv.getCounts.clear(); // only count gets during consumeInvite itself
  const email = await W.consumeInvite(null, env, t);
  assert.equal(email, "a@example.test");
  assert.equal(kv.getCounts.get("users:invites"), 1, "consumeInvite must do exactly one get of users:invites");
});

test("a corrupt invites map degrades to no invites instead of throwing", async () => {
  const kv = memKV({ "users:invites": "{not json" });
  const env = envWith(kv);
  await assert.doesNotReject(async () => {
    assert.equal(await W.readInvite(null, env, "anything"), null);
  });
  await assert.doesNotReject(async () => {
    assert.equal(await W.consumeInvite(null, env, "anything"), null);
  });
  let token;
  await assert.doesNotReject(async () => {
    token = await W.mintInvite(null, env, "a@example.test");
  });
  assert.equal(await W.readInvite(null, env, token), "a@example.test", "mintInvite still produces a usable token");
});

test("an invite is expired exactly at its boundary (nowMs === expires)", async () => {
  const kv = memKV(); const env = envWith(kv);
  const t0 = 1_000_000_000_000;
  const t = await W.mintInvite(null, env, "a@example.test", t0);
  assert.equal(await W.readInvite(null, env, t, t0 + W.INVITE_TTL_MS), null, "expires is exclusive: nowMs === expires reads as expired");
});

const ROSTER = [{ email: "a@example.test", name: "A" }];

// An empty workspace context — no config, no workspaces mounted. The pages these tests
// render are the SIGNED-OUT ones, and they have to render on a deployment that has
// published nothing at all, so the fixture is deliberately bare.
const BARE = W.applyDerivedRouting({});

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
  const t = await W.mintInvite(null, env, "a@example.test");
  const res = await W.invitePost(BARE, invitePostRequest(t, "a good long password"), new URL("https://example.test/__invite"), env, ROSTER);
  assert.equal(res.status, 303);
  const cookie = res.headers.get("Set-Cookie") || "";
  assert.match(cookie, /^__Host-augur_user=a%40example\.test\.|^__Host-augur_user=a@example\.test\./, "session cookie issued");
  const stored = JSON.parse(await kv.get("users:secrets"))["a@example.test"];
  assert.ok(W.isPassHash(stored), "stored as a hash, never plaintext");
  assert.equal(await W.verifyPassword("a good long password", stored), true);
});

test("an invite cannot be redeemed twice", async () => {
  const kv = memKV(); const env = envWith(kv, { SESSION_SECRET: "s3cret" });
  const t = await W.mintInvite(null, env, "a@example.test");
  await W.invitePost(BARE, invitePostRequest(t, "a good long password"), new URL("https://example.test/__invite"), env, ROSTER);
  const again = await W.invitePost(BARE, invitePostRequest(t, "another long password"), new URL("https://example.test/__invite"), env, ROSTER);
  assert.equal(again.status, 400);
  assert.equal(await W.verifyPassword("a good long password", JSON.parse(await kv.get("users:secrets"))["a@example.test"]), true, "first password still stands");
});

test("a short password is rejected and nothing is stored", async () => {
  const kv = memKV(); const env = envWith(kv, { SESSION_SECRET: "s3cret" });
  const t = await W.mintInvite(null, env, "a@example.test");
  const res = await W.invitePost(BARE, invitePostRequest(t, "short"), new URL("https://example.test/__invite"), env, ROSTER);
  assert.equal(res.status, 400);
  assert.equal(await kv.get("users:secrets"), null, "no secret written");
  assert.equal(await W.readInvite(null, env, t), "a@example.test", "token survives a failed attempt");
});

test("a token for an unknown roster entry is refused", async () => {
  const kv = memKV(); const env = envWith(kv, { SESSION_SECRET: "s3cret" });
  const t = await W.mintInvite(null, env, "ghost@example.test");
  const res = await W.invitePost(BARE, invitePostRequest(t, "a good long password"), new URL("https://example.test/__invite"), env, ROSTER);
  assert.equal(res.status, 400);
});

// ---- The iteration ceiling, and the ordering that keeps a link alive through a failure.
// These two tests exist because raising PBKDF2_ITERATIONS to 600k shipped green: Node's
// crypto has no iteration cap, so every functional test above still passed while the
// deployed worker could not hash a password at all, and each redemption attempt burned the
// link on its way to a 500. Hence one assertion Node cannot paper over, and one that pins
// the ordering.
test("PBKDF2_ITERATIONS stays within the Workers WebCrypto ceiling (100k)", () => {
  // Workers' deriveBits THROWS above 100_000 (measured: 100_000 verifies, 100_001 throws).
  // Node does not, so this cannot be a roundtrip test — it has to be an explicit bound.
  assert.ok(W.PBKDF2_ITERATIONS <= 100000,
    `PBKDF2_ITERATIONS=${W.PBKDF2_ITERATIONS} exceeds the 100k Workers cap: deriving would throw in production`);
});

test("a hashing failure leaves the invite redeemable (hash before consume)", async () => {
  const kv = memKV(); const env = envWith(kv, { SESSION_SECRET: "s3cret" });
  const t = await W.mintInvite(null, env, "a@example.test");
  // Stand in for what a rejected iteration count does inside WebCrypto.
  const realDeriveBits = crypto.subtle.deriveBits;
  crypto.subtle.deriveBits = () => { throw new Error("Not implemented: iterations too large"); };
  let res;
  try {
    res = await W.invitePost(BARE, invitePostRequest(t, "a good long password"), new URL("https://example.test/__invite"), env, ROSTER);
  } finally {
    crypto.subtle.deriveBits = realDeriveBits;
  }
  assert.equal(res.status, 500, "the attempt fails");
  assert.equal(await kv.get("users:secrets"), null, "no secret written");
  assert.equal(await W.readInvite(null, env, t), "a@example.test", "the link SURVIVES — retrying once the cause is fixed works");
  // And it really is still redeemable, not merely present.
  const ok = await W.invitePost(BARE, invitePostRequest(t, "a good long password"), new URL("https://example.test/__invite"), env, ROSTER);
  assert.equal(ok.status, 303, "same link redeems normally afterwards");
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
  const t = await W.mintInvite(null, env, "Mixed@Example.test"); // invite minted with different case
  const res = await W.invitePost(
    BARE,
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
  const t = await W.mintInvite(null, env, "a@example.test");
  const realPut = kv.put.bind(kv);
  kv.put = async (k, v) => {
    if (k === "users:secrets") throw new Error("simulated KV outage");
    return realPut(k, v);
  };
  const res = await W.invitePost(BARE, invitePostRequest(t, "a good long password"), new URL("https://example.test/__invite"), env, ROSTER);
  assert.equal(res.status, 500);
  assert.equal(await W.readInvite(null, env, t), null, "the token was already consumed and is not restored");
});

// ---- Finding 3: the most exposed endpoint in the codebase — cookie hardening
// and HTML-escaping — had no direct test coverage.

test("invitePost success sets a hardened cookie: Path=/, HttpOnly, Secure, SameSite=Lax, <email>.<token> shape", async () => {
  const kv = memKV(); const env = envWith(kv, { SESSION_SECRET: "s3cret" });
  const t = await W.mintInvite(null, env, "a@example.test");
  const res = await W.invitePost(BARE, invitePostRequest(t, "a good long password"), new URL("https://example.test/__invite"), env, ROSTER);
  const cookie = res.headers.get("Set-Cookie") || "";
  assert.match(cookie, /Path=\//, "Path=/ present");
  assert.match(cookie, /HttpOnly/, "HttpOnly present");
  assert.match(cookie, /Secure/, "Secure present");
  assert.match(cookie, /SameSite=Lax/, "SameSite=Lax present");
  // The three the `__Host-` prefix makes mandatory: Path=/ and Secure above, and no
  // Domain at all. A browser drops the whole cookie if any of them is missing.
  assert.equal(/;\s*Domain=/i.test(cookie), false, "no Domain attribute");
  // Split on the first "=", never a hardcoded name length: the name is renameable (there
  // is a live migration window on it) and a stale literal here silently shifts the value
  // rather than failing on the name, which reads as a corrupt token.
  const pair = cookie.split(";")[0];
  assert.match(pair, /^__Host-/, "issued under a __Host- prefixed name");
  const rawValue = pair.slice(pair.indexOf("=") + 1);
  const value = decodeURIComponent(rawValue);
  assert.match(value, /^a@example\.test\.[0-9a-fA-F]+$/, "<email>.<token> shape");
});

test("invitePage escapes a hostile token so it cannot break out of value=\"...\"", () => {
  const hostile = `"><script>alert(1)</script>&`;
  const html = W.invitePage(BARE, hostile, null);
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
  const res = await W.adminUsersApi(BARE, adminGet(), new URL("https://example.test/__admin/users"), env, ADMIN, [ADMIN, PLAIN]);
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
  const res = await W.adminUsersApi(BARE, adminGet(), new URL("https://example.test/__admin/users"), env, PLAIN, [ADMIN, PLAIN]);
  assert.equal(res.status, 403);
});

test("reset clears the secret and returns a fresh invite link", async () => {
  const h = await W.hashPassword("a good long password");
  const kv = memKV({ "users:secrets": JSON.stringify({ "u@example.test": h }) });
  const env = envWith(kv);
  const res = await W.adminUsersApi(BARE, adminPost({ op: "reset", email: "u@example.test" }),
    new URL("https://example.test/__admin/users"), env, ADMIN, [ADMIN, PLAIN]);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.match(body.url, /^https:\/\/example\.test\/__invite\?t=/);
  const secrets = JSON.parse(await kv.get("users:secrets"));
  assert.ok(!secrets["u@example.test"], "old secret cleared — the password dies now");
  const token = new URL(body.url).searchParams.get("t");
  assert.equal(await W.readInvite(null, env, token), "u@example.test");
});

test("the password-setting endpoint is gone", async () => {
  const env = envWith(memKV());
  const res = await W.adminUsersApi(BARE, adminPost({ email: "u@example.test", pass: "hunter2hunter2" }),
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
  const res = await W.adminUsersApi(BARE, adminPost({ op: "reset", email: "leaky@example.test" }),
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
  const getRes = await W.adminUsersApi(BARE, adminGet(),
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
  const page = W.loginPage(BARE, "/", W.RESET_NOTICE);
  assert.match(page, /This account was reset/);
  assert.ok(!/Incorrect email or password/.test(page), "the generic message is replaced, not appended");
  // An unknown email must still get the generic message — no enumeration of non-users.
  assert.match(W.loginPage(BARE, "/", true), /Incorrect email or password/);
});

test("the reset notice is html-escaped into the page", () => {
  const page = W.loginPage(BARE, "/", '<script>alert(1)</script>');
  assert.ok(!page.includes("<script>alert(1)</script>"), "escaped, not injected");
  assert.match(page, /&lt;script&gt;/);
});

// ---- Runtime roster overlay: invite + remove without a config commit ---------
// The overlay is a convenience layer; the SECURITY boundary for a removal is the
// users:secrets tombstone (which fails closed), not the list. These tests pin both.

const ADMIN_URL = new URL("https://example.test/__admin/users");
const callAdmin = (req, env, users, config = []) =>
  W.adminUsersApi(BARE, req, ADMIN_URL, env, ADMIN, users, config);

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
  // `editor` is the current spelling of what used to be written as `user`. The
  // assertion that matters is unchanged: an invite with no role asked for must never
  // come out admin.
  assert.equal(roster.add["new.person@example.test"].role, "editor", "no silent admin escalation");
  const token = new URL(body.url).searchParams.get("t");
  assert.equal(await W.readInvite(null, env, token), "new.person@example.test");
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
  assert.equal(await W.readInvite(null, env, token), "half@example.test");
  const list = W.mergeRoster([ADMIN], JSON.parse(await kv.get("users:roster")));
  await callAdmin(adminPost({ op: "remove", email: "half@example.test" }), env, list, [ADMIN]);
  assert.equal(await W.readInvite(null, env, token), null, "the link they already hold stops working");
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
  const ctx = W.applyDerivedRouting({
    _engine: { id: "_engine", routing: { canvasLoaderExtras: "<!--x-->" } },
    alpha: manifestOf("alpha", { def: true, catalog: [{ url: "/a/", title: "A" }], tracks: [{ id: "t1" }] }),
    beta: manifestOf("beta", { catalog: [{ url: "/beta/b/", title: "B" }] }),
  });
  const merged = await W.canvasAggregate(ctx, "catalog").json();
  assert.deepEqual(merged.map((e) => e.url), ["/a/", "/beta/b/"],
    "both spaces contribute — publishing one must not blank the other");
  assert.deepEqual((await W.canvasAggregate(ctx, "tracks").json()).map((t) => t.id), ["t1"]);
});

test("a space that has never published contributes nothing rather than erasing others", async () => {
  const ctx = W.applyDerivedRouting({
    alpha: manifestOf("alpha", { def: true, catalog: [{ url: "/a/" }] }),
    beta: { id: "beta", format: 1, files: {}, space: { id: "beta" } }, // no routing at all
  });
  assert.deepEqual((await W.canvasAggregate(ctx, "catalog").json()).map((e) => e.url), ["/a/"]);
});

test("the build stamp reports publish provenance, and flags a working-tree publish", () => {
  const stamp = W.synthBuildStamp(BARE, {
    _engine: { id: "_engine", version: 27, publishedAt: "2026-08-09T08:00:00.000Z", source: { sha: "e".repeat(40) } },
    alpha: {
      id: "alpha", version: 15, publishedAt: "2026-08-09T07:00:00.000Z", publishedBy: "ben",
      source: { sha: "a".repeat(40), dirty: true },
    },
  });
  assert.equal(stamp.spaces.alpha.version, 15);
  assert.equal(stamp.spaces.alpha.publishedBy, "ben");
  assert.equal(stamp.spaces.alpha.dirty, true, "a dirty publish must never be silent");
  assert.equal(stamp.engine.version, 27);
  assert.equal(stamp.builtAt, "2026-08-09T08:00:00.000Z", "newest publish across the store");
});

test("a clean publish carries no dirty flag at all (absent, not false)", () => {
  const stamp = W.synthBuildStamp(BARE, { alpha: { id: "alpha", version: 2, source: { sha: "a".repeat(40) } } });
  assert.equal("dirty" in stamp.spaces.alpha, false);
});

// ---- Delete forever actually deletes ----------------------------------------

test("repo path → live URL prefix, per space base", () => {
  const ctx = W.applyDerivedRouting({
    alpha: manifestOf("alpha", { def: true }),
    beta: manifestOf("beta"),
  });
  assert.equal(W.deleteUrlPrefix(ctx, "alpha", "onboarding/prototypes/signup"), "/onboarding/signup/",
    "the default space serves at the root and drops the prototypes/ segment");
  assert.equal(W.deleteUrlPrefix(ctx, "beta", "onboarding/prototypes/signup"), "/beta/onboarding/signup/");
  assert.equal(W.deleteUrlPrefix(ctx, "alpha", "playground/sketch"), "/playground/sketch/");
  assert.equal(W.deleteUrlPrefix(ctx, "nope", "playground/sketch"), null,
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
  const res = await W.removeFromStore(BARE, env, "alpha", "/onboarding/signup/", "admin@example.test");
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
  const res = await W.removeFromStore(BARE, env, "alpha", "/gone/", "admin@example.test");
  assert.equal(res.removed, 0);
  assert.equal(JSON.parse(env.BUNDLES.store.get("spaces/alpha/manifest.json")).version, 4);
});

test("personId is stable per address and independent of the photo", () => {
  const a = W.personId("ben@example.test");
  assert.equal(a, W.personId("  BEN@Example.Test  "), "case- and space-insensitive");
  assert.match(a, /^[a-z0-9]+$/, "base36");
  assert.notEqual(a, W.personId("ana@example.test"));
  // avatarKey hashes email + photo length; personId must not, or a new photo
  // would orphan every past comment.
  const u1 = { email: "ben@example.test", avatar: "data:image/png;base64,AAAA" };
  const u2 = { email: "ben@example.test", avatar: "data:image/png;base64,AAAAAAAA" };
  assert.notEqual(W.avatarKey(u1), W.avatarKey(u2), "avatarKey changes with the photo");
  assert.equal(W.personId(u1.email), W.personId(u2.email), "personId does not");
});

// An anonymous comment may not WEAR a roster name — that is how a stranger would sign a
// review as a teammate. The roster it is checked against is the one passed in, and that
// is the point of passing it: the same pseudonym is blocked in the workspace whose person
// it names and free in a workspace where nobody is called that. Nothing pinned this rule
// before, so it could have been threaded to the wrong roster with every test still green.
test("an anonymous author may not wear a name from THAT workspace's roster", () => {
  const roster = [{ email: "marta@example.test", name: "Marta" }];
  const worn = W.sanitizeMsg(roster, { author: "Marta", body: "hi" }, null);
  assert.equal(worn.author, "Anonymous", "a roster name is taken away from an anonymous writer");
  assert.equal(worn.verified, false);

  // Same pseudonym, a workspace where no such person exists: nothing to impersonate.
  const elsewhere = W.sanitizeMsg([{ email: "ana@example.test", name: "Ana" }], { author: "Marta", body: "hi" }, null);
  assert.equal(elsewhere.author, "Marta", "the rule follows the roster it was given");

  // A signed-in person always wears their own name, roster collision or not.
  const signed = W.sanitizeMsg(roster, { author: "Marta", body: "hi" }, { email: "marta@example.test", name: "Marta" });
  assert.equal(signed.author, "Marta");
  assert.equal(signed.verified, true);
});

test("sanitizeMsg stamps `by` from the session, never from the request body", () => {
  const me = { email: "ben@example.test", name: "Ben" };
  const signed = W.sanitizeMsg(BARE.USERS, { author: "Someone Else", body: "hi", by: "forged" }, me);
  assert.equal(signed.author, "Ben");
  assert.equal(signed.verified, true);
  assert.equal(signed.by, W.personId("ben@example.test"));

  const anon = W.sanitizeMsg(BARE.USERS, { author: "Marta", body: "hi", by: "forged", verified: true }, null);
  assert.equal(anon.author, "Marta");
  assert.equal(anon.verified, false);
  assert.equal(anon.by, null, "an unauthenticated write can never carry an identity");
});

// A stored message keeps `by` and nothing else that identifies its author — the
// display name beside it is a snapshot, and renaming the roster entry changes it.
// So `by` is the ONLY durable handle an erasure sweep has: given an address, it
// recomputes the id and finds every message that address ever wrote, however the
// person has been renamed since. That is also why the address itself must never be
// stamped onto the message — the id is one-way, and /__people leans on that to stay
// safely ungated on public prototypes.
test("`by` survives a rename, so an erasure sweep keyed on the address still finds the message", () => {
  const before = { email: "ben@example.test", name: "Ben" };
  const stored = W.sanitizeMsg(BARE.USERS, { body: "my comment" }, before);

  const after = { email: "ben@example.test", name: "Benedetta Ruiz" };
  const later = W.sanitizeMsg(BARE.USERS, { body: "and another" }, after);

  assert.notEqual(stored.author, later.author, "the display name did change");
  assert.equal(stored.by, later.by, "the durable id did not");

  // What purgeUser(email) would do: derive the key, match the stored messages.
  const key = W.personId("  BEN@Example.Test  ");
  const mine = [stored, later, W.sanitizeMsg(BARE.USERS, { body: "hers" }, { email: "ana@example.test", name: "Ana" })]
    .filter((m) => m.by === key);
  assert.equal(mine.length, 2, "both of Ben's messages, none of Ana's");

  for (const m of [stored, later]) {
    assert.equal(m.email, undefined, "no address is stamped onto a stored message");
    assert.ok(!JSON.stringify(m).includes("@"), "nor anywhere else in its shape");
  }
});

test("publicUser exposes the person id but never a password", () => {
  const u = { email: "ben@example.test", name: "Ben", pass: "secret", role: "admin" };
  const p = W.publicUser(u);
  assert.equal(p.id, W.personId("ben@example.test"));
  assert.equal(p.pass, undefined);
  assert.equal(W.publicUser(null), null);
});

// ---- publicUser (/__me) and peopleApi (/__people) must derive initials/color the
// SAME way for a roster user who has neither configured (only admin-panel invites
// populate them — a user named straight in identity.json usually has neither).
// This is NOT self-correcting client-side: loadMe() seeds PEOPLE[ME.id] from /__me
// and loadPeople() deliberately skips ids already in PEOPLE, so a signed-in user's
// own id is never re-resolved via /__people. If the two fallbacks disagreed, this
// exact user would see "?" on default indigo for their own pin/hover-card/reply-bar
// for the whole session, while every OTHER viewer (who resolves them via
// /__people) sees proper derived initials and colour.

test("publicUser and peopleApi agree on initials/color for a roster user with neither configured", async () => {
  const u = { email: "nofrills@example.test", name: "No Frills" };
  const viaMe = W.publicUser(u);
  const peopleRes = await W.peopleApi(
    new URL("https://x.test/__people?ids=" + W.personId(u.email)), [u]
  ).json();
  const viaPeople = peopleRes.people[0];
  assert.ok(viaPeople, "peopleApi must resolve this user by id");
  assert.notEqual(viaMe.initials, "", "publicUser must not fall back to an empty string");
  assert.equal(viaMe.initials, viaPeople.initials, "/__me and /__people must derive the same initials");
  assert.equal(viaMe.color, viaPeople.color, "/__me and /__people must derive the same color");
});

const PEOPLE = [
  { email: "ben@example.test", name: "Ben", initials: "RA", color: "#4f46e5",
    avatar: "data:image/png;base64,AAAA" },
  { email: "ana@example.test", name: "Ana", initials: "AB", color: "#15803d" },
];
const peopleFor = async (qs) =>
  (await W.peopleApi(new URL("https://x.test/__people" + qs), PEOPLE).json()).people;

test("peopleApi answers only the ids it was asked for", async () => {
  const got = await peopleFor("?ids=" + W.personId("ben@example.test"));
  assert.equal(got.length, 1);
  assert.equal(got[0].name, "Ben");
  assert.equal(got[0].id, W.personId("ben@example.test"));
  assert.equal(got[0].avatar, "/__avatar/" + W.avatarKey(PEOPLE[0]));
  assert.equal(got[0].email, undefined, "an address never leaves the server");
});

test("peopleApi has no enumeration mode", async () => {
  assert.deepEqual(await peopleFor(""), []);
  assert.deepEqual(await peopleFor("?ids="), []);
  assert.deepEqual(await peopleFor("?ids=nosuchid"), [], "unknown ids are omitted, not an error");
});

test("peopleApi resolves exact names for pre-`by` comments", async () => {
  const got = await peopleFor("?names=Ana");
  assert.equal(got.length, 1);
  assert.equal(got[0].id, W.personId("ana@example.test"));
  assert.equal(got[0].avatar, null, "no photo on file");
  assert.deepEqual(await peopleFor("?names=an"), [], "exact match only, no prefix search");
});

test("peopleApi caps a request at 50 lookups", async () => {
  const ids = Array.from({ length: 60 }, (_, i) => "id" + i)
    .concat(W.personId("ben@example.test")).join(",");
  const res = W.peopleApi(new URL("https://x.test/__people?ids=" + ids), PEOPLE);
  assert.equal(res.status, 400);
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

test("DUMMY_HASH is a valid pbkdf2 string at the current cost, verifiable without a hash pass", async () => {
  const h = W.DUMMY_HASH; // STATIC, not computed — a lazy compute in the login path did
  assert.ok(W.isPassHash(h)); // two 600k passes on a cold isolate and blew the CPU budget.
  assert.ok(h.startsWith("pbkdf2$" + W.PBKDF2_ITERATIONS + "$"), "uses the current cost");
  // Verifying a wrong password against it returns false without throwing — its only
  // job is to make the timing of an unknown email match a known one (one derivation).
  assert.equal(await W.verifyPassword("anything", h), false);
});

test("revokePublishTokens drops exactly the removed user's tokens", async () => {
  const kv = memKV({ "publish:tokens": JSON.stringify({
    h1: { space: "*", label: "gone@example.test", createdAt: "x" },
    h2: { space: "space-alpha", label: "gone@example.test", createdAt: "y" }, // case-different label handled by lcEmail
    h3: { space: "space-alpha", label: "keep@example.test", createdAt: "z" },
  }) });
  // `tctx` first, since `B-kv-read-cutover` moved the token read onto the workspace object
  // and a revocation has to reach BOTH stores. Null here is a deployment with no object,
  // which is every self-hosted instance and exactly the KV-only behaviour this pins.
  await W.revokePublishTokens(null, envWith(kv), "GONE@example.test");
  const map = JSON.parse(await kv.get("publish:tokens"));
  assert.deepEqual(Object.keys(map), ["h3"], "only the other user's token survives");
});

// D2 retired (Phase A, S3): with the path-mount tier gone there is one workspace, so
// ownership no longer discriminates by space id — a "/space-beta/..." path is the one
// workspace's now, whichever id is asked. The engine-chrome / reserved-/__ exclusions are
// KEPT: they are what keeps a publish token off shared assets, single-workspace or not.
test("pathOwnedBySpace: the one workspace owns any non-chrome subtree (tier retired)", () => {
  const spaces = [{ id: "space-alpha", default: true }, { id: "space-beta" }];
  assert.equal(W.pathOwnedBySpace("/space-beta/pages/x/", "space-beta", spaces), true);
  assert.equal(W.pathOwnedBySpace("/departments/x/", "space-beta", spaces), true, "no /<id>/ boundary any more");
  assert.equal(W.pathOwnedBySpace("/admin/index.html", "space-beta", spaces), false, "engine chrome");
});

test("pathOwnedBySpace: the workspace owns root EXCEPT engine chrome (tier retired)", () => {
  const spaces = [{ id: "space-alpha", default: true }, { id: "space-beta" }];
  assert.equal(W.pathOwnedBySpace("/departments/x/", "space-alpha", spaces), true);
  assert.equal(W.pathOwnedBySpace("/__canvas/canvas.js", "space-alpha", spaces), false, "engine internals");
  assert.equal(W.pathOwnedBySpace("/admin/app.js", "space-alpha", spaces), false, "the admin panel");
  assert.equal(W.pathOwnedBySpace("/space-beta/pages/x/", "space-alpha", spaces), true,
    "a former second-space subtree is the one workspace's now");
  assert.equal(W.pathOwnedBySpace("relative", "space-alpha", spaces), false, "must be absolute");
});

test("the redeem page shows the target email read-only, and hides it when unknown", () => {
  const withEmail = W.invitePage(BARE, "tok", "", "mia@example.test");
  assert.match(withEmail, /mia@example\.test/);
  assert.match(withEmail, /readonly/);
  const without = W.invitePage(BARE, "tok", "");
  assert.ok(!/readonly/.test(without), "no email field when none is passed");
});

test("the redeem page html-escapes the target email (no attribute breakout)", () => {
  const page = W.invitePage(BARE, "tok", "", '"><script>alert(1)</script>@x');
  assert.ok(!page.includes('"><script>'), "escaped, not injected");
  assert.match(page, /&quot;&gt;/);
});

test("synthBuildStamp redacts the publisher email to a display name", () => {
  // publishedBy is the token label (an email); the public build stamp must not leak it.
  const manifests = {
    "space-alpha": { source: { sha: "abc" }, version: 3, publishedAt: "2026-08-09T00:00:00Z", publishedBy: "ben@example.test" },
  };
  const stamp = W.synthBuildStamp(BARE, manifests);
  const s = JSON.stringify(stamp);
  assert.ok(!s.includes("ben@example.test"), "raw email must not appear");
  // With no roster loaded it falls back to the local-part — still no domain.
  assert.match(stamp.spaces["space-alpha"].publishedBy, /^ben$/);
});

// The chrome a space may never write, and the two things a blanket "/__" ban got
// wrong in both directions. Publishing was blocked outright by the first of these.
test("the workspace owns its own search index at the root (tier retired)", () => {
  const spaces = [{ id: "alpha", default: true }, { id: "beta" }];
  assert.equal(W.pathOwnedBySpace("/__search.json", "alpha", spaces), true,
    "the workspace serves at the root, so its search index lands under /__ — refusing it stops it publishing at all");
  assert.equal(W.pathOwnedBySpace("/beta/__search.json", "beta", spaces), true);
  // /__search.json is the one /__ exception, owned by the one workspace whichever id
  // asks — the "…but only its OWN index" boundary was the multi-space tier, now retired.
  assert.equal(W.pathOwnedBySpace("/__search.json", "beta", spaces), true);
});

test("a space cannot write chrome that other spaces' pages load absolutely", () => {
  const spaces = [{ id: "alpha", default: true }, { id: "beta" }];
  for (const chrome of [
    "/__review/comments.js", "/__canvas/canvas.js", "/piti.js",
    "/fonts/inter.woff2", "/admin/index.html", "/augur-mark.png", "/404.html",
  ]) {
    assert.equal(W.pathOwnedBySpace(chrome, "alpha", spaces), false, `default space must not own ${chrome}`);
    assert.equal(W.pathOwnedBySpace(chrome, "beta", spaces), false, `non-default space must not own ${chrome}`);
  }
});

test("an unrecognised /__ path stays reserved for the engine", () => {
  const spaces = [{ id: "alpha", default: true }];
  assert.equal(W.pathOwnedBySpace("/__something-new.json", "alpha", spaces), false);
});

test("the composition graph is space content, published with its design system", () => {
  const spaces = [{ id: "alpha", default: true }, { id: "beta" }];
  assert.equal(W.pathOwnedBySpace("/skills/acme-ui/graph.js", "alpha", spaces), true);
  assert.equal(W.pathOwnedBySpace("/beta/skills/acme-ui/graph.js", "beta", spaces), true);
  assert.equal(W.pathOwnedBySpace("/__review/graph.js", "alpha", spaces), false,
    "the old home was shared chrome — that is why it moved");
});

// ── Hardening pass 2026-08-09 ────────────────────────────────────────────────
// Three guards added after an adversarial re-audit. Each one closes a hole that
// looked closed: the ownership rule that accepted the root, the throttle that
// doubled as a lockout button, and the picker catalogue that doubled as a site index.

test("a public prefix may not be the bare root (that opens the whole site)", () => {
  const spaces = [{ id: "alpha", default: true }, { id: "beta" }];
  // The hole: "/" IS owned by the default space, so the ownership rule alone passed it,
  // and isPublicPath matches by startsWith — every gated path becomes public.
  assert.equal(W.pathOwnedBySpace("/", "alpha", spaces), true, "still owned — that was the trap");
  assert.equal(W.isPublishablePublicPrefix("/", "alpha", spaces), false, "but never publishable");
  assert.equal(W.isPublishablePublicPrefix("", "alpha", spaces), false);
  // Real subtrees still publish, with or without the trailing slash.
  assert.equal(W.isPublishablePublicPrefix("/departments/x/", "alpha", spaces), true);
  assert.equal(W.isPublishablePublicPrefix("/departments/x", "alpha", spaces), true);
  // Engine chrome is still never publishable — the tier retirement keeps that guard. (The
  // "/beta/x/ belongs to another space" boundary that used to sit here was the multi-space
  // tier: with one workspace, "/beta/x/" is simply the workspace's own subtree now.)
  assert.equal(W.isPublishablePublicPrefix("/__canvas/", "alpha", spaces), false, "engine chrome");
});

test("the login throttle blocks a source but never locks an account out", async () => {
  const kv = memKV();
  const env = envWith(kv);
  const ids = ["rl:login:em:t@example.test", "rl:login:ip:203.0.113.9"];
  for (let i = 0; i < W.LOGIN_MAX_FAILS; i++) await W.loginFail(env, ids);
  // The IP that did the hammering is hard-blocked.
  assert.equal(await W.loginThrottled(env, ids), true);
  // But the EMAIL alone only slows — otherwise ten guesses at a known address would bar
  // that person from every IP for fifteen minutes, renewably. Anyone could do it to anyone.
  const fromCleanIp = ["rl:login:em:t@example.test", "rl:login:ip:198.51.100.1"];
  assert.equal(await W.loginThrottled(env, fromCleanIp), false, "the real user can still reach the gate");
  assert.equal(await W.loginSlowed(env, fromCleanIp), true, "but they are braked");
});

test("the canvas catalogue is not a site index for a signed-out caller", async () => {
  const ctx = W.applyDerivedRouting({
    alpha: {
      id: "alpha", format: 1, files: {}, space: { id: "alpha", default: true },
      routing: { canvasCatalog: [{ url: "/departments/secret-thing/", title: "secret-thing" }] },
    },
  });
  // Signed in: the picker needs the full inventory.
  assert.equal((await W.canvasAggregate(ctx, "catalog", true).json()).length, 1);
  // Signed out: the board they were sent still renders, but they get no directory of
  // every URL on the site. Empty array, not a 401 — the client's fetch must still parse.
  const anon = W.canvasAggregate(ctx, "catalog", false);
  assert.equal(anon.status, 200);
  assert.deepEqual(await anon.json(), []);
});

// ---- The front door wears the deployment's brand ----------------------------

test("the gate and the invite form show the default space's icon, not the engine mark", () => {
  const ctx = W.applyDerivedRouting({
    alpha: { id: "alpha", format: 1, files: {}, space: { id: "alpha", default: true } },
    beta: { id: "beta", format: 1, files: {}, space: { id: "beta" } },
  });
  for (const [what, html] of [["gate", W.loginPage(ctx, "/", false)], ["invite", W.invitePage(ctx, "t", "", "")]]) {
    assert.match(html, /<img src="\/space-icon\.png"/, `${what} wears the space icon`);
    assert.doesNotMatch(html, /aria-label="Augur"/, `${what} drops the engine mark`);
  }
  // …and the icon has to clear the gate, or that <img> fetches the login HTML instead.
  assert.equal(W.isPublicPath(ctx, "/space-icon.png"), true);
  // the review overlay's own assets, for the same reason: a gated cursor image falls
  // back to a keyword silently, a gated avatar renders as a broken <img>
  for (const p of ["/__review/comments.js", "/__review/cat.png", "/__review/comment-cursor.svg"])
    assert.equal(W.isPublicPath(ctx, p), true, `${p} must clear the gate`);
});

test("with no space mounted the front door falls back to the engine mark", () => {
  const ctx = W.applyDerivedRouting({}); // engine-only site: no space branding to wear
  assert.match(W.brandMark(ctx), /aria-label="Augur"/);
  assert.match(W.loginPage(ctx, "/", false), /aria-label="Augur"/);
  assert.doesNotMatch(W.loginPage(ctx, "/", false), /space-icon\.png/);
});

test("session music is admin-only — never public, whatever the space is called", async () => {
  // A tracks/ folder is somebody's music library. It ships only when the space opts in,
  // and even then the gate hands it to admins alone — the door it used to have in
  // isPublicPath made every published track downloadable by anyone who asked.
  // Root-only now (Phase A, S4): the "/<space>/tracks/" mount was retired with the
  // path-mount tier, so "/space-2/tracks/theme.m4a" is no longer a track.
  const ctx = W.applyDerivedRouting({});
  for (const p of ["/tracks/01 Ambient.mp3", "/tracks/deep/sub.opus"]) {
    assert.equal(W.isPublicPath(ctx, p), false, `${p} must not be public`);
    assert.equal(W.isTrackPath(p), true, `${p} must be recognised as music`);
  }
  assert.equal(W.isTrackPath("/space-2/tracks/theme.m4a"), false, "no /<space>/ mount survives");
  // …and the rule is audio-only: a doc that lands in the same folder is not "music",
  // it is ordinary gated content (isTrackPath is a permission, not a hiding place).
  for (const p of ["/tracks/README.md", "/tracks/cover.png", "/track-list/x.mp3"])
    assert.equal(W.isTrackPath(p), false, `${p} is not a track`);

  // The manifest a non-admin sees says the instance has no music at all, so the canvas
  // hides its music surface instead of offering a picker whose every track 404s. With
  // adminOnly retired (Q1), a formerly-sealed space now contributes its CATALOG too —
  // the admin-only exclusion was the multi-space tier, and the track LIST already only
  // ever answered admins, so nothing leaks that the default space did not already.
  const trackCtx = W.applyDerivedRouting({
    alpha: { id: "alpha", format: 1, files: {}, space: { id: "alpha", default: true },
             routing: { canvasTracks: [{ id: "alpha:one", name: "One", url: "/tracks/one.mp3" }] } },
    vault: { id: "vault", format: 1, files: {}, space: { id: "vault", adminOnly: true },
             routing: { canvasTracks: [{ id: "vault:two", name: "Two", url: "/vault/tracks/two.mp3" }],
                        canvasCatalog: [{ title: "secret", url: "/vault/x/" }] } },
  });
  assert.deepEqual(await (await W.canvasAggregate(trackCtx, "catalog", true)).json(),
    [{ title: "secret", url: "/vault/x/" }],
    "with adminOnly retired, the formerly-sealed space now appears in the catalogue");
  assert.deepEqual(await (await W.canvasAggregate(trackCtx, "tracks", false)).json(), []);
  assert.equal((await (await W.canvasAggregate(trackCtx, "tracks", true)).json()).length, 2);
});

// ---- Self-set profile photos ------------------------------------------------
// The one overlay that BEATS the config file: a person's face is theirs. A photo baked
// into identity.json is a seed — the value they see until they change it — so an
// instance carrying baked photos can take this feature by pin bump with no migration.

// parseAvatarDataUri checks magic bytes, not the label, so these fixtures only need a
// believable header and enough length to clear the floor.
const jpegUri = (n = 32) =>
  "data:image/jpeg;base64," + Buffer.from(
    Uint8Array.from([0xff, 0xd8, 0xff, ...Array(n - 3).fill(0x41)])).toString("base64");
const pngUri = () =>
  "data:image/png;base64," + Buffer.from(
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, ...Array(29).fill(0x42)])).toString("base64");

const meAvatarPost = (avatar) => new Request("https://example.test/__me/avatar", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ avatar }),
});
const meAvatarDelete = () => new Request("https://example.test/__me/avatar", { method: "DELETE" });

test("parseAvatarDataUri accepts the three raster formats we serve", () => {
  assert.equal(W.parseAvatarDataUri(jpegUri()).mime, "image/jpeg");
  assert.equal(W.parseAvatarDataUri(pngUri()).mime, "image/png");
});

test("parseAvatarDataUri rejects a payload whose bytes contradict its label", () => {
  // The whole point: /__avatar/ is ungated and echoes this mime back, so a trusted
  // label would let a signed-in user park arbitrary bytes behind image/jpeg.
  const lying = "data:image/jpeg;base64," + Buffer.from("<html>not an image</html>").toString("base64");
  assert.equal(W.parseAvatarDataUri(lying), null);
});

test("parseAvatarDataUri rejects non-raster types, junk and oversized payloads", () => {
  for (const bad of [
    null, "", "https://example.test/face.jpg",
    "data:image/svg+xml;base64," + Buffer.from("<svg onload=alert(1)/>").toString("base64"),
    "data:text/html;base64," + Buffer.from("<h1>hi</h1>").toString("base64"),
    "data:image/jpeg;base64,!!!not base64!!!",
    "data:image/jpeg;base64," + Buffer.from(Uint8Array.from([0xff, 0xd8, 0xff])).toString("base64"), // under the floor
  ]) assert.equal(W.parseAvatarDataUri(bad), null, `rejected: ${String(bad).slice(0, 40)}`);
  assert.equal(W.parseAvatarDataUri(jpegUri(W.AVATAR_MAX_CHARS)), null, "over the ceiling");
});

test("applyAvatars: a self-set photo beats a config-baked one, and never mutates the config object", () => {
  const config = { email: "a@example.test", name: "A", avatar: "data:image/png;base64,AAAA" };
  const other = { email: "b@example.test", name: "B" };
  const { USERS: users, AVATAR_KEYS: keys } =
    W.applyAvatars([config, other], { "a@example.test": { k: "abc123" } });
  assert.equal(users[0].avatar, "/__avatar/u/abc123", "self-set wins");
  assert.equal(users[1], other, "an untouched user is passed through as-is");
  assert.equal(config.avatar, "data:image/png;base64,AAAA",
    "the config entry itself is unchanged — otherwise removing the photo could not fall back to it");
  // The hashes travel WITH the users, as a value: the ungated /__avatar/ route checks
  // them, so they belong to the workspace whose roster produced them, not to the isolate.
  assert.deepEqual([...keys], ["abc123"]);
  // …and dropping the overlay entry restores the seed, which is what makes DELETE work.
  const dropped = W.applyAvatars([config], {});
  assert.equal(dropped.USERS[0].avatar, "data:image/png;base64,AAAA");
  assert.deepEqual([...dropped.AVATAR_KEYS], []);
});

test("applyAvatars matches addresses case-insensitively and ignores malformed entries", () => {
  const users = [{ email: "Mixed@Example.test" }, { email: "junk@example.test" }];
  const out = W.applyAvatars(users, { "mixed@example.test": { k: "k1" }, "junk@example.test": { k: 42 } }).USERS;
  assert.equal(out[0].avatar, "/__avatar/u/k1");
  assert.equal(out[1].avatar, undefined);
});

test("POST /__me/avatar stores the photo, indexes it, and answers with its content-hashed URL", async () => {
  const kv = memKV();
  const env = envWith(kv);
  const uri = jpegUri();
  const res = await W.meAvatarApi(W.DEFAULT_TENANT_ID, meAvatarPost(uri), env, PLAIN);
  const body = await res.json();
  assert.equal(body.ok, true);
  const k = await W.avatarHash(uri);
  assert.equal(body.avatar, "/__avatar/u/" + k);
  assert.equal(await kv.get(W.AVATAR_BLOB_PREFIX + k), uri, "the blob is the data URI, verbatim");
  const index = JSON.parse(await kv.get(W.USER_AVATARS_KEY));
  assert.deepEqual(Object.keys(index), ["u@example.test"]);
  assert.equal(index["u@example.test"].k, k);
  // The index is what gets re-read every config tick — it must stay tiny.
  assert.ok((await kv.get(W.USER_AVATARS_KEY)).length < 200, "the index holds keys, never images");
});

test("/__me/avatar refuses a signed-out caller and a bad image, and touches nothing", async () => {
  const kv = memKV();
  const env = envWith(kv);
  assert.equal((await W.meAvatarApi(W.DEFAULT_TENANT_ID, meAvatarPost(jpegUri()), env, null)).status, 401);
  assert.equal((await W.meAvatarApi(W.DEFAULT_TENANT_ID, meAvatarPost("data:text/html;base64,AAAA"), env, PLAIN)).status, 400);
  assert.equal((await W.meAvatarApi(W.DEFAULT_TENANT_ID, new Request("https://example.test/__me/avatar"), env, PLAIN)).status, 405);
  assert.equal(kv.store.size, 0, "nothing written");
});

test("a user can only ever set their OWN photo — there is no email parameter", async () => {
  const kv = memKV();
  const req = new Request("https://example.test/__me/avatar", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ avatar: jpegUri(), email: ADMIN.email }),
  });
  await W.meAvatarApi(W.DEFAULT_TENANT_ID, req, envWith(kv), PLAIN);
  assert.deepEqual(Object.keys(JSON.parse(await kv.get(W.USER_AVATARS_KEY))), ["u@example.test"]);
});

test("DELETE /__me/avatar drops the index entry (and the config seed comes back)", async () => {
  const kv = memKV();
  const env = envWith(kv);
  const uri = jpegUri();
  await W.meAvatarApi(W.DEFAULT_TENANT_ID, meAvatarPost(uri), env, PLAIN);
  const res = await W.meAvatarApi(W.DEFAULT_TENANT_ID, meAvatarDelete(), env, PLAIN);
  assert.deepEqual(await res.json(), { ok: true, avatar: null });
  assert.deepEqual(JSON.parse(await kv.get(W.USER_AVATARS_KEY)), {});
  const seeded = { email: PLAIN.email, avatar: "data:image/png;base64,AAAA" };
  assert.equal(W.applyAvatars([seeded], await W.readAvatars(env)).USERS[0].avatar, "data:image/png;base64,AAAA");
});

test("serving a self-set photo: known key returns the bytes, unknown key never reads KV", async () => {
  const kv = memKV();
  let reads = 0;
  const counting = { ...kv, async get(k) { reads++; return kv.get(k); } };
  const env = envWith(counting);
  const uri = jpegUri();
  await W.meAvatarApi(W.DEFAULT_TENANT_ID, meAvatarPost(uri), env, PLAIN);
  const k = await W.avatarHash(uri);

  // The route trusts the index the CALLING workspace's config tick built, handed to it as
  // a context — never a module binding, which would be whichever workspace loaded last.
  const tctx = W.applyAvatars([{ email: PLAIN.email }], await W.readAvatars(env));
  reads = 0;
  const miss = await W.serveKvAvatar(tctx, env, "deadbeef");
  assert.equal(miss.status, 404);
  assert.equal(reads, 0, "an ungated route must not be a KV read amplifier for typed-in hashes");

  // A neighbour's context vouches for nothing here, so the same hash is not served to it.
  const neighbour = await W.serveKvAvatar({ AVATAR_KEYS: new Set() }, env, k);
  assert.equal(neighbour.status, 404, "a workspace whose index does not vouch for a hash must not serve it");

  const hit = await W.serveKvAvatar(tctx, env, k);
  assert.equal(hit.status, 200);
  assert.equal(hit.headers.get("Content-Type"), "image/jpeg");
  assert.equal(hit.headers.get("X-Content-Type-Options"), "nosniff");
  assert.match(hit.headers.get("Cache-Control"), /immutable/);
  assert.equal(new Uint8Array(await hit.arrayBuffer())[0], 0xff);
});

test("an indexed key whose blob vanished 404s rather than serving a broken image", async () => {
  const kv = memKV();
  const env = envWith(kv);
  const uri = jpegUri();
  await W.meAvatarApi(W.DEFAULT_TENANT_ID, meAvatarPost(uri), env, PLAIN);
  const k = await W.avatarHash(uri);
  const tctx = W.applyAvatars([{ email: PLAIN.email }], await W.readAvatars(env));
  await kv.delete(W.AVATAR_BLOB_PREFIX + k);
  assert.equal((await W.serveKvAvatar(tctx, env, k)).status, 404);
});

test("removing a user takes their face out of the index too", async () => {
  const kv = memKV();
  const env = envWith(kv);
  await W.meAvatarApi(W.DEFAULT_TENANT_ID, meAvatarPost(jpegUri()), env, PLAIN);
  const res = await callAdmin(adminPost({ op: "remove", email: PLAIN.email }), env, [ADMIN, PLAIN], [ADMIN, PLAIN]);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(await kv.get(W.USER_AVATARS_KEY)), {});
});

// ---- Self-set display names -------------------------------------------------
// Same bargain as the photo above: who you are is a deploy decision, what you are
// CALLED is yours, and a config-baked name is the seed until you change it.

const meNamePost = (name) => new Request("https://example.test/__me/name", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
});

test("cleanName trims, collapses whitespace and strips control + bidi characters", () => {
  assert.equal(W.cleanName("  Bee   Wilson  "), "Bee Wilson");
  assert.equal(W.cleanName("Bee Wilson"), "Bee Wilson");
  assert.equal(W.cleanName("Bee\tWilson\n"), "Bee Wilson");
  // RLO would reorder everything drawn after the name — in the chip, the admin table
  // and on every comment. It must never survive into storage.
  assert.equal(W.cleanName("Bee‮Wilson"), "Bee Wilson");
});

test("cleanName rejects blanks and anything over the ceiling", () => {
  for (const bad of [null, undefined, 42, "", "   ", "  ", "‪‬"])
    assert.equal(W.cleanName(bad), null, `rejected: ${JSON.stringify(bad)}`);
  assert.equal(W.cleanName("a".repeat(W.NAME_MAX_CHARS)), "a".repeat(W.NAME_MAX_CHARS));
  assert.equal(W.cleanName("a".repeat(W.NAME_MAX_CHARS + 1)), null);
});

test("applyNames: a self-set name beats the config one, and never mutates the config object", () => {
  const config = { email: "a@example.test", name: "Config Name", initials: "CN" };
  const other = { email: "b@example.test", name: "B" };
  const users = W.applyNames([config, other], { "a@example.test": { name: "Chosen" } });
  assert.equal(users[0].name, "Chosen");
  assert.equal(users[1], other, "an untouched user is passed through as-is");
  assert.equal(config.name, "Config Name", "the config entry itself is unchanged");
  assert.equal(W.applyNames([config], {})[0].name, "Config Name", "dropping the entry restores the seed");
});

test("a renamed person loses their config initials, so the face never contradicts the name", () => {
  // "CN" against a name changed to "Chosen" would read as two different people
  // wherever there is no photo. publicUser re-derives from the name once it's gone.
  const config = { email: "a@example.test", name: "Config Name", initials: "CN" };
  const renamed = W.applyNames([config], { "a@example.test": { name: "Chosen" } })[0];
  assert.equal(renamed.initials, undefined);
  assert.equal(W.publicUser(renamed).initials, "CH", "derived from the new name, not the old letters");
  assert.equal(W.publicUser(config).initials, "CN", "an un-renamed person keeps theirs");
});

test("applyNames matches addresses case-insensitively and ignores malformed entries", () => {
  const out = W.applyNames(
    [{ email: "Mixed@Example.test", name: "seed" }, { email: "junk@example.test", name: "seed" }],
    { "mixed@example.test": { name: "Chosen" }, "junk@example.test": { name: 42 } });
  assert.equal(out[0].name, "Chosen");
  assert.equal(out[1].name, "seed");
});

test("POST /__me/name stores the cleaned name and answers with it plus fresh initials", async () => {
  const kv = memKV();
  const env = envWith(kv);
  const res = await W.meNameApi(W.DEFAULT_TENANT_ID, meNamePost("  Bee   Wilson "), env, PLAIN);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.name, "Bee Wilson");
  assert.equal(body.initials, "BW");
  const index = JSON.parse(await kv.get(W.USER_NAMES_KEY));
  assert.deepEqual(Object.keys(index), ["u@example.test"]);
  assert.equal(index["u@example.test"].name, "Bee Wilson");
});

test("/__me/name refuses a signed-out caller, a blank name and the wrong method", async () => {
  const kv = memKV();
  const env = envWith(kv);
  assert.equal((await W.meNameApi(W.DEFAULT_TENANT_ID, meNamePost("Bee"), env, null)).status, 401);
  assert.equal((await W.meNameApi(W.DEFAULT_TENANT_ID, meNamePost("   "), env, PLAIN)).status, 400);
  assert.equal((await W.meNameApi(W.DEFAULT_TENANT_ID, meNamePost(null), env, PLAIN)).status, 400);
  assert.equal((await W.meNameApi(W.DEFAULT_TENANT_ID, new Request("https://example.test/__me/name"), env, PLAIN)).status, 405);
  assert.equal(kv.store.size, 0, "nothing written");
});

test("a user can only ever set their OWN name — there is no email parameter", async () => {
  const kv = memKV();
  const req = new Request("https://example.test/__me/name", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Impostor", email: ADMIN.email }),
  });
  await W.meNameApi(W.DEFAULT_TENANT_ID, req, envWith(kv), PLAIN);
  assert.deepEqual(Object.keys(JSON.parse(await kv.get(W.USER_NAMES_KEY))), ["u@example.test"]);
});

test("removing a user takes their chosen name out too, so a re-invite doesn't inherit it", async () => {
  const kv = memKV();
  const env = envWith(kv);
  await W.meNameApi(W.DEFAULT_TENANT_ID, meNamePost("Bee Wilson"), env, PLAIN);
  const res = await callAdmin(adminPost({ op: "remove", email: PLAIN.email }), env, [ADMIN, PLAIN], [ADMIN, PLAIN]);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(await kv.get(W.USER_NAMES_KEY)), {});
});

test("avatarUrl passes a self-set URL through untouched (only data URIs get hashed)", () => {
  assert.equal(W.avatarUrl({ email: "a@example.test", avatar: "/__avatar/u/abc" }), "/__avatar/u/abc");
  assert.equal(W.avatarUrl({ email: "a@example.test" }), null);
});

// ---- loginHint --------------------------------------------------------------
// The instance's one-liner under the login form (how a demo instance surfaces its
// test credentials). Escaped like any other instance-supplied string, and absent
// entirely when unset. Runs LAST in this file: applyInstance rewrites module state.

test("the instance loginHint renders under the login form, escaped, only when set", () => {
  const hinted = W.applyInstance({ users: [], loginHint: "Demo login: visita@example.test / secret" });
  assert.match(W.loginPage(hinted, "/", false), /Demo login: visita@example\.test \/ secret/);

  const hostile = W.applyInstance({ users: [], loginHint: "<script>alert(1)</script>" });
  const page = W.loginPage(hostile, "/", false);
  assert.doesNotMatch(page, /<script>alert\(1\)/);
  assert.match(page, /&lt;script&gt;/);

  const unset = W.applyInstance({ users: [] });
  assert.doesNotMatch(W.loginPage(unset, "/", false), /class="hint"/);

  // A non-string hint (config typo) is ignored, not stringified into the page.
  const typo = W.applyInstance({ users: [], loginHint: { text: "nope" } });
  assert.doesNotMatch(W.loginPage(typo, "/", false), /class="hint"/);
});

test("a viewer can never trade its public credentials for a publish token", async () => {
  const hash = await W.hashPassword("public-demo-pass");
  const ctx = W.applyInstance({ users: [
    { email: "visita@example.test", name: "Visita", role: "viewer", passHash: hash },
    { email: "member@example.test", name: "Member", passHash: hash },
  ] });
  const env = envWith(memKV(), { BUNDLES: {} , SESSION_SECRET: "s3cret" });
  const mint = (email) => W.publishApi(ctx,
    new Request("https://example.test/__publish/_login/token", {
      method: "POST",
      body: JSON.stringify({ email, password: "public-demo-pass" }),
    }),
    new URL("https://example.test/__publish/_login/token"), env);

  const v = await mint("visita@example.test");
  assert.equal(v.status, 403);
  assert.equal((await v.json()).error, "viewer-role");

  // The same credentials on a regular account get PAST the role gate (what stops
  // them here is only the fixture's missing default space — not their role).
  const m = await mint("member@example.test");
  const mBody = await m.json();
  assert.notEqual(mBody.error, "viewer-role");

  W.applyInstance({ users: [] });
});

// The build stamp has to distinguish two engine facts that look like one.
//
// `engine.sha` is the last chrome + worker deploy. `spaces.<id>.builtWithEngine` is the
// engine that COMPOSED that space's pages. They diverge silently and expensively: page
// chrome (rail, profile menu, overlays) is baked into each page at build time, so an
// engine deploy alone never changes it — a space that has not republished keeps serving
// old UI while the stamp reports a current engine. That cost real debugging time before
// the field existed: one instance showed a new profile menu and another did not, both
// reporting the same engine sha.
test("the build stamp says which engine BUILT each space, not just which one is deployed", () => {
  const manifests = {
    _engine: { version: 3, publishedAt: "2026-08-16T16:00:00Z", builtWith: { engine: "n".repeat(40) } },
    alpha: {
      version: 9, publishedAt: "2026-08-13T19:00:00Z",
      space: { id: "alpha", default: true },
      source: { sha: "abc" },
      builtWith: { engine: "o".repeat(40) }, // built by an older engine
    },
  };
  const stamp = W.synthBuildStamp(BARE, manifests);
  assert.equal(stamp.spaces.alpha.builtWithEngine, "o".repeat(40),
    "a space must report the engine that composed its pages");
  assert.notEqual(stamp.spaces.alpha.builtWithEngine, stamp.engine.sha,
    "and that must be readable as different from the deployed engine");
});

test("a manifest with no builtWith omits the field rather than reporting a false one", () => {
  // Every space published before this field existed has no builtWith. Reporting null or
  // the current engine would both be lies — absent is the only honest answer.
  const stamp = W.synthBuildStamp(BARE, {
    alpha: { version: 1, space: { id: "alpha", default: true }, source: { sha: "abc" } },
  });
  assert.equal("builtWithEngine" in stamp.spaces.alpha, false);
});
