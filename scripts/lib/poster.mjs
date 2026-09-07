// poster.mjs — the picture on a prototype's gallery card: `preview.webp` in its folder.
//
// The gallery shows a poster when the folder has one and a blank tile when it does not,
// and nothing on the serving side renders one — every poster on every instance was shot
// on somebody's machine by `npm run shoot` and uploaded with the folder. A draft landed
// from a folder without one therefore stayed blank for good. This is the one-folder half
// of that shoot, so `augur land` can take the picture on the way up, and `shoot.mjs`
// keeps the whole-space loop on top of the same functions.
//
// Optional by construction. Playwright and cwebp are a maintainer's tools, not a
// dependency of the package: missing either, `AUGUR_NO_POSTER=1`, or a folder that has
// no html to shoot means "skip, and say why" — never a landing that did not happen.
//
// Rendered over file://, so the injected companion/review overlays are absent (their
// absolute paths do not resolve) and the poster is a clean shot of the prototype itself.
// A canvas board cannot be shot that way — its entry is a thin shell around a script
// served by the instance — and is left to `shoot.mjs`, which shoots the live page.
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";

const execFileP = promisify(execFile);

export const VIEWPORT = { width: 1280, height: 800 }; // 16:10 — the card's aspect ratio
export const WEBP_W = 768; // shown at ≤260px; 768px covers 2–3× DPR crisply
export const WEBP_Q = 72;
export const POSTER = "preview.webp";

export async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

/** The folder's entry html: index.html, else the first .html at its top level. */
export async function entryOf(dir) {
  if (await exists(path.join(dir, "index.html"))) return path.join(dir, "index.html");
  let es = [];
  try { es = await fs.readdir(dir, { withFileTypes: true }); } catch { return null; }
  const h = es.find((e) => e.isFile() && e.name.endsWith(".html"));
  return h ? path.join(dir, h.name) : null;
}

/** A canvas board's entry is a shell that loads the canvas script by absolute path. */
export async function isCanvasEntry(file) {
  try { return /\/__canvas\/canvas\.js/.test(await fs.readFile(file, "utf8")); } catch { return false; }
}

// Engine assets every deployment serves by absolute path. Dead over file:// too, but a page
// without them still paints its own content — a missing font falls back; a missing stylesheet
// does not.
const ENGINE_ABS = /^\/(?:__|piti\.js$|fonts\/|_chrome\.|sw\.js$)/;

/**
 * Does the page pull a stylesheet or a script from OUTSIDE its folder — `../x.css`, or
 * `/skills/x.css`? A draft folder holds the unit and nothing else, and file:// resolves
 * neither, so the shot would be a white page with a stray bar: a poster worse than none,
 * since the folder card then wears it. Such a page is shot from the space clone, where the
 * paths resolve, by `npm run shoot`.
 */
export async function pullsFromOutside(file) {
  let html = "";
  try { html = await fs.readFile(file, "utf8"); } catch { return false; }
  const tags = html.match(/<(?:link|script)\b[^>]*>/gi) || [];
  for (const tag of tags) {
    if (/^<link/i.test(tag) && !/\brel\s*=\s*["']?[^"'>]*stylesheet/i.test(tag)) continue;
    const m = /\b(?:href|src)\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (!m) continue;
    const u = m[1].trim();
    if (/^(?:[a-z]+:)?\/\//i.test(u) || /^(?:data|blob):/i.test(u)) continue; // the network is not the folder
    if (u.startsWith("../")) return true;
    if (u.startsWith("/") && !ENGINE_ABS.test(u)) return true;
  }
  return false;
}

async function newestMtime(dir, ignore) {
  let latest = 0;
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.name === ignore || e.name === ".augur") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) latest = Math.max(latest, await newestMtime(p, ignore));
    else if (e.isFile()) latest = Math.max(latest, (await fs.stat(p)).mtimeMs);
  }
  return latest;
}

/** A folder needs shooting when it has no poster, or its source is newer than the poster. */
export async function needsPoster(dir) {
  const poster = path.join(dir, POSTER);
  if (!(await exists(poster))) return true;
  return (await newestMtime(dir, POSTER)) > (await fs.stat(poster)).mtimeMs;
}

/**
 * Shoot ONE folder's entry html from source into `<dir>/preview.webp` with an open
 * Playwright browser. Two attempts: a headless capture occasionally hands back an empty
 * PNG that cwebp cannot read, and a retry clears that. Resolves true when the poster was
 * written, false when it was not; never throws for one folder's sake.
 */
