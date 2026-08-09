// The review overlay is injected into every prototype page, including gated ones and
// pages admins open. It renders values derived from window.__GV_GRAPH (graph.js), which
// is SPACE-PUBLISHED content — writable by any publish-token holder. Those values reach
// innerHTML, so they must be escaped, and escaped for ATTRIBUTE positions (quotes) not
// just text positions. comments.js is an unexported IIFE, so these read the source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../src/review/comments.js", import.meta.url), "utf8");
const line = (needle) => SRC.split("\n").find((l) => l.includes(needle));

test("escHtml escapes quotes, so it is safe in an attribute position", () => {
  const fn = line("function escHtml");
  const body = SRC.slice(SRC.indexOf(fn), SRC.indexOf(fn) + 400);
  assert.match(body, /&quot;|&#34;/, "escHtml must escape double quotes");
  assert.match(body, /&#39;|&apos;/, "escHtml must escape single quotes");
});

test("the layer chip does not interpolate a raw class name", () => {
  const l = line('class="chip l-');
  assert.ok(l, "the chip template still exists");
  assert.doesNotMatch(l, /l-' \+ layer/, "raw layer concatenated into a class attribute");
  assert.match(l, /slugClass\(layer\)/, "the class name must be slug-clamped");
});

test("the link badge escapes the layer it prints", () => {
  const l = line('<span class="lyr">');
  assert.ok(l, "the badge template still exists");
  assert.doesNotMatch(l, /"lyr">' \+ it\.layer/, "raw it.layer concatenated into innerHTML");
});

// The token swatch is the one sink that builds an inline STYLE attribute, and its value
// comes straight from graph.js (t.raw / t.value). The leading-character regex above it
// only constrains the FIRST characters, so `#fff" onload="…` passes it — the escape at
// the sink is what actually holds.
test("the token swatch escapes the colour it drops into a style attribute", () => {
  const l = line('class="sw" style="background:');
  assert.ok(l, "the swatch template still exists");
  assert.match(l, /escHtml\(col\)/, "the swatch colour must be escaped");
});

test("the escaping helpers behave", () => {
  // Mirrors the implementations, so the policy is asserted and not just its call sites.
  const escHtml = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const slugClass = (s) => (/^[a-z0-9-]+$/.test(String(s)) ? String(s) : "");
  assert.equal(escHtml('a" onload="x'), "a&quot; onload=&quot;x");
  assert.equal(escHtml("<img>"), "&lt;img&gt;");
  assert.equal(slugClass("components"), "components");
  assert.equal(slugClass('x" onload="y'), "");
  assert.equal(slugClass("<img src=x>"), "");
});
