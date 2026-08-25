// The guard against a workspace's private vocabulary in the shared engine.
//
// Running it against the tree it was written from only proves it recognises code that
// is already gone. What has to hold is that it catches the NEXT one — a client nobody
// has met, a prefix nobody has typed — so every case here is synthetic, and none of
// them is the code the extraction removed.
//
// The negatives matter as much as the positives: a guard on `check` gates the deploy,
// so a false positive is an outage of the ability to ship. Each "allowed" case below is
// something the engine legitimately does today.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const SCRIPT = fileURLToPath(new URL("../scripts/no-foreign-vocabulary.mjs", import.meta.url));

// Run the guard over a throwaway tree holding one file. Returns {ok, out}.
function scan(relPath, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "no-foreign-vocab-"));
  try {
    const file = path.join(root, relPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
    try {
      const out = execFileSync(process.execPath, [SCRIPT, root], { encoding: "utf8" });
      return { ok: true, out };
    } catch (e) {
      return { ok: false, out: (e.stdout || "") + (e.stderr || "") };
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const flags = (rel, src) => { const r = scan(rel, src); assert.equal(r.ok, false, `expected a finding:\n${r.out}`); return r.out; };
const passes = (rel, src) => { const r = scan(rel, src); assert.equal(r.ok, true, `expected NO finding:\n${r.out}`); };

// ── brand-table: a colour with somebody's name on it ─────────────────────────

test("a colour table labelled with organisation names is caught, whoever they are", () => {
  // Names invented for this test. The point is that the guard has never seen them:
  // it is reacting to the SHAPE — a quoted name beside a quoted colour — not to a list.
  const out = flags("src/chrome/x.mjs", `
    const THEMES = [
      [0, "Northgate Borough", "#604596"], [1, "Vilanova", "#0077A3"],
    ];
  `);
  assert.match(out, /brand-table/);
  assert.match(out, /Northgate Borough/);
});

test("one name and one colour is enough — a table does not have to be a table", () => {
  assert.match(flags("src/x.mjs", `const ACCENT = { org: "Kirkwall", color: "#123456" };\n`), /brand-table/);
});

test("the engine's own anonymous colours are fine — a palette has no names in it", () => {
  passes("src/canvas/x.js", `
    var STICKY_COLORS = ["#ffffff", "#e9ecef", "#f4a9a8", "#a9cbf5"];
    var DEFAULT_STICKY = "#a9cbf5";
  `);
});

test("a BARE css colour beside a quoted font stack is not a brand table", () => {
  // The engine's own chrome CSS does exactly this on thirteen lines of build.js, so
  // this is the false positive that would have made the guard unshippable. It passes
  // because the colour is a DECLARATION, not a value: nothing put it in quotes.
  const line = '  .t { font: 600 16px/1.2 "Inter", "Inter Variable", sans-serif; color: #16171a; }';
  passes("src/x.mjs", "const CSS = `\n" + line + "\n`;\n");
});

test("...and quoting that same colour is exactly what makes it a finding", () => {
  // The one-character difference that separates a stylesheet from a stored brand.
  const out = flags("src/x.mjs", 'const T = { label: "Northgate", brand: "#16171a" };\n');
  assert.match(out, /brand-table/);
});

test("inline SVG art keeps its fills — markup beside a colour is not a name", () => {
  passes("src/canvas/x.js", `
    var STAR = '<polygon points="20,2.5 24.9,14.2" fill="#f6c514" stroke="#ffffff"/>';
  `);
});

test("a CSS keyword that happens to be capitalised is not an organisation", () => {
  passes("src/x.mjs", `const D = [["Normal", "#111111"], ["Bold", "#222222"]];\n`);
});

// ── token-namespace: whose CSS variables are these ───────────────────────────

test("anchoring on a literal custom-property prefix is caught, for any prefix", () => {
  const out = flags("build.js", `
    function group(name) {
      if (/^--zeta-space-/.test(name)) return "Spacing";
      return "Other";
    }
  `);
  assert.match(out, /token-namespace/);
  assert.match(out, /--zeta-/);
});

test("the correct construction passes — a prefix interpolated from the skill's manifest", () => {
  passes("build.js", "const typeRe = new RegExp(String.raw`^--(?:${PFX})-type-(.+)-(size|lh|weight)$`);\n");
});

test("a doc comment may still SAY --acme-*, or the feature cannot be explained", () => {
  passes("build.js", "  // the class/token prefixes its stylesheets use (classes .acme-*, tokens --acme-*).\n");
});

// ── meta-namespace: whose contract is this meta tag ──────────────────────────

test("reading a meta tag in someone else's namespace is caught", () => {
  const out = flags("build.js", `
    const m = html.match(/<meta\\s+name=["']zeta-surface["']\\s+content=["']([^"']+)["']/i);
  `);
  assert.match(out, /meta-namespace/);
  assert.match(out, /zeta-surface/);
});

test("standard web meta names pass — description, robots, og:, twitter:", () => {
  passes("build.js", `
    const head = \`<meta name="description" content="x"><meta name="robots" content="noindex">
      <meta name="og:title" content="y"><meta name="twitter:card" content="summary">
      <meta name="viewport" content="width=device-width">\`;
  `);
});

test("the engine may name its own half of the contract", () => {
  passes("build.js", `const t = html.match(/<meta name="augur-screen" content="([^"]+)"/);\n`);
});

test("a form field called name is not a meta tag", () => {
  passes("src/x.mjs", `const email = form.get("email"); const el = '<input name="password">';\n`);
});

// ── the guard does not lint itself into a corner ─────────────────────────────

test("the real engine tree is clean, and that is the standing assertion", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const out = execFileSync(process.execPath, [SCRIPT, root], { encoding: "utf8" });
  assert.match(out, /OK/);
});
