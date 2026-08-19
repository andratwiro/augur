// A publish baked with a non-current engine must SUCCEED and trigger the shell's
// space-rebake (the instance repairs itself; the publisher is never refused or
// told about engine versions). Detection: manifest builtWith.engine vs the live
// _engine manifest's engine sha; missing builtWith (very old clients) counts as
// stale. The dispatch rides the existing shellDispatch channel and is debounced
// per space via KV so publish bursts don't stampede the shell.
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
function memKV() {
  const m = new Map();
  return { async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, v); } };
}

const ENGINE_SHA = "current777";
const LIVE = {
  id: "alpha", version: 4, format: 1,
  space: { id: "alpha", default: true },
  source: { sha: "abc123", dirty: false },
  builtWith: { engine: ENGINE_SHA },
  files: { "/toolkit/widgets/index.html": { h: "a".repeat(64), ct: "text/html", s: 10 } },
  routing: { publicPrefixes: ["/toolkit/widgets/"], versionMap: {} },
};
const ENGINE_M = {
  id: "_engine", version: 9, format: 1,
  source: { sha: ENGINE_SHA },
  builtWith: { engine: ENGINE_SHA, version: "0.13.0" },
  files: {}, routing: {},
};
const NEXT = {
  id: "alpha", format: 1, files: LIVE.files,
  space: { id: "alpha", default: true },
  routing: { publicPrefixes: ["/toolkit/widgets/"], versionMap: {} },
};

const baseEnv = (extra = {}) => ({
  BUNDLES: memR2({
    "spaces/alpha/manifest.json": JSON.stringify(LIVE),
    "spaces/_engine/manifest.json": JSON.stringify(ENGINE_M),
  }),
  PUBLISH_BOOTSTRAP_TOKEN: "tok",
  DELETE_DISPATCH_URL: "https://gh.test/dispatches",
  DELETE_DISPATCH_TOKEN: "t",
  ...extra,
});

const commit = (env, manifest, space = "alpha") => W.publishApi(
  new Request(`https://x.test/__publish/${space}/commit`, {
    method: "POST",
    headers: { Authorization: "Bearer tok", "content-type": "application/json" },
    body: JSON.stringify(manifest),
  }),
  new URL(`https://x.test/__publish/${space}/commit`),
  env);

function captureFetch() {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response(null, { status: 204 }); };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

test("a publish with no builtWith stamp succeeds AND dispatches space-rebake", async () => {
  const f = captureFetch();
  try {
    const res = await commit(baseEnv(), NEXT);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.rebake, "dispatched");
    assert.equal(f.calls.length, 1);
    const sent = JSON.parse(f.calls[0].init.body);
    assert.equal(sent.event_type, "space-rebake");
    assert.equal(sent.client_payload.space, "alpha");
    assert.equal(sent.client_payload.engine, ENGINE_SHA);
  } finally { f.restore(); }
});

test("a publish baked with an OLD engine sha dispatches; a current one does not", async () => {
  const f = captureFetch();
  try {
    const stale = await commit(baseEnv(), { ...NEXT, builtWith: { engine: "old111" } });
    assert.equal((await stale.json()).rebake, "dispatched");
    const fresh = await commit(baseEnv(), { ...NEXT, builtWith: { engine: ENGINE_SHA } });
    const body = await fresh.json();
    assert.equal(body.ok, true);
    assert.equal("rebake" in body, false, "current bake: nothing to heal, no field");
    assert.equal(f.calls.length, 1, "only the stale commit dispatched");
  } finally { f.restore(); }
});

test("builtWith is persisted; the dispatch happens after the manifest is live", async () => {
  const f = captureFetch();
  try {
    const env = baseEnv();
    await commit(env, { ...NEXT, builtWith: { engine: "old111" } });
    const after = JSON.parse(env.BUNDLES.store.get("spaces/alpha/manifest.json"));
    assert.equal(after.builtWith.engine, "old111",
      "the stale stamp is recorded — it is what the shell's drift check reads");
  } finally { f.restore(); }
});

test("_engine commits never dispatch (the shell's own publish is the convergence signal)", async () => {
  const f = captureFetch();
  try {
    const res = await commit(baseEnv(), {
      id: "_engine", format: 1, files: {}, routing: {},
      builtWith: { engine: "newer888", version: "0.13.0" },
    }, "_engine");
    assert.equal(res.status, 200);
    assert.equal(f.calls.length, 0);
  } finally { f.restore(); }
});

test("no _engine manifest in the store (fresh instance): no dispatch, publish unaffected", async () => {
  const f = captureFetch();
  try {
    const env = baseEnv();
    env.BUNDLES.store.delete("spaces/_engine/manifest.json");
    const res = await commit(env, NEXT);
    assert.equal(res.status, 200);
    assert.equal(f.calls.length, 0);
  } finally { f.restore(); }
});

test("KV debounce: a second stale publish inside the window does not re-dispatch", async () => {
  const f = captureFetch();
  try {
    const env = baseEnv({ COMMENTS: memKV() });
    await commit(env, { ...NEXT, builtWith: { engine: "old111" } });
    const second = await commit(env, { ...NEXT, builtWith: { engine: "old111" } });
    assert.equal((await second.json()).rebake, "debounced");
    assert.equal(f.calls.length, 1);
  } finally { f.restore(); }
});

test("dispatch channel unconfigured: publish still succeeds and says so", async () => {
  const env = baseEnv({ DELETE_DISPATCH_URL: "", DELETE_DISPATCH_TOKEN: "" });
  const res = await commit(env, NEXT);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).rebake, "unconfigured");
});

test("check reports liveBuiltWith, so a re-bake with identical output can restamp instead of skipping", async () => {
  // Without this field the client's "unchanged — commit skipped" fires even when
  // the live bake came from a DIFFERENT engine that happens to produce identical
  // bytes — leaving builtWithEngine stale forever and the drift alarm crying wolf.
  const res = await W.publishApi(
    new Request("https://x.test/__publish/alpha/check", {
      method: "POST",
      headers: { Authorization: "Bearer tok", "content-type": "application/json" },
      body: JSON.stringify({ files: LIVE.files }),
    }),
    new URL("https://x.test/__publish/alpha/check"),
    baseEnv());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.filesUnchanged, true);
  assert.equal(body.liveBuiltWith, ENGINE_SHA);
});
