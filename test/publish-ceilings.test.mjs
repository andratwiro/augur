// Manifest ceilings (commit-time) + the etag manifest cache (request-time).
//
// Both exist because of the same measured incident: the 2026-08-22 cascade
// doubled one space's manifest and the instance started throwing 1102s — the
// refresh tick re-parsed multi-MB JSON on the request path, and nothing at the
// write path found a 533-prefix manifest suspicious. The wall (refuse insane
// manifests) and the diet (parse only when the etag moved) ship together.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

// The workspace this publish is for. publishApi reads its protocol floor, sentinels and
// workspace list off the context now, so the fixture names one rather than leaving the
// answer to whatever module scope was last written.
const CTX = W.applyInstance({ users: [] });

function memR2(initial = {}) {
  const store = new Map(Object.entries(initial));
  const etags = new Map();
  let heads = 0, gets = 0;
  const bump = (k) => etags.set(k, `"v${(Number(/v(\d+)/.exec(etags.get(k) || '"v0"')?.[1]) || 0) + 1}"`);
  for (const k of store.keys()) bump(k);
  return {
    store,
    stats: () => ({ heads, gets }),
    async get(k) { gets++; return store.has(k) ? { text: async () => store.get(k), etag: etags.get(k) } : null; },
    async put(k, v) { store.set(k, typeof v === "string" ? v : JSON.stringify(v)); bump(k); },
    async head(k) { heads++; return store.has(k) ? { etag: etags.get(k) } : null; },
    async list({ prefix = "", delimiter } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix));
      if (delimiter) {
        const set = new Set();
        for (const k of keys) {
          const rest = k.slice(prefix.length);
          const i = rest.indexOf(delimiter);
          if (i >= 0) set.add(prefix + rest.slice(0, i + 1));
        }
        return { objects: [], delimitedPrefixes: [...set], truncated: false };
      }
      return { objects: keys.map((k) => ({ key: k })), truncated: false };
    },
  };
}

const LIVE = {
  id: "alpha", version: 1, format: 1,
  space: { id: "alpha", default: true },
  source: { sha: "abc", dirty: false, actor: "x" },
  files: { "/toolkit/w/index.html": { h: "a".repeat(64), ct: "text/html", s: 10 } },
  routing: { publicPrefixes: ["/toolkit/w/"], versionMap: {} },
};
const envWithLive = () => ({
  BUNDLES: memR2({ "spaces/alpha/manifest.json": JSON.stringify(LIVE) }),
  PUBLISH_BOOTSTRAP_TOKEN: "tok",
});
const commit = (env, manifest) => W.publishApi(
  CTX,
  new Request("https://x.test/__publish/alpha/commit", {
    method: "POST",
    headers: { Authorization: "Bearer tok", "content-type": "application/json" },
    body: JSON.stringify(manifest),
  }),
  new URL("https://x.test/__publish/alpha/commit"),
  env);
const base = () => ({
  id: "alpha", format: 1,
  space: { id: "alpha", default: true },
  files: { ...LIVE.files },
  routing: { publicPrefixes: ["/toolkit/w/"], versionMap: {} },
});

// ── ceilings ─────────────────────────────────────────────────────────────────

test("a manifest sprouting conflict-fork prefixes is refused — the cascade signature", async () => {
  const m = base();
  for (let i = 0; i < 25; i++) {
    const u = `/toolkit/w-conflict-demo-${i}/`;
    m.routing.publicPrefixes.push(u);
    m.files[`${u}index.html`] = { h: "b".repeat(64), ct: "text/html", s: 5 };
  }
  const res = await commit(envWithLive(), m);
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.equal(body.error, "manifest-ceiling");
  assert.equal(body.limit, "conflict-prefixes");
});

test("a handful of legitimate conflict forks still commits (the ceiling is a wall, not a ban)", async () => {
  const env = envWithLive();
  await env.BUNDLES.put("blobs/" + "c".repeat(64), "x");
  const m = base();
  for (let i = 0; i < 3; i++) {
    const u = `/toolkit/w-conflict-someone-${i}/`;
    m.routing.publicPrefixes.push(u);
    m.files[`${u}index.html`] = { h: "c".repeat(64), ct: "text/html", s: 5 };
  }
  const res = await commit(env, m);
  assert.equal(res.status, 200);
});

test("a prefix-flood manifest is refused before it can poison the routing table", async () => {
  const m = base();
  for (let i = 0; i < 1100; i++) m.routing.publicPrefixes.push(`/toolkit/p${i}/`);
  const res = await commit(envWithLive(), m);
  assert.equal(res.status, 413);
  assert.equal((await res.json()).limit, "prefixes");
});

test("a file-flood manifest is refused", async () => {
  const m = base();
  for (let i = 0; i < 30_001; i++) m.files[`/toolkit/w/f${i}.txt`] = { h: "d".repeat(64), ct: "text/plain", s: 1 };
  const res = await commit(envWithLive(), m);
  assert.equal(res.status, 413);
  assert.equal((await res.json()).limit, "files");
});

test("a normal-size commit is untouched by the ceilings", async () => {
  const res = await commit(envWithLive(), base());
  assert.equal(res.status, 200);
});

// ── etag cache: parse only when the manifest actually changed ────────────────

test("the refresh tick re-parses a manifest only when its etag moved", async () => {
  const env = envWithLive();
  const first = await W.loadManifests(CTX.tenantId, env, true);
  assert.equal(first.alpha.version, 1);
  const g1 = env.BUNDLES.stats().gets;

  // Ticks with an unchanged etag must not re-fetch the body.
  await W.loadManifests(CTX.tenantId, env, true);
  await W.loadManifests(CTX.tenantId, env, true);
  assert.equal(env.BUNDLES.stats().gets, g1, "no body fetch while the etag is stable");

  // A publish bumps the etag — the next tick parses the new manifest.
  await commit(env, base());
  const after = await W.loadManifests(CTX.tenantId, env, true);
  assert.equal(after.alpha.version, 2, "etag moved → body re-fetched and parsed");
  assert.ok(env.BUNDLES.stats().gets > g1);
});
