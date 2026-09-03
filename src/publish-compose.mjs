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
//   2. live's unit is the SEED (`isSeedSource`, F-seed-yields-to-real-publish): the
//      platform wrote it and it is nobody's work, so it reverts nobody → ship mine,
//      outright — no evidence asked for. Unless only the decoration differs (same
//      source hash, or tolerant-equal): then live's bytes AND its seed marker stay,
//      because a page nobody edited must not become "theirs" on the first publish.
//   3. live's unit source: clean commit in my history → ship mine (fast-forward).
//   4. else: no local evidence I edited it   → keep live's.
//            evidence, but tolerant-equal     → keep live's (chrome-only churn).
//            evidence and really different    → CONTESTED: theirs keeps the URL,
//              mine composes at <unit>-conflict-<who>/ + a synthesized CONFLICT.md.
//   Only in mine → new unit, ships. Only in live → stays live: implicit unpublish
//   is impossible by construction. Removal needs an evidenced deletion AND
//   --allow-unpublish: git-evidenced (the caller passes those units in
//   `evidence.deletedUnits`), or a SEED unit the tree lacks — the platform's page
//   is not a deletion anyone has to prove, but it is still an unpublish, so without
//   the flag it stays live and is NAMED (removalBlocked) rather than kept in silence.
//
// ⚠️ THE SEED RULE LIVES HERE AND NOWHERE ELSE. The evidence is what each caller can
// prove — git for the CLI, the base manifest for the store — and the store runs this
// same composer to resolve a repo-less publisher's stale base (C-fork-on-conflict). A
// rule written into one caller's evidence would leave the other deciding by byte
// identity, which agrees only until a re-seed changes bytes under a seed marker.
//
// Hard rule, lint-grade: a tree folder named `*-conflict-*` NEVER ships
// implicitly (filterLitter below). Composed fork prefixes are added after the
// filter, so real conflicts still surface — but stale fork litter in a working
// tree cannot re-enter the live site, ever.
//
// Everything impure (git, the store, the tree) is the caller's problem: this
// module sees two manifests plus predicates and answers with a manifest.

// ⚠️ NO NODE IMPORTS. This module is the publish stack's BRAIN and the worker runs the same
// one — `C-fork-on-conflict` resolves a stale base inside the commit handler, and a second
// implementation of "who keeps the URL" would disagree with the client on exactly the
// publishes a conflict is about. So hashing arrives as a parameter and bytes are Uint8Array:
// `node:crypto` and `Buffer` exist in the CLI and in neither workerd nor a Durable Object.
import { authoredUnits, unitOfPath as unitOf, unitPaths } from "./publish-units.mjs";
import { isSeedSource } from "./provenance.mjs";
export { authoredUnits, unitPaths };

const dec = (s) => { try { return decodeURIComponent(String(s)); } catch (e) { return String(s); } };
const norm = (p) => String(p == null ? "" : p).replace(/\/?$/, "/");
/** The default hasher, for the CLI. A worker passes its own — see `sha256` in the options. */
async function nodeSha256(bytes) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(bytes).digest("hex");
}

export const LITTER_RE = /-conflict-[a-z0-9][a-z0-9-]*\/$/;

const sameUnitBytes = (a, b, unit) => {
  const pa = unitPaths(a, unit), pb = unitPaths(b, unit);
  if (pa.length !== pb.length) return false;
  const bh = new Map(pb.map((p) => [p, (b.files[p] || {}).h]));
  return pa.every((p) => bh.get(p) === (a.files[p] || {}).h);
};

