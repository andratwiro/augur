// The session cookie's name is load-bearing.
//
// Several workspaces share one apex host, so a page published on one of them can set a
// cookie with `Domain=.<apex>` and the browser will send it to a sibling workspace too.
// It can never FORGE a session — the token is an HMAC over SESSION_SECRET plus the
// user's effective secret — but it can SHADOW the real cookie and break login on the
// sibling, because identify() reads the first cookie under the name it is looking for.
// `__Host-` is a browser-enforced prefix: a cookie under such a name is stored only when
// it is Secure, has Path=/ and carries NO Domain, so the tossed cookie is refused before
// it ever reaches the worker.
//
// Nothing here can drive a real browser, so what these tests pin is the half that lives
// in the engine: the ONLY name ever issued is the current prefixed one, every issue and
// clear keeps the three attributes the prefix requires, and the read side accepts every
// older name for the length of the migration window with the current one winning.
//
// ⏳ The "old name" cases below are per NAME, not per window: when a name leaves
// LEGACY_USER_COOKIES its entry leaves OLD, and the last one out takes these cases with
// it. OLD is deliberately a LIST — the read set is three names, not two, because one live
// deployment never issued the `__Host-` prefixed form at all and its sessions are still
// under the bare name.
import { test } from "node:test";
import assert from "node:assert/strict";

import { default as worker, __testables as W } from "../src/_worker.js";

const NEW = "__Host-augur_user";
const OLD = ["__Host-gv_user", "gv_user"];

const ORIGIN = "https://example.test";
const SESSION_SECRET = "cookie-prefix-fixed-session-secret";
const PASSWORD = "a properly long password";

function memKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
  };
}

// A real PBKDF2 hash so POST /__auth can actually succeed. Computed once, at import, and
// seeded as the roster's passHash — with KV bound but no users:secrets key,
// effectiveSecret() falls back to it, exactly as a first admin's does.
const PASS_HASH = await W.hashPassword(PASSWORD);
const USER = { email: "ada@example.test", name: "Ada", initials: "A", role: "admin", passHash: PASS_HASH };
const OTHER = { email: "bo@example.test", name: "Bo", initials: "B", passHash: "bo-seed-passhash" };
const ROSTER = [USER, OTHER];

const INSTANCE_JSON = {
  users: ROSTER, engineVersion: "1.0.0-cookie", updateFeed: "",
  mcpHostSuffixes: [], mcpHostAllowlistUrl: "", vanityRedirects: {}, rtOrigin: "", sentinels: [],
};
const ROUTING_JSON = {
  buildId: "cookie-build", versionMap: {}, publicPrefixes: [], publicSkillPrefixes: [],
  restrictedBases: [], canvasLoaderExtras: "", canvasCatalog: [], canvasTracks: [], mcpAllowlist: [],
  spaces: [{ id: "one", name: "One", badge: "O", default: true, base: "", adminOnly: false }],
  defaultSpace: "one",
};
const CONFIG = {
  "/__config/instance.json": JSON.stringify(INSTANCE_JSON),
  "/__config/routing.json": JSON.stringify(ROUTING_JSON),
};

const env = {
  COMMENTS: memKV(),
  SESSION_SECRET,
  ASSETS: {
    async fetch(req) {
      const p = new URL(typeof req === "string" ? req : req.url).pathname;
      const body = CONFIG[p];
      if (body === undefined) return new Response("Not Found", { status: 404 });
      return new Response(body, { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } });
    },
  },
};
const ctx = { waitUntil() {} };

const identifyWith = (cookie) =>
  W.identify(new Request(ORIGIN, { headers: { Cookie: cookie } }), env, ROSTER);

const setCookies = (res) =>
  (res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("Set-Cookie")]).filter(Boolean);

// A cookie is named by everything before the first "=" of a Set-Cookie line.
const nameOf = (line) => line.slice(0, line.indexOf("="));

// ---- the read side ----------------------------------------------------------

test("a cookie under the prefixed name authenticates", async () => {
  const token = await W.userToken(env, USER);
  const me = await identifyWith(`${NEW}=${USER.email}.${token}`);
  assert.equal(me && me.email, USER.email);
});

