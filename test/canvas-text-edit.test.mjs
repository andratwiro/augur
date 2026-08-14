// Leaving text-edit mode on the canvas.
//
// Edit mode used to be a one-way door with no visible state: the only way out was clicking
// some OTHER element, because the editable swallows every keydown (so canvas shortcuts don't
// fire mid-typing) and that included the Escape meant to end the edit. A node stuck in edit
// mode cannot be moved — a press on its text belongs to the caret, and a press anywhere else
// on it bailed out of the drag path entirely. And because enterEdit selects the whole text,
// the selection outlived the edit: Chromium reads a press on selected glyphs as a request to
// drag the TEXT, lifts a ghost image of it, and the node never moves. What the user sees is
// "I can only drag this node from the empty space next to the text".
//
// canvas.js exports nothing and this is DOM behaviour, so these are source guards on the three
// properties that were each verified in Chromium (see the commit): Escape exits, a press off
// the text exits + drags, and the selection never outlives the edit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const JS = readFileSync(new URL("../src/canvas/canvas.js", import.meta.url), "utf8");
const CSS = readFileSync(new URL("../src/canvas/canvas.css", import.meta.url), "utf8");

function fn(name) {
  const start = JS.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} still exists`);
  let i = JS.indexOf("{", start), depth = 0;
  for (; i < JS.length; i++) {
    if (JS[i] === "{") depth++;
    else if (JS[i] === "}" && --depth === 0) return JS.slice(start, i + 1);
  }
  throw new Error(`${name} never closed`);
}

test("exitEdit drops the selection BEFORE it blurs", () => {
  const body = fn("exitEdit");
  assert.match(body, /removeAllRanges\(\)/, "the text selection must be cleared on the way out");
  assert.ok(body.indexOf("removeAllRanges") < body.indexOf(".blur()"),
    "clear the selection first — a selection that outlives the edit makes the next press on the glyphs a native text drag");
  assert.match(body, /\.blur\(\)/, "and the blur handler is what commits the text");
});

test("Escape leaves text-edit — handled where the keys are swallowed", () => {
  // It cannot live in the document-level shortcut handler: the editable's keydown listener
  // calls stopPropagation on everything, which is what ate Escape in the first place.
  const i = JS.indexOf('txt.addEventListener("keydown"');
  assert.notEqual(i, -1, "the editable's keydown handler still exists");
  const handler = JS.slice(i, JS.indexOf('txt.addEventListener("paste"', i));
  assert.match(handler, /e\.stopPropagation\(\)/, "it still swallows canvas shortcuts while typing");
  assert.match(handler, /e\.key === "Escape"/, "…and it must answer Escape itself");
  assert.match(handler, /exitEdit\(\)/, "Escape exits the edit");
  assert.match(handler, /nodeById\(id\)/,
    "and only re-selects a node that survived — an emptied text node deletes itself on blur");
});

test("a press on an editing node, off its text, exits the edit and drags", () => {
  const i = JS.indexOf('nodeHost.classList.contains("editing")');
  assert.notEqual(i, -1, "the pointerdown branch for an editing node still exists");
  const branch = JS.slice(i, i + 200);
  assert.match(branch, /if \(!exitEdit\(\)\) return/,
    "an editing node must leave edit and fall through to the move path, not bail out");
  // presses INSIDE the text never reach that branch — the editable stops them, which is what
  // keeps caret placement and drag-to-select working while editing
  assert.match(JS, /txt\.addEventListener\("pointerdown", function \(e\) \{ if \(host\.classList\.contains\("editing"\)\) e\.stopPropagation\(\); \}\)/,
    "the editable still owns presses on its own text");
});

test("node text is never draggable content", () => {
  assert.match(CSS, /\.gvc-txt\s*{[^}]*-webkit-user-drag:\s*none/,
    "Chromium drags selected text as an object unless this says otherwise");
  // third layer: the root cancels any native drag that starts on a node anyway
  const i = JS.indexOf('root.addEventListener("dragstart"');
  assert.notEqual(i, -1, "the dragstart guard is still there");
  assert.match(JS.slice(i, i + 200), /preventDefault\(\)/);
});
