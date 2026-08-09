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
