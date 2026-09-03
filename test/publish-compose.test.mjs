// Composed publish (protocol 5): the live manifest is the base; a publisher's
// build lands per unit only where it is a fast-forward of live or where git
// evidences an edit. These tests pin the property that killed the 2026-08-22
// cascade: a stale or divergent tree CANNOT revert, unpublish, adopt, or fork
// units it never edited — and the working tree is never written to at all
// (composePublish is pure; there is nothing to write with).
import { test } from "node:test";
import assert from "node:assert/strict";
import { composePublish, filterLitter, LITTER_RE } from "../scripts/lib/publish-compose.mjs";

const H = (c) => String(c).repeat(64).slice(0, 64);
const entry = (h) => ({ h: H(h), ct: "text/html; charset=utf-8", s: 10 });
const mani = ({ files = {}, prefixes = [], skills = [], source = null, unitSources = null, publishedBy = null } = {}) => ({
  files,
  routing: {
    publicPrefixes: prefixes, versionMap: {}, publicSkillPrefixes: skills,
    ...(unitSources ? { unitSources } : {}),
  },
  ...(source ? { source } : {}),
  ...(publishedBy ? { publishedBy } : {}),
});
const unit = (name, h) => ({ [`/toolkit/${name}/index.html`]: entry(h) });
const compose = (over = {}) => composePublish({
  who: "tester",
  evidence: { editedUnits: new Set(), dirtyUnits: new Set(), deletedUnits: new Set(), editedPaths: new Set() },
  ffUnits: new Set(),
  ...over,
});

// ── the litter filter (lint-grade hard rule) ─────────────────────────────────

test("filterLitter drops tree-derived -conflict- units: files, prefixes, versionMap", () => {
  const m = mani({
    files: { ...unit("map", "a"), "/toolkit/map-conflict-demo/index.html": entry("b") },
    prefixes: ["/toolkit/map/", "/toolkit/map-conflict-demo/"],
  });
  m.routing.versionMap["/toolkit/map-conflict-demo/"] = "1";
  const dropped = filterLitter(m);
  assert.deepEqual(dropped, ["/toolkit/map-conflict-demo/"]);
  assert.deepEqual(m.routing.publicPrefixes, ["/toolkit/map/"]);
  assert.equal("/toolkit/map-conflict-demo/index.html" in m.files, false);
  assert.equal("/toolkit/map-conflict-demo/" in m.routing.versionMap, false);
});

test("second-order fork names match the litter rule too", () => {
  assert.ok(LITTER_RE.test("/toolkit/x-conflict-demo/"));
  assert.ok(LITTER_RE.test("/toolkit/x-conflict-demo-conflict-demo/"));
  assert.ok(LITTER_RE.test("/playground/y-conflict-wvanransbeeck/"));
  assert.equal(LITTER_RE.test("/toolkit/deconflict-panel/"), false, "only the -conflict-<who> suffix");
});

// ── the cascade killer: no evidence ⇒ live's bytes stay, verbatim ────────────

test("a differing unit with NO local evidence keeps live's bytes (never adopt, never fork)", async () => {
  const mine = mani({ files: unit("map", "m"), prefixes: ["/toolkit/map/"] });
  const live = mani({ files: unit("map", "L"), prefixes: ["/toolkit/map/"], source: { sha: "s1", dirty: true } });
  const { manifest, summary } = await compose({ mine, live });
  assert.equal(manifest.files["/toolkit/map/index.html"].h, H("L"), "live's hash survives");
  assert.deepEqual(summary.forked, []);
  assert.deepEqual(summary.kept, ["/toolkit/map/"]);
});

test("139 stale units fork nothing — the 2026-08-22 shape, replayed", async () => {
  const mineFiles = {}, liveFiles = {}, prefixes = [];
  for (let i = 0; i < 139; i++) {
    Object.assign(mineFiles, unit(`u${i}`, "m"));
    Object.assign(liveFiles, unit(`u${i}`, "L"));
    prefixes.push(`/toolkit/u${i}/`);
  }
  const mine = mani({ files: mineFiles, prefixes });
  const live = mani({ files: liveFiles, prefixes, source: { sha: "dead", dirty: true } });
  const { manifest, summary } = await compose({ mine, live });
  assert.equal(summary.forked.length, 0);
  assert.equal(summary.kept.length, 139);
  assert.equal(manifest.routing.publicPrefixes.length, 139, "no fork prefixes minted");
  for (const p of prefixes) assert.equal(manifest.files[`${p}index.html`].h, H("L"));
});

