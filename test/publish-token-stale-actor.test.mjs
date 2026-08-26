// A publish token is only as good as the membership behind it, checked on every publish.
//
// `B-publish-auth-full-recheck`. Removing or demoting somebody revokes their tokens today,
// so in the happy path this changes nothing. The re-check exists for when that revoke does
// NOT run: a hand-edited identity file, a config push that lands before the revoke, a
// token minted while the roster overlay was mid-write, a removal verb somebody writes next
// year that forgets the call. Every test below therefore edits the roster DIRECTLY,
// bypassing the admin API, because bypassing it is the whole scenario.
//
// WHAT WAS ACTUALLY WRONG, and it is worth stating because the old code read as correct:
// the two checks were shaped `if (u && …) return null`. Both PASSED when `u` was
// undefined, and `u` is undefined in exactly one case — the person was REMOVED rather than
// demoted. So a demoted editor was caught and a deleted one was not. The smaller failure
// was guarded and the larger one waved through.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

function memKV(init = {}) {
  const store = new Map(Object.entries(init));
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
  };
}

const ADMIN = { email: "boss@example.test", name: "Boss", role: "admin" };
const EDITOR = { email: "ed@example.test", name: "Ed", role: "editor" };

/** Mint a token straight into the store, the shape /__admin/tokens writes. */
async function mint(kv, label, space) {
  const raw = "tok-" + label + "-" + space;
  const map = JSON.parse((await kv.get("publish:tokens")) || "{}");
  map[await W.tokenFor("pub:" + raw)] = { space, label };
  await kv.put("publish:tokens", JSON.stringify(map));
  return raw;
}

/** Whether a token gets PAST publishAuth. `forbidden` is that function's verdict. */
async function publishes(ctx, env, token) {
  const url = new URL("https://x.test/__publish/alpha/check");
  const quiet = console.log; console.log = () => {};
  try {
    const res = await W.publishApi(ctx, new Request(url, { headers: { Authorization: "Bearer " + token } }), url, env);
    if (res.status !== 403) return true;
    return (await res.json()).error !== "forbidden";
  } finally { console.log = quiet; }
}

const roster = (users) => W.applyInstance({ users });

// ── the case the old check waved through ─────────────────────────────────────

test("A REMOVED EDITOR'S TOKEN STOPS WORKING, even if nothing revoked it", async () => {
  // The VERIFY. The removal here goes nowhere near adminUsersApi, so no revoke fires —
  // which is the point: this is what a future removal-verb bug looks like from the outside.
  const kv = memKV();
  const env = { COMMENTS: kv, BUNDLES: {} };
  const token = await mint(kv, EDITOR.email, "alpha");

  assert.equal(await publishes(roster([ADMIN, EDITOR]), env, token), true,
    "an editor who is still a member cannot publish — the fixture proves nothing");

  // Gone from the roster. The token map is untouched, deliberately.
  assert.equal(await publishes(roster([ADMIN]), env, token), false,
    "a token outlived the membership that justified it");
  assert.ok((await kv.get("publish:tokens")).includes("ed@example.test"),
    "the token was revoked after all, so this tested the revoke rather than the re-check");
  roster([]);
});

test("a removed ADMIN's star-scope token stops working too", async () => {
  // Star scope pushes instance config — the user list itself. A removed admin holding one
  // could put themselves back.
  const kv = memKV();
  const env = { COMMENTS: kv, BUNDLES: {} };
  const token = await mint(kv, ADMIN.email, "*");
  assert.equal(await publishes(roster([ADMIN, EDITOR]), env, token), true);
  assert.equal(await publishes(roster([EDITOR]), env, token), false);
  roster([]);
});

// ── the cases it already caught, which must keep working ─────────────────────

