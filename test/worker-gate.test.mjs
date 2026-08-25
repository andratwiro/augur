// The gate: which paths bypass the password (isPublicPath), which need an admin
// (isRestrictedPath, isTrackPath), and which live-reload token a page gets
// (versionFor). All four used to read module-scope routing globals; three of them now
// take the tenant context as their first argument instead, so every assertion below
// names the config it is asking about.
//
// These tests are therefore a BASELINE, written before that refactor and describing
// what the gate does TODAY — warts included, and noted where they are warts. Their job
// is to fail loudly if threading the config through changes an answer. Nothing here
// should be "corrected" while the refactor is in flight: a behaviour change and a
// mechanical refactor must never ride in the same commit, or neither is reviewable.
//
// Routing is seeded through applyDerivedRouting(), the same function bundle mode uses
// to derive routing from live manifests — so the fixtures are the real input shape. It
// hands back the CONTEXT it derived, which is what the threaded predicates take.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

// One space's slice of routing, in the shape applyDerivedRouting consumes.
function space(id, routing, opts = {}) {
  return {
    space: { id, default: !!opts.default, adminOnly: !!opts.adminOnly },
    version: 1,
    routing,
  };
}

// The instance the whole file is described against: a default space with two public
// prototypes and a UI skill, plus a sealed second space.
function seedRouting() {
  return W.applyDerivedRouting({
    _engine: { routing: { canvasLoaderExtras: "" } },
    delta: space("delta", {
      publicPrefixes: ["/prototypes/garden/", "/prototypes/gate/"],
      publicSkillPrefixes: ["/skills/delta-ui/"],
      versionMap: { "/prototypes/garden/": "v-garden", "/prototypes/garden/deep/": "v-deep" },
      shellSig: "sig-delta",
    }, { default: true }),
    sealed: space("sealed", {
      publicPrefixes: [],
      versionMap: {},
      shellSig: "sig-sealed",
    }, { adminOnly: true }),
  });
}

// ---- isPublicPath: the fixed doors -----------------------------------------

test("the fixed public doors are public", () => {
  const ctx = seedRouting();
  for (const p of [
    "/_build.json",
    "/__review/comments.js",
    "/__review/cat.png",
    "/__review/comment-cursor.svg",
    "/__review/graph.js",
    "/space-icon.png",
    "/piti.js",
    "/fonts/anything.woff2",
  ]) assert.equal(W.isPublicPath(ctx, p), true, `${p} must be public`);
});

test("/__invite is NOT listed as public — its route intercepts first", () => {
  const ctx = seedRouting();
  // Deliberate: an entry here would be unreachable code reading as a safety net.
  // Pinned so nobody "fixes" the omission and creates a real second door.
  assert.equal(W.isPublicPath(ctx, "/__invite"), false);
});

// ---- isPublicPath: the extension-scoped doors ------------------------------

test("/__canvas/ is public for rendered assets only, never as a blanket prefix", () => {
  const ctx = seedRouting();
  for (const ok of ["/__canvas/canvas.js", "/__canvas/canvas.css", "/__canvas/a.mjs",
    "/__canvas/catalog.json", "/__canvas/x.map", "/__canvas/i.svg", "/__canvas/i.png",
    "/__canvas/i.webp", "/__canvas/f.woff", "/__canvas/f.woff2"])
    assert.equal(W.isPublicPath(ctx, ok), true, `${ok} must be public`);
  for (const no of ["/__canvas/README.md", "/__canvas/notes.txt", "/__canvas/",
    "/__canvas/secret.html"])
    assert.equal(W.isPublicPath(ctx, no), false, `${no} must stay gated`);
});

test("the extension guard is case-insensitive", () => {
  const ctx = seedRouting();
  assert.equal(W.isPublicPath(ctx, "/__canvas/CANVAS.JS"), true);
  assert.equal(W.isPublicPath(ctx, "/skills/delta-ui/MAIN.CSS"), true);
});

