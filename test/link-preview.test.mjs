// The gate is the only HTML an anonymous unfurl bot ever sees on a gated instance,
// so its <head> IS the instance's link preview (a Notion bookmark, a Slack card).
// These hold: workspace-branded title/description/icon/og tags when a default space
// is mounted, engine fallbacks when none is, absolute og:url/og:image derived from
// the request, and attribute-safe escaping of space-authored strings.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

// previewHead reads the same SPACES global loadConfig fills; the chrome test seam
// is the sanctioned way to set it in a unit test.
const setSpaces = (spaces) => W.__setChromeTestState(null, spaces, false);
afterEach(() => setSpaces([]));

const DELTA = { id: "delta", name: "Delta Studio", default: true, description: "" };

test("engine-only gate falls back to Augur + the engine tagline, no icon or image", () => {
  setSpaces([]);
  const html = W.loginPage("/", false);
  assert.match(html, /<title>Augur<\/title>/);
  assert.ok(html.includes(`<meta name="description" content="${W.ENGINE_TAGLINE}" />`));
  assert.ok(html.includes(`<meta property="og:site_name" content="Augur" />`));
  assert.ok(!html.includes('rel="icon"'), "no default space ⇒ no space icon to link");
  assert.ok(!html.includes("og:image"), "no image without a space icon");
  assert.match(html, /noindex, nofollow/, "unfurl meta must not reopen search indexing");
});

test("a mounted default space brands the whole preview", () => {
  setSpaces([{ ...DELTA, description: "Prototypes for the Delta team." }]);
  const html = W.loginPage("/", false, "https://augur.deltastudio.io/pages/x/?q=1");
  assert.match(html, /<title>Delta Studio · Augur<\/title>/);
  assert.ok(html.includes(`<meta property="og:title" content="Delta Studio" />`));
  assert.ok(html.includes(`<meta property="og:description" content="Prototypes for the Delta team." />`));
  assert.ok(html.includes(`<link rel="icon" href="/space-icon.png" />`));
  assert.ok(html.includes(`<meta property="og:image" content="https://augur.deltastudio.io/space-icon.png" />`));
  assert.ok(html.includes(`<meta property="og:url" content="https://augur.deltastudio.io/pages/x/" />`),
    "og:url keeps the path but drops the query");
  assert.ok(html.includes(`<meta name="twitter:card" content="summary" />`));
});

test("a default space without a description gets the engine tagline", () => {
  setSpaces([DELTA]);
  const html = W.loginPage("/", false, "https://augur.deltastudio.io/");
  assert.ok(html.includes(`<meta property="og:description" content="${W.ENGINE_TAGLINE}" />`));
});

test("no request URL ⇒ no absolute tags, everything else intact", () => {
  setSpaces([DELTA]);
  const html = W.loginPage("/", false);
  assert.ok(!html.includes("og:image") && !html.includes("og:url"));
  assert.ok(html.includes(`<link rel="icon" href="/space-icon.png" />`), "favicon may stay relative");
});

test("space-authored name and description are attribute-safe", () => {
  setSpaces([{ id: "x", name: `A"B <c>`, default: true, description: `say "hi" & <run>` }]);
  const html = W.previewHead("https://x.example/");
  assert.ok(html.includes(`content="A&quot;B &lt;c&gt;"`), "name is escaped");
  assert.ok(html.includes(`content="say &quot;hi&quot; &amp; &lt;run&gt;"`), "description is escaped");
  assert.ok(!/content="[^"]*"[^ />]/.test(html), "no attribute breaks out of its quotes");
});

test("the 404 wears the space favicon exactly when a default space is mounted", () => {
  setSpaces([DELTA]);
  assert.ok(W.notFoundPage().includes(`<link rel="icon" href="/space-icon.png" />`));
  setSpaces([]);
  assert.ok(!W.notFoundPage().includes('rel="icon"'));
});
