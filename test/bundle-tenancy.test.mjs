// The bundle store's keys carry the workspace — the seam, as a table that runs.
//
// `B-bundle-store-tenancy`. Not one `BUNDLES` key used to carry a workspace:
// `config/instance.json` was one document for the whole bucket, `spaces/<id>/…` named a
// SPACE, and one deployment serving several workspaces had them all writing the same keys.
// Two workspaces publishing a space under the same id wrote the same object, so the commit
// CAS, the unpublish guard and the stale-base check all evaluated against a stranger's
// document. `bundleKey` is the fix and this file is the account of what it does.
//
// ⚠️ THIS IS THE CHEAP FILTER, NOT THE PROOF. The bucket below is a `Map` behind a
// hand-written stub, and a stub's `list` cannot get `delimitedPrefixes` wrong, cannot
// truncate, and will agree with whatever this file believes about prefixes because both
// were written from the same belief. The proof is `scripts/bundle-tenancy-rehearsal.mjs`:
// real workerd, a real R2 bucket, two workspaces on two hostnames, publishes over HTTP, the
// migration run, and the per-family revert run against a modified copy of the worker. Reach
// for that before trusting a green result here about a key shape.
//
// What this file IS good for: the mapping table, the two deliberate exemptions, and the
// property that a deployment binding no `TENANTS` and setting no suffix writes the exact
// keys it has always written — the additive claim, asserted key by key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

function memR2(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async head(k) { return store.has(k) ? { etag: `e${store.get(k).length}` } : null; },
    async get(k) {
      const o = store.get(k);
      if (o == null) return null;
      const buf = Buffer.from(o);
      return {
        body: o, etag: `e${o.length}`,
        text: async () => o,
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      };
    },
    async put(k, v) { store.set(k, typeof v === "string" ? v : Buffer.from(v).toString()); },
    async delete(k) { store.delete(k); },
    async list({ prefix = "", delimiter, cursor } = {}) {
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
      return { objects: keys.map((key) => ({ key, size: store.get(key).length })), truncated: false, cursor };
    },
  };
}

const HOSTED = (r2) => ({ BUNDLES: r2, GV_ASSET_SOURCE: "r2", TENANT_HOST_SUFFIX: ".example.test" });
const SINGLE = (r2) => ({ BUNDLES: r2, GV_ASSET_SOURCE: "r2" });

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE TABLE
// ─────────────────────────────────────────────────────────────────────────────

test("the key former is the IDENTITY when no workspace is passed", () => {
  // The whole of the straddle: every caller that passes nothing gets back the string it has
  // always got back. There is no deployment where this is not the answer today.
  for (const k of [
    "config/instance.json", "spaces/site/manifest.json", "spaces/site/versions/9.json",
    "spaces/_engine/manifest.json", "blobs/" + "a".repeat(64), "assets/" + "b".repeat(40),
  ]) assert.equal(W.bundleKey(k), k, k);
});

test("with a workspace, three families take the segment and two deliberately do not", () => {
  const ws = "wren";
  assert.equal(W.bundleKey("config/instance.json", ws), "t/wren/config/instance.json");
  assert.equal(W.bundleKey("spaces/site/manifest.json", ws), "t/wren/spaces/site/manifest.json");
  assert.equal(W.bundleKey("spaces/site/versions/9.json", ws), "t/wren/spaces/site/versions/9.json");
  assert.equal(W.bundleKey("spaces/", ws), "t/wren/spaces/");
  assert.equal(W.bundleKey("assets/" + "b".repeat(40), ws), "t/wren/assets/" + "b".repeat(40));

  // ⚠️ THE TWO EXEMPTIONS, AND THEY ARE THE POINT OF THIS TEST. `blobs/` is shared because
  // every write verifies the digest against the key, so a workspace can only write bytes
  // that hash to the name it used, dedup is load-bearing, and `blobGc` is written FOR a
  // shared namespace. `spaces/_engine/` is shared because one worker build serves every
  // workspace, so one chrome bundle is correct — prefix it by accident and every workspace
  // loses its chrome on the deploy that does it.
  assert.equal(W.bundleKey("blobs/" + "a".repeat(64), ws), "blobs/" + "a".repeat(64));
  assert.equal(W.bundleKey("spaces/_engine/manifest.json", ws), "spaces/_engine/manifest.json");
  assert.equal(W.bundleKey("spaces/_engine/versions/3.json", ws), "spaces/_engine/versions/3.json");
});

