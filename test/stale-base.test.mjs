// The stale-base check: a commit may declare the live version it was computed
// against (`baseVersion`), and the store refuses when live has moved past it.
//
// This is the server half of conflict-aware publishing. The client-side
// classification (publish-conflict.test.mjs) decides what to adopt or fork, but
// only the store knows what is live at the instant of the commit — between a
// client's check and its commit someone else may have published. The field is
// optional (older clients never send it) and transport-only (never persisted),
// exactly like allowUnpublish.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

function memR2(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(k) { return store.has(k) ? { text: async () => store.get(k), body: store.get(k) } : null; },
    async put(k, v) { store.set(k, typeof v === "string" ? v : JSON.stringify(v)); },
    async head(k) { return store.has(k) ? {} : null; },
    async list({ prefix = "" } = {}) {
      return { objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ key: k })), truncated: false };
    },
  };
}

const LIVE = {
  id: "alpha", version: 4, format: 1,
  space: { id: "alpha", default: true },
  source: { sha: "abc123", dirty: true, actor: "someone" },
  files: { "/toolkit/widgets/index.html": { h: "a".repeat(64), ct: "text/html", s: 10 } },
  routing: { publicPrefixes: ["/toolkit/widgets/"], versionMap: {} },
};

const envWithLive = () => ({
  BUNDLES: memR2({ "spaces/alpha/manifest.json": JSON.stringify(LIVE) }),
  PUBLISH_BOOTSTRAP_TOKEN: "tok",
});

const commit = (env, manifest) => W.publishApi(
  new Request("https://x.test/__publish/alpha/commit", {
    method: "POST",
    headers: { Authorization: "Bearer tok", "content-type": "application/json" },
    body: JSON.stringify(manifest),
  }),
  new URL("https://x.test/__publish/alpha/commit"),
  env);

const NEXT = {
  id: "alpha", format: 1, files: LIVE.files,
  space: { id: "alpha", default: true },
  routing: { publicPrefixes: ["/toolkit/widgets/"], versionMap: {} },
};

test("a commit whose baseVersion matches live goes through, and the field is never persisted", async () => {
  const env = envWithLive();
  const res = await commit(env, { ...NEXT, baseVersion: 4 });
  assert.equal(res.status, 200);
  const after = JSON.parse(env.BUNDLES.store.get("spaces/alpha/manifest.json"));
  assert.equal(after.version, 5);
  assert.equal("baseVersion" in after, false, "transport-only, like allowUnpublish");
  assert.equal("baseVersion" in JSON.parse(env.BUNDLES.store.get("spaces/alpha/versions/5.json")), false);
});

test("a commit computed against a version live has moved past is refused with the live state", async () => {
  const env = envWithLive();
  const res = await commit(env, { ...NEXT, baseVersion: 3 });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, "stale-base");
  assert.equal(body.liveVersion, 4);
  assert.deepEqual(body.liveSource, { sha: "abc123", dirty: true },
    "the refusal carries what the client needs to re-evaluate: whose work is live, and whether git can reach it");
  const after = JSON.parse(env.BUNDLES.store.get("spaces/alpha/manifest.json"));
  assert.equal(after.version, 4, "refused means nothing shipped");
});

test("a client that never sends baseVersion commits exactly as before", async () => {
  const env = envWithLive();
  const res = await commit(env, NEXT);
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(env.BUNDLES.store.get("spaces/alpha/manifest.json")).version, 5);
});

test("first publish into an empty store: baseVersion 0 passes, anything else is stale", async () => {
  // files: {} — blob spot-validation is not what's under test here.
  const first = { ...NEXT, files: {} };
  const fresh = () => ({ BUNDLES: memR2(), PUBLISH_BOOTSTRAP_TOKEN: "tok" });
  assert.equal((await commit(fresh(), { ...first, baseVersion: 0 })).status, 200);
  const res = await commit(fresh(), { ...first, baseVersion: 5 });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).liveVersion, 0);
});

test("staleness is reported before the unpublish guard — reconcile first, then decide removals", async () => {
  // A stale tree often ALSO drops pages. The client's next move differs: stale-base
  // means "re-evaluate against live" (after which the removal usually disappears),
  // while unpublish-refused means "you are removing pages on purpose or not at all".
  const env = envWithLive();
  const res = await commit(env, { ...NEXT, routing: { publicPrefixes: [], versionMap: {} }, baseVersion: 3 });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "stale-base");
});

test("the check response now speaks protocol 3", async () => {
  const env = envWithLive();
  const res = await W.publishApi(
    new Request("https://x.test/__publish/alpha/check", {
      method: "POST",
      headers: { Authorization: "Bearer tok", "content-type": "application/json" },
      body: JSON.stringify({ files: {} }),
    }),
    new URL("https://x.test/__publish/alpha/check"),
    env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).protocol, 3);
});
