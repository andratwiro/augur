// After a restore, can anybody get in?
//
// `MIG-delta-roster-gap`. Every other question about a backup is about content; this one is
// about whether the copy is worth anything. A workspace restored with its pages, its
// comments and its boards intact, that nobody can sign in to, has not been restored.
//
// THE COPY DELIBERATELY DOES NOT CARRY PASSWORD HASHES. `users:secrets` is destined for the
// account store — a credential is account-level, one address across several workspaces — so
// the export walks past it, and a test in `state-export` asserts it cannot be reached at
// all. That is right for a hosted workspace and it leaves a real question for a SELF-HOSTED
// one, where there is no account store and `users:secrets` in KV IS the credential.
//
// THE ANSWER IS THE SEED, and it already works: `effectiveSecret` falls back to the roster's
// baked `pass` when the KV key is ABSENT, and after a restore into a fresh instance it is
// absent. So the deploy shell's `identity.json` is what lets the first admin in, and from
// there they reset everybody — which is the same path a brand-new instance takes on its
// first day. Nothing has to be carried, and nothing has to be surgically put back.
//
// ⚠️ The nuance worth stating plainly, because it is the difference between a promise kept
// and a promise nearly kept: they sign in with the SEED password from the shell, not with
// whatever they had changed it to. If those differ, the difference is discovered here
// rather than during a recovery.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

const SEED_PASSWORD = "correct-horse-battery-staple";

function memKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async getWithMetadata(k) { return { value: store.get(k) ?? null, metadata: null }; },
    async put(k, v) { store.set(k, typeof v === "string" ? v : JSON.stringify(v)); },
    async delete(k) { store.delete(k); },
    async list({ prefix = "" } = {}) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}
const memR2 = () => ({
  store: new Map(),
  async head() { return null; }, async get() { return null; },
  async put() {}, async delete() {},
  async list() { return { objects: [], truncated: false }; },
});

const CTX_ID = "acme";

/** The shell's identity file, as build.js bakes it into the instance config. */
async function shellRoster() {
  const hash = await W.hashPassword(SEED_PASSWORD);
  return [
    { email: "boss@example.test", name: "Boss", role: "admin", pass: hash },
    { email: "ed@example.test", name: "Ed", role: "editor", pass: hash },
  ];
}

test("A RESTORED WORKSPACE HAS ITS ROSTER BACK", async () => {
  // The invite/remove overlay travels; it is workspace state, not a credential.
  const from = {
    COMMENTS: memKv({
      "users:roster": JSON.stringify({
        add: { "later@example.test": { email: "later@example.test", name: "Later", role: "viewer" } },
        remove: ["gone@example.test"],
      }),
      "users:names": JSON.stringify({ "ed@example.test": { name: "Edie Renamed", at: "2026-08-16T19:02:39.768Z" } }),
      "users:lastseen:boss@example.test": JSON.stringify("2026-08-01T00:00:00.000Z"),
    }),
    BUNDLES: memR2(),
  };
  const ctx = Object.freeze({ ...W.applyInstance({ users: [] }), tenantId: CTX_ID });
  const doc = await W.exportState(ctx, from);

  const to = { COMMENTS: memKv(), BUNDLES: memR2() };
  assert.equal((await W.importState(ctx, to, doc)).ok, true);

  const roster = JSON.parse(to.COMMENTS.store.get("users:roster"));
  assert.equal(roster.add["later@example.test"].role, "viewer");
  assert.deepEqual(roster.remove, ["gone@example.test"], "a removal did not survive — a removed person would be back");
  assert.equal(JSON.parse(to.COMMENTS.store.get("users:names"))["ed@example.test"].name, "Edie Renamed");
  assert.ok(to.COMMENTS.store.has("users:lastseen:boss@example.test"));
});