// ── fast-forward ships, and stamps provenance ────────────────────────────────

test("a fast-forward unit ships mine and stamps unitSources", async () => {
  const mine = mani({ files: unit("map", "m"), prefixes: ["/toolkit/map/"], source: { sha: "MYHEAD", dirty: false } });
  const live = mani({ files: unit("map", "L"), prefixes: ["/toolkit/map/"], source: { sha: "OLD", dirty: false } });
  const { manifest, summary } = await compose({ mine, live, ffUnits: new Set(["/toolkit/map/"]) });
  assert.equal(manifest.files["/toolkit/map/index.html"].h, H("m"));
  assert.deepEqual(summary.shipped, ["/toolkit/map/"]);
  assert.deepEqual(manifest.routing.unitSources["/toolkit/map/"], { sha: "MYHEAD", dirty: false });
});

test("kept units carry live's unitSources through (or synthesize from live.source)", async () => {
  const mine = mani({ files: { ...unit("a", "x"), ...unit("b", "x") }, prefixes: ["/toolkit/a/", "/toolkit/b/"] });
  const live = mani({
    files: { ...unit("a", "x"), ...unit("b", "x") }, prefixes: ["/toolkit/a/", "/toolkit/b/"],
    source: { sha: "S", dirty: false }, unitSources: { "/toolkit/a/": { sha: "A1", dirty: false } },
  });
  const { manifest } = await compose({ mine, live });
  assert.deepEqual(manifest.routing.unitSources["/toolkit/a/"], { sha: "A1", dirty: false });
  assert.deepEqual(manifest.routing.unitSources["/toolkit/b/"], { sha: "S", dirty: false });
});

// ── evidence without proof: tolerant check, then a manifest-only fork ────────

test("evidenced edit that is only volatile-head noise keeps live's", async () => {
  const mine = mani({ files: unit("map", "m"), prefixes: ["/toolkit/map/"] });
  const live = mani({ files: unit("map", "L"), prefixes: ["/toolkit/map/"], source: { sha: "x", dirty: true } });
  const { manifest, summary } = await compose({
    mine, live,
    evidence: { editedUnits: new Set(["/toolkit/map/"]), dirtyUnits: new Set(), deletedUnits: new Set(), editedPaths: new Set() },
    tolerantEqual: async () => true,
  });
  assert.equal(manifest.files["/toolkit/map/index.html"].h, H("L"));
  assert.equal(summary.forked.length, 0);
});

test("a real contested edit forks in the manifest: theirs at the URL, mine at -conflict-<who>", async () => {
  const mine = mani({
    files: { "/toolkit/map/index.html": entry("m"), "/toolkit/map/app.js": { h: H("j"), ct: "text/javascript", s: 5 } },
    prefixes: ["/toolkit/map/"], source: { sha: "MYHEAD", dirty: true },
  });
  const live = mani({
    files: unit("map", "L"), prefixes: ["/toolkit/map/"],
    source: { sha: "x", dirty: true }, publishedBy: "them@example.com",
  });
  const { manifest, summary, readMap, extraBlobs } = await compose({
    mine, live,
    evidence: { editedUnits: new Set(["/toolkit/map/"]), dirtyUnits: new Set(["/toolkit/map/"]), deletedUnits: new Set(), editedPaths: new Set() },
  });
  assert.equal(manifest.files["/toolkit/map/index.html"].h, H("L"), "theirs keeps the URL");
  assert.equal(manifest.files["/toolkit/map-conflict-tester/index.html"].h, H("m"), "mine is live at the fork");
  assert.equal(manifest.files["/toolkit/map-conflict-tester/app.js"].h, H("j"));
  assert.equal(readMap["/toolkit/map-conflict-tester/index.html"], "/toolkit/map/index.html",
    "fork bytes are read from the real unit's dist path");
  const note = manifest.files["/toolkit/map-conflict-tester/CONFLICT.md"];
  assert.ok(note && extraBlobs[note.h], "CONFLICT.md is synthesized, not read from any tree");
  // ⚠️ BYTES, NOT A Buffer. The module is runtime-agnostic now — the worker runs the same
  // composition and has no Buffer — so a synthesized blob is a Uint8Array and reading it as
  // text is the caller's decode. `String(bytes)` silently yields a comma-separated list of
  // byte values that matches no assertion and looks like a content bug.
  const noteText = new TextDecoder().decode(extraBlobs[note.h]);
  assert.match(noteText, /them@example\.com/);
  assert.match(noteText, /working tree was NOT touched/);
  assert.equal(summary.forked[0].fork, "/toolkit/map-conflict-tester/");
  assert.ok(manifest.routing.publicPrefixes.includes("/toolkit/map-conflict-tester/"));
});

