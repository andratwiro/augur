// Membership as an ADMIN action. Two things here cannot be undone from inside the
// product, so both are guarded and both are tested:
//
//   - Emptying a space of admins. An instance with no admin needs a redeploy to
//     recover (roles.test.mjs guards the instance-wide case); a space with no admin
//     is the same trap one level down.
//   - An admin of one space reaching into another. Per-space roles are only worth
//     anything if the authority to CHANGE them is scoped the same way.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";
import { emptyTenantContext, withTenantFields } from "../src/tenant-context.mjs";

// The workspace whose admin panel this is. adminUsersApi defaults its roster, config
// list and workspace list off the context now; every case here passes its own lists
// explicitly, so this only has to be a real context, not a populated one.
const CTX = W.applyDerivedRouting({});

function memKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
  };
}
const envWith = (kv) => ({ COMMENTS: kv });
const SPACES = [
  { id: "alpha", name: "Alpha", default: true, base: "" },
  { id: "beta", name: "Beta", base: "/beta" },
];
const BOSS = { email: "boss@example.test", name: "Boss", role: "editor" };
const ED = { email: "ed@example.test", name: "Ed", role: "editor" };
const GLOBAL = { email: "g@example.test", name: "G", role: "admin" };

const withSpaces = (users, index) => W.applySpaces(users, index);

test("the last admin of a space is recognised, and stops being the last when another arrives", () => {
  const one = withSpaces([BOSS, ED], {
    "boss@example.test": { alpha: "admin" },
    "ed@example.test": { alpha: "editor" },
  });
  assert.equal(W.lastAdminOf(one, "alpha", "boss@example.test"), true);

  const two = withSpaces([BOSS, ED], {
    "boss@example.test": { alpha: "admin" },
    "ed@example.test": { alpha: "admin" },
  });
  assert.equal(W.lastAdminOf(two, "alpha", "boss@example.test"), false);
});

test("a global admin with no membership recorded counts as an admin of every space", () => {
  const users = withSpaces([BOSS, GLOBAL], { "boss@example.test": { alpha: "admin" } });
  assert.equal(W.lastAdminOf(users, "alpha", "boss@example.test"), false,
    "the global admin is still there, so boss is not the last one");
  assert.equal(W.lastAdminOf(users, "beta", "g@example.test"), true,
    "and in beta the global admin IS the last one");
});

test("someone's own admin-ness never counts toward 'is there another admin'", () => {
  const users = withSpaces([BOSS], { "boss@example.test": { alpha: "admin" } });
  assert.equal(W.lastAdminOf(users, "alpha", "boss@example.test"), true);
  assert.equal(W.lastAdminOf(users, "alpha", "BOSS@Example.Test"), true,
    "matched case-insensitively, or the guard is trivially bypassed by capitalisation");
});

test("a space admin has authority in their own space and none in another", () => {
  const [boss] = withSpaces([BOSS], { "boss@example.test": { alpha: "admin", beta: "editor" } });
  assert.equal(W.roleIn(boss, "alpha"), "admin");
  assert.equal(W.roleIn(boss, "beta"), "editor");
  assert.equal(W.administersAny(boss, SPACES), true, "reaches /admin, but only for alpha");
});

test("clearSpaces drops the entry so a re-invited address inherits nothing", async () => {
  const kv = memKV({ "users:spaces": JSON.stringify({
    "e@example.test": { alpha: "admin" }, "keep@example.test": { beta: "editor" },
  }) });
  await W.clearSpaces(envWith(kv), "E@Example.Test");
  assert.deepEqual(JSON.parse(kv.store.get("users:spaces")), { "keep@example.test": { beta: "editor" } });
});

test("clearSpaces on an address with no entry leaves the document untouched", async () => {
  const kv = memKV({ "users:spaces": JSON.stringify({ "keep@example.test": { beta: "editor" } }) });
  await W.clearSpaces(envWith(kv), "nobody@example.test");
  assert.deepEqual(JSON.parse(kv.store.get("users:spaces")), { "keep@example.test": { beta: "editor" } });
});

