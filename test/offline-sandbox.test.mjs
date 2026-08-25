// Offline mode has two postures and they must not mix. With deploy creds the local
// worker is a live mirror (prod KV, prod realtime rooms). WITHOUT creds it promises a
// "safe local-only sandbox" — but until this test existed, only KV went local: the
// canvas still joined the REAL prod rooms through /__rt, so board edits half-escaped
// the sandbox (and solo saves silently diverged from what everyone else saw). The
// sandbox now disables the realtime proxy outright (GV_RT_DISABLE, set by
// scripts/offline.mjs when creds are absent), and the client degrades to solo against
// the local KV — actually isolated.
//
// The wrangler process is also supervised: a workerd crash used to take the whole
// offline server down with it (`process.exit` on close) and every open canvas tab
// lost both its room and its save rail at once. The respawn policy is a pure helper
// so the crash-loop cutoff is testable without spawning anything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";
import { respawnDelay } from "../scripts/lib/offline-respawn.mjs";

// A workspace with no realtime origin configured — the sandbox case these tests are
// about. rtProxy takes the workspace it is proxying for, so the fixture names one.
const CTX = W.applyDerivedRouting({});

const rtReq = (headers = {}) =>
  new Request("https://example.test/__rt?path=/x/", { headers });
const rtUrl = () => new URL("https://example.test/__rt?path=/x/");

test("GV_RT_DISABLE seals /__rt shut, before any origin or upgrade check", async () => {
  const res = W.rtProxy(CTX, rtReq({ Upgrade: "websocket" }), rtUrl(), { GV_RT_DISABLE: "1" });
  assert.equal(res.status, 501);
  assert.deepEqual(await res.json(), { error: "realtime-disabled" });
});

test("without the disable flag, an unconfigured origin still answers not-configured", async () => {
  const res = W.rtProxy(CTX, rtReq({ Upgrade: "websocket" }), rtUrl(), {});
  assert.equal(res.status, 501);
  assert.deepEqual(await res.json(), { error: "realtime-not-configured" });
});

// ---- respawn policy: restart on crash, give up on a crash LOOP --------------

test("a lone crash respawns after a short delay", () => {
  assert.equal(typeof respawnDelay([], 1000_000), "number");
  assert.ok(respawnDelay([990_000], 1000_000) >= 1000, "at least a second between spawns");
});

test("crashes spaced out over a long session keep respawning", () => {
  const history = [0, 600_000, 1200_000, 1800_000, 2400_000];
  assert.notEqual(respawnDelay(history, 2400_500), null);
});

test("five crashes inside a minute means something is really wrong — give up", () => {
  const now = 60_000;
  const history = [now - 50_000, now - 40_000, now - 30_000, now - 20_000, now - 10_000];
  assert.equal(respawnDelay(history, now), null);
});
