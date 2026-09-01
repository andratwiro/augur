// Chrome tracks the worker automatically (D-chrome-auto-on-deploy).
//
// The shared _engine chrome (rail, switcher, /admin, /sw.js) used to be republished to R2
// by per-instance CI on every engine bump. The shared-worker migration removed that CI, so
// the R2 _engine bundle can lag the deployed worker: /_build.json reports the last CHROME
// publish rather than the running code, and a switcher shipped in a worker deploy stays
// invisible until someone runs a manual chrome refresh.
//
// The fix serves _engine from the worker's OWN assets (engine/dist — what wrangler uploads
// in lockstep with the worker), so chrome can never lag. The R2 chrome-refresh verb
// (D-chrome-refresh-fanout) is kept as an override for the rare case R2 chrome is
// deliberately pushed AHEAD of a worker deploy: the two are ordered by wall clock, the
// assets manifest's `builtAt` against R2's `publishedAt`, newer wins.
//
// assetFetch() is the shared serving path for every request and every workspace, so these
// drive it directly with a fake R2 + a fake ASSETS binding and assert BOTH which source
// answered and — via a blob-read spy — that R2 is not even consulted when assets win.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

const CHROME_PATHS = ["/admin/index.html", "/sw.js"];

// A file record shaped like a manifest entry. The hash differs per source so a served body
// (keyed by hash in R2) can be told apart from the assets copy (served by path).
const rec = (tag) => ({ h: tag.repeat(64).slice(0, 64), ct: "text/html; charset=utf-8", s: 3 });

function engineManifest({ src, kind }) {
  // `src` distinguishes the two builds; `kind` is "assets" (carries builtAt, no publish
  // provenance) or "r2" (carries publishedAt + source.sha, the shape a publish stamps).
  const files = {};
  for (const p of CHROME_PATHS) files[p] = rec(src === "new" ? "n" : "o");
  const m = {
    id: "_engine",
    files,
    routing: { chrome: { css: `_chrome.${src}.css`, js: `_chrome.${src}.js`, ui: "1.16", stamp: src }, runtimeChrome: true },
    builtWith: { engine: src === "new" ? "n".repeat(40) : "o".repeat(40), version: "0.15.0" },
  };
  if (kind === "assets") m.builtAt = src === "new" ? "2026-08-31T12:00:00.000Z" : "2026-08-01T12:00:00.000Z";
  else { m.publishedAt = src === "new" ? "2026-08-31T12:00:00.000Z" : "2026-08-01T12:00:00.000Z"; m.source = { sha: (src === "new" ? "n" : "o").repeat(40) }; }
  return m;
}

// A space manifest, so there is always a non-_engine space present too.
const SPACE = {
  id: "demo", space: { id: "demo", default: true },
  files: { "/p/index.html": rec("d") },
  routing: { publicPrefixes: ["/p/"], versionMap: {}, shellSig: "sig" },
};

// A bundle env: R2 with an optional _engine manifest at a chosen build, an ASSETS binding
// serving its own _engine manifest at a chosen build plus the chrome files by path. Records
// every `blobs/` read so a test can prove R2 was skipped.
function bundleEnv({ r2Engine, assetsEngine, withAssets = true } = {}) {
  const blobReads = [];
  const r2Manifests = { "spaces/demo/manifest.json": SPACE };
  const prefixes = ["spaces/demo/"];
  if (r2Engine) { r2Manifests["spaces/_engine/manifest.json"] = r2Engine; prefixes.push("spaces/_engine/"); }
  const env = {
    GV_ASSET_SOURCE: "r2",
    BUNDLES: {
      list: async () => ({ objects: [], delimitedPrefixes: [...prefixes], truncated: false }),
      get: async (key) => {
        if (key.startsWith("blobs/")) { blobReads.push(key); return { body: "xxx" }; }
        const m = r2Manifests[key];
        return m ? { text: async () => JSON.stringify(m) } : null;
      },
    },
  };
  if (withAssets) env.ASSETS = {
    fetch: async (input) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      if (url.pathname === "/__manifests/_engine.json") {
        return assetsEngine
          ? new Response(JSON.stringify(assetsEngine), { status: 200 })
          : new Response("Not Found", { status: 404 });
      }
      if (CHROME_PATHS.includes(url.pathname)) {
        return new Response("ASSETS:" + url.pathname, { status: 200, headers: { "Content-Type": "text/html" } });
      }
      return new Response("Not Found", { status: 404 });
    },
  };
  return { env, blobReads };
}

// Distinct tenant per case: loadManifests caches per-tenant for ~1.5s, and these cases
// differ in what _engine holds, so sharing one id would serve a stale view.
let seq = 0;
const tenant = () => `chrome-auto-${seq++}`;
const req = (p) => new Request("https://example.test" + p);

