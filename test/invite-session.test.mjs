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
import { DatabaseSync } from "node:sqlite";
import { __testables as W } from "../src/_worker.js";
import { TenantStore } from "../src/tenant-do.js";
import { renderMail } from "../src/mail.mjs";

const ORIGIN = "https://x.test";
const URL_INVITE = new URL(`${ORIGIN}/__invite`);
const INVITEE = { email: "new@x.test", name: "New Person", role: "editor" };
const HOLDER = { email: "holder@x.test", name: "Holder", role: "admin" };
const WATCHER = { email: "watcher@x.test", name: "Watcher", role: "viewer" };
const ROSTER = [INVITEE, HOLDER, WATCHER];

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

// ── a real workspace object behind the redemption ────────────────────────────
//
// Everything above this line drives `invitePost` with no TENANTS binding at all — the
// self-hosted shape, where nothing is recorded and nothing changes. The welcome-owed
// stamp needs the other shape: a provisioned workspace object with member rows, so the
// redemption has somewhere to write and the test can read the row back. Same
// `storage()`/`wired()` construction as test/onboarding-me.test.mjs.
function storage(db) {
  const sql = {
    exec(stmt, ...params) {
      if (params.length) {
        const s = db.prepare(stmt);
        return /^\s*SELECT|RETURNING/i.test(stmt) ? s.all(...params) : (s.run(...params), []);
      }
      if (/^\s*SELECT/i.test(stmt)) return db.prepare(stmt).all();
      db.exec(stmt);
      return [];
    },
  };
  return {
    sql,
    transactionSync(cb) {
      db.exec("BEGIN");
      try { const out = cb(); db.exec("COMMIT"); return out; }
      catch (e) { db.exec("ROLLBACK"); throw e; }
    },
  };
}

let SEQ = 0;

async function wired(base) {
  const tenantId = `invite-${++SEQ}`;
  const db = new DatabaseSync(":memory:");
  const object = new TenantStore({ storage: storage(db), blockConcurrencyWhile: async (f) => f() }, {});
  await object.provision({ workspaceId: tenantId, adminEmail: HOLDER.email, adminName: HOLDER.name });
  await object.fetch(new Request("https://workspace/identity/roster/write", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: tenantId, configUsers: ROSTER.map((u) => ({ email: u.email, role: u.role, name: u.name })) }),
  }));
  const env = {
    ...freshEnv(),
    TENANTS: { idFromName: (n) => n, get: () => ({ fetch: (input, init) => object.fetch(new Request(input, init)) }) },
  };
  return { env, object, db, tctx: { ...base, tenantId } };
}

/** Whichever key this deployment's KV view put the invite map under. */
const inviteDoc = (env) => [...env.COMMENTS.m.keys()].find((k) => k.endsWith("users:invites"));

