// The invite link ends in a session, not in "set a password" — passwordless first run.
//
// `SESSION_KEYS` on moves where redemption LANDS and nothing else: `mintInvite`, the
// token hash, the TTL and single-use are machinery that already existed and is not
// re-tested here beyond the contract that an old link still works. What these tests
// prove is the landing in both modes: flag off is byte-for-byte the old behaviour, flag
// on establishes a session with no credential ever created — and every refusal shape
// `identify()` had is still a refusal with no password in the picture, because the
// session-key seam fails closed the same way the credential does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";
import { renderMail } from "../src/mail.mjs";

const ORIGIN = "https://x.test";
const URL_INVITE = new URL(`${ORIGIN}/__invite`);
const INVITEE = { email: "new@x.test", name: "New Person", role: "editor" };
const HOLDER = { email: "holder@x.test", name: "Holder", role: "admin" };
const ROSTER = [INVITEE, HOLDER];

function memKV(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, String(v)); },
    async delete(k) { m.delete(k); },
    async list({ prefix = "" } = {}) {
      return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}

const CTX_OFF = W.applyDerivedRouting({});
const CTX_ON = { ...CTX_OFF, SESSION_KEYS: true };

const freshEnv = () => ({ SESSION_SECRET: "s3cret", COMMENTS: memKV() });

const postRedeem = (tctx, env, fields) => W.invitePost(tctx, new Request(`${ORIGIN}/__invite`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
}), URL_INVITE, env, ROSTER);

function cookieOf(res) {
  const line = res.headers.get("Set-Cookie");
  assert.ok(line, "a session cookie was issued");
  return line.split(";")[0];
}

const identifyAs = (env, tctx, cookie) =>
  W.identify(new Request(`${ORIGIN}/`, { headers: { Cookie: cookie } }), env, ROSTER,
    { sessionKeys: !!tctx.SESSION_KEYS, tctx });

// ── flag on: the landing ─────────────────────────────────────────────────────

test("FLAG ON: the redeemed link answers with a session, and no credential exists at any point", async () => {
  const env = freshEnv();
  const t = await W.mintInvite(CTX_ON, env, INVITEE.email);

  // The GET shows a one-click confirmation — no password field anywhere on it.
  const page = await W.inviteGet(CTX_ON, new URL(`${ORIGIN}/__invite?t=${encodeURIComponent(t)}`), env);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.equal(/type="password"/i.test(html), false, "no password input");
  assert.equal(/name="password"/i.test(html), false, "no password field at all");
  assert.equal(/Set your password/.test(html), false, "no password prompt");
  assert.ok(html.includes(INVITEE.email), "says whose account this admits");

  // The POST redeems: a real 303 with the session cookie, no password submitted.
  const res = await postRedeem(CTX_ON, env, { token: t });
  assert.equal(res.status, 303);
  const cookie = cookieOf(res);
  assert.match(cookie, /^__Host-augur_user=/);

  // The cookie resolves — a REAL session for a person who holds no credential.
  const who = await identifyAs(env, CTX_ON, cookie);
  assert.equal(who && who.email, INVITEE.email);
  assert.equal(await W.effectiveSecret(env, INVITEE), "", "still no credential of any kind");
  assert.equal(env.COMMENTS.m.has("users:secrets"), false, "users:secrets was never written");
});

test("FLAG ON: the same link is refused the second time, identically to an expired one", async () => {
  const env = freshEnv();
  const t = await W.mintInvite(CTX_ON, env, INVITEE.email);
  assert.equal((await postRedeem(CTX_ON, env, { token: t })).status, 303, "first redemption");

  const second = await postRedeem(CTX_ON, env, { token: t });
  assert.equal(second.status, 400, "second redemption refused");

  const env2 = freshEnv();
  const dead = await W.mintInvite(CTX_ON, env2, INVITEE.email, Date.now() - W.INVITE_TTL_MS - 60000);
  const expired = await postRedeem(CTX_ON, env2, { token: dead });
  assert.equal(expired.status, 400, "expired link refused");

  // A caller cannot tell "already used" from "expired": same status, same bytes.
  assert.equal(await second.text(), await expired.text());
});

