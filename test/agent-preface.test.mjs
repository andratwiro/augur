// A prototype fetched by something that is not a browser opens with the door.
//
// Two of four cold agents, handed a public prototype's URL, fetched the page and found a
// finished site with nothing on it about how it is edited — the customer's HTML, never the
// gate — and told the person to ask a developer. The `Link` header reaches a scripted
// agent; a summarising fetch keeps only the text. So a fetch with no browser headers gets
// ONE paragraph prepended to the body, naming the origin and /llms.txt, and a browser gets
// the page byte for byte: a person never sees it, an embed never carries it.
//
// The line is drawn by what a browser cannot help sending: `Sec-Fetch-Dest` rides every
// browser request and no scripted fetcher's. A `Mozilla/` user agent counts as a browser
// too — the fetcher that dresses as one gets the person's page, which is the safe side.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

const URL_ = new URL("https://acme.example/opportunity/prototype/");
const PAGE = `<!doctype html><html><head><title>Cards</title></head><body class="x"><main><h1>Cards</h1></main></body></html>`;
const page = (extra = {}) => new Response(PAGE, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", Link: '</llms.txt>; rel="help"', ETag: '"abc"', ...extra } });
const req = (headers = {}) => new Request(URL_.href, { headers });

test("A CURL-SHAPED FETCH OF A PROTOTYPE OPENS WITH THE DOOR, first thing in the body", async () => {
  const out = await W.withAgentPreface(page(), req({ "User-Agent": "curl/8.7.1" }), URL_);
  const html = await out.text();
  assert.match(html, /<body class="x"><p data-augur-door>This prototype is served by an Augur workspace at https:\/\/acme\.example\. /);
  assert.match(html, /<a href="\/llms\.txt">https:\/\/acme\.example\/llms\.txt<\/a> says how to change it/);
  assert.match(html, /paired with the person's approval, and nobody is ever asked for a password/);
  assert.ok(html.endsWith(`<main><h1>Cards</h1></main></body></html>`), "the page itself is untouched after the paragraph");
  assert.equal(out.headers.get("Cache-Control"), "no-store", "the agent's variant must never be what a cache hands a browser");
  assert.equal(out.headers.get("Link"), '</llms.txt>; rel="help"', "the header pointer stays beside the text one");
  assert.equal(out.headers.get("ETag"), null);
});

test("a fetch with NO user agent at all — node, Python, a summarising tool — gets the door too", async () => {
  const html = await (await W.withAgentPreface(page(), req(), URL_)).text();
  assert.match(html, /data-augur-door/);
});

test("⚠️ A BROWSER GETS THE PAGE BYTE FOR BYTE: a navigation, an iframe, an old browser, a fetcher dressed as one", async () => {
  const shapes = [
    ["a navigation", { "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "User-Agent": "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/128" }],
    ["an embed in somebody else's site", { "Sec-Fetch-Dest": "iframe", "Sec-Fetch-Mode": "navigate", "User-Agent": "Mozilla/5.0 Safari/605.1" }],
    ["a prefetch", { "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "User-Agent": "Mozilla/5.0" }],
    ["a browser old enough to send no Sec-Fetch", { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) Safari/604.1" }],
    ["a fetcher dressed as a browser", { "User-Agent": "Mozilla/5.0 (compatible; SomeBot/1.0)" }],
  ];
  for (const [what, headers] of shapes) {
    const before = page();
    const out = await W.withAgentPreface(before, req(headers), URL_);
    assert.equal(out, before, `${what} must get the very response it would have got`);
    assert.equal(await out.text(), PAGE, `${what}: the bytes changed`);
  }
});

test("a fetch that carries a member's session is already inside and gets the page unchanged", async () => {
  const before = page();
  const out = await W.withAgentPreface(before, req({ "User-Agent": "curl/8" }), URL_, { email: "a@x.test", role: "editor" });
  assert.equal(out, before);
});

test("only a 200 HTML page: a stylesheet, a redirect and a not-found page are left alone", async () => {
  const curl = req({ "User-Agent": "curl/8" });
  const css = new Response("a{}", { status: 200, headers: { "Content-Type": "text/css" } });
  assert.equal(await W.withAgentPreface(css, curl, URL_), css);
  const gone = new Response("<body>no</body>", { status: 404, headers: { "Content-Type": "text/html" } });
  assert.equal(await W.withAgentPreface(gone, curl, URL_), gone);
  const moved = new Response(null, { status: 302, headers: { Location: "/x" } });
  assert.equal(await W.withAgentPreface(moved, curl, URL_), moved);
});

test("a page with no <body> tag still gets it, at the top, rather than nowhere", async () => {
  const bare = new Response("<h1>fragment</h1>", { status: 200, headers: { "Content-Type": "text/html" } });
  const html = await (await W.withAgentPreface(bare, req({ "User-Agent": "curl/8" }), URL_)).text();
  assert.ok(html.startsWith("<p data-augur-door>"));
  assert.ok(html.endsWith("<h1>fragment</h1>"));
});

test("the decision is what a browser cannot help sending, and nothing else", () => {
  assert.equal(W.browserFetch(req({ "Sec-Fetch-Dest": "document" })), true);
  assert.equal(W.browserFetch(req({ "Sec-Fetch-Mode": "no-cors" })), true);
  assert.equal(W.browserFetch(req({ "User-Agent": "Mozilla/5.0" })), true);
  assert.equal(W.browserFetch(req({ "User-Agent": "curl/8" })), false);
  assert.equal(W.browserFetch(req({ "User-Agent": "python-requests/2.32" })), false);
  assert.equal(W.browserFetch(req({ "Accept": "text/html" })), false, "an Accept header is not a browser — every fetcher sends one");
  assert.equal(W.browserFetch(null), true, "no request to judge means the page a person gets");
});
