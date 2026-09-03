// Seed content always yields to a real publish — decided once, in the composer both sides run.
//
// `F-seed-yields-to-real-publish`. Measured on staging: on a freshly provisioned workspace
// (seed pack at version 1), editing one line of a start-here page in a PLAIN COPY of the
// tree — no git history — and running `augur ship` was refused: "differs from live but
// neither side is provable — live stays". Only `--takeover` landed it. The reconciliation
// treated the seed like any other unprovable live version, but a seed version is nobody's
// work: the manifest says so (`source.seed`, `routing.unitSources[unit].seed`) and
// `isSeedSource()` is the one predicate that reads it.
//
// THE DECISION LIVES IN `composePublish`, NOT IN THE EVIDENCE. The evidence is what each
// caller can prove — git for the CLI, the base manifest for the store — and `C-fork-on-
// conflict` moved the composer into src/ precisely so a repo-less publisher whose conflict
// the STORE resolves gets the same verdict a CLI gets. A rule written into the CLI's
// evidence alone would leave the server deciding by byte identity, which happens to agree
// today only because a re-seed never bumps the version. The tests below run BOTH paths
// against the real seed pack, the same one a provisioning writes.
//
// AND "CHANGED" MEANS THE SOURCE CHANGED, not the served bytes. Every authored page leaves
// the build with the engine's fingerprint in it (og meta carries the origin, the linked
// stamp carries the engine), so a clone's build of an untouched seed page is rarely
// byte-identical to the pack's. The commit handler already judges provenance on `sh` — the
// hash of a page's bytes BEFORE decoration — and the yield judges on the same field, so
// the five pages a person did not touch keep the seed marker instead of quietly becoming
// "theirs" on the first publish and being refused on the second.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { buildSeedPack, SEED_CONNECT_FILE } from "../scripts/lib/seed-pack-build.mjs";
import { publishSeedPack } from "../src/seed-pack.mjs";
import { composePublish } from "../src/publish-compose.mjs";
import { collectEvidence } from "../scripts/lib/publish-evidence.mjs";
import { isSeedSource, seedSource } from "../src/provenance.mjs";
import { __testables as W } from "../src/_worker.js";

const ENGINE = fileURLToPath(new URL("..", import.meta.url));
const AT = "2026-09-02T10:00:00.000Z";
const sha = (s) => createHash("sha256").update(s).digest("hex");
const file = (body) => ({ h: sha(body), ct: "text/html; charset=utf-8", s: body.length });

// ── the furnished workspace ─────────────────────────────────────────────────────────

/** An R2-shaped store holding real bytes under real keys — the fork-on-conflict harness's
 *  shape plus what the seed writer needs, so ONE stub serves the seed publish and the
 *  worker's commit handler alike. */
function r2Stub() {
  const map = new Map();
  const obj = (k) => {
    const v = map.get(k);
    return {
      key: k, size: v.byteLength, body: v,
      async text() { return new TextDecoder().decode(v); },
      async arrayBuffer() { return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength); },
    };
  };
  return {
    map,
    async get(k) { return map.has(k) ? obj(k) : null; },
    async head(k) { return map.has(k) ? { key: k, size: map.get(k).byteLength } : null; },
    async put(k, v) {
      map.set(k, typeof v === "string" ? new TextEncoder().encode(v)
        : v instanceof Uint8Array ? v
        : v && v.byteLength !== undefined ? new Uint8Array(v)
        : new TextEncoder().encode(JSON.stringify(v)));
    },
    async delete(k) { map.delete(k); },
    async list({ prefix = "" } = {}) {
      return { objects: [...map.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ key: k })), truncated: false };
    },
  };
}

// The pack is built ONCE for the whole file: a child build of seed/ (~1s).
const PACK = buildSeedPack({ engineRoot: ENGINE });
const SPACE = PACK.space.id;
const CONNECT_PATH = SEED_CONNECT_FILE;                       // /start-here/connect-your-terminal/index.html
const CONNECT_UNIT = "/start-here/connect-your-terminal/";
const SAMPLE_UNIT = "/start-here/sample-with-comments/";
const SAMPLE_PATH = `${SAMPLE_UNIT}index.html`;
const DESIGN_UNIT = "/start-here/set-up-your-design-system/";
const SKILL_PATH = Object.keys(PACK.files).find((p) => p.startsWith("/skills/starter-ui/") && p.endsWith(".css"));
assert.ok(SKILL_PATH, "the seed pack ships a starter design-system stylesheet");
assert.ok(PACK.files[CONNECT_PATH].sh, "the seed pack records a source hash for its authored pages");

