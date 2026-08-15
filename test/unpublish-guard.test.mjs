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
// Every prefix passed here is genuinely LIVE — backed by a synthetic file — so
// these fixtures represent real pages, exactly as they did before the guard
// learned to tell live from dead. The dead/orphaned case below builds its
// manifests by hand instead, precisely so it can declare a prefix with nothing
// backing it.
const live = (...prefixes) => ({
  routing: { publicPrefixes: prefixes },
  files: Object.fromEntries(prefixes.map((p) => [`${p}index.html`, { h: "f".repeat(64), ct: "text/html", s: 1 }])),
});

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

// ---- Dead/orphaned prefixes: declared live, backed by nothing ---------------
// The landmine this fix exists for: a prototype gets renamed (or otherwise loses
// its files) and its OLD publicPrefixes entry is left behind in a live manifest —
// a URL that already 404s for every visitor, e.g.
// /toolkit/old-workshop-name/ after that prototype was renamed. The guard used to treat that
// leftover exactly like a real removal, which meant the FIRST person to publish
// after the rename got refused (expected — the rename really did happen), but so
// did EVERY person after them, forever, because nothing ever cleared the orphan
// out of what "live" meant. Fixed at the source: a publicPrefixes entry only
// counts as live if a file backs it (backedPublicPrefixes / isPrefixBacked).
test("a dead/orphaned prefix — live in routing, backed by no file — is not a removal", () => {
  const deadLive = {
    routing: { publicPrefixes: ["/a/one/", "/toolkit/old-workshop-name/"] },
    files: { "/a/one/index.html": { h: "f".repeat(64), ct: "text/html", s: 1 } },
    // No file anywhere under /toolkit/old-workshop-name/ — it is
    // already gone; nothing this publish does can be the thing that "takes it down".
  };
  assert.deepEqual(removed(deadLive, live("/a/one/")), []);
});

test("a dead prefix and a real removal in the same publish: only the real one is reported", () => {
  const mixedLive = {
    routing: { publicPrefixes: ["/a/one/", "/a/two/", "/dead/orphan/"] },
    files: {
      "/a/one/index.html": { h: "f".repeat(64), ct: "text/html", s: 1 },
      "/a/two/index.html": { h: "f".repeat(64), ct: "text/html", s: 1 },
    },
  };
  assert.deepEqual(removed(mixedLive, live("/a/one/")), ["/a/two/"],
    "the orphan never had to be re-declared to avoid being 'removed'; the real page did");
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
  // Both declared prefixes are genuinely backed by a file — required so the
  // "real removal still blocks" tests below actually exercise a real removal
  // under the dead-prefix-aware guard (see unpublish-guard-dead-prefix.test.mjs
  // for the orphan side of the same story).
  files: {
    "/toolkit/widgets/index.html": { h: "a".repeat(64), ct: "text/html", s: 10 },
    "/toolkit/map/index.html": { h: "b".repeat(64), ct: "text/html", s: 10 },
  },
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

// ---- Dead/orphaned prefixes at the endpoint ----------------------------------
// Same landmine as the predicate tests above, exercised through the actual commit
// door: a live manifest carrying a publicPrefixes entry with no backing file must
// never require --allow-unpublish to drop, and — the other half of "make it right
// forever" — the manifest a commit persists must never carry that dead entry
// forward, or it just traps whoever publishes next instead.
const LIVE_WITH_ORPHAN = {
  id: "alpha", version: 4, format: 1,
  space: { id: "alpha", default: true },
  files: { "/toolkit/widgets/index.html": { h: "a".repeat(64), ct: "text/html", s: 10 } },
  // The renamed-away URL: declared live, nothing backs it — the exact shape a
  // renamed prototype's dead old URL is live in.
  routing: { publicPrefixes: ["/toolkit/widgets/", "/toolkit/old-workshop-name/"], versionMap: {} },
};
const envWithOrphan = () => ({
  BUNDLES: memR2({ "spaces/alpha/manifest.json": JSON.stringify(LIVE_WITH_ORPHAN) }),
  PUBLISH_BOOTSTRAP_TOKEN: "tok",
});
const noOrphan = {
  id: "alpha", format: 1, files: LIVE_WITH_ORPHAN.files,
  space: { id: "alpha", default: true },
  routing: { publicPrefixes: ["/toolkit/widgets/"], versionMap: {} },
};

test("a publish that only drops a dead/orphaned prefix needs no flag and is not refused", async () => {
  const env = envWithOrphan();
  const res = await commit(env, noOrphan);
  assert.equal(res.status, 200, "a dead prefix's disappearance is not an unpublish");
  const after = JSON.parse(env.BUNDLES.store.get("spaces/alpha/manifest.json"));
  assert.equal(after.version, 5);
});

test("once gone, the orphan does not come back — the persisted manifest never carries it forward", async () => {
  const env = envWithOrphan();
  await commit(env, noOrphan);
  const after = JSON.parse(env.BUNDLES.store.get("spaces/alpha/manifest.json"));
  assert.deepEqual(after.routing.publicPrefixes, ["/toolkit/widgets/"],
    "no dead entry left to trap the NEXT publisher");
});

test("a manifest that DECLARES a live prefix without shipping its files has it pruned, not trusted", async () => {
  // The mirror-image hole: a client claims to "keep" a real live prefix (so the
  // guard sees no removal) but never actually ships a file under it. Auto-pruning
  // at commit strips the empty claim — so it cannot silently plant a FRESH orphan
  // — and the guard still catches the resulting real removal, because "declared"
  // stopped being enough to count as "keeping" it.
  const env = envWithLive(); // LIVE: /toolkit/widgets/ and /toolkit/map/, both backed
  const res = await commit(env, {
    id: "alpha", format: 1,
    files: { "/toolkit/widgets/index.html": LIVE.files["/toolkit/widgets/index.html"] },
    space: { id: "alpha", default: true },
    routing: { publicPrefixes: ["/toolkit/widgets/", "/toolkit/map/"], versionMap: {} },
  });
  assert.equal(res.status, 422, "claiming to keep it is not the same as actually shipping it");
  const body = await res.json();
  assert.deepEqual(body.removed, ["/toolkit/map/"]);
});

test("/check's advisory livePrefixes excludes dead/orphaned entries too, matching what commit enforces", async () => {
  const env = envWithOrphan();
  const res = await W.publishApi(
    new Request("https://x.test/__publish/alpha/check", {
      method: "POST",
      headers: { Authorization: "Bearer tok", "content-type": "application/json" },
      body: JSON.stringify({ files: {} }),
    }),
    new URL("https://x.test/__publish/alpha/check"),
    env);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).livePrefixes, ["/toolkit/widgets/"]);
});
