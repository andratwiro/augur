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
const USER = { email: "user@smoke.test", name: "User" };
const ROSTER = [ADMIN, USER];
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

// 1. A roster entry with no secret is pending.
let res = await W.adminUsersApi(new Request(`${ORIGIN}/__admin/users`), new URL(`${ORIGIN}/__admin/users`), env, ADMIN, ROSTER);
let body = await res.json();
assert.equal(body.users.find((u) => u.email === USER.email).state, "pending");
ok("new roster entry reads as pending");

// 2. Reset mints a link.
res = await W.adminUsersApi(post({ op: "reset", email: USER.email }), new URL(`${ORIGIN}/__admin/users`), env, ADMIN, ROSTER);
body = await res.json();
assert.equal(body.ok, true);
const token = new URL(body.url).searchParams.get("t");
ok("reset returns a single-use invite link");

// 3. Redeeming sets a hash and signs in.
res = await W.invitePost(redeem(token, "a properly long password"), new URL(`${ORIGIN}/__invite`), env, ROSTER);
assert.equal(res.status, 303);
assert.match(res.headers.get("Set-Cookie") || "", /gv_user=/);
const stored = JSON.parse(await kv.get("users:secrets"))[USER.email];
assert.ok(W.isPassHash(stored), "stored as a hash");
ok("redemption stores a hash and issues a session");

// 4. The link is dead.
res = await W.invitePost(redeem(token, "another long password"), new URL(`${ORIGIN}/__invite`), env, ROSTER);
assert.equal(res.status, 400);
ok("the link cannot be reused");

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
  new Request(ORIGIN, { headers: { Cookie: `gv_user=${USER.email}.${sessionToken}` } }), env, ROSTER);
assert.equal(identified && identified.email, USER.email);
ok("password verifies and the session identifies the user");

// 7. Reset again: password dies immediately, session stops verifying.
await W.adminUsersApi(post({ op: "reset", email: USER.email }), new URL(`${ORIGIN}/__admin/users`), env, ADMIN, ROSTER);
assert.equal(await W.identify(
  new Request(ORIGIN, { headers: { Cookie: `gv_user=${USER.email}.${sessionToken}` } }), env, ROSTER), null);
ok("reset revokes the password AND the live session");

console.log("\nall good.");
