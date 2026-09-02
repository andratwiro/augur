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
