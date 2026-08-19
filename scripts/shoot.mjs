#!/usr/bin/env node
// shoot.mjs — capture optimized WebP poster screenshots for prototype/page/component
// cards. Renders each entry index.html headlessly and writes preview.webp into its
// folder (OVERWRITING any old one), optimized via cwebp. build.js then renders an
// <img> poster instead of a live <iframe> preview — far cheaper — and falls back to
// a live iframe for anything without a poster yet.
//
// Rendered from source over file:// so the injected companion/review overlay are
// absent (their absolute /piti.js, /__review paths simply don't resolve) and the
// poster is a clean shot of the prototype itself.
//
// Usage:
//   npm run shoot                       # (re)shoot every card target
//   npm run shoot -- --stale            # only targets whose source changed (or no poster)
//   npm run shoot -- <path/to/folder>   # just one folder (must hold an entry .html)
//
// `--stale` is what `npm run posters` uses: it compares each folder's newest source
// file against its preview.webp and reshoots only what actually changed. Posters are
// COMMITTED IN THE SPACE REPOS — run this from a workspace of sibling clones (so targets
// resolve to the editable sibling clones), then commit/push the space repo.
//
// Requires: playwright (devDep) + cwebp on PATH (`brew install webp`).

import { chromium } from "playwright";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VIEWPORT = { width: 1280, height: 800 }; // 16:10 — matches the card aspect ratio
const WEBP_W = 768; // shown at ≤260px; 768px covers 2–3× DPR crisply
const WEBP_Q = 72;

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }
async function isDir(p) { try { return (await fs.stat(p)).isDirectory(); } catch { return false; } }

// Entry HTML for a folder: index.html, else the first .html.
async function entry(dir) {
  if (await exists(path.join(dir, "index.html"))) return path.join(dir, "index.html");
  const es = await fs.readdir(dir, { withFileTypes: true });
  const h = es.find((e) => e.isFile() && e.name.endsWith(".html"));
  return h ? path.join(dir, h.name) : null;
}

// A canvas board can't be shot from source: its entry html is a thin shell that
// loads /__canvas/canvas.js by absolute path (dead over file://) and the board
// content lives in the instance's KV (GET /__board — a public route). Canvas
// folders are shot from the LIVE page instead — strictly read-only: the room
// socket is stubbed at the constructor (upgrades bypass route interception), in
// EVERY frame, because a tile can embed another canvas which would join ITS room
// and haunt presence; POST /__board is answered locally; the overlay/companion
// scripts are blocked for the same clean-shot reason source shots use file://.
// No siteOrigin, offline, or a gate answering the URL → skip, keeping whatever
// poster is committed.
async function isCanvasEntry(file) {
  try { return /\/__canvas\/canvas\.js/.test(await fs.readFile(file, "utf8")); } catch { return false; }
}

// A card folder's live URL: walk up to its space root (space.json), mount the
// default space at "/" and others at "/<id>/" (build.js's rule), and drop the
// on-disk "prototypes/" segment (<opp>/prototypes/<name> ships at /<opp>/<name>/).
async function liveUrl(dir) {
  let root = dir;
  while (root !== path.dirname(root) && !(await exists(path.join(root, "space.json")))) root = path.dirname(root);
  let meta;
  try { meta = JSON.parse(await fs.readFile(path.join(root, "space.json"), "utf8")); } catch { return null; }
  const origin = typeof meta.siteOrigin === "string" ? meta.siteOrigin.replace(/\/+$/, "") : "";
  if (!origin) return null;
  const parts = path.relative(root, dir).split(path.sep);
  if (parts[1] === "prototypes") parts.splice(1, 1);
  const base = meta.default ? "" : `/${meta.id}`;
  return `${origin}${base}/${parts.map(encodeURIComponent).join("/")}/`;
}

