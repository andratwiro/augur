// The three-role model. Until now it was aspirational: the panel could only ever
// produce `admin` or `user`, `editor` did not exist as a string anywhere, and `viewer`
// was enforced in exactly one place but could not be created — so the only way to
// change anyone's role was remove-and-re-invite, which loses their password and still
// could not make a viewer.
//
// The two things these tests really guard are the ones that cannot be undone from
// inside the product: demoting the last admin (an instance with no admin needs a
// redeploy to recover), and a demotion that leaves the old privilege alive in a token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

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
const ADMIN = { email: "admin@example.test", name: "Admin", role: "admin" };
const ADMIN2 = { email: "boss@example.test", name: "Boss", role: "admin" };
const LEGACY = { email: "old@example.test", name: "Old", role: "user" };
const EDITOR = { email: "ed@example.test", name: "Ed", role: "editor" };
const VIEWER = { email: "vi@example.test", name: "Vi", role: "viewer" };
const NOROLE = { email: "nr@example.test", name: "Nr" };

const URL_ = new URL("https://example.test/__admin/users");
const post = (body) => new Request("https://example.test/__admin/users", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const call = (body, env, users, config = []) => W.adminUsersApi(post(body), URL_, env, ADMIN, users, config);

// ---- the vocabulary ---------------------------------------------------------

test("roleOf: legacy `user`, an absent role and junk all read as editor", () => {
  assert.equal(W.roleOf(LEGACY), "editor", "the legacy spelling is not a fourth role");
  assert.equal(W.roleOf(NOROLE), "editor");
  assert.equal(W.roleOf({ role: "" }), "editor");
  assert.equal(W.roleOf({ role: "superuser" }), "editor", "an unrecognised value must not grant anything");
  assert.equal(W.roleOf(null), "editor");
  assert.equal(W.roleOf(ADMIN), "admin");
  assert.equal(W.roleOf(VIEWER), "viewer");
  assert.equal(W.roleOf(EDITOR), "editor");
});

test("a roster row stored as `user` behaves identically to one stored as `editor`", () => {
  assert.equal(W.roleOf(LEGACY), W.roleOf(EDITOR));
  assert.deepEqual(W.publicUser(LEGACY).role, W.publicUser(EDITOR).role);
  assert.equal(W.publicUser(LEGACY).admin, false);
});

test("applyRoles overlays a role, and refuses to invent one", () => {
  const users = [ADMIN, LEGACY];
  const out = W.applyRoles(users, { "old@example.test": "viewer" });
  assert.equal(W.roleOf(out[1]), "viewer");
  // A corrupt or hand-edited overlay must not be able to blank or invent a role.
  for (const junk of ["superuser", "", null, 42, undefined]) {
    const same = W.applyRoles(users, { "old@example.test": junk });
    assert.equal(W.roleOf(same[1]), "editor", `junk overlay value: ${JSON.stringify(junk)}`);
  }
});

// ---- the verb ---------------------------------------------------------------

test("an admin promotes and demotes, and it lands in the overlay immediately", async () => {
  const kv = memKV();
  const env = envWith(kv);
  const res = await call({ op: "role", email: "ed@example.test", role: "viewer" }, env, [ADMIN, EDITOR]);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.from, "editor");
  assert.equal(body.role, "viewer");
  assert.deepEqual(JSON.parse(await kv.get("users:roles")), { "ed@example.test": "viewer" });

  const back = await call({ op: "role", email: "ed@example.test", role: "editor" }, env, [ADMIN, EDITOR]);
  assert.equal((await back.json()).role, "editor");
});

test("changing a config user back to what identity.json says DRAINS the overlay", async () => {
  const kv = memKV();
  const env = envWith(kv);
  const users = [ADMIN, EDITOR];
  await call({ op: "role", email: "ed@example.test", role: "viewer" }, env, users, [ADMIN, EDITOR]);
  assert.ok(JSON.parse(await kv.get("users:roles"))["ed@example.test"], "overlay set while it differs");

  await call({ op: "role", email: "ed@example.test", role: "editor" }, env, users, [ADMIN, EDITOR]);
  assert.deepEqual(JSON.parse(await kv.get("users:roles")), {},
    "back in agreement with the file — a leftover entry would override it forever after");
});

test("the last admin cannot be demoted, and is still an admin afterwards", async () => {
  const kv = memKV();
  const env = envWith(kv);
  const users = [ADMIN, EDITOR];
  const res = await call({ op: "role", email: "admin@example.test", role: "editor" }, env, users);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, "last-admin");
  assert.match(body.message, /only admin/i);
  assert.equal(await kv.get("users:roles"), null, "nothing written");
  assert.equal(W.roleOf(users[0]), "admin");
});

