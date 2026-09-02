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

/**
 * A KV timestamp as the ISO string the object's columns hold.
 *
 * ⚠️ THE TWO STORES SPELL A MOMENT DIFFERENTLY AND THE COPY HAS TO TRANSLATE IT. KV records
 * an invite's expiry as epoch MILLISECONDS (`mintInvite` writes `nowMs + INVITE_TTL_MS`);
 * every timestamp column in the object's schema is an ISO-8601 string. Handing the number
 * straight over put `"1788484474092"` in a text column, which `Date.parse` answers `NaN`
 * for — so an invite carried across by a copy read as having no usable expiry at all, on a
 * path where an unreadable expiry is the difference between a link working and a link
 * quietly not. It cost nothing at the time because nothing read the table; `B-kv-read-cutover`
 * is what reads it.
 *
 * Anything already unreadable is not made worse: `stampMs` in src/tenant-do.js still accepts
 * the number, so rows an earlier copy wrote stay redeemable. This is what stops new ones.
 */
const isoStamp = (v, fallback) => {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v).toISOString();
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return fallback;
  if (/^\d+$/.test(s)) return new Date(Number(s)).toISOString();
  return Number.isFinite(Date.parse(s)) ? s : fallback;
};

/** The roles `members.role` will accept. A value outside this set is the object's to refuse. */
const MEMBER_ROLE_SET = Object.freeze(["admin", "editor", "viewer"]);
const FALLBACK_ROLE = "viewer";

/**
 * Families the inventory sends to the workspace object that this translation does NOT carry.
 * Named rather than dropped: a copy that quietly skips a family is indistinguishable from a
 * complete one, which is the failure this whole item exists to avoid.
 */
export const UNMAPPED_WORKSPACE_FAMILIES = Object.freeze({
  "spaces:icons": "the workspace icon pointer belongs in the object's `settings` table, which `importAll` does not write yet",
  "mail:suppressed": "the object has NO TABLE for a suppression list, and the inventory entry says dropping it breaks a promise not to mail somebody again — see B-do-schema-core",
  "users:firstrun": "the object has no table for the first-run record yet — it lives in the workspace's segmented KV, like users:sessionkeys, and the two should take a table in the same schema decision. Losing this family in a copy re-shows one placeholder page to each person once, which is the safer of the two ways to be wrong.",
  "users:sessionkeys:": "the object has no table for a PER-PERSON session key. It has `signing_keys`, which is the workspace's own one, and the two belong in the same schema decision rather than in two — B-cross-workspace-signin is the item that makes it, because minting a session ON a workspace host is the thing that decides what a session binds to. Declared here rather than given a table now so that decision is made once, deliberately. Losing this family in a copy signs that workspace's people out once, which is recoverable, so it is the safer of the two ways to be wrong.",
  "users:sessionkeys": "the retired shared document the per-person records above replaced, read only for a person who has no record yet. Same table decision as the records, same cost when lost: one sign-out for whoever had not been rotated since the records landed.",
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

  // Which addresses the config file NAMES, as against which the overlay added. That is the
  // provenance `members.source` carries, and it is a fact about the source rather than
  // something the table can be asked to work out afterwards.
  const fromConfig = new Set((configUsers || []).map((u) => lc(u && u.email)).filter(Boolean));

  const rowFor = (u, removedAt) => {
    const e = lc(u.email);
    const av = avatars[e] && typeof avatars[e] === "object" ? avatars[e] : null;
    // ⚠️ THE OVERLAY AND THE FILE GO INTO DIFFERENT COLUMNS AND ARE NOT MERGED HERE.
    // Merging is what the SERVING path does, per request, and it is not a fold: `applyNames`
    // DROPS a config-set `initials` when a name override exists and keeps it when one does
    // not, so a table that had already merged them could not answer both. `users:names` also
    // has two live shapes — `{name, at}` today, a bare string on older instances — and only
    // the first is honoured by `applyNames`, so the value travels VERBATIM rather than
    // normalised: normalising would start applying a name the KV path ignores.
    const nmRaw = names[e];
    return {
      email: e,
      // The DURABLE half: what the file says, or what the invitation said for somebody the
      // file does not name yet.
      //
      // A value `members.role` will not accept — the column has a CHECK and `users:roster`
      // does not — is passed through UNCHANGED so `writeIdentity` refuses it BY NAME rather
      // than the copy quietly deciding what somebody's role is. The one exception is a legal
      // overlay role on top of an illegal durable one: taking it keeps the person, where
      // refusing loses them and their overlay together, and `role_overlay` still records
      // that the overlay is where it came from.
      role: MEMBER_ROLE_SET.includes(u.role) ? u.role
        : (MEMBER_ROLE_SET.includes(roles[e]) ? roles[e] : (u.role || FALLBACK_ROLE)),
      name: u.name || null,
      initials: u.initials || null,
      colour: u.color || null,
      addedBy: u.addedBy || null,
      source: fromConfig.has(e) ? "config" : "overlay",
      // The OVERLAY half, one column each.
      roleOverlay: typeof roles[e] === "string" && roles[e] ? roles[e] : null,
      nameOverlay: nmRaw === undefined || nmRaw === null ? null : nmRaw,
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
        createdAt: isoStamp(rec.createdAt, now),
        expiresAt: isoStamp(rec.expires ?? rec.expiresAt, now),
        // KV never recorded who sent an invite, and inventing a plausible author would be
        // read as a fact about who let somebody in.
        createdBy: null,
      });
    }
  }

  // Publish tokens need no re-keying: KV already stores them under a hash.
  //
  // ⚠️ THE SCOPE TRAVELS VERBATIM AND IS THE POINT OF THE ROW. KV's record is
  // `{space, label, createdAt, expiresAt?}`, and `space` is not a label — it is what
  // `publishAuthDetailed` refuses `wrong-space` on, with `*` meaning admin-equivalent
  // because a star token can push the instance config, i.e. the roster. `*` stays `*` and a
  // space id stays that space id: mapping either onto the other would widen every
  // space-scoped token or refuse every star one, and nothing would say so until somebody
  // published. A record with NO `space` copies across as null, which the read treats as
  // "this object cannot answer for this token" rather than as any scope at all.
  //
  // ⚠️ AND `caps` TRAVELS BESIDE IT, FOR THE SAME REASON AND WITH A SHARPER FAILURE. KV's
  // optional `caps` array is what `capabilityRefusal` reads deny-by-default: absent means
  // unrestricted, a list means ONLY those routes. It is what lets the control plane hold a
  // purge-only bearer instead of a star token that could publish over every workspace's
  // content. A copy that dropped it handed the object a row saying `*` and nothing else —
  // and since the object is what the request path reads FIRST, the narrow credential came
  // back out of it as a FULL star token. `null` here is not "unknown": it is this
  // translation stating that KV's record carries no capability, which is a fact it can see
  // and a pre-`caps` copy could not.
  const publishTokens = [];
  if (has("publish:tokens")) {
    take("publish:tokens");
    for (const [hash, rec] of Object.entries(doc("publish:tokens"))) {
      if (!hash || !rec) continue;
      publishTokens.push({
        tokenHash: hash,
        scope: typeof rec.space === "string" && rec.space ? rec.space : null,
        label: rec.label ?? null,
        createdAt: rec.createdAt || now,
        expiresAt: rec.expiresAt ?? null,
        // Verbatim, including a malformed value: `capabilityRefusal` treats anything that is
        // not a list as absent, and normalising here would decide on its behalf.
        caps: rec.caps === undefined ? null : rec.caps,
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