test("the public skill dir opens rendered assets and keeps its docs gated", () => {
  const ctx = seedRouting();
  for (const ok of ["/skills/delta-ui/delta-ui.css", "/skills/delta-ui/img/logo.svg",
    "/skills/delta-ui/f.woff2", "/skills/delta-ui/f.ttf", "/skills/delta-ui/f.otf",
    "/skills/delta-ui/a.jpg", "/skills/delta-ui/a.jpeg", "/skills/delta-ui/a.gif",
    "/skills/delta-ui/a.ico", "/skills/delta-ui/skill.json"])
    assert.equal(W.isPublicPath(ctx, ok), true, `${ok} must be public`);
  // The whole reason the guard is extension-scoped rather than a prefix: docs and
  // galleries ship into this same dir and must stay behind the password.
  for (const no of ["/skills/delta-ui/img/MANIFEST.md", "/skills/delta-ui/gallery.html",
    "/skills/delta-ui/notes.txt", "/skills/delta-ui/"])
    assert.equal(W.isPublicPath(ctx, no), false, `${no} must stay gated`);
});

test("a skill dir that is not in publicSkillPrefixes opens nothing", () => {
  const ctx = seedRouting();
  assert.equal(W.isPublicPath(ctx, "/skills/other-ui/other.css"), false);
});

test("any /og.jpg is public so unfurl bots can load it from a gated folder", () => {
  const ctx = seedRouting();
  assert.equal(W.isPublicPath(ctx, "/prototypes/private-thing/og.jpg"), true);
  assert.equal(W.isPublicPath(ctx, "/og.jpg"), true);
  assert.equal(W.isPublicPath(ctx, "/prototypes/private-thing/og.png"), false);
});

test("the whole /pages subtree is public, and only as a folder", () => {
  const ctx = seedRouting();
  assert.equal(W.isPublicPath(ctx, "/pages"), true);
  assert.equal(W.isPublicPath(ctx, "/pages/"), true);
  assert.equal(W.isPublicPath(ctx, "/pages/buttons/"), true);
  assert.equal(W.isPublicPath(ctx, "/pages/buttons/local.css"), true);
  // A sibling that merely starts with the same letters is a different path.
  assert.equal(W.isPublicPath(ctx, "/pages-internal/x"), false);
});

// ---- isPublicPath: the published-prototype prefixes ------------------------

test("a public prototype prefix covers the folder, its bare form and everything under it", () => {
  const ctx = seedRouting();
  assert.equal(W.isPublicPath(ctx, "/prototypes/garden/"), true, "the folder");
  assert.equal(W.isPublicPath(ctx, "/prototypes/garden"), true, "the bare form (no trailing slash)");
  assert.equal(W.isPublicPath(ctx, "/prototypes/garden/index.html"), true);
  assert.equal(W.isPublicPath(ctx, "/prototypes/garden/deep/asset.png"), true, "any depth");
});

test("an unpublished sibling stays gated", () => {
  const ctx = seedRouting();
  assert.equal(W.isPublicPath(ctx, "/prototypes/secret/"), false);
  assert.equal(W.isPublicPath(ctx, "/prototypes/"), false);
  assert.equal(W.isPublicPath(ctx, "/"), false);
});

test("with no routing at all nothing prototype-shaped is public", () => {
  const ctx = W.applyDerivedRouting({});
  assert.equal(W.isPublicPath(ctx, "/prototypes/garden/"), false);
  assert.equal(W.isPublicPath(ctx, "/_build.json"), true, "the fixed doors do not depend on routing");
});

// ---- isRestrictedPath ------------------------------------------------------

// D4 RETIRED with the path-mount tier + Q1 (Phase A, S4): an adminOnly space only ever
// sealed a NON-DEFAULT "/<id>/" mount, and no such mount exists any more, so the bundle
// derivation seals nothing — RESTRICTED_BASES is permanently empty and isRestrictedPath
// answers false for every path. This inverts the S1 baseline (a sealed "/sealed" used to
// be restricted); the flip is the deliberate diff a reviewer should see land with D4.
test("an admin-only space no longer seals anything (tier + adminOnly retired)", () => {
  const ctx = seedRouting();
  assert.equal(W.isRestrictedPath(ctx, "/sealed"), false, "the bare base is not sealed");
  assert.equal(W.isRestrictedPath(ctx, "/sealed/"), false, "nor its root");
  assert.equal(W.isRestrictedPath(ctx, "/sealed/prototypes/x/"), false, "nor anything beneath");
});

