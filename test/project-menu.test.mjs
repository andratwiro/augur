// A project card answers a right-click like a prototype card: Open, Copy link and, for an
// admin, Delete forever. No Rename (a project has no rename key).
//
// A real build's chrome in a real browser. The root gallery of a build does not carry the
// project hooks (only the derived gallery does, src/galleries.mjs), so the fake server
// stamps them on the folder card the way renderRootIndex writes them.
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
  const ws = mkdtempSync(path.join(tmpdir(), "project-menu-ws-"));
  const dir = path.join(ws, "acme");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "space.json"), JSON.stringify({ id: "acme", name: "acme", default: true }));
  mkdirSync(path.join(dir, "demo", "prototypes", "hello"), { recursive: true });
  writeFileSync(path.join(dir, "demo", "prototypes", "hello", "index.html"), "<!doctype html><title>Hello</title><p>hi</p>\n");
  const g = (...a) => execFileSync("git", ["-C", dir, "-c", "user.email=t@t.t", "-c", "user.name=t", ...a], { stdio: "pipe" });
  g("init", "-q", "-b", "main"); g("add", "-A"); g("commit", "-qm", "init");
  const out = path.join(ws, "dist");
  execFileSync(process.execPath, ["build.js"], { cwd: ROOT, env: { ...process.env, GV_SPACES_ROOT: ws, GV_DIST: out }, stdio: "pipe" });
  return { ws, out };
}

const HOOKS = '<div class="card-opp" data-del-kind="project" data-del-space="acme" data-del-path="demo" data-del-count="1"';

function serve(dist, deleteStatus) {
  const deletes = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    if (p === "/__delete" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        deletes.push({ ...JSON.parse(body), origin: req.headers.origin, type: req.headers["content-type"] });
        res.writeHead(deleteStatus, { "content-type": "application/json" });
        res.end(JSON.stringify(deleteStatus === 202 ? { ok: true, prototypes: 1, store: { removed: 1, version: 2 } } : { error: "no" }));
      });
      return;
    }
    if (p.startsWith("/__")) { res.writeHead(req.method === "GET" ? 200 : 404, { "content-type": "application/json" }); return res.end(JSON.stringify({ map: {} })); }
    let f = path.join(dist, decodeURIComponent(p));
    if (f !== dist && !f.startsWith(dist + path.sep)) { res.writeHead(403); return res.end("no"); }
    if (existsSync(f) && statSync(f).isDirectory()) f = path.join(f, "index.html");
    if (!existsSync(f)) { res.writeHead(404); return res.end("nf"); }
    const type = f.endsWith(".html") ? "text/html" : f.endsWith(".js") ? "text/javascript" : f.endsWith(".css") ? "text/css" : "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    if (p === "/") return res.end(readFileSync(f, "utf8").replace('<div class="card-opp"', HOOKS));
    res.end(readFileSync(f));
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ port: server.address().port, deletes, close: () => server.close() })));
}

async function openRoot(app, role) {
  const browser = await chromium.launch({ chromiumSandbox: true });
  const page = await browser.newPage();
  await page.addInitScript(() => { try { delete navigator.serviceWorker; } catch (e) {} });
  await page.goto(`http://127.0.0.1:${app.port}/`, { waitUntil: "load" });
  await page.waitForTimeout(400);
  // The role classes are PROFILE_JS's to set; pin them so the test says who is looking.
  await page.evaluate((r) => { const h = document.documentElement; h.classList.remove("gv-admin", "gv-operator"); if (r) h.classList.add(r); }, role);
  return { browser, page };
}
const items = (page) => page.locator(".gv-ctx button").allTextContents();

describe("the project card's right-click menu", { skip: !chromium && "playwright not installed" }, () => {
  let built;
  before(() => { built = buildWorkspace(); });
  after(() => { rmSync(built.ws, { recursive: true, force: true }); });

  test("an admin deletes a project: menu, confirm with the count, one POST, the card goes", async () => {
    const app = await serve(built.out, 202);
    const { browser, page } = await openRoot(app, "gv-admin");
    try {
      const card = page.locator('[data-del-kind="project"]');
      assert.equal(await card.count(), 1);
      await card.click({ button: "right" });
      assert.deepEqual(await items(page), ["Open", "Copy link", "Delete forever…"]);
      await page.locator(".gv-ctx .gv-ctx-danger").click();
      assert.match(await page.locator(".gv-modal__title").textContent(), /^Delete “Demo” forever\?$/);
      assert.equal(await page.locator(".gv-modal__body").textContent(), "This deletes the project and its 1 prototype from the live site for everyone.");
      assert.equal(app.deletes.length, 0, "nothing is sent before the confirm");
      await page.locator('.gv-modal [data-m="del"]').click();
      await page.waitForTimeout(600);
      assert.deepEqual(app.deletes, [{ space: "acme", path: "demo", origin: `http://127.0.0.1:${app.port}`, type: "application/json" }], "what the server's guard asks for is what the menu sends");
      assert.equal(await card.count(), 0, "the card is gone");
      assert.match(await page.locator(".gv-toast.show").last().textContent(), /^Deleted “Demo”$/);
    } finally { await browser.close(); app.close(); }
  });

  test("Cancel sends nothing and keeps the card", async () => {
    const app = await serve(built.out, 202);
    const { browser, page } = await openRoot(app, "gv-admin");
    try {
      const card = page.locator('[data-del-kind="project"]');
      await card.click({ button: "right" });
      await page.locator(".gv-ctx .gv-ctx-danger").click();
      await page.locator('.gv-modal [data-m="cancel"]').click();
      await page.waitForTimeout(200);
      assert.equal(app.deletes.length, 0);
      assert.equal(await card.count(), 1);
    } finally { await browser.close(); app.close(); }
  });

  test("someone who is not an admin gets Open and Copy link, and no Delete", async () => {
    const app = await serve(built.out, 202);
    const { browser, page } = await openRoot(app, "");
    try {
      await page.locator('[data-del-kind="project"]').click({ button: "right" });
      assert.deepEqual(await items(page), ["Open", "Copy link"]);
    } finally { await browser.close(); app.close(); }
  });

  test("a refused delete keeps the card and says so", async () => {
    const app = await serve(built.out, 403);
    const { browser, page } = await openRoot(app, "gv-admin");
    try {
      const card = page.locator('[data-del-kind="project"]');
      await card.click({ button: "right" });
      await page.locator(".gv-ctx .gv-ctx-danger").click();
      await page.locator('.gv-modal [data-m="del"]').click();
      await page.waitForTimeout(600);
      assert.equal(await card.count(), 1);
      assert.match(await page.locator(".gv-toast.show").last().textContent(), /Only admins can delete projects/);
    } finally { await browser.close(); app.close(); }
  });
});
