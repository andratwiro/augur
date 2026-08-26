// The guard against another company's product name in the shared engine.
//
// Running it over the tree it was written from only proves it recognises the 50 mentions
// that are already gone. What has to hold is that it catches the NEXT one — a tool nobody
// has heard of yet — so the decisive case below invents a product name and asserts the
// SHAPE rule catches it with no list involved.
//
// The negatives matter as much as the positives: this runs in `check`, which gates the
// deploy, so a false positive is an outage of the ability to ship. Every "allowed" case
// here is something the engine legitimately writes today, and each one was a real false
// positive during development.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const SCRIPT = fileURLToPath(new URL("../scripts/no-product-names.mjs", import.meta.url));
const ENGINE = fileURLToPath(new URL("..", import.meta.url));

function scan(relPath, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "no-product-names-"));
  try {
    const file = path.join(root, relPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
    try {
      return { ok: true, out: execFileSync(process.execPath, [SCRIPT, root], { encoding: "utf8" }) };
    } catch (e) {
      return { ok: false, out: (e.stdout || "") + (e.stderr || "") };
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const flags = (rel, src) => { const r = scan(rel, src); assert.equal(r.ok, false, `expected a finding:\n${r.out}`); return r.out; };
const passes = (rel, src) => { const r = scan(rel, src); assert.equal(r.ok, true, `expected NO finding:\n${r.out}`); };

// ── rule 1: the closed list ──────────────────────────────────────────────────

test("a design tool named in shipped UI copy is caught", () => {
  const out = flags("build.js", 'const copy = `the main components of a Figma library, except live`;\n');
  assert.match(out, /product-denylist/);
  assert.match(out, /Figma/);
});

test("a design tool named in a CODE COMMENT is caught too, because comments ship", () => {
  // build.js runs no minifier: src/canvas/canvas.js reaches the browser verbatim at
  // /__canvas/canvas.js, so a comment is as public as a paragraph.
  const out = flags("src/canvas/canvas.js", "// Option-drag duplicates (the FigJam idiom)\n");
  assert.match(out, /product-denylist/);
});

test("the possessive and the hyphenated adjective are both caught", () => {
  assert.match(flags("CANVAS.md", "Proportions are FigJam's, measured off a screenshot.\n"), /figjam/i);
  assert.match(flags("CANVAS.md", "The ending is audible (FigJam-parity): each of the last\n"), /figjam/i);
});

test("markdown, css and yaml are all in scope, not just javascript", () => {
  flags("docs/thing.md", "**Reference:** Figma's account menu\n");
  flags("src/canvas/canvas.css", "/* Figma's rotate cursor: one curved arrow */\n");
  flags("templates/shell/deploy.yml", "# mirrors the Storybook layout\n");
});

// ── rule 2: the shape, with no name on any list ──────────────────────────────

test("a product NOBODY has written down is caught by its shape alone", () => {
  // The decisive case. "Fabricadabra" is invented for this test and appears on no list
  // in the guard; if this passes, the guard is a denylist wearing a shape rule's clothes.
  const out = flags("src/canvas/canvas.js", "// ---- follow mode: mirror a peer's viewport (the Fabricadabra idiom) ----\n");
  assert.match(out, /product-comparison/);
  assert.match(out, /Fabricadabra/);
});

test("each of the four comparison frames fires", () => {
  assert.match(flags("a.js", "// Thingummy's model, and the reason it works\n"), /possessive/);
  assert.match(flags("b.js", "// a Thingummy-style rail down the left\n"), /product-as-adjective/);
  assert.match(flags("c.js", "// selection behaves like Thingummy on a marquee drag\n"), /explicit comparison/);
  assert.match(flags("d.js", "// nudge ten with Shift, the Thingummy/Whatsit pair\n"), /attributive/);
});

// ── the negatives: everything the engine legitimately says ───────────────────

test("the engine's own capitalised vocabulary is not a product comparison", () => {
  passes("build.js", "// Base and Patterns are built from these, the Augur way\n");
  passes("build.js", "// the Tokens model: one value, many consumers\n");
});

test("infrastructure the engine actually runs on is not a comparison", () => {
  passes("src/_worker.js", "// the Cloudflare model: one isolate per colo\n");
  passes("scripts/deploy.mjs", "// unlike GitHub, the store has no merge step\n");
  passes("src/canvas/canvas.js", "// Lucide icons (lucide.dev, ISC) render in their native box\n");
});

test("ALL-CAPS emphasis is the engine's own house style, not a proper noun", () => {
  // Every one of these was a live false positive before the shape rule required a
  // lowercase second character.
  passes("src/_worker.js", "// Canvas board docs follow the COMMENTS model, not the status model\n");
  passes("src/canvas/canvas.js", "// ---- the LINE model (what makes lists possible) ----\n");
  passes("CANVAS.md", "- **Chrome-class stripping runs on the ENGINE's nodes only**\n");
  passes("test/x.test.mjs", "// the WEAKER shape: a slot filled by six simultaneous loads\n");
});

test("ordinary English that merely contains a product-shaped word is not caught", () => {
  // Each of these is a real line in the engine today. `canvas` is 400+ lines of it.
  passes("src/canvas/canvas.js", "const canvas = document.createElement('canvas');\n");
  passes("build.js", "  .x { background: linear-gradient(to bottom, #000, transparent); }\n");
  passes("src/_worker.js", "// the CLI's equivalent notion of a unit path\n");
  passes("src/canvas/canvas.js", "// abstract motifs, so nothing reads as a logo\n");
  passes("src/canvas/canvas.js", "// keep sketching until the shape settles\n");
  passes("build.js", "// so every icon sat high with the slack pooling at the bottom\n");
});

// ── the standing ratchet ─────────────────────────────────────────────────────

test("the real engine tree names no other company's product", () => {
  // This is the ratchet. It goes red the moment anyone reintroduces a name anywhere in
  // the repo, which is what was asked for after the same class of thing came back twice.
  const out = execFileSync(process.execPath, [SCRIPT, ENGINE], { encoding: "utf8" });
  assert.match(out, /OK/);
});

test("the guard reads real files rather than passing over an empty scan", () => {
  // A guard that finds nothing because it LOOKED at nothing is the failure this whole
  // file exists to prevent. Plant a name in a real tracked file and require a finding.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "no-product-vacuity-"));
  try {
    fs.writeFileSync(path.join(root, "build.js"), "// a line with spaces, a tab\tand a Figma reference\n");
    let failed = false;
    try { execFileSync(process.execPath, [SCRIPT, root], { encoding: "utf8" }); } catch { failed = true; }
    assert.equal(failed, true, "a file containing spaces and tabs must still be read");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