// ---- password reset is an ACCOUNT action, not a space-admin power ------------

test("an admin of one space cannot reset an account that reaches into another", () => {
  const users = withSpaces([BOSS, ED], {
    "boss@example.test": { alpha: "admin" },
    "ed@example.test": { alpha: "editor", beta: "editor" },
  });
  assert.equal(W.mayResetPassword(users, "boss@example.test", "ed@example.test", SPACES), false,
    "resetting would hand boss a route into beta, which they were never given");
});

test("a reset is allowed when every space the target is in is one the actor administers", () => {
  const users = withSpaces([BOSS, ED], {
    "boss@example.test": { alpha: "admin" },
    "ed@example.test": { alpha: "editor" },
  });
  assert.equal(W.mayResetPassword(users, "boss@example.test", "ed@example.test", SPACES), true);
});

test("a target with no membership recorded reaches every space, so only a global admin may reset them", () => {
  const users = withSpaces([BOSS, ED, GLOBAL], { "boss@example.test": { alpha: "admin" } });
  assert.equal(W.mayResetPassword(users, "boss@example.test", "ed@example.test", SPACES), false,
    "ed is in every space; boss administers one");
  assert.equal(W.mayResetPassword(users, "g@example.test", "ed@example.test", SPACES), true,
    "the global admin administers all of them");
});

test("on an instance that never set memberships, every admin may reset anyone — as today", () => {
  const users = [GLOBAL, ED];
  assert.equal(W.mayResetPassword(users, "g@example.test", "ed@example.test", SPACES), true);
});

// ---- reading a roster is scoped too -----------------------------------------

test("administering SOME space is not authority to read ANOTHER space's roster", async () => {
  // The door check is administersAny; the read check must be per space, or an admin of
  // one workspace enumerates every other workspace's members by editing the query string.
  const users = withSpaces([BOSS, ED], {
    "boss@example.test": { alpha: "admin" },
    "ed@example.test": { beta: "editor" },
  });
  const [boss] = users;
  assert.equal(W.administersAny(boss, SPACES), true, "gets through the door");
  assert.equal(W.roleIn(boss, "beta"), "editor", "but has no authority in beta");

  const req = new Request("https://example.test/__admin/users?space=beta");
  const res = await W.adminUsersApi(CTX, req, new URL(req.url), envWith(memKV()), boss, users, [], SPACES);
  assert.equal(res.status, 403);
});

test("an admin reading their own space's roster is answered", async () => {
  const users = withSpaces([BOSS, ED], {
    "boss@example.test": { alpha: "admin" },
    "ed@example.test": { alpha: "editor" },
  });
  const req = new Request("https://example.test/__admin/users?space=alpha");
  const res = await W.adminUsersApi(CTX, req, new URL(req.url), envWith(memKV()), users[0], users, [], SPACES);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.space, "alpha");
  assert.deepEqual(body.users.map((u) => u.email).sort(), ["boss@example.test", "ed@example.test"]);
  assert.equal(body.users.find((u) => u.email === "ed@example.test").role, "editor",
    "the role reported is the one in THIS space");
});

// ---- workspace icon ---------------------------------------------------------
// Same shape as a profile photo, one authority level up: the workspace's admin sets
// it, not the person. The two rules worth guarding are that authority is per
// workspace, and that an ungated serve route cannot be turned into a KV probe.

const iconEnv = (kv, users, index) => ({ COMMENTS: kv });

test("only an admin of THAT workspace may set its icon", async () => {
  const kv = memKV();
  const users = withSpaces([BOSS, ED], {
    "boss@example.test": { alpha: "admin" },
    "ed@example.test": { alpha: "editor", beta: "admin" },
  });
  // PNG magic + padding: parseAvatarDataUri rejects anything under 16 bytes.
  const png = "data:image/png;base64," +
    Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,13,10,26,10]), Buffer.alloc(24)]).toString("base64");
  const req = (email, space) => new Request("https://example.test/__admin/space-icon", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ space, icon: png }),
  });
  const boss = users[0], ed = users[1];

  let res = await W.spaceIconApi(req(boss.email, "beta"), iconEnv(kv), boss, SPACES);
  assert.equal(res.status, 403, "boss administers alpha, not beta");

  res = await W.spaceIconApi(req(ed.email, "alpha"), iconEnv(kv), ed, SPACES);
  assert.equal(res.status, 403, "ed is only an editor in alpha");

  res = await W.spaceIconApi(req(ed.email, "beta"), iconEnv(kv), ed, SPACES);
  assert.equal(res.status, 200, "ed administers beta");
});

