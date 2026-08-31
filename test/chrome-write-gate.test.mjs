// The shared chrome is nobody's workspace to write.
//
// `spaces/_engine/…` is the ONE bundle-store key a prefixing deployment deliberately leaves
// global (`bundleKey`'s engine exception): one worker build serves every workspace, so one
// chrome bundle is correct rather than a leak. `test/bundle-tenancy.test.mjs` asserts that
// sharing is intentional. Nothing asserted anything about WHO MAY WRITE IT — and the
// credential that can is minted per workspace, at that workspace's own Settings panel, from
// that workspace's own roster. So any hosted workspace's admin could rewrite
// `/admin/index.html` and `/sw.js` for every other customer on the deployment. That is not a
// philosophical boundary: it is a stranger's admin serving script into your admin panel.
//
// ── WHAT THE GATE IS, AND WHAT IT DELIBERATELY IS NOT ────────────────────────────────
//
// It refuses `_engine` WRITES on a deployment where the chrome is actually shared, and it
// refuses them to EVERY credential — there is no capability that satisfies it yet, and
// shipping one that nothing could mint would be a door with no key pretending to be a lock.
//
//   · READS are untouched. `augur export` walks `_engine` through `manifest`, `versions`,
//     `version` and `blob` GET, and a 403 there is a "skipped, not in this copy" line in a
//     backup that reports success — the one failure nobody would ever read.
//   · A DEPLOYMENT THAT SHARES NO CHROME IS UNTOUCHED, byte for byte. That is every
//     self-hosted instance, and it includes the shape a wrong discriminator would have
//     broken: `TENANTS` bound with no `TENANT_HOST_SUFFIX`, which `wrangler-preflight.mjs`
//     permits and which serves exactly one workspace.
//   · `rollback` IS A WRITE. It republishes an old manifest under a new version and bypasses
//     the engine-downgrade guard on purpose, so leaving it open would let any workspace's
//     admin re-arm a chrome version everyone else has already moved off. With commits
//     refused there is nothing left to undo, so the undo path costs nothing to close and
//     costs the deployment everything to leave open.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { TenantStore } from "../src/tenant-do.js";
import { __testables as W } from "../src/_worker.js";

const CTX = W.applyInstance({ users: [] });
const H = "b".repeat(64);
const TOKEN = "a-plain-star-token";
const CHROME_TOKEN = "a-chrome-cap-token";
const EXPIRED_CHROME_TOKEN = "an-expired-chrome-cap-token";

const LIVE_ENGINE = {
  id: "_engine", version: 9, format: 1,
  source: { sha: "current777" },
  builtWith: { engine: "current777", version: "0.13.0" },
  files: {
    "/sw.js": { h: H, ct: "text/javascript", s: 5 },
    "/_chrome.1.14.abc12345.css": { h: H, ct: "text/css", s: 5 },
    "/_chrome.1.14.abc12345.js": { h: H, ct: "text/javascript", s: 5 },
    "/admin/index.html": { h: H, ct: "text/html", s: 5 },
  },
  routing: {
    chrome: { css: "_chrome.1.14.abc12345.css", js: "_chrome.1.14.abc12345.js", ui: "1.14" },
    runtimeChrome: true, publicPrefixes: [], versionMap: {},
  },
};

function memR2(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async head(k) { return store.has(k) ? { etag: `e${store.get(k).length}` } : null; },
    async get(k) {
      const o = store.get(k);
      return o == null ? null : { body: o, etag: `e${o.length}`, text: async () => o };
    },
    async put(k, v) { store.set(k, typeof v === "string" ? v : Buffer.from(v).toString()); },
    async delete(k) { store.delete(k); },
    async list({ prefix = "", delimiter } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      if (delimiter) {
        const prefixes = new Set();
        for (const k of keys) {
          const rest = k.slice(prefix.length);
          const at = rest.indexOf(delimiter);
          if (at >= 0) prefixes.add(prefix + rest.slice(0, at + 1));
        }
        return { objects: [], delimitedPrefixes: [...prefixes], truncated: false };
      }
      return { objects: keys.map((key) => ({ key, size: store.get(key).length })), truncated: false };
    },
  };
}

function memKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
    async list({ prefix = "" } = {}) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}

/**
 * One deployment, named by the two facts that decide whether its chrome is shared.
 *
 * `suffix` is what `bundleWorkspaceSegment` reads. `tenants` binds a REAL workspace object
 * (node:sqlite behind the same storage stub the other DO files use), because the shape this
 * gate must not break — a `TENANTS` binding with no suffix — cannot be staged with a stub
 * that throws.
 */
async function deployment({ suffix = null, tenants = false, tenantId = "acme" } = {}) {
  const r2 = memR2({
    "spaces/_engine/manifest.json": JSON.stringify(LIVE_ENGINE),
    "spaces/_engine/versions/8.json": JSON.stringify({ ...LIVE_ENGINE, version: 8 }),
    ["blobs/" + H]: "hello",
  });
  // The token lives at BOTH physical keys — which is what the straddle writes anyway, and
  // it keeps this fixture from having to know which one a shape reads.
  const starHash = await W.tokenFor("pub:" + TOKEN);
  const chromeHash = await W.tokenFor("pub:" + CHROME_TOKEN);
  const expiredChromeHash = await W.tokenFor("pub:" + EXPIRED_CHROME_TOKEN);
  const doc = JSON.stringify({
    [starHash]: { space: "*", label: "ci", createdAt: "2026-01-01T00:00:00.000Z" },
    [chromeHash]: { space: "*", label: "chrome-refresh", caps: ["chrome"], createdAt: "2026-01-01T00:00:00.000Z" },
    // A chrome-capability token whose TTL has already elapsed — the ISO expiry the fixed
    // mint now stores. `publishAuthDetailed` must refuse it as expired, PROVING the ISO
    // format is enforced end-to-end rather than merely pinned in a unit test.
    [expiredChromeHash]: {
      space: "*", label: "chrome-refresh", caps: ["chrome"],
      createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2020-01-01T00:00:00.000Z",
    },
  });
  const kv = memKV({ "publish:tokens": doc, [`t/${tenantId}/publish:tokens`]: doc });

  const env = { BUNDLES: r2, GV_ASSET_SOURCE: "r2", COMMENTS: kv };
  if (suffix) env.TENANT_HOST_SUFFIX = suffix;
  if (tenants) {
    const db = new DatabaseSync(":memory:");
    const sql = {
      exec(stmt, ...params) {
        if (params.length) {
          const s = db.prepare(stmt);
          return /^\s*SELECT|RETURNING/i.test(stmt) ? s.all(...params) : (s.run(...params), []);
        }
        if (/^\s*SELECT/i.test(stmt)) return db.prepare(stmt).all();
        db.exec(stmt);
        return [];
      },
    };
    const object = new TenantStore({
      storage: { sql, transactionSync: (cb) => cb() },
      blockConcurrencyWhile: async (f) => f(),
    }, {});
    env.TENANTS = { idFromName: (n) => n, get: () => ({ fetch: (i, init) => object.fetch(new Request(i, init)) }) };
  }
  const tctx = Object.freeze({ ...CTX, tenantId });
  const fire = (path, init = {}) => {
    W.__setConfigTestState({ cfgAt: 0, cfgGoodAt: 0, roster: null, manifests: null, storage: null });
    const url = new URL("https://x.test" + path);
    return W.publishApi(tctx, new Request(url, {
      ...init,
      headers: { Authorization: "Bearer " + TOKEN, ...(init.headers || {}) },
    }), url, env);
  };
  const fireAs = (bearer, path, init = {}) => {
    W.__setConfigTestState({ cfgAt: 0, cfgGoodAt: 0, roster: null, manifests: null, storage: null });
    const url = new URL("https://x.test" + path);
    return W.publishApi(tctx, new Request(url, {
      ...init, headers: { Authorization: "Bearer " + bearer, ...(init.headers || {}) },
    }), url, env);
  };
  return { env, r2, kv, fire, fireAs };
}