/** A store with the seed pack live as version 1 — exactly what a provisioning writes. */
async function seededStore() {
  const r2 = r2Stub();
  await publishSeedPack({ store: r2, pack: PACK, workspaceId: "ws", at: AT, origin: "https://ws.example.test" });
  const live = JSON.parse(await (await r2.get(`spaces/${SPACE}/manifest.json`)).text());
  return { r2, live };
}

const clone = (m) => JSON.parse(JSON.stringify(m));

/** What a PLAIN COPY of the tree builds: the live file map, with no repo state at all —
 *  `repoState()` on a directory that is not a repository answers exactly this. */
function treeOf(live) {
  const mine = clone(live);
  for (const k of ["version", "publishedAt", "publishedBy", "bytesReferenced"]) delete mine[k];
  mine.source = { sha: null, dirty: false };
  return mine;
}

/** One line changed in a page: new bytes AND a new source hash, as the build records it. */
function edit(m, p, body) {
  m.files[p] = { ...m.files[p], ...file(body), sh: sha(`source of ${body}`) };
  return m;
}

/** A page re-decorated by a different engine: new served bytes, the SAME source. */
function redecorate(m, p) {
  m.files[p] = { ...m.files[p], ...file(`chrome churn on ${p}`), sh: m.files[p].sh };
  return m;
}

/** Bytes for every file the manifest names, so the store's spot-check passes. */
async function storeBlobs(r2, m) {
  for (const f of Object.values(m.files)) if (!(await r2.head(`blobs/${f.h}`))) await r2.put(`blobs/${f.h}`, "x");
}

// A directory that is NOT a git repository: the plain copy of the tree.
const plain = mkdtempSync(path.join(os.tmpdir(), "augur-plain-copy-"));
test.after(() => rmSync(plain, { recursive: true, force: true }));

const cliCompose = (mine, live, extra = {}) => {
  const ev = collectEvidence({ sourceDir: plain, spaceBase: "", mine, live });
  return composePublish({ mine, live, who: "someone", evidence: ev, ffUnits: ev.ffUnits, ...extra }).then((out) => ({ ...out, ev }));
};

const seedUnits = (m) => m.routing.publicPrefixes.filter((u) => isSeedSource(m.routing.unitSources[u]));

// ── the CLI: a plain copy, one edit, no flag ────────────────────────────────────────

test("A PLAIN COPY OF THE TREE PUBLISHES ONE EDITED START-HERE PAGE OVER THE SEED — no flag, no note, the other five still seed", async () => {
  const { live } = await seededStore();
  assert.equal(seedUnits(live).length, 6, "the furnished workspace opens with six seed units");
  const mine = edit(treeOf(live), CONNECT_PATH, "my connect page");

  const { manifest, summary, ev } = await cliCompose(mine, live);
  // The evidence itself is empty — no git, nothing provable. That is what used to refuse.
  assert.equal(ev.editedUnits.size, 0);
  assert.equal(ev.ffUnits.size, 0, "no git history: nothing is a fast-forward by git's rule");
  assert.deepEqual(ev.unprovable, [], "a seed unit is the platform's, which is a provenance — not an unprovable one");

  assert.equal(manifest.files[CONNECT_PATH].h, sha("my connect page"), "the edit did not land");
  assert.deepEqual(summary.kept, [], "the note that used to say 'live stays' has nothing to say");
  assert.deepEqual(summary.forked, []);
  assert.deepEqual(summary.seeded, [CONNECT_UNIT], "the replaced seed unit is named, once");
  assert.equal(isSeedSource(manifest.routing.unitSources[CONNECT_UNIT]), false, "the republished unit is a person's now");
  // Every unit this tree did not touch is byte-for-byte the seed's, and still reads as seed.
  for (const u of live.routing.publicPrefixes.filter((u) => u !== CONNECT_UNIT)) {
    for (const p of Object.keys(live.files).filter((p) => p.startsWith(u))) {
      assert.equal(manifest.files[p].h, live.files[p].h, `${p} changed under a publish that did not touch it`);
    }
    assert.ok(isSeedSource(manifest.routing.unitSources[u]), `${u} lost the seed marker without being edited`);
  }
  assert.deepEqual([...manifest.routing.publicPrefixes].sort(), [...live.routing.publicPrefixes].sort());
});

