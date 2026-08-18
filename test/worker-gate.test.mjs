// The gate: which paths bypass the password (isPublicPath), which need an admin
// (isRestrictedPath, isTrackPath), and which live-reload token a page gets
// (versionFor). All four read module-scope routing globals that the tenant-context
// refactor is about to replace with a passed-in value.
//
// These tests are therefore a BASELINE, written before that refactor and describing
// what the gate does TODAY — warts included, and noted where they are warts. Their job
// is to fail loudly if threading the config through changes an answer. Nothing here
// should be "corrected" while the refactor is in flight: a behaviour change and a
// mechanical refactor must never ride in the same commit, or neither is reviewable.
//
// Routing is seeded through applyDerivedRouting(), the same function bundle mode uses
// to derive routing from live manifests — so the fixtures are the real input shape.
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
  W.applyDerivedRouting({
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
  seedRouting();
  for (const p of [
    "/_build.json",
    "/__review/comments.js",
    "/__review/cat.png",
    "/__review/comment-cursor.svg",
    "/__review/graph.js",
    "/space-icon.png",
    "/piti.js",
    "/fonts/anything.woff2",
  ]) assert.equal(W.isPublicPath(p), true, `${p} must be public`);
});

test("/__invite is NOT listed as public — its route intercepts first", () => {
  seedRouting();
  // Deliberate: an entry here would be unreachable code reading as a safety net.
  // Pinned so nobody "fixes" the omission and creates a real second door.
  assert.equal(W.isPublicPath("/__invite"), false);
});

// ---- isPublicPath: the extension-scoped doors ------------------------------

test("/__canvas/ is public for rendered assets only, never as a blanket prefix", () => {
  seedRouting();
  for (const ok of ["/__canvas/canvas.js", "/__canvas/canvas.css", "/__canvas/a.mjs",
    "/__canvas/catalog.json", "/__canvas/x.map", "/__canvas/i.svg", "/__canvas/i.png",
    "/__canvas/i.webp", "/__canvas/f.woff", "/__canvas/f.woff2"])
    assert.equal(W.isPublicPath(ok), true, `${ok} must be public`);
  for (const no of ["/__canvas/README.md", "/__canvas/notes.txt", "/__canvas/",
    "/__canvas/secret.html"])
    assert.equal(W.isPublicPath(no), false, `${no} must stay gated`);
});

test("the extension guard is case-insensitive", () => {
  seedRouting();
  assert.equal(W.isPublicPath("/__canvas/CANVAS.JS"), true);
  assert.equal(W.isPublicPath("/skills/delta-ui/MAIN.CSS"), true);
});

test("the public skill dir opens rendered assets and keeps its docs gated", () => {
  seedRouting();
  for (const ok of ["/skills/delta-ui/delta-ui.css", "/skills/delta-ui/img/logo.svg",
    "/skills/delta-ui/f.woff2", "/skills/delta-ui/f.ttf", "/skills/delta-ui/f.otf",
    "/skills/delta-ui/a.jpg", "/skills/delta-ui/a.jpeg", "/skills/delta-ui/a.gif",
    "/skills/delta-ui/a.ico", "/skills/delta-ui/skill.json"])
    assert.equal(W.isPublicPath(ok), true, `${ok} must be public`);
  // The whole reason the guard is extension-scoped rather than a prefix: docs and
  // galleries ship into this same dir and must stay behind the password.
  for (const no of ["/skills/delta-ui/img/MANIFEST.md", "/skills/delta-ui/gallery.html",
    "/skills/delta-ui/notes.txt", "/skills/delta-ui/"])
    assert.equal(W.isPublicPath(no), false, `${no} must stay gated`);
});

test("a skill dir that is not in publicSkillPrefixes opens nothing", () => {
  seedRouting();
  assert.equal(W.isPublicPath("/skills/other-ui/other.css"), false);
});

test("any /og.jpg is public so unfurl bots can load it from a gated folder", () => {
  seedRouting();
  assert.equal(W.isPublicPath("/prototypes/private-thing/og.jpg"), true);
  assert.equal(W.isPublicPath("/og.jpg"), true);
  assert.equal(W.isPublicPath("/prototypes/private-thing/og.png"), false);
});

test("the whole /pages subtree is public, and only as a folder", () => {
  seedRouting();
  assert.equal(W.isPublicPath("/pages"), true);
  assert.equal(W.isPublicPath("/pages/"), true);
  assert.equal(W.isPublicPath("/pages/buttons/"), true);
  assert.equal(W.isPublicPath("/pages/buttons/local.css"), true);
  // A sibling that merely starts with the same letters is a different path.
  assert.equal(W.isPublicPath("/pages-internal/x"), false);
});