/** The five ops that end in bytes the next request serves. */
const WRITES = [
  ["/__publish/_engine/check", { method: "POST", body: JSON.stringify({ files: {} }) }],
  ["/__publish/_engine/blob/" + H, { method: "PUT", body: "hello" }],
  ["/__publish/_engine/commit", { method: "POST", body: JSON.stringify({ ...LIVE_ENGINE, version: undefined }) }],
  ["/__publish/_engine/fork", { method: "POST", body: JSON.stringify({ from: "/a/", to: "/b/" }) }],
  ["/__publish/_engine/rollback", { method: "POST", body: JSON.stringify({ version: 8 }) }],
];

/** The reads `augur export` walks. */
const READS = [
  "/__publish/_engine/manifest",
  "/__publish/_engine/versions",
  "/__publish/_engine/version/8",
  "/__publish/_engine/blob/" + H,
];

// ─────────────────────────────────────────────────────────────────────────────
// 1. WHERE THE CHROME IS SHARED
// ─────────────────────────────────────────────────────────────────────────────

test("A PLAIN STAR TOKEN CANNOT WRITE THE SHARED CHROME — this is the whole item", async () => {
  const d = await deployment({ suffix: ".example.test", tenants: true });
  for (const [path, init] of WRITES) {
    const res = await d.fire(path, init);
    assert.equal(res.status, 403, `${path} was not refused`);
    const body = await res.json();
    assert.equal(body.error, "forbidden");
    assert.equal(body.reason, "chrome-not-writable-here", `${path} answered ${body.reason}`);
  }
  // Refused means nothing moved. The manifest is the one that would have been served.
  assert.equal(JSON.parse(d.r2.store.get("spaces/_engine/manifest.json")).version, 9);
});

test("ROLLBACK IS A WRITE, and closing it is the point rather than an oversight", async () => {
  // It republishes an old manifest under a new version and deliberately bypasses the
  // engine-downgrade guard — the one path that can put a superseded chrome back on every
  // workspace at once. Left open, an admin who had pushed once could re-arm that push
  // forever. With commit refused there is nothing legitimate left for it to undo.
  const d = await deployment({ suffix: ".example.test", tenants: true });
  const res = await d.fire("/__publish/_engine/rollback", { method: "POST", body: JSON.stringify({ version: 8 }) });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).reason, "chrome-not-writable-here");
  assert.equal(JSON.parse(d.r2.store.get("spaces/_engine/manifest.json")).version, 9);
});

test("READING the chrome is untouched — a backup that skips it reports success", async () => {
  // `scripts/export.mjs` treats a 403 on a manifest as "skipped, not in this copy": one
  // yellow line and an entry in a `skipped[]` array nobody reads. A gate on the op name
  // alone would have taken the chrome out of every nightly backup silently.
  const d = await deployment({ suffix: ".example.test", tenants: true });
  for (const path of READS) {
    const res = await d.fire(path);
    assert.equal(res.status, 200, `${path} answered ${res.status}`);
  }
});

