// The config load is fail-open-stale WITH A FLOOR, and this is the floor.
//
// test/config-keep-last-good.test.mjs pins the half that keeps a working gate working: a
// transient read failure must not empty the roster or close the public doors. This file
// pins the opposite half, and the two are only meaningful together — "keep the last good
// config" is safe exactly as long as there IS a last good config and it is still young.
//
// THE DISTINCTION THIS FILE EXISTS TO HOLD, and it must not blur:
//
//   A RAW BUILD THAT NEVER HAD CONFIG IS OPEN BY DESIGN. An engine clone with no
//   identity file builds an empty, open-gated site; an offline shell with no config
//   source at all is the same thing. Nothing was read, so nothing failed, and the empty
//   defaults are the honest answer.
//
//   A DEPLOYMENT WHOSE CONFIG HAS LOADED BEFORE MUST NOT FALL BACK TO THOSE DEFAULTS.
//   The empty defaults are byte-for-byte what a raw build produces — no users, no
//   prefixes, CONFIG_LOADED false — so a refresh that fails and falls through to them is
//   a deployment impersonating a raw build. It is the same picture; only the history
//   tells them apart, and the history is what `cfgGoodAt` records.
//
// So a read that FAILED is not a document that is ABSENT, and the load now says which is
// which. Absent contributes nothing and the gate shuts on CONFIG_LOADED. Failed keeps the
// last good context until CONFIG_STALE_CEILING_MS, and then the request is refused with a
// 503 rather than answered from a config nobody can vouch for any more.
//
// Both serving modes, because the response-snapshot corpus runs in ASSETS mode and every
// deployed instance runs in BUNDLE mode.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

const T = W.DEFAULT_TENANT_ID;
const CEILING = W.CONFIG_STALE_CEILING_MS;

function memKV(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, String(v)); },
    async delete(k) { store.delete(k); },
  };
}

const INSTANCE = {
  users: [{ email: "known@x.test", name: "Known", role: "admin", passHash: "seed" }],
  minClientProtocol: 4,
};
const ROUTING = {
  buildId: "build-1",
  publicPrefixes: ["/open/"],
  versionMap: { "/open/": "v-open" },
  spaces: [{ id: "one", name: "One", default: true }],
};

// ---- the four things a config read can do -------------------------------------------
// `mode` is the whole point of this fixture: each value is one of the answers the load
// now has to tell apart, spelled out where a test names it.
function assets(mode = "ok") {
  const o = {
    reads: 0,
    async fetch(u) {
      o.reads += 1;
      if (mode === "throw") throw new Error("config read down");        // FAILED
      if (mode === "5xx") return new Response("nope", { status: 503 }); // FAILED
      if (mode === "absent") return new Response("Not Found", { status: 404 }); // ABSENT
      if (mode === "fallback-page") {                                   // ABSENT
        return new Response("<html>the host's own miss page</html>", { status: 200 });
      }
      const p = new URL(typeof u === "string" ? u : u.url).pathname;
      if (p === "/__config/instance.json") return new Response(JSON.stringify(INSTANCE), { status: 200 });
      if (p === "/__config/routing.json") return new Response(JSON.stringify(ROUTING), { status: 200 });
      return new Response("Not Found", { status: 404 });
    },
  };
  return o;
}

const MANIFESTS = {
  "config/instance.json": JSON.stringify(INSTANCE),
  "spaces/one/manifest.json": JSON.stringify({
    id: "one", format: 1, files: {},
    routing: {
      publicPrefixes: ["/open/"], versionMap: { "/open/": "v-open" },
      shellSig: "sig", name: "One", default: true,
    },
  }),
};
function bundle(seed, mode = "ok") {
  const store = new Map(Object.entries(seed));
  const down = () => { throw new Error("store down"); };
  return {
    async get(k) { if (mode === "throw") down(); return store.has(k) ? { text: async () => store.get(k) } : null; },
    async list() { if (mode === "throw") down(); return { objects: [], delimitedPrefixes: ["spaces/one/"], truncated: false }; },
    async head(k) { if (mode === "throw") down(); return store.has(k) ? { etag: "etag-" + k } : null; },
  };
}