test("⏳ a cookie under EVERY older name still authenticates during the migration window", async () => {
  const token = await W.userToken(env, USER);
  for (const old of OLD) {
    const me = await identifyWith(`${old}=${USER.email}.${token}`);
    assert.equal(me && me.email, USER.email, `a session issued under ${old} survives the deploy`);
  }
});

test("⏳ the bare legacy name is read as itself, not as a suffix of the prefixed one", async () => {
  // The two old names differ only by the prefix, so a matcher that looked for `gv_user`
  // anywhere would call a `__Host-gv_user` cookie a bare one and vice versa. Each has to
  // be found on its own, including when the header carries only the other.
  const token = await W.userToken(env, USER);
  assert.ok(await identifyWith(`__Host-gv_user=${USER.email}.${token}`));
  assert.ok(await identifyWith(`gv_user=${USER.email}.${token}`));
  // A single header holding both, either order, still resolves to that one user.
  assert.ok(await identifyWith(`gv_user=${USER.email}.${token}; __Host-gv_user=${USER.email}.${token}`));
});

test("⏳ the current name wins, so no older-name cookie can shadow a live session", async () => {
  const mine = await W.userToken(env, USER);
  const theirs = await W.userToken(env, OTHER);
  // Both orders, for each older name: a sibling workspace controls where in the header its
  // cookie lands, and the current name must win either way.
  for (const old of OLD) {
    for (const cookie of [
      `${old}=${OTHER.email}.${theirs}; ${NEW}=${USER.email}.${mine}`,
      `${NEW}=${USER.email}.${mine}; ${old}=${OTHER.email}.${theirs}`,
    ]) {
      const me = await identifyWith(cookie);
      assert.equal(me && me.email, USER.email, cookie);
    }
  }
  // And the older names are consulted in list order, so the newest of them wins between
  // themselves — the same no-shadowing rule one rung down.
  const both = `${OLD[1]}=${OTHER.email}.${theirs}; ${OLD[0]}=${USER.email}.${mine}`;
  assert.equal((await identifyWith(both)).email, USER.email, both);
});

test("a garbage cookie under any name is refused, it does not fall through to the others", async () => {
  const token = await W.userToken(env, USER);
  assert.equal(await identifyWith(`${NEW}=${USER.email}.deadbeef`), null);
  for (const old of OLD) assert.equal(await identifyWith(`${old}=${USER.email}.deadbeef`), null);
  assert.equal(await identifyWith(`${NEW}=nonsense`), null);
  assert.equal(await identifyWith(""), null);
  // A refused CURRENT cookie is the end of it: a valid older cookie beside it must not
  // rescue the request, or the migration window becomes a way to downgrade a session.
  assert.equal(await identifyWith(`${NEW}=${USER.email}.deadbeef; ${OLD[0]}=${USER.email}.${token}`), null);
});

test("each name is matched exactly — a lookalike cookie is not the session", async () => {
  const token = await W.userToken(env, USER);
  for (const name of [NEW, ...OLD]) {
    assert.equal(await identifyWith(`x${name}=${USER.email}.${token}`), null, `x${name}`);
    assert.equal(await identifyWith(`${name}_x=${USER.email}.${token}`), null, `${name}_x`);
  }
});

// ---- the write side: only ever the prefixed name ----------------------------

// Every session cookie the worker hands out has to satisfy the prefix's three rules, or
// the browser silently drops it and nobody can stay signed in.
function assertPrefixSafe(line) {
  assert.equal(nameOf(line), NEW, `issued under the prefixed name: ${line}`);
  assert.match(line, /;\s*Path=\/(;|$)/, "Path=/");
  assert.match(line, /;\s*Secure(;|$)/, "Secure");
  assert.equal(/;\s*Domain=/i.test(line), false, "no Domain attribute");
  assert.match(line, /;\s*HttpOnly(;|$)/, "HttpOnly");
}

