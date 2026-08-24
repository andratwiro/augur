// Composed publish — the pure half of protocol 5.
//
// A publish used to ship one machine's tree as the WHOLE space, then spend
// hundreds of lines reconciling the damage that implied for every unit the
// publisher never touched (adopt-into-tree, peels, forks, mechanical commits).
// Protocol 5 inverts it: the LIVE manifest is the base, and this module decides,
// per authored unit, whether the publisher's build may replace what is live.
// The rule is git's own: a unit ships when it is a FAST-FORWARD of live —
// live's recorded source commit is in the publisher's history — or when there
// is local evidence of an edit. Everything else keeps live's bytes, verbatim.
// The working tree is never touched; a conflict forks in the MANIFEST only.
//
// Per-unit decision (unit in both, built bytes differ):
//   1. live IS my last publish (caller proves via cache+version) → whole tree safe,
//      this module is not called at all.
//   2. live's unit source: clean commit in my history → ship mine (fast-forward).
//   3. else: no local evidence I edited it   → keep live's.
//            evidence, but tolerant-equal     → keep live's (chrome-only churn).
//            evidence and really different    → CONTESTED: theirs keeps the URL,
//              mine composes at <unit>-conflict-<who>/ + a synthesized CONFLICT.md.
//   Only in mine → new unit, ships. Only in live → stays live: implicit unpublish
//   is impossible by construction. Removal needs git-evidenced deletion AND
//   --allow-unpublish (the caller passes those units in `evidence.deletedUnits`).
//
// Hard rule, lint-grade: a tree folder named `*-conflict-*` NEVER ships
// implicitly (filterLitter below). Composed fork prefixes are added after the
// filter, so real conflicts still surface — but stale fork litter in a working
// tree cannot re-enter the live site, ever.
//
// Everything impure (git, the store, the tree) is the caller's problem: this
// module sees two manifests plus predicates and answers with a manifest.

import { createHash } from "node:crypto";
import { authoredUnits, unitOfPath as unitOf, unitPaths } from "./publish-conflict.mjs";
export { authoredUnits, unitPaths };

const dec = (s) => { try { return decodeURIComponent(String(s)); } catch (e) { return String(s); } };
const norm = (p) => String(p == null ? "" : p).replace(/\/?$/, "/");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

export const LITTER_RE = /-conflict-[a-z0-9][a-z0-9-]*\/$/;

const sameUnitBytes = (a, b, unit) => {
  const pa = unitPaths(a, unit), pb = unitPaths(b, unit);
  if (pa.length !== pb.length) return false;
  const bh = new Map(pb.map((p) => [p, (b.files[p] || {}).h]));
  return pa.every((p) => bh.get(p) === (a.files[p] || {}).h);
};

// Drop tree-derived `*-conflict-*` units from a built manifest, in place.
// Returns the unit prefixes it removed (for one summary log line).
export function filterLitter(manifest) {
  const routing = (manifest || {}).routing || {};
  const litter = (routing.publicPrefixes || []).map(norm).filter((u) => LITTER_RE.test(dec(u)));
  if (!litter.length) return [];
  const under = (p) => litter.some((u) => dec(p).startsWith(dec(u)));
  routing.publicPrefixes = (routing.publicPrefixes || []).filter((u) => !LITTER_RE.test(dec(norm(u))));
  for (const p of Object.keys(manifest.files || {})) if (under(p)) delete manifest.files[p];
  for (const k of Object.keys(routing.versionMap || {})) if (under(k) || LITTER_RE.test(dec(norm(k)))) delete routing.versionMap[k];
  if (routing.unitSources) for (const k of Object.keys(routing.unitSources)) if (LITTER_RE.test(dec(norm(k)))) delete routing.unitSources[k];
  return litter;
}

const conflictNote = (unit, theirName) =>
  `# Live edit conflict\n\n` +
  `You and **${theirName}** changed \`${dec(unit)}\` at the same time. Their version was\n` +
  `live from work your git history has never seen, so \`augur publish\` kept **theirs**\n` +
  `at the original URL — any shared link still resolves — and published **yours** here.\n\n` +
  `Your working tree was NOT touched: your copy still lives at its real folder.\n` +
  `Compare the two pages, fold in whatever should survive, then ship — the next\n` +
  `publish that fast-forwards live retires this URL. Nothing has been lost.\n`;

