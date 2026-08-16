// Every inline script the build emits must actually parse.
//
// This exists because of a real, shipped break: build.js composes its client scripts as
// TEMPLATE LITERALS, so a `\n` written inside one is not an escape that reaches the
// browser — it is a real newline, injected straight into the emitted JavaScript. Put one
// inside a single-quoted string and that string is unterminated, which takes down the
// WHOLE script it lives in, not just the line.
//
// That happened to ADMIN_JS: two confirm() messages carried `?\n\n…`, and the entire
// admin panel script — the people table, invite, role changes, remove, reset — silently
// failed to parse. Nothing in the build complained, no test covered it, and the page just
// sat at "Loading…". A grep for the symptom finds nothing; only parsing the output does.
//
// So: parse everything, every build. The rule for authors is `\\n` inside these
// literals, never `\n`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

const ROOT = new URL("..", import.meta.url).pathname;

// Build an engine-only dist into a scratch dir: no space checkouts required, and it is
// the same chrome (rail, admin page, overlays) every instance ships.
const OUT = mkdtempSync(join(tmpdir(), "augur-inline-"));
execFileSync(process.execPath, ["build.js"], {
  cwd: ROOT,
  env: { ...process.env, GV_ENGINE_ONLY: "1", GV_DIST: OUT },
  stdio: "pipe",
});

// GV_DIST is not a knob build.js honours; fall back to the repo's own dist, which the
// build above just rewrote.
const DIST = existsSync(join(OUT, "admin", "index.html")) ? OUT : join(ROOT, "dist");

// `scripts: true` means the page is expected to CARRY inline JS — if it stops doing so
// the regex or the build broke, and a silently-empty scan would read as a pass.
const PAGES = [
  { file: "index.html", scripts: true },
  { file: join("admin", "index.html"), scripts: true },
  { file: "404.html", scripts: false },
];

// <script> blocks carrying a non-JS type (speculationrules, application/json, importmap)
// are data, not code — parsing them as JavaScript would be the test's own bug.
const JS_BLOCKS = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g;
const isJs = (attrs) => !/type=/.test(attrs) || /type="?(text\/javascript|module)/.test(attrs);

for (const page of PAGES) {
  test(`every inline script in ${page.file} parses`, () => {
    const file = join(DIST, page.file);
    if (!existsSync(file)) return; // not every build emits every page
    const html = readFileSync(file, "utf8");
    const broken = [];
    let m, i = 0;
    while ((m = JS_BLOCKS.exec(html))) {
      i++;
      if (!isJs(m[1])) continue;
      try {
        new vm.Script(m[2]);
      } catch (e) {
        // Point at the likely culprit: a line whose single quotes do not balance is
        // almost always a `\n` that became a real newline.
        // Comments are full of apostrophes ("can't", "shouldn't") and would otherwise
        // win the race to be blamed — skip them before counting quotes.
        const suspect = m[2].split("\n")
          .filter((l) => !l.trim().startsWith("//"))
          .find((l) => ((l.match(/'/g) || []).length % 2) === 1);
        broken.push(`script #${i}: ${e.message}${suspect ? `\n    near: ${suspect.trim()}` : ""}`);
      }
    }
    if (page.scripts) assert.ok(i > 0, `${page.file} emitted at least one inline script`);
    assert.deepEqual(broken, [], `broken inline scripts in ${page.file}:\n  ${broken.join("\n  ")}`);
  });
}
