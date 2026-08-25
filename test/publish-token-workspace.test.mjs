// A publish token's LABEL is an email, and an email only means a person relative to one
// workspace's roster. `publishAuth` re-checks that label's role on every resolve — a
// star-scope token whose holder is no longer an admin is refused, and a viewer may hold
// no token at all — because the revoke that fires on demotion cannot reach a token minted
// while the overlay was mid-write, a hand-edited identity file, or a config push that
// landed first.
//
// Until the identity cluster was threaded, that lookup read a module-scope roster. Two
// things follow, and this file pins both:
//
//   1. The four verdicts themselves, which nothing else in the suite reaches.
//   2. That the verdict follows the WORKSPACE. The same token, the same label, resolved
//      against two different rosters, answers differently — which is precisely what a
//      module global could not express, and therefore what a single-tenant era could not
//      observe going wrong.
//
// Why here rather than in the response snapshot: this whole route is bundle-mode only
// (`publishApi` answers 501 without a BUNDLES binding) and the snapshot corpus runs in
// assets mode, so no byte-level baseline watches it. It runs in bundle mode below.
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
// Holds a star-scope token minted while they WERE an admin; the roster says otherwise now.
const DEMOTED = { email: "was@example.test", name: "Was", role: "editor" };
const VIEWER = { email: "look@example.test", name: "Look", role: "viewer" };

// Mint a token straight into the store, the shape /__admin/tokens writes.
async function mint(kv, label, space) {
  const raw = "tok-" + label;
  const map = JSON.parse((await kv.get("publish:tokens")) || "{}");
  map[await W.tokenFor("pub:" + raw)] = { space, label };
  await kv.put("publish:tokens", JSON.stringify(map));
  return raw;
}

const bearer = (t) => new Request("https://x.test/__publish/alpha/check", {
  headers: { Authorization: "Bearer " + t },
});

// publishAuth is internal, so drive it through the one caller that exposes its verdict:
// `forbidden` is what it produces, and any other answer means the token got PAST it.
async function pastAuth(ctx, env, token) {
  const res = await W.publishApi(ctx, bearer(token), new URL("https://x.test/__publish/alpha/check"), env);
  if (res.status !== 403) return true;
  return (await res.json()).error !== "forbidden";
}

test("a publish token's role re-check answers to the workspace's roster, not the isolate's", async () => {
  const kv = memKV();
  // BUNDLES bound: this route exists only in bundle mode, which is what every deployed
  // instance serves in and what the response snapshot does not cover.
  const env = { COMMENTS: kv, BUNDLES: {} };

  const tAdmin = await mint(kv, ADMIN.email, "*");
  const tDemoted = await mint(kv, DEMOTED.email, "*");
  const tViewer = await mint(kv, VIEWER.email, "alpha");
  const tHand = await mint(kv, "ci", "*"); // a label no roster user answers to

  const ctx = W.applyInstance({ users: [ADMIN, DEMOTED, VIEWER] });

  assert.equal(await pastAuth(ctx, env, tAdmin), true,
    "a real admin's star-scope token resolves");
  assert.equal(await pastAuth(ctx, env, tDemoted), false,
    "a star-scope token outlived the admin role that justified it — refused");
  assert.equal(await pastAuth(ctx, env, tViewer), false,
    "a viewer may hold no publish token, however it was minted");
  assert.equal(await pastAuth(ctx, env, tHand), true,
    "a hand-typed label matching no roster user is unaffected by either check");

  // The whole point of threading identity: same token, same label, different workspace.
  // Next door that address IS an admin, so the very token refused above resolves — an
  // answer a module-scope roster had no way to give.
  const neighbour = Object.freeze({ ...ctx, USERS: [{ ...DEMOTED, role: "admin" }] });
  assert.equal(await pastAuth(neighbour, env, tDemoted), true,
    "the verdict follows the workspace the request is for");

  W.applyInstance({ users: [] }); // leave module state as found
});
