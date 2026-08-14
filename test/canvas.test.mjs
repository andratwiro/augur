// Guards for the canvas renderer's HTML sinks.
//
// canvas.js is one big IIFE with nothing exported, so these read the SOURCE rather than
// call the functions. That is the point: the thing worth preventing is someone
// reintroducing a raw interpolation, and a source guard catches exactly that.
//
// Why it matters: a board document is NOT trusted input. It round-trips through
// GET/POST /__board — which answers an ANONYMOUS caller — and through the multiplayer
// socket. clipSanitize covers the clipboard path only. renderShape and renderDraw
// concatenate node fields into attribute positions inside an innerHTML string, so an
// unclipped `color` of `#fff"/><img src=x onerror=…>` is stored XSS on the origin that
// serves every gated page and the admin API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../src/canvas/canvas.js", import.meta.url), "utf8");

test("the shape and draw sinks clip their colour instead of interpolating it raw", () => {
  // renderShape's template specifically — `<g fill="` alone also matches the sticker art.
  const shape = SRC.split("\n").find((l) => l.includes('preserveAspectRatio="none"') && l.includes("innerHTML"));
  assert.ok(shape, "renderShape's svg template still exists");
  assert.match(shape, /clipColor\(node\.color\)/, "shape fill must go through clipColor");
  assert.doesNotMatch(shape, /\(\s*node\.color\s*\|\|/, "raw node.color reintroduced into innerHTML");

  const draw = SRC.split("\n").find((l) => l.includes("host.innerHTML = strokeSvg("));
  assert.ok(draw, "renderDraw's strokeSvg call still exists");
  assert.match(draw, /clipColor\(node\.color\)/, "stroke colour must go through clipColor");
  assert.doesNotMatch(draw, /\(\s*node\.color\s*\|\|/, "raw node.color reintroduced into innerHTML");
  // strokeSvg drops width/w/h into attribute positions too — string concatenation, so a
  // string field escapes just as a colour would. Every one must be a number by then.
  for (const f of ["node.size", "node.w", "node.h"]) {
    assert.doesNotMatch(draw, new RegExp(f.replace(".", "\\.") + "\\s*\\|\\|"),
      `${f} must be clipNum'd, not defaulted with || (string concatenation escapes)`);
  }
});

test("the colour predicate accepts the real palette and rejects an attribute breakout", () => {
  // Mirrors clipColor in canvas.js — kept here so the policy is asserted, not just its call.
  const ok = (v) => /^#[0-9a-fA-F]{3,8}$/.test(String(v == null ? "" : v));
  for (const c of ["#1e1e1e", "#f24822", "#ffd233", "#3aa2ff", "#ffffff", "#fff", "#ffccaa80"]) {
    assert.equal(ok(c), true, `${c} is a real palette colour and must survive`);
  }
  for (const bad of [
    '#fff"/><img src=x onerror=alert(1)>',
    '#fff" onload="alert(1)',
    "red", "rgb(1,2,3)", "url(javascript:alert(1))", "", null, undefined, 12,
  ]) {
    assert.equal(ok(bad), false, `${String(bad)} must be rejected`);
  }
  // And the regex the source actually ships is the one tested above.
  const line = SRC.split("\n").find((l) => l.includes("function clipColor"));
  assert.match(line, /\/\^#\[0-9a-fA-F\]\{3,8\}\$\//, "clipColor's pattern changed — retest it");
});

test("the face stamp's avatar src is clipped before it reaches the svg", () => {
  // avatarSvg concatenates src into an href="" attribute inside an innerHTML string, and a
  // stamp node arrives over the room socket like any other — the face on it is whoever
  // stamped it, i.e. a value this client never chose.
  // The branch renders initials first and swaps the photo in once it loads, so the src is
  // derived on one line and used on another — assert the property (node.src only ever
  // reaches avatarSvg through clipPath), not the layout it happens to have today.
  const derive = SRC.split("\n").find((l) => l.includes("clipPath(node.src)"));
  assert.ok(derive, "renderStamp's avatar branch still clips node.src");
  for (const l of SRC.split("\n")) {
    if (l.includes("avatarSvg(")) {
      assert.doesNotMatch(l, /avatarSvg\(\s*node\.src/, "raw node.src reintroduced into innerHTML");
    }
  }

  // the initials fallback is drawn as SVG text — same sink, so the name must be reduced to
  // characters that cannot open a tag
  const initials = SRC.split("\n").find((l) => l.includes("function initialsOf"));
  assert.ok(initials, "initialsOf still exists");
  const body = SRC.slice(SRC.indexOf(initials)).split("\n").slice(0, 10).join("\n");
  assert.match(body, /replace\(\/\[\^A-Z0-9\]\/g, ""\)/, "initials must be stripped to A-Z0-9");
});

test("rotation is geometry: a peer's angle rides the fast path, not a rebuild", () => {
  // rot lives on the node like x/y/w/h. If it is not a GEO_KEY, every remote rotation
  // re-renders the node — which reloads a live tile's iframe mid-drag.
  const geo = SRC.split("\n").find((l) => l.includes("var GEO_KEYS"));
  assert.ok(geo, "GEO_KEYS still exists");
  assert.match(geo, /"rot"/, "rot must be a geometry key");
  // and it is written as 0 rather than deleted, because the geo fast-path copies keys that
  // are PRESENT — a deleted rot would never straighten a peer's copy
  const set = SRC.split("\n").find((l) => l.includes("node.rot = Math.round(deg"));
  assert.ok(set, "setRot still assigns rather than deletes");
});

test("the selection bar writes ONE value to the whole selection, never a per-node flip", () => {
  // Multi-edit's trap: `n[prop] = !n[prop]` inside the loop reads as "toggle bold on the
  // selection" and does the opposite of what anyone wants — a selection where half the
  // stickies were already bold comes back inverted rather than all bold.
  const fmt = SRC.slice(SRC.indexOf("function toggleFormat"), SRC.indexOf("function editableText"));
  assert.ok(fmt, "toggleFormat still exists");
  assert.match(fmt, /var want = !node\[prop\]/, "the new value is resolved ONCE, off the first node");
  assert.match(fmt, /\(targets \|\| \[node\]\)\.forEach/, "and written to every target");
  assert.doesNotMatch(fmt, /n\[prop\] = !n\[prop\]/, "no per-node flip inside the loop");

  // And a control only reaches the bar when it means the same thing for everything selected.
  assert.match(SRC, /function uniformType\(nodes\)/, "the same-type gate still exists");
  const bar = SRC.slice(SRC.indexOf("function showSelBar(nodes)"), SRC.indexOf("// ---- deep links"));
  assert.match(bar, /var type = many \? uniformType\(nodes\) : node\.type/,
    "the bar's type must come from the gate, not from the first node, when many are selected");
});

test("no node ever starts a native drag — not even one being edited", () => {
  // The exception this pins used to exist ("dragging a text selection inside the box is a
  // real affordance") and it cost a visible bug: with the box in edit mode its text is
  // selected, so pressing inside it to MOVE it hands Chromium a selection drag instead —
  // and Chromium paints that drag image without the world's zoom transform, smearing a
  // page-sized translucent copy of an 80px "Huge" text node across the board. Restoring
  // any classList test here brings the ghost back.
  const i = SRC.indexOf('root.addEventListener("dragstart"');
  assert.ok(i > 0, "the dragstart guard still exists");
  const handler = SRC.slice(i, SRC.indexOf("});", i));
  assert.match(handler, /closest\("\.gvc-node"\)\)?\s*\)?\s*e\.preventDefault\(\)/,
    "a node target must be cancelled outright");
  assert.doesNotMatch(handler, /classList/, "no per-state exception — editing nodes included");
});

test("a tile's framed view syncs in place, and only the driver sets it", () => {
  // node.viewAt is where in the page a tile was left. Like liveUrl it must be OUTSIDE the
  // tile signature: if it counts, a peer's scroll rebuilds the tile element, which reloads
  // the prototype and throws away exactly the in-page state the view is meant to keep.
  const sig = SRC.split("\n").find((l) => l.includes("function mpTileSig"));
  const body = SRC.split("\n")[SRC.split("\n").indexOf(sig) + 1];
  assert.ok(body && body.includes("GEO_KEYS.indexOf(k)"), "mpTileSig's key filter still exists");
  assert.match(body, /k !== "viewAt"/, "viewAt must not count toward the tile signature");
  assert.match(body, /k !== "liveUrl"/, "liveUrl must not count toward the tile signature");

  // Only the person driving reframes a tile — otherwise a prototype that scrolls itself on
  // load (anchor, restore-scroll script) rewrites the shared view for everyone, on mount.
  const remember = SRC.slice(SRC.indexOf("function rememberView"), SRC.indexOf("function applyView"));
  assert.ok(remember, "rememberView still exists");
  assert.match(remember, /if \(!driving\) return/, "rememberView must be gated on driving the tile");
  // and "driving" is read off the scroll EVENT, not off interactId when the throttle fires —
  // pressing Stop within the throttle window would otherwise drop the view you just set
  const capture = SRC.split("\n").find((l) => l.includes("if (interactId === node.id) scDrv = true"));
  assert.ok(capture, "the driving flag is still captured in the scroll listener itself");

  // A scroll is not an undo step: histApply re-renders what it touches, and re-rendering a
  // tile reloads its iframe — so ⌘Z would reload a prototype to move a scrollbar.
  assert.match(remember, /histIgnore\(node, "viewAt"\)/, "the view must be kept out of the undo diff");
});
