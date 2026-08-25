// The gate is the only HTML an anonymous unfurl bot ever sees on a gated instance,
// so its <head> IS the instance's link preview (a Notion bookmark, a Slack card).
// These hold: workspace-branded title/description/icon/og tags when a default space
// is mounted, engine fallbacks when none is, absolute og:url/og:image derived from
// the request, and attribute-safe escaping of space-authored strings.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

// previewHead reads the workspace list off the tenant context loadConfig builds; the
// chrome test seam is the sanctioned way to seed one in a unit test, and it hands the
// seeded context back so the page render can be given the workspace it is describing.
const setSpaces = (spaces) => W.__setChromeTestState(null, spaces, false);
afterEach(() => setSpaces([]));

const BOREALIS = { id: "borealis", name: "Borealis Studio", default: true, description: "" };

test("engine-only gate falls back to Augur + the engine tagline, no icon or image", () => {
  const ctx = setSpaces([]);
  const html = W.loginPage(ctx, "/", false);
  assert.match(html, /<title>Augur<\/title>/);
  assert.ok(html.includes(`<meta name="description" content="${W.ENGINE_TAGLINE}" />`));
  assert.ok(html.includes(`<meta property="og:site_name" content="Augur" />`));
  assert.ok(!html.includes('rel="icon"'), "no default space ⇒ no space icon to link");
  assert.ok(!html.includes("og:image"), "no image without a space icon");
  assert.match(html, /noindex, nofollow/, "unfurl meta must not reopen search indexing");
});

test("a mounted default space brands the whole preview", () => {
  const ctx = setSpaces([{ ...BOREALIS, description: "Prototypes for the Borealis team." }]);
  const html = W.loginPage(ctx, "/", false, "https://borealis.example.com/pages/x/?q=1");
  assert.match(html, /<title>Borealis Studio · Augur<\/title>/);
  assert.ok(html.includes(`<meta property="og:title" content="Borealis Studio" />`));
  assert.ok(html.includes(`<meta property="og:description" content="Prototypes for the Borealis team." />`));
  assert.ok(html.includes(`<link rel="icon" href="/space-icon.png" />`));
  assert.ok(html.includes(`<meta property="og:image" content="https://borealis.example.com/space-icon.png" />`));
  assert.ok(html.includes(`<meta property="og:url" content="https://borealis.example.com/pages/x/" />`),
    "og:url keeps the path but drops the query");
  assert.ok(html.includes(`<meta name="twitter:card" content="summary" />`));
});

test("a default space without a description gets the engine tagline", () => {
  const ctx = setSpaces([BOREALIS]);
  const html = W.loginPage(ctx, "/", false, "https://borealis.example.com/");
  assert.ok(html.includes(`<meta property="og:description" content="${W.ENGINE_TAGLINE}" />`));
});

test("no request URL ⇒ no absolute tags, everything else intact", () => {
  const ctx = setSpaces([BOREALIS]);
  const html = W.loginPage(ctx, "/", false);
  assert.ok(!html.includes("og:image") && !html.includes("og:url"));
  assert.ok(html.includes(`<link rel="icon" href="/space-icon.png" />`), "favicon may stay relative");
});

test("space-authored name and description are attribute-safe", () => {
  const ctx = setSpaces([{ id: "x", name: `A"B <c>`, default: true, description: `say "hi" & <run>` }]);
  const html = W.previewHead(ctx, "https://x.example/");
  assert.ok(html.includes(`content="A&quot;B &lt;c&gt;"`), "name is escaped");
  assert.ok(html.includes(`content="say &quot;hi&quot; &amp; &lt;run&gt;"`), "description is escaped");
  assert.ok(!/content="[^"]*"[^ />]/.test(html), "no attribute breaks out of its quotes");
});

test("the 404 wears the space favicon exactly when a default space is mounted", () => {
  const mounted = setSpaces([BOREALIS]);
  assert.ok(W.notFoundPage(mounted).includes(`<link rel="icon" href="/space-icon.png" />`));
  const bare = setSpaces([]);
  assert.ok(!W.notFoundPage(bare).includes('rel="icon"'));
});
