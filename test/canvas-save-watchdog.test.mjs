// The solo save rail may never latch shut, and it may never fail in silence.
//
// The bug these guard (measured 2026-08-19, offline dev session): the local dev server was
// restarted while a tab had a save POST in flight. fetch has NO default timeout, so that
// request simply never settled — and the old `savePending` boolean, set before the fetch and
// cleared only when it settled, then short-circuited every save() for the REST OF THE
// SESSION. The tab kept editing for an hour with zero persistence and zero warning: the
// room socket was down (solo rail correctly active), the first saves had landed, and then
// one hung request killed the rail silently. Nothing retried, nothing warned, nothing
// self-healed. The doc on screen was the only copy of the work.
//
// canvas.js is one big IIFE with nothing exported, so these are source guards on the four
// properties that close that class of failure — not just the one hang that was measured.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const JS = readFileSync(new URL("../src/canvas/canvas.js", import.meta.url), "utf8");
const CSS = readFileSync(new URL("../src/canvas/canvas.css", import.meta.url), "utf8");

test("a pending save EXPIRES — no boolean latch can shut the rail", () => {
  // the guard that skips a save while one is in flight must be time-bounded: a pending
  // save only counts while it's provably in flight, never as a permanent fact
  assert.doesNotMatch(JS, /savePending\s*=\s*(true|false)\b/,
    "boolean savePending latch reintroduced — one unsettled request kills every later save");
  const guard = JS.split("\n").find((l) => l.includes("sig === lastSavedSig"));
  assert.ok(guard, "the duplicate/pending save guard still exists");
  assert.match(guard, /savePendingAt/, "the pending guard must be a timestamp");
  assert.match(guard, /SAVE_TIMEOUT/, "…and it must expire after SAVE_TIMEOUT");
});

test("the save POST aborts instead of hanging forever", () => {
  const call = JS.split("\n").find((l) => l.includes("fetch(BOARD_API") && l.includes("POST"));
  assert.ok(call, "the save POST still exists");
  assert.match(call, /signal/, "the save POST must carry an abort signal");
  assert.match(JS, /ctl\.abort\(\)/, "…armed by a timer, so a hung request settles into saveFail");
  // and settling MUST clear the pending stamp on both paths, or the abort feeds the latch
  const clears = JS.split("\n").filter((l) => l.includes("savePendingAt = 0"));
  assert.ok(clears.length >= 2, "both the resolve and reject paths must clear savePendingAt");
});

test("a dead rail restarts itself: the watchdog kicks save() when dirty, roomless and idle", () => {
  const i = JS.indexOf("saveDirtyTicks");
  assert.ok(i > 0, "the save watchdog still exists");
  const wd = JS.slice(i, JS.indexOf("}, 5000)", i));
  assert.ok(wd.length > 0 && wd.length < 2000, "the watchdog runs on a 5s interval");
  assert.match(wd, /mpLiveFresh\(\)/, "the room being live must stand the watchdog down");
  assert.match(wd, /save\(\)/, "a dirty, roomless, idle rail must be kicked — self-heal, not just report");
  assert.match(wd, /saveRetryTimer/, "an armed retry means the rail is alive — the kick must respect backoff");
});

test("a rail that isn't landing saves says so — persistently, not as a toast", () => {
  assert.match(JS, /gvc-savewarn/, "the unsaved-changes pill exists in the js");
  assert.match(CSS, /#gvc-savewarn/, "…and in the css");
  assert.match(CSS, /#gvc-savewarn\.show/, "…with a shown state");
  // the pill clears the moment a save confirms — a stale warning is as bad as none
  const ok = JS.indexOf("lastSavedSig = sig");
  assert.ok(ok > 0, "the save-confirmed path still exists");
  assert.match(JS.slice(ok, ok + 200), /saveWarn\(false\)/, "a confirmed save must clear the warning");
});

test("closing the tab with a dead rail asks first", () => {
  // the unload beacon is fire-and-forget and can miss; while the pill is up, the board on
  // screen may be the only copy of the work — leaving should be a decision, not a default
  const i = JS.indexOf('addEventListener("beforeunload", function (e)');
  assert.ok(i > 0, "the guarded-exit listener exists");
  const h = JS.slice(i, i + 300);
  assert.match(h, /preventDefault/, "it must actually arm the browser prompt");
  assert.match(h, /saveWarn/, "…and only while the unsaved warning is showing");
});
