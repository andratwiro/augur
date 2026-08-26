// Two publishes landing together get two version numbers.
//
// `B-do-publish-version-cas`. Three places mint a new version — commit, rollback, and the
// delete that removes a URL prefix — and all three did the same thing against R2: read
// `manifest.json`, add one, PUT `versions/<n>.json`. R2 has no compare-and-swap, so two of
// those landing together compute the SAME number and the second PUT overwrites the first's
// version file. Both publishes report success. What is lost is a point in the history that
// `augur rollback` and every recovery runbook depend on, and nothing says so.
//
// A Durable Object is single-threaded, so one object issuing the number cannot interleave.
// R2 keeps the payloads; the object keeps nothing but the counter.
//
// THE FLOOR IS WHAT MAKES ADOPTING IT SAFE. The counter starts empty, so on a workspace
// that has been publishing for months the first issue would be 1 — which names an existing
// `versions/1.json` and destroys exactly what this is for. Every call passes the version
// the store currently holds, and the counter answers `MAX(counter, floor) + 1`.
//
// THE SERIALIZATION IS CLOUDFLARE'S, so it was checked against Cloudflare's. Under
// `wrangler dev --local` with a real Durable Object namespace, 40 issues fired at once
// from the worker came back as 40 DISTINCT CONTIGUOUS numbers starting at floor + 1; a
// second batch of 40 with the same, now-stale floor continued from where the first ended
// rather than being dragged back. The in-process objects below are real TenantStores over
// real SQLite, so what they cannot prove is only that workerd runs one at a time — which
// is the part that was measured.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { __testables as W } from "../src/_worker.js";
import { TenantStore } from "../src/tenant-do.js";

/** A TENANTS namespace whose objects are real TenantStores over real SQLite. */
function namespace() {
  const objects = new Map();
  const ns = {
    calls: 0,
    idFromName(name) { return { name, toString: () => `id:${name}` }; },
    get(id) {
      if (!objects.has(id.name)) {
        const db = new DatabaseSync(":memory:");
        const sql = {
          exec(stmt, ...params) {
            if (params.length) return db.prepare(stmt).all(...params);
            if (/^\s*(SELECT|INSERT|UPDATE)/i.test(stmt) && /RETURNING/i.test(stmt)) return db.prepare(stmt).all();
            if (/^\s*SELECT/i.test(stmt)) return db.prepare(stmt).all();
            db.exec(stmt);
            return [];
          },
        };
        objects.set(id.name, new TenantStore({ storage: { sql }, blockConcurrencyWhile: async (f) => f() }, {}));
      }
      const store = objects.get(id.name);
      return { id, fetch: (u, init) => { ns.calls++; return store.fetch(new Request(u, init)); } };
    },
  };
  return ns;
}

const tctx = (over = {}) => Object.freeze({ tenantId: "acme", ...over });

// ── with no workspace store, nothing changes ─────────────────────────────────

test("an instance with no TENANTS binding computes the version exactly as before", async () => {
  // Every live instance is this case. The old arithmetic has to survive verbatim, or
  // taking this engine would change what the next publish is numbered.
  assert.deepEqual(await W.nextPublishVersion({}, tctx(), "alpha", { version: 274 }), { version: 275 });
  assert.deepEqual(await W.nextPublishVersion({}, tctx(), "alpha", null), { version: 1 });
  assert.deepEqual(await W.nextPublishVersion({}, tctx(), "alpha", {}), { version: 1 });
});

// ── the counter ──────────────────────────────────────────────────────────────

test("TWO CONCURRENT ISSUES GET TWO DIFFERENT NUMBERS", async () => {
  // The VERIFY, at the layer where the race lives. Fired together, awaited together.
  const env = { TENANTS: namespace() };
  const cur = { version: 10 };
  const got = await Promise.all(Array.from({ length: 8 }, () => W.nextPublishVersion(env, tctx(), "alpha", cur)));
  const versions = got.map((g) => g.version).sort((a, b) => a - b);
  assert.deepEqual(versions, [11, 12, 13, 14, 15, 16, 17, 18],
    "concurrent issues collided or skipped");
});

test("THE FIRST ISSUE ON A WORKSPACE ALREADY PUBLISHING IS live + 1", async () => {
  // Without the floor this answers 1 and names an existing version file — the exact
  // history destruction the counter exists to prevent, caused by adopting it.
  const env = { TENANTS: namespace() };
  assert.deepEqual(await W.nextPublishVersion(env, tctx(), "alpha", { version: 274 }), { version: 275 });
  assert.deepEqual(await W.nextPublishVersion(env, tctx(), "alpha", { version: 274 }), { version: 276 },
    "the counter did not take over after the first issue");
});