test("a fork name another person already holds gets a numbered suffix", async () => {
  const mine = mani({ files: unit("map", "m"), prefixes: ["/toolkit/map/"], source: { sha: "s", dirty: true } });
  const live = mani({
    files: { ...unit("map", "L"), "/toolkit/map-conflict-tester/index.html": entry("old") },
    prefixes: ["/toolkit/map/", "/toolkit/map-conflict-tester/"], source: { sha: "x", dirty: true },
  });
  // Same display name, but the live fork is not provably mine: `who` is the anonymous fallback.
  const { summary: anon } = await compose({
    mine, live, who: "someone",
    evidence: { editedUnits: new Set(["/toolkit/map/"]), dirtyUnits: new Set(), deletedUnits: new Set(), editedPaths: new Set() },
  });
  assert.equal(anon.forked[0].fork, "/toolkit/map-conflict-someone/");
  live.routing.publicPrefixes.push("/toolkit/map-conflict-someone/");
  live.files["/toolkit/map-conflict-someone/index.html"] = entry("old");
  const { summary } = await compose({
    mine, live, who: "someone",
    evidence: { editedUnits: new Set(["/toolkit/map/"]), dirtyUnits: new Set(), deletedUnits: new Set(), editedPaths: new Set() },
  });
  assert.equal(summary.forked[0].fork, "/toolkit/map-conflict-someone-2/", "the anonymous name never reuses: it could be anybody's");
});

// ── additions, deletions, unpublish ──────────────────────────────────────────

test("my new unit ships; their live-only unit stays — implicit unpublish is impossible", async () => {
  const mine = mani({ files: unit("new", "n"), prefixes: ["/toolkit/new/"], source: { sha: "s", dirty: false } });
  const live = mani({ files: unit("theirs", "t"), prefixes: ["/toolkit/theirs/"], source: { sha: "x", dirty: true } });
  const { manifest, summary } = await compose({ mine, live });
  assert.deepEqual(manifest.routing.publicPrefixes, ["/toolkit/new/", "/toolkit/theirs/"]);
  assert.equal(manifest.files["/toolkit/theirs/index.html"].h, H("t"));
  assert.deepEqual(summary.newUnits, ["/toolkit/new/"]);
});

test("an evidenced deletion drops only with --allow-unpublish; otherwise it stays, loudly", async () => {
  const mine = mani({ files: {}, prefixes: [] });
  const live = mani({ files: unit("gone", "g"), prefixes: ["/toolkit/gone/"], source: { sha: "x", dirty: false } });
  const ev = { editedUnits: new Set(), dirtyUnits: new Set(), deletedUnits: new Set(["/toolkit/gone/"]), editedPaths: new Set() };
  const blocked = await compose({ mine, live, evidence: ev });
  assert.ok(blocked.manifest.routing.publicPrefixes.includes("/toolkit/gone/"));
  assert.deepEqual(blocked.summary.removalBlocked, ["/toolkit/gone/"]);
  const allowed = await compose({ mine, live, evidence: ev, allowUnpublish: true });
  assert.equal(allowed.manifest.routing.publicPrefixes.includes("/toolkit/gone/"), false);
  assert.deepEqual(allowed.summary.removed, ["/toolkit/gone/"]);
});

// ── shared skill files and generated pages ───────────────────────────────────