test("an unknown workspace is refused before any authority check", async () => {
  const users = withSpaces([BOSS], { "boss@example.test": { alpha: "admin" } });
  const req = new Request("https://example.test/__admin/space-icon", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ space: "nope", icon: "data:image/png;base64,iVBORw0KGgo=" }),
  });
  const res = await W.spaceIconApi(req, iconEnv(memKV()), users[0], SPACES);
  assert.equal(res.status, 400);
});

test("a payload whose bytes do not match its declared type is refused", async () => {
  const users = withSpaces([BOSS], { "boss@example.test": { alpha: "admin" } });
  // Declared PNG, actually not — parseAvatarDataUri checks magic bytes, not the label,
  // because the serve route echoes the mime back on an ungated response.
  const req = new Request("https://example.test/__admin/space-icon", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ space: "alpha", icon: "data:image/png;base64," + Buffer.from("<svg/>").toString("base64") }),
  });
  const res = await W.spaceIconApi(req, iconEnv(memKV()), users[0], SPACES);
  assert.equal(res.status, 400);
});

test("applySpaceIcons stamps a URL and vouches for only the hashes it stamped", () => {
  const { SPACES: out, SPACE_ICON_KEYS: keys } = W.applySpaceIcons(SPACES, { alpha: { k: "abc123" } });
  assert.equal(out[0].icon, "/__space-icon/abc123");
  assert.equal("icon" in out[1], false, "a workspace with no icon keeps its repo seed");
  assert.notEqual(out, SPACES, "copies, never in-place — the overlay must not outlive itself");
  // The allowlist is exactly the hashes this list was stamped with, and it comes back
  // WITH the list rather than as a side effect — the two describe one workspace and a
  // caller cannot take one without the other.
  assert.deepStrictEqual([...keys], ["abc123"]);
});

test("the serve route refuses a hash the index never vouched for", async () => {
  const vouched = W.applySpaceIcons(SPACES, { alpha: { k: "known" } });
  const ctx = withTenantFields(emptyTenantContext("alpha"), vouched);
  const res = await W.serveSpaceIcon(ctx, { COMMENTS: memKV() }, "guessed");
  assert.equal(res.status, 404, "an ungated route must not become a KV read amplifier");
});

test("a hash one workspace vouches for is not served by another workspace", async () => {
  // The reason the allowlist is a context field: it used to be one module-scope Set, so
  // whichever workspace loaded last decided which hashes every OTHER workspace's icon
  // route would serve.
  const alpha = withTenantFields(emptyTenantContext("alpha"), W.applySpaceIcons(SPACES, { alpha: { k: "alphaicon" } }));
  const beta = withTenantFields(emptyTenantContext("beta"), W.applySpaceIcons(SPACES, { beta: { k: "betaicon" } }));
  assert.equal(alpha.SPACE_ICON_KEYS.has("alphaicon"), true, "alpha does not vouch for its own hash");
  assert.equal(
    beta.SPACE_ICON_KEYS.has("alphaicon"), false,
    "beta vouches for a hash only alpha's index names",
  );
  const res = await W.serveSpaceIcon(beta, { COMMENTS: memKV() }, "alphaicon");
  assert.equal(res.status, 404, "beta's icon route served a hash alpha vouched for");
});

// ---- a viewer may look, not change -------------------------------------------
// The role existed but two content endpoints never asked about it: /__name renames a
// prototype for everyone, and /__status changes its state for everyone. Both only
// checked "is anyone signed in", so a viewer could do both.

