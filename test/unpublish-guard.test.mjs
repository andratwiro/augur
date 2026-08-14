// The unpublish guard: a publish may not take live public pages off the site unless
// it asked to. This is the rule that stands between one person's checkout and
// everyone else's shareable links, so the cases below are the incident it came from,
// written down.
//
// A publish ships ONE working tree as the WHOLE space, routing fragment included. A
// tree that is missing a folder therefore removes it, for everyone, and the publisher
// sees nothing wrong: their own preview is correct, and the gate answers a path it no
// longer knows with the login page — so a page that is GONE looks merely LOCKED. That
// is what happened on 2026-08-10: seven toolkit prototypes left the public list for
// 53 minutes, and every iframe embed pasted into a third-party site rendered a
// password form until the next good publish put them back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

const removed = W.removedPublicPrefixes;
const live = (...prefixes) => ({ routing: { publicPrefixes: prefixes } });

test("an ordinary publish that changes nothing about the public surface removes nothing", () => {
  assert.deepEqual(removed(live("/toolkit/storytelling-widgets/"), live("/toolkit/storytelling-widgets/")), []);
});

test("adding pages is never a removal", () => {
  assert.deepEqual(
    removed(live("/toolkit/home/"), live("/toolkit/home/", "/toolkit/survey-studio/")),
    [], "publishing new work must stay frictionless — the guard is about loss only");
});

test("the incident: a tree with the folder nested elsewhere takes every URL under it down", () => {
  // The tree behind the incident had the opportunity folder inside playground/, so the
  // prototypes still SHIPPED — at /playground/<opp>/prototypes/… — while every
  // advertised URL disappeared. The content still being present somewhere, under an
  // address nobody had been given, is exactly why this went unnoticed.
  const before = live("/toolkit/storytelling-widgets/", "/toolkit/map-embed/", "/ux-ui-audit/x/");
  const after = live("/playground/toolkit/", "/ux-ui-audit/x/");
  assert.deepEqual(removed(before, after), ["/toolkit/storytelling-widgets/", "/toolkit/map-embed/"]);
});

test("a stale checkout removes the work it has never seen", () => {
  assert.deepEqual(
    removed(live("/a/one/", "/a/two/"), live("/a/one/")),
    ["/a/two/"], "publishing from behind must not silently revert a colleague");
});

test("first publish of a space removes nothing (no live manifest to lose)", () => {
  for (const noLive of [null, undefined, {}, { routing: {} }]) {
    assert.deepEqual(removed(noLive, live("/a/one/")), [], `live=${JSON.stringify(noLive)}`);
  }
});

test("a manifest carrying no routing at all still counts as removing everything live", () => {
  // The dangerous direction: an incoming manifest missing the fragment would
  // otherwise read as "nothing to compare" and wipe the public surface.
  for (const noRouting of [{}, { routing: {} }, { routing: { publicPrefixes: [] } }]) {
    assert.deepEqual(removed(live("/a/one/"), noRouting), ["/a/one/"], `next=${JSON.stringify(noRouting)}`);
  }
});

test("order and duplicates carry no meaning — only membership does", () => {
  assert.deepEqual(removed(live("/b/", "/a/", "/b/"), live("/a/", "/b/")), []);
  assert.deepEqual(removed(live("/a/", "/a/", "/c/"), live("/a/")), ["/c/"],
    "a prefix listed twice is reported once");
});

test("deleting a prototype is a real removal — the flag is the only way past, not a special case", () => {
  // The guard has no notion of a legitimate deletion, deliberately: the store cannot
  // tell "I deleted this" from "my checkout lost this". Only the person can, and
  // --allow-unpublish is them saying so.
  assert.deepEqual(removed(live("/a/one/", "/a/two/"), live("/a/one/")), ["/a/two/"]);
});

// ---- The endpoint, not just the predicate -----------------------------------
// The commit handler is where the refusal has to happen: it is the one door BOTH
// publish paths go through (the classic upload-then-commit and the one-round-trip
// inline commit, which never calls /check), and the only one a client cannot skip.