// Same SOURCE, whatever the served bytes: `sh` is the hash build.js records of a page's
// bytes BEFORE it decorates them (og meta, the linked stamp — everything an engine change
// rewrites). It is the field the commit handler already judges per-file provenance on,
// so "did a person change this" means the same thing at both ends. A file without one
// (verbatim copies carry none) compares its served bytes.
const sameFileSource = (a, b) => (a && b && a.sh && b.sh) ? a.sh === b.sh : !!a && !!b && a.h === b.h;
const sameUnitSource = (a, b, unit) => {
  const pa = unitPaths(a, unit), pb = unitPaths(b, unit);
  if (pa.length !== pb.length) return false;
  const bf = new Map(pb.map((p) => [p, b.files[p]]));
  return pa.every((p) => bf.has(p) && sameFileSource(a.files[p], bf.get(p)));
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
  // Injected so this module needs no runtime-specific import. The CLI gets node's; the
  // worker passes one built on crypto.subtle, which is the only one it has.
  sha256 = nodeSha256,
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

  // Is live's copy of this unit the platform's seed? Asked through `isSeedSource()`, the
  // one predicate, of the per-unit marker — falling back to the manifest's own source for
  // a manifest that predates `unitSources`. After a real publish the manifest's source is
  // a person's while the units nobody touched still carry the sentinel, so it is per unit.
  const liveSeedUnit = (u) => isSeedSource((liveRouting.unitSources || {})[u] || (live || {}).source);
  // Shared skill files carry no per-file marker; they are the seed's only while the whole
  // live manifest still is (i.e. before the first real publish).
  const liveSeedAll = isSeedSource((live || {}).source);

  const out = {
    ...mine,
    files: {},
    routing: { ...mineRouting, publicPrefixes: [], versionMap: { ...(mineRouting.versionMap || {}) }, unitSources: {} },
  };
  const readMap = {};    // composed path → path whose bytes exist in dist (fork re-keys)
  const extraBlobs = {}; // hash → Uint8Array (synthesized CONFLICT.md)
  // `seeded`: seed units this publish replaced. `seedKept`: seed units this tree carries
  // unchanged — byte-identical, or with only their decoration changed — where live's bytes
  // AND ITS SEED MARKER stay; NOT reported as kept (nothing was held back), but the caller's
  // cache must know live is not exactly this tree, so the next publish composes again rather
  // than fast-pathing the tree over it. The marker is the reason the byte-identical case is
  // in here too: the built manifest stamps every unit as the publisher's, so a fast path
  // that ships it whole would take the seed marker off five untouched pages while shipping
  // one edit — measured, by the clone round trip, on the second publish from a clone.
  const summary = { shipped: [], kept: [], forked: [], removed: [], removalBlocked: [], newUnits: [], keptDiffer: [], seeded: [], seedKept: [], healed: [], retired: [] };

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

  // Identical bytes from a clean tree are PROOF that the unit is this commit. When live's
  // provenance for it is dirty or unknown, say so. This is what stops one dirty publish
  // from poisoning every untouched unit for everybody: a legacy manifest (space-level
  // `{sha, dirty:true}`, no `unitSources`) once got synthesized onto 158 units nobody had
  // touched, and every clean edit after that forked as "contested" — three times for one
  // person — because a dirty base can never fast-forward. A clean provenance is kept even
  // when mine is newer: the older commit is the one more people can prove.
  const healable = (u) => {
    if (!(mine.source || {}).sha || ev.dirtyUnits.has(u)) return false;
    const src = out.routing.unitSources[u];
    return !(src && src.sha && !src.dirty);
  };
  const heal = (u) => {
    if (!healable(u)) return;
    out.routing.unitSources[u] = { sha: (mine.source || {}).sha, dirty: false };
    summary.healed.push(u);
  };

  // My own earlier fork of the same unit is mine to replace: a person who forks twice
  // gets ONE `-conflict-<who>` copy with their newest bytes, not -2, -3, -4. The anonymous
  // fallback name is nobody's in particular, so it still numbers.
  const forkName = (u) => {
    const base = norm(dec(u).replace(/\/$/, "") + `-conflict-${who}`);
    if (who !== "someone" && liveUnits.has(base) && !mineUnits.has(base)) return base;
    let fork = base;
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
      // A seed unit the tree lacks needs no proof of deletion — but it is still an
      // unpublish, so the flag still gates it and without the flag it is named.
      if (ev.deletedUnits.has(u) || liveSeedUnit(u)) {
        if (allowUnpublish) { summary.removed.push(u); continue; }
        summary.removalBlocked.push(u);
      }
      takeLive(u);
      continue;
    }
    // In both.
    if (sameUnitBytes(mine, live, u)) {
      takeLive(u);
      if (liveSeedUnit(u)) summary.seedKept.push(u); // the marker is live's, and the cache must know
      else heal(u);
      continue;
    }
    if (liveSeedUnit(u)) {
      // The platform's page yields to anybody's — unless nobody actually changed it.
      if (sameUnitSource(mine, live, u) || await tolerantEqual(u)) { takeLive(u); summary.seedKept.push(u); continue; }
      takeMine(u);
      summary.seeded.push(u);
      continue;
    }
    if (ff.has(u)) { takeMine(u); summary.shipped.push(u); continue; }
    if (!ev.editedUnits.has(u)) {
      takeLive(u); summary.kept.push(u);
      // Same source under a different engine's decoration is the same proof as identical bytes.
      if (healable(u) && (sameUnitSource(mine, live, u) || await tolerantEqual(u))) heal(u);
      continue;
    }
    if (await tolerantEqual(u)) { takeLive(u); summary.kept.push(u); heal(u); continue; }
    // Contested: theirs keeps the URL, mine composes at a fork prefix.
    takeLive(u);
    summary.keptDiffer.push(u);
    const fork = forkName(u);
    const theirName = (live && live.publishedBy) || ((live || {}).source || {}).actor || "a collaborator";
    if (liveUnits.has(fork)) {
      // Replacing my own earlier fork: its files were taken as a live-only unit above.
      for (const p of unitPaths(live, fork)) delete out.files[p];
      out.routing.publicPrefixes = out.routing.publicPrefixes.filter((x) => x !== fork);
      delete out.routing.versionMap[fork];
    }
    for (const p of unitPaths(mine, u)) {
      const fp = fork + dec(p).slice(dec(u).length);
      out.files[fp] = mineFiles[p];
      readMap[fp] = p;
    }
    const note = new TextEncoder().encode(conflictNote(u, theirName));
    const noteHash = await sha256(note);
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
    else if (liveSeedAll) { out.files[p] = sameFileSource(a, b) ? b : a; }
    else { out.files[p] = b; summary.kept.push(p); }
  }

  // Everything else is generated output (galleries, indexes, landing, tokens):
  // mine wins wholesale — any publish regenerates all of it.
  for (const [p, f] of Object.entries(mineFiles)) {
    if (p in out.files) continue;
    if (unitOf(p, allUnits) || underSkill(p)) continue;
    out.files[p] = f;
  }

  // A fork retires the moment it is redundant: its bytes are at the origin URL now
  // (whoever shipped them), or its author just shipped the origin (their fold-in
  // superseded it). CONFLICT.md promised exactly this. Nothing else ever removes one:
  // a stranger's fork of a unit nobody shipped stays, like any live-only unit.
  const shippedNow = new Set([...summary.shipped, ...summary.newUnits, ...summary.seeded]);
  const forkedNow = new Set(summary.forked.map((f) => f.fork));
  const strip = (u, p) => dec(p).slice(dec(u).length);
  for (const f of [...out.routing.publicPrefixes]) {
    const m = dec(f).match(/^(.*)-conflict-([a-z0-9][a-z0-9-]*)\/$/);
    if (!m || forkedNow.has(f) || !liveUnits.has(f)) continue;
    const origin = norm(m[1] + "/");
    if (!out.routing.publicPrefixes.includes(origin)) continue;
    const mineFork = who !== "someone" && (m[2] === who || m[2].startsWith(who + "-"));
    const fPaths = unitPaths(live, f).filter((p) => !/\/CONFLICT\.md$/.test(dec(p)));
    const of = new Map(unitPaths(out, origin).map((p) => [strip(origin, p), out.files[p]]));
    const landed = fPaths.length > 0 && fPaths.length === of.size
      && fPaths.every((p) => sameFileSource(live.files[p], of.get(strip(f, p))));
    if (!landed && !(mineFork && shippedNow.has(origin))) continue;
    for (const p of unitPaths(live, f)) delete out.files[p];
    out.routing.publicPrefixes = out.routing.publicPrefixes.filter((x) => x !== f);
    delete out.routing.versionMap[f];
    delete out.routing.unitSources[f];
    summary.retired.push(f);
  }

  // Carry unitSources for kept units even when live predates the field entirely
  // (out.routing.unitSources was filled per unit above; nothing else to do), and
  // keep prefix order stable for humans reading the manifest.
  out.routing.publicPrefixes.sort();

  return { manifest: out, readMap, extraBlobs, summary };
}
