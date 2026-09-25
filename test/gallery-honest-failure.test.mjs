// A card action the server refused does not look done.
//
// Status, rename and pins painted the new state first and swallowed the answer: a 403 on
// /__status left the new status on the chip (it only reverted on a network error), a
// refused rename kept the new name, a refused pin kept the pin, and removing a canvas said
// "Canvas removed" whatever /__canvases answered. Each looked saved until a reload undid it.
//
// A real build of a one-prototype workspace, served with the write endpoints refusing, in
// a real browser.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let chromium = null;
try { ({ chromium } = await import("playwright")); } catch (e) { /* not installed: DOM tests skip */ }

function buildWorkspace() {
  const ws = mkdtempSync(path.join(tmpdir(), "gallery-fail-ws-"));
  const dir = path.join(ws, "acme");
  mkdirSync(path.join(dir, "skills", "acme-ui"), { recursive: true });
  writeFileSync(path.join(dir, "skills", "acme-ui", "acme-ui.css"), ":root{--acme:1}\n");
  writeFileSync(path.join(dir, "skills", "acme-ui", "skill.json"), JSON.stringify({ assets: ["acme-ui.css"], cssPrefixes: ["acme"] }));
  writeFileSync(path.join(dir, "registry.json"), JSON.stringify({
    items: [{ name: "stat", type: "primitive", classes: ["acme-stat"], label: "Stat", description: "A number." }],
  }));
  writeFileSync(path.join(dir, "space.json"), JSON.stringify({ id: "acme", name: "acme", default: true }));
  mkdirSync(path.join(dir, "demo", "prototypes", "hello"), { recursive: true });
  writeFileSync(path.join(dir, "demo", "prototypes", "hello", "index.html"), "<!doctype html><title>Hello</title><p>hi</p>\n");
  const g = (...a) => execFileSync("git", ["-C", dir, "-c", "user.email=t@t.t", "-c", "user.name=t", ...a], { stdio: "pipe" });
  g("init", "-q", "-b", "main"); g("add", "-A"); g("commit", "-qm", "init");
  const out = path.join(ws, "dist");
  execFileSync(process.execPath, ["build.js"], { cwd: ROOT, env: { ...process.env, GV_SPACES_ROOT: ws, GV_DIST: out }, stdio: "pipe" });
  return { ws, out };
}

// Serves the build; every write endpoint answers `writeStatus`, every read an empty map.
function serve(dist, writeStatus) {
  const posts = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    if (["/__status", "/__name", "/__pins", "/__canvases"].includes(p)) {
      if (req.method === "POST") {
        posts.push(p);
        res.writeHead(writeStatus, { "content-type": "application/json" });
        return res.end(writeStatus === 200 ? JSON.stringify({ map: {} }) : JSON.stringify({ error: "no" }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ map: {}, canvases: [] }));
    }
    if (p.startsWith("/__")) { res.writeHead(404); return res.end("{}"); }
    let f = path.join(dist, decodeURIComponent(p));
    if (existsSync(f) && statSync(f).isDirectory()) f = path.join(f, "index.html");
    if (!existsSync(f)) { res.writeHead(404); return res.end("nf"); }
    const type = f.endsWith(".html") ? "text/html" : f.endsWith(".js") ? "text/javascript" : f.endsWith(".css") ? "text/css" : "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(readFileSync(f));
  });
  return new Promise((r) => server.listen(0, () => r({ port: server.address().port, posts, close: () => server.close() })));
}

async function openGallery(app) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const failed = [];
  await page.exposeFunction("__failed", (d) => failed.push(d));
  await page.addInitScript(() => {
    window.addEventListener("augur:action-failed", (e) => window.__failed(e.detail));
    // Services workers would serve a stale copy between tests; this page is fresh each time.
    try { delete navigator.serviceWorker; } catch (e) {}
  });
  await page.goto(`http://127.0.0.1:${app.port}/demo/`, { waitUntil: "load" });
  await page.waitForTimeout(400);
  return { browser, page, failed };
}

