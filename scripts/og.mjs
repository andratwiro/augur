#!/usr/bin/env node
// og.mjs — compose a 1200×630 Open Graph card for a prototype: the prototype's
// poster screenshot framed in a browser chrome, beside the title + site wordmark,
// on the site's indigo shell background. Writes og.jpg into the folder.
//
// Run AFTER shoot.mjs (it reuses each folder's preview.webp as the screenshot).
//
//   node scripts/og.mjs <path/to/folder>   # one folder
//   node scripts/og.mjs                     # every card target (same set as shoot)
//
// Requires: playwright (devDep).

import { chromium } from "playwright";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OG = { width: 1200, height: 630 };

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }
async function isDir(p) { try { return (await fs.stat(p)).isDirectory(); } catch { return false; } }

async function entry(dir) {
  if (await exists(path.join(dir, "index.html"))) return path.join(dir, "index.html");
  const es = await fs.readdir(dir, { withFileTypes: true });
  const h = es.find((e) => e.isFile() && e.name.endsWith(".html"));
  return h ? path.join(dir, h.name) : null;
}

// Folders inside a space root that never hold card targets. Space discovery mirrors
// shoot.mjs: editable sibling clones (../<x> with space.json) first, pinned spaces/<id>
// mirrors as the fallback.
const IGNORE = new Set(["node_modules", "skills", "scripts", "registry", "govocal-exports", ".git", ".github", ".claude"]);
async function spaceRoots() {
  const roots = [];
  for (const base of [path.join(ROOT, ".."), path.join(ROOT, "spaces")]) {
    try {
      for (const e of await fs.readdir(base, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith(".")) continue;
        if (await exists(path.join(base, e.name, "space.json"))) roots.push(path.join(base, e.name));
      }
    } catch {}
    if (roots.length) break;
  }
  return roots;
}
async function targets() {
  const out = [];
  for (const root of await spaceRoots()) {
    for (const t of await fs.readdir(root, { withFileTypes: true })) {
      if (!t.isDirectory() || IGNORE.has(t.name) || t.name.startsWith(".")) continue;
      const pp = path.join(root, t.name, "prototypes");
      if (await isDir(pp)) {
        for (const p of await fs.readdir(pp, { withFileTypes: true }))
          if (p.isDirectory()) out.push(path.join(pp, p.name));
      }
    }
    for (const group of ["pages", "components", "base", "patterns", "playground"]) {
      const g = path.join(root, group);
      if (await isDir(g)) {
        for (const e of await fs.readdir(g, { withFileTypes: true }))
          if (e.isDirectory() && !e.name.startsWith(".")) out.push(path.join(g, e.name));
      }
    }
  }
  return out;
}

// Bare card: just the prototype preview, centered, bottom-flush, on the soft site
// shell. No logo/title/text — those live in the og:* meta tags, not the image.
function cardHTML({ posterDataUri }) {
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html,body { width:1200px; height:630px; }
  body { position:relative; overflow:hidden; background:#fbfbfd; }
  body::before {
    content:""; position:absolute; inset:0;
    background:
      radial-gradient(1000px 520px at 50% -22%, rgba(94,106,210,0.13), transparent 60%),
      linear-gradient(180deg, #f3f4fb 0%, #fbfbfd 62%);
  }
  .shot {
    position:absolute; left:50%; bottom:0; transform:translateX(-50%);
    width:940px; display:block; border-radius:14px 14px 0 0;
    box-shadow:0 34px 90px -30px rgba(16,24,40,0.46), 0 2px 8px rgba(16,24,40,0.06);
  }
</style></head><body>
  <img class="shot" src="${posterDataUri}">
</body></html>`;
}

async function makeCard(browser, dir) {
  const file = await entry(dir);
  const rel = path.relative(ROOT, dir);
  if (!file) { console.log("· skip (no html):", rel); return false; }
  const posterPath = path.join(dir, "preview.webp");
  if (!(await exists(posterPath))) { console.log("· skip (no poster — run shoot):", rel); return false; }

  const posterB64 = (await fs.readFile(posterPath)).toString("base64");
  const posterDataUri = `data:image/webp;base64,${posterB64}`;
  const out = path.join(dir, "og.jpg");

  // Up to 2 attempts, with per-card failures caught so a single transient screenshot
  // hiccup can't crash the run and abort `npm run deploy` — the existing committed
  // card is left in place and the run continues. Mirrors shoot.mjs.
  for (let attempt = 1; attempt <= 2; attempt++) {
    // 1× = the OG spec size (1200×630). Unfurl thumbnails render ~500px wide, so a
    // higher DPR only bloats the file (some bots time out on multi-MB images).
    const page = await browser.newPage({ viewport: OG, deviceScaleFactor: 1 });
    try {
      await page.setContent(cardHTML({ posterDataUri }), { waitUntil: "load" });
      await page.waitForTimeout(200); // let the poster decode
      // JPEG q85 keeps each committed card ~80–120KB (vs ~300KB PNG) — invisible on an
      // unfurl thumbnail, ~3× lighter in the repo as the prototype count grows.
      await page.screenshot({ path: out, type: "jpeg", quality: 85, clip: { x: 0, y: 0, ...OG } });
      const kb = Math.round((await fs.stat(out)).size / 1024);
      console.log("✓", rel + "/og.jpg", kb + "KB");
      return true;
    } catch (e) {
      const msg = e.message.split("\n")[0];
      if (attempt < 2) { console.log("· retry", rel, "—", msg); continue; }
      console.log("✗ FAIL", rel, "—", msg);
      return false;
    } finally {
      await page.close().catch(() => {});
    }
  }
  return false;
}

// A folder needs a fresh card when it has no og.jpg, or its poster/entry html is
// newer than the existing card. Mirrors shoot.mjs's --stale so deploys stay cheap.
async function needsCard(dir) {
  const card = path.join(dir, "og.jpg");
  if (!(await exists(card))) return true;
  const cardM = (await fs.stat(card)).mtimeMs;
  const poster = path.join(dir, "preview.webp");
  const file = await entry(dir);
  for (const p of [poster, file].filter(Boolean)) {
    if (await exists(p) && (await fs.stat(p)).mtimeMs > cardM) return true;
  }
  return false;
}

const argv = process.argv.slice(2);
const staleOnly = argv.includes("--stale");
const pathArg = argv.find((a) => !a.startsWith("--"));
let list = pathArg ? [path.resolve(pathArg)] : await targets();

if (staleOnly) {
  const fresh = [];
  for (const d of list) if (await needsCard(d)) fresh.push(d);
  const skipped = list.length - fresh.length;
  if (skipped) console.log(`stale: ${skipped} card(s) up to date · ${fresh.length} to (re)make`);
  list = fresh;
}

if (!list.length) {
  console.log("nothing to make — all OG cards current");
} else {
  const browser = await chromium.launch();
  let ok = 0;
  for (const d of list) if (await makeCard(browser, d)) ok++;
  await browser.close();
  console.log(`\nmade ${ok}/${list.length} OG cards`);
}