const owedAt = async (object, user) => {
  const res = await object.fetch(new Request("https://workspace/onboarding/welcome", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: user.email }),
  }));
  const body = await res.json();
  return body.member ? body.member.welcomeOwedAt : null;
};

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
  const record = await W.sessionKeyName(INVITEE.email);
  const good = env.COMMENTS.m.get(record);
  assert.ok(good, "the redemption wrote this person's own record");
  await env.COMMENTS.put(record, "[]");
  assert.equal(await identifyAs(env, CTX_ON, cookie), null, "corrupt store refuses");

  // A store that throws on the read refuses too.
  await env.COMMENTS.put(record, good);
  const throwing = {
    ...env,
    COMMENTS: {
      ...env.COMMENTS,
      async get(k) { if (k === record) throw new Error("kv down"); return env.COMMENTS.get(k); },
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

// ── redeeming an invite is what makes the welcome flow owed ──────────────────
//
// ⚠️ THE GATE MUST NOT BE DERIVABLE FROM MEMBERSHIP. `welcomeGated` reads
// `welcome_owed_at`, and this is the only thing in the engine that writes it: without the
// stamp, the flow's conditions are true of every editor and admin a workspace already had,
// and deploying it onto a real roster gates the whole team. So the record is made HERE, on
// the one event the flow is actually for — a person arriving by an invite.

test("FLAG ON: a redeemed EDITOR invite marks the member owed the welcome flow", async () => {
  const { env, object, tctx } = await wired(CTX_ON);
  assert.equal(await owedAt(object, INVITEE), null, "nothing is owed before the redemption");

  const t = await W.mintInvite(tctx, env, INVITEE.email);
  assert.equal((await postRedeem(tctx, env, { token: t })).status, 303);
  assert.ok(await owedAt(object, INVITEE), "the redemption stamped it");
});

test("FLAG OFF: the password path stamps it too — the door differs, the event does not", async () => {
  const { env, object, tctx } = await wired(CTX_OFF);
  const t = await W.mintInvite(tctx, env, INVITEE.email);
  const res = await postRedeem(tctx, env, { token: t, password: "a-long-password" });
  assert.equal(res.status, 303);
  assert.ok(await owedAt(object, INVITEE), "the credential path owes the flow as well");
});

test("a redeemed VIEWER invite owes nobody anything", async () => {
  // Viewers are never gated (the global constraint), so they are never stamped either —
  // a column nothing reads for them would be a record with no meaning, and the role check
  // sits at the write as well as at the read.
  const { env, object, tctx } = await wired(CTX_ON);
  const t = await W.mintInvite(tctx, env, WATCHER.email);
  assert.equal((await postRedeem(tctx, env, { token: t })).status, 303, "the viewer still gets in");
  assert.equal(await owedAt(object, WATCHER), null);
});

test("a workspace object that refuses the stamp never costs the person their session", async () => {
  // The stamp runs AFTER the token is burned, so a throw escaping it would answer a
  // successful redemption with "something went wrong" and a dead link.
  const { env, object, tctx } = await wired(CTX_ON);
  const t = await W.mintInvite(tctx, env, INVITEE.email);
  const real = env.TENANTS.get;
  env.TENANTS.get = (n) => {
    const r = real(n);
    return {
      fetch: (input, init) => {
        const path = new URL(typeof input === "string" ? input : input.url).pathname;
        if (path === "/onboarding/welcome-set") return Promise.reject(new Error("workspace object unreachable"));
        return r.fetch(input, init);
      },
    };
  };
  const res = await postRedeem(tctx, env, { token: t });
  assert.equal(res.status, 303, "the redemption stands");
  assert.ok(res.headers.get("Set-Cookie"), "and the session was issued");
  env.TENANTS.get = real;
  assert.equal(await owedAt(object, INVITEE), null, "the stamp is the only thing lost");
});

// ── and a PASSWORD RESET is not an arrival ───────────────────────────────────
//
// ⚠️ ONE MECHANISM SERVES BOTH, WHICH IS EXACTLY THE HAZARD. The reset op in
// `adminUsersApi` mints through the same `mintInvite`, hands back the same `/__invite?t=`
// link, and redeems through this same handler — so with nothing on the record saying why
// it was minted, a member of five years recovering their password was stamped owed and
// held at a door built for somebody's first day. The record carries the reason; the
// redemption reads it.

test("FLAG ON: a redeemed RESET link admits the person and owes them nothing", async () => {
  const { env, object, tctx } = await wired(CTX_ON);
  const t = await W.mintInvite(tctx, env, INVITEE.email, undefined, { kind: "reset" });
  const res = await postRedeem(tctx, env, { token: t });
  assert.equal(res.status, 303, "the reset link still lets them back in");
  assert.ok(res.headers.get("Set-Cookie"), "with a real session");
  assert.equal(await owedAt(object, INVITEE), null, "and no welcome flow is owed to somebody who was already here");
});

test("FLAG OFF: the password path reads the kind too — both doors, one rule", async () => {
  const { env, object, tctx } = await wired(CTX_OFF);
  const t = await W.mintInvite(tctx, env, INVITEE.email, undefined, { kind: "reset" });
  assert.equal((await postRedeem(tctx, env, { token: t, password: "a-long-password" })).status, 303);
  assert.equal(await owedAt(object, INVITEE), null);
});

test("a record minted before the kind existed is NOT read as an invitation", async () => {
  const { env, object, db, tctx } = await wired(CTX_ON);
  const t = await W.mintInvite(tctx, env, INVITEE.email);

  // The shape a link minted before this deploy has in BOTH stores: the object's column
  // says nothing, and the KV record carries no such field at all. Absent is no answer, and
  // the welcome flow may only be owed by a link that provably invited somebody — so this
  // fails toward NOT gated, the direction every degradation on this path takes.
  db.exec("UPDATE invites SET kind = NULL");
  const key = inviteDoc(env);
  const map = JSON.parse(await env.COMMENTS.get(key));
  for (const rec of Object.values(map)) delete rec.kind;
  await env.COMMENTS.put(key, JSON.stringify(map));

  assert.equal((await postRedeem(tctx, env, { token: t })).status, 303, "the old link still redeems");
  assert.equal(await owedAt(object, INVITEE), null, "and stamps nobody");
});

test("the reset op mints a RESET and the invite op mints an INVITATION", async () => {
  // Read at the seam the two ops share, so the kind is a property of what the ADMIN did
  // rather than of what this test typed: the same panel, the same link, two records.
  const { env, tctx } = await wired(CTX_ON);
  const req = (body) => W.adminUsersApi(tctx, new Request(`${ORIGIN}/__admin/users`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), new URL(`${ORIGIN}/__admin/users`), env, HOLDER, ROSTER, ROSTER);

  const reset = await req({ op: "reset", email: INVITEE.email });
  assert.equal(reset.status, 200, await reset.clone().text());
  const invite = await req({ op: "invite", email: "fresh@x.test", role: "editor" });
  assert.equal(invite.status, 200, await invite.clone().text());

  const map = JSON.parse(await env.COMMENTS.get(inviteDoc(env)));
  const kinds = Object.fromEntries(Object.values(map).map((r) => [r.email.toLowerCase(), r.kind]));
  assert.equal(kinds[INVITEE.email], "reset", "a reset link says it is a reset");
  assert.equal(kinds["fresh@x.test"], "invite", "an invitation says it is one");
});
