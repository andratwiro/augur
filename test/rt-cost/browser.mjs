/* Two real browser tabs, the real canvas client, the real room.
 *
 *   node test/rt-cost/browser.mjs --minutes 5
 *
 * measure.mjs replays what the client sends. This runs the client itself: Chromium loads
 * src/canvas/canvas.js off a page byte-identical to the one the worker serves, and a real
 * pointer drags a real node while a real keyboard types into another. The room on the far
 * end is the same instrumented one, so the residency arithmetic is the same arithmetic.
 *
 * It exists to check the replay rather than to replace it. The replay's cadence is read
 * out of the client's source; this reads it off the wire (`framesent`), and the two
 * numbers are reported next to each other. If they disagree, the replay is wrong and
 * every number derived from it is wrong with it.
 *
 * The scaffolding around the page is deliberately thin — the four endpoints the client
 * boots against, and a raw upgrade proxy for /__rt. Nothing here is a second
 * implementation of the site worker; it is the smallest thing canvas.js will boot on.
 */
import { createServer } from "node:http";
import { connect } from "node:net";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeLedger, startLocalRuntime, activeMs, tally, saveResult, saveLedger, sleep, round } from "./ledger.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const RESULTS = resolve(HERE, "results");
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const RT_PORT = Number(opt("rt-port", 8809));
const WEB_PORT = Number(opt("web-port", 8810));
const MINUTES = Number(opt("minutes", 5));
const GRACE_MS = Number(opt("grace-ms", 3000)); // measured: test/rt-cost/results/grace.json
const BOARD = "/board/rt-cost-" + Date.now();

let playwright;
try { playwright = await import("playwright"); }
catch (e) { console.error("playwright is not installed here — `npm install` in this checkout first"); process.exit(2); }

// ---- the smallest page canvas.js will boot on ----------------------------
const file = (p) => readFileSync(resolve(ROOT, p));
const boards = new Map();
function loaderPage(name) {
  // The same four lines src/_worker.js:canvasLoaderPage emits.
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="stylesheet" href="/__canvas/canvas.css" />
<script>window.GV_CANVAS = ${JSON.stringify({ name })};</script>
<title>${name}</title></head><body>
<script src="/__canvas/canvas.js" defer></script></body></html>`;
}
const web = createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  const send = (code, type, body) => { res.writeHead(code, { "content-type": type, "cache-control": "no-store" }); res.end(body); };
  if (u.pathname === "/__canvas/canvas.js") return send(200, "text/javascript", file("src/canvas/canvas.js"));
  if (u.pathname === "/__canvas/canvas.css") return send(200, "text/css", file("src/canvas/canvas.css"));
  if (u.pathname === "/__canvas/catalog.json" || u.pathname === "/__canvas/tracks.json") return send(200, "application/json", "[]");
  if (u.pathname === "/__me") {
    // Each browser context carries its own cookie jar, which is how two tabs on one
    // origin get two identities without two origins.
    const who = /(?:^|;\s*)who=([^;]+)/.exec(req.headers.cookie || "");
    return send(200, "application/json", JSON.stringify({ accounts: true, user: { name: who ? decodeURIComponent(who[1]) : "Guest" } }));
  }
  if (u.pathname === "/__board") {
    const key = u.searchParams.get("path") || "";
    if (req.method === "POST") {
      let b = ""; req.on("data", (c) => { b += c; });
      return req.on("end", () => { try { boards.set(key, JSON.parse(b).doc); } catch (e) {} send(200, "application/json", '{"ok":true}'); });
    }
    return send(200, "application/json", JSON.stringify({ doc: boards.get(key) || null }));
  }
  if (u.pathname.startsWith("/board/")) return send(200, "text/html; charset=utf-8", loaderPage("Cost board"));
  send(404, "text/plain", "not here");
});
// /__rt is a WebSocket upgrade, and an upgrade cannot be proxied with fetch(): the reply
// is a 101 and a socket, not a body. Rewriting the request line and piping the two TCP
// streams is the whole of it, and it is what the site worker's rtProxy does in effect.
web.on("upgrade", (req, socket, head) => {
  const u = new URL(req.url, "http://127.0.0.1");
  if (u.pathname !== "/__rt") return socket.destroy();
  const up = connect(RT_PORT, "127.0.0.1", () => {
    let head_ = `GET /room${u.search} HTTP/1.1\r\nHost: 127.0.0.1:${RT_PORT}\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (req.rawHeaders[i].toLowerCase() === "host") continue;
      head_ += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    up.write(head_ + "\r\n");
    if (head && head.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});

