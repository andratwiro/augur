// The roster overlay refresh (6 KV reads: roster, avatars, names, roles, spaces,
// icons) runs on its own, slower clock than the 1.5s config tick. Under sustained
// traffic the per-tick reads were the dominant KV consumer (~4 reads/s ≈ 350k/day)
// and exhausted the free-tier daily get() budget, 500ing every KV-touching route
// for the rest of the day (2026-08-20). The overlay must still be RE-APPLIED every
// tick — applyInstance resets USERS to the config list and counts on the overlay
// landing on top — so the cadence is about the KV READS, never the apply.
// An admin write busts via cfgAt = 0, which forces a fresh read on that isolate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

function countingKV() {
  const store = new Map();
  const kv = {
    store,
    gets: 0,
    async get(k) { kv.gets += 1; return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, String(v)); },
    async delete(k) { store.delete(k); },
    async list({ prefix = "" } = {}) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
  return kv;
}
function memR2(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(k) { return store.has(k) ? { text: async () => store.get(k), body: store.get(k) } : null; },
    async list() { return { objects: [], delimitedPrefixes: [], truncated: false }; },
    async head(k) { return store.has(k) ? {} : null; },
  };
}

const INSTANCE = JSON.stringify({ users: [{ email: "cfg@x.test", name: "Config" }] });

function bundleEnv() {
  return {
    GV_ASSET_SOURCE: "r2",
    BUNDLES: memR2({ "config/instance.json": INSTANCE }),
    COMMENTS: countingKV(),
  };
}

test("roster KV reads ride a slow clock, not the 1.5s config tick", async () => {
  const env = bundleEnv();
  env.COMMENTS.store.set("users:roster", JSON.stringify({
    add: { "inv@x.test": { email: "inv@x.test", name: "Invited" } }, remove: [],
  }));

  // Cold isolate: first load is forced, roster read happens.
  W.__setConfigTestState({ cfgAt: 0, rosterReadAt: 0 });
  await W.loadConfig(W.DEFAULT_TENANT_ID, env);
  assert.ok(env.COMMENTS.gets > 0, "cold isolate reads the roster overlay");
  assert.ok(W.__usersNow().some((u) => u.email === "inv@x.test"), "overlay applied");

  // A natural 1.5s tick with a fresh roster cache: ZERO KV reads...
  env.COMMENTS.gets = 0;
  W.__setConfigTestState({ cfgAt: Date.now() - 2000 });
  await W.loadConfig(W.DEFAULT_TENANT_ID, env);
  assert.equal(env.COMMENTS.gets, 0, "fresh cache tick costs no KV reads");
  // ...but the overlay is still applied on top of applyInstance's USERS reset.
  assert.ok(W.__usersNow().some((u) => u.email === "inv@x.test"), "cached overlay re-applied every tick");
  assert.ok(W.__usersNow().some((u) => u.email === "cfg@x.test"), "config users present");

  // Once the roster TTL elapses, the next tick re-reads KV.
  env.COMMENTS.gets = 0;
  W.__setConfigTestState({ cfgAt: Date.now() - 2000, rosterReadAt: Date.now() - 61_000 });
  await W.loadConfig(W.DEFAULT_TENANT_ID, env);
  assert.ok(env.COMMENTS.gets > 0, "elapsed TTL re-reads the overlay");

  // An admin write busts with cfgAt = 0: forced fresh read, no 60s wait.
  env.COMMENTS.store.set("users:roster", JSON.stringify({
    add: { "inv2@x.test": { email: "inv2@x.test", name: "Second" } }, remove: [],
  }));
  env.COMMENTS.gets = 0;
  W.__setConfigTestState({ cfgAt: 0 });
  await W.loadConfig(W.DEFAULT_TENANT_ID, env);
  assert.ok(env.COMMENTS.gets > 0, "cfgAt=0 bust forces a roster read");
  assert.ok(W.__usersNow().some((u) => u.email === "inv2@x.test"), "busted read sees the new invite");
});