// Back to a cold isolate: no tick, no last-good, no roster cache, no manifest cache.
const cold = () => W.__setConfigTestState({
  cfgAt: 0, cfgGoodAt: 0, roster: null, manifests: false, storage: false,
});
// A new tick, keeping whatever last-good the previous load established.
const tick = () => W.__setConfigTestState({ cfgAt: 0 });

// ---- (a) the raw build stays open ----------------------------------------------------

test("a raw build with no config source at all is OPEN by design, and a load cannot refuse it", async () => {
  cold();
  // No ASSETS, no BUNDLES: an offline shell or a raw engine clone. Nothing is read, so
  // nothing can fail — the answer is a context, never a refusal.
  const ctx = await W.loadConfig(T, {});
  assert.ok(ctx, "no config source is not a failure and must never produce a refusal");
  assert.deepEqual(ctx.USERS, [], "a raw build has no roster");
  assert.equal(ctx.CONFIG_LOADED, false,
    "nothing was loaded — and this false is what the gate reads to tell raw from broken");
});

test("a deployment whose config documents are ABSENT is not refused — the gate shuts on CONFIG_LOADED", async () => {
  cold();
  const kv = memKV();
  // 404 on both documents. This is a build that shipped no config, served by a host that
  // says so honestly. It is ABSENT, not FAILED: a context comes back.
  const ctx = await W.loadConfig(T, { ASSETS: assets("absent"), COMMENTS: kv });
  assert.ok(ctx, "an absent document is not a failed read");
  assert.equal(ctx.CONFIG_LOADED, false,
    "no instance document parsed, so the gate must not be told identity is genuinely empty");
});

test("a 200 that is the host's own miss page is ABSENT too, not a failed read", async () => {
  cold();
  const kv = memKV();
  const ctx = await W.loadConfig(T, { ASSETS: assets("fallback-page"), COMMENTS: kv });
  assert.ok(ctx, "an unparseable document is a document that is not there, not a broken store");
  assert.equal(ctx.CONFIG_LOADED, false);
});

// ---- (b) a deployment whose refresh fails --------------------------------------------

test("assets mode: a COLD isolate whose first config read FAILS is refused, never opened", async () => {
  cold();
  const kv = memKV();
  const ctx = await W.loadConfig(T, { ASSETS: assets("throw"), COMMENTS: kv });
  assert.equal(ctx, null,
    "no last good config and no way to read one — the request must be refused, not answered " +
    "from the empty defaults that are indistinguishable from a raw build");
});

test("assets mode: a config document answered with a 5xx is a FAILED read, not an absent one", async () => {
  cold();
  const kv = memKV();
  assert.equal(await W.loadConfig(T, { ASSETS: assets("5xx"), COMMENTS: kv }), null,
    "the host answered, and what it answered was that it could not serve the document");
});

test("assets mode: a refresh that fails keeps the config that LOADED, inside the ceiling", async () => {
  cold();
  const kv = memKV();
  const good = await W.loadConfig(T, { ASSETS: assets(), COMMENTS: kv });
  assert.deepEqual(good.USERS.map((u) => u.email), ["known@x.test"], "the fixture actually loaded");

  tick();
  const stale = await W.loadConfig(T, { ASSETS: assets("throw"), COMMENTS: kv });
  assert.ok(stale, "a workspace with a recent good config keeps serving it");
  assert.deepEqual(stale.USERS.map((u) => u.email), ["known@x.test"],
    "and it is the config that worked, not an empty one");
  assert.equal(stale.CONFIG_LOADED, true);
});

test("assets mode: past the staleness ceiling, a config that cannot be refreshed is refused", async () => {
  cold();
  const kv = memKV();
  await W.loadConfig(T, { ASSETS: assets(), COMMENTS: kv });

  // The reads have been failing for longer than the ceiling. The last good config has
  // stopped being a description of this workspace and become a photograph of it.
  W.__setConfigTestState({ cfgAt: 0, cfgGoodAt: Date.now() - (CEILING + 1) });
  assert.equal(await W.loadConfig(T, { ASSETS: assets("throw"), COMMENTS: kv }), null,
    "a config nobody can vouch for any more must stop being served");

  // And it heals the moment a read comes back — the refusal is a state, not a latch.
  W.__setConfigTestState({ cfgAt: 0, cfgGoodAt: Date.now() - (CEILING + 1) });
  const healed = await W.loadConfig(T, { ASSETS: assets(), COMMENTS: kv });
  assert.ok(healed && healed.CONFIG_LOADED, "a successful read restores service immediately");
});

