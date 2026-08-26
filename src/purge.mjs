// Redacting one person out of a conversation other people are part of.
//
// `E-gdpr-purge-user`. Extracted from src/_worker.js so the WORKSPACE OBJECT can run the
// same sweep the worker runs. Under Decision 2 an erasure has to happen in every workspace
// the account belongs to, and only the control plane knows which those are — so the sweep
// has to be reachable as a workspace verb, not only as an admin action inside one workspace
// by somebody who happens to administer it. Two copies of this logic would be two answers
// to "was this person erased", and the one that gets used less is the one that rots.
//
// ── WHAT AN ERASURE KEEPS ───────────────────────────────────────────────────────────
//
// `body` and `at` survive, and so does thread structure. Deleting the messages would erase
// other people's conversation — a reply that answers a question is unreadable once the
// question is gone — and the request is to stop identifying somebody, not to rewrite a
// record other people are part of. So the message stays and stops carrying a person:
// `author` becomes a fixed sentinel, `by` is cleared, and `verified` goes false so nothing
// renders it as a confirmed identity.
//
// ── ⚠️ IDENTIFICATION IS BY A 32-BIT HASH, AND THAT IS THE SHARP EDGE ───────────────
//
// Messages store `by: personId(email)`, a one-way djb2 hash — deliberately, because an
// address in every stored message would be reversible PII and `/__people` is ungated on
// public prototypes precisely because ids cannot be reversed. Do NOT "fix" that by storing
// the address.
//
// The consequence is that two addresses can share an id, and a purge keyed on it would then
// redact an innocent third party's messages too. A machine cannot choose between them, so
// nothing here tries: the caller checks the workspace roster for any OTHER member sharing
// the id and REFUSES, naming the count. That turns a silent over-redaction into a question
// for a person, which is the only honest answer available.

/** What a redacted message says instead of a name. One string, so nothing invents a second. */
export const PURGED_AUTHOR = "Deleted user";

/** The address folding this module uses. Matches the worker's `lcEmail`. */
export const lcAddress = (e) => String(e == null ? "" : e).trim().toLowerCase();

/**
 * The one-way author id. djb2 over the folded address, base 36.
 *
 * ⚠️ ITS OUTPUT IS STORED IN EVERY MESSAGE EVER WRITTEN, so this function is a data format
 * and not an implementation detail. Changing it orphans every stored `by`, which means every
 * past erasure silently stops matching and every "is this mine" check answers no.
 */
export function personIdFor(email) {
  const s = lcAddress(email);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Redact one person from one thread array. Pure — every caller does its own I/O. */
export function purgeThreads(threads, id) {
  let redacted = 0;
  const out = (Array.isArray(threads) ? threads : []).map((t) => {
    if (!t || !Array.isArray(t.messages)) return t;
    let touched = false;
    const messages = t.messages.map((m) => {
      if (!m || m.by !== id) return m;
      touched = true; redacted++;
      // Spread first so any field a future version adds survives an erasure written before
      // it existed; the three that identify are then overwritten by name.
      return { ...m, author: PURGED_AUTHOR, by: null, verified: false };
    });
    return touched ? { ...t, messages } : t;
  });
  return { threads: out, redacted };
}

/**
 * Which OTHER members share this address's author id. Empty means the sweep is safe.
 * `members` is anything with an `email` — the worker's roster rows and the workspace
 * object's `members` table both qualify.
 */
export function idCollisions(members, email) {
  const addr = lcAddress(email);
  const id = personIdFor(addr);
  return (members || [])
    .map((u) => lcAddress(u && u.email))
    .filter((e) => e && e !== addr && personIdFor(e) === id);
}
