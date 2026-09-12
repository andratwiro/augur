// The "we emailed you a code" screen submits ITSELF. Six digits is the whole intent — there
// is nothing left for a person to confirm — so the field fires the form the moment it holds
// six and the Sign in button goes away. The button stays in the markup for the one state
// where a person still has to press something: no script ran.
//
// Driven in a real browser, because every claim here is about events (input, paste, autofill)
// and about what CSS hides — none of which a string assertion can see.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { __testables as W } from "../src/_worker.js";

const tctx = {
  ACCOUNT_ORIGIN: "https://accounts.example.test",
  LOGIN_HINT: "", LOGIN_PREFILL_EMAIL: "", LOGIN_PREFILL_PASSWORD: "",
  SPACES: [], BRAND: null, tenantId: "code-screen",
};
const codeHtml = () => W.loginPage(tctx, "/", false, "https://acme.example/", { code: true, email: "member@example.test" });
const gateHtml = () => W.loginPage(tctx, "/", false, "https://acme.example/");

// ── the markup, without a browser ────────────────────────────────────────────

test("the code screen carries the script and the button, and nothing addressed to agents", () => {
  const html = codeHtml();
  assert.match(html, /id="code-form"/);
  assert.match(html, /class="submit">Sign in</, "the no-script fallback is still in the markup");
  assert.match(html, /className \+= " js"/, "the marker lands in <head>, before first paint");
  // The comment and the <meta> ride every render of this template and cost nothing; what is
  // absent here is the line a person would READ — nobody reaches this screen but a person
  // who just posted an address, so there is no agent here to address.
  assert.doesNotMatch(html, /Connecting an assistant/, "an agent cannot reach this screen — it follows a person's POST");
});

test("the gate still carries the door for a summarising fetch, out of sight", () => {
  const html = gateHtml();
  assert.match(html, /class="door visually-hidden">Connecting an assistant or a script\? It reads <a href="\/llms\.txt">/);
  assert.doesNotMatch(html, /aria-hidden="true"[^>]*>Connecting an assistant/, "aria-hidden would drop it from the extractors this line exists for");
});

// ── the same screen, in a browser ────────────────────────────────────────────

function browsersPath() {
  return process.env.PLAYWRIGHT_BROWSERS_PATH
    || [path.join(os.homedir(), "Library", "Caches", "ms-playwright"), path.join(os.homedir(), ".cache", "ms-playwright")].find((d) => fs.existsSync(d));
}

/** Serves the code screen and records the form POST the browser makes. */
async function server() {
  const posts = [];
  const srv = http.createServer((req, res) => {
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        posts.push({ path: req.url, form: Object.fromEntries(new URLSearchParams(body)) });
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<!doctype html><title>landed</title><p>landed</p>");
      });
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(codeHtml());
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { origin: `http://127.0.0.1:${srv.address().port}`, posts, close: () => new Promise((r) => srv.close(r)) };
}

test("six digits sign in by themselves; the button is not on screen", async (t) => {
  const browsers = browsersPath();
  if (browsers) process.env.PLAYWRIGHT_BROWSERS_PATH = browsers;
  let chromium;
  try { ({ chromium } = await import("playwright")); } catch (e) { t.skip("playwright not installed"); return; }
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip(`no browser: ${e.message.split("\n")[0]}`); return; }
  const srv = await server();
  try {
    const page = await browser.newPage();
    await page.goto(srv.origin);
    assert.equal(await page.locator("button.submit").isVisible(), false, "the button is hidden wherever the script runs");
    assert.equal(await page.locator("#checking").isVisible(), false);

    const landed = page.waitForURL(/__signin\/code$/, { waitUntil: "load" });
    await page.locator("#code").type("246948", { delay: 10 });
    await landed;
    assert.equal(await page.title(), "landed", "the form went without a click");
    assert.deepEqual(srv.posts.at(-1), { path: "/__signin/code", form: { email: "member@example.test", code: "246948" } });

    // Pasting the whole line out of the mail: the digits are taken out of it, not the first
    // six characters (which maxlength would otherwise leave as "Your c").
    const page2 = await browser.newPage();
    await page2.goto(srv.origin);
    const landed2 = page2.waitForURL(/__signin\/code$/, { waitUntil: "load" });
    await page2.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData("text", "Your code: 246948");
      document.getElementById("code").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await landed2;
    assert.equal(srv.posts.at(-1).form.code, "246948");

    // A five-digit code waits — and nothing is sent while it does.
    const sentBefore = srv.posts.length;
    const page3 = await browser.newPage();
    await page3.goto(srv.origin);
    await page3.locator("#code").type("24694", { delay: 10 });
    await page3.waitForTimeout(150);
    assert.equal(srv.posts.length, sentBefore, "five digits is not an intent to sign in");

    // No script: the button is the only way in, so it is on screen.
    const noJs = await browser.newContext({ javaScriptEnabled: false });
    const page4 = await noJs.newPage();
    await page4.goto(srv.origin);
    assert.equal(await page4.locator("button.submit").isVisible(), true);
  } finally {
    await browser.close();
    await srv.close();
  }
});
