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

const IGNORE = new Set(["dist", "node_modules", "skills", "src", "references", "govocal-exports", "pitis", ".git", ".github"]);
async function targets() {
  const out = [];
  for (const t of await fs.readdir(ROOT, { withFileTypes: true })) {
    if (!t.isDirectory() || IGNORE.has(t.name) || t.name.startsWith(".")) continue;
    const pp = path.join(ROOT, t.name, "prototypes");
    if (await isDir(pp)) {
      for (const p of await fs.readdir(pp, { withFileTypes: true }))
        if (p.isDirectory()) out.push(path.join(pp, p.name));
    }
  }
  for (const group of ["pages", "components", "playground"]) {
    const g = path.join(ROOT, group);
    if (await isDir(g)) {
      for (const e of await fs.readdir(g, { withFileTypes: true }))
        if (e.isDirectory() && !e.name.startsWith(".")) out.push(path.join(g, e.name));
    }
  }
  return out;
}

// Pull <title>, split a leading "Title — Subtitle" / "Title (note)" into two lines.
async function titleOf(file) {
  const html = await fs.readFile(file, "utf8");
  const m = html.match(/<title>([^<]*)<\/title>/i);
  const raw = (m ? m[1] : "Prototype").trim();
  const parts = raw.split(/\s+[—–-]\s+/);
  return { title: parts[0].trim(), subtitle: parts.slice(1).join(" — ").trim() };
}

function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

function cardHTML({ title, subtitle, posterDataUri }) {
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html,body { width:1200px; height:630px; }
  body {
    font-family:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    letter-spacing:-0.014em; background:#fbfbfd; color:#16171a;
    -webkit-font-smoothing:antialiased; position:relative; overflow:hidden;
  }
  body::before {
    content:""; position:absolute; inset:0;
    background:
      radial-gradient(940px 460px at 12% -16%, rgba(94,106,210,0.16), transparent 60%),
      radial-gradient(760px 460px at 104% -8%, rgba(140,99,210,0.10), transparent 55%);
  }
  .wrap { position:relative; height:100%; display:grid; grid-template-columns:440px 1fr;
          align-items:center; gap:0; padding:64px 0 64px 64px; }
  .left { padding-right:40px; }
  .brand { display:flex; align-items:center; gap:12px; margin-bottom:30px; }
  .mark { width:46px; height:46px; border-radius:13px; display:grid; place-items:center;
          color:#fff; font-size:23px; font-weight:700; letter-spacing:-0.02em;
          background:linear-gradient(150deg,#828bf5,#5e6ad2 70%);
          box-shadow:0 0 0 1px rgba(255,255,255,0.25) inset,0 6px 18px rgba(94,106,210,0.42); }
  .brand span { font-size:18px; font-weight:600; color:#3a3f4b; }
  h1 { font-size:46px; line-height:1.06; font-weight:600; letter-spacing:-0.028em; }
  .sub { margin-top:16px; font-size:21px; line-height:1.35; font-weight:400; color:#5b626e; }
  .chip { display:inline-block; margin-top:30px; font-size:15px; font-weight:500;
          color:#5159c9; background:rgba(94,106,210,0.10); border:1px solid rgba(94,106,210,0.20);
          padding:7px 14px; border-radius:999px; }
  .frame { position:relative; height:498px; border-radius:16px 0 0 16px; overflow:hidden;
           background:#fff; border:1px solid rgba(16,17,26,0.10); border-right:none;
           box-shadow:0 40px 90px -36px rgba(16,24,40,0.42), 0 2px 6px rgba(16,24,40,0.05); }
  .bar { height:46px; display:flex; align-items:center; gap:9px; padding:0 18px;
         background:#f6f7f9; border-bottom:1px solid rgba(16,17,26,0.07); }
  .dot { width:12px; height:12px; border-radius:50%; }
  .shot { width:100%; height:calc(100% - 46px); object-fit:cover; object-position:top left; display:block; }
</style></head><body>
  <div class="wrap">
    <div class="left">
      <div class="brand"><div class="mark">P</div><span>Product Prototypes</span></div>
      <h1>${esc(title)}</h1>
      ${subtitle ? `<div class="sub">${esc(subtitle)}</div>` : ""}
      <div class="chip">Clickable prototype · GoVocal</div>
    </div>
    <div class="frame">
      <div class="bar"><div class="dot" style="background:#ff5f57"></div><div class="dot" style="background:#febc2e"></div><div class="dot" style="background:#28c840"></div></div>
      <img class="shot" src="${posterDataUri}">
    </div>
  </div>
</body></html>`;
}

async function makeCard(browser, dir) {
  const file = await entry(dir);
  const rel = path.relative(ROOT, dir);
  if (!file) { console.log("· skip (no html):", rel); return false; }
  const posterPath = path.join(dir, "preview.webp");
  if (!(await exists(posterPath))) { console.log("· skip (no poster — run shoot):", rel); return false; }

  const { title, subtitle } = await titleOf(file);
  const posterB64 = (await fs.readFile(posterPath)).toString("base64");
  const posterDataUri = `data:image/webp;base64,${posterB64}`;

  // 1× = the OG spec size (1200×630). Unfurl thumbnails render ~500px wide, so a
  // higher DPR only bloats the file (some bots time out on multi-MB images).
  const page = await browser.newPage({ viewport: OG, deviceScaleFactor: 1 });
  await page.setContent(cardHTML({ title, subtitle, posterDataUri }), { waitUntil: "load" });
  await page.waitForTimeout(500); // let webfont swap in
  // JPEG q85 keeps each committed card ~80–120KB (vs ~300KB PNG) — invisible on an
  // unfurl thumbnail, ~3× lighter in the repo as the prototype count grows.
  const out = path.join(dir, "og.jpg");
  await page.screenshot({ path: out, type: "jpeg", quality: 85, clip: { x: 0, y: 0, ...OG } });
  await page.close();
  const kb = Math.round((await fs.stat(out)).size / 1024);
  console.log("✓", rel + "/og.jpg", kb + "KB");
  return true;
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