test("⚠️ AN UNTOUCHED SEED PAGE RE-DECORATED BY THIS TREE'S ENGINE KEEPS THE SEED'S BYTES AND MARKER — the yield judges the SOURCE, not the chrome", async () => {
  const { live } = await seededStore();
  const mine = edit(treeOf(live), CONNECT_PATH, "my connect page");
  for (const p of [SAMPLE_PATH, `${DESIGN_UNIT}index.html`]) redecorate(mine, p);

  const { manifest, summary } = await cliCompose(mine, live);
  assert.deepEqual(summary.seeded, [CONNECT_UNIT], "only the page whose source changed replaced the seed");
  assert.deepEqual(summary.kept, [], "and re-decoration is not reported as 'kept' — nothing was held back");
  assert.equal(manifest.files[SAMPLE_PATH].h, live.files[SAMPLE_PATH].h, "the served bytes stay the seed's");
  assert.ok(isSeedSource(manifest.routing.unitSources[SAMPLE_UNIT]));
  assert.ok(isSeedSource(manifest.routing.unitSources[DESIGN_UNIT]));
  assert.equal(seedUnits(manifest).length, 5);
});

test("ONCE A PERSON HAS REPUBLISHED A UNIT, ORDINARY RULES APPLY: the same plain copy editing it again is refused, as any unprovable divergence is", async () => {
  const { live } = await seededStore();
  const first = await cliCompose(edit(treeOf(live), CONNECT_PATH, "my connect page"), live);
  // Version 2 is what the store now holds: a real publish's provenance on the manifest,
  // the one replaced unit a person's, the other five still the seed's.
  const live2 = { ...first.manifest, version: 2, publishedAt: AT, publishedBy: "person@example.test" };

  const again = await cliCompose(edit(treeOf(live2), CONNECT_PATH, "my connect page, second draft"), live2);
  assert.ok(again.ev.unprovable.includes(CONNECT_UNIT), "no git, a real live version: neither side is provable");
  assert.deepEqual(again.summary.kept, [CONNECT_UNIT], "live stays — the rule every real unit has always had");
  assert.equal(again.manifest.files[CONNECT_PATH].h, sha("my connect page"), "the second draft did not overwrite the first");
  assert.deepEqual(again.summary.seeded, []);

  // While a DIFFERENT seed page edited from the same copy still yields: the marker is per unit.
  const other = await cliCompose(edit(treeOf(live2), SAMPLE_PATH, "my sample page"), live2);
  assert.deepEqual(other.summary.seeded, [SAMPLE_UNIT]);
  assert.equal(other.manifest.files[SAMPLE_PATH].h, sha("my sample page"));
  assert.equal(seedUnits(other.manifest).length, 4);
});

test("a real live version whose provenance is merely UNKNOWN is protected exactly as before", async () => {
  // The seed's sha is an engine commit no space repo has; a person's unpushed commit is
  // the same shape to git. Only the marker tells them apart, and only the marker yields.
  const { live } = await seededStore();
  const real = clone(live);
  real.source = { sha: "f".repeat(40), dirty: false, actor: "colleague" };
  real.publishedBy = "colleague@example.test";
  for (const u of real.routing.publicPrefixes) real.routing.unitSources[u] = { sha: "f".repeat(40), dirty: false };
  const { manifest, summary, ev } = await cliCompose(edit(treeOf(real), CONNECT_PATH, "my connect page"), real);
  assert.ok(ev.unprovable.includes(CONNECT_UNIT));
  assert.deepEqual(summary.kept, [CONNECT_UNIT]);
  assert.deepEqual(summary.seeded, []);
  assert.equal(manifest.files[CONNECT_PATH].h, real.files[CONNECT_PATH].h);
});

// ── the seed page a person DELETED rather than edited ───────────────────────────────

