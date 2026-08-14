// The canvas has ONE camera, and it is a CSS transform on #gvc-world. Anything else that
// moves the world breaks every coordinate in the engine, because screenToWorld/worldToScreen
// assume the world's origin sits at (view.x, view.y) in VIEWPORT coordinates.
//
// The bug these guard (measured in Chromium, 2026-08-13): #gvc-root was `overflow: hidden`.
// That clips, but it still makes a scroll container — and the world's nodes give it a real
// scroll range in both axes. No gesture can scroll an overflow:hidden box, but the BROWSER
// scrolls it programmatically to reveal a focused element, and enterEdit focuses a
// contenteditable that is routinely at or past the screen edge. Chromium scrolled #gvc-root by
// 2072px in the probe. #gvc-world is absolutely positioned inside root so it went with the
// scroll; #gvc-ui is fixed, so it did not. From then on, for the rest of the session:
// a stroke drawn at x=500 was painted at x=-1572, placed nodes missed the pointer, and a
// selected node's toolbar sat ~2000px away from the node. Nothing ever reset the scroll.
//
// Two independent guards, because either alone would have prevented it: no scroll container,
// and no focus() that asks the browser to scroll anything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const JS = readFileSync(new URL("../src/canvas/canvas.js", import.meta.url), "utf8");
const CSS = readFileSync(new URL("../src/canvas/canvas.css", import.meta.url), "utf8");

test("#gvc-root is overflow: clip — never a scroll container", () => {
  // declarations only — the rule's own comment talks ABOUT overflow: hidden
  const rule = CSS.slice(CSS.indexOf("#gvc-root {"), CSS.indexOf("}", CSS.indexOf("#gvc-root {")))
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(rule.includes("position: fixed"), "#gvc-root's rule still exists");
  assert.match(rule, /overflow:\s*clip/, "overflow must be clip: hidden leaves a scrollable box");
  assert.doesNotMatch(rule, /overflow:\s*(hidden|auto|scroll)/,
    "a scrollable #gvc-root lets a focus() offset the whole board from the pointer");
  // the world is positioned INSIDE root, which is what made root's scroll move the camera
  assert.match(CSS, /#gvc-world\s*{[^}]*position:\s*absolute/, "#gvc-world is still root-relative");
});

test("no focus() in the canvas ever asks the browser to scroll", () => {
  // The camera is ours. A focus that scrolls is the browser moving a viewport it does not
  // understand — in the world layer that desynchronises every transform, and in the fixed UI
  // layer there is nothing to reveal anyway. So the rule is total: preventScroll everywhere.
  const plain = JS.split("\n")
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /\.focus\(\s*\)/.test(l));
  assert.deepEqual(plain, [],
    "these focus() calls must pass { preventScroll: true }:\n" +
    plain.map(([n, l]) => `  ${n}: ${l.trim()}`).join("\n"));
  assert.ok(JS.includes("focus({ preventScroll: true })"), "…and the call form is the one asserted");
});
