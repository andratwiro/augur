#!/usr/bin/env node
/**
 * no-product-names — the engine may not name another company's product.
 *
 * WHY THIS EXISTS. Design-tool comparisons had colonised the engine: 50 mentions across
 * 19 files, and 32 of them were fetchable by any visitor. That last number is the point
 * and it is not obvious — build.js runs no minifier, so every comment in
 * src/canvas/canvas.js, src/canvas/canvas.css, src/review/comments.js and in build.js's
 * emitted CSS ships byte-for-byte to the browser at /__canvas/canvas.js, /__review/,
 * /_chrome.*.css and /admin/. One mention was live PROSE on /changelog/. So "it is only a
 * comment" was never true here, and the rule reaches the whole repo rather than the
 * strings a reader was expected to notice.
 *
 * WHY A DENYLIST IS FINE HERE AND NOT NEXT DOOR. scripts/no-foreign-vocabulary.mjs
 * argues at length that a denylist cannot work for a workspace's private vocabulary, and
 * it is right: that set is OPEN (one new name per customer, so the next one is by
 * definition not on the list) and writing it down would put a client list in a public
 * repo. Neither leg transfers. The design-tool set is CLOSED and grows with the industry
 * rather than with the business, and writing `figjam` into a public file discloses
 * nothing about anybody. It is the same category as the CSS_WORDS allowlist that file
 * already ships and defends on exactly that ground.
 *
 * But the rule is "another company's product", not "the twenty I listed", so RULE 2 is a
 * shape rule that stands on its own. Measured against the pre-purge tree, rule 2 alone
 * caught 31 of the 50, including every one that rule 1 had no name for.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO — read before assuming you are covered:
 *   · A LOWERCASE mention of an ambiguous name in running prose ("paste it into notion")
 *     is caught by neither rule. Rule 1 excludes ambiguous names because `canvas`,
 *     `linear-gradient`, `no notion of`, `abstract motifs` and `keep sketching` are all
 *     legitimate here and a guard on `check` gates the deploy, so a false positive is an
 *     outage of the ability to ship. Rule 2 requires title case. That gap is a review
 *     question, and this comment is where it is written down instead of assumed away.
 *
 * Run: node scripts/no-product-names.mjs [ROOT]   (exit 1 on any finding)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = process.argv[2] || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "coverage"]);
const EXT = new Set([".js", ".mjs", ".cjs", ".css", ".html", ".md", ".json", ".yml", ".yaml", ".toml", ".txt", ".sh"]);
// This file necessarily writes down the names it forbids, and its test necessarily uses
// them as fixtures.
const SELF = new Set(["scripts/no-product-names.mjs", "test/no-product-names.test.mjs"]);

// RULE 1 — names with no common-English sense, so a bare match is never a false positive.
// Ambiguous names (notion, sketch, abstract, framer, linear, canva, principle, craft,
// marvel, mural) are NOT here on purpose; see the header.
const PRODUCTS = [
  "figma", "figjam", "miro", "excalidraw", "invision", "zeplin", "penpot",
  "balsamiq", "axure", "protopie", "lucidchart", "whimsical", "shadcn",
  "storybook", "photoshop", "illustrator", "webflow", "imessage",
];
// `Linear` and `Notion` and `Slack` are ambiguous as words but unambiguous in the two
// frames the engine actually used them in, so they are caught by rule 2 instead.
const PRODUCT_RE = new RegExp(String.raw`\b(${PRODUCTS.join("|")})(?:['’]s|-[a-z]+)?\b`, "gi");

// RULE 2 — the comparison SHAPES. Every one of the 50 original hits sat in one of these,
// and they are what catches the tool nobody has written down.
const SHAPES = [
  [/\b([A-Z][a-z]{2,}[A-Za-z]*)['’]s\s+(?:idiom|model|move|shape|order|pair|set|affordance|convention|way|parity|answer|version)\b/g, "possessive product comparison"],
  [/\b([A-Z][a-z]{2,}[A-Za-z]*)-(?:parity|style|styled|class|quiet|like|ish|grade|native)\b/g, "product-as-adjective"],
  [/\b(?:like|unlike|the way|the same as)\s+([A-Z][a-z]{2,}[A-Za-z]*)\b/g, "explicit comparison to a named product"],
  [/\bthe\s+([A-Z][a-z]{2,}[A-Za-z]*)(?:\/[A-Z][a-z]{2,}[A-Za-z]*)*\s+(?:idiom|model|move|shape|order|pair|set|affordance|convention|way)\b/g, "attributive product comparison"],
];

// The proper nouns the engine legitimately writes: its own vocabulary, the platforms it
// RUNS ON, and the dependencies it vendors and must attribute. Every entry here is public
// standard vocabulary that identifies nobody — the same test the sibling guard's
// allowlists have to pass. Adding a name is a one-line diff in a commit whose subject is
// "we now depend on X", which makes it a review event by construction. There is
// deliberately no per-line pragma: a written reason is what every closed leak shipped
// under, and if a mention is legitimate it is a dependency and belongs here.
const ALLOWED = new Set([
  // the engine's own
  "Augur", "Clawd", "Piti", "Pitis", "Base", "Tokens", "Components", "Patterns", "Pages",
  "Playground", "Changelog", "Canvas", "Workspace", "Prototype", "Design", "Admin", "Help",
  // platforms it runs on
  "Cloudflare", "Workers", "Pages", "GitHub", "Actions", "Scaleway", "Stripe", "Migadu",
  "Wrangler", "Node", "Durable", "Object", "Objects",
  // browsers and rendering engines the code genuinely branches on
  "Chrome", "Safari", "Firefox", "WebKit", "Blink", "Gecko",
  // vendored dependencies and licences
  "Lucide", "Inter", "Menlo", "Consolas", "Helvetica", "Arial", "Roboto", "Segoe",
  "LentiaNova", "DSEG", "Playwright", "SIL", "ISC", "MIT", "OFL",
  // ordinary capitalised English that lands in these frames
  "The", "This", "That", "These", "Those", "Every", "Each", "One", "Two", "Both", "Same",
  "Option", "Shift", "Control", "Command", "Escape", "Enter", "Guest", "Admin", "Viewer",
  "Editor", "Owner", "Anyone", "Nobody", "Somebody", "Read", "Write", "Note", "Sticky",
]);

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* walk(path.join(dir, e.name)); }
    else if (EXT.has(path.extname(e.name))) yield path.join(dir, e.name);
  }
}

// Prefer the tracked set — an untracked scratch file is not what a deploy ships — but a
// tarball checkout has no .git, so fall back to walking rather than passing vacuously.
function files() {
  try {
    const out = execFileSync("git", ["-C", ROOT, "ls-files", "-z"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const rels = out.split("\0").filter(Boolean).filter((r) => EXT.has(path.extname(r)));
    if (rels.length) return rels.map((r) => path.join(ROOT, r));
  } catch { /* no git — fall through */ }
  return [...walk(ROOT)];
}

