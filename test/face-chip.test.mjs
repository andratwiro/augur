// Guards for the contributor face chip — the one place a person's photo meets a
// build-time colour.
//
// The chip is initials-on-colour with the photo laid over it by FACE_JS, and the
// photo only ever looks right because `.proto-editor` sizes it (`background-size:
// cover; background-position: center`). Those are STYLESHEET longhands, so the chip's
// inline style must never use the `background` SHORTHAND: an inline shorthand wins the
// cascade and resets both longhands to their initial values, and the 96px photo then
// paints at natural size from the top-left corner of a 22px circle — a blurry crop of
// someone's hair, on every card. That is a rendering bug no test of the markup's
// *content* would catch, so it is asserted here.
//
// build.js exports nothing, so this lifts faceChip out of the source and runs it for
// real (same technique as publish-filter.test.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../build.js", import.meta.url), "utf8");

function lift(name) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} was found in build.js`);
  return SRC.slice(start, SRC.indexOf("\n}", start) + 2);
}
const faceChip = new Function(`${lift("escAttr")}\n${lift("faceChip")}\nreturn faceChip;`)();

const ANA = { name: "Ana", initials: "R", color: "#4f46e5", avatar: "/__avatar/u/abc" };

test("the chip was actually lifted out of build.js", () => {
  assert.equal(typeof faceChip, "function");
});

test("the chip's colour never resets the photo's sizing", () => {
  const html = faceChip(ANA, "proto-editor", "Ana");
  assert.match(html, /style="[^"]*background-color:/,
    "the colour must be set as background-color");
  assert.doesNotMatch(html, /style="[^"]*background:/,
    "the background shorthand would reset background-size/position from .proto-editor");
});

test("the stylesheet is the other half of that pairing", () => {
  const rule = SRC.slice(SRC.indexOf(".proto-editor {"), SRC.indexOf("}", SRC.indexOf(".proto-editor {")));
  assert.match(rule, /background-size:\s*cover/);
  assert.match(rule, /background-position:\s*center/);
});

test("the photo is a data attribute, never a baked background", () => {
  // FACE_JS paints it only once the image has loaded, so a URL the instance no longer
  // serves degrades to initials instead of an empty circle.
  const html = faceChip(ANA, "proto-editor", "Ana");
  assert.match(html, /data-face="\/__avatar\/u\/abc"/);
  assert.doesNotMatch(html, /url\(/);
  assert.match(html, />R</, "initials are the chip's own content");
});

test("FACE_JS stamps the sizing alongside the image", () => {
  // Defence in depth for the same failure: whatever the chip's inline colour turns out
  // to be, the photo is only ever painted together with cover/center.
  const js = SRC.slice(SRC.indexOf("const FACE_JS = `"), SRC.indexOf("`;", SRC.indexOf("const FACE_JS = `")));
  assert.match(js, /backgroundSize = 'cover'/);
  assert.match(js, /backgroundPosition = 'center'/);
});

test("someone without a photo gets no data-face at all", () => {
  const html = faceChip({ name: "Iva Kopraleva", initials: "IK", color: "#0d9488" }, "proto-editor", "Iva");
  assert.doesNotMatch(html, /data-face/);
  assert.match(html, />IK</);
});
