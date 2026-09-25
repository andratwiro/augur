// The failure reporter in a real browser: it sends Augur's failures, never a prototype's own
// bugs, never more than its cap, and a refused comment arrives at /__report on its own.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";

const REPORTER = fs.readFileSync(new URL("../src/review/reporter.js", import.meta.url), "utf8");
const COMMENTS = fs.readFileSync(new URL("../src/review/comments.js", import.meta.url), "utf8");
let chromium = null;
try { ({ chromium } = await import("playwright")); } catch (e) { /* skip */ }

function serve(pageBody) {
  const reports = [];
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const body = await new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });
    if (u.pathname === "/__report") { reports.push(...JSON.parse(body)); res.writeHead(204); return res.end(); }
    if (u.pathname === "/__review/reporter.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(REPORTER); }
    if (u.pathname === "/__review/comments.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(COMMENTS); }
    if (u.pathname === "/__canvas/broken.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end("setTimeout(function(){ null.x; }, 50);"); }
    if (u.pathname === "/proto.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end("setTimeout(function(){ undefinedThing(); }, 50);"); }
    if (u.pathname === "/__review/api") {
      if (req.method === "POST") { res.writeHead(500); return res.end("{}"); }
      res.writeHead(200, { "content-type": "application/json" }); return res.end('{"threads":[]}');
    }
    if (u.pathname === "/__me" || u.pathname === "/__people") { res.writeHead(200, { "content-type": "application/json" }); return res.end("{}"); }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><html><body>${pageBody}</body></html>`);
  });
  return new Promise((r) => server.listen(0, () => r({ port: server.address().port, reports, close: () => server.close() })));
}

async function visit(app, fn) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${app.port}/opp/proto/`, { waitUntil: "load" });
    await page.waitForTimeout(300);
    if (fn) await fn(page);
    await page.waitForTimeout(2200); // the reporter batches for 1.5 s
  } finally { await browser.close(); }
}

describe("the failure reporter", { skip: !chromium && "playwright not installed" }, () => {
  test("Augur's own error is reported; a prototype's own error is not", async () => {
    const app = await serve(`<p>hi</p><script src="/__review/reporter.js"></script><script src="/__canvas/broken.js"></script><script src="/proto.js"></script>`);
    try {
      await visit(app);
      assert.equal(app.reports.length, 1, JSON.stringify(app.reports));
      assert.equal(app.reports[0].kind, "js-error");
      assert.equal(app.reports[0].src, "/__canvas/broken.js");
      assert.equal(app.reports[0].path, "/opp/proto/");
      assert.match(app.reports[0].tab, /^[a-z0-9]{4,10}$/);
    } finally { app.close(); }
  });

  test("a refused comment reaches /__report as comment.add 500", async () => {
    const app = await serve(`<main><p id="t" style="margin:80px;padding:40px">x</p></main><script src="/__review/reporter.js"></script><script src="/__review/comments.js"></script>`);
    try {
      await visit(app, async (page) => {
        await page.keyboard.press("Shift+C");
        await page.click("#t");
        await page.locator(".compose textarea.tx").fill("hello");
        await page.locator(".compose textarea.tx").press("Enter");
      });
      assert.deepEqual(app.reports.map((r) => [r.kind, r.action, r.status]), [["action-failed", "comment.add", 500]]);
    } finally { app.close(); }
  });

  test("never more than 20 reports from one page", async () => {
    const app = await serve(`<script src="/__review/reporter.js"></script>`);
    try {
      await visit(app, (page) => page.evaluate(() => {
        for (let i = 0; i < 50; i++) window.dispatchEvent(new CustomEvent("augur:action-failed", { detail: { action: "x", status: 1 } }));
      }));
      assert.equal(app.reports.length, 20);
    } finally { app.close(); }
  });
});
