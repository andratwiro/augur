// Turning a live URL back into a source path.
//
// `C-clone-pull-materializer`. build.js maps a source tree to URLs; a clone has to undo it.
// The mapping is LOSSY in one place: `/<folder>/<name>/` is a prototype whose source lives
// at `<folder>/prototypes/<name>/`, while `/base/<name>/` is a gallery tier whose source is
// the URL verbatim. Nothing in the path distinguishes them.
//
// So the classifier reads `routing.publicPrefixes` out of the manifest instead of guessing.
// The decisive test is the ROUND TRIP at the bottom: build a real space, take the manifest
// build.js produced, and check every reconstructed path exists in the tree it was built
// from. A rule that merely looks right passes the unit cases and fails that one.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { classify, materializePlan, synthesizeSpaceJson, TIERS } from "../scripts/lib/materialize.mjs";

const ENGINE = fileURLToPath(new URL("..", import.meta.url));
const PREFIXES = ["/garden/seed-swap/", "/playground/scratch/"];

const src = (url, prefixes = PREFIXES) => {
  const c = classify(url, prefixes);
  return c.kind === "source" ? c.path : null;
};

test("a published prototype maps back under its project's prototypes/ folder", () => {
  assert.equal(src("/garden/seed-swap/index.html"), "garden/prototypes/seed-swap/index.html");
  assert.equal(src("/garden/seed-swap/img/a.png"), "garden/prototypes/seed-swap/img/a.png");
});

test("A GALLERY TIER IS NOT A PROJECT, which is the whole ambiguity", () => {
  // Same shape as a prototype URL, opposite answer. Getting this wrong writes every base
  // demo into base/prototypes/, which rebuilds into a different site.
  for (const tier of TIERS) {
    assert.equal(src(`/${tier}/buttons/index.html`), `${tier}/buttons/index.html`);
  }
  assert.equal(src("/playground/scratch/index.html"), "playground/scratch/index.html");
});

test("a folder that LOOKS like a prototype but is not in publicPrefixes is not one", () => {
  // The reason the classifier reads the manifest rather than pattern-matching. An
  // unpublished folder's index could otherwise be written as somebody's source.
  assert.equal(src("/garden/not-published/index.html"), null);
  assert.equal(classify("/garden/not-published/index.html", PREFIXES).why, "not a published prototype (/garden/not-published/ is not in publicPrefixes)");
});

test("a project named after a tier still resolves correctly", () => {
  // Somebody will name a project "pages". With prefixes consulted, both answers stay right.
  assert.equal(src("/pages/overview/index.html", ["/pages/overview/"]), "pages/overview/index.html",
    "a tier must stay a tier even when a prefix would also match");
});

test("build OUTPUT is never written into a source tree", () => {
  // A clone that wrote these back produces a tree that rebuilds into something else — a
  // clone that cannot be published again, which is the one thing it must be able to do.
  for (const url of [
    "/index.html", "/__search.json", "/garden/index.html", "/base/index.html",
    "/components/index.html", "/pages/index.html", "/patterns/index.html",
    "/playground/index.html", "/tokens/index.html", "/skills/acme-ui/graph.js",
  ]) {
    assert.equal(src(url), null, `${url} would have been written into the source tree`);
  }
});

test("the skill's own assets ARE source, except the graph it derives", () => {
  assert.equal(src("/skills/acme-ui/acme-ui.css"), "skills/acme-ui/acme-ui.css");
  assert.equal(src("/skills/acme-ui/acme-tokens.css"), "skills/acme-ui/acme-tokens.css");
  assert.equal(src("/skills/acme-ui/vendor/x.js"), "skills/acme-ui/vendor/x.js");
  assert.equal(src("/skills/acme-ui/graph.js"), null, "the composition graph is derived from the stylesheets beside it");
});

test("the workspace icon is source; other root files are not", () => {
  assert.equal(src("/space-icon.png"), "space-icon.png");
  assert.equal(src("/manifest.webmanifest"), null);
});

test("every skip carries a reason", () => {
  // A tool whose promise is "leaving is free" must not omit anything silently.
  const { skipped } = materializePlan({
    routing: { publicPrefixes: PREFIXES },
    files: { "/index.html": { h: "a" }, "/base/index.html": { h: "b" }, "/tokens/index.html": { h: "c" } },
  });
  assert.equal(skipped.length, 3);
  for (const s of skipped) assert.ok(s.why && s.why.length > 5, `${s.url} was skipped with no reason`);
});

test("the plan is deterministic, so two runs diff cleanly", () => {
  const m = { routing: { publicPrefixes: PREFIXES }, files: { "/garden/seed-swap/b.html": { h: "2" }, "/garden/seed-swap/a.html": { h: "1" } } };
  assert.deepEqual(materializePlan(m).files.map((f) => f.url), ["/garden/seed-swap/a.html", "/garden/seed-swap/b.html"]);
});

test("the synthesized space.json claims only what is knowable", () => {
  // Anything inferred — a display name, a projects label — would be a guess written into
  // the file that decides how the space builds.
  const s = synthesizeSpaceJson("acme", "https://acme.example");
  assert.deepEqual(Object.keys(s).sort(), ["default", "id", "siteOrigin"]);
  assert.equal(s.id, "acme");
});

// ── the round trip, against a real space ─────────────────────────────────────

test("EVERY reconstructed path exists in the tree the manifest was built from", () => {
  // The decisive one. Build a real space, take the manifest build.js produced, reverse it,
  // and require every source path to be a file that actually exists in the tree it came
  // from. A rule that merely looks right passes every case above and fails this.
  const space = path.join(ENGINE, "..", "augur-space-fulla");
  if (!fs.existsSync(path.join(space, "space.json"))) return; // not in a full workspace

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "materialize-root-"));
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "materialize-dist-"));
  try {
    // Its own root, so it builds as the DEFAULT space and its URLs carry no /<id>/ prefix.
    fs.cpSync(space, path.join(root, "fulla"), { recursive: true, filter: (p) => !p.includes(`${path.sep}.git`) });
    execFileSync(process.execPath, [path.join(ENGINE, "build.js")], {
      cwd: ENGINE, env: { ...process.env, GV_SPACES_ROOT: root, GV_DIST: dist }, stdio: ["ignore", "pipe", "pipe"],
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(dist, "__manifests", "fulla.json"), "utf8"));
    const { files, skipped } = materializePlan(manifest);

    assert.ok(files.length > 20, `only ${files.length} source files planned — did the build produce a manifest?`);
    const missing = files.filter((f) => !fs.existsSync(path.join(space, f.path)));
    assert.deepEqual(missing.map((f) => `${f.url} → ${f.path}`), [],
      "these reconstructed paths do not exist in the source tree the manifest was built from");
    assert.ok(skipped.length > 0, "nothing was classified as generated, which cannot be right for a real build");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dist, { recursive: true, force: true });
  }
});