// In-memory R2 covering the subset publishApi touches.
function memR2(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(k) { return store.has(k) ? { text: async () => store.get(k), body: store.get(k) } : null; },
    async put(k, v) { store.set(k, typeof v === "string" ? v : JSON.stringify(v)); },
    async head(k) { return store.has(k) ? {} : null; },
    async list({ prefix = "", delimiter } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix));
      if (!delimiter) return { objects: keys.map((k) => ({ key: k })), truncated: false };
      const pre = new Set();
      for (const k of keys) {
        const rest = k.slice(prefix.length);
        const i = rest.indexOf(delimiter);
        if (i >= 0) pre.add(prefix + rest.slice(0, i + 1));
      }
      return { objects: [], delimitedPrefixes: [...pre], truncated: false };
    },
  };
}

const LIVE = {
  id: "alpha", version: 4, format: 1,
  space: { id: "alpha", default: true },
  files: { "/toolkit/widgets/index.html": { h: "a".repeat(64), ct: "text/html", s: 10 } },
  routing: { publicPrefixes: ["/toolkit/widgets/", "/toolkit/map/"], versionMap: {} },
};

const envWithLive = () => ({
  BUNDLES: memR2({ "spaces/alpha/manifest.json": JSON.stringify(LIVE) }),
  PUBLISH_BOOTSTRAP_TOKEN: "tok",
});

const commit = (env, manifest) => W.publishApi(
  new Request("https://x.test/__publish/alpha/commit", {
    method: "POST",
    headers: { Authorization: "Bearer tok", "content-type": "application/json" },
    body: JSON.stringify(manifest),
  }),
  new URL("https://x.test/__publish/alpha/commit"),
  env);

// A publish from a checkout that has lost /toolkit/ — same files, poorer routing.
const droppedToolkit = {
  id: "alpha", format: 1, files: LIVE.files,
  space: { id: "alpha", default: true },
  routing: { publicPrefixes: ["/toolkit/widgets/"], versionMap: {} },
};

test("the commit endpoint refuses a publish that would take a live page down", async () => {
  const env = envWithLive();
  const res = await commit(env, droppedToolkit);
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.error, "unpublish-refused");
  assert.deepEqual(body.removed, ["/toolkit/map/"]);
  assert.equal(body.count, 1);

  const after = JSON.parse(env.BUNDLES.store.get("spaces/alpha/manifest.json"));
  assert.equal(after.version, 4, "the live manifest is untouched — refused means nothing shipped");
});

test("a star-scope token is guarded too — a maintainer's stale tree removes just as much", async () => {
  // PUBLISH_BOOTSTRAP_TOKEN authenticates as space "*", which skips the per-space
  // ownership checks. The guard must sit OUTSIDE that block: the incident that
  // motivated it could as easily have come from a maintainer's clone.
  const res = await commit(envWithLive(), droppedToolkit);
  assert.equal(res.status, 422);
});

test("--allow-unpublish lets the same publish through, and the flag is never persisted", async () => {
  const env = envWithLive();
  const res = await commit(env, { ...droppedToolkit, allowUnpublish: true });
  assert.equal(res.status, 200);
  const after = JSON.parse(env.BUNDLES.store.get("spaces/alpha/manifest.json"));
  assert.equal(after.version, 5);
  assert.deepEqual(after.routing.publicPrefixes, ["/toolkit/widgets/"]);
  assert.equal("allowUnpublish" in after, false,
    "transport-only: a persisted flag would exempt every later publish");
  assert.equal("allowUnpublish" in JSON.parse(env.BUNDLES.store.get("spaces/alpha/versions/5.json")), false);
});

test("a publish that only adds is never blocked", async () => {
  const env = envWithLive();
  const res = await commit(env, {
    id: "alpha", format: 1, files: LIVE.files,
    space: { id: "alpha", default: true },
    routing: { publicPrefixes: ["/toolkit/widgets/", "/toolkit/map/", "/toolkit/new/"], versionMap: {} },
  });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(env.BUNDLES.store.get("spaces/alpha/manifest.json")).version, 5);
});

test("the first publish of a space is not blocked by an empty store", async () => {
  const env = { BUNDLES: memR2(), PUBLISH_BOOTSTRAP_TOKEN: "tok" };
  const res = await commit(env, {
    id: "alpha", format: 1, files: {},
    space: { id: "alpha", default: true },
    routing: { publicPrefixes: ["/toolkit/widgets/"], versionMap: {} },
  });
  assert.equal(res.status, 200);
});
