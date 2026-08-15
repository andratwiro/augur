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
