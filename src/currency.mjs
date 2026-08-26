// What is current here, and what has been left behind.
//
// `F-currency-default`. Divergence is cheap in a workspace — a second version of a screen
// costs a folder — so the shelf fills with abandoned paths fast, and a repository where the
// live thing and the dead thing look identical has stopped being a repository. The failure
// is quiet: nothing breaks, nothing 404s, the gallery just slowly stops meaning anything.
//
// The two facts that answer it were already recorded, in two different places, and neither
// was on a card:
//
//   · STATUS — what a person said about this unit — is a row in the workspace overlay,
//     written by the chip on the card and read by `/__status`. It was visible only as a
//     20px glyph on the preview image, and only to somebody who already knew to hover it.
//   · EDITED-AT — when this unit's bytes last actually changed — is stamped per file at
//     COMMIT by the publish handler and carried forward untouched for every file a publish
//     did not change. It was rendered nowhere at all.
//
// ⚠️ STALENESS IS DERIVED, AND MUST STAY DERIVED. The obvious shape — an "archived" flag
// somebody sets — is the bug wearing the fix's clothes: the person who abandons a
// prototype is by definition not coming back to tick a box, so the flag is accurate only
// for the units that were never the problem. Everything here is computed from `editedAt`
// and a clock. There is NO new stored field, and adding one would put the junk drawer back.
//
// ⚠️ ABSENT IS AN ANSWER, AND IT IS NOT "FRESH". A file published before the stamp existed
// carries no `editedAt`, so its unit's `stale` is `null` — unknown — and it gets no
// treatment at all. Defaulting the unknown to either end would be inventing the exact fact
// the stamp exists to stop being invented: false-stale accuses somebody's live work, and
// false-fresh is the junk drawer with a clean bill of health. The treatment therefore turns
// on unit by unit as content is republished, which is slower than a flag day and true.
//
// The module is PURE and lives in `src/` because three callers need to agree: the worker
// (which answers `/__currency` and `/__publish/<space>/currency`), build.js (which bakes
// the first paint), and the suite. Same reason `src/publish-units.mjs` lives here.

import { spanWords, relTime } from "./chrome/appchrome.mjs";
import { authoredUnits } from "./publish-units.mjs";

/**
 * How long a unit may go untouched before the gallery says so, in days.
 *
 * NINETY, and the number is a judgement, so here is the judgement. It is a full planning
 * quarter: a prototype somebody returns to once a cycle — the norm for anything still
 * being argued about — never gets marked, and only something skipped for an entire cycle
 * does. The failure directions are not symmetrical, which is what sets the floor rather
 * than the ceiling. A false stale mark is an accusation against live work and costs the
 * signal its credibility the first time somebody sees it on the thing they shipped
 * yesterday; a late one costs a few weeks of a card looking ordinary. So the threshold is
 * set where it cannot fire on ordinary working rhythm — a holiday, a re-org, a quarter
 * spent on something else — and it is one number in one place, echoed in every answer
 * (`staleAfterDays`) so no client and no agent ever hardcodes a second copy of it.
 */
export const STALE_AFTER_DAYS = 90;

const DAY_MS = 86400000;

/**
 * The status vocabulary's WORDS. One table — the worker validates against its keys, build.js
 * takes its labels, and the currency line prints them — because the whole point of this
 * item is that a status is legible without hovering anything, and a status spelled two ways
 * on two surfaces is not legible.
 */
export const STATUS_LABELS = Object.freeze({
  "in-progress": "In progress",
  "dev-ready": "Dev ready",
  ignore: "Ignore",
  reviewed: "Reviewed",
});

// A poster is a BUILD OUTPUT committed back into the folder, so a reshoot is not an edit —
// and one reshoot touches every folder on the site at once. Counting it would move every
// card to "edited now" in a single commit, which is not a hypothetical: it happened, to 76
// folders, and it is why the git-derived pass carries the same exclusion. build.js imports
// THIS test rather than keeping its own, so the stamp-derived answer and the git-derived
// answer cannot come to disagree about what a person wrote.
//
// A regex LITERAL, not a `new RegExp` built from a list of basenames: the module-scope lint
// (scripts/no-tenant-globals.mjs) can prove a literal holds no state and cannot prove it of
// a constructor call, so the prettier version costs two allowlist entries and buys nothing.
const GENERATED_ASSET = /(^|\/)(preview\.webp|og\.jpg)$/i;

/** Is this path a build output rather than something a person wrote? */
export const isGeneratedAsset = (p) => GENERATED_ASSET.test(String(p == null ? "" : p));

const decode = (s) => { try { return decodeURIComponent(String(s)); } catch (e) { return String(s); } };

/**
 * The overlay status key for a unit path.
 *
 * `/checkout/flow/` is the unit; `checkout/flow` is the key the status chip has always
 * written under (`data-status-key`). Decoded and unslashed, and nothing more — the two
 * spellings must keep meeting, so this is the one place that converts between them.
 */