test("skill files: theirs kept without evidence, mine ships with it, new files ship", async () => {
  const mine = mani({
    files: { "/skills/ui/a.css": entry("mA"), "/skills/ui/b.css": entry("mB"), "/skills/ui/new.css": entry("mN") },
    prefixes: [], skills: ["/skills/ui/"],
  });
  const live = mani({
    files: { "/skills/ui/a.css": entry("LA"), "/skills/ui/b.css": entry("LB"), "/skills/ui/old.css": entry("LO") },
    prefixes: [], skills: ["/skills/ui/"], source: { sha: "x", dirty: true },
  });
  const { manifest } = await compose({
    mine, live,
    evidence: { editedUnits: new Set(), dirtyUnits: new Set(), deletedUnits: new Set(), editedPaths: new Set(["/skills/ui/b.css"]) },
  });
  assert.equal(manifest.files["/skills/ui/a.css"].h, H("LA"), "untouched skill file keeps live's bytes");
  assert.equal(manifest.files["/skills/ui/b.css"].h, H("mB"), "evidenced skill edit ships");
  assert.equal(manifest.files["/skills/ui/new.css"].h, H("mN"), "new skill file ships");
  assert.equal(manifest.files["/skills/ui/old.css"].h, H("LO"), "live-only skill file survives");
});

test("generated pages outside units are mine wholesale — regenerated every publish", async () => {
  const mine = mani({ files: { "/index.html": entry("mi"), "/toolkit/index.html": entry("mg") }, prefixes: [] });
  const live = mani({
    files: { "/index.html": entry("Li"), "/stale-gallery/index.html": entry("Ls") },
    prefixes: [], source: { sha: "x", dirty: false },
  });
  const { manifest } = await compose({ mine, live });
  assert.equal(manifest.files["/index.html"].h, H("mi"));
  assert.equal(manifest.files["/toolkit/index.html"].h, H("mg"));
  assert.equal("/stale-gallery/index.html" in manifest.files, false, "live-only generated output is replaced");
});

test("identical units pass through untouched, with live's provenance", async () => {
  const mine = mani({ files: unit("same", "s"), prefixes: ["/toolkit/same/"] });
  const live = mani({
    files: unit("same", "s"), prefixes: ["/toolkit/same/"],
    source: { sha: "x", dirty: false }, unitSources: { "/toolkit/same/": { sha: "S0", dirty: false } },
  });
  const { manifest, summary } = await compose({ mine, live });
  assert.equal(manifest.files["/toolkit/same/index.html"].h, H("s"));
  assert.deepEqual(summary.shipped, []);
  assert.deepEqual(summary.kept, []);
  assert.deepEqual(manifest.routing.unitSources["/toolkit/same/"], { sha: "S0", dirty: false });
});

// ── provenance heals; forks retire (the 2026-09-03 smear, replayed) ──────────
// One dirty publish from an engine clone that predated `unitSources` left a legacy
// manifest whose only provenance was space-level `{sha, dirty:true}`. The first
// composed publish over it synthesized THAT for all 158 untouched units, and from
// then on every clean edit by anybody forked as "contested" — three times for one
// person — although nobody had touched those units at all. Identical bytes from a
// clean tree are proof the unit IS that commit; the composer now says so.

test("identical bytes from a clean tree heal a dirty or unknown live provenance", async () => {
  const mine = mani({ files: { ...unit("a", "x"), ...unit("b", "y") }, prefixes: ["/toolkit/a/", "/toolkit/b/"], source: { sha: "CLEAN", dirty: false } });
  const live = mani({
    files: { ...unit("a", "x"), ...unit("b", "y") }, prefixes: ["/toolkit/a/", "/toolkit/b/"],
    source: { sha: "OLD", dirty: true }, // legacy: no unitSources at all
  });
  const { manifest, summary } = await compose({ mine, live });
  assert.deepEqual(manifest.routing.unitSources["/toolkit/a/"], { sha: "CLEAN", dirty: false });
  assert.deepEqual(manifest.routing.unitSources["/toolkit/b/"], { sha: "CLEAN", dirty: false });
  assert.deepEqual(summary.healed.sort(), ["/toolkit/a/", "/toolkit/b/"]);
  assert.deepEqual(summary.shipped, [], "nothing shipped: the bytes were already live");
});

test("a per-unit dirty live provenance heals too, when my copy of that unit is clean", async () => {
  const mine = mani({ files: unit("a", "x"), prefixes: ["/toolkit/a/"], source: { sha: "CLEAN", dirty: false } });
  const live = mani({ files: unit("a", "x"), prefixes: ["/toolkit/a/"], source: { sha: "S", dirty: false }, unitSources: { "/toolkit/a/": { sha: "S", dirty: true } } });
  const { manifest } = await compose({ mine, live });
  assert.deepEqual(manifest.routing.unitSources["/toolkit/a/"], { sha: "CLEAN", dirty: false });
});