export async function shootFolder(browser, dir, { label = dir, log = () => {} } = {}) {
  const file = await entryOf(dir);
  if (!file) { log(`· skip (no html): ${label}`); return false; }
  const tmp = path.join(os.tmpdir(), "shoot-" + label.replace(/[^a-z0-9]+/gi, "-") + ".png");
  const outWebp = path.join(dir, POSTER);
  for (let attempt = 1; attempt <= 2; attempt++) {
    const page = await browser.newPage({ viewport: VIEWPORT });
    try {
      await page.goto("file://" + file, { waitUntil: "load", timeout: 20000 });
      await page.waitForTimeout(900); // let fonts/layout settle
      await page.screenshot({ path: tmp, clip: { x: 0, y: 0, ...VIEWPORT } });
      const png = await fs.stat(tmp).catch(() => null);
      if (!png || png.size === 0) throw new Error("empty screenshot");
      await execFileP("cwebp", ["-quiet", "-q", String(WEBP_Q), "-resize", String(WEBP_W), "0", tmp, "-o", outWebp]);
      const kb = Math.round((await fs.stat(outWebp)).size / 1024);
      log(`✓ ${label}/${POSTER} ${kb}KB`);
      return true;
    } catch (e) {
      const msg = String(e && e.message || e).split("\n")[0];
      if (attempt < 2) { log(`· retry ${label} — ${msg}`); continue; }
      log(`✗ FAIL ${label} — ${msg}`);
      return false;
    } finally {
      await page.close().catch(() => {});
      await fs.unlink(tmp).catch(() => {});
    }
  }
  return false;
}

/** The tools this machine has for a poster, asked for rather than assumed. */
export async function posterTools() {
  let chromium = null;
  try { ({ chromium } = await import("playwright")); } catch { return { ok: false, why: "playwright is not installed here" }; }
  try { await execFileP("cwebp", ["-version"]); } catch { return { ok: false, why: "cwebp is not on PATH (`brew install webp`)" }; }
  return { ok: true, chromium };
}

/**
 * The poster for one folder, for `augur land`: shoot it when the folder has a shootable
 * page and no current poster, and this machine has the tools. The answer says what
 * happened — `{ shot: true }`, or `{ skipped, why }` with a reason a person can act on:
 *
 *   disabled       AUGUR_NO_POSTER=1, or the caller asked not to
 *   current        the poster is newer than every source file
 *   no-html        nothing to shoot
 *   canvas         a board; shot from the live page by `npm run shoot`, not from source
 *   outside-folder the page pulls a stylesheet/script from outside the folder (`../`, `/skills/…`);
 *                  a draft cannot render it — `npm run shoot` from the space clone can
 *   no-tools       Playwright or cwebp is missing (`why` names which)
 *   no-browser     Playwright is installed and its browser is not (`npx playwright install chromium`)
 *   failed         the capture failed twice
 */
export async function posterFor(dir, { log = () => {}, enabled = true } = {}) {
  if (!enabled || process.env.AUGUR_NO_POSTER === "1") return { skipped: "disabled", why: "poster shooting is off" };
  const file = await entryOf(dir);
  if (!file) return { skipped: "no-html", why: "the folder has no html page to shoot" };
  if (await isCanvasEntry(file)) return { skipped: "canvas", why: "a board is shot from its live page by `npm run shoot`, not from source" };
  if (await pullsFromOutside(file)) return { skipped: "outside-folder", why: "the page pulls a stylesheet or script from outside this folder, which a draft does not hold — shoot it from the space clone with `npm run shoot -- <folder>` and commit the poster" };
  if (!(await needsPoster(dir))) return { skipped: "current", why: `${POSTER} is newer than the source` };
  const tools = await posterTools();
  if (!tools.ok) return { skipped: "no-tools", why: tools.why };
  let browser;
  try { browser = await tools.chromium.launch(); }
  catch (e) { return { skipped: "no-browser", why: `Playwright's browser would not start — \`npx playwright install chromium\` (${String(e && e.message || e).split("\n")[0]})` }; }
  try {
    const ok = await shootFolder(browser, dir, { label: path.basename(dir), log });
    return ok ? { shot: true } : { skipped: "failed", why: "the capture failed twice; the folder is unchanged" };
  } finally {
    await browser.close().catch(() => {});
  }
}
