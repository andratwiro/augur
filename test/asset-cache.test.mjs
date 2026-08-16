// Cache headers on store-served assets.
//
// The bug these describe: assetFetch() used to return bundle-mode responses with
// Content-Type, ETag and Accept-Ranges but NO Cache-Control, on the assumption that
// "no header" means "not cached". It does not. A header-less response takes the
// CDN's own default TTL, which is keyed on the file extension and is four hours for
// the static ones — so a republished prototype served new HTML (not a cached
// extension) alongside up-to-four-hour-stale .js/.css/.svg/.png, with no way to bust
// it, because none of those URLs carry a version. `/space-icon.png` was the same lie
// with a friendlier face: change a workspace icon, see the old one for four hours.
//
// So the invariant is not "some particular max-age". It is: EVERY store response
// carries an explicit Cache-Control, and an un-versioned one revalidates.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

const PNG = { h: "a".repeat(64), ct: "image/png", s: 3 };
const JS = { h: "b".repeat(64), ct: "application/javascript; charset=utf-8", s: 3 };
const HTML = { h: "c".repeat(64), ct: "text/html; charset=utf-8", s: 3 };

// A minimal R2 stand-in: one space, three files, blobs that answer with their bytes.
function bundleEnv() {
  const manifest = {
    id: "demo",
    files: { "/space-icon.png": PNG, "/p/app.js": JS, "/p/index.html": HTML },
    space: { id: "demo", default: true },
    routing: { publicPrefixes: ["/p/"], versionMap: {}, shellSig: "sig" },
  };
  return {
    GV_ASSET_SOURCE: "r2",
    BUNDLES: {
      list: async () => ({ delimitedPrefixes: ["spaces/demo/"] }),
      get: async (key) =>
        key === "spaces/demo/manifest.json"
          ? { text: async () => JSON.stringify(manifest) }
          : key.startsWith("blobs/")
            ? { body: "xxx" }
            : null,
    },
  };
}

const get = (env, path, headers) =>
  W.assetFetch(env, new Request("https://example.test" + path, { headers }));

// ---- the invariant --------------------------------------------------------

test("a store-served asset always carries an explicit Cache-Control", async () => {
  const env = bundleEnv();
  for (const p of ["/space-icon.png", "/p/app.js", "/p/index.html"]) {
    const res = await get(env, p);
    assert.equal(res.status, 200, p);
    assert.ok(res.headers.get("Cache-Control"), `${p} was served with no Cache-Control`);
  }
});

test("an un-versioned asset revalidates rather than going stale", async () => {
  const res = await get(bundleEnv(), "/space-icon.png");
  const cc = res.headers.get("Cache-Control");
  assert.equal(cc, W.ASSET_REVALIDATE);
  // The point of the header, stated as behaviour rather than as a string: a cache
  // must check with us before reusing it. Any rewrite that keeps a bare max-age
  // over zero seconds reopens the four-hour window this file exists to close.
  assert.match(cc, /no-cache|max-age=0/);
  assert.doesNotMatch(cc, /immutable/);
});

test("the ETag still answers a conditional request with a 304", async () => {
  const env = bundleEnv();
  const res = await get(env, "/space-icon.png", { "If-None-Match": `"${PNG.h}"` });
  assert.equal(res.status, 304);
  // The 304 refreshes the client's freshness record. Without the header here a
  // copy cached from an earlier 200 just ages back into staleness.
  assert.equal(res.headers.get("Cache-Control"), W.ASSET_REVALIDATE);
  assert.equal(res.headers.get("ETag"), `"${PNG.h}"`);
});

// ---- withAssetCache only ever upgrades ------------------------------------

test("a versioned URL is still promoted to a year + immutable", async () => {
  const env = bundleEnv();
  const url = new URL("https://example.test/p/app.js?v=123");
  const out = W.withAssetCache(await get(env, "/p/app.js"), url);
  assert.match(out.headers.get("Cache-Control"), /max-age=31536000/);
  assert.match(out.headers.get("Cache-Control"), /immutable/);
});

test("withAssetCache leaves an un-versioned asset's revalidation intact", async () => {
  const env = bundleEnv();
  const url = new URL("https://example.test/space-icon.png");
  const out = W.withAssetCache(await get(env, "/space-icon.png"), url);
  assert.equal(out.headers.get("Cache-Control"), W.ASSET_REVALIDATE);
});