test("with the tier retired, no path is restricted at all", () => {
  const ctx = seedRouting();
  assert.equal(W.isRestrictedPath(ctx, "/sealed-public/"), false);
  assert.equal(W.isRestrictedPath(ctx, "/sealedx"), false);
  const onlyCtx = W.applyDerivedRouting({
    only: space("only", { publicPrefixes: [], versionMap: {} }, { default: true, adminOnly: true }),
  });
  assert.equal(W.isRestrictedPath(onlyCtx, "/only"), false, "an adminOnly default space is not restricted either");
  assert.equal(W.isRestrictedPath(onlyCtx, "/"), false);
  const plainCtx = W.applyDerivedRouting({ delta: space("delta", { publicPrefixes: [], versionMap: {} }, { default: true }) });
  assert.equal(W.isRestrictedPath(plainCtx, "/anything"), false);
});

// ---- isTrackPath -----------------------------------------------------------

// D5 RETIRED (Phase A, S4): the leading optional "/<space>/" mount group is gone, so
// session music resolves ONLY at the root now — no space mounts under "/<id>/". A
// "/sealed/tracks/*.mp3" is no longer a track (it inverts the S1 baseline deliberately).
test("session music is admin-only for audio extensions, at the root only", () => {
  for (const ext of ["mp3", "m4a", "aac", "ogg", "opus", "wav", "flac", "webm"]) {
    assert.equal(W.isTrackPath(`/tracks/song.${ext}`), true, `root /tracks/*.${ext}`);
    assert.equal(W.isTrackPath(`/sealed/tracks/song.${ext}`), false, `no /<space>/ mount any more`);
  }
});

test("a non-audio file in tracks/ is governed by the ordinary rules, not this one", () => {
  assert.equal(W.isTrackPath("/tracks/README.md"), false);
  assert.equal(W.isTrackPath("/tracks/cover.png"), false);
  assert.equal(W.isTrackPath("/tracks/"), false);
});

test("isTrackPath matches only the root tracks/ folder, at any depth below it", () => {
  assert.equal(W.isTrackPath("/a/b/tracks/song.mp3"), false, "not under any prefix");
  assert.equal(W.isTrackPath("/sealed/tracks/song.mp3"), false, "not even one segment deep now");
  assert.equal(W.isTrackPath("/tracks/nested/song.mp3"), true, "but the file may nest below tracks/");
});

// ---- versionFor ------------------------------------------------------------

test("versionFor takes the LONGEST matching prefix, not the first", () => {
  const ctx = seedRouting();
  assert.equal(W.versionFor(ctx, "/prototypes/garden/deep/x.png"), "v-deep",
    "the deeper entry wins over its parent");
  assert.equal(W.versionFor(ctx, "/prototypes/garden/x.png"), "v-garden");
});

test("versionFor matches the folder and its bare form", () => {
  const ctx = seedRouting();
  assert.equal(W.versionFor(ctx, "/prototypes/garden/"), "v-garden");
  assert.equal(W.versionFor(ctx, "/prototypes/garden"), "v-garden");
});

test("an unmapped path falls back to the build id, and the build id is derived", () => {
  const ctx = seedRouting();
  const fallback = W.versionFor(ctx, "/");
  assert.equal(typeof fallback, "string");
  assert.ok(fallback.length, "there is always a fallback token");
  assert.equal(W.versionFor(ctx, "/prototypes/gate/index.html"), fallback,
    "a public prototype with no versionMap entry still gets the fallback");
});

test("the build id is stable for the same manifests and moves when a slice does", () => {
  const ctx = seedRouting();
  const a = W.versionFor(ctx, "/");
  const again = seedRouting();
  assert.equal(W.versionFor(again, "/"), a, "same input, same id");
  const moved = W.applyDerivedRouting({
    _engine: { routing: { canvasLoaderExtras: "" } },
    delta: space("delta", { publicPrefixes: [], versionMap: {}, shellSig: "sig-MOVED" }, { default: true }),
    sealed: space("sealed", { publicPrefixes: [], versionMap: {}, shellSig: "sig-sealed" }, { adminOnly: true }),
  });
  assert.notEqual(W.versionFor(moved, "/"), a, "a changed slice changes the id");
});

// ---- the public canvas catalog, with the admin-only exclusion retired -------

