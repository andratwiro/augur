// The _engine pseudo-space is the whole instance's chrome, service worker, and
// the runtime-chrome switch itself. A star-token publish from a stale clone used
// to be able to rewrite it from a tree that predates those files — /sw.js and
// /_chrome.* 404 site-wide and routing loses `chrome`/`runtimeChrome`, silently
// switching serve-time composition OFF. _engine skips the client-side reconcile
// and has no publicPrefixes for the unpublish guard, so the commit path is the
// only chokepoint. Same idea one level up: a stale --all also POSTs its old
// instance.json over /__publish/_instance/config.
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

const H = "b".repeat(64);
const LIVE_ENGINE = {
  id: "_engine", version: 9, format: 1,
  source: { sha: "current777" },
  builtWith: { engine: "current777", version: "0.13.0" },
  files: {
    "/sw.js": { h: H, ct: "text/javascript", s: 5 },
    "/_chrome.1.14.abc12345.css": { h: H, ct: "text/css", s: 5 },
    "/_chrome.1.14.abc12345.js": { h: H, ct: "text/javascript", s: 5 },
    "/index.html": { h: H, ct: "text/html", s: 5 },
  },
  routing: { chrome: { css: "_chrome.1.14.abc12345.css", js: "_chrome.1.14.abc12345.js", ui: "1.14" }, runtimeChrome: true },
};

const envWith = (extra = {}) => ({
  BUNDLES: memR2({ "spaces/_engine/manifest.json": JSON.stringify(LIVE_ENGINE), ...extra }),
  PUBLISH_BOOTSTRAP_TOKEN: "tok",
});

const commitEngine = (env, manifest) => W.publishApi(
  new Request("https://x.test/__publish/_engine/commit", {
    method: "POST",
    headers: { Authorization: "Bearer tok", "content-type": "application/json" },
    body: JSON.stringify(manifest),
  }),
  new URL("https://x.test/__publish/_engine/commit"),
  env);

test("a pre-bundle engine tree (no sw.js, no _chrome.*, no routing.chrome) is refused", async () => {
  const env = envWith();
  const res = await commitEngine(env, {
    id: "_engine", format: 1,
    files: { "/index.html": { h: H, ct: "text/html", s: 5 } },
    routing: {},
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, "engine-downgrade");
  assert.ok(body.drops.includes("/sw.js"));
  assert.ok(body.drops.includes("/_chrome.*"));
  assert.ok(body.drops.includes("routing.chrome"));
  assert.ok(body.drops.includes("routing.runtimeChrome"));
  const after = JSON.parse(env.BUNDLES.store.get("spaces/_engine/manifest.json"));
  assert.equal(after.version, 9, "refused means nothing shipped");
});

test("a normal engine UPDATE passes — new bundle hashes are not 'drops'", async () => {
  const env = envWith();
  const res = await commitEngine(env, {
    id: "_engine", format: 1,
    builtWith: { engine: "newer888", version: "0.13.0" },
    files: {
      "/sw.js": { h: H, ct: "text/javascript", s: 5 },
      "/_chrome.1.15.def67890.css": { h: H, ct: "text/css", s: 5 },
      "/_chrome.1.15.def67890.js": { h: H, ct: "text/javascript", s: 5 },
      "/index.html": { h: H, ct: "text/html", s: 5 },
    },
    routing: { chrome: { css: "_chrome.1.15.def67890.css", js: "_chrome.1.15.def67890.js", ui: "1.15" }, runtimeChrome: true },
  });
  assert.equal(res.status, 200);
});

test("a semver-older engine is refused even when its files look complete", async () => {
  const env = envWith();
  const res = await commitEngine(env, {
    id: "_engine", format: 1,
    builtWith: { engine: "old111", version: "0.12.0" },
    files: LIVE_ENGINE.files,
    routing: LIVE_ENGINE.routing,
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, "engine-downgrade");
  assert.equal(body.live, "0.13.0");
  assert.equal(body.publishing, "0.12.0");
});

test("rollback on _engine still works — the audited escape hatch", async () => {
  const env = envWith({ "spaces/_engine/versions/8.json": JSON.stringify({ ...LIVE_ENGINE, version: 8 }) });
  const res = await W.publishApi(
    new Request("https://x.test/__publish/_engine/rollback", {
      method: "POST",
      headers: { Authorization: "Bearer tok", "content-type": "application/json" },
      body: JSON.stringify({ version: 8 }),
    }),
    new URL("https://x.test/__publish/_engine/rollback"),
    env);
  assert.equal(res.status, 200);
});

const postConfig = (env, cfg) => W.publishApi(
  new Request("https://x.test/__publish/_instance/config", {
    method: "POST",
    headers: { Authorization: "Bearer tok", "content-type": "application/json" },
    body: JSON.stringify(cfg),
  }),
  new URL("https://x.test/__publish/_instance/config"),
  env);

test("an instance-config push with an older (or missing) engineVersion is refused; same-or-newer passes", async () => {
  const mk = () => envWith({ "config/instance.json": JSON.stringify({ engineVersion: "0.13.0", users: [] }) });
  assert.equal((await postConfig(mk(), { engineVersion: "0.12.0", users: [] })).status, 409);
  assert.equal((await postConfig(mk(), { users: [] })).status, 409);
  assert.equal((await postConfig(mk(), { engineVersion: "0.13.0", users: [] })).status, 200);
  assert.equal((await postConfig(mk(), { engineVersion: "0.14.0", users: [] })).status, 200);
});

test("a live config with no engineVersion accepts anything (nothing to compare)", async () => {
  const env = envWith({ "config/instance.json": JSON.stringify({ users: [] }) });
  assert.equal((await postConfig(env, { users: [] })).status, 200);
});
