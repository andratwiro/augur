// `hidden` must actually hide.
//
// The HTML `hidden` attribute is a UA rule — `[hidden] { display: none }` — at the
// lowest possible specificity. Any class rule that sets a display value beats it. So
// `<a class="gvspace__item" hidden>` where `.gvspace__item { display: flex }` renders
// in full, and every piece of JavaScript that carefully sets `el.hidden = true` does
// nothing at all.
//
// This has now bitten this codebase twice: once on `.gvprof__item` (hence the
// `.gvprof__item[hidden]` rule), and once on `.gvspace__item`, where it meant the
// space switcher listed every space to every signed-in user regardless of membership —
// the filter ran, set the attribute, and had no effect.
//
// The lesson this test encodes: asserting the ATTRIBUTE is in the markup proves
// nothing. Only the presence of the matching `[hidden]` override proves it hides.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const DIST = join(ROOT, "dist");

if (!existsSync(join(DIST, "index.html"))) {
  execFileSync(process.execPath, ["build.js"], {
    cwd: ROOT, env: { ...process.env, GV_ENGINE_ONLY: "1" }, stdio: "pipe",
  });
}

const PAGES = ["index.html", join("admin", "index.html")];

function classesToggledByHidden(html) {
  // Elements that ship carrying `hidden` — the ones whose visibility is controlled by
  // the attribute rather than by a class.
  const out = new Set();
  // `(?<![-\w])` keeps `aria-hidden` and `data-…-hidden` out: those are not the boolean
  // attribute and carry no UA display rule at all.
  for (const m of html.matchAll(/<[a-z][^>]*\s(?<![-\w])hidden(?=[\s>])[^>]*>/gi)) {
    const cls = /class="([^"]*)"/.exec(m[0]);
    if (!cls) continue;
    for (const c of cls[1].split(/\s+/).filter(Boolean)) out.add(c);
  }
  return out;
}

function styleText(html) {
  return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
}

// `.foo { … display: flex … }` — capture the display value declared for a bare class.
function declaredDisplay(css, cls) {
  const rule = new RegExp(`(^|[},])\\s*\\.${cls.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "g");
  let m, found = null;
  while ((m = rule.exec(css))) {
    const d = /(?:^|;)\s*display\s*:\s*([a-z-]+)/i.exec(m[2]);
    if (d) found = d[1].toLowerCase();
  }
  return found;
}

function hasHiddenOverride(css, cls) {
  const esc = cls.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
  return new RegExp(`\\.${esc}\\[hidden\\]\\s*\\{[^}]*display\\s*:\\s*none`, "i").test(css);
}

for (const page of PAGES) {
  test(`every class toggled by [hidden] in ${page} can actually be hidden`, () => {
    const file = join(DIST, page);
    if (!existsSync(file)) return;
    const html = readFileSync(file, "utf8");
    const css = styleText(html);
    const offenders = [];
    for (const cls of classesToggledByHidden(html)) {
      const display = declaredDisplay(css, cls);
      if (!display || display === "none") continue; // nothing beats the UA rule
      if (!hasHiddenOverride(css, cls)) {
        offenders.push(`.${cls} sets display:${display} but has no .${cls}[hidden] override`);
      }
    }
    assert.deepEqual(offenders, [],
      `these elements ship with \`hidden\` but render anyway:\n  ${offenders.join("\n  ")}`);
  });
}
