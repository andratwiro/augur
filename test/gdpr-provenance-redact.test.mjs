// Redacting a purged person from stored publish provenance.
//
// `E-gdpr-provenance-redact`. Every published version records who committed it, and the
// label on a publish token IS an address. Three write sites, in two shapes: a clean field
// (`publishedBy: <label>`) and an address interpolated into a sentence (`rollback to v3 by
// <label>`, `delete by <label>`). The sentences are why this is string surgery and not a
// value swap.
//
// The sharp part is not the sweep. It is that `/_build.json` is served BEFORE the gate and
// derives what it shows from these stored records, so a leftover address surfaces publicly
// as a bare local-part.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

const { redactPublishedBy, redactProvenance, PURGED_PUBLISHER, synthBuildStamp } = W;

const ME = "ada@example.test";
const OTHER = "grace@example.test";

/** A stand-in R2 bucket. */
function memR2(seed = {}) {
  const m = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    store: m,
    get: async (k) => (m.has(k) ? { text: async () => m.get(k) } : null),
    put: async (k, v) => { m.set(k, v); },
    list: async ({ prefix = "", cursor } = {}) => ({
      objects: [...m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
      truncated: false, cursor: null,
    }),
    json: (k) => JSON.parse(m.get(k)),
  };
}

// ── the string surgery ───────────────────────────────────────────────────────

test("the clean-field shape becomes the sentinel", () => {
  assert.equal(redactPublishedBy(ME, ME), PURGED_PUBLISHER);
  assert.equal(redactPublishedBy("Ada@Example.TEST", ME), PURGED_PUBLISHER, "the match must be case-insensitive");
});

test("the sentence shapes keep their sentence and lose the address", () => {
  assert.equal(redactPublishedBy(`rollback to v3 by ${ME}`, ME), `rollback to v3 by ${PURGED_PUBLISHER}`);
  assert.equal(redactPublishedBy(`delete by ${ME}`, ME), `delete by ${PURGED_PUBLISHER}`);
  // The version number and the verb are the useful part of the record and are not the
  // person; erasing the whole field would delete a fact about the workspace.
  assert.match(redactPublishedBy(`rollback to v3 by ${ME}`, ME), /rollback to v3/);
});

test("somebody else's record is left exactly alone", () => {
  assert.equal(redactPublishedBy(OTHER, ME), null);
  assert.equal(redactPublishedBy(`delete by ${OTHER}`, ME), null);
  assert.equal(redactPublishedBy("", ME), null);
  assert.equal(redactPublishedBy(undefined, ME), null);
});

test("an address with regex metacharacters is handled as text", () => {
  // Building a regex from an address is how a purge of `a+b@x.test` either misses or
  // throws. This does index-of surgery instead.
  const odd = "a+b(c)[d]@example.test";
  assert.equal(redactPublishedBy(`delete by ${odd}`, odd), `delete by ${PURGED_PUBLISHER}`);
});

test("every occurrence goes, not just the first", () => {
  assert.equal(
    redactPublishedBy(`${ME} rolled back a publish by ${ME}`, ME),
    `${PURGED_PUBLISHER} rolled back a publish by ${PURGED_PUBLISHER}`,
  );
});

// ── the sweep ────────────────────────────────────────────────────────────────

test("every stored version and the live manifest are swept, bounded to the workspace", () => {
  const r2 = memR2({
    "spaces/delta/versions/1.json": { version: 1, publishedBy: ME },
    "spaces/delta/versions/2.json": { version: 2, publishedBy: `rollback to v1 by ${ME}` },
    "spaces/delta/versions/3.json": { version: 3, publishedBy: OTHER },
    "spaces/delta/manifest.json": { version: 3, publishedBy: `delete by ${ME}` },
    // A NEIGHBOUR's history, under its own prefix. It must not be touched.
    "spaces/fulla/versions/1.json": { version: 1, publishedBy: ME },
    "spaces/fulla/manifest.json": { version: 1, publishedBy: ME },
  });
  return redactProvenance({ BUNDLES: r2 }, "delta", ME).then((r) => {
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.redacted, 3);
    assert.deepEqual(r.versions.sort(), ["1", "2"]);
    assert.equal(r.manifest, true);

    assert.equal(r2.json("spaces/delta/versions/1.json").publishedBy, PURGED_PUBLISHER);
    assert.equal(r2.json("spaces/delta/versions/2.json").publishedBy, `rollback to v1 by ${PURGED_PUBLISHER}`);
    assert.equal(r2.json("spaces/delta/versions/3.json").publishedBy, OTHER, "a live user's history was touched");
    assert.equal(r2.json("spaces/delta/manifest.json").publishedBy, `delete by ${PURGED_PUBLISHER}`);

    // The bound. Versions are keyed per space, so one workspace's erasure cannot reach
    // another's history — and this asserts the sweep actually respects that.
    assert.equal(r2.json("spaces/fulla/versions/1.json").publishedBy, ME, "a NEIGHBOUR workspace's history was swept");
    assert.equal(r2.json("spaces/fulla/manifest.json").publishedBy, ME);
  });
});

test("the version number and other fields survive", () => {
  const r2 = memR2({ "spaces/d/versions/7.json": { version: 7, files: { "/a": 1 }, publishedAt: "t", publishedBy: ME } });
  return redactProvenance({ BUNDLES: r2 }, "d", ME).then(() => {
    const doc = r2.json("spaces/d/versions/7.json");
    assert.equal(doc.version, 7);
    assert.deepEqual(doc.files, { "/a": 1 });
    assert.equal(doc.publishedAt, "t");
  });
});

test("no bundle store refuses instead of reporting success", async () => {
  assert.equal((await redactProvenance({}, "d", ME)).reason, "no-bundle-store");
  assert.equal((await redactProvenance({ BUNDLES: memR2() }, "d", "")).reason, "bad-address");
});

test("malformed stored JSON is skipped, not thrown on", async () => {
  const r2 = memR2({ "spaces/d/versions/1.json": { publishedBy: ME } });
  r2.store.set("spaces/d/versions/2.json", "not json");
  const r = await redactProvenance({ BUNDLES: r2 }, "d", ME);
  assert.equal(r.ok, true);
  assert.equal(r.redacted, 1);
});

// ── the property the VERIFY actually checks ─────────────────────────────────

test("AFTER THE SWEEP, /_build.json cannot show the local-part either", () => {
  // This is the reason the sweep matters at all. /_build.json is served BEFORE the gate,
  // and synthBuildStamp's byName falls back to label.split("@")[0] — the local-part — for
  // a label it does not recognise. So a leftover address surfaces publicly as a bare name.
  //
  // It cannot, because every write site stores the FULL address, so removing the address
  // removes the only thing the local-part could be derived from. That is not obvious from
  // the sweep alone, which is why it is asserted here.
  const tctx = { INSTANCE_ENGINE_VERSION: "", USERS: [], SPACES: [{ id: "delta", default: true }] };
  const before = JSON.stringify(synthBuildStamp(tctx, { delta: { id: "delta", version: 2, publishedBy: `rollback to v1 by ${ME}` } }));
  assert.match(before, /ada/, "the fixture does not reproduce the leak, so this test proves nothing");

  const after = JSON.stringify(synthBuildStamp(tctx, {
    delta: { id: "delta", version: 2, publishedBy: redactPublishedBy(`rollback to v1 by ${ME}`, ME) },
  }));
  assert.ok(!after.includes(ME), "the raw address survives in the public stamp");
  assert.ok(!after.includes("ada"), `the local-part survives in the public stamp: ${after}`);
  assert.match(after, /rollback to v1/, "the useful part of the record was erased along with the person");
});