test("FLAG ON: the GET never consumes — a scanned (viewed) link still redeems", async () => {
  const env = freshEnv();
  const t = await W.mintInvite(CTX_ON, env, INVITEE.email);
  const u = new URL(`${ORIGIN}/__invite?t=${encodeURIComponent(t)}`);
  assert.equal((await W.inviteGet(CTX_ON, u, env)).status, 200);
  assert.equal((await W.inviteGet(CTX_ON, u, env)).status, 200, "viewed twice, still alive");
  assert.equal((await postRedeem(CTX_ON, env, { token: t })).status, 303, "then redeems");
});

test("an invite minted BEFORE the flag was on redeems into a session AFTER — the hash is the contract", async () => {
  const env = freshEnv();
  const t = await W.mintInvite(CTX_OFF, env, INVITEE.email); // minted under the old regime
  const res = await postRedeem(CTX_ON, env, { token: t });   // redeemed under the new one
  assert.equal(res.status, 303);
  assert.equal((await identifyAs(env, CTX_ON, cookieOf(res))).email, INVITEE.email);
});

// ── flag on: nothing existing is removed ─────────────────────────────────────

test("FLAG ON: someone who already has a password still signs in with it, unchanged", async () => {
  const env = freshEnv();
  const hash = await W.hashPassword("a-long-password");
  await env.COMMENTS.put("users:secrets", JSON.stringify({ [HOLDER.email]: hash }));
  assert.ok(await W.verifyPassword("a-long-password", await W.effectiveSecret(env, HOLDER)), "the credential still verifies");
  // The cookie /__auth would mint (same call, same flag) resolves.
  const token = await W.userToken(env, HOLDER, undefined, true, CTX_ON);
  const who = await identifyAs(env, CTX_ON, `__Host-augur_user=${HOLDER.email}.${token}`);
  assert.equal(who && who.email, HOLDER.email);
});

test("FLAG OFF: byte-for-byte the old landing — a password form, and no password is no session", async () => {
  const env = freshEnv();
  const t = await W.mintInvite(CTX_OFF, env, INVITEE.email);
  const html = await (await W.inviteGet(CTX_OFF, new URL(`${ORIGIN}/__invite?t=${encodeURIComponent(t)}`), env)).text();
  assert.match(html, /type="password"/, "the set-password form");
  assert.match(html, /Set your password/);

  const bare = await postRedeem(CTX_OFF, env, { token: t });
  assert.equal(bare.status, 400, "a POST without a password is refused, and does not burn the link");

  const res = await postRedeem(CTX_OFF, env, { token: t, password: "a-long-password" });
  assert.equal(res.status, 303, "the old path still works end to end");
  assert.ok(env.COMMENTS.m.has("users:secrets"), "and it writes the credential, as it always has");
});

// ── flag on: sessions still END ──────────────────────────────────────────────

test("FLAG ON: rotate ends a link-established session — the cookie ceases to resolve", async () => {
  const env = freshEnv();
  const t = await W.mintInvite(CTX_ON, env, INVITEE.email);
  const cookie = cookieOf(await postRedeem(CTX_ON, env, { token: t }));
  assert.equal((await identifyAs(env, CTX_ON, cookie)).email, INVITEE.email, "live before the rotate");

  const rot = await W.rotateSessionKey(env, INVITEE.email, CTX_ON);
  assert.equal(rot.ok, true);
  assert.equal(await identifyAs(env, CTX_ON, cookie), null, "ended by the rotate");
});