test("with adminOnly retired, every space contributes to the public canvas catalog", async () => {
  // The admin-only catalog exclusion was the multi-space tier: a NON-DEFAULT sealed space
  // was kept out of /__canvas/catalog.json (served before the gate) so its inventory did
  // not leak. Q1 retires adminOnly with the tier, so nothing is excluded now — exactly as
  // the DEFAULT space's catalog was always merged. This inverts the S1 baseline.
  const ctx = W.applyDerivedRouting({
    _engine: { routing: { canvasLoaderExtras: "" } },
    delta: space("delta", {
      publicPrefixes: [], versionMap: {},
      canvasCatalog: [{ path: "/open/", title: "Open" }],
      canvasTracks: [{ path: "/tracks/a.mp3" }],
    }, { default: true }),
    sealed: space("sealed", {
      publicPrefixes: [], versionMap: {},
      canvasCatalog: [{ path: "/sealed/x/", title: "Secret" }],
      canvasTracks: [{ path: "/sealed/tracks/b.mp3" }],
    }, { adminOnly: true }),
  });
  const catalog = await W.canvasAggregate(ctx, "catalog").text();
  assert.match(catalog, /Secret/, "the formerly-sealed space now contributes too");
  assert.match(catalog, /Open/, "the open space still does");

  // Music is unchanged: the track LIST answers admins only, and the audio itself is
  // admin-only (isTrackPath), so every space's tracks merge for an admin to see.
  const tracksAdmin = await W.canvasAggregate(ctx, "tracks", true).text();
  assert.match(tracksAdmin, /\/sealed\/tracks\/b\.mp3/, "an admin sees every space's music");
  const tracksAnon = await W.canvasAggregate(ctx, "tracks", false).text();
  assert.equal(tracksAnon, "[]", "a non-admin is told the instance has no music at all");
});

// ---- S1: the space-tier baseline (pins TODAY's multi-space answers) ---------
//
// Phase A retires the "several spaces path-mounted in one instance" tier (plan
// §1b, D1–D9): the default space at "/", every other under "/<id>/", a path
// resolved to one of several spaces. Nothing live uses the plural, so it goes
// first — but before the deletion these assertions LOCK the current answers, so
// when S2/S4 collapse the tier the flip is a visible, reviewed diff and not a
// silent behaviour change. Every assertion below passes against the UNMODIFIED
// worker; each is expected to INVERT in the commit that deletes its D-item.
//
// The fixture the whole section is described against: a DEFAULT space "alpha" at
// the root, plus a NON-DEFAULT admin-only space "beta" mounted under "/beta/".
function seedTier() {
  return W.applyDerivedRouting({
    _engine: { routing: { canvasLoaderExtras: "" } },
    alpha: space("alpha", {
      publicPrefixes: ["/prototypes/home/"],
      versionMap: {},
      shellSig: "sig-alpha",
    }, { default: true }),
    beta: space("beta", {
      publicPrefixes: ["/beta/prototypes/panel/"],
      versionMap: {},
      shellSig: "sig-beta",
    }, { adminOnly: true }),
  });
}

// The module-scope SPACES list applyDerivedRouting builds is exactly the array
// of each fixture's `.space` object ({id, default, adminOnly}); spaceIdForPath
// and pathOwnedBySpace take that list as an explicit argument (they do not read
// the global), so the tests reconstruct it in the same shape.
function tierSpaces() {
  return [
    { id: "alpha", default: true, adminOnly: false },
    { id: "beta", default: false, adminOnly: true },
  ];
}

// D1 — spaceIdForPath RETIRED (S2): the path-mount tier is gone, so there is exactly one
// workspace (the default). The resolver ignores the path and every owned path maps to
// that one space; the "/<id>/" mount that used to pick a non-default space no longer
// exists, so a "/beta/..." path is the single workspace's, not "beta"'s. This inverts the
// S1 baseline deliberately — the flip a reviewer should see land with the D1 deletion.
test("[tier] spaceIdForPath maps every path to the single default workspace", () => {
  const spaces = tierSpaces();
  assert.equal(W.spaceIdForPath("/beta/x", spaces), "alpha", "no /<id>/ mount survives");
  assert.equal(W.spaceIdForPath("/beta", spaces), "alpha");
  assert.equal(W.spaceIdForPath("/beta/", spaces), "alpha");
  assert.equal(W.spaceIdForPath("/", spaces), "alpha", "the root is the one workspace's too");
});

