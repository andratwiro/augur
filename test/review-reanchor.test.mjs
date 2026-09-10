// A comment survives the edit it asked for.
//
// Threads are pinned by a CSS path of tag names and :nth-of-type. Editing the page is what
// a comment is FOR, and most edits move the anchor without removing it — inserting one
// sibling shifts every index below it. The overlay used to read "the path no longer
// matches" as "the UI is gone" and DELETE the thread from the shared store, 2.2s after any
// plain page load, for every viewer. Acting on a comment destroyed it.
//
// These run the real overlay in a real browser against a local page and a fake threads API,
// because the bug was invisible to a source read: every function was individually correct.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";

const SRC = fs.readFileSync(new URL("../src/review/comments.js", import.meta.url), "utf8");

let chromium = null;
try { ({ chromium } = await import("playwright")); } catch (e) { /* not installed: DOM tests skip */ }

// One page, one threads API. Every op the overlay posts is recorded and applied, so the
// test sees exactly what the store would have seen.
async function serve(bodyHtml, threads) {
  const ops = [];
  let state = threads.map((t) => ({ resolved: false, messages: [], fx: 0.5, fy: 0.5, px: 0, py: 0, ...t }));
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/__review/api") {
      if (req.method === "POST") {
        const body = await new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });
        const op = JSON.parse(body);
        ops.push(op);
        if (op.op === "delete") state = state.filter((t) => t.id !== op.id);
        if (op.op === "move") state = state.map((t) => (t.id === op.id ? { ...t, sel: op.sel, fx: op.fx, fy: op.fy } : t));
      }
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
    res.end(`<!doctype html><html><body>${bodyHtml}<script src="/__review/comments.js"></script></body></html>`);
  });
  await new Promise((r) => server.listen(0, r));
  return { port: server.address().port, ops, threads: () => state, close: () => server.close() };
}

// Load the page and sit through the boot grace (1500ms) and the orphan timer (700ms) with
// no interaction whatsoever — the exact conditions under which comments vanished.
async function view(app) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${app.port}/`, { waitUntil: "load" });
  await page.waitForTimeout(3500);
  await browser.close();
}

describe("the review overlay re-anchors a comment before it will delete one", { skip: !chromium && "playwright not installed" }, () => {
  test("a sibling inserted above the anchor does not destroy the thread", async () => {
    // The comment was made on the second <div>. The edit inserts another <div> above it —
    // a banner image, say — so :nth-of-type counts one more of the same type and the stored
    // path now points at the WRONG element's index, while the block the person commented on
    // is still right there on the screen. (A different tag would not shift it: :nth-of-type
    // counts same-type siblings, which is why the real break came from a same-type insert.)
    const app = await serve(
      `<main><div>inserted by the edit</div><div>one</div><div id="target">two</div></main>`,
      [{ id: "t1", sel: "main>div:nth-of-type(3)>span", view: "/", screen: "", px: 40, py: 40,
         messages: [{ author: "Rob", body: "this bit" }] }],
    );
    try {
      await view(app);
      const ids = app.threads().map((t) => t.id);
      assert.deepEqual(ids, ["t1"], "the thread must survive an edit above its anchor");
      assert.equal(app.ops.some((o) => o.op === "delete"), false, "nothing may be deleted while an anchor is recoverable");
      const moved = app.ops.find((o) => o.op === "move" && o.id === "t1");
      assert.ok(moved, "the recovered anchor is written back, so it heals once and not every load");
      assert.notEqual(moved.sel, "main>div:nth-of-type(3)>span", "it must re-anchor, not re-save the dead path");
      assert.ok(app.threads()[0].fx >= 0 && app.threads()[0].fx <= 1, "the pin keeps a position inside its new anchor");
    } finally { app.close(); }
  });

  test("a thread whose page has nothing left to hold it is still removed", async () => {
    // Rob's rule: keep it in a similar-ish position if you can, otherwise remove it. Here
    // the path is unrecognisable AND the stored point is off-screen, so nothing can hold it.
    const app = await serve(
      `<main><p>only this</p></main>`,
      [{ id: "gone", sel: "section>article>span:nth-of-type(9)", view: "/", screen: "", px: 99999, py: 99999,
         messages: [{ author: "Rob", body: "about something deleted" }] }],
    );
    try {
      await view(app);
      assert.deepEqual(app.threads().map((t) => t.id), [], "an unrecoverable thread is an orphan and goes");
      assert.ok(app.ops.some((o) => o.op === "delete" && o.id === "gone"));
    } finally { app.close(); }
  });
});

test("cssPath stops at a unique id, so a later sibling insertion cannot shift the path", () => {
  const i = SRC.indexOf("function cssPath");
  const body = SRC.slice(i, i + 900);
  assert.match(body, /querySelectorAll\("#"/, "cssPath must check that an id is unique before trusting it");
  assert.match(body, /parts\.unshift\("#"/, "a unique id must end the path");
});

test("the orphan sweep deletes only what recoverAnchor could not place", () => {
  const i = SRC.indexOf("function isOrphan");
  assert.match(SRC.slice(i, i + 200), /resolvesHere/, "isOrphan still asks whether the page can hold the thread");
  const a = SRC.indexOf("function anchorOf");
  assert.match(SRC.slice(a, a + 200), /recoverAnchor/, "…and that question now means the full recovery ladder");
});