test("a workspace's OWN space is unaffected on the very same deployment", async () => {
  // The gate is about ONE key that is deliberately global. A workspace publishing its own
  // content writes a prefixed key and must notice nothing.
  const d = await deployment({ suffix: ".example.test", tenants: true });
  const res = await d.fire("/__publish/one/check", { method: "POST", body: JSON.stringify({ files: {} }) });
  assert.equal(res.status, 200);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. WHERE IT IS NOT — the discriminator, which is the part that was easy to get wrong
// ─────────────────────────────────────────────────────────────────────────────

test("a single-workspace instance is byte-for-byte unchanged", async () => {
  const d = await deployment({});
  for (const [path, init] of WRITES) {
    const res = await d.fire(path, init);
    assert.notEqual(res.status, 403, `${path} was refused on a deployment that shares no chrome`);
  }
});

test("⚠️ `TENANTS` BOUND WITH NO SUFFIX STILL SERVES ONE WORKSPACE, and may write its own chrome", async () => {
  // The shape a wrong discriminator would have broken. `wrangler-preflight.mjs` refuses
  // "suffix set + no TENANTS" and does NOT refuse this one — an instance using the workspace
  // object as its identity store without resolving workspaces from the Host is legal, real,
  // and shares its chrome with nobody. Keying the gate on `env.TENANTS` would have refused
  // that operator's own chrome publish, from their own CI, with a cross-tenant explanation
  // that is not true of their deployment.
  const d = await deployment({ tenants: true });
  assert.deepEqual(W.bundleWorkspaceSegment(d.env, "acme"), { workspace: "", legacyIsOurs: true });
  for (const [path, init] of WRITES) {
    const res = await d.fire(path, init);
    assert.notEqual(res.status, 403, `${path} was refused on a deployment that shares no chrome`);
  }
});

test("an EMPTY suffix is not a suffix here either", async () => {
  // It reads as multi-workspace to a person and as single-workspace to the resolver, which
  // is why the preflight refuses it. The gate must agree with the key former, not with the
  // person: `bundleKey` writes no segment, so the chrome is not shared.
  const d = await deployment({ suffix: "   " });
  const res = await d.fire("/__publish/_engine/rollback", { method: "POST", body: JSON.stringify({ version: 8 }) });
  assert.notEqual(res.status, 403);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE PREDICATE ITSELF
// ─────────────────────────────────────────────────────────────────────────────

test("the gate reads the SAME fact `bundleKey`'s engine exception reads", async () => {
  // One fact about the deployment, not two that could disagree. If these two ever answer
  // differently, either the chrome is shared and unguarded or it is private and refused.
  const shared = { TENANT_HOST_SUFFIX: ".example.test" };
  const solo = {};
  assert.equal(W.bundleKey("spaces/_engine/manifest.json", W.bundleWorkspaceSegment(shared, "acme").workspace),
    "spaces/_engine/manifest.json");
  assert.equal(!!W.bundleWorkspaceSegment(shared, "acme").workspace, true);
  assert.equal(!!W.bundleWorkspaceSegment(solo, "acme").workspace, false);
  // `who` is null here — no credential, no capability granted — so these calls keep
  // asserting the bare fact-check they always did; a chrome-capability `who` is covered
  // by the dedicated "THE ONE KEY" tests below.
  assert.equal(W.sharedChromeRefusal(shared, { tenantId: "acme" }, null, "_engine", "commit", "POST"),
    "chrome-not-writable-here");
  assert.equal(W.sharedChromeRefusal(solo, { tenantId: "acme" }, null, "_engine", "commit", "POST"), null);
});

test("`_engine` is refused as a SPACE ID, not as a prefix", async () => {
  // A space genuinely called `_engine-notes` takes the segment and is its workspace's own.
  assert.equal(W.sharedChromeRefusal({ TENANT_HOST_SUFFIX: ".x.test" }, { tenantId: "a" }, null, "_engine-notes", "commit", "POST"), null);
});

test("an op added later is refused by default — the list names the READS", async () => {
  // Deny-by-default, the same direction `CAP_ROUTES` is written in. A denylist of writes
  // would have to be widened in step with every new publishing verb, and the step somebody
  // forgets is the one that opens something.
  const shared = { TENANT_HOST_SUFFIX: ".example.test" };
  assert.equal(W.sharedChromeRefusal(shared, { tenantId: "a" }, null, "_engine", "some-future-op", "POST"),
    "chrome-not-writable-here");
  // And a read verb asked with a writing METHOD is not a read.
  assert.equal(W.sharedChromeRefusal(shared, { tenantId: "a" }, null, "_engine", "blob", "PUT"),
    "chrome-not-writable-here");
  assert.equal(W.sharedChromeRefusal(shared, { tenantId: "a" }, null, "_engine", "blob", "GET"), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE ONE KEY — a chrome-capability token, and nothing else, may write the chrome
// ─────────────────────────────────────────────────────────────────────────────

test("a CHROME-CAPABILITY token passes the gate on _engine writes the star token could not", async () => {
  const d = await deployment({ suffix: ".example.test", tenants: true });
  // `check` is the publish preflight — a clean pass answers 200 with the missing set.
  const res = await d.fireAs(CHROME_TOKEN, "/__publish/_engine/check", {
    method: "POST", body: JSON.stringify({ files: {} }),
  });
  assert.equal(res.status, 200, "chrome token was refused on _engine/check");
});

test("a chrome-capability token may READ the manifest and versions the CAS needs", async () => {
  const d = await deployment({ suffix: ".example.test", tenants: true });
  for (const path of ["/__publish/_engine/manifest", "/__publish/_engine/versions", "/__publish/_engine/version/8"]) {
    const res = await d.fireAs(CHROME_TOKEN, path);
    assert.equal(res.status, 200, `${path} answered ${res.status} for the chrome token`);
  }
});

test("the chrome capability is walled off EVERYTHING but the chrome — content, config, rollback", async () => {
  const d = await deployment({ suffix: ".example.test", tenants: true });
  // A real space: refused as capability-not-granted, never granted by the chrome cap.
  const space = await d.fireAs(CHROME_TOKEN, "/__publish/one/check", { method: "POST", body: JSON.stringify({ files: {} }) });
  assert.equal(space.status, 403);
  assert.equal((await space.json()).reason, "capability-not-granted");
  // The roster document — the hard constraint. Structurally refused before it is reached.
  const cfg = await d.fireAs(CHROME_TOKEN, "/__publish/_instance/config", { method: "POST", body: JSON.stringify({ users: [] }) });
  assert.equal(cfg.status, 403);
  assert.equal((await cfg.json()).reason, "capability-not-granted");
  // rollback is not in CAP_ROUTES.chrome, so capabilityRefusal catches it first.
  const rb = await d.fireAs(CHROME_TOKEN, "/__publish/_engine/rollback", { method: "POST", body: JSON.stringify({ version: 8 }) });
  assert.equal(rb.status, 403);
  assert.equal((await rb.json()).reason, "capability-not-granted");
});

test("the star token is STILL refused where the chrome token is admitted", async () => {
  // The regression that clause 2 of the VERIFY names. Same deployment, same route, no caps.
  const d = await deployment({ suffix: ".example.test", tenants: true });
  const res = await d.fireAs(TOKEN, "/__publish/_engine/check", { method: "POST", body: JSON.stringify({ files: {} }) });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).reason, "chrome-not-writable-here");
});

test("an EXPIRED chrome-capability token is refused — the TTL is enforced, not just minted", async () => {
  // The `chrome` verb mints a token with a 1-hour TTL. That TTL is only worth anything if
  // `publishAuthDetailed` actually reads it: this proves an elapsed one is treated as no
  // token at all, at the very route the capability exists to admit.
  const d = await deployment({ suffix: ".example.test", tenants: true });
  const res = await d.fireAs(EXPIRED_CHROME_TOKEN, "/__publish/_engine/check", {
    method: "POST", body: JSON.stringify({ files: {} }),
  });
  assert.equal(res.status, 403, "an expired chrome token was admitted");
  assert.deepEqual(await res.json(), {
    error: "token-expired",
    message: "This publish token has expired. Run `augur login` again.",
  });
});