async function shootLiveCanvas(browser, dir, rel) {
  const live = await liveUrl(dir);
  if (!live) { console.log("· skip (canvas, no siteOrigin):", rel); return false; }
  // Reachability first: the gate answers unknown or locked paths with its own
  // login HTML, which must never become a poster.
  let shell = "";
  try { shell = await (await fetch(live)).text(); } catch {}
  if (!/\/__canvas\/canvas\.js/.test(shell)) {
    console.log("· skip (canvas gated/unpublished/offline):", rel, "→", live);
    return false;
  }
  const tmp = path.join(os.tmpdir(), "shoot-" + rel.replace(/[^a-z0-9]+/gi, "-") + ".png");
  const outWebp = path.join(dir, "preview.webp");
  for (let attempt = 1; attempt <= 2; attempt++) {
    const page = await browser.newPage({ viewport: VIEWPORT });
    try {
      await page.addInitScript(() => {
        window.WebSocket = class {
          constructor() {
            this.readyState = 3;
            setTimeout(() => { if (this.onerror) this.onerror(new Event("error")); if (this.onclose) this.onclose(new Event("close")); }, 0);
          }
          addEventListener(type, fn) { if (type === "error" || type === "close") setTimeout(() => fn(new Event(type)), 0); }
          removeEventListener() {} send() {} close() {}
        };
      });
      await page.route("**/__board*", (r) =>
        r.request().method() === "POST" ? r.fulfill({ status: 204, body: "" }) : r.continue());
      await page.route("**/piti*", (r) => r.abort());
      await page.route("**/__review/**", (r) => r.abort());
      await page.goto(live, { waitUntil: "load", timeout: 30000 });
      // Board fetch + node paint; an empty board is legitimate, so a miss just shoots.
      await page.waitForFunction(() => window.GVCanvas && window.GVCanvas.nodes && window.GVCanvas.nodes().length > 0, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2500); // tiles/images/fonts settle
      // Editing chrome (toolbar/topbar/zoom — all inside #gvc-ui) is not board
      // content; frame the whole board rather than whatever camera was saved last.
      await page.addStyleTag({ content: "#gvc-ui { display: none !important; }" });
      await page.evaluate(() => { try { window.GVCanvas.fit({ cover: true }); } catch {} });
      await page.waitForTimeout(700); // fit() animates ~320ms; let tiles re-rasterize
      await page.screenshot({ path: tmp, clip: { x: 0, y: 0, ...VIEWPORT } });
      const png = await fs.stat(tmp).catch(() => null);
      if (!png || png.size === 0) throw new Error("empty screenshot");
      await execFileP("cwebp", ["-quiet", "-q", String(WEBP_Q), "-resize", String(WEBP_W), "0", tmp, "-o", outWebp]);
      const kb = Math.round((await fs.stat(outWebp)).size / 1024);
      console.log("✓", rel + "/preview.webp", kb + "KB (live canvas)");
      return true;
    } catch (e) {
      const msg = e.message.split("\n")[0];
      if (attempt < 2) { console.log("· retry", rel, "—", msg); continue; }
      console.log("✗ FAIL", rel, "—", msg);
      return false;
    } finally {
      await page.close().catch(() => {});
      await fs.unlink(tmp).catch(() => {});
    }
  }
  return false;
}

// Folders inside a space root that never hold card targets.
// Extend via GV_SCAN_IGNORE (comma-separated dir names) for space-specific bulk dirs.
const IGNORE = new Set(["node_modules", "skills", "scripts", "registry", ".git", ".github", ".claude",
  ...(process.env.GV_SCAN_IGNORE || "").split(",").filter(Boolean)]);

// Space roots to scan. One repo per space: card targets live inside each space repo.
// Prefer the EDITABLE sibling clones (../<x> with a space.json at its root — a shot
// poster can be committed + pushed from there); fall back to the pinned spaces/<id>
// mirrors (posters shot there can't be pushed — run from the sibling-clone workspace).
async function spaceRoots() {
  const roots = [];
  for (const base of [path.join(ROOT, ".."), path.join(ROOT, "spaces")]) {
    try {
      for (const e of await fs.readdir(base, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith(".")) continue;
        if (await exists(path.join(base, e.name, "space.json"))) roots.push(path.join(base, e.name));
      }
    } catch {}
    if (roots.length) break; // siblings found → don't also scan the pinned mirrors
  }
  return roots;
}