test("A SEED PAGE THE TREE LACKS IS A DELETION THE TREE NEED NOT PROVE — it drops with --allow-unpublish and is NAMED without it", async () => {
  const { live } = await seededStore();
  const mine = treeOf(live);
  for (const p of Object.keys(mine.files)) if (p.startsWith(SAMPLE_UNIT)) delete mine.files[p];
  mine.routing.publicPrefixes = mine.routing.publicPrefixes.filter((u) => u !== SAMPLE_UNIT);
  delete mine.routing.versionMap[SAMPLE_UNIT];
  delete mine.routing.unitSources[SAMPLE_UNIT];

  // Without the flag: live stays, and the publisher is told why — not silence.
  const kept = await cliCompose(mine, live);
  assert.deepEqual(kept.summary.removalBlocked, [SAMPLE_UNIT]);
  assert.ok(kept.manifest.routing.publicPrefixes.includes(SAMPLE_UNIT));
  assert.equal(kept.manifest.files[SAMPLE_PATH].h, live.files[SAMPLE_PATH].h);
  assert.ok(isSeedSource(kept.manifest.routing.unitSources[SAMPLE_UNIT]));

  // With it: gone, like any evidenced deletion. The store's unpublish guard still stands
  // behind this — the flag rides in the commit body as it always has.
  const gone = await cliCompose(mine, live, { allowUnpublish: true });
  assert.deepEqual(gone.summary.removed, [SAMPLE_UNIT]);
  assert.equal(gone.manifest.routing.publicPrefixes.includes(SAMPLE_UNIT), false);
  assert.equal(SAMPLE_PATH in gone.manifest.files, false);
  assert.equal(SAMPLE_UNIT in gone.manifest.routing.unitSources, false);
});

test("but a REAL live unit the tree lacks stays live silently, as it always has — a git-less tree cannot prove that deletion", async () => {
  const { live } = await seededStore();
  const live2 = { ...(await cliCompose(edit(treeOf(live), CONNECT_PATH, "my connect page"), live)).manifest, version: 2 };
  const mine = treeOf(live2);
  for (const p of Object.keys(mine.files)) if (p.startsWith(CONNECT_UNIT)) delete mine.files[p];
  mine.routing.publicPrefixes = mine.routing.publicPrefixes.filter((u) => u !== CONNECT_UNIT);
  const { manifest, summary } = await cliCompose(mine, live2, { allowUnpublish: true });
  assert.deepEqual(summary.removed, []);
  assert.deepEqual(summary.removalBlocked, []);
  assert.ok(manifest.routing.publicPrefixes.includes(CONNECT_UNIT), "a person's unit was dropped on no evidence");
});

// ── the design system the start-here page tells them to edit ────────────────────────

test("a seeded skill file yields while the live manifest is still the seed's, and follows the ordinary rule after the first real publish", async () => {
  const { live } = await seededStore();
  const mine = treeOf(live);
  mine.files[SKILL_PATH] = { ...mine.files[SKILL_PATH], ...file("body { --ink: hotpink }") };
  const first = await cliCompose(mine, live);
  assert.equal(first.manifest.files[SKILL_PATH].h, sha("body { --ink: hotpink }"), "the design-system edit did not land");
  assert.deepEqual(first.summary.kept, []);

  // ⏳ A skill file carries no per-file provenance marker, so once the manifest's own
  // source is a person's the file follows the rule every shared file has: evidence or
  // live stays. Pinned so the day a per-file marker exists, this line is what to change.
  const live2 = { ...first.manifest, version: 2, publishedBy: "person@example.test" };
  const mine2 = treeOf(live2);
  mine2.files[SKILL_PATH] = { ...mine2.files[SKILL_PATH], ...file("body { --ink: teal }") };
  const second = await cliCompose(mine2, live2);
  assert.equal(second.manifest.files[SKILL_PATH].h, sha("body { --ink: hotpink }"));
  assert.deepEqual(second.summary.kept, [SKILL_PATH]);
});

// ── the server: a repo-less publisher gets the same verdict ─────────────────────────

const CTX = W.applyInstance({ users: [] });
const commit = async (r2, manifest) => {
  await storeBlobs(r2, manifest);
  const env = { BUNDLES: r2, PUBLISH_BOOTSTRAP_TOKEN: "tok" };
  return W.publishApi(
    CTX,
    new Request(`https://x.test/__publish/${SPACE}/commit`, {
      method: "POST",
      headers: { Authorization: "Bearer tok", "content-type": "application/json" },
      body: JSON.stringify(manifest),
    }),
    new URL(`https://x.test/__publish/${SPACE}/commit`),
    env);
};
const liveNow = async (r2) => JSON.parse(await (await r2.get(`spaces/${SPACE}/manifest.json`)).text());