const findings = [];
for (const abs of files()) {
  const rel = path.relative(ROOT, abs).split(path.sep).join("/");
  if (SELF.has(rel)) continue;
  let src;
  try { src = fs.readFileSync(abs, "utf8"); } catch { continue; }
  // A binary that slipped past the extension filter. The NUL is written as an escape
  // rather than embedded as a raw byte, so this file is not itself a file with a NUL
  // in it — which would make git treat it as binary and every diff of it unreadable.
  if (src.includes("\0")) continue;
  const lines = src.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const m of line.matchAll(PRODUCT_RE)) {
      findings.push({ rel, n: i + 1, rule: "product-denylist", detail: `"${m[0]}" is another company's product. Describe the mechanism instead.`, line });
    }
    for (const [re, why] of SHAPES) {
      for (const m of line.matchAll(re)) {
        const noun = m[1];
        if (ALLOWED.has(noun)) continue;
        findings.push({ rel, n: i + 1, rule: "product-comparison", detail: `${why}: "${noun}". Say what the behaviour IS, not what it is like.`, line });
      }
    }
  });
}

if (!findings.length) {
  console.log("no-product-names: OK — the engine names no other company's product");
  process.exit(0);
}
// One line per finding, deduped by file+line+rule so a line with two names reads once
// per rule rather than twice per name.
const seen = new Set();
for (const f of findings) {
  const key = `${f.rel}:${f.n}:${f.rule}`;
  if (seen.has(key)) continue;
  seen.add(key);
  console.log(`${f.rel}:${f.n}  [${f.rule}]`);
  console.log(`    ${f.detail}`);
  console.log(`    ${f.line.trim().slice(0, 160)}`);
}
console.log(`\n${seen.size} finding(s). The engine is public and unminified — a comparison in a comment ships to the browser.`);
process.exit(1);