test("an editor demoted to viewer stops publishing on the NEXT publish, not the next login", async () => {
  // The second half of the VERIFY. There is no session here to expire: a publish token is
  // presented by a CLI that never signs in again.
  const kv = memKV();
  const env = { COMMENTS: kv, BUNDLES: {} };
  const token = await mint(kv, EDITOR.email, "alpha");
  assert.equal(await publishes(roster([ADMIN, EDITOR]), env, token), true);
  assert.equal(await publishes(roster([ADMIN, { ...EDITOR, role: "viewer" }]), env, token), false);
  roster([]);
});

test("an admin demoted to editor keeps their own workspace but loses star scope", async () => {
  const kv = memKV();
  const env = { COMMENTS: kv, BUNDLES: {} };
  const star = await mint(kv, ADMIN.email, "*");
  const scoped = await mint(kv, ADMIN.email, "alpha");
  const demoted = roster([{ ...ADMIN, role: "editor" }]);
  assert.equal(await publishes(demoted, env, star), false, "a star-scope token survived the demotion");
  assert.equal(await publishes(demoted, env, scoped), true, "an editor lost the workspace they may still publish");
  roster([]);
});

// ── what must NOT be caught ──────────────────────────────────────────────────

test("A MACHINE TOKEN IS UNAFFECTED — there is no person behind a label an admin typed", () => {
  // The discriminator is the `@`. Without it, asking the roster about "ci" would refuse
  // every machine token on the instance the moment this shipped — including the ones a
  // status page publishes with.
  const ctx = W.applyInstance({ users: [ADMIN] });
  for (const label of ["ci", "backup", "uptime-probe", "deploy-bot", ""]) {
    assert.equal(W.tokenActorRefusal(ctx, { space: "*", label }), null, `${label} was refused`);
    assert.equal(W.tokenActorRefusal(ctx, { space: "alpha", label }), null, `${label} was refused`);
  }
  assert.equal(W.tokenActorRefusal(ctx, { space: "alpha" }), null, "an unlabelled token was refused");
  W.applyInstance({ users: [] });
});

test("the verdict follows the WORKSPACE, not the isolate", async () => {
  // An address means a person only relative to one roster. The same token refused here can
  // legitimately resolve next door, and a neighbour's roster must never be what answers.
  const kv = memKV();
  const env = { COMMENTS: kv, BUNDLES: {} };
  const token = await mint(kv, EDITOR.email, "alpha");
  const here = roster([ADMIN]);                       // Ed is not a member here
  const nextDoor = Object.freeze({ ...here, USERS: [EDITOR] });
  assert.equal(await publishes(here, env, token), false);
  assert.equal(await publishes(nextDoor, env, token), true);
  roster([]);
});

// ── the reasons, so a refusal is diagnosable ─────────────────────────────────

test("each refusal says which of the three things went wrong", () => {
  const ctx = W.applyInstance({ users: [ADMIN, EDITOR, { email: "look@example.test", role: "viewer" }] });
  assert.equal(W.tokenActorRefusal(ctx, { space: "alpha", label: "gone@example.test" }), "not-a-member");
  assert.equal(W.tokenActorRefusal(ctx, { space: "alpha", label: "look@example.test" }), "viewer-role");
  assert.equal(W.tokenActorRefusal(ctx, { space: "*", label: EDITOR.email }), "not-an-admin");
  assert.equal(W.tokenActorRefusal(ctx, { space: "*", label: ADMIN.email }), null);
  assert.equal(W.tokenActorRefusal(ctx, { space: "alpha", label: EDITOR.email }), null);
  W.applyInstance({ users: [] });
});

test("a label is matched the way an address is matched, not the way a string is", () => {
  // userByEmail folds case and trims; a token labelled with a capitalised address at mint
  // time must not stop working because the roster spells it in lower case.
  const ctx = W.applyInstance({ users: [EDITOR] });
  assert.equal(W.tokenActorRefusal(ctx, { space: "alpha", label: "ED@Example.TEST" }), null);
  assert.equal(W.tokenActorRefusal(ctx, { space: "alpha", label: "  ed@example.test  " }), null);
  W.applyInstance({ users: [] });
});