test("FLAG ON: a broken session-key read is a REFUSAL, never an admission", async () => {
  const env = freshEnv();
  const t = await W.mintInvite(CTX_ON, env, INVITEE.email);
  const cookie = cookieOf(await postRedeem(CTX_ON, env, { token: t }));
  assert.equal((await identifyAs(env, CTX_ON, cookie)).email, INVITEE.email);

  // Corrupt shape: an array passes `typeof === "object"` — the seam must refuse, not
  // fall through to a credential this person does not have (or worse, to nothing).
  const good = env.COMMENTS.m.get(W.SESSION_KEYS_KEY);
  await env.COMMENTS.put(W.SESSION_KEYS_KEY, "[]");
  assert.equal(await identifyAs(env, CTX_ON, cookie), null, "corrupt store refuses");

  // A store that throws on the read refuses too.
  await env.COMMENTS.put(W.SESSION_KEYS_KEY, good);
  const throwing = {
    ...env,
    COMMENTS: {
      ...env.COMMENTS,
      async get(k) { if (k === W.SESSION_KEYS_KEY) throw new Error("kv down"); return env.COMMENTS.get(k); },
    },
  };
  assert.equal(await identifyAs(throwing, CTX_ON, cookie), null, "unreadable store refuses");

  // And the same cookie still resolves once the store answers again — the refusal was
  // the read's, not the session's.
  assert.equal((await identifyAs(env, CTX_ON, cookie)).email, INVITEE.email);
});

test("FLAG ON: no stored key and no credential is still a refusal — the forgery identify() exists to stop", async () => {
  const env = freshEnv();
  // A forged cookie built from public data: tokenFor("<email>:") — the exact shape the
  // guard predates. No session key exists for this person and they hold no credential.
  const forged = `__Host-augur_user=${INVITEE.email}.${await W.tokenFor(INVITEE.email + ":")}`;
  assert.equal(await identifyAs(env, CTX_ON, forged), null);
});

// ── the mail describes where the link lands ──────────────────────────────────

test("the invite mail on a passwordless deployment promises no password — and vice versa", () => {
  const vars = { workspace: "Example", link: "https://x.test/__invite?t=abc", expiresHours: 168 };
  const pw = renderMail("roster-invite", vars);
  assert.match(pw.text, /Choose a password/);
  assert.match(pw.html, /Set your password/);
  const pwless = renderMail("roster-invite", { ...vars, passwordless: true });
  for (const part of [pwless.text, pwless.html, pwless.subject]) {
    assert.equal(/choose a password|set your password|set a( new)? password/i.test(part), false, "no password promised anywhere");
  }
  assert.match(pwless.text, /no password to set/, "says so out loud");
  assert.match(pwless.html, /Accept invitation/);
});

test("the reset mail on a passwordless deployment says sign back in, not choose a new password", () => {
  const vars = { workspace: "Example", link: "https://x.test/__invite?t=abc", expiresHours: 168 };
  const pw = renderMail("credential-reset", vars);
  assert.match(pw.text, /Choose a new one/);
  const pwless = renderMail("credential-reset", { ...vars, passwordless: true });
  for (const part of [pwless.text, pwless.html, pwless.subject]) {
    assert.equal(/choose a( new)? password|set a new password|your password/i.test(part), false, "no password promised anywhere");
  }
  assert.match(pwless.html, /Sign back in/);
});

// ── the admin panel tells the truth about a passwordless acceptance ──────────

test("FLAG ON: a link-redeemed person reads as accepted in the people list, not pending forever", async () => {
  const env = freshEnv();
  const t = await W.mintInvite(CTX_ON, env, INVITEE.email);
  assert.equal((await postRedeem(CTX_ON, env, { token: t })).status, 303);

  const res = await W.adminUsersApi(CTX_ON, new Request(`${ORIGIN}/__admin/users`), new URL(`${ORIGIN}/__admin/users`), env, HOLDER, ROSTER, ROSTER);
  assert.equal(res.status, 200);
  const body = await res.json();
  const row = body.users.find((u) => u.email === INVITEE.email);
  assert.equal(row.state, "accepted", "redeemed-by-link is accepted");
  const holder = body.users.find((u) => u.email === HOLDER.email);
  assert.equal(holder.state, "pending", "no credential and no key is still pending");
});
