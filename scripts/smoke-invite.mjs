#!/usr/bin/env node
/*
 * smoke-invite.mjs — the whole invite lifecycle in one pass, against an in-memory KV.
 * The unit tests check each piece; this checks the SEQUENCE, which is what an operator
 * actually walks through: pending → invite → accepted → login → reset → locked out.
 *
 * Usage: npm run smoke
 */
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

function memKV() {
  const store = new Map();
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
  };
}

const kv = memKV();
const env = { COMMENTS: kv, SESSION_SECRET: "smoke-secret" };
const ADMIN = { email: "admin@smoke.test", name: "Admin", role: "admin" };
// pass: "leaked-seed-2026" stands in for the legacy roster password migration is
// revoking. Without it, effectiveSecret has nothing to fall back to, so a tombstone
// (ov[email] = null) and an outright `delete ov[email]` both collapse to "" — steps
// 6 and 7 would pass identically either way, and the reset-regresses-to-a-leak bug
// this script exists to catch would sail straight through. Do not remove this field.
const USER = { email: "user@smoke.test", name: "User", pass: "leaked-seed-2026" };
// A fresh entry with no legacy password and no passHash — represents a genuinely new,
// never-invited person. Asserts that the pending state is actually derivable.
const FRESH = { email: "fresh@smoke.test", name: "Fresh" };
const ROSTER = [ADMIN, USER, FRESH];
const ORIGIN = "https://smoke.test";

const post = (body) => new Request(`${ORIGIN}/__admin/users`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const redeem = (token, password) => new Request(`${ORIGIN}/__invite`, {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ token, password }).toString(),
});

let step = 0;
const ok = (m) => console.log(`  ${++step}. ${m}`);

console.log("invite lifecycle:");

// 1. A roster entry with a legacy password reads as accepted — that's the leaked
// password this whole migration exists to revoke. "reset" (step 2) is what moves
// them to pending. A fresh entry with no password reads as pending — that state
// derivation must not be broken.
let res = await W.adminUsersApi(new Request(`${ORIGIN}/__admin/users`), new URL(`${ORIGIN}/__admin/users`), env, ADMIN, ROSTER);
let body = await res.json();
assert.equal(body.users.find((u) => u.email === USER.email).state, "accepted");
assert.equal(body.users.find((u) => u.email === FRESH.email).state, "pending");
ok("legacy roster entry reads as accepted, fresh never-invited entry reads as pending");

// 2. Reset mints a link.
res = await W.adminUsersApi(post({ op: "reset", email: USER.email }), new URL(`${ORIGIN}/__admin/users`), env, ADMIN, ROSTER);
body = await res.json();
assert.equal(body.ok, true);
const token = new URL(body.url).searchParams.get("t");
ok("reset returns a single-use invite link");

// 3. Redeeming sets a hash and signs in.
res = await W.invitePost(redeem(token, "a properly long password"), new URL(`${ORIGIN}/__invite`), env, ROSTER);
assert.equal(res.status, 303);
assert.match(res.headers.get("Set-Cookie") || "", /^__Host-gv_user=/);
const stored = JSON.parse(await kv.get("users:secrets"))[USER.email];
assert.ok(W.isPassHash(stored), "stored as a hash");
ok("redemption stores a hash and issues a session");

// 4. The link is dead, and the reuse attempt didn't touch the stored secret. A status-only
// check would miss a future reordering that starts mutating state before the token check.
res = await W.invitePost(redeem(token, "another long password"), new URL(`${ORIGIN}/__invite`), env, ROSTER);
assert.equal(res.status, 400);
assert.equal(JSON.parse(await kv.get("users:secrets"))[USER.email], stored);
ok("the link cannot be reused, and the stored secret is untouched by the attempt");

// 5. The user now reads as accepted.
res = await W.adminUsersApi(new Request(`${ORIGIN}/__admin/users`), new URL(`${ORIGIN}/__admin/users`), env, ADMIN, ROSTER);
body = await res.json();
assert.equal(body.users.find((u) => u.email === USER.email).state, "accepted");
assert.ok(!JSON.stringify(body).includes("pbkdf2$"), "no secret leaks through the admin API");
ok("state flips to accepted, no secret in the API response");

// 6. The chosen password verifies; the session cookie identifies.
assert.equal(await W.verifyPassword("a properly long password", stored), true);
const sessionToken = await W.userToken(env, USER);
const identified = await W.identify(
  new Request(ORIGIN, { headers: { Cookie: `__Host-gv_user=${USER.email}.${sessionToken}` } }), env, ROSTER);
assert.equal(identified && identified.email, USER.email);
ok("password verifies and the session identifies the user");

// 7. Reset again: this must write a TOMBSTONE, not a delete. Both make the session stop
// verifying, so that check alone can't tell them apart — a regression from
// `ov[email] = null` to `delete ov[email]` would sail through it, because effectiveSecret
// only falls back to USER.pass ("leaked-seed-2026") when the key is ABSENT, and a fallback
// to that leaked roster password is exactly the bug this reset exists to prevent. Assert
// the raw stored state directly, not just the session outcome.
await W.adminUsersApi(post({ op: "reset", email: USER.email }), new URL(`${ORIGIN}/__admin/users`), env, ADMIN, ROSTER);
const secretsMap = JSON.parse(await kv.get("users:secrets"));
assert.ok(Object.prototype.hasOwnProperty.call(secretsMap, USER.email), "key still present: a tombstone, not a deletion");
assert.ok(!secretsMap[USER.email], "tombstoned value is falsy");
const revokedSecret = await W.effectiveSecret(env, USER);
assert.equal(revokedSecret, "");
assert.notEqual(revokedSecret, "leaked-seed-2026", "must not fall back to the leaked roster password");
assert.equal(await W.identify(
  new Request(ORIGIN, { headers: { Cookie: `__Host-gv_user=${USER.email}.${sessionToken}` } }), env, ROSTER), null);
ok("reset writes a tombstone (not a deletion), revokes the password with no fallback, and kills the live session");

console.log("\nall good.");