export const unitKey = (unitPath) => decode(unitPath).replace(/^\/+|\/+$/g, "");

/**
 * When this unit's bytes last changed, and who by, from the manifest's per-file stamps.
 *
 * The NEWEST stamp in the folder wins: a unit is a folder and editing any file in it is
 * editing the unit. Files with no stamp are skipped rather than counted as old, and a unit
 * where every file is unstamped answers `null` — see the header on why that is not "fresh".
 */
export function unitProvenance(manifest, unitPath) {
  const prefix = decode(unitPath);
  let at = 0, editedAt = null, by = null;
  for (const [p, f] of Object.entries((manifest || {}).files || {})) {
    if (!decode(p).startsWith(prefix)) continue;
    if (isGeneratedAsset(p)) continue;
    const t = f && f.editedAt ? Date.parse(f.editedAt) : NaN;
    if (!Number.isFinite(t) || t <= at) continue;
    at = t; editedAt = f.editedAt; by = f.by || null;
  }
  return { editedAt, by };
}

/**
 * The whole of the staleness decision, in one function with no I/O.
 *
 * `stale` is a THREE-valued answer — true, false, or null for "no record" — because the
 * two-valued version has to guess about unstamped content, and there is no honest guess.
 */
export function freshness(editedAt, now = Date.now()) {
  const t = editedAt ? Date.parse(editedAt) : NaN;
  if (!Number.isFinite(t)) return { ageDays: null, stale: null };
  const ageDays = Math.max(0, Math.floor((now - t) / DAY_MS));
  return { ageDays, stale: ageDays >= STALE_AFTER_DAYS };
}

/**
 * The sentence a card shows for a unit's freshness.
 *
 * A stale unit does not get the same sentence in a different colour: "Edited 7 months ago"
 * asks the reader to do the arithmetic and know the threshold, and most of them will do
 * neither. "Untouched for 7 months" is the finding, stated. Both come off the same counter.
 */
export function whenWords(editedAt, now = Date.now()) {
  const { stale } = freshness(editedAt, now);
  if (stale === null) return null;
  const t = Date.parse(editedAt);
  return stale ? `Untouched for ${spanWords(t, now)}` : relTime(t, now);
}

/**
 * How far back a `since` window reaches, in ms — `14d`, `2w`, `36h`, or a bare number of
 * days. Returns 0 for anything it does not understand, so a caller refuses rather than
 * silently answering a different question than the one asked.
 */
export function parseSince(raw) {
  const m = /^\s*(\d+)\s*([hdw])?\s*$/i.exec(String(raw == null ? "" : raw));
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  if (!n) return 0;
  const unit = (m[2] || "d").toLowerCase();
  return n * (unit === "h" ? 3600000 : unit === "w" ? 7 * DAY_MS : DAY_MS);
}

/**
 * Every authored unit in a workspace, with what is known about it. The ONE read — the
 * gallery paints from it and an agent answers "what changed here" from it, so there is no
 * second definition of current to drift.
 *
 * `spaces` is the live manifest map (`loadManifests`'s shape). `_engine` is skipped: it is
 * shared chrome, it has no authored units, and a deploy would make the whole site look
 * freshly edited.
 */
export function currencyRows(spaces, statuses, { now = Date.now(), sinceMs = 0 } = {}) {
  const rows = [];
  const floor = sinceMs ? now - sinceMs : 0;
  for (const [space, manifest] of Object.entries(spaces || {})) {
    if (space === "_engine") continue;
    for (const path of authoredUnits(manifest)) {
      const key = unitKey(path);
      const { editedAt, by } = unitProvenance(manifest, path);
      const { ageDays, stale } = freshness(editedAt, now);
      // A `since` window asks what CHANGED. A unit with no record did not answer, and
      // listing it would put "we don't know" in a list of things that happened.
      if (floor && (!editedAt || Date.parse(editedAt) < floor)) continue;
      const status = (statuses && Object.prototype.hasOwnProperty.call(statuses, key) && statuses[key]) || null;
      rows.push({
        key,
        path,
        space,
        status,
        statusLabel: (status && STATUS_LABELS[status]) || null,
        editedAt: editedAt || null,
        // The recorded author id, exactly as the manifest holds it: `personId(email)`, a
        // one-way hash, never an address. Resolving it to a name and a face belongs at the
        // render, against the roster — it is not this read's job to hand out who.
        by,
        ageDays,
        stale,
        when: whenWords(editedAt, now),
      });
    }
  }
  // Newest first, unstamped last, then by path — so the first screenful of an agent's
  // answer is the answer.
  rows.sort((a, b) => {
    const ta = a.editedAt ? Date.parse(a.editedAt) : -Infinity;
    const tb = b.editedAt ? Date.parse(b.editedAt) : -Infinity;
    return tb - ta || a.path.localeCompare(b.path);
  });
  return rows;
}
