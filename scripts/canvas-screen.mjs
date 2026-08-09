#!/usr/bin/env node
// canvas-screen — scaffold a prototype that is OWNED BY a canvas.
//
// The model (see augur/CANVAS.md "Canvas-owned prototypes"): a canvas is a container.
// "Build a prototype on the canvas" = create a real prototype in a SUBFOLDER of the canvas
// (`<opp>/prototypes/<canvas>/<slug>/index.html`, ships at `/<opp>/<canvas>/<slug>/`) AND
// place a tile for it on that canvas's board. The screen is OWNED by the canvas: removing it
// from the canvas deletes the folder too — gone in general, not merely unlinked. (A tile that
// points at some pre-existing top-level prototype, added via the in-app picker, is a mere
// REFERENCE — this tool never touches those.)
//
// Because a canvas can't write git from the browser, that create/remove coupling is enforced
// HERE, in the terminal, by whoever authors the prototype (you + an agent). Use:
//   node scripts/canvas-screen.mjs add <canvasUrl> <slug> [--title "Nice Title"]
//   node scripts/canvas-screen.mjs rm  <canvasUrl> <slug>
//   node scripts/canvas-screen.mjs ls  <canvasUrl>
//   node scripts/canvas-screen.mjs gc  <canvasUrl>
// e.g. node scripts/canvas-screen.mjs add /ux-ui-audit/canvas/ voting-screen --title "Voting"
//
// `gc` is the browser half of the remove coupling: deleting a tile IN THE CANVAS UI can't
// delete the folder (no git in the browser), so the folder lingers as an orphan. gc notices
// orphans and deletes their folders after a ONE-HOUR grace window (to cover a
// ⌘Z that brings the tile back) anchored at the first gc run that saw the orphan. Run it
// whenever you start working a canvas; state lives in godmode/.canvas-gc.json (local only).
//
// `add`/`rm` touch two things: the FILES (in the space repo, which you then commit + push) and
// the canvas BOARD — written THROUGH the multiplayer room as per-node ops (takes effect
// live, and can't be clobbered by the room's own KV persistence). After `add`, write the
// real prototype into the created index.html, then commit + push the space repo.