// Every folder that appears as a card on a shell page: each opportunity's prototypes,
// plus the pages/, components/, base/, patterns/, playground/ groups — per space.
async function targets() {
  const out = [];
  for (const root of await spaceRoots()) {
    for (const t of await fs.readdir(root, { withFileTypes: true })) {
      if (!t.isDirectory() || IGNORE.has(t.name) || t.name.startsWith(".")) continue;
      const pp = path.join(root, t.name, "prototypes");
      if (await isDir(pp)) {
        for (const p of await fs.readdir(pp, { withFileTypes: true })) {
          if (p.isDirectory()) out.push(path.join(pp, p.name));
        }
      }
    }
    for (const group of ["pages", "components", "base", "patterns", "playground"]) {
      const g = path.join(root, group);
      if (await isDir(g)) {
        for (const e of await fs.readdir(g, { withFileTypes: true })) {
          if (e.isDirectory() && !e.name.startsWith(".")) out.push(path.join(g, e.name));
        }
      }
    }
  }
  return out;
}

// Newest mtime (ms) of any file in a folder tree, ignoring the poster itself.
async function newestMtime(dir, ignore) {
  let latest = 0;
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.name === ignore) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) latest = Math.max(latest, await newestMtime(p, ignore));
    else if (e.isFile()) latest = Math.max(latest, (await fs.stat(p)).mtimeMs);
  }
  return latest;
}

// A folder needs reshooting when it has no poster, or its source is newer than one.
async function needsShoot(dir) {
  const poster = path.join(dir, "preview.webp");
  if (!(await exists(poster))) return true;
  return (await newestMtime(dir, "preview.webp")) > (await fs.stat(poster)).mtimeMs;
}

async function shoot(browser, dir) {
  const file = await entry(dir);
  const rel = path.relative(ROOT, dir);
  if (!file) { console.log("· skip (no html):", rel); return false; }
  if (await isCanvasEntry(file)) return shootLiveCanvas(browser, dir, rel);
  const tmp = path.join(os.tmpdir(), "shoot-" + rel.replace(/[^a-z0-9]+/gi, "-") + ".png");
  const outWebp = path.join(dir, "preview.webp");
  // Up to 2 attempts. Headless captures occasionally produce an empty/corrupt PNG
  // that cwebp then can't read; previously the unguarded cwebp rejection crashed the
  // whole run (aborting `npm run deploy`). Now any single-poster failure is caught and
  // logged — the run keeps going and the existing committed poster is left in place —
  // and a retry clears the common transient case.
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
      console.log("✓", rel + "/preview.webp", kb + "KB");
      return true;
    } catch (e) {
      const msg = e.message.split("\n")[0];
      if (attempt < 2) { console.log("· retry", rel, "—", msg); continue; }
      console.log("✗ FAIL", rel, "—", msg);
      return false;
    } finally {
      await page.close().catch(() => {});
      await fs.unlink(tmp).catch(() => {});
    }
  }
  return false;
}

const argv = process.argv.slice(2);
const staleOnly = argv.includes("--stale");
const pathArg = argv.find((a) => !a.startsWith("--"));
let list = pathArg ? [path.resolve(pathArg)] : await targets();

if (staleOnly) {
  const fresh = [];
  for (const d of list) if (await needsShoot(d)) fresh.push(d);
  const skipped = list.length - fresh.length;
  if (skipped) console.log(`stale: ${skipped} poster(s) up to date · ${fresh.length} to (re)shoot`);
  list = fresh;
}

if (!list.length) {
  console.log("nothing to shoot — all posters current");
} else {
  const browser = await chromium.launch();
  let ok = 0;
  for (const d of list) if (await shoot(browser, d)) ok++;
  await browser.close();
  console.log(`\nshot ${ok}/${list.length} posters`);
}
