#!/usr/bin/env node
/**
 * no-foreign-vocabulary — the engine may not carry a workspace's private vocabulary.
 *
 * WHY THIS EXISTS. `check.yml` already greps for instance and product words, and it
 * caught NOTHING through the whole de-client extraction: nine customer names, a
 * customer's slug prefixes and a customer's CSS-variable namespace sat in the shared
 * engine through every one of those runs. The reason is structural, not a gap in the
 * list — that grep is a DENYLIST of names, so it can only ever catch a name somebody
 * already thought to write down. The next client is, by definition, not on it.
 *
 * WHY NOT JUST WIDEN THE LIST. A denylist of client names, in a public repo, IS a
 * client list in a public repo — the problem restated, and worse, because it would be
 * the canonical one. The list would also have to name cities, products and codenames
 * that mean nothing out of context, so nobody could maintain it and every miss would
 * look like a decision. Rejected on both counts.
 *
 * WHAT THIS DOES INSTEAD. It names no client and no city. Each rule below states a
 * SHAPE that only foreign vocabulary has, and every allowlist in this file is standard
 * web vocabulary — CSS keywords, HTML meta names — which leaks nothing about who runs
 * an instance. A rule earns its place by two proofs, both recorded in the commit that
 * adds it: it FIRES on the pre-extraction tree, and it is SILENT on HEAD.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO — read this before assuming you are covered:
 *   · A workspace's SLUG PREFIXES (`fo-`, `bo-`, a retired page's slug in a Set) are
 *     not checkable here. They have exactly the shape of the engine's own hyphenated
 *     names — CSS classes, attributes, route segments, MIME types — and no regex over
 *     source can tell `"bo-project-phase"` from `"stroke-linejoin"` without knowing
 *     which one is compared against a directory entry. That needs dataflow, not grep.
 *   · A short word smuggled into a general-vocabulary list (an entry in ACRONYMS that
 *     is one team's initials rather than an acronym) is not checkable EITHER, for the
 *     same reason inverted: the honest entries and the dishonest one are the same
 *     shape. That one is a review question, and the comment on that Set says so.
 * Both are real gaps. A guard that pretends otherwise is worse than one that says
 * where it stops.
 *
 * Run: node scripts/no-foreign-vocabulary.mjs   (exit 1 on any finding)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.argv[2] || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The SHIPPED engine: what a pin bump pushes into every instance. Vendored trees, build
// output and the repo's own git data are not ours to lint.
const SCAN_DIRS = ["src", "scripts", "agents"];
const SCAN_FILES = ["build.js"];
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "coverage"]);
const EXT = new Set([".js", ".mjs", ".cjs"]);
// This file necessarily writes down the shapes it forbids.
const SELF = "scripts/no-foreign-vocabulary.mjs";

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* walk(path.join(dir, e.name)); }
    else if (EXT.has(path.extname(e.name))) yield path.join(dir, e.name);
  }
}

function sources() {
  const out = [];
  for (const f of SCAN_FILES) { const p = path.join(ROOT, f); if (fs.existsSync(p)) out.push(p); }
  for (const d of SCAN_DIRS) out.push(...walk(path.join(ROOT, d)));
  return out.filter((p) => path.relative(ROOT, p) !== SELF);
}

const findings = [];
const report = (rule, file, lineNo, line, detail) =>
  findings.push({ rule, file: path.relative(ROOT, file), lineNo, line: line.trim().slice(0, 160), detail });

// Every quoted string literal on a line, single/double/backtick, value only.
const stringsOn = (line) =>
  [...line.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|`([^`\\$]*)`/g)]
    .map((m) => m[1] ?? m[2] ?? m[3]).filter((s) => s !== undefined);

const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

// A proper noun: capitalised words, optionally several, optionally with the marks real
// place and organisation names carry. NOT an ALL-CAPS constant, not camelCase, not a
// sentence (a sentence has a lowercase function word in it, which this rejects by
// requiring every word to be capitalised).
const PROPER_NOUN = /^[A-ZÀ-Þ][a-zß-ÿ'’]+(?:[ \u00A0''-][A-ZÀ-Þa-zß-ÿ][a-zß-ÿ'’]*)*$/;
// Capitalised words that are ordinary CSS/web vocabulary, not somebody's name. Standard
// vocabulary only — nothing here identifies a person, a city or a company.
const CSS_WORDS = new Set([
  "Inter", "Menlo", "Consolas", "Helvetica", "Arial", "Georgia", "Courier", "Roboto",
  "Segoe", "Cambria", "Verdana", "Tahoma", "Times", "Symbol", "Noto", "Liberation",
  "Auto", "None", "Normal", "Bold", "Italic", "Regular", "Medium", "Light", "Black",
  "White", "Center", "Left", "Right", "Top", "Bottom", "Solid", "Dashed", "Dotted",
  "Small", "Large", "Default", "Custom", "Other", "Unknown", "Untitled", "New",
]);

/* ── Rule 1 — a proper noun standing next to a colour is somebody's brand ──────
 *
 * The engine's own colours are ANONYMOUS: a hex in engine source is a swatch in a
 * palette array, a fill in an inline SVG, or a value in a CSS declaration, and none of
 * those has a name beside it. The moment a hex is quoted next to a capitalised name,
 * the engine has stopped styling itself and started holding a TABLE OF SOMEBODY'S
 * BRANDS — which is exactly the shape the nine-customer theme list had, and exactly
 * the shape the tenth would have.
 *
 * This is why the rule pairs the two rather than banning either: hex literals are
 * ordinary and proper nouns are ordinary; a hex literal AS DATA, labelled with a name,
 * is not.
 *
 * QUOTED is load-bearing, and it is the second half of why this is precise. CSS writes
 * a colour BARE — `color: #16171a;` — and the engine's chrome CSS does so on hundreds
 * of lines, thirteen of which also carry a quoted font stack. A colour that has been
 * put in QUOTES has stopped being a declaration and become a VALUE: something the code
 * carries around, which is the only way a customer's brand colour can be stored. So a
 * bare hex is invisible to this rule by construction, not by exception, and no
 * allowlist of the engine's own stylesheets is needed or wanted.                      */
