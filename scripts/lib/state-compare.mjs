// state-compare.mjs — how `augur migrate` judges whether a family arrived.
//
// Split out of migrate.mjs so the judgement can be tested without spawning the runner:
// the script is a top-level program with two instances on the other end of it, and the
// comparison is a pure function whose edge cases are exactly the ones a live migration
// finds.
//
// ⚠️ THE COMPARISON IS STRUCTURAL, NOT BYTEWISE, AND THAT IS NOT LENIENCY. The two sides
// of a migration answer the SAME documents in DIFFERENT KEY ORDERS: a KV-backed export
// hands a family back in insertion order, and the workspace object hands it back sorted
// (its read is a SELECT). `JSON.stringify(a) === JSON.stringify(b)` therefore reported
// "differ" on a correct copy, and a correct migration failed its own verification. So
// both sides are rendered as canonical JSON — object keys sorted at every depth — before
// they are compared. Arrays are left in order, because order in an array IS content: a
// comment thread with its messages reversed is a different thread.
import { inventoryEntry } from "../../src/state-inventory.mjs";

/** JSON with object keys sorted at every depth. `undefined` renders as `null`. */
export function canonicalJson(value) {
  return JSON.stringify(canonicalise(value === undefined ? null : value));
}

function canonicalise(v) {
  if (Array.isArray(v)) return v.map(canonicalise);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (v[k] === undefined) continue; // JSON.stringify would drop it too
      out[k] = canonicalise(v[k]);
    }
    return out;
  }
  return v;
}

// ⚠️ EMPTY AND ABSENT ARE THE SAME ANSWER FOR ONE KIND OF FAMILY AND NOT FOR THE OTHER, and
// a comparison that does not know the difference fails on correct data in one direction and
// passes over a blind copy in the other. Both happened.
//
//   A `key` FAMILY is one document. It is there or it is not, and "not there" is exactly
//   "holds nothing" — there is no third state either end could be in. So absent on one side
//   and `{}` on the other is a MATCH, and refusing it is refusing a workspace where nobody
//   has ever set a status.
//
//   A `prefix` FAMILY is a set of documents, and an empty set is `{}`. Absent therefore does
//   NOT mean empty here: it means that export could not enumerate the family at all, which
//   is a copy nobody can judge and the one report that must fail. This is not hypothetical
//   tidying — `pins:` reported absent from the workspace-object backing whether it held two
//   sidebars or none, so every KV→object migration failed this step on correct data, ABOVE
//   the board move, which is the step that reads a board from the room that owns it.
//   The export keeps the invariant now (see `exportState`); this refuses rather than
//   assuming, because the next family to break it would otherwise be copied blind.
//
// AND NOTHING WITH CONTENT IN IT IS EVER FLATTENED. Both sides have to hold nothing before
// the kind is even consulted, so no amount of leniency here can make two different families
// compare equal — which is the failure mode of "just make it pass".
export const holdsNothing = (v) => v === null || v === undefined
  || (Array.isArray(v) ? v.length === 0
    : typeof v === "object" && Object.keys(v).length === 0);

/** `match` — the two agree. `differ` — they do not. `blind` — both empty, but one side could not enumerate it. */
export function compareFamily(id, a, b, lookup = inventoryEntry) {
  if (canonicalJson(a) === canonicalJson(b)) return "match";
  if (!holdsNothing(a) || !holdsNothing(b)) return "differ";
  const entry = lookup(id);
  if (entry && entry.kind === "key") return "match";
  return "blind";
}
