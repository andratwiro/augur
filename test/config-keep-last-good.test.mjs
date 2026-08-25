// The config load is fail-open-STALE, and this is what says so out loud.
//
// Two properties hold the hot path together, and neither is visible in a response
// snapshot of a healthy instance — they only show themselves when a read breaks:
//
//   STAMP-FIRST     the tick is marked BEFORE the read, so a config document that is
//                   broken costs one attempt per 1.5s tick and not one per concurrent
//                   request. Without it, every request behind a slow or failing store
//                   queues up its own read of the same broken document.
//   KEEP-LAST-GOOD  a read that fails contributes NOTHING. The users, the public
//                   prefixes and the version map that were working stay working. The
//                   failure mode this exists to stop is a transient store blip emptying
//                   the roster, which locks every person out of a healthy site.
//
// The counterweight is the opposite rule and lives in the same place: a COLD isolate
// whose FIRST read fails has no last-good to keep, so it must fail CLOSED rather than
// look like a raw build with no identity. That one is pinned by the cold-isolate case in
// test/response-snapshot.test.mjs; here we pin its other half, that a warm isolate does
// not throw away a gate that works.
//
// Both serving modes are covered on purpose. The response snapshot corpus runs in ASSETS
// mode, so the bundle branch — which is what every deployed instance actually runs — has
// no byte-level baseline watching it at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

const T = W.DEFAULT_TENANT_ID;

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
  users: [{ email: "known@x.test", name: "Known", role: "admin" }],
  loginHint: "the hint", minClientProtocol: 4,
};
const ROUTING = {
  buildId: "build-1",
  publicPrefixes: ["/open/"],
  versionMap: { "/open/": "v-open" },
  spaces: [{ id: "one", name: "One", default: true }],
};

// An ASSETS binding that can be told to break. `reads` counts the config fetches, which
// is how stamp-first is measured.
function assetsBinding({ fail = false } = {}) {
  const o = {
    reads: 0,
    async fetch(u) {
      o.reads += 1;
      if (fail) throw new Error("config read down");
      const p = new URL(typeof u === "string" ? u : u.url).pathname;
      if (p === "/__config/instance.json") return new Response(JSON.stringify(INSTANCE), { status: 200 });
      if (p === "/__config/routing.json") return new Response(JSON.stringify(ROUTING), { status: 200 });
      return new Response("Not Found", { status: 404 });
    },
  };
  return o;
}

// The bundle store, same trick.
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
function bundleBinding(seed, { fail = false } = {}) {
  const store = new Map(Object.entries(seed));
  return {
    async get(k) {
      if (fail) throw new Error("store down");
      return store.has(k) ? { text: async () => store.get(k) } : null;
    },
    async list() {
      if (fail) throw new Error("store down");
      return { objects: [], delimitedPrefixes: ["spaces/one/"], truncated: false };
    },
    async head(k) {
      if (fail) throw new Error("store down");
      return store.has(k) ? { etag: "etag-" + k } : null;
    },
  };
}

// What a request would actually see: who can sign in, what the gate opens, what version
// a page is told it is. Comparing this whole shape is the point — a partial apply that
// updated one field and not another would show up as a difference here.
const served = () => ({
  users: W.__usersNow().map((u) => u.email).sort(),
  openPath: W.isPublicPath("/open/thing.html"),
  gatedPath: W.isPublicPath("/internal/thing.html"),
  version: W.versionFor("/open/"),
  fallbackVersion: W.versionFor("/not-in-the-map"),
});

test("assets mode: a read that fails leaves the working gate exactly as it was", async () => {
  const kv = memKV();
  W.__setConfigTestState({ cfgAt: 0, rosterReadAt: 0 });
  await W.loadConfig(T, { ASSETS: assetsBinding(), COMMENTS: kv });
  const good = served();
  assert.deepEqual(good.users, ["known@x.test"], "the fixture actually loaded");
  assert.equal(good.openPath, true);
  assert.equal(good.version, "v-open");

  // The very next tick: the config documents are unreadable.
  W.__setConfigTestState({ cfgAt: 0 });
  await W.loadConfig(T, { ASSETS: assetsBinding({ fail: true }), COMMENTS: kv });
  assert.deepEqual(served(), good, "a transient read failure must not wipe a working gate");

  // ...and the instance heals on its own when the read comes back.
  W.__setConfigTestState({ cfgAt: 0 });
  await W.loadConfig(T, { ASSETS: assetsBinding(), COMMENTS: kv });
  assert.deepEqual(served(), good);
});

