// The emitted stylesheet must parse.
//
// CSS fails silently and asymmetrically: one stray `}` ends the block early, and the
// browser then discards rules until it resynchronises — so the damage shows up in
// selectors that are nowhere near the mistake and look untouched in the source. That
// is exactly what happened when a multi-line rule was edited by replacing only its
// first line: the leftover declarations plus the old closing brace took out the rules
// after them, and a 20px workspace icon rendered at its natural size.
//
// Nothing here validates CSS properly — it checks the two things that actually broke:
// braces balance, and no declaration sits outside a block.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const DIST = join(ROOT, "dist");

if (!existsSync(join(DIST, "admin", "index.html"))) {
  execFileSync(process.execPath, ["build.js"], {
    cwd: ROOT, env: { ...process.env, GV_ENGINE_ONLY: "1" }, stdio: "pipe",
  });
}

const PAGES = ["index.html", join("admin", "index.html")];

const styleText = (html) =>
  [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");

// Strip comments and strings so a `}` inside either can't be miscounted.
const strip = (css) =>
  css.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');

for (const page of PAGES) {
  test(`the stylesheet in ${page} has balanced braces`, () => {
    const file = join(DIST, page);
    if (!existsSync(file)) return;
    const css = strip(styleText(readFileSync(file, "utf8")));
    let depth = 0, stray = 0, line = 1, firstStray = null;
    for (const ch of css) {
      if (ch === "\n") line++;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth < 0) { stray++; firstStray = firstStray || line; depth = 0; }
      }
    }
    assert.equal(stray, 0,
      `${stray} unmatched closing brace(s), first near line ${firstStray} — everything after it is discarded by the browser`);
    assert.equal(depth, 0, `${depth} block(s) left open`);
  });

  test(`no declaration sits outside a block in ${page}`, () => {
    const file = join(DIST, page);
    if (!existsSync(file)) return;
    const css = strip(styleText(readFileSync(file, "utf8")));
    // Walk top level only; a `prop: value;` at depth 0 is an orphan left by an edit.
    const orphans = [];
    let depth = 0, buf = "", line = 1;
    for (const ch of css) {
      if (ch === "\n") { line++; }
      if (ch === "{") { depth++; buf = ""; continue; }
      if (ch === "}") { depth = Math.max(0, depth - 1); buf = ""; continue; }
      if (depth === 0) {
        if (ch === ";") {
          const t = buf.trim();
          // A selector never contains a colon followed by a space-delimited value and
          // then a semicolon at top level; an at-rule (@import …;) legitimately does.
          if (/^[a-z-]+\s*:\s*\S/i.test(t) && !t.startsWith("@")) orphans.push(`line ${line}: ${t.slice(0, 60)}`);
          buf = "";
        } else buf += ch;
      }
    }
    assert.deepEqual(orphans, [],
      `declarations outside any rule — leftovers from editing a multi-line rule:\n  ${orphans.join("\n  ")}`);
  });
}

// ---- the rail's marks share one slot ----------------------------------------
// Three different systems were in play before this: nav glyphs in a 16px box, a 20px
// workspace icon nudged 1px right by a stray margin, and a 22px avatar pushed another
// pixel by a transparent border. Nothing lined up down the left edge. Measured in a
// browser the fix is exact (every mark at x=18, every label at x=48); what this test
// can cheaply hold is the CSS contract that produces it.
test("the rail's leading marks share one padding, gap and box", () => {
  const file = join(DIST, "index.html");
  if (!existsSync(file)) return;
  const css = strip(styleText(readFileSync(file, "utf8")));
  // Escape the selector once, here — passing pre-escaped strings in and escaping
  // again produced patterns that matched nothing and a test that "passed" vacuously.
  const rule = (sel) => {
    const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`(^|[},])\\s*${esc}\\s*\\{([^}]*)\\}`).exec(css);
    return m ? m[2].replace(/\s+/g, " ").trim() : null;
  };
  const decl = (body, prop) => {
    const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(body || "");
    return m ? m[1].trim() : null;
  };

  const nav = rule(".gvside a");
  const chip = rule(".gvprof__btn");
  const space = rule(".gvspace__btn");
  assert.ok(nav && chip && space, "all three rules exist");

  // Guard against a vacuous pass: if the selectors stop matching, fail loudly.
  assert.ok(nav.length && chip.length && space.length, 'rule bodies are non-empty');
  for (const [name, body] of [["nav row", nav], ["profile chip", chip], ["workspace row", space]]) {
    assert.equal(decl(body, "padding"), "6px 8px", `${name} shares the rail's padding`);
    assert.equal(decl(body, "gap"), "10px", `${name} shares the rail's gap`);
  }
  // A transparent border still occupies a pixel — that is what pushed the avatar right.
  assert.equal(/border\s*:\s*1px/.test(chip), false,
    "the profile chip must not carry a border the nav rows lack");
  // And the marks themselves are one 20px box.
  assert.match(rule(".gvprof__av") || "", /width: 20px/);
  assert.match(rule(".gvspace__icon") || "", /width: 20px/);
  assert.match(rule(".gvside a > .gvic, .gvside__act > .gvic") || "", /width: 20px/);
});
