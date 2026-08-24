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
  assert.match(extraBlobs[note.h].toString(), /them@example\.com/);
  assert.match(extraBlobs[note.h].toString(), /working tree was NOT touched/);
  assert.equal(summary.forked[0].fork, "/toolkit/map-conflict-tester/");
  assert.ok(manifest.routing.publicPrefixes.includes("/toolkit/map-conflict-tester/"));
});

test("a fork name that already exists gets a numbered suffix", async () => {
  const mine = mani({ files: unit("map", "m"), prefixes: ["/toolkit/map/"], source: { sha: "s", dirty: true } });
  const live = mani({
    files: { ...unit("map", "L"), "/toolkit/map-conflict-tester/index.html": entry("old") },
    prefixes: ["/toolkit/map/", "/toolkit/map-conflict-tester/"], source: { sha: "x", dirty: true },
  });
  const { summary } = await compose({
    mine, live,
    evidence: { editedUnits: new Set(["/toolkit/map/"]), dirtyUnits: new Set(), deletedUnits: new Set(), editedPaths: new Set() },
  });
  assert.equal(summary.forked[0].fork, "/toolkit/map-conflict-tester-2/");
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
