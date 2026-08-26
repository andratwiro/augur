// The UNIT of publishing, as a pure module both the CLI and the WORKER can hold.
//
// A unit is a prototype/playground folder — the thing a URL names and a person edits, never
// a lone file — and units are exactly the routing fragment's `publicPrefixes`. Galleries get
// `versionMap` entries and no prefix, which is what keeps them out.
//
// ⚠️ IT LIVES IN src/ BECAUSE THE SERVER NEEDS IT TOO. `C-fork-on-conflict` resolves a stale
// base inside the commit handler, and it has to agree with the client about what a unit is
// down to the last character. Two definitions of "which folder does this path belong to"
// would disagree on exactly the paths a conflict is about. scripts/lib/publish-conflict.mjs
// re-exports these three so no CLI import has to move.

const dec = (s) => { try { return decodeURIComponent(String(s)); } catch (e) { return String(s); } };
const norm = (p) => String(p == null ? "" : p).replace(/\/?$/, "/");

export function authoredUnits(manifest) {
  const out = new Set();
  for (const p of ((manifest || {}).routing || {}).publicPrefixes || []) out.add(norm(p));
  return out;
}

/**
 * Which unit owns this path, or null for a path outside every unit.
 *
 * ⚠️ THE LONGEST PREFIX WINS, and the first version of this returned the first match. With
 * `/toolkit/` and `/toolkit/embed/` both units, a file under the second belonged to the
 * first or the second depending on Set iteration order — which is insertion order, which is
 * whatever the manifest happened to list. A conflict decided by JSON key order is a conflict
 * decided at random.
 */
export function unitOfPath(path, unitSet) {
  const p = dec(path);
  let best = null;
  for (const u of unitSet) {
    const d = dec(u);
    if (p.startsWith(d) && (!best || d.length > dec(best).length)) best = u;
  }
  return best;
}

export function unitPaths(manifest, unit) {
  const prefix = dec(unit);
  return Object.keys((manifest || {}).files || {}).filter((p) => dec(p).startsWith(prefix));
}