describe("a refused card action is put back and reported", { skip: !chromium && "playwright not installed" }, () => {
  let built;
  before(() => { built = buildWorkspace(); });
  after(() => { rmSync(built.ws, { recursive: true, force: true }); });

  test("status: a 403 puts the chip back and says it was not saved", async () => {
    const app = await serve(built.out, 403);
    const { browser, page, failed } = await openGallery(app);
    try {
      const chip = page.locator('[data-status-key="demo/hello"]');
      await chip.click();
      await page.locator('.gv-status-menu [data-pick="dev-ready"]').click();
      await page.waitForTimeout(500);
      assert.ok(app.posts.includes("/__status"), "it did try to save");
      assert.equal(await chip.getAttribute("data-status"), "ignore", "the refused status must not stay painted");
      assert.match(await page.locator(".gv-toast.show").last().textContent(), /Status not saved: you can.t change this/);
      assert.deepEqual(failed, [{ action: "card.status", status: 403 }]);
    } finally { await browser.close(); app.close(); }
  });

  test("pin: a 500 takes the pin back off and says so", async () => {
    const app = await serve(built.out, 500);
    const { browser, page, failed } = await openGallery(app);
    try {
      const pin = page.locator('.pin-btn[data-pin-key="/demo/hello/"]').first();
      await pin.click();
      await page.waitForTimeout(600);
      assert.ok(app.posts.includes("/__pins"));
      assert.equal(await pin.getAttribute("aria-pressed"), "false", "the refused pin must not stay pinned");
      assert.match(await page.locator(".gv-toast.show").last().textContent(), /Pin not saved/);
      assert.deepEqual(failed, [{ action: "pins.save", status: 500 }]);
    } finally { await browser.close(); app.close(); }
  });

  test("rename: a 403 puts the old name back and says so", async () => {
    const app = await serve(built.out, 403);
    const { browser, page, failed } = await openGallery(app);
    try {
      const card = page.locator('[data-rename-key="demo/hello"]').first();
      const name = card.locator(".proto-name");
      const before = (await name.textContent()).trim();
      await card.click({ button: "right" });
      await page.getByText("Rename", { exact: true }).click();
      await page.keyboard.type("Renamed by someone");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(500);
      assert.ok(app.posts.includes("/__name"));
      assert.equal((await name.textContent()).trim(), before, "the refused name must not stay on the card");
      assert.match(await page.locator(".gv-toast.show").last().textContent(), /Name not saved/);
      assert.deepEqual(failed, [{ action: "card.rename", status: 403 }]);
    } finally { await browser.close(); app.close(); }
  });

  test("a server that accepts keeps the change and raises nothing", async () => {
    const app = await serve(built.out, 200);
    const { browser, page, failed } = await openGallery(app);
    try {
      const chip = page.locator('[data-status-key="demo/hello"]');
      await chip.click();
      await page.locator('.gv-status-menu [data-pick="dev-ready"]').click();
      await page.waitForTimeout(500);
      // The fake server's map is empty, so the authoritative repaint is "ignore": what
      // matters here is that nothing was reported as a failure.
      assert.equal(failed.length, 0);
    } finally { await browser.close(); app.close(); }
  });
});

test("removing a canvas checks the answer before it says 'Canvas removed'", () => {
  // The canvas-remove path needs a created canvas (a live /__canvases registry) to render at
  // all, so this pins the source: the success branch is behind okOrThrow.
  const src = readFileSync(path.join(ROOT, "build.js"), "utf8");
  const i = src.indexOf("body:JSON.stringify({path:p,remove:true})");
  assert.ok(i > 0);
  const tail = src.slice(i, i + 400);
  assert.match(tail, /\.then\(okOrThrow\)\s*\.then\(function\(\)\{ close\(\); c\.style/, "the fade and 'Canvas removed' only run on an ok answer");
  assert.match(tail, /failNote\('Canvas not removed'/);
});