test("assets mode: a 404 or a non-JSON document contributes nothing either", async () => {
  const kv = memKV();
  W.__setConfigTestState({ cfgAt: 0, rosterReadAt: 0 });
  await W.loadConfig(T, { ASSETS: assetsBinding(), COMMENTS: kv });
  const good = served();

  // Not a throw — a 200 that is not JSON, and a 404. grab() answers null for both.
  const junk = {
    reads: 0,
    async fetch() { this.reads += 1; return new Response("<html>a login page, not config</html>", { status: 200 }); },
  };
  W.__setConfigTestState({ cfgAt: 0 });
  await W.loadConfig(T, { ASSETS: junk, COMMENTS: kv });
  assert.deepEqual(served(), good, "an unparseable document is not an empty document");

  const gone = { reads: 0, async fetch() { this.reads += 1; return new Response("Not Found", { status: 404 }); } };
  W.__setConfigTestState({ cfgAt: 0 });
  await W.loadConfig(T, { ASSETS: gone, COMMENTS: kv });
  assert.deepEqual(served(), good, "a missing document is not an empty document");
});

test("stamp-first: concurrent requests behind a broken read cost ONE attempt, not one each", async () => {
  const kv = memKV();
  const broken = assetsBinding({ fail: true });
  W.__setConfigTestState({ cfgAt: 0, rosterReadAt: 0 });
  await Promise.all([
    W.loadConfig(T, { ASSETS: broken, COMMENTS: kv }),
    W.loadConfig(T, { ASSETS: broken, COMMENTS: kv }),
    W.loadConfig(T, { ASSETS: broken, COMMENTS: kv }),
    W.loadConfig(T, { ASSETS: broken, COMMENTS: kv }),
  ]);
  // One attempt = the two documents it reads in parallel. Four requests, two fetches.
  assert.equal(broken.reads, 2, "the tick is stamped before the read, so the rest of the tick is free");

  // The next tick tries again — a stamp, not a permanent give-up.
  W.__setConfigTestState({ cfgAt: 0 });
  await W.loadConfig(T, { ASSETS: broken, COMMENTS: kv });
  assert.equal(broken.reads, 4, "a failed read retries on the next tick");
});

test("bundle mode: the store going down keeps the last good config", async () => {
  const kv = memKV();
  W.__setConfigTestState({ cfgAt: 0, rosterReadAt: 0 });
  await W.loadConfig(T, { GV_ASSET_SOURCE: "r2", BUNDLES: bundleBinding(MANIFESTS), COMMENTS: kv });
  const good = served();
  assert.deepEqual(good.users, ["known@x.test"], "the fixture actually loaded");
  assert.equal(good.openPath, true);
  assert.equal(good.version, "v-open");

  W.__setConfigTestState({ cfgAt: 0 });
  await W.loadConfig(T, { GV_ASSET_SOURCE: "r2", BUNDLES: bundleBinding(MANIFESTS, { fail: true }), COMMENTS: kv });
  assert.deepEqual(served(), good, "a store outage must not empty the roster or close the public doors");
});

test("bundle mode: a corrupt instance document changes nothing, routing included", async () => {
  const kv = memKV();
  W.__setConfigTestState({ cfgAt: 0, rosterReadAt: 0 });
  await W.loadConfig(T, { GV_ASSET_SOURCE: "r2", BUNDLES: bundleBinding(MANIFESTS), COMMENTS: kv });
  const good = served();

  // The parse throws inside the load's try, so routing is not derived on this tick
  // either — all of it or none of it, never half a routing table.
  const corrupt = bundleBinding({ ...MANIFESTS, "config/instance.json": "{ not json at all" });
  W.__setConfigTestState({ cfgAt: 0 });
  await W.loadConfig(T, { GV_ASSET_SOURCE: "r2", BUNDLES: corrupt, COMMENTS: kv });
  assert.deepEqual(served(), good, "a half-written config document must not be half-applied");
});

test("the KV overlay failing leaves the config roster, never an empty one", async () => {
  const angryKV = {
    async get() { throw new Error("KV down"); },
    async put() { throw new Error("KV down"); },
    async delete() { throw new Error("KV down"); },
  };
  W.__setConfigTestState({ cfgAt: 0, rosterReadAt: 0 });
  await W.loadConfig(T, { ASSETS: assetsBinding(), COMMENTS: angryKV });
  assert.deepEqual(
    W.__usersNow().map((u) => u.email), ["known@x.test"],
    "the overlay is a convenience; the config roster is what remains when it cannot be read",
  );
});