// ---- isPublicPath: the published-prototype prefixes ------------------------

test("a public prototype prefix covers the folder, its bare form and everything under it", () => {
  seedRouting();
  assert.equal(W.isPublicPath("/prototypes/garden/"), true, "the folder");
  assert.equal(W.isPublicPath("/prototypes/garden"), true, "the bare form (no trailing slash)");
  assert.equal(W.isPublicPath("/prototypes/garden/index.html"), true);
  assert.equal(W.isPublicPath("/prototypes/garden/deep/asset.png"), true, "any depth");
});

test("an unpublished sibling stays gated", () => {
  seedRouting();
  assert.equal(W.isPublicPath("/prototypes/secret/"), false);
  assert.equal(W.isPublicPath("/prototypes/"), false);
  assert.equal(W.isPublicPath("/"), false);
});

test("with no routing at all nothing prototype-shaped is public", () => {
  W.applyDerivedRouting({});
  assert.equal(W.isPublicPath("/prototypes/garden/"), false);
  assert.equal(W.isPublicPath("/_build.json"), true, "the fixed doors do not depend on routing");
});

// ---- isRestrictedPath ------------------------------------------------------

test("an admin-only space seals its base, its root and everything beneath", () => {
  seedRouting();
  assert.equal(W.isRestrictedPath("/sealed"), true, "the bare base");
  assert.equal(W.isRestrictedPath("/sealed/"), true, "the root");
  assert.equal(W.isRestrictedPath("/sealed/prototypes/x/"), true, "any depth");
});

test("a sibling space whose name merely EXTENDS a sealed one is not sealed", () => {
  // The trap this matching shape exists to avoid: a bare startsWith("/sealed") would
  // seal "/sealed-public" too, and — worse in the other direction — a base of "/s"
  // would seal every space. The `b + "/"` is load-bearing.
  seedRouting();
  assert.equal(W.isRestrictedPath("/sealed-public/"), false);
  assert.equal(W.isRestrictedPath("/sealedx"), false);
});

test("a space that is adminOnly AND default is not restricted", () => {
  // A sealed default space would put the whole instance root behind an admin check,
  // so applyDerivedRouting excludes it (spRestricted = adminOnly && !default).
  W.applyDerivedRouting({
    only: space("only", { publicPrefixes: [], versionMap: {} }, { default: true, adminOnly: true }),
  });
  assert.equal(W.isRestrictedPath("/only"), false);
  assert.equal(W.isRestrictedPath("/"), false);
});

test("with no admin-only space nothing is restricted", () => {
  W.applyDerivedRouting({ delta: space("delta", { publicPrefixes: [], versionMap: {} }, { default: true }) });
  assert.equal(W.isRestrictedPath("/anything"), false);
});

// ---- isTrackPath -----------------------------------------------------------

test("session music is admin-only for audio extensions, at the root and under a space", () => {
  for (const ext of ["mp3", "m4a", "aac", "ogg", "opus", "wav", "flac", "webm"]) {
    assert.equal(W.isTrackPath(`/tracks/song.${ext}`), true, `root /tracks/*.${ext}`);
    assert.equal(W.isTrackPath(`/sealed/tracks/song.${ext}`), true, `spaced /tracks/*.${ext}`);
  }
});

test("a non-audio file in tracks/ is governed by the ordinary rules, not this one", () => {
  assert.equal(W.isTrackPath("/tracks/README.md"), false);
  assert.equal(W.isTrackPath("/tracks/cover.png"), false);
  assert.equal(W.isTrackPath("/tracks/"), false);
});

test("isTrackPath only matches one space segment deep", () => {
  assert.equal(W.isTrackPath("/a/b/tracks/song.mp3"), false);
  assert.equal(W.isTrackPath("/tracks/nested/song.mp3"), true, "but the file may nest below tracks/");
});

// ---- versionFor ------------------------------------------------------------

test("versionFor takes the LONGEST matching prefix, not the first", () => {
  seedRouting();
  assert.equal(W.versionFor("/prototypes/garden/deep/x.png"), "v-deep",
    "the deeper entry wins over its parent");
  assert.equal(W.versionFor("/prototypes/garden/x.png"), "v-garden");
});

test("versionFor matches the folder and its bare form", () => {
  seedRouting();
  assert.equal(W.versionFor("/prototypes/garden/"), "v-garden");
  assert.equal(W.versionFor("/prototypes/garden"), "v-garden");
});

