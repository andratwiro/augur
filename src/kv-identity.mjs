// KV's identity documents, translated into the rows the workspace object stores.
//
// `B-kv-to-do-migration-tool`. The object gained the write path (`importAll` in
// src/tenant-do.js); this is the half that decides what to hand it. It is a pure function
// on purpose: the mapping is where a copy silently loses somebody, so it is tested against
// fixtures rather than exercised through a live instance and eyeballed.
//
// ⚠️ THE ROSTER HAS TWO LAYERS AND ONLY ONE OF THEM IS IN KV. `users:roster` is the
// invite/remove OVERLAY; the durable record is `identity.json`, injected at build time and
// living in the deploy shell, not in KV. A copy that read KV alone would produce a members
// table missing every person the config file names — which is most of them on a real
// instance, and every one of them on an instance nobody has invited anyone to. So this
// takes the config roster as well, and merges the two exactly the way the serving path
// does (`mergeRoster` in src/_worker.js): the config list first minus anyone removed, then
// overlay `add` entries for addresses the config does not already name.
//
// ⚠️ A REMOVAL IS A TOMBSTONE. `users:roster.remove` names people who must not come back
// by fallback, so they become rows carrying `removed_at` rather than absent rows. Leaving
// them out would let a re-invite inherit the last holder's role.

/** Lowercased address, the same normalisation the serving path uses as an identity. */
const lc = (s) => String(s || "").trim().toLowerCase();

/** The roles `members.role` will accept. A value outside this set is the object's to refuse. */
const FALLBACK_ROLE = "viewer";

/**
 * Families the inventory sends to the workspace object that this translation does NOT carry.
 * Named rather than dropped: a copy that quietly skips a family is indistinguishable from a
 * complete one, which is the failure this whole item exists to avoid.
 */
export const UNMAPPED_WORKSPACE_FAMILIES = Object.freeze({
  "spaces:icons": "the workspace icon pointer belongs in the object's `settings` table, which `importAll` does not write yet",
  "mail:suppressed": "the object has NO TABLE for a suppression list, and the inventory entry says dropping it breaks a promise not to mail somebody again — see B-do-schema-core",
  "users:sessionkeys": "the object has no table for a PER-PERSON session key. It has `signing_keys`, which is the workspace's own one, and the two belong in the same schema decision rather than in two — B-cross-workspace-signin is the item that makes it, because minting a session ON a workspace host is the thing that decides what a session binds to. Declared here rather than given a table now so that decision is made once, deliberately. Losing this family in a copy signs that workspace's people out once, which is recoverable, so it is the safer of the two ways to be wrong.",
});

/**
 * The KV documents this translation reads. Named so `scripts/state-inventory.mjs` can ask
 * the question that would have caught `mail:suppressed`: does every family the inventory
 * sends to the workspace object actually have somewhere to land?
 */
export const IDENTITY_KV_FAMILIES = Object.freeze([
  "users:roster", "users:roles", "users:names", "users:avatars",
  "users:invites", "users:lastseen:", "publish:tokens", "avatar:", "spaceicon:",
]);

/**
 * @param {object} families  the export document's `families` map, keyed by inventory id
 * @param {object} opts
 * @param {Array}  opts.configUsers  the roster from instance config — the durable half
 * @param {(token: string) => Promise<string>} opts.hashInvite  how a raw invite token is keyed
 * @param {string} opts.now  ISO stamp for rows KV has no date for
 * @returns {Promise<{identity: object, consumed: string[], skipped: Array<{id: string, why: string}>}>}
 */
