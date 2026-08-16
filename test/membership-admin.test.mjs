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