const req = (method, path) => new Request("https://example.test" + path, { method });

test("a viewer cannot rename a prototype or change its status", () => {
  const [v] = withSpaces([{ email: "v@example.test", role: "viewer" }],
    { "v@example.test": { alpha: "viewer" } });
  for (const [p, what] of [["/__name?path=/proj/proto/", "name"], ["/__status?path=/proj/proto/", "status"]]) {
    const res = W.viewerWriteRefusal(req("POST", p), new URL("https://example.test" + p), v, what, SPACES);
    assert.ok(res, `${what} write refused`);
    assert.equal(res.status, 403);
  }
});

test("a viewer may still READ names and statuses", () => {
  const [v] = withSpaces([{ email: "v@example.test", role: "viewer" }],
    { "v@example.test": { alpha: "viewer" } });
  const p = "/__name?path=/proj/proto/";
  assert.equal(W.viewerWriteRefusal(req("GET", p), new URL("https://example.test" + p), v, "name", SPACES), null,
    "reading is looking, not changing");
});

test("an editor and an admin write freely", () => {
  const users = withSpaces([ED, BOSS], {
    "ed@example.test": { alpha: "editor" }, "boss@example.test": { alpha: "admin" },
  });
  const p = "/__name?path=/proj/proto/";
  for (const u of users) {
    assert.equal(W.viewerWriteRefusal(req("POST", p), new URL("https://example.test" + p), u, "name", SPACES), null);
  }
});

test("the role is taken from the one workspace's membership, not the global role or the path", () => {
  // D1 retired (Phase A, S2): every path resolves to the single workspace, so a person
  // holds ONE role in it. A viewer in that workspace — whatever their global role — is
  // refused on EVERY path; the "/beta/..." prefix no longer selects a second space with
  // a different role. (Before the tier retirement this same person was an editor under
  // "/beta/" and allowed there; that path-mounted second answer is what went.)
  const [u] = withSpaces([{ email: "x@example.test", role: "editor" }],
    { "x@example.test": { alpha: "viewer" } });
  const rootPath = "/__name?path=/proj/proto/";
  const betaLike = "/__name?path=/beta/proj/proto/";
  assert.ok(W.viewerWriteRefusal(req("POST", rootPath), new URL("https://example.test" + rootPath), u, "name", SPACES),
    "refused: a viewer in the one workspace, despite the editor global role");
  assert.ok(W.viewerWriteRefusal(req("POST", betaLike), new URL("https://example.test" + betaLike), u, "name", SPACES),
    "still refused: the '/beta/' prefix resolves to the same one workspace now");
});

test("a signed-out caller is not this gate's problem", () => {
  const p = "/__name?path=/x/";
  assert.equal(W.viewerWriteRefusal(req("POST", p), new URL("https://example.test" + p), null, "name", SPACES), null,
    "the auth check ahead of it already answered 401");
});

test("a viewer cannot create a canvas or upload an image", () => {
  // Their canvas rights stop where an anonymous visitor's do, and anonymous cannot
  // upload. Commenting is the one thing a viewer adds.
  const [v] = withSpaces([{ email: "v@example.test", role: "viewer" }],
    { "v@example.test": { alpha: "viewer" } });
  for (const [p, what] of [["/__canvases", "canvas"], ["/__asset", "asset"]]) {
    const res = W.viewerWriteRefusal(req("POST", p), new URL("https://example.test" + p), v, what, SPACES);
    assert.ok(res && res.status === 403, `${what} refused`);
  }
});

test("every viewer refusal explains what the account can do instead", async () => {
  const [v] = withSpaces([{ email: "v@example.test", role: "viewer" }],
    { "v@example.test": { alpha: "viewer" } });
  for (const what of ["name", "status", "canvas", "asset"]) {
    const res = W.viewerWriteRefusal(req("POST", "/__x"), new URL("https://example.test/__x"), v, what, SPACES);
    const body = await res.json();
    assert.equal(body.error, "viewer-role");
    assert.match(body.message, /look around/, `${what} says what the account CAN do`);
  }
});