test("no heal from a unit that is dirty in MY tree, from a repo-less tree, or over a clean provenance", async () => {
  const live = mani({ files: unit("a", "x"), prefixes: ["/toolkit/a/"], source: { sha: "OLD", dirty: true } });
  // dirty in my tree: the bytes match, but I cannot claim my commit produced them
  let r = await compose({
    mine: mani({ files: unit("a", "x"), prefixes: ["/toolkit/a/"], source: { sha: "CLEAN", dirty: true } }), live,
    evidence: { editedUnits: new Set(), dirtyUnits: new Set(["/toolkit/a/"]), deletedUnits: new Set(), editedPaths: new Set() },
  });
  assert.deepEqual(r.manifest.routing.unitSources["/toolkit/a/"], { sha: "OLD", dirty: true });
  // repo-less (the store's own composition): no sha to offer
  r = await compose({ mine: mani({ files: unit("a", "x"), prefixes: ["/toolkit/a/"] }), live });
  assert.deepEqual(r.manifest.routing.unitSources["/toolkit/a/"], { sha: "OLD", dirty: true });
  // live's provenance is already a clean commit: keep it — older is provable by more people
  const liveClean = mani({ files: unit("a", "x"), prefixes: ["/toolkit/a/"], source: { sha: "S", dirty: false }, unitSources: { "/toolkit/a/": { sha: "S0", dirty: false } } });
  r = await compose({ mine: mani({ files: unit("a", "x"), prefixes: ["/toolkit/a/"], source: { sha: "NEWER", dirty: false } }), live: liveClean });
  assert.deepEqual(r.manifest.routing.unitSources["/toolkit/a/"], { sha: "S0", dirty: false });
  assert.deepEqual(r.summary.healed, []);
});

test("the seed marker never heals away", async () => {
  const seed = { sha: "ENGINE", dirty: false, seed: true };
  const mine = mani({ files: unit("a", "x"), prefixes: ["/toolkit/a/"], source: { sha: "CLEAN", dirty: false } });
  const live = mani({ files: unit("a", "x"), prefixes: ["/toolkit/a/"], source: seed, unitSources: { "/toolkit/a/": seed } });
  const { manifest } = await compose({ mine, live });
  assert.deepEqual(manifest.routing.unitSources["/toolkit/a/"], seed);
});

test("a fork retires when its bytes reach the URL, or when its author ships the origin", async () => {
  const fork = (name, who, h, extra = {}) => ({
    [`/toolkit/${name}-conflict-${who}/index.html`]: entry(h),
    [`/toolkit/${name}-conflict-${who}/CONFLICT.md`]: { h: H("n"), ct: "text/markdown; charset=utf-8", s: 3 },
    ...extra,
  });
  const live = mani({
    files: {
      ...unit("map", "L"), ...fork("map", "wietse", "W"),          // W's edit, forked; the URL still has L
      ...unit("plan", "P"), ...fork("plan", "tester", "T"),        // my own earlier fork of plan
      ...unit("faq", "F"), ...fork("faq", "other", "O"),           // someone else's fork, unrelated
    },
    prefixes: ["/toolkit/map/", "/toolkit/map-conflict-wietse/", "/toolkit/plan/", "/toolkit/plan-conflict-tester/", "/toolkit/faq/", "/toolkit/faq-conflict-other/"],
    source: { sha: "OLD", dirty: false },
  });
  // I pulled W's commit (so my map bytes are W) and edited plan further (T2), faq untouched.
  const mine = mani({
    files: { ...unit("map", "W"), ...unit("plan", "T2"), ...unit("faq", "F") },
    prefixes: ["/toolkit/map/", "/toolkit/plan/", "/toolkit/faq/"], source: { sha: "MINE", dirty: false },
  });
  const { manifest, summary } = await compose({ mine, live, ffUnits: new Set(["/toolkit/map/", "/toolkit/plan/"]) });
  assert.equal(manifest.files["/toolkit/map/index.html"].h, H("W"), "W's edit is at its URL");
  assert.ok(!manifest.files["/toolkit/map-conflict-wietse/index.html"], "W's fork retired: its bytes are at the URL");
  assert.ok(!manifest.files["/toolkit/map-conflict-wietse/CONFLICT.md"]);
  assert.ok(!manifest.files["/toolkit/plan-conflict-tester/index.html"], "my own fork retired: I shipped the origin");
  assert.equal(manifest.files["/toolkit/faq-conflict-other/index.html"].h, H("O"), "a stranger's fork of an untouched unit stays");
  assert.deepEqual(summary.retired.sort(), ["/toolkit/map-conflict-wietse/", "/toolkit/plan-conflict-tester/"]);
  for (const k of ["/toolkit/map-conflict-wietse/", "/toolkit/plan-conflict-tester/"]) {
    assert.ok(!manifest.routing.publicPrefixes.includes(k));
    assert.ok(!(k in manifest.routing.unitSources));
  }
});