test("[tier] spaceIdForPath sends a root path to the default space", () => {
  const spaces = tierSpaces();
  assert.equal(W.spaceIdForPath("/", spaces), "alpha", "the root is the default's");
  assert.equal(W.spaceIdForPath("/prototypes/home/", spaces), "alpha", "any unowned path too");
  // "/betamax" is NOT the "beta" space — the "/<id>/" boundary is load-bearing.
  assert.equal(W.spaceIdForPath("/betamax", spaces), "alpha");
});

// D2 / D3 — pathOwnedBySpace / isPublishablePublicPrefix RETIRED the /<id>/ ownership
// (S3): with one workspace, ownership no longer discriminates by space — every path that
// is not engine chrome and not reserved /__ (bar /__search.json) belongs to the one
// workspace, whichever spaceId is asked. The chrome and /__ exclusions are KEPT — they
// are what keeps a publish token off shared engine assets, single-workspace or not.
test("[tier] pathOwnedBySpace owns every non-chrome path for the one workspace", () => {
  const spaces = tierSpaces();
  // Formerly-second-space paths are the one workspace's now, whichever id is asked.
  assert.equal(W.pathOwnedBySpace("/beta/prototypes/panel/", "beta", spaces), true);
  assert.equal(W.pathOwnedBySpace("/beta/prototypes/panel/", "alpha", spaces), true,
    "no /<id>/ boundary: the space id no longer restricts ownership");
  assert.equal(W.pathOwnedBySpace("/beta", "beta", spaces), true, "the bare base too");
  assert.equal(W.pathOwnedBySpace("/prototypes/home/", "alpha", spaces), true);
  assert.equal(W.pathOwnedBySpace("/prototypes/home/", "beta", spaces), true);
  // KEEP: engine chrome and reserved /__ belong to NO space, the one workspace included.
  assert.equal(W.pathOwnedBySpace("/admin", "alpha", spaces), false, "engine chrome");
  assert.equal(W.pathOwnedBySpace("/__canvas/canvas.js", "alpha", spaces), false, "engine chrome");
  assert.equal(W.pathOwnedBySpace("/__whatever", "alpha", spaces), false, "reserved /__");
  assert.equal(W.pathOwnedBySpace("/__search.json", "alpha", spaces), true, "the one /__ exception");
});

test("[tier] isPublishablePublicPrefix owns any non-root subtree for the one workspace", () => {
  const spaces = tierSpaces();
  assert.equal(W.isPublishablePublicPrefix("/beta/prototypes/panel/", "beta", spaces), true);
  assert.equal(W.isPublishablePublicPrefix("/beta/prototypes/panel/", "alpha", spaces), true,
    "no /<id>/ boundary any more");
  assert.equal(W.isPublishablePublicPrefix("/", "alpha", spaces), false, "but never the bare root");
});

// D4 RETIRED (S4) + Q1: adminOnly no longer seals anything, so an adminOnly non-default
// space contributes NOTHING to RESTRICTED_BASES — it is permanently empty. This inverts
// the S1 baseline (the "/beta" base used to be sealed).
test("[tier] an adminOnly non-default space no longer seals its base", () => {
  const ctx = seedTier();
  assert.equal(W.isRestrictedPath(ctx, "/beta"), false, "the base is not sealed any more");
  assert.equal(W.isRestrictedPath(ctx, "/beta/secret"), false, "nor anything beneath it");
  assert.equal(W.isRestrictedPath(ctx, "/prototypes/home/"), false, "and the default's paths never were");
});

// D5 RETIRED (S4): the leading optional "(\/<space>)" mount group is gone, so a
// "/<id>/tracks/*.mp3" is no longer a track — session music lives only at the root.
test("[tier] TRACK_PATH no longer matches a /<id>/tracks/*.mp3 (root only now)", () => {
  assert.equal(W.isTrackPath("/beta/tracks/x.mp3"), false, "no /<space>/ mount survives");
  assert.equal(W.isTrackPath("/tracks/x.mp3"), true, "the root form still matches");
});
