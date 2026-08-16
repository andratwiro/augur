// Prototypes and the design system are the content worth protecting — everything else
// the instance holds (comments, canvases, rosters, statuses) is a recoverable
// convenience. So the failure this guards is the one that was invisible: a space's
// stylesheets silently not shipping.
//
// It is invisible because nothing downstream notices. The build succeeds, the publish
// succeeds, `augur export` faithfully copies what was published, the health canary sees
// matching shas — and every prototype renders unstyled. Nobody finds out until they
// open a page.
//
// Realistically it happens through the skill inventory: skills/<x>-ui/skill.json names
// the assets to ship, so a renamed file, a typo, or a moved directory drops the CSS
// while leaving the space otherwise intact.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// A minimal space: one prototype, one UI skill. `<prefix>-ui/` containing
// `<prefix>-ui.css` is what detectUiSkill looks for.
function makeSpace({ assets }) {
  const dir = mkdtempSync(path.join(tmpdir(), "ds-ships-"));
  const skill = path.join(dir, "skills", "acme-ui");
  mkdirSync(skill, { recursive: true });
  writeFileSync(path.join(skill, "acme-ui.css"), ":root{--acme:1}\n");
  writeFileSync(path.join(skill, "acme-tokens.css"), ":root{--acme-token:1}\n");
  writeFileSync(path.join(skill, "skill.json"), JSON.stringify({ assets, cssPrefixes: ["acme"] }, null, 2));
  const proto = path.join(dir, "demo", "prototypes", "hello");
  mkdirSync(proto, { recursive: true });
  writeFileSync(path.join(proto, "index.html"), "<!doctype html><title>Hello</title><p>hi</p>\n");
  // A space with a UI skill must carry the overlay catalog — loadCatalog treats it as
  // required and has no fallback, so an empty one is the minimum valid fixture.
  writeFileSync(path.join(dir, "registry.json"), JSON.stringify({
    items: [{ name: "stat", type: "primitive", classes: ["acme-stat"], label: "Stat", description: "A number." }],
  }));
  writeFileSync(path.join(dir, "space.json"), JSON.stringify({ id: "acme", name: "Acme", default: true }));
  return dir;
}

function build(spacesRoot) {
  try {
    execFileSync(process.execPath, ["build.js"], {
      cwd: ROOT,
      env: { ...process.env, GV_SPACES_ROOT: spacesRoot },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, out: "" };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ""}${e.stderr || ""}` };
  }
}

test("a space whose skill inventory is intact builds", () => {
  const dir = makeSpace({ assets: ["acme-ui.css", "acme-tokens.css"] });
  try {
    assert.equal(build(dir).ok, true, "a healthy design system must not trip the guard");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a space whose inventory names a file that does not exist FAILS the build", () => {
  // The realistic break: someone renames the stylesheet and not the manifest entry.
  const dir = makeSpace({ assets: ["acme-ui-RENAMED.css"] });
  try {
    const r = build(dir);
    assert.equal(r.ok, false, "shipping no stylesheet must fail the build, not warn");
    assert.match(r.out, /NO stylesheet/);
    assert.match(r.out, /skills\/acme-ui/);
    // The message has to say what the consequence is — "missing asset" reads as
    // cosmetic, and this is every page in the space rendering unstyled.
    assert.match(r.out, /unstyled/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an empty inventory FAILS too — the guard is about the CSS, not the manifest", () => {
  const dir = makeSpace({ assets: [] });
  try {
    assert.equal(build(dir).ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a space with NO design system at all still builds", () => {
  // Plain self-contained HTML is a legitimate space. The guard applies only where
  // there is a design system to lose.
  const dir = mkdtempSync(path.join(tmpdir(), "ds-none-"));
  try {
    const proto = path.join(dir, "demo", "prototypes", "hello");
    mkdirSync(proto, { recursive: true });
    writeFileSync(path.join(proto, "index.html"), "<!doctype html><title>Hello</title><p>hi</p>\n");
    writeFileSync(path.join(dir, "space.json"), JSON.stringify({ id: "bare", name: "Bare", default: true }));
    assert.equal(build(dir).ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