test("a stale floor cannot drag the counter backwards", async () => {
  // A number issued for a commit that then failed leaves the counter ahead of the store.
  // The next publish reads an older manifest and passes a lower floor; MAX is what stops
  // that reissuing a number.
  const env = { TENANTS: namespace() };
  await W.nextPublishVersion(env, tctx(), "alpha", { version: 100 }); // issues 101
  await W.nextPublishVersion(env, tctx(), "alpha", { version: 100 }); // issues 102, commit failed
  assert.deepEqual(await W.nextPublishVersion(env, tctx(), "alpha", { version: 100 }), { version: 103 });
});

test("each space has its own counter, and each workspace its own object", async () => {
  const env = { TENANTS: namespace() };
  assert.deepEqual(await W.nextPublishVersion(env, tctx(), "alpha", { version: 5 }), { version: 6 });
  assert.deepEqual(await W.nextPublishVersion(env, tctx(), "beta", { version: 0 }), { version: 1 });
  assert.deepEqual(await W.nextPublishVersion(env, tctx(), "_engine", { version: 40 }), { version: 41 });
  // A different workspace is a different object, so its counter starts from its own floor.
  assert.deepEqual(await W.nextPublishVersion(env, tctx({ tenantId: "other" }), "alpha", { version: 2 }), { version: 3 });
  assert.deepEqual(await W.nextPublishVersion(env, tctx(), "alpha", { version: 0 }), { version: 7 },
    "one workspace's counter answered for another's space");
});

// ── it fails closed ──────────────────────────────────────────────────────────

test("A BOUND-BUT-UNREACHABLE STORE REFUSES THE COMMIT — it does not fall back", async () => {
  // The decision worth reading twice. A deployment that binds TENANTS has said the object
  // is the issuer; computing the number the old way when it hiccups would make the
  // guarantee "usually atomic", and the failure it lets through is silent history loss. A
  // refused commit is loud and costs one re-run.
  const quiet = console.log; console.log = () => {};
  try {
    const dead = { idFromName: (n) => ({ name: n }), get: () => ({ fetch: async () => { throw new Error("no route to object"); } }) };
    assert.deepEqual(await W.nextPublishVersion({ TENANTS: dead }, tctx(), "alpha", { version: 9 }),
      { error: "version-unavailable" });

    const errored = { idFromName: (n) => ({ name: n }), get: () => ({ fetch: async () => new Response("nope", { status: 500 }) }) };
    assert.deepEqual(await W.nextPublishVersion({ TENANTS: errored }, tctx(), "alpha", { version: 9 }),
      { error: "version-unavailable" });
  } finally { console.log = quiet; }
});

test("a counter answering at or below the floor is refused, not obeyed", async () => {
  // The one answer that must never be acted on: a number naming a version file that
  // already exists. Trusting it would overwrite the thing this whole item protects.
  const quiet = console.log; console.log = () => {};
  try {
    for (const version of [9, 8, 0, -1, 1.5, null, "10"]) {
      const bad = {
        idFromName: (n) => ({ name: n }),
        get: () => ({ fetch: async () => Response.json({ version }) }),
      };
      assert.deepEqual(await W.nextPublishVersion({ TENANTS: bad }, tctx(), "alpha", { version: 9 }),
        { error: "version-unavailable" }, `answered ${version}`);
    }
  } finally { console.log = quiet; }
});

// ── the object's own API ─────────────────────────────────────────────────────