// ---- drive ---------------------------------------------------------------
const ledger = makeLedger();
let rt = null, browser = null;
async function main() {
  rt = await startLocalRuntime({ cwd: ROOT, config: "test/rt-cost/wrangler.toml", port: RT_PORT, ledger });
  await new Promise((r) => web.listen(WEB_PORT, "127.0.0.1", r));
  browser = await playwright.chromium.launch();

  const tabs = [];
  for (const who of ["Ana", "Ben"]) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    await ctx.addCookies([{ name: "who", value: who, url: `http://127.0.0.1:${WEB_PORT}` }]);
    const page = await ctx.newPage();
    const frames = { total: 0, ping: 0, cursor: 0, ops: 0, view: 0, other: 0, at: [] };
    page.on("websocket", (ws) => {
      ws.on("framesent", (f) => {
        const p = String(f.payload || "");
        frames.total++;
        frames.at.push(Date.now());
        if (p === "ping") frames.ping++;
        else { const t = (p.match(/"t":"(\w+)"/) || [])[1]; frames[t === "cursor" || t === "ops" || t === "view" ? t : "other"]++; }
      });
    });
    page.on("pageerror", (e) => console.log("  page error:", String(e).slice(0, 160)));
    await page.goto(`http://127.0.0.1:${WEB_PORT}${BOARD}`);
    await page.waitForFunction(() => window.__GV_CANVAS_BOOTED === true, null, { timeout: 20000 });
    tabs.push({ who, page, frames });
  }
  // Both sockets have to be in the room before the clock starts, or the first minute
  // measures a join rather than a session.
  await sleep(4000);
  console.log(`browser: two tabs on ${BOARD}, ${MINUTES} min`);

  const mark = ledger.records.length;
  const t0 = Date.now();
  const until = t0 + MINUTES * 60000;
  await Promise.all(tabs.map((t, i) => drive(t, i, until)));
  const t1 = Date.now();
  const rs = ledger.records.slice(mark);

  const act = activeMs(rs, GRACE_MS);
  const wall = t1 - t0;
  const out = {
    runtime: "local wrangler dev (workerd), driven by two real Chromium tabs running src/canvas/canvas.js",
    at: new Date().toISOString(),
    scenario: "browser",
    question: "does a real client cost what the replayed one costs?",
    board: BOARD,
    people: 2,
    wallClockMs: wall,
    framesSentByTheRealClient: Object.fromEntries(tabs.map((t) => [t.who, {
      total: t.frames.total, ping: t.frames.ping, cursor: t.frames.cursor, ops: t.frames.ops, view: t.frames.view, other: t.frames.other,
      perSecond: round(t.frames.total / (wall / 1000), 2),
    }])),
    events: rs.length,
    kinds: tally(rs),
    ...act,
    awakeMinPerRoomHour: round(act.awakeMs / 60000 / (wall / 3600000)),
    awakeMinPerPersonHour: round(act.awakeMs / 60000 / ((wall * 2) / 3600000)),
    awakeFraction: round(act.awakeMs / wall, 3),
  };
  saveResult(RESULTS, "browser", out);
  saveLedger(RESULTS, "ledger-browser", { scenario: "browser", graceMs: GRACE_MS }, ledger.records);
  console.log("\n" + JSON.stringify({ ...out, windows: undefined }, null, 2));
}

// A person, in real input events. Gestures and pauses come from the same profile
// measure.mjs states, so the two runs are comparable.
function mulberry(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
async function drive(tab, i, until) {
  const rnd = mulberry(11 + i * 18);
  const span = (lo, hi) => lo + rnd() * (hi - lo);
  const { page } = tab;
  const id = "b" + i;
  await page.evaluate(([id, x]) => window.GVCanvas.addNode({ id, type: "text", x, y: 260, w: 220, h: 90, text: "note", color: "#ffd43b" }), [id, 300 + i * 320]);
  await sleep(500);
  let k = 0;
  while (Date.now() < until) {
    const box = await page.evaluate((id) => {
      const el = document.querySelector(`.gvc-node[data-id="${id}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, id);
    const ms = span(2, 6) * 1000;
    if (box && rnd() < 0.6) {
      // A REAL drag: press, move on a pointer cadence, release.
      await page.mouse.move(box.x, box.y);
      await page.mouse.down();
      const end = Date.now() + ms;
      let step = 0;
      while (Date.now() < end) {
        step++;
        await page.mouse.move(box.x + Math.sin(step / 6) * 120, box.y + Math.cos(step / 7) * 90);
        await sleep(16); // ~60Hz pointer input, which the client throttles to 20Hz on the wire
      }
      await page.mouse.up();
    } else {
      // A REAL edit: click into the node and type.
      if (box) { await page.mouse.dblclick(box.x, box.y); }
      const end = Date.now() + ms;
      while (Date.now() < end) { await page.keyboard.type("x", { delay: 0 }); await sleep(60); }
      await page.keyboard.press("Escape");
    }
    k++;
    const think = span(3, 20) * 1000;
    await sleep(Math.min(think, Math.max(0, until - Date.now())));
  }
  tab.gestures = k;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    try { if (browser) await browser.close(); } catch (e) {}
    try { web.close(); } catch (e) {}
    try { if (rt) rt.kill("SIGTERM"); } catch (e) {}
    setTimeout(() => process.exit(process.exitCode || 0), 1500);
  });
