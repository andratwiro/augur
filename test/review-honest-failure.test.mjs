// A comment the server refused is not "added".
//
// The overlay used to catch every failed write, store the change in this browser's
// localStorage and say "Comment added". The comment then lived in one browser only:
// nobody else saw it, and the person believed it was sent. Refused deletes looked done.
// Local-only storage is right for exactly one case — a page with no server behind it,
// where the API has never answered — and these tests pin both sides of that line.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";

const SRC = fs.readFileSync(new URL("../src/review/comments.js", import.meta.url), "utf8");

let chromium = null;
try { ({ chromium } = await import("playwright")); } catch (e) { /* not installed: DOM tests skip */ }

// postStatus: what every POST answers. getStatus: what the boot GET answers.
async function serve({ getStatus = 200, postStatus = 200, threads = [] }) {
  const posts = [];
  let state = threads;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/__review/api") {
      if (req.method === "POST") {
        const body = await new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });
        const op = JSON.parse(body);
        posts.push(op);
        if (postStatus !== 200) { res.writeHead(postStatus); return res.end("{}"); }
        if (op.op === "add") state = [...state, op.thread];
        if (op.op === "delete") state = state.filter((t) => t.id !== op.id);
      } else if (getStatus !== 200) { res.writeHead(getStatus); return res.end("{}"); }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ threads: state }));
    }
    if (url.pathname === "/__review/comments.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      return res.end(SRC);
    }
    if (url.pathname === "/__me" || url.pathname === "/__people") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end("{}");
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><html><body><main><p id="target" style="margin:80px;padding:40px">a paragraph to comment on</p></main><script src="/__review/comments.js"></script></body></html>`);
  });
  await new Promise((r) => server.listen(0, r));
  return { port: server.address().port, posts, threads: () => state, close: () => server.close() };
}

// Shift+C, click the paragraph, type, press Enter. Returns what the person is left with.
async function comment(app, text) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const failed = [];
    await page.exposeFunction("__failed", (d) => failed.push(d));
    await page.addInitScript(() => {
      window.addEventListener("augur:action-failed", (e) => window.__failed(e.detail));
    });
    await page.goto(`http://127.0.0.1:${app.port}/`, { waitUntil: "load" });
    await page.waitForTimeout(300);
    await page.keyboard.press("Shift+C");
    await page.click("#target");
    await page.locator(".compose textarea.tx").fill(text);
    await page.locator(".compose textarea.tx").press("Enter");
    await page.waitForTimeout(600);
    const toast = await page.locator(".toast").textContent();
    const composerText = await page.locator(".compose textarea.tx").count()
      ? await page.locator(".compose textarea.tx").inputValue() : null;
    const local = await page.evaluate(() => localStorage.getItem("gv-review:/"));
    return { toast, composerText, local: JSON.parse(local || "[]"), failed };
  } finally {
    await browser.close();
  }
}

describe("a refused comment is never reported as added", { skip: !chromium && "playwright not installed" }, () => {
  for (const status of [500, 403, 401, 429]) {
    test(`POST answers ${status}: the person is told, the text stays, nothing is kept locally`, async () => {
      const app = await serve({ postStatus: status });
      try {
        const r = await comment(app, "the button is too small");
        assert.equal(app.posts.length, 1, "the overlay did try the server");
        assert.match(r.toast, /^Not saved/, `the toast must say it failed, got: ${r.toast}`);
        assert.doesNotMatch(r.toast, /Comment added/);
        assert.equal(r.composerText, "the button is too small", "the typed text must still be there to retry");
        assert.equal(r.local.length, 0, "a refused comment must not be parked in this browser's storage");
        assert.deepEqual(r.failed, [{ action: "comment.add", status }], "the failure is announced for the reporter");
      } finally { app.close(); }
    });
  }

  test("a server that works still says Comment added and stores it", async () => {
    const app = await serve({});
    try {
      const r = await comment(app, "looks good");
      assert.equal(r.toast, "Comment added");
      assert.equal(app.threads().length, 1);
      assert.equal(r.composerText, null, "the composer closes on success");
      assert.equal(r.failed.length, 0);
    } finally { app.close(); }
  });

  test("a page with no server at all (API 404 from the start) keeps comments locally, as before", async () => {
    const app = await serve({ getStatus: 404, postStatus: 404 });
    try {
      const r = await comment(app, "offline note");
      assert.equal(r.toast, "Comment added");
      assert.equal(r.local.length, 1, "static previews keep their comments in the browser");
      assert.equal(r.failed.length, 0);
    } finally { app.close(); }
  });
});
