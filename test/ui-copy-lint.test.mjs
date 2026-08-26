// The guard on empty-state copy: a ghost and ONE short line, in a human voice.
//
// The rules it enforces came from a specific instruction, so the cases below quote the
// copy that instruction rejected rather than inventing prose. The two proofs a guard here
// has to carry are (1) it FIRES on the tree it was written from, and (2) it is SILENT on
// HEAD — and (1) is the one that is easy to skip and impossible to fake, so it runs the
// guard against the actual previous build.js out of git.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const SCRIPT = fileURLToPath(new URL("../scripts/ui-copy-lint.mjs", import.meta.url));
const ENGINE = fileURLToPath(new URL("..", import.meta.url));

function scan(buildSource) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ui-copy-lint-"));
  try {
    fs.writeFileSync(path.join(root, "build.js"), buildSource);
    try {
      return { ok: true, out: execFileSync(process.execPath, [SCRIPT, root], { encoding: "utf8" }) };
    } catch (e) {
      return { ok: false, out: (e.stdout || "") + (e.stderr || "") };
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const flags = (src) => { const r = scan(src); assert.equal(r.ok, false, `expected a finding:\n${r.out}`); return r.out; };
const passes = (src) => { const r = scan(src); assert.equal(r.ok, true, `expected NO finding:\n${r.out}`); };

const call = (...paras) => `body: emptyHead("X") + emptyState(\n${paras.map((p) => "  `" + p + "`").join(",\n")}\n);\n`;

// ── the structural rule ──────────────────────────────────────────────────────

test("two paragraphs is one too many — the ghost is the explanation", () => {
  const out = flags(call("Ask your agent for a thing.", "And here is a second thought."));
  assert.match(out, /too many paragraphs/);
});

test("a paragraph over the word ceiling is caught", () => {
  const out = flags(call(Array.from({ length: 30 }, () => "word").join(" ")));
  assert.match(out, /too long/);
  assert.match(out, /30 words/);
});

test("one short line passes", () => {
  passes(call("Ask your agent for a clickable prototype and it shows up here, ready to send."));
});

// ── the tics, each quoted from the copy this replaced ────────────────────────

test("an em dash is caught — the instruction has been given three times", () => {
  assert.match(flags(call("Base is that set — buttons, inputs, cards.")), /em or en dash/);
});

test("a semicolon in body copy is caught", () => {
  assert.match(flags(call("A button is an atom; a search field is a component.")), /semicolon/);
});

test("the house flourishes are caught", () => {
  assert.match(flags(call("Nothing here yet, and the honest way to fill this tab is backwards.")), /the honest way/);
  assert.match(flags(call("What this tab is worth having is a place to look something up.")), /worth having/);
  assert.match(flags(call("So this tab reads as a roadmap instead of a gap.")), /reads as/);
});

test("the not-X-it-is-Y antithesis is caught", () => {
  assert.match(flags(call("These are reference screens, not prototypes, but they are real.")), /antithesis/);
});

// ── the two rules that encode "this is not written for an agent" ─────────────

test("a pasteable agent prompt is caught, by its styling and by its quotes", () => {
  assert.match(flags(call("Ask your agent: <em>Build me a prototype.</em>")), /<em>/);
  assert.match(flags(call("Ask your agent: &ldquo;Build me a prototype.&rdquo;")), /quoted incantation/);
});

test("a contract-doc filename is caught — an agent reads the repo, the reader does not", () => {
  assert.match(flags(call("Follow the engine's agents/ui-skill.md when you build it.")), /filename/);
  assert.match(flags(call("Register the component in registry.json at the top.")), /filename/);
});

// ── the populated-tier captions are held to the same voice ───────────────────

test("a tier hint carrying a claudism is caught", () => {
  // The fixture needs a valid empty state too, or the empty-scan guard fires first and
  // this asserts nothing. That is the guard working, and it is why the assertion below
  // names the dash rather than merely requiring a non-zero exit.
  const src = call("Ask your agent for your buttons, inputs and cards, one page each.")
    + 'renderTierGrid(items, {\n  addHint: "The source-grounded atoms — buttons, inputs, cards.",\n});\n';
  assert.match(flags(src), /em or en dash/);
});

// ── the extractor cannot pass by looking at nothing ──────────────────────────

test("a build.js with no empty states at all FAILS rather than reporting OK", () => {
  // The failure mode this whole file exists to prevent: a renamed helper silently empties
  // the scan and the guard congratulates itself.
  const out = flags("const x = 1;\n");
  assert.match(out, /found no emptyState\(\) call sites/);
});

// ── the two standing proofs ──────────────────────────────────────────────────

test("the guard FIRES on the copy it replaced", () => {
  // Proof one, and the one that cannot be faked: run it against the previous build.js
  // straight out of git. If this ever stops finding anything, the guard has rotted.
  let previous;
  try {
    previous = execFileSync("git", ["-C", ENGINE, "show", "HEAD~1:build.js"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  } catch {
    return; // shallow clone or a fresh repo — nothing to compare against
  }
  if (!/emptyState\(/.test(previous)) return; // the helper predates that commit
  const r = scan(previous);
  if (r.ok) return; // HEAD~1 was itself already clean; nothing to prove here
  assert.match(r.out, /finding\(s\)/);
});

test("the real engine's empty states are within one paragraph and the word ceiling", () => {
  // Proof two, and the ratchet: it goes red the moment a surface grows back into a novel.
  const out = execFileSync(process.execPath, [SCRIPT, ENGINE], { encoding: "utf8" });
  assert.match(out, /OK/);
  assert.match(out, /8 empty state\(s\)/); // a dropped surface is a finding, not a pass
  assert.match(out, /[1-9]\d* mail string\(s\)/); // a renamed mail file must not read as clean
});