// Compose the manifest a publish will commit: live as the base, the publisher's
// build overlaid where it is allowed to land.
//
//   mine, live   — built manifest / live manifest (live non-empty; caller handles
//                  bootstrap and the live-is-my-last-publish case without us)
//   who          — fork suffix (git author identity)
//   evidence     — { editedUnits:Set, dirtyUnits:Set, deletedUnits:Set, editedPaths:Set }
//                  (git-derived by the caller; editedPaths covers shared skill files)
//   ffUnits      — Set of units where live's source is a clean commit in my history
//   allowUnpublish — evidenced deletions actually drop (else they are kept + noted)
//   tolerantEqual — async (unit) => bool: my built bytes vs live's, volatile head ignored
export async function composePublish({
  mine, live, who = "someone", evidence, ffUnits,
  allowUnpublish = false, tolerantEqual = async () => false,
}) {
  const ev = {
    editedUnits: evidence?.editedUnits || new Set(),
    dirtyUnits: evidence?.dirtyUnits || new Set(),
    deletedUnits: evidence?.deletedUnits || new Set(),
    editedPaths: evidence?.editedPaths || new Set(),
  };
  const ff = ffUnits || new Set();
  const mineUnits = authoredUnits(mine);
  const liveUnits = authoredUnits(live);
  const allUnits = new Set([...mineUnits, ...liveUnits]);

  const skillPrefixes = new Set();
  for (const m of [mine, live]) {
    for (const p of ((m || {}).routing || {}).publicSkillPrefixes || []) skillPrefixes.add(norm(p));
  }
  const underSkill = (p) => { const d = dec(p); return [...skillPrefixes].some((s) => d.startsWith(dec(s))); };

  const mineFiles = (mine || {}).files || {};
  const liveFiles = (live || {}).files || {};
  const mineRouting = (mine || {}).routing || {};
  const liveRouting = (live || {}).routing || {};

  const out = {
    ...mine,
    files: {},
    routing: { ...mineRouting, publicPrefixes: [], versionMap: { ...(mineRouting.versionMap || {}) }, unitSources: {} },
  };
  const readMap = {};    // composed path → path whose bytes exist in dist (fork re-keys)
  const extraBlobs = {}; // hash → Buffer (synthesized CONFLICT.md)
  const summary = { shipped: [], kept: [], forked: [], removed: [], removalBlocked: [], newUnits: [], keptDiffer: [] };

  const takeMine = (u) => {
    for (const p of unitPaths(mine, u)) out.files[p] = mineFiles[p];
    out.routing.publicPrefixes.push(u);
    out.routing.unitSources[u] = {
      sha: (mine.source || {}).sha || null,
      dirty: ev.dirtyUnits.has(u),
    };
  };
  const takeLive = (u) => {
    for (const p of unitPaths(live, u)) out.files[p] = liveFiles[p];
    out.routing.publicPrefixes.push(u);
    const vm = (liveRouting.versionMap || {})[u];
    if (vm) out.routing.versionMap[u] = vm;
    const src = (liveRouting.unitSources || {})[u];
    out.routing.unitSources[u] = src || {
      sha: (live.source || {}).sha || null, dirty: !!(live.source || {}).dirty,
    };
    // My build may have generated different bytes for this unit; make sure none
    // of mine leak in (paths only mine has under a kept unit stay out).
    for (const p of unitPaths(mine, u)) if (!(p in out.files)) { /* dropped */ }
  };

  const forkName = (u) => {
    let fork = norm(dec(u).replace(/\/$/, "") + `-conflict-${who}`);
    let n = 2;
    while (liveUnits.has(fork) || mineUnits.has(fork)) fork = norm(dec(u).replace(/\/$/, "") + `-conflict-${who}-${n++}`);
    return fork;
  };

  for (const u of [...allUnits].sort()) {
    const inMine = mineUnits.has(u), inLive = liveUnits.has(u);
    if (inMine && !inLive) {
      takeMine(u);
      summary.newUnits.push(u);
      continue;
    }
    if (inLive && !inMine) {
      if (ev.deletedUnits.has(u)) {
        if (allowUnpublish) { summary.removed.push(u); continue; }
        summary.removalBlocked.push(u);
      }
      takeLive(u);
      continue;
    }
    // In both.
    if (sameUnitBytes(mine, live, u)) { takeLive(u); continue; }
    if (ff.has(u)) { takeMine(u); summary.shipped.push(u); continue; }
    if (!ev.editedUnits.has(u)) { takeLive(u); summary.kept.push(u); continue; }
    if (await tolerantEqual(u)) { takeLive(u); summary.kept.push(u); continue; }
    // Contested: theirs keeps the URL, mine composes at a fork prefix.
    takeLive(u);
    summary.keptDiffer.push(u);
    const fork = forkName(u);
    const theirName = (live && live.publishedBy) || ((live || {}).source || {}).actor || "a collaborator";
    for (const p of unitPaths(mine, u)) {
      const fp = fork + dec(p).slice(dec(u).length);
      out.files[fp] = mineFiles[p];
      readMap[fp] = p;
    }
    const note = Buffer.from(conflictNote(u, theirName));
    const noteHash = sha256(note);
    out.files[fork + "CONFLICT.md"] = { h: noteHash, ct: "text/markdown; charset=utf-8", s: note.length };
    extraBlobs[noteHash] = note;
    out.routing.publicPrefixes.push(fork);
    const vm = (mineRouting.versionMap || {})[u];
    if (vm) out.routing.versionMap[fork] = vm;
    out.routing.unitSources[fork] = { sha: (mine.source || {}).sha || null, dirty: ev.dirtyUnits.has(u) };
    summary.forked.push({ unit: u, fork, theirs: theirName });
  }

  // Shared skill files: per file — mine ships only with evidence; live's are never
  // implicitly dropped; a file only I have is new and ships.
  for (const p of new Set([...Object.keys(mineFiles), ...Object.keys(liveFiles)])) {
    if (!underSkill(p)) continue;
    const a = mineFiles[p], b = liveFiles[p];
    if (a && !b) { out.files[p] = a; continue; }
    if (!a && b) { out.files[p] = b; continue; }
    if (a.h === b.h) { out.files[p] = a; continue; }
    if (ev.editedPaths.has(p)) { out.files[p] = a; }
    else { out.files[p] = b; summary.kept.push(p); }
  }

  // Everything else is generated output (galleries, indexes, landing, tokens):
  // mine wins wholesale — any publish regenerates all of it.
  for (const [p, f] of Object.entries(mineFiles)) {
    if (p in out.files) continue;
    if (unitOf(p, allUnits) || underSkill(p)) continue;
    out.files[p] = f;
  }

  // Carry unitSources for kept units even when live predates the field entirely
  // (out.routing.unitSources was filled per unit above; nothing else to do), and
  // keep prefix order stable for humans reading the manifest.
  out.routing.publicPrefixes.sort();

  return { manifest: out, readMap, extraBlobs, summary };
}
