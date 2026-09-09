// Who wrote a published version, and the one answer that is not a person.
//
// `F-seed-vs-real-provenance-marker`. A provisioned workspace is not empty: it arrives
// carrying seed prototypes, written by the platform on somebody's behalf before they have
// done anything. Every downstream reader of provenance — the onboarding floor-check that
// asks "has this workspace published anything REAL yet", and the "Edited by" line that
// will replace today's git-derived dates — has to be able to tell those versions from a
// person's, and has to be able to do it without guessing.
//
// THE SENTINEL MUST NOT BE FORGEABLE, and that is the part that cannot be retrofitted.
// `publish.mjs` stamps `source.actor` from `process.env.USER`, which is an environment
// variable: it is whatever the shell says it is. So a sentinel is only trustworthy if the
// ordinary publish path REFUSES to write it — otherwise "was this seeded?" is answered by
// a string anybody can set, and the floor-check it feeds can be walked straight past.
//
// Hence `sanitizeActor`: the reserved prefix is stripped at the one place a real publish
// stamps an actor. It is enforced at the WRITE, not checked at the read, because a read-
// side check has to be remembered by every future consumer and this one cannot be.
//
// The prefix is `augur:` and it contains a colon on purpose — no POSIX username may
// contain one, so an ordinary `$USER` cannot collide with the namespace by accident, and
// the only way to land in it is to try.

/** The actor recorded for anything the platform wrote on a workspace's behalf. */
export const SEED_ACTOR = "augur:seed";

/** The namespace no real actor may occupy. */
export const RESERVED_ACTOR_PREFIX = "augur:";

/** What a screen shows where it would show the publisher's name, for a platform write. */
export const SEED_DISPLAY_NAME = "Augur";

/**
 * Is this publish-token label the platform's? The label-shaped twin of `isSeedSource`, for
 * the one field that carries a label rather than a source object (`publishedBy`). Same
 * rule, same namespace, so a second platform actor is still one edit in one file.
 */
export function isSeedActor(label) {
  return typeof label === "string" && label.toLowerCase().startsWith(RESERVED_ACTOR_PREFIX);
}

/**
 * Clean an actor string coming from the environment. Anything claiming the reserved
 * namespace loses it, so a real publish can never present itself as a platform write.
 */
export function sanitizeActor(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return "";
  if (s.toLowerCase().startsWith(RESERVED_ACTOR_PREFIX)) {
    // Not an error: a person whose $USER happens to start with this should still be able
    // to publish. They simply do not get to claim the namespace.
    return s.slice(RESERVED_ACTOR_PREFIX.length).trim() || "";
  }
  return s;
}

/**
 * Was this version written by the platform rather than by a person?
 *
 * THE ONE PREDICATE. Every consumer asks through here rather than comparing strings, so
 * that adding a second platform actor later (a migration writer, a restore) is one edit
 * in one file rather than a hunt through everything that ever looked at provenance.
 */
export function isSeedSource(source) {
  const actor = source && typeof source === "object" ? source.actor : null;
  if (source && source.seed === true) return true;
  return typeof actor === "string" && actor.toLowerCase().startsWith(RESERVED_ACTOR_PREFIX);
}

/** The provenance stamp for a platform write. `seed: true` is belt and braces for a
 *  reader that only knows the flag, and costs one boolean. */
export function seedSource(extra = {}) {
  return { ...extra, actor: SEED_ACTOR, seed: true };
}

// ── contributors: every editor a file has had ───────────────────────────────────────────
//
// A manifest entry's `by` answers "who last changed this file". A card built from `by` alone
// shows the last editor of each file and nobody else, so a prototype one person made and a
// colleague then touched end to end shows only the colleague. `contributors` is the additive
// answer: every id ever recorded as `by` on the file, plus git's own list of past authors
// when the build can send one (`SOURCE_STAMPS` in build.js), with `by` last. Optional —
// omitted when it would only repeat `by` — and every reader unions it with `by`, so a
// manifest that predates the field means exactly what it meant before. Ids only, never an
// address: the same one-way `personId` hash `by` carries, resolved to a face at render time.

/** A recorded person id: `personId`'s base36 of a 32-bit hash — short, lowercase, no `@`. */
export const PERSON_ID_RE = /^[a-z0-9]{1,13}$/;

/** The contributors a file entry carries, shape-checked: unique ids, nothing that is not one. */
export function contributorsOf(entry) {
  const out = [];
  for (const id of entry && Array.isArray(entry.contributors) ? entry.contributors : []) {
    if (typeof id === "string" && PERSON_ID_RE.test(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * The list a file entry should carry after a write: the prior entry's list and its `by`,
 * then what the body claims (git's past authors — the one claim a body may add to the
 * record, since it can only put a name on a list of people who touched the file), then
 * `by` last. `null` when the list would only repeat `by`, and the field is omitted then.
 */
export function mergeContributors(prior, claimed, by) {
  const ids = [];
  const add = (id) => { if (typeof id === "string" && PERSON_ID_RE.test(id) && !ids.includes(id)) ids.push(id); };
  for (const id of contributorsOf(prior)) add(id);
  if (prior) add(prior.by);
  for (const id of Array.isArray(claimed) ? claimed : []) add(id);
  if (typeof by === "string" && PERSON_ID_RE.test(by)) {
    const i = ids.indexOf(by);
    if (i >= 0) ids.splice(i, 1);
    ids.push(by);
  }
  if (!ids.length || (ids.length === 1 && ids[0] === by)) return null;
  return ids;
}

