// Behavioural guards for the FACE stamp (`stamp: "avatar"`).
//
// canvas.js exports nothing, so this lifts the real functions out of the source and runs
// them against a minimal DOM — same technique as face-chip.test.mjs, but here it has to be
// behavioural rather than a source grep: the bug this pins is an ORDERING bug between
// renderStamp and its caller, and no assertion about the text of either line would catch it.
//
// The ordering: renderNode calls renderStamp, and appends the host it returns AFTERWARDS.
// So renderStamp always runs against a DETACHED host. Any work it defers to a callback that
// can fire synchronously therefore cannot test `host.isConnected` — that is false for a host
// which is about to be appended, and the second face stamp of a session takes exactly that
// path (the avatar's probe result is cached by then, so the callback is synchronous).
// Symptom: every face stamp after the first paints initials-on-colour, forever — "I see my
// face while stamping, then it turns into an R".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../src/canvas/canvas.js", import.meta.url), "utf8");

// Lift a function by walking its braces, so single-line and multi-line bodies both work.
function lift(name) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} was found in canvas.js`);
  let i = SRC.indexOf("{", start), depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}" && --depth === 0) return SRC.slice(start, i + 1);
  }
  throw new Error(`${name} never closed`);
}

// A DOM small enough to be obviously honest: the only behaviour under test is what ends up
// in host.innerHTML, and whether the host was attached when it happened.
function fakeEl(tag) {
  return {
    tagName: tag, className: "", innerHTML: "", textContent: "", isConnected: false,
    dataset: {}, kids: [],
    style: { setProperty() {}, removeProperty() {} },
    classList: { add() {}, remove() {}, contains: () => false },
    appendChild(c) { this.kids.push(c); c.isConnected = true; return c; },
  };
}

function harness() {
  const pending = [];
  const sandbox = {
    document: { createElement: fakeEl },
    // every `new Image()` load resolves only when the test flushes it
    Image: function () {
      const self = this;
      Object.defineProperty(self, "src", {
        set(v) { self._src = v; pending.push(() => self.onload && self.onload()); },
        get() { return self._src; },
      });
    },
    stampHtml: () => null,   // the avatar branch never reaches the sticker art
    stampChar: () => "",
  };
  const body = [
    "var avSeq = 0;",
    'var STAMP_FONT = "sans-serif";',
    "var FACE_OK = Object.create(null);",
    lift("initialsOf"), lift("avatarSvg"), lift("faceProbe"),
    lift("clipPath"), lift("clipColor"), lift("rotOf"), lift("applyRot"),
    lift("place"), lift("el"), lift("renderStamp"),
    // faceCached is the fix's helper; tolerate its absence so the test FAILS on behaviour
    // rather than exploding at parse time before the fix exists.
    SRC.includes("function faceCached(") ? lift("faceCached") : "",
    "return { renderStamp: renderStamp, FACE_OK: FACE_OK };",
  ].join("\n");
  const api = new Function("document", "Image", "stampHtml", "stampChar", body)(
    sandbox.document, sandbox.Image, sandbox.stampHtml, sandbox.stampChar);
  return { ...api, flush: () => { while (pending.length) pending.shift()(); } };
}

const ANA = { type: "stamp", stamp: "avatar", src: "/__avatar/u/ana", name: "Ana", color: "#e8590c", x: 0, y: 0, w: 46, h: 46 };
const photo = (h) => h.innerHTML.includes('<image href="/__avatar/u/ana"');

// renderNode's contract, reproduced: the host is appended AFTER renderStamp returns.
function renderAndAppend(api, node) {
  const host = api.renderStamp(node);
  host.isConnected = true; // world.appendChild(host)
  return host;
}

test("a face stamp paints the photo, not initials, once the avatar loads", () => {
  const api = harness();
  const first = renderAndAppend(api, { ...ANA });
  assert.equal(photo(first), false, "initials first — an <image> that 404s leaves a hole in the ring");
  api.flush();
  assert.equal(photo(first), true, "the photo is swapped in once it has really loaded");
});

test("EVERY face stamp gets the photo — not just the first one of the session", () => {
  // The regression: with the avatar's probe result cached, faceProbe answers synchronously,
  // i.e. BEFORE the caller appends the host. A guard that requires an attached host drops
  // the photo on the floor with no retry, so stamp #2 onwards is initials forever.
  const api = harness();
  api.flush.call(null); // (no-op: nothing pending yet)
  const first = renderAndAppend(api, { ...ANA });
  api.flush();
  assert.equal(photo(first), true, "precondition: the first stamp works");
  assert.equal(api.FACE_OK["/__avatar/u/ana"], true, "precondition: the probe is now cached");

  const second = renderAndAppend(api, { ...ANA });
  api.flush();
  assert.equal(photo(second), true, "the second face stamp must show the face too");

  const third = renderAndAppend(api, { ...ANA });
  api.flush();
  assert.equal(photo(third), true, "and every one after it");
});

test("a face whose avatar 404s stays initials — a hole in the ring is worse", () => {
  const api = harness();
  const host = api.renderStamp({ ...ANA });
  host.isConnected = true;
  // fail the probe instead of loading it
  const img = null; // (the harness only exposes onload; drive the cache directly)
  api.FACE_OK["/__avatar/u/gone"] = false;
  const gone = renderAndAppend(api, { ...ANA, src: "/__avatar/u/gone" });
  api.flush();
  assert.equal(gone.innerHTML.includes("<image"), false, "no <image> for an avatar that does not resolve");
  assert.match(gone.innerHTML, />A</, "initials stand in for the person");
  assert.equal(img, null);
});

test("a face stamp with no src at all is initials on the stamper's colour", () => {
  const api = harness();
  const host = renderAndAppend(api, { ...ANA, src: undefined });
  api.flush();
  assert.equal(host.innerHTML.includes("<image"), false);
  assert.match(host.innerHTML, /fill="#e8590c"/, "the fallback wears the colour the stamp was pressed with");
});