export async function identityFromKv(families = {}, opts = {}) {
  const { configUsers = [], hashInvite, now = new Date().toISOString() } = opts;
  const has = (id) => Object.prototype.hasOwnProperty.call(families, id);
  const doc = (id) => (has(id) && families[id] && typeof families[id] === "object" ? families[id] : {});

  const consumed = [];
  const skipped = [];
  const take = (id) => { if (has(id)) consumed.push(id); };

  const roster = doc("users:roster");
  const roles = doc("users:roles");
  const names = doc("users:names");
  const avatars = doc("users:avatars");
  take("users:roster"); take("users:roles"); take("users:names"); take("users:avatars");

  const removed = new Set((Array.isArray(roster.remove) ? roster.remove : []).map(lc));

  // mergeRoster's order, and its precedence: the config list wins over an `add` of the same
  // address, because the file is the record the overlay is a layer on.
  const merged = [];
  const seen = new Set();
  for (const u of configUsers || []) {
    const e = lc(u && u.email);
    if (!e || removed.has(e) || seen.has(e)) continue;
    seen.add(e);
    merged.push({ ...u, email: e });
  }
  for (const rec of Object.values(roster.add || {})) {
    const e = lc(rec && rec.email);
    if (!e || removed.has(e) || seen.has(e)) continue;
    seen.add(e);
    merged.push({ ...rec, email: e });
  }

  const rowFor = (u, removedAt) => {
    const e = lc(u.email);
    const av = avatars[e] && typeof avatars[e] === "object" ? avatars[e] : null;
    // `users:names` is documented as `{email: {name, at}}` and older instances hold a bare
    // string. Both are read: a copy that understood only the current shape would drop the
    // display name of everyone who set one before the shape changed, and a dropped name
    // looks exactly like a name nobody set.
    const nmRaw = names[e];
    const nm = typeof nmRaw === "string" ? { name: nmRaw }
      : (nmRaw && typeof nmRaw === "object" ? nmRaw : null);
    return {
      email: e,
      // The role overlay wins over the config's, which is the precedence `applyRoles` uses:
      // an admin's change has to take effect without waiting for a commit.
      role: roles[e] || u.role || FALLBACK_ROLE,
      name: (nm && nm.name) || u.name || null,
      avatarKey: av ? av.k ?? null : null,
      avatarMime: av ? av.mime ?? null : null,
      avatarAt: av ? av.at ?? null : null,
      addedAt: u.addedAt || now,
      removedAt: removedAt ?? null,
    };
  };

  const members = merged.map((u) => rowFor(u));
  // Tombstones for everyone the overlay removed, whether they came from the file or the
  // overlay. Their role is whatever the record last said, so a re-invite starts from
  // nothing rather than from the last holder's.
  const byEmail = new Map((configUsers || []).map((u) => [lc(u && u.email), u]));
  for (const e of removed) {
    if (!e) continue;
    const prior = byEmail.get(e) || (roster.add && roster.add[e]) || { email: e };
    members.push(rowFor({ ...prior, email: e }, now));
  }

  // Invites are a RE-KEYING, not a copy: KV keys them by the raw token so it can look one
  // up directly, and the object stores only a hash so a read of its storage cannot redeem
  // anybody's invitation.
  const invites = [];
  if (has("users:invites")) {
    take("users:invites");
    if (typeof hashInvite !== "function") {
      throw new Error("identityFromKv: users:invites needs a hashInvite function — the object stores only the hash");
    }
    for (const [token, rec] of Object.entries(doc("users:invites"))) {
      if (!token || !rec) continue;
      invites.push({
        tokenHash: await hashInvite(token),
        email: lc(rec.email),
        createdAt: rec.createdAt || now,
        expiresAt: rec.expires || rec.expiresAt || now,
        // KV never recorded who sent an invite, and inventing a plausible author would be
        // read as a fact about who let somebody in.
        createdBy: null,
      });
    }
  }

  // Publish tokens need no re-keying: KV already stores them under a hash.
  const publishTokens = [];
  if (has("publish:tokens")) {
    take("publish:tokens");
    for (const [hash, rec] of Object.entries(doc("publish:tokens"))) {
      if (!hash || !rec) continue;
      publishTokens.push({
        tokenHash: hash,
        label: rec.label ?? null,
        createdAt: rec.createdAt || now,
        expiresAt: rec.expiresAt ?? null,
      });
    }
  }

  const lastseen = [];
  if (has("users:lastseen:")) {
    take("users:lastseen:");
    for (const [email, at] of Object.entries(doc("users:lastseen:"))) {
      if (!email) continue;
      lastseen.push({ email: lc(email), at: typeof at === "string" ? at : now });
    }
  }

  // Small content-addressed blobs: profile photos and the workspace icon, both base64 data
  // URIs. Canvas images are NOT here — they are megabytes and live in R2.
  const blobs = [];
  for (const [id, prefix] of [["avatar:", "avatar:"], ["spaceicon:", "spaceicon:"]]) {
    if (!has(id)) continue;
    take(id);
    for (const [suffix, body] of Object.entries(doc(id))) {
      if (!suffix || typeof body !== "string") continue;
      blobs.push({ key: prefix + suffix, mime: null, body, at: now });
    }
  }

  for (const [id, why] of Object.entries(UNMAPPED_WORKSPACE_FAMILIES)) {
    if (has(id)) skipped.push({ id, why });
  }

  return { identity: { members, invites, publishTokens, lastseen, blobs }, consumed, skipped };
}