test("bundle mode: the store going down on a COLD isolate is refused, not served empty", async () => {
  cold();
  const kv = memKV();
  const env = { GV_ASSET_SOURCE: "r2", BUNDLES: bundle(MANIFESTS, "throw"), COMMENTS: kv };
  assert.equal(await W.loadConfig(T, env), null,
    "every deployed instance serves in bundle mode — this is the branch the byte-level " +
    "snapshot cannot see, and it must fail closed");
});

test("bundle mode: a store outage keeps the last good config, then refuses past the ceiling", async () => {
  cold();
  const kv = memKV();
  const good = await W.loadConfig(T, {
    GV_ASSET_SOURCE: "r2", BUNDLES: bundle(MANIFESTS), COMMENTS: kv,
  });
  assert.deepEqual(good.USERS.map((u) => u.email), ["known@x.test"], "the fixture actually loaded");

  tick();
  const stale = await W.loadConfig(T, {
    GV_ASSET_SOURCE: "r2", BUNDLES: bundle(MANIFESTS, "throw"), COMMENTS: kv,
  });
  assert.deepEqual(stale.USERS.map((u) => u.email), ["known@x.test"],
    "a blip must not empty the roster");

  W.__setConfigTestState({ cfgAt: 0, cfgGoodAt: Date.now() - (CEILING + 1) });
  assert.equal(await W.loadConfig(T, {
    GV_ASSET_SOURCE: "r2", BUNDLES: bundle(MANIFESTS, "throw"), COMMENTS: kv,
  }), null, "an outage longer than the ceiling takes the workspace out of service");
});

test("bundle mode: a corrupt instance document is a FAILED read, and half of it is never applied", async () => {
  cold();
  const kv = memKV();
  const corrupt = bundle({ ...MANIFESTS, "config/instance.json": "{ not json at all" });
  assert.equal(await W.loadConfig(T, { GV_ASSET_SOURCE: "r2", BUNDLES: corrupt, COMMENTS: kv }), null,
    "a document that is there and will not parse is a broken store, not an empty one");
});

// ---- stamp-first survives the new failure path ---------------------------------------

test("stamp-first still holds when the failure ends in a refusal", async () => {
  cold();
  const kv = memKV();
  const broken = assets("throw");
  const answers = await Promise.all([
    W.loadConfig(T, { ASSETS: broken, COMMENTS: kv }),
    W.loadConfig(T, { ASSETS: broken, COMMENTS: kv }),
    W.loadConfig(T, { ASSETS: broken, COMMENTS: kv }),
    W.loadConfig(T, { ASSETS: broken, COMMENTS: kv }),
  ]);
  // One attempt = the two documents it reads in parallel. Four requests, two fetches —
  // a store that is refusing everything must not get one read per request just because
  // the request is now going to be refused too.
  assert.equal(broken.reads, 2, "the tick is stamped before the read, and before the classification");
  // The three that rode the fresh clock got the context in the slot, which on a cold
  // isolate is the empty one. That is the ONE hole this transitional shape still has and
  // it is the single-slot TENANT_CTX, not the failure path: see the note on its
  // declaration. What matters here is that the attempt was made once.
  assert.equal(answers[0], null, "the request that actually did the read is refused");
});

// ---- the guard that must be able to fire ---------------------------------------------

test("a second workspace finds no last-good in the slot and is refused rather than served this one's", async () => {
  cold();
  const kv = memKV();
  const good = await W.loadConfig(T, { ASSETS: assets(), COMMENTS: kv });
  assert.equal(good.tenantId, T);

  // A different workspace, on the same isolate, whose read fails. The last good context
  // in the slot belongs to someone else, and borrowing it is the leak this whole phase
  // exists to close — so the answer is a refusal, not a neighbour's roster.
  const other = await W.loadConfig("elsewhere", { ASSETS: assets("throw"), COMMENTS: kv });
  assert.equal(other, null, "one workspace's last good config is not another's");
});