test("with a second admin, demoting the first is allowed", async () => {
  const env = envWith(memKV());
  const res = await call({ op: "role", email: "admin@example.test", role: "editor" }, env, [ADMIN, ADMIN2]);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).role, "editor");
});

test("the last-admin count sees legacy and overlay users, not just config", async () => {
  // ADMIN is the only admin however the other two are spelled.
  const env = envWith(memKV());
  const res = await call({ op: "role", email: "admin@example.test", role: "viewer" }, env, [ADMIN, LEGACY, NOROLE]);
  assert.equal(res.status, 409);
});

test("an unknown user and an unknown role are refused distinctly", async () => {
  const env = envWith(memKV());
  const a = await call({ op: "role", email: "nobody@example.test", role: "viewer" }, env, [ADMIN]);
  assert.equal(a.status, 400);
  assert.equal((await a.json()).error, "unknown-user");

  const b = await call({ op: "role", email: "ed@example.test", role: "superuser" }, env, [ADMIN, EDITOR]);
  assert.equal(b.status, 400);
  const body = await b.json();
  assert.equal(body.error, "bad-role");
  assert.deepEqual(body.roles, ["admin", "editor", "viewer"]);
});

test("a no-op role change is reported as such, without touching anything", async () => {
  const kv = memKV();
  const res = await call({ op: "role", email: "ed@example.test", role: "editor" }, envWith(kv), [ADMIN, EDITOR]);
  assert.equal((await res.json()).unchanged, true);
  assert.equal(kv.store.has("users:roles"), false);
});

test("only an admin may change a role at all", async () => {
  const env = envWith(memKV());
  for (const who of [null, EDITOR, VIEWER, LEGACY]) {
    const res = await W.adminUsersApi(post({ op: "role", email: "ed@example.test", role: "admin" }), URL_, env, who, [ADMIN, EDITOR]);
    assert.equal(res.status, 403, `${who ? who.email : "anonymous"} must not change roles`);
  }
});

// ---- the demotion must not leave privilege behind ---------------------------

test("demoting to viewer revokes their publish tokens", async () => {
  // Two tokens: one this person holds, one belonging to someone else.
  const tokens = {
    hashA: { space: "*", label: "ed@example.test" },
    hashB: { space: "alpha", label: "someone@example.test" },
  };
  const kv = memKV({ "publish:tokens": JSON.stringify(tokens) });
  const env = envWith(kv);
  await call({ op: "role", email: "ed@example.test", role: "viewer" }, env, [ADMIN, ADMIN2, EDITOR]);
  const after = JSON.parse(await kv.get("publish:tokens"));
  assert.equal(after.hashA, undefined, "a viewer may hold no publish token");
  assert.ok(after.hashB, "and nobody else's token is touched");
});

test("losing admin revokes the star-scope token that role justified", async () => {
  const kv = memKV({
    "publish:tokens": JSON.stringify({ h: { space: "*", label: "boss@example.test" } }),
  });
  const env = envWith(kv);
  await call({ op: "role", email: "boss@example.test", role: "editor" }, env, [ADMIN, ADMIN2]);
  assert.deepEqual(JSON.parse(await kv.get("publish:tokens")), {});
});

test("removing someone drops their role overlay — a re-invite must not inherit admin", async () => {
  const kv = memKV({ "users:roles": JSON.stringify({ "ed@example.test": "admin" }) });
  const env = envWith(kv);
  await call({ op: "remove", email: "ed@example.test" }, env, [ADMIN, EDITOR], []);
  assert.deepEqual(JSON.parse(await kv.get("users:roles")), {});
});

// ---- invite can now produce all three -------------------------------------

test("invite accepts every role, and still defaults to editor", async () => {
  for (const [asked, expected] of [["admin", "admin"], ["viewer", "viewer"], ["editor", "editor"],
    [undefined, "editor"], ["user", "editor"], ["superuser", "editor"]]) {
    const kv = memKV();
    const email = `p${expected}${asked}@example.test`.toLowerCase();
    await call({ op: "invite", email, ...(asked ? { role: asked } : {}) }, envWith(kv), [ADMIN]);
    const roster = JSON.parse(await kv.get("users:roster"));
    assert.equal(roster.add[email].role, expected, `asked for ${asked}`);
  }
});

// ---- what each role may actually do ----------------------------------------

test("the public user shape reports the role, and only an admin reads as admin", () => {
  const table = [[ADMIN, "admin", true], [EDITOR, "editor", false], [VIEWER, "viewer", false],
    [LEGACY, "editor", false], [NOROLE, "editor", false]];
  for (const [u, role, isAdmin] of table) {
    const p = W.publicUser(u);
    assert.equal(p.role, role, u.email);
    assert.equal(p.admin, isAdmin, u.email);
    assert.equal(p.pass, undefined);
  }
});