import { readdirSync, existsSync, readFileSync, mkdirSync, writeFileSync, rmSync, cpSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");   // augur/
const PARENT = path.join(ROOT, "..");                                           // god-mode container
const SITE = process.env.CANVAS_SITE_ORIGIN || process.env.REVIEW_SITE_URL || "";
if (!SITE) {
  console.error("canvas-screen: set CANVAS_SITE_ORIGIN (or REVIEW_SITE_URL) to the deployed site origin, e.g. https://<project>.pages.dev");
  process.exit(1);
}

// ---- space resolution: map a canvas URL to its space repo + on-disk prototype dir ----------
function spaces() {
  // sibling dirs carrying a space.json (same rule build.js/offline use)
  return readdirSync(PARENT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && existsSync(path.join(PARENT, e.name, "space.json")))
    .map((e) => {
      let meta = {};
      try { meta = JSON.parse(readFileSync(path.join(PARENT, e.name, "space.json"), "utf8")); } catch {}
      return { dir: path.join(PARENT, e.name), id: meta.id || e.name, isDefault: !!meta.default };
    });
}

// canvasUrl: "/ux-ui-audit/canvas/" (default space) or "/<spaceid>/<opp>/<canvas>/" (non-default)
function resolve(canvasUrl) {
  const segs = String(canvasUrl).replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  if (segs.length < 2) throw new Error(`canvas URL needs at least <opp>/<canvas>: got "${canvasUrl}"`);
  const sp = spaces();
  const named = sp.find((s) => !s.isDefault && s.id === segs[0]);
  const space = named || sp.find((s) => s.isDefault) || sp[0];
  if (!space) throw new Error("no space repo found (need a sibling dir with space.json)");
  const rest = named ? segs.slice(1) : segs;             // drop the space-id prefix if present
  if (rest.length < 2) throw new Error(`expected <opp>/<canvas> after the space, got "${rest.join("/")}"`);
  const [opp, canvas] = rest;
  const canvasDir = path.join(space.dir, opp, "prototypes", canvas);
  if (!existsSync(path.join(canvasDir, "index.html")))
    throw new Error(`no canvas at ${path.relative(PARENT, canvasDir)} (its index.html must exist first)`);
  const boardPath = "/" + rest.join("/") + "/";          // KV board key path is the CANVAS url (space-prefixed on live via the URL you pass)
  return { space, opp, canvas, canvasDir, canvasUrl: (named ? "/" + segs.join("/") : "/" + rest.join("/")) + "/", boardPath: (named ? "/" + segs.join("/") : "/" + rest.join("/")) + "/" };
}

// ---- board mutations — THROUGH THE ROOM, never a raw KV overwrite --------------------------
// Since 2026-07-27 the BoardRoom DO persists the doc itself while anyone is on the board, so
// a direct POST /__board would be silently clobbered by the room's next write. The correct
// write path for every out-of-band tool is the same one the engine uses: join the room, send
// per-node ops, let the room fold them into the live doc and persist. When the room is empty
// this still works — the one-shot client seeds it from KV, ops apply, and the room flushes to
// KV when the client (last one out) disconnects.
import { ClawdCanvas } from "./clawd-canvas.mjs";
async function getBoard(canvasUrl) {
  const r = await fetch(`${SITE}/__board?path=${encodeURIComponent(canvasUrl)}`);
  const j = await r.json().catch(() => ({}));
  return j.doc || { v: 1, name: "Untitled canvas", view: { x: 0, y: 0, scale: 1 }, nodes: [] };
}
// apply(doc) mutates a COPY of the live doc into the desired state; we then diff copy vs live
// and send the difference as upsert/del ops. Returns the room's resulting doc.
async function mutateBoard(boardPath, apply, confirm, label) {
  const c = new ClawdCanvas({ boardPath, name: "canvas-screen" });
  try {
    await c.connect();
    const before = JSON.parse(JSON.stringify(c.doc));
    const desired = JSON.parse(JSON.stringify(c.doc));
    desired.nodes = desired.nodes || [];
    apply(desired);
    const beforeIds = new Set((before.nodes || []).map((n) => n.id));
    const desiredIds = new Set(desired.nodes.map((n) => n.id));
    for (const n of desired.nodes) {
      const old = (before.nodes || []).find((o) => o.id === n.id);
      if (!old || JSON.stringify(old) !== JSON.stringify(n)) c.upsert(n);
    }
    for (const id of beforeIds) if (!desiredIds.has(id)) c.del(id);
    await new Promise((r) => setTimeout(r, 600)); // let the ops land in the room
    const ok = confirm(c.doc);
    if (!ok) console.warn(`⚠ board ${label}: ops sent but end state not confirmed in the room doc.`);
    return ok;
  } finally {
    try { c.close(); } catch {}
  }
}
const uid = () => "n" + Math.random().toString(36).slice(2, 9);

// place a new tile clear of existing nodes: to the right of the rightmost, aligned to the top
function placeRightOf(nodes, w, h) {
  const boxes = nodes.filter((n) => n.type !== "arrow" && typeof n.x === "number");
  if (!boxes.length) return { x: -w / 2, y: -h / 2 };
  const right = Math.max(...boxes.map((n) => n.x + (n.w || 240)));
  const top = Math.min(...boxes.map((n) => n.y));
  return { x: right + 60, y: top };
}

// The meta description is the screen's agent-facing meaning — one line stating the CLAIM
// the prototype makes (not what it looks like). The artifact owns it: update it in the
// same commit that changes the prototype. `ls` flags screens where it's missing/empty.
const escAttr = (s) => String(s || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const STARTER = (title, desc) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="description" content="${escAttr(desc)}" />
<title>${title}</title>
<style>
  body { margin: 0; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1a1a1a; }
  .wrap { min-height: 100vh; display: grid; place-items: center; padding: 40px; box-sizing: border-box; text-align: center; background: #f4f5f7; }
  h1 { margin: 0 0 8px; font-size: 22px; }
  p { margin: 0; color: #6b7280; }
</style>
</head>
<body>
  <div class="wrap">
    <div>
      <h1>${title}</h1>
      <p>Scaffolded canvas screen — replace this with the real prototype.</p>
    </div>
  </div>
</body>
</html>
`;

// ---- commands ------------------------------------------------------------------------------
async function cmdAdd(canvasUrl, slug, title, desc) {
  const { space, canvasDir, boardPath } = resolve(canvasUrl);
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error("slug must be lowercase [a-z0-9-]");
  const screenDir = path.join(canvasDir, slug);
  const url = boardPath + slug + "/";
  const name = title || slug;
  if (!existsSync(screenDir)) {
    mkdirSync(screenDir, { recursive: true });
    writeFileSync(path.join(screenDir, "index.html"), STARTER(name, desc));
    console.log(`✓ created ${path.relative(PARENT, path.join(screenDir, "index.html"))}`);
    if (!desc) console.log(`  ⚠ no --desc — fill the <meta name="description"> when you write the real prototype (ls flags opaque screens)`);
  } else {
    console.log(`• folder exists, keeping its index.html`);
  }
  const hasTile = (d) => (d.nodes || []).some((n) => n.type === "tile" && n.url === url);
  await mutateBoard(boardPath, (d) => {
    if (hasTile(d)) return;
    const w = 560, h = 360, { x, y } = placeRightOf(d.nodes, w, h);
    d.nodes.push({ id: uid(), type: "tile", x, y, w, h, url, name });
  }, hasTile, "add-tile");
  console.log(`✓ tile "${name}" → ${url} is on the canvas board`);
  console.log(`\nNext: write the real prototype into that index.html, then commit + push the ${path.basename(space.dir)} repo.`);
  console.log(`Lives at ${SITE}${url} once deployed.`);
}

async function cmdRm(canvasUrl, slug) {
  const { canvasDir, boardPath } = resolve(canvasUrl);
  const screenDir = path.join(canvasDir, slug);
  const url = boardPath + slug + "/";
  // 1) remove the tile from the board (retry through KV consistency until it's confirmed gone)
  const gone = (d) => !(d.nodes || []).some((n) => n.type === "tile" && n.url === url);
  await mutateBoard(boardPath, (d) => { d.nodes = (d.nodes || []).filter((n) => !(n.type === "tile" && n.url === url)); }, gone, "remove-tile");
  console.log(`✓ tile ${url} removed from the board`);
  // 2) delete the folder — owned-by-the-canvas means removing it deletes it in general
  if (existsSync(screenDir)) { rmSync(screenDir, { recursive: true, force: true }); console.log(`✓ deleted ${path.relative(PARENT, screenDir)}`); }
  else console.log(`• folder ${path.relative(PARENT, screenDir)} did not exist`);
  console.log(`\nNext: commit + push the space repo so the deletion ships.`);
}


// Fork a canvas-owned screen: copy its folder to a new slug and point the DUPLICATE tile at
// it. This is the terminal half of "duplicate the tile ⇒ duplicate the folder": Cmd+D on the
// canvas clones only the tile (the browser can't write git), so both tiles briefly share one
// folder; before editing "the copy", run dup — it repoints the duplicate (by --tile name, or
// the one named "… copy", or the last sharer) at the fresh fork. If no duplicate tile exists
// yet it places a new one beside the source.
async function cmdDup(canvasUrl, srcSlug, newSlug, title, tileName) {
  const { space, canvasDir, boardPath } = resolve(canvasUrl);
  if (!/^[a-z0-9-]+$/.test(newSlug || "")) throw new Error("new slug must be lowercase [a-z0-9-]");
  const srcDir = path.join(canvasDir, srcSlug), newDir = path.join(canvasDir, newSlug);
  if (!existsSync(path.join(srcDir, "index.html"))) throw new Error(`no owned screen at ${srcSlug}`);
  if (existsSync(newDir)) throw new Error(`${newSlug} already exists`);
  cpSync(srcDir, newDir, { recursive: true });
  console.log(`✓ forked ${path.relative(PARENT, srcDir)} → ${path.relative(PARENT, newDir)}`);
  const srcUrl = boardPath + srcSlug + "/", newUrl = boardPath + newSlug + "/";
  const name = title || newSlug;
  const done = (d) => (d.nodes || []).some((n) => n.type === "tile" && n.url === newUrl);
  await mutateBoard(boardPath, (d) => {
    if (done(d)) return;
    const sharers = d.nodes.filter((n) => n.type === "tile" && n.url === srcUrl);
    let dupe = tileName ? sharers.find((n) => n.name === tileName) : null;
    if (!dupe && sharers.length > 1) dupe = sharers.find((n) => / copy$/.test(n.name || "")) || sharers[sharers.length - 1];
    if (dupe) { dupe.url = newUrl; dupe.name = name; delete dupe.liveUrl; delete dupe.thumb; }
    else {
      const src = sharers[0] || { x: 0, y: 0, w: 560, h: 360 };
      d.nodes.push({ id: uid(), type: "tile", x: (src.x || 0) + 48, y: (src.y || 0) + 48, w: src.w || 560, h: src.h || 360, url: newUrl, name });
    }
  }, done, "fork-tile");
  console.log(`✓ tile "${name}" → ${newUrl} on the board`);
  console.log(`\nNext: edit the fork (${path.relative(PARENT, newDir)}), then commit + push the ${path.basename(space.dir)} repo.`);
  console.log(`The fork inherits the source's <meta name="description"> — update it when the fork diverges.`);
}

// Pull a screen's <meta name="description"> — its agent-facing meaning. Null = opaque.
function screenDesc(dir) {
  try {
    const html = readFileSync(path.join(dir, "index.html"), "utf8");
    // exclude only the active delimiter — [^"'] would truncate at an inner apostrophe
    const m = html.match(/<meta\s+name=["']description["']\s+content="([^"]*)"/i)
      || html.match(/<meta\s+name=["']description["']\s+content='([^']*)'/i)
      || html.match(/<meta\s+content="([^"]*)"\s+name=["']description["']/i)
      || html.match(/<meta\s+content='([^']*)'\s+name=["']description["']/i);
    return m && m[1].trim() ? m[1].trim() : null;
  } catch { return null; }
}

async function cmdLs(canvasUrl) {
  const { canvasDir, boardPath } = resolve(canvasUrl);
  const folders = readdirSync(canvasDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(canvasDir, e.name, "index.html")))
    .map((e) => e.name);
  const doc = await getBoard(boardPath);
  const tileUrls = new Set((doc.nodes || []).filter((n) => n.type === "tile").map((n) => n.url));
  console.log(`Canvas ${boardPath} — owned screens (nested folders) vs board tiles:\n`);
  for (const f of folders) {
    const url = boardPath + f + "/";
    const desc = screenDesc(path.join(canvasDir, f));
    console.log(`  ${tileUrls.has(url) ? "●" : "○ (folder, no tile — orphaned)"}  ${f}  → ${url}`);
    console.log(`      ${desc ? `"${desc}"` : "⚠ no meta description — opaque to agents"}`);
  }
  if (folders.some((f) => !tileUrls.has(boardPath + f + "/")))
    console.log(`\n  → orphaned folders are meant to disappear: run \`canvas-screen gc ${boardPath}\` (1h grace for undo)`);
  // tiles pointing under this canvas but with no folder = a dangling tile
  for (const n of (doc.nodes || []).filter((n) => n.type === "tile" && n.url && n.url.startsWith(boardPath) && n.url !== boardPath)) {
    const slug = n.url.slice(boardPath.length).replace(/\/$/, "");
    if (!folders.includes(slug)) console.log(`  ⚠ tile with no folder: ${n.url} (dangling)`);
  }
  if (!folders.length) console.log("  (no owned screens yet)");
  // the board's other opaque nodes: images without a desc field
  const blind = (doc.nodes || []).filter((n) => n.type === "image" && !(n.desc && String(n.desc).trim()));
  if (blind.length) {
    console.log(`\n  ⚠ ${blind.length} image node(s) without desc (opaque to agents):`);
    for (const n of blind) console.log(`      ${n.name || n.id}`);
  }
}

// Orphan garbage collection: a screen folder whose tile was deleted in the canvas UI is
// meant to DISAPPEAR (ownership coupling), but not instantly — a 1h grace covers undo.
// Grace is anchored at the first gc observation (the board doc carries no deletion times),
// so deletion happens at the first gc run at least an hour after an orphan was noticed.
const GC_GRACE_MS = 60 * 60 * 1000;
const GC_STATE = path.join(PARENT, "godmode", ".canvas-gc.json");
async function cmdGc(canvasUrl) {
  const { space, canvasDir, boardPath } = resolve(canvasUrl);
  const folders = readdirSync(canvasDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(canvasDir, e.name, "index.html")))
    .map((e) => e.name);
  const doc = await getBoard(boardPath);
  const tileUrls = new Set((doc.nodes || []).filter((n) => n.type === "tile").map((n) => n.url));
  let state = {};
  try { state = JSON.parse(readFileSync(GC_STATE, "utf8")); } catch {}
  const now = Date.now();
  const deleted = [];
  for (const f of folders) {
    const url = boardPath + f + "/";
    if (tileUrls.has(url)) {
      if (state[url]) { delete state[url]; console.log(`● ${f}: tile is back on the board, grace cleared`); }
      continue;
    }
    if (!state[url]) {
      state[url] = now;
      console.log(`○ ${f}: orphaned (no tile) — noticed now, deleting after a 1h grace (rerun gc later)`);
    } else if (now - state[url] >= GC_GRACE_MS) {
      rmSync(path.join(canvasDir, f), { recursive: true, force: true });
      delete state[url];
      deleted.push(f);
      console.log(`✗ ${f}: grace expired, folder deleted`);
    } else {
      console.log(`○ ${f}: orphaned, ${Math.ceil((GC_GRACE_MS - (now - state[url])) / 60000)}m of grace left`);
    }
  }
  // stamps whose folder is gone (deleted here or by hand) are spent
  for (const url of Object.keys(state)) {
    if (!url.startsWith(boardPath)) continue;
    const slug = url.slice(boardPath.length).replace(/\/$/, "");
    if (!folders.includes(slug) || deleted.includes(slug)) delete state[url];
  }
  mkdirSync(path.dirname(GC_STATE), { recursive: true });
  writeFileSync(GC_STATE, JSON.stringify(state, null, 1));
  if (!folders.length) console.log("(no owned screens)");
  if (deleted.length) console.log(`\nNext: commit + push the ${path.basename(space.dir)} repo so the deletion ships.`);
}

// ---- cli -----------------------------------------------------------------------------------
const [cmd, canvasUrl, slug] = process.argv.slice(2);
const titleIdx = process.argv.indexOf("--title");
const title = titleIdx > -1 ? process.argv[titleIdx + 1] : "";
try {
  const tileIdx = process.argv.indexOf("--tile");
  const tileName = tileIdx > -1 ? process.argv[tileIdx + 1] : "";
  const descIdx = process.argv.indexOf("--desc");
  const desc = descIdx > -1 ? process.argv[descIdx + 1] : "";
  if (cmd === "add" && canvasUrl && slug) await cmdAdd(canvasUrl, slug, title, desc);
  else if (cmd === "dup" && canvasUrl && slug && process.argv[5] && !process.argv[5].startsWith("--")) await cmdDup(canvasUrl, slug, process.argv[5], title, tileName);
  else if (cmd === "rm" && canvasUrl && slug) await cmdRm(canvasUrl, slug);
  else if (cmd === "ls" && canvasUrl) await cmdLs(canvasUrl);
  else if (cmd === "gc" && canvasUrl) await cmdGc(canvasUrl);
  else {
    console.log("usage:\n  canvas-screen add <canvasUrl> <slug> [--title \"T\"] [--desc \"one-line claim the screen makes\"]\n  canvas-screen dup <canvasUrl> <srcSlug> <newSlug> [--title \"T\"] [--tile \"Dup tile name\"]\n  canvas-screen rm  <canvasUrl> <slug>\n  canvas-screen ls  <canvasUrl>  (also flags opaque screens/images — no description)\n  canvas-screen gc  <canvasUrl>  (delete folders orphaned by in-canvas tile deletion, 1h grace)");
    process.exit(1);
  }
} catch (e) { console.error("✗ " + e.message); process.exit(1); }