function ruleBrandTable(file, lines) {
  lines.forEach((line, i) => {
    const strs = stringsOn(line);
    if (!strs.some((s) => HEX.test(s.trim()))) return;
    for (const s of strs) {
      const v = s.trim();
      if (HEX.test(v)) continue;
      if (!PROPER_NOUN.test(v)) continue;
      if (v.split(/[\s-]+/).every((w) => CSS_WORDS.has(w))) continue;
      report("brand-table", file, i + 1, line,
        `the quoted name ${JSON.stringify(v)} sits beside a colour literal — the engine holds no organisation's brand colour`);
      return;
    }
  });
}

/* ── Rule 2 — the token namespace comes from the workspace, never from here ────
 *
 * A design system's CSS custom properties are named in ITS vocabulary, and the engine
 * is told what that vocabulary is: the UI skill declares `cssPrefixes` in skill.json,
 * buildGraph() resolves it, and it rides out on the composition graph precisely so
 * that anything downstream reads it instead of re-deriving one. So a literal
 * `--<something>-` anchored in engine source cannot be anything but one workspace's
 * private prefix, hardcoded — there is no other way it could have got there.
 *
 * An INTERPOLATED prefix (`^--(?:${PFX})-…`) is the correct construction and passes:
 * the shape being caught is the literal, not the anchor.                             */
function ruleTokenNamespace(file, lines) {
  lines.forEach((line, i) => {
    // Skip comments: the docs have to be able to SAY "--acme-*" to explain the feature.
    const code = line.replace(/^\s*(?:\/\/|\*|\/\*).*$/, "");
    if (!code) return;
    for (const m of code.matchAll(/\^--([A-Za-z][\w-]*)-/g)) {
      report("token-namespace", file, i + 1, line,
        `anchors on the literal custom-property prefix "--${m[1]}-" — the token vocabulary is the skill's ` +
        `cssPrefixes, carried on the graph; interpolate it instead of naming one workspace's`);
      return;
    }
  });
}

/* ── Rule 3 — a meta tag the engine reads must be in a namespace the engine owns ──
 *
 * A prototype is a workspace's own HTML, so a `<meta name="…">` the ENGINE goes
 * looking for is a contract between them, and the engine gets to name its half of it.
 * A meta name in someone else's namespace means the contract was written in their
 * words and every other workspace has to learn them — which is how a page taxonomy
 * belonging to one product ended up classifying every page of every workspace.
 *
 * The allowlist is standard web vocabulary plus the engine's own `augur-` namespace.
 * It names no product: if a name is neither a W3C/OGP one nor the engine's, it is
 * somebody's, and that is the finding.                                              */
const STD_META = new Set([
  "description", "viewport", "robots", "theme-color", "color-scheme", "author",
  "generator", "keywords", "referrer", "application-name", "format-detection",
  "mobile-web-app-capable", "apple-mobile-web-app-capable",
  "apple-mobile-web-app-status-bar-style", "apple-mobile-web-app-title", "msapplication-TileColor",
]);
const stdMetaOk = (n) =>
  STD_META.has(n) || /^(?:og|twitter|fb|al|article|product|profile|music|video|book):/i.test(n)
  || n.startsWith("augur-");

function ruleMetaNamespace(file, lines) {
  lines.forEach((line, i) => {
    // Only where a <meta …> tag is actually in play, so ordinary `name=` form fields
    // and function parameters are out of scope.
    if (!/<meta\b/i.test(line)) return;
    // Between `name=` and the name itself, skip whatever quoting the site uses: a plain
    // quote in emitted HTML, an escaped one in a JS string, or a character class in the
    // REGEX that reads the tag — `name=["']gv-surface["']`. Missing the character-class
    // form would mean catching only the comment that documents the read and never the
    // read, which is the wrong way round.
    for (const m of line.matchAll(/name=\s*\\?[\["'\]]*\s*([A-Za-z][\w:.-]*)/g)) {
      const n = m[1];
      if (stdMetaOk(n)) continue;
      report("meta-namespace", file, i + 1, line,
        `reads or writes <meta name="${n}"> — not a standard web meta name and not in the engine's ` +
        `own "augur-" namespace, so it is one workspace's vocabulary`);
      return;
    }
  });
}

for (const file of sources()) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  ruleBrandTable(file, lines);
  ruleTokenNamespace(file, lines);
  ruleMetaNamespace(file, lines);
}

if (!findings.length) {
  console.log("no-foreign-vocabulary: OK — no foreign vocabulary in the engine");
  process.exit(0);
}
for (const f of findings) {
  console.error(`\n${f.file}:${f.lineNo}  [${f.rule}]\n  ${f.detail}\n  ${f.line}`);
}
console.error(`\nno-foreign-vocabulary: ${findings.length} finding(s).`);
console.error("The engine is shared by every instance. A workspace's own names belong in its");
console.error("space.json / skill.json, and reach the engine through the manifest, never as a literal.");
process.exit(1);
