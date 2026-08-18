// FACE_JS heals a transient avatar miss on its own — no page refresh.
//
// The contributor chip shows initials immediately and lays the photo over them once
// two async steps both succeed: /__people resolves the id→avatar map, then a per-chip
// `new Image()` loads. On a TRANSIENT failure of either step (a non-200 from a cold
// worker isolate, a network reject, or a probe that errors under fan-out) the resolver
// used to re-arm the chip for a *future* wire() call that nothing on the page ever made
// — so the initials stuck until the human hit reload. The Playground grid, the highest
// fan-out view, is where that lands most (~one probe per card, all at once).
//
// These tests run the real FACE_JS IIFE lifted out of build.js against fake browser
// globals, so they assert the behaviour end to end: a miss that clears must repaint by
// itself, and a permanent miss must give up rather than spin forever.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../build.js", import.meta.url), "utf8");

function faceJsBody() {
  const open = "const FACE_JS = `";
  const start = SRC.indexOf(open) + open.length;
  const end = SRC.indexOf("`;", start);
  assert.notEqual(start, open.length - 1, "FACE_JS was found in build.js");
  return SRC.slice(start, end);
}

// Let every queued microtask AND macrotask (the fake setTimeout callbacks below fire
// synchronously, so a single macrotask hop drains a whole retry wave) settle.
const settle = () => new Promise((r) => setImmediate(r));

// A chip element with just the surface FACE_JS touches.
function makeChip(personId) {
  return {
    _attrs: { "data-person": personId },
    dataset: {},
    style: {},
    textContent: "IN",
    getAttribute(k) {
      return k in this._attrs ? this._attrs[k] : null;
    },
  };
}

// Build the browser sandbox and run the real FACE_JS in it. `fetchPlan(callN)` returns
// the response for the Nth /__people call; `imgVerdict(src)` returns 'load' | 'error'.
function runFaceJs({ chips, fetchPlan, imgVerdict }) {
  const state = { fetchCalls: 0, timers: [] };

  const documentFake = {
    querySelectorAll(sel) {
      if (sel === "[data-person]") return chips;
      return []; // no [data-face] baked photos in these fixtures
    },
  };

  class ImageFake {
    set src(v) {
      const verdict = imgVerdict(v);
      queueMicrotask(() => {
        if (verdict === "load") this.onload && this.onload();
        else this.onerror && this.onerror();
      });
    }
  }

  function fetchFake() {
    state.fetchCalls++;
    return Promise.resolve(fetchPlan(state.fetchCalls));
  }

  function setTimeoutFake(fn) {
    state.timers.push(fn);
    return state.timers.length;
  }

  const windowFake = {};
  const run = new Function(
    "window",
    "document",
    "Image",
    "fetch",
    "setTimeout",
    faceJsBody(),
  );
  run(windowFake, documentFake, ImageFake, fetchFake, setTimeoutFake);

  // Fire every scheduled retry timer that is currently queued.
  state.flushTimers = () => {
    const due = state.timers.splice(0);
    due.forEach((fn) => fn());
  };
  return state;
}

const OK = (avatar) => ({
  ok: true,
  json: () => Promise.resolve({ people: [{ id: "p1", avatar }] }),
});
const MISS_200 = { ok: false, json: () => Promise.resolve(null) };

test("a transient /__people miss heals itself without a reload", async () => {
  const chips = [makeChip("p1")];
  const state = runFaceJs({
    chips,
    // First lookup cold-misses (non-200); the retry succeeds.
    fetchPlan: (n) => (n === 1 ? MISS_200 : OK("https://cdn.example/p1.png")),
    imgVerdict: () => "load",
  });

  await settle(); // boot wire(): fetch #1 resolves to the non-200 miss
  // The retry is what a page reload used to do by hand; drive it a few waves.
  for (let i = 0; i < 3 && !chips[0].style.backgroundImage; i++) {
    state.flushTimers();
    await settle();
  }

  assert.match(
    chips[0].style.backgroundImage || "",
    /cdn\.example\/p1\.png/,
    "the photo must land on its own after the transient miss clears",
  );
  assert.equal(chips[0].textContent, "", "initials give way to the photo");
});

test("a permanent miss gives up instead of retrying forever", async () => {
  const chips = [makeChip("p1")];
  const state = runFaceJs({
    chips,
    fetchPlan: () => MISS_200, // never recovers
    imgVerdict: () => "error",
  });

  await settle();
  for (let i = 0; i < 20; i++) {
    state.flushTimers();
    await settle();
  }

  assert.ok(
    state.fetchCalls <= 6,
    `retries must be bounded; saw ${state.fetchCalls} /__people calls`,
  );
  assert.equal(
    chips[0].style.backgroundImage,
    undefined,
    "a permanent miss settles on initials, no photo",
  );
});