test("a key the scheme does not name is left alone rather than guessed at", () => {
  assert.equal(W.bundleFamily("whatever"), "");
  assert.equal(W.bundleKey("whatever", "wren"), "whatever");
});

test("`_engine` is exempt as a SPACE, not as a substring", () => {
  // A space actually called `_engine-notes` is a space, and gets the segment. The exemption
  // is the path segment, so a name that merely starts with the same letters is not caught.
  assert.equal(W.bundleKey("spaces/_engine-notes/manifest.json", "wren"),
    "t/wren/spaces/_engine-notes/manifest.json");
});

test("the family flags are frozen, one word each, and `blobs` is not among them", () => {
  assert.equal(Object.isFrozen(W.BUNDLE_TENANCY), true);
  assert.deepEqual(Object.keys(W.BUNDLE_TENANCY).sort(), ["assets", "config", "spaces"]);
  // ⛔ A day when this key exists is a day somebody decided to stop sharing the blob
  // namespace, and that is a decision with a migration in it — not a line in a diff.
  assert.equal(W.BUNDLE_TENANCY.blobs, undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. WHICH DEPLOYMENTS CARRY A SEGMENT AT ALL
// ─────────────────────────────────────────────────────────────────────────────

test("no TENANT_HOST_SUFFIX means no segment, and an unprefixed key IS ours", () => {
  // Every instance running today. ⚠️ AND `TENANTS` IS NOT THE SAME QUESTION: the preflight
  // refuses the SUFFIX with no binding, and deliberately does NOT refuse a BINDING with no
  // suffix — an instance may use the workspace object as its identity store while still
  // serving the one workspace its build named. There the bucket holds one workspace's
  // content, an unprefixed key is unambiguously its, and the chrome is shared with nobody.
  // So the suffix is the whole discriminator, and anything keying on the binding instead
  // (a gate, a listing, a usage sum) would be answering a different question than the key
  // former is.
  assert.deepEqual(W.bundleWorkspaceSegment(SINGLE(memR2()), "anything"),
    { workspace: "", legacyIsOurs: true });
  assert.deepEqual(W.bundleWorkspaceSegment({}, "anything"),
    { workspace: "", legacyIsOurs: true });
  // An empty string is not a suffix. It reads as multi-workspace to a person and as
  // single-workspace to the resolver, which is why the preflight refuses it too.
  assert.deepEqual(W.bundleWorkspaceSegment({ TENANT_HOST_SUFFIX: "  " }, "x"),
    { workspace: "", legacyIsOurs: true });
});

test("with the suffix set, the segment is the workspace and legacy is NOT ours", () => {
  assert.deepEqual(W.bundleWorkspaceSegment(HOSTED(memR2()), "wren"),
    { workspace: "wren", legacyIsOurs: false });
  // ⚠️ `legacyIsOurs: false` is what forbids a read-through fallback. An unprefixed key on a
  // shared bucket belongs to whichever workspace the deployment served before the segment
  // existed, and nothing in the key says which — so reading it would hand one workspace
  // content that may be another's. It is also why the migration is a PREREQUISITE there
  // rather than an optimisation.
});

test("with no segment, the store accessor IS the binding — not a wrapper around it", () => {
  // The additive claim at its sharpest: on every deployment running today there is no new
  // code at all between the worker and R2.
  const r2 = memR2();
  assert.equal(W.bundleStore(SINGLE(r2), ""), r2);
  assert.equal(W.bundlesFor(SINGLE(r2), "wren"), r2);
  assert.equal(W.bundleStore({}, ""), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE ACCESSOR
// ─────────────────────────────────────────────────────────────────────────────

test("the scoped store applies the segment going in and STRIPS it coming out", async () => {
  const r2 = memR2();
  const s = W.bundleStore(HOSTED(r2), "wren");
  await s.put("spaces/site/versions/1.json", "{}");
  await s.put("spaces/site/versions/2.json", "{}");
  assert.equal(r2.store.has("t/wren/spaces/site/versions/1.json"), true);

  // A listing hands back the LOGICAL key, so handing it straight back to `get` or `delete`
  // re-applies the segment rather than double-prefixing it. That round trip is what lets
  // every existing caller keep the key it already had.
  const page = await s.list({ prefix: "spaces/site/versions/" });
  assert.deepEqual(page.objects.map((o) => o.key),
    ["spaces/site/versions/1.json", "spaces/site/versions/2.json"]);
  assert.equal((await s.get(page.objects[0].key)) !== null, true);
  await s.delete(page.objects[0].key);
  assert.equal(r2.store.has("t/wren/spaces/site/versions/1.json"), false);

  const listed = await s.list({ prefix: "spaces/", delimiter: "/" });
  assert.deepEqual(listed.delimitedPrefixes, ["spaces/site/"]);
});

test("a write on a shared bucket lands under the segment and NOWHERE ELSE", async () => {
  // The segment exists only where the bucket is shared — and there an unprefixed key is
  // unattributable, which is the engine's own rule (`legacyIsOurs: false`). A copy written
  // there is one workspace's document sitting where every workspace shares: the roster,
  // in the config family's case, and the blob index in the manifest's. Nothing reads it,
  // and the "revert" it was kept for restores a collision, not yesterday.
  const r2 = memR2({ "spaces/site/manifest.json": "{\"someone\":\"else\"}" });
  const s = W.bundleStore(HOSTED(r2), "wren");
  await s.put("spaces/site/manifest.json", "{\"v\":1}");
  await s.put("config/instance.json", "{\"users\":[]}");
  await s.put("assets/" + "b".repeat(40), "png-bytes");
  assert.equal(r2.store.get("t/wren/spaces/site/manifest.json"), "{\"v\":1}");
  assert.equal(r2.store.get("t/wren/config/instance.json"), "{\"users\":[]}");
  assert.equal(r2.store.get("t/wren/assets/" + "b".repeat(40)), "png-bytes");
  assert.equal(r2.store.get("spaces/site/manifest.json"), "{\"someone\":\"else\"}",
    "the write reached the unprefixed key, which may be a neighbour's");
  assert.equal(r2.store.has("config/instance.json"), false,
    "one workspace's roster document was written where every workspace shares");
  assert.equal(r2.store.has("assets/" + "b".repeat(40)), false);
  assert.deepEqual([...r2.store.keys()].filter((k) => !k.startsWith("t/wren/")), ["spaces/site/manifest.json"]);
});

test("but DELETES never touch the unprefixed key", async () => {
  // An unprefixed key on a shared bucket is unattributable, so removing one is removing an
  // object that may be a neighbour's. The safe direction of a straddle is to leave more
  // behind, never less.
  const r2 = memR2({ "spaces/site/manifest.json": "{\"someone\":\"else\"}" });
  const s = W.bundleStore(HOSTED(r2), "wren");
  await s.put("spaces/site/versions/1.json", "{}");
  await s.delete("spaces/site/versions/1.json");
  await s.delete("spaces/site/manifest.json");
  assert.equal(r2.store.get("spaces/site/manifest.json"), "{\"someone\":\"else\"}");
});

test("a shared family is written ONCE, not twice under two names", async () => {
  const r2 = memR2();
  const s = W.bundleStore(HOSTED(r2), "wren");
  await s.put("spaces/_engine/manifest.json", "{}");
  assert.deepEqual([...r2.store.keys()], ["spaces/_engine/manifest.json"]);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE DEPLOYMENT-WIDE LISTING, AND THE ONE SWEEP THAT CROSSES THE SEGMENT
// ─────────────────────────────────────────────────────────────────────────────

test("storeWorkspaceIds names the prefixes, and answers with nothing when there are none", async () => {
  const empty = memR2({ "spaces/site/manifest.json": "{}" });
  assert.deepEqual(await W.storeWorkspaceIds({ BUNDLES: empty }), { ids: [], complete: true });
  const two = memR2({
    "t/wren/spaces/site/manifest.json": "{}",
    "t/finch/spaces/site/manifest.json": "{}",
    "spaces/_engine/manifest.json": "{}",
  });
  const out = await W.storeWorkspaceIds({ BUNDLES: two });
  assert.deepEqual(out.ids.sort(), ["finch", "wren"]);
});

const manifestWith = (h) => JSON.stringify({ id: "site", files: { "/site/i.html": { h } } });

test("blobGc reads EVERY workspace, so one workspace's blob is not an orphan to another", async () => {
  const MINE = "a".repeat(64), YOURS = "b".repeat(64), CHROME = "c".repeat(64), DEAD = "d".repeat(64);
  const r2 = memR2({
    "t/wren/spaces/site/manifest.json": manifestWith(MINE),
    "t/finch/spaces/site/manifest.json": manifestWith(YOURS),
    // ⚠️ The chrome's blobs are referenced from the ONE shared `_engine` manifest, which is
    // outside every workspace prefix. A sweep that walked only the prefixes would collect
    // every byte of chrome on the deployment.
    "spaces/_engine/manifest.json": manifestWith(CHROME),
    [`blobs/${MINE}`]: "1", [`blobs/${YOURS}`]: "2", [`blobs/${CHROME}`]: "3", [`blobs/${DEAD}`]: "4",
  });
  const out = await W.blobGc(HOSTED(r2), { dryRun: true });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(out.keys, [`blobs/${DEAD}`]);
  assert.equal(out.referenced, 3);
  assert.equal(out.spaces, 3, "two workspaces' spaces plus the shared _engine");
});

test("and on a deployment with no segment it walks the bucket exactly as it always did", async () => {
  const MINE = "a".repeat(64), DEAD = "d".repeat(64);
  const r2 = memR2({
    "spaces/site/manifest.json": manifestWith(MINE),
    [`blobs/${MINE}`]: "1", [`blobs/${DEAD}`]: "2",
  });
  const out = await W.blobGc(SINGLE(r2), { dryRun: true });
  assert.deepEqual(out.keys, [`blobs/${DEAD}`]);
  assert.equal(out.spaces, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. THE MOVE
// ─────────────────────────────────────────────────────────────────────────────

const CTX = (id) => Object.freeze({ tenantId: id });

const legacyBucket = () => memR2({
  "config/instance.json": "{\"tenantId\":\"wren\"}",
  "spaces/site/manifest.json": "{\"id\":\"site\"}",
  "spaces/site/versions/1.json": "{\"v\":1}",
  "spaces/site/versions/2.json": "{\"v\":2}",
  "spaces/_engine/manifest.json": "{\"id\":\"_engine\"}",
  ["blobs/" + "a".repeat(64)]: "bytes",
  ["assets/" + "b".repeat(40)]: "image",
});

test("a re-key on a deployment with no segment is a no-op that says so", async () => {
  const r2 = legacyBucket();
  const out = await W.rekeyToSegment(CTX("wren"), SINGLE(r2), { confirm: "wren", dryRun: false });
  assert.deepEqual(out, { ok: true, done: true, reason: "no-segment", workspace: "wren" });
  assert.equal([...r2.store.keys()].some((k) => k.startsWith("t/")), false);
});

test("the dry run reports and writes nothing; the confirmed run copies and deletes nothing", async () => {
  const r2 = legacyBucket();
  const env = HOSTED(r2);
  const before = [...r2.store.keys()].sort();

  const dry = await W.rekeyToSegment(CTX("wren"), env, {});
  assert.equal(dry.ok && dry.dryRun, true);
  assert.equal(dry.copied, 4, "config/instance.json + the manifest + two versions — and NOT _engine");
  assert.deepEqual([...r2.store.keys()].sort(), before, "a dry run wrote something");

  const wrong = await W.rekeyToSegment(CTX("wren"), env, { confirm: "finch", dryRun: false });
  assert.deepEqual(wrong, { ok: false, reason: "confirm-mismatch", expected: "wren" });

  const run = await W.rekeyToSegment(CTX("wren"), env, { confirm: "wren", dryRun: false });
  assert.equal(run.ok && run.done, true, JSON.stringify(run));
  assert.equal(run.copied, 4);
  // ⚠️ `spaces/_engine/…` maps to itself, so `dest === src` and the loop counts it as
  // SHARED rather than copying it. Prefixing it would give every workspace a private copy
  // of the deployment's chrome, which is the accident this whole exemption exists against.
  assert.equal(run.shared, 1, JSON.stringify(run));
  assert.equal(r2.store.has("t/wren/spaces/site/manifest.json"), true);
  assert.equal(r2.store.has("t/wren/spaces/_engine/manifest.json"), false);
  assert.equal(r2.store.has("t/wren/blobs/" + "a".repeat(64)), false);
  // A COPY AND NEVER A CUT. It is what makes the run re-runnable, and what the per-family
  // revert reads.
  for (const k of before) assert.equal(r2.store.has(k), true, `${k} was removed`);
});

test("it is idempotent — a second run copies nothing and still says done", async () => {
  const r2 = legacyBucket();
  const env = HOSTED(r2);
  await W.rekeyToSegment(CTX("wren"), env, { confirm: "wren", dryRun: false });
  const again = await W.rekeyToSegment(CTX("wren"), env, { confirm: "wren", dryRun: false });
  assert.equal(again.ok && again.done, true);
  assert.equal(again.copied, 0);
  assert.equal(again.skipped, 4);
});

test("it pages, and `done` is the caller's loop condition", async () => {
  const r2 = legacyBucket();
  const env = HOSTED(r2);
  const first = await W.rekeyToSegment(CTX("wren"), env, { confirm: "wren", limit: 1, dryRun: false });
  assert.equal(first.copied, 1);
  assert.equal(first.done, false);
  let guard = 0;
  let out = first;
  while (!out.done && guard++ < 10) out = await W.rekeyToSegment(CTX("wren"), env, { confirm: "wren", limit: 1, dryRun: false });
  assert.equal(out.done, true);
  assert.equal(r2.store.has("t/wren/spaces/site/versions/2.json"), true);
});

test("⛔ it REFUSES once a second workspace holds a prefix — nothing may claim an unattributable key", async () => {
  // The guard that keeps this correct for exactly one workspace per deployment. An
  // unprefixed key belongs to whichever workspace the deployment served before the segment
  // existed, and running the move as a SECOND workspace would hand it the FIRST one's
  // content — the disclosure the segment exists to close, performed on purpose.
  const r2 = legacyBucket();
  await r2.put("t/finch/spaces/site/manifest.json", "{}");
  const out = await W.rekeyToSegment(CTX("wren"), HOSTED(r2), { confirm: "wren", dryRun: false });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "not-the-only-workspace");
  assert.deepEqual(out.others, ["finch"]);
});

test("`assets` is opt-in, and an unknown family is refused rather than ignored", async () => {
  const r2 = legacyBucket();
  const env = HOSTED(r2);
  const dflt = await W.rekeyToSegment(CTX("wren"), env, { confirm: "wren", dryRun: false });
  assert.equal(r2.store.has("t/wren/assets/" + "b".repeat(40)), false, "assets moved without being asked for");
  assert.equal(dflt.families.includes("assets"), false);

  const withAssets = await W.rekeyToSegment(CTX("wren"), env, { confirm: "wren", families: ["assets"], dryRun: false });
  assert.equal(withAssets.copied, 1);
  assert.equal(r2.store.has("t/wren/assets/" + "b".repeat(40)), true);

  const bad = await W.rekeyToSegment(CTX("wren"), env, { confirm: "wren", families: ["blobs"], dryRun: false });
  assert.deepEqual(bad, { ok: false, reason: "unknown-family", unknown: ["blobs"] });
});
