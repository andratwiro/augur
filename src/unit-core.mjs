// src/unit-core.mjs — the pure half of drafts that land.
//
// A UNIT is a prototype folder, spelled as its URL prefix with a leading and a trailing
// slash, exactly as `routing.publicPrefixes` spells it. A DRAFT is one session's live
// working copy of a unit, addressed at the unit's own depth: `/checkout/flow@k7f3q1/` for
// the unit `/checkout/flow/`. Everything here is a decision over
// plain objects: the Durable Object, the worker and the CLI all import it, and none of them
// re-derive what a unit, a draft or a stale save is. See docs/drafts-that-land.md.
//
// ⚠️ NO NODE IMPORTS. The worker and the Durable Object run this too.

export const ACTIVE_MS = 5 * 60_000;
export const DRAFT_ID_RE = /^[a-z0-9]{6}$/;
// A draft address: the unit's path with `@` + six chars on its LAST segment, then the rest —
// `/checkout/flow@k7f3q1/`. SAME DEPTH AS THE UNIT, on purpose: a page's relative links
// (`../../skills/x.css`, `img/a.png`) resolve to the same URLs from the draft as from the real
// page. The first cut hung the id one folder deeper (`/checkout/flow/@k7f3q1/`), and every
// `../../` in a prototype then climbed one folder short — measured 9 Sep 2026: the whole
// design system answered with the sign-in page, and nothing hydrated. That shape is still
// READ, for drafts opened before the change and for links people kept; it is never written.
const DRAFT_PATH_RE = /^(\/(?:[^/@][^/]*\/)*[^/@][^/]*)@([a-z0-9]{6})(\/.*)?$/;
const DRAFT_PATH_DEEP_RE = /^(\/(?:[^/@][^/]*\/)+)@([a-z0-9]{6})(\/.*)?$/;

/** `"checkout/flow"` → `"/checkout/flow/"`; null for anything that is not a unit path. */
export function normUnit(s) {
  const raw = String(s == null ? "" : s).trim().replace(/\/{2,}/g, "/");
  const segs = raw.split("/").filter(Boolean);
  if (!segs.length) return null;
  // No `@` anywhere in a unit path: the draft address is `<unit>@<id>/`, and a unit that
  // carried its own `@` would be read as somebody's draft.
  for (const seg of segs) if (seg === "." || seg === ".." || seg.includes("@")) return null;
  return "/" + segs.join("/") + "/";
}

export function newDraftId(random = Math.random) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(random() * alphabet.length) % alphabet.length];
  return out;
}

export const draftAddress = (unit, id) => `${String(unit).replace(/\/$/, "")}@${id}/`;

export function splitDraftPath(pathname) {
  const s = String(pathname || "");
  let m = DRAFT_PATH_RE.exec(s);
  if (m) return { unit: m[1] + "/", id: m[2], rest: m[3] || "/" };
  m = DRAFT_PATH_DEEP_RE.exec(s);
  if (m) return { unit: m[1], id: m[2], rest: m[3] || "/" };
  return null;
}

/** The manifest's entries under `unit`, with only the fields a table carries. */
export function unitTable(files, unit) {
  const out = {};
  for (const [p, f] of Object.entries(files || {})) {
    if (!p.startsWith(unit) || !f) continue;
    const row = { h: f.h, ct: f.ct, s: f.s };
    if (f.by) row.by = f.by;
    if (f.editedAt) row.editedAt = f.editedAt;
    out[p] = row;
  }
  return out;
}

export function sameTable(a, b) {
  const ka = Object.keys(a || {}), kb = Object.keys(b || {});
  if (ka.length !== kb.length) return false;
  return ka.every((p) => b[p] && b[p].h === a[p].h);
}

/**
 * Apply a save's changes with per-file compare-and-set. All or nothing: one stale base
 * refuses the whole batch, and the caller gets the current hash of every stale file.
 */
export function applyChanges(table, changes) {
  const stale = [];
  for (const c of changes || []) {
    const cur = table[c.path];
    const curHash = cur ? cur.h : null;
    const base = c.baseHash == null ? null : c.baseHash;
    if (base !== curHash) stale.push({ path: c.path, h: curHash });
  }
  if (stale.length) return { ok: false, table, stale };
  const next = { ...table };
  for (const c of changes || []) {
    if (c.delete) delete next[c.path];
    else next[c.path] = { h: c.h, ct: c.ct, s: c.s };
  }
  return { ok: true, table: next, stale: [] };
}

/** What `to` has that `from` does not: changed/added with `to`'s metadata, and removed paths. */
export function tableDelta(from, to) {
  const changed = [], removed = [];
  for (const [p, f] of Object.entries(to || {})) {
    if (!from[p] || from[p].h !== f.h) changed.push({ path: p, ...f });
  }
  for (const p of Object.keys(from || {})) if (!to[p]) removed.push(p);
  changed.sort((a, b) => a.path.localeCompare(b.path));
  removed.sort();
  return { changed, removed };
}

/** Open drafts, each with `active` derived from its last save (or its opening). */
export function presenceOf(drafts, nowMs) {
  return (drafts || [])
    .filter((d) => !d.closedAt)
    .map((d) => {
      const last = Date.parse(d.lastSaveAt || d.openedAt || "") || 0;
      return {
        id: d.id, owner: d.owner, session: d.session || "", openedAt: d.openedAt,
        lastSaveAt: d.lastSaveAt || null, active: nowMs - last < ACTIVE_MS,
      };
    });
}