test("re-forking the same unit replaces the person's earlier fork instead of numbering it", async () => {
  const mine = mani({ files: unit("map", "m2"), prefixes: ["/toolkit/map/"], source: { sha: "s", dirty: true } });
  const live = mani({
    files: { ...unit("map", "L"), "/toolkit/map-conflict-tester/index.html": entry("m1"), "/toolkit/map-conflict-tester/CONFLICT.md": { h: H("n"), ct: "text/markdown; charset=utf-8", s: 3 } },
    prefixes: ["/toolkit/map/", "/toolkit/map-conflict-tester/"], source: { sha: "x", dirty: true },
  });
  const { manifest, summary } = await compose({
    mine, live,
    evidence: { editedUnits: new Set(["/toolkit/map/"]), dirtyUnits: new Set(), deletedUnits: new Set(), editedPaths: new Set() },
  });
  assert.equal(summary.forked[0].fork, "/toolkit/map-conflict-tester/");
  assert.equal(manifest.files["/toolkit/map-conflict-tester/index.html"].h, H("m2"), "the fork carries my newest bytes");
  assert.ok(!manifest.routing.publicPrefixes.includes("/toolkit/map-conflict-tester-2/"));
  assert.equal(manifest.routing.publicPrefixes.filter((p) => p.includes("-conflict-")).length, 1);
});

test("a kept unit heals on same SOURCE under another engine's decoration (sh equal, bytes differ)", async () => {
  const src = (h, sh) => ({ [`/toolkit/a/index.html`]: { h: H(h), sh: H(sh), ct: "text/html; charset=utf-8", s: 10 } });
  const mine = mani({ files: src("new", "same"), prefixes: ["/toolkit/a/"], source: { sha: "CLEAN", dirty: false } });
  const live = mani({ files: src("old", "same"), prefixes: ["/toolkit/a/"], source: { sha: "OLD", dirty: true } });
  const { manifest, summary } = await compose({ mine, live });
  assert.equal(manifest.files["/toolkit/a/index.html"].h, H("old"), "live's bytes stay: nothing was edited");
  assert.deepEqual(manifest.routing.unitSources["/toolkit/a/"], { sha: "CLEAN", dirty: false });
  assert.deepEqual(summary.healed, ["/toolkit/a/"]);
  // and NOT when the source really differs and the tolerant check says so too
  const live2 = mani({ files: src("old", "other"), prefixes: ["/toolkit/a/"], source: { sha: "OLD", dirty: true } });
  const r = await compose({ mine, live: live2 });
  assert.deepEqual(r.manifest.routing.unitSources["/toolkit/a/"], { sha: "OLD", dirty: true });
});

test("a fork retires on same SOURCE at the origin, not only identical bytes", async () => {
  const page = (u, h, sh) => ({ [`${u}index.html`]: { h: H(h), sh: H(sh), ct: "text/html; charset=utf-8", s: 10 } });
  const live = mani({
    files: { ...page("/toolkit/map/", "L", "L"), ...page("/toolkit/map-conflict-wietse/", "W1", "W"), "/toolkit/map-conflict-wietse/CONFLICT.md": { h: H("n"), ct: "text/markdown; charset=utf-8", s: 3 } },
    prefixes: ["/toolkit/map/", "/toolkit/map-conflict-wietse/"], source: { sha: "OLD", dirty: false },
  });
  const mine = mani({ files: page("/toolkit/map/", "W2", "W"), prefixes: ["/toolkit/map/"], source: { sha: "MINE", dirty: false } });
  const { manifest, summary } = await compose({ mine, live, ffUnits: new Set(["/toolkit/map/"]) });
  assert.deepEqual(summary.retired, ["/toolkit/map-conflict-wietse/"]);
  assert.ok(!manifest.files["/toolkit/map-conflict-wietse/index.html"]);
});