test("POST /__auth issues the session under the prefixed name, and only that name", async () => {
  const body = new URLSearchParams({ email: USER.email, password: PASSWORD, redirect: "/" });
  const res = await worker.fetch(new Request(`${ORIGIN}/__auth`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  }), env, ctx);
  assert.equal(res.status, 303, "signed in");
  const lines = setCookies(res);
  assert.equal(lines.length, 1);
  assertPrefixSafe(lines[0]);
  assert.match(lines[0], new RegExp(`^${NEW}=${USER.email.replace("@", "(@|%40)")}\\.[0-9a-f]+;`));
});

test("redeeming an invite issues the session under the prefixed name, and only that name", async () => {
  const inviteEnv = { ...env, COMMENTS: memKV() };
  const t = await W.mintInvite(null, inviteEnv, OTHER.email);
  const res = await W.invitePost(W.applyDerivedRouting({}), new Request(`${ORIGIN}/__invite`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: t, password: PASSWORD }).toString(),
  }), new URL(`${ORIGIN}/__invite`), inviteEnv, ROSTER);
  assert.equal(res.status, 303, "redeemed");
  const lines = setCookies(res);
  assert.equal(lines.length, 1);
  assertPrefixSafe(lines[0]);
});

test("no older name is ever issued by anything the worker answers with", async () => {
  const body = new URLSearchParams({ email: USER.email, password: PASSWORD, redirect: "/" });
  const res = await worker.fetch(new Request(`${ORIGIN}/__auth`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  }), env, ctx);
  for (const line of setCookies(res)) {
    assert.equal(OLD.includes(nameOf(line)), false, "a login must not put a session back under an old name");
  }
});

test("⏳ a login under an older name re-issues under the current one, and only that one", async () => {
  // This is what drains the window: the person is signed in on a legacy cookie, signs in
  // again, and walks away holding the current name. If the response ever carried an old
  // name too, no window would ever close.
  const token = await W.userToken(env, USER);
  const body = new URLSearchParams({ email: USER.email, password: PASSWORD, redirect: "/" });
  const res = await worker.fetch(new Request(`${ORIGIN}/__auth`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: `${OLD[0]}=${USER.email}.${token}` },
    body: body.toString(),
  }), env, ctx);
  const lines = setCookies(res);
  assert.equal(lines.length, 1);
  assertPrefixSafe(lines[0]);
});

// ---- signing out has to reach the cookie the browser is actually holding ----

test("/__logout clears every name, each with the attributes its own name requires", async () => {
  const res = await worker.fetch(new Request(`${ORIGIN}/__logout`), env, ctx);
  assert.equal(res.status, 303);
  const lines = setCookies(res);
  assert.deepEqual(lines.map(nameOf).sort(), [NEW, ...OLD].sort(), "⏳ every name cleared");
  for (const line of lines) {
    assert.match(line, /;\s*Max-Age=0(;|$)/, `expires immediately: ${line}`);
    assert.match(line, /;\s*Path=\/(;|$)/, `Path=/: ${line}`);
    assert.match(line, /;\s*Secure(;|$)/, `Secure: ${line}`);
    assert.equal(/;\s*Domain=/i.test(line), false, `no Domain: ${line}`);
  }
  // The clear for the prefixed name is itself a Set-Cookie under that name, so it has to
  // satisfy the prefix too — otherwise the browser ignores it and sign-out does nothing.
  assertPrefixSafe(lines.find((l) => nameOf(l) === NEW));
});

test("⏳ a session signed out under ANY older name really is over", async () => {
  const token = await W.userToken(env, USER);
  for (const old of OLD) {
    const cookie = `${old}=${USER.email}.${token}`;
    assert.ok(await identifyWith(cookie), `live before sign-out: ${old}`);
    const res = await worker.fetch(new Request(`${ORIGIN}/__logout`, { headers: { Cookie: cookie } }), env, ctx);
    const cleared = setCookies(res).find((l) => nameOf(l) === old);
    assert.ok(cleared, `sign-out names the cookie the browser is holding: ${old}`);
    assert.match(cleared, /=;/, "cleared to an empty value");
  }
});