test("THE FIRST ADMIN CAN SIGN IN AFTER A RESTORE, with the shell's seed password", async () => {
  // The literal test of the promise. The restored instance has no `users:secrets` at all,
  // and that is exactly the state in which `effectiveSecret` falls back to the roster the
  // shell baked — so the recovery path is the same one a brand-new instance takes on day
  // one, with nothing to carry and no KV surgery.
  const users = await shellRoster();
  const env = { COMMENTS: memKv(), BUNDLES: memR2() };
  assert.equal(env.COMMENTS.store.has("users:secrets"), false, "the fixture is not a restored instance");

  const boss = users[0];
  const secret = await W.effectiveSecret(env, boss);
  assert.ok(secret, "the seeded admin has no effective secret, so nothing can sign them in");
  assert.equal(await W.verifyPassword(SEED_PASSWORD, secret), true);
  assert.equal(await W.verifyPassword("something-else", secret), false);

  // And a session token can actually be derived for them, which is the step that refuses
  // when there is no secret.
  const token = await W.userToken(env, boss);
  assert.match(token, /^[0-9a-f]{64}$/);
});

test("⚠️ AND NOT WITH A PASSWORD THEY CHANGED IT TO, which is the nuance", async () => {
  // Stated as a test because it is the difference between a promise kept and a promise
  // nearly kept, and it should be discovered here rather than during a recovery.
  const users = await shellRoster();
  const boss = users[0];

  // The live instance, where they had changed it.
  const live = { COMMENTS: memKv({
    "users:secrets": JSON.stringify({ [boss.email]: await W.hashPassword("what-they-actually-use") }),
  }) };
  assert.equal(await W.verifyPassword("what-they-actually-use", await W.effectiveSecret(live, boss)), true);

  // The restored one, which carries no secrets: the seed is what works.
  const restored = { COMMENTS: memKv() };
  const secret = await W.effectiveSecret(restored, boss);
  assert.equal(await W.verifyPassword("what-they-actually-use", secret), false,
    "the changed password survived a restore that does not carry credentials");
  assert.equal(await W.verifyPassword(SEED_PASSWORD, secret), true);
});

test("A RESET TOMBSTONE IS NOT RESURRECTED BY A RESTORE", async () => {
  // The direction this must never be wrong in. A tombstone (`users:secrets` holding null
  // for somebody) is what stops a reset person signing in with the roster's seed. If a
  // restore carried the roster and dropped the tombstone, every reset password on the
  // instance would come back into service at once — so the export must not be the thing
  // that reinstates one, and it is not: it never touches `users:secrets` in either
  // direction.
  const users = await shellRoster();
  const ed = users[1];
  const env = { COMMENTS: memKv({ "users:secrets": JSON.stringify({ [ed.email]: null }) }), BUNDLES: memR2() };
  const ctx = Object.freeze({ ...W.applyInstance({ users: [] }), tenantId: CTX_ID });

  const doc = await W.exportState(ctx, env);
  assert.equal("users:secrets" in doc.families, false);

  // Replaying that copy over the live instance leaves the tombstone exactly where it was.
  assert.equal((await W.importState(ctx, env, doc)).ok, true);
  assert.deepEqual(JSON.parse(env.COMMENTS.store.get("users:secrets")), { [ed.email]: null });
  assert.equal(await W.effectiveSecret(env, ed), "", "a reset person got their seed password back");
});

test("what a restore does NOT carry is stated in the copy, not inferred", async () => {
  // The `absent` list is what an operator reads to know what they are holding. A family
  // that could not be read and a family that is empty must not look the same, and a family
  // that was never reachable must not look like either.
  const ctx = Object.freeze({ ...W.applyInstance({ users: [] }), tenantId: CTX_ID });
  const doc = await W.exportState(ctx, { COMMENTS: memKv(), BUNDLES: memR2() });
  assert.equal("users:secrets" in doc.families, false);
  assert.equal(doc.absent.includes("users:secrets"), false,
    "the credential is reported as an absent family, which reads as 'this instance has none'");
  assert.deepEqual(doc.failed, []);
});