test("assets win when they are the newer build: _engine served from ASSETS, R2 blob never read", async () => {
  const { env, blobReads } = bundleEnv({
    r2Engine: engineManifest({ src: "old", kind: "r2" }),
    assetsEngine: engineManifest({ src: "new", kind: "assets" }),
  });
  const t = tenant();
  const res = await W.assetFetch(t, env, req("/admin/index.html"));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "ASSETS:/admin/index.html", "chrome came from the assets binding, not R2");
  assert.equal(blobReads.length, 0, "R2 blob store was consulted for a path the assets copy owns");

  const manifests = await W.loadManifests(t, env);
  assert.equal(manifests._engine.__fromAssets, true, "_engine is flagged as coming from assets");
  assert.equal(manifests._engine.routing.chrome.js, "_chrome.new.js", "the chrome pointer follows the deployed worker");

  const stamp = W.synthBuildStamp({ USERS: [] }, manifests);
  assert.equal(stamp.engine.sha, "n".repeat(40), "/_build.json reports the DEPLOYED worker's sha, not a stale one");
});

test("R2 wins when a chrome-refresh published it after the worker shipped: served from R2", async () => {
  const { env, blobReads } = bundleEnv({
    r2Engine: engineManifest({ src: "new", kind: "r2" }),      // published later
    assetsEngine: engineManifest({ src: "old", kind: "assets" }), // deployed earlier
  });
  const t = tenant();
  const res = await W.assetFetch(t, env, req("/admin/index.html"));
  assert.equal(res.status, 200);
  assert.notEqual(await res.text(), "ASSETS:/admin/index.html", "R2 override was ignored");
  assert.equal(blobReads.length, 1, "the R2 blob backing the newer chrome was read");

  const manifests = await W.loadManifests(t, env);
  assert.ok(!manifests._engine.__fromAssets, "R2 is authoritative, so nothing is flagged from assets");
  assert.equal(manifests._engine.routing.chrome.js, "_chrome.new.js");
  const stamp = W.synthBuildStamp({ USERS: [] }, manifests);
  assert.equal(stamp.engine.sha, "n".repeat(40), "the R2 publish's own source.sha");
});

test("assets win when R2 has no _engine bundle at all (a self-hoster who only ships chrome to assets)", async () => {
  const { env, blobReads } = bundleEnv({
    r2Engine: null,
    assetsEngine: engineManifest({ src: "new", kind: "assets" }),
  });
  const t = tenant();
  const res = await W.assetFetch(t, env, req("/sw.js"));
  assert.equal(await res.text(), "ASSETS:/sw.js");
  assert.equal(blobReads.length, 0);
  const manifests = await W.loadManifests(t, env);
  assert.equal(manifests._engine.__fromAssets, true);
});

test("an assets manifest with no builtAt never wins — byte-for-byte the old behaviour", async () => {
  // An engine built before this landed carries no `builtAt`, so it cannot be ordered
  // against R2 and must not be preferred: R2 stays authoritative until the worker is
  // redeployed with a stamping build.
  const oldAssets = engineManifest({ src: "new", kind: "assets" });
  delete oldAssets.builtAt;
  const { env, blobReads } = bundleEnv({
    r2Engine: engineManifest({ src: "old", kind: "r2" }),
    assetsEngine: oldAssets,
  });
  const t = tenant();
  const res = await W.assetFetch(t, env, req("/admin/index.html"));
  assert.notEqual(await res.text(), "ASSETS:/admin/index.html");
  assert.equal(blobReads.length, 1, "R2 still serves the chrome");
  const manifests = await W.loadManifests(t, env);
  assert.ok(!manifests._engine.__fromAssets);
});

test("a space's own content never takes the assets branch, even when assets win for _engine", async () => {
  // _engine sorts last in resolution, so a space path resolves to the space — the assets
  // branch keys on the resolved owner being _engine, so demo content still comes from R2.
  const { env, blobReads } = bundleEnv({
    r2Engine: engineManifest({ src: "old", kind: "r2" }),
    assetsEngine: engineManifest({ src: "new", kind: "assets" }),
  });
  const res = await W.assetFetch(tenant(), env, req("/p/index.html"));
  assert.equal(res.status, 200);
  assert.equal(blobReads.length, 1, "the space's page was served from its R2 blob");
});

test("assets mode (bundleMode false) is untouched: assetFetch delegates straight to ASSETS", async () => {
  // No GV_ASSET_SOURCE / no BUNDLES ⇒ not bundle mode. assetFetch must hand the request to
  // the ASSETS binding verbatim, with none of the _engine machinery running.
  let got = null;
  const env = { ASSETS: { fetch: async (r) => { got = new URL(r.url).pathname; return new Response("raw", { status: 200 }); } } };
  const res = await W.assetFetch("x", env, req("/admin/index.html"));
  assert.equal(await res.text(), "raw");
  assert.equal(got, "/admin/index.html");
});