test("the workspace object exposes ONE verb, and refuses everything else", async () => {
  // A Durable Object stub is not publicly routable, so this is an internal API rather than
  // a surface — but every verb added is a round trip on a path that did not need one.
  const ns = namespace();
  const stub = ns.get(ns.idFromName("acme"));
  assert.equal((await stub.fetch("https://workspace/nope", { method: "POST" })).status, 404);
  assert.equal((await stub.fetch("https://workspace/publish-version", { method: "GET" })).status, 404);
  const noSpace = await stub.fetch("https://workspace/publish-version", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.equal(noSpace.status, 400);
  assert.equal((await noSpace.json()).error, "no-space");
});

// ── the whole route, twice at once ───────────────────────────────────────────

/** An R2 stub that YIELDS on every read, so a read-compute-write genuinely interleaves. */
function slowR2(initial = {}) {
  const store = new Map(Object.entries(initial));
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return {
    store,
    async get(k) { await tick(); return store.has(k) ? { text: async () => store.get(k), body: store.get(k) } : null; },
    async put(k, v) { await tick(); store.set(k, typeof v === "string" ? v : JSON.stringify(v)); },
    async head(k) { await tick(); return store.has(k) ? {} : null; },
    async list({ prefix = "" } = {}) {
      await tick();
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
const nextManifest = (marker) => ({
  id: "alpha", format: 1, files: LIVE.files,
  space: { id: "alpha", default: true },
  source: { sha: marker, dirty: false, actor: marker },
  routing: { publicPrefixes: ["/toolkit/widgets/"], versionMap: {} },
});
// The workspace this publish is for. `tenantId` matters here and nowhere else in the
// publish tests: it is what names the Durable Object the counter lives in.
const COMMIT_CTX = Object.freeze({ ...W.applyInstance({ users: [] }), tenantId: "acme" });
const commit = (env, manifest) => W.publishApi(
  COMMIT_CTX,
  new Request("https://x.test/__publish/alpha/commit", {
    method: "POST",
    headers: { Authorization: "Bearer tok", "content-type": "application/json" },
    body: JSON.stringify(manifest),
  }),
  new URL("https://x.test/__publish/alpha/commit"),
  env);

test("THE BUG, REPRODUCED: without the counter, two commits at once lose one version file", async () => {
  // Not a hypothetical, and worth reproducing before claiming the fix. Both requests read
  // live at version 4, both compute 5, and the second PUT lands on the first's
  // `versions/5.json`. Both report 200.
  const env = { BUNDLES: slowR2({ "spaces/alpha/manifest.json": JSON.stringify(LIVE) }), PUBLISH_BOOTSTRAP_TOKEN: "tok" };
  const [a, b] = await Promise.all([commit(env, nextManifest("first")), commit(env, nextManifest("second"))]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const versions = [...env.BUNDLES.store.keys()].filter((k) => k.startsWith("spaces/alpha/versions/"));
  assert.deepEqual(versions, ["spaces/alpha/versions/5.json"], "the race did not reproduce; the fixture is not interleaving");
  const kept = JSON.parse(env.BUNDLES.store.get("spaces/alpha/versions/5.json")).source.actor;
  assert.ok(kept === "first" || kept === "second");
  // One publisher's bytes are simply gone, and nothing anywhere says so.
});

test("WITH THE COUNTER, both land, on their own numbers, with their own bytes", async () => {
  // The VERIFY: two concurrent commits, distinct versions, and neither version file
  // overwritten — checked by comparing the bytes back against what each publisher sent.
  const env = {
    BUNDLES: slowR2({ "spaces/alpha/manifest.json": JSON.stringify(LIVE) }),
    PUBLISH_BOOTSTRAP_TOKEN: "tok",
    TENANTS: namespace(),
  };
  const [a, b] = await Promise.all([commit(env, nextManifest("first")), commit(env, nextManifest("second"))]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const va = (await a.json()).version;
  const vb = (await b.json()).version;
  assert.notEqual(va, vb, "two concurrent commits were given the same version");
  assert.deepEqual([va, vb].sort(), [5, 6]);

  const actors = new Set();
  for (const v of [va, vb]) {
    const doc = JSON.parse(env.BUNDLES.store.get(`spaces/alpha/versions/${v}.json`));
    assert.equal(doc.version, v, `versions/${v}.json holds version ${doc.version}`);
    actors.add(doc.source.actor);
  }
  assert.deepEqual([...actors].sort(), ["first", "second"], "a publisher's bytes were overwritten");
});

test("a commit is REFUSED, not computed the old way, when the counter cannot answer", async () => {
  const quiet = console.log; console.log = () => {};
  try {
    const env = {
      BUNDLES: slowR2({ "spaces/alpha/manifest.json": JSON.stringify(LIVE) }),
      PUBLISH_BOOTSTRAP_TOKEN: "tok",
      TENANTS: { idFromName: (n) => ({ name: n }), get: () => ({ fetch: async () => { throw new Error("gone"); } }) },
    };
    const res = await commit(env, nextManifest("first"));
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, "version-unavailable");
    assert.equal(env.BUNDLES.store.has("spaces/alpha/versions/5.json"), false, "a refused commit wrote a version file");
    assert.equal(JSON.parse(env.BUNDLES.store.get("spaces/alpha/manifest.json")).version, 4, "live moved on a refused commit");
  } finally { console.log = quiet; }
});

test("a number is burned rather than reused when a commit does not land", async () => {
  // Stated because it looks like a bug and is the same trade the rollback path already
  // makes: reusing an issued number means overwriting a version that exists. Gaps in the
  // sequence are fine; collisions are not.
  const env = { TENANTS: namespace() };
  const a = await W.nextPublishVersion(env, tctx(), "alpha", { version: 1 });
  const b = await W.nextPublishVersion(env, tctx(), "alpha", { version: 1 }); // this one "fails"
  const c = await W.nextPublishVersion(env, tctx(), "alpha", { version: a.version });
  assert.deepEqual([a.version, b.version, c.version], [2, 3, 4]);
});