test("THE STORE RESOLVES A REPO-LESS PUBLISHER'S STALE BASE THE SAME WAY: their seed edit lands, a colleague's real page is kept, no fork", async () => {
  const { r2, live } = await seededStore();
  // A colleague's real publish moved live to v2 while this publisher worked from v1.
  const v2 = edit(clone(live), SAMPLE_PATH, "their sample page");
  Object.assign(v2, { version: 2, source: { sha: "c0ffee", dirty: false, actor: "colleague" }, publishedBy: "colleague@example.test" });
  v2.routing.unitSources[SAMPLE_UNIT] = { sha: "c0ffee", dirty: false };
  await storeBlobs(r2, v2);
  await r2.put(`spaces/${SPACE}/versions/2.json`, JSON.stringify(v2));
  await r2.put(`spaces/${SPACE}/manifest.json`, JSON.stringify(v2));

  const mine = edit(treeOf(live), CONNECT_PATH, "my connect page");
  const res = await commit(r2, { ...mine, baseVersion: 1, forkOnConflict: true });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.forks, undefined, "a seed page is not contested");
  const after = await liveNow(r2);
  assert.equal(after.version, 3);
  assert.equal(after.files[CONNECT_PATH].h, sha("my connect page"), "the repo-less edit did not land");
  assert.equal(after.files[SAMPLE_PATH].h, sha("their sample page"), "the colleague's real page was reverted");
  assert.equal(isSeedSource(after.routing.unitSources[CONNECT_UNIT]), false);
  assert.equal(isSeedSource(after.routing.unitSources[SAMPLE_UNIT]), false);
  assert.ok(isSeedSource(after.routing.unitSources[DESIGN_UNIT]), "an untouched seed unit lost its marker");
});

test("⚠️ THE STORE YIELDS ON THE MARKER, NOT ON BYTE IDENTITY: a re-seeded live page still yields, and the same bytes under a person's name still fork", async () => {
  // A re-seed rewrites the pack (a refilled connect line, a newer pack) without a person
  // touching anything. Against the BASE the unit now differs on both sides, which is the
  // shape the resolver forks — unless it reads the marker.
  const reseed = async () => {
    const { r2, live } = await seededStore();
    const v2 = edit(clone(live), CONNECT_PATH, "the pack, refilled");
    Object.assign(v2, { version: 2, source: seedSource({ sha: "engine2", dirty: false, at: AT }) });
    v2.routing.unitSources[CONNECT_UNIT] = seedSource({ sha: "engine2", dirty: false });
    return { r2, live, v2 };
  };
  const put = async (r2, m) => {
    await storeBlobs(r2, m);
    await r2.put(`spaces/${SPACE}/versions/${m.version}.json`, JSON.stringify(m));
    await r2.put(`spaces/${SPACE}/manifest.json`, JSON.stringify(m));
  };

  const a = await reseed();
  await put(a.r2, a.v2);
  const yielded = await commit(a.r2, { ...edit(treeOf(a.live), CONNECT_PATH, "my connect page"), baseVersion: 1, forkOnConflict: true });
  assert.equal(yielded.status, 200);
  assert.equal((await yielded.json()).forks, undefined, "a seed-marked page forked against its own editor");
  assert.equal((await liveNow(a.r2)).files[CONNECT_PATH].h, sha("my connect page"));

  // Control: the identical v2 bytes, published by a PERSON — today's rule, untouched.
  const b = await reseed();
  Object.assign(b.v2, { source: { sha: "c0ffee", dirty: false, actor: "colleague" }, publishedBy: "colleague@example.test" });
  b.v2.routing.unitSources[CONNECT_UNIT] = { sha: "c0ffee", dirty: false };
  await put(b.r2, b.v2);
  const forked = await commit(b.r2, { ...edit(treeOf(b.live), CONNECT_PATH, "my connect page"), baseVersion: 1, forkOnConflict: true });
  assert.equal(forked.status, 200);
  const forks = (await forked.json()).forks;
  assert.equal((forks || []).length, 1, "a person's concurrent edit stopped being a conflict");
  assert.equal(forks[0].unit, CONNECT_UNIT);
  assert.equal((await liveNow(b.r2)).files[CONNECT_PATH].h, sha("the pack, refilled"), "theirs keeps the URL");
});

test("the composer's verdict is the same object on both sides — no second implementation to drift", async () => {
  const cli = await import("../scripts/lib/publish-compose.mjs");
  assert.equal(cli.composePublish, composePublish);
});
