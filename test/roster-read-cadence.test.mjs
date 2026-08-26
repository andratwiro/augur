// The roster overlay refresh (6 KV reads: roster, avatars, names, roles, spaces,
// icons) runs on its own, slower clock than the 1.5s config tick. Under sustained
// traffic the per-tick reads were the dominant KV consumer (~4 reads/s ≈ 350k/day)
// and exhausted the free-tier daily get() budget, 500ing every KV-touching route
// for the rest of the day (2026-08-20). The overlay must still be RE-APPLIED every
// tick — applyInstance resets USERS to the config list and counts on the overlay
// landing on top — so the cadence is about the KV READS, never the apply.
//
// Freshness is KEYED. The cache is one entry per workspace, and a handler that writes
// one of the six busts that workspace's entry — not the isolate's. `cfgAt = 0` no
// longer reaches this clock at all: a config tick that forced every workspace's six
// documents to be re-read because a neighbour renamed themselves is the coarse shape
// this cache was moved off. So the write path is driven here through a real handler,
// which is the only thing that proves the bust is wired to the write.
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

  // Cold isolate: no entry for this workspace yet, so the roster read happens.
  W.__setConfigTestState({ cfgAt: 0, roster: null });
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

  // Ageing THIS workspace's entry past the TTL re-reads on the next tick. Aged by key,
  // because there is no clock left that could age every workspace's entry at once.
  env.COMMENTS.gets = 0;
  W.__setConfigTestState({
    cfgAt: Date.now() - 2000,
    roster: { tenantId: W.DEFAULT_TENANT_ID, at: Date.now() - 61_000 },
  });
  await W.loadConfig(W.DEFAULT_TENANT_ID, env);
  assert.ok(env.COMMENTS.gets > 0, "elapsed TTL re-reads the overlay");

  // A write through a REAL handler busts this workspace's entry: fresh read, no 60s wait.
  // Driving the handler rather than poking the clock is the point — it is what says the
  // bust is actually wired to the write, on the workspace the write happened in.
  const me = { email: "cfg@x.test", name: "Config" };
  const named = await W.meNameApi(W.DEFAULT_TENANT_ID, new Request("https://x.test/__me/name", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Renamed" }),
  }), env, me);
  assert.equal(named.status, 200, "the rename was refused");
  env.COMMENTS.gets = 0;
  W.__setConfigTestState({ cfgAt: 0 });
  await W.loadConfig(W.DEFAULT_TENANT_ID, env);
  assert.ok(env.COMMENTS.gets > 0, "the write did not bust this workspace's entry");
  assert.ok(
    W.__usersNow().some((u) => u.name === "Renamed"),
    "the busted read did not see the write that busted it",
  );
});

test("a write in one workspace does not send another back to KV", async () => {
  // The other half of "keyed": the bust reaches the entry the write belongs to and no
  // other. A blanket bust would be invisible here except as six KV reads per workspace
  // per admin action, which is the budget this cache exists to protect.
  W.__setConfigTestState({ cfgAt: 0, roster: null });
  const alpha = bundleEnv();
  const beta = bundleEnv();
  await W.loadConfig("alpha", alpha);
  await W.loadConfig("beta", beta);
  assert.ok(beta.COMMENTS.gets > 0, "beta never read its own overlay — nothing below distinguishes anything");

  const me = { email: "cfg@x.test", name: "Config" };
  await W.meNameApi("alpha", new Request("https://x.test/__me/name", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Renamed in alpha" }),
  }), alpha, me);

  beta.COMMENTS.gets = 0;
  W.__setConfigTestState({ cfgAt: 0 });
  await W.loadConfig("beta", beta);
  assert.equal(beta.COMMENTS.gets, 0, "a rename in ALPHA sent beta back to KV for six documents");
});