test("an unmapped path falls back to the build id, and the build id is derived", () => {
  seedRouting();
  const fallback = W.versionFor("/");
  assert.equal(typeof fallback, "string");
  assert.ok(fallback.length, "there is always a fallback token");
  assert.equal(W.versionFor("/prototypes/gate/index.html"), fallback,
    "a public prototype with no versionMap entry still gets the fallback");
});

test("the build id is stable for the same manifests and moves when a slice does", () => {
  seedRouting();
  const a = W.versionFor("/");
  seedRouting();
  assert.equal(W.versionFor("/"), a, "same input, same id");
  W.applyDerivedRouting({
    _engine: { routing: { canvasLoaderExtras: "" } },
    delta: space("delta", { publicPrefixes: [], versionMap: {}, shellSig: "sig-MOVED" }, { default: true }),
    sealed: space("sealed", { publicPrefixes: [], versionMap: {}, shellSig: "sig-sealed" }, { adminOnly: true }),
  });
  assert.notEqual(W.versionFor("/"), a, "a changed slice changes the id");
});

// ---- the aggregate an admin-only space must NOT reach -----------------------

test("an admin-only space contributes nothing to the public canvas catalog", async () => {
  // /__canvas/catalog.json is served BEFORE the gate, so a listed entry would leak a
  // sealed space's whole inventory — titles, descriptions and exact URLs — to anyone.
  W.applyDerivedRouting({
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
  const catalog = await W.canvasAggregate("catalog").text();
  assert.doesNotMatch(catalog, /Secret|\/sealed\//, "a sealed space must not appear in the catalog");
  assert.match(catalog, /Open/, "the open space still does");

  // Music is the opposite case by design: the track LIST answers admins only, and the
  // audio itself is admin-only (isTrackPath), so a sealed space's tracks do merge.
  const tracksAdmin = await W.canvasAggregate("tracks", true).text();
  assert.match(tracksAdmin, /\/sealed\/tracks\/b\.mp3/, "an admin sees the sealed space's music");
  const tracksAnon = await W.canvasAggregate("tracks", false).text();
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
  W.applyDerivedRouting({
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

// D2 / D3 — pathOwnedBySpace / isPublishablePublicPrefix: a "/<id>/" public path
// is owned by that non-default space, and the DEFAULT space does NOT own another
// space's "/<id>/" subtree. This is what keeps a publish token to its own space.
test("[tier] a /<id>/ public path is owned by that non-default space, not the default", () => {
  const spaces = tierSpaces();
  assert.equal(W.pathOwnedBySpace("/beta/prototypes/panel/", "beta", spaces), true,
    "beta owns its own /beta/ subtree");
  assert.equal(W.pathOwnedBySpace("/beta/prototypes/panel/", "alpha", spaces), false,
    "the default space does NOT own another space's /beta/ subtree");
  assert.equal(W.pathOwnedBySpace("/beta", "beta", spaces), true, "the bare base too");
  // And the default still owns whatever is left.
  assert.equal(W.pathOwnedBySpace("/prototypes/home/", "alpha", spaces), true,
    "the default owns the root-mounted subtree");
  assert.equal(W.pathOwnedBySpace("/prototypes/home/", "beta", spaces), false,
    "a non-default space does not own the default's root subtree");
});

test("[tier] isPublishablePublicPrefix follows the same /<id>/ ownership", () => {
  const spaces = tierSpaces();
  assert.equal(W.isPublishablePublicPrefix("/beta/prototypes/panel/", "beta", spaces), true);
  assert.equal(W.isPublishablePublicPrefix("/beta/prototypes/panel/", "alpha", spaces), false,
    "the default space cannot publish into beta's mount");
});

// D4 — RESTRICTED_BASES: a space that is adminOnly AND non-default seals its base.
// RESTRICTED_BASES is not exported, so the seal is pinned through its one observable
// consumer, isRestrictedPath (which reads the global applyDerivedRouting just filled).
test("[tier] an adminOnly non-default space puts its base in RESTRICTED_BASES", () => {
  seedTier();
  assert.equal(W.isRestrictedPath("/beta"), true, "the bare base is sealed");
  assert.equal(W.isRestrictedPath("/beta/secret"), true, "and everything beneath it");
  assert.equal(W.isRestrictedPath("/prototypes/home/"), false, "the default's paths are not sealed");
});

// D5 — TRACK_PATH: the leading optional "(\/<space>)" group is the "/<id>/" mount,
// so session music resolves under a non-default space, not only at the root.
test("[tier] TRACK_PATH matches a /<id>/tracks/*.mp3 under a non-default space", () => {
  assert.equal(W.isTrackPath("/beta/tracks/x.mp3"), true, "the /<space>/ mounted form");
  assert.equal(W.isTrackPath("/tracks/x.mp3"), true, "and the root form still");
});
