// Every piece of state an instance holds, and where it goes.
//
// `MIG-state-inventory`. The migration off shared KV needs one authoritative list of what
// exists — otherwise a family that nobody remembers is a family nobody exports, and the
// first time anyone finds out is when a workspace arrives on its new home missing
// something.
//
// ⚠️ THIS LIST ROTS BY DEFAULT, and that is the whole reason `scripts/state-inventory.mjs`
// exists. Five families appeared between the first draft of this inventory and the second
// reading of it, and nothing caught them. The checker is not a nicety on top of the list;
// it is the only thing that keeps the list true.
//
// IT LIVES IN src/ RATHER THAN scripts/ because the worker itself reads it: the export
// endpoint walks this list, so the account of what a backup covers and the account of what
// exists are ONE account rather than two that agree until they do not.
//
// EVERY key-shaped constant in the engine is classified, including the ones that are not
// store keys at all. A list that quietly omitted `pbkdf2$` because "obviously that is not a
// KV key" is a list whose omissions cannot be told apart from oversights.

/**
 * `store`  — where it lives now: `kv`, `r2`, or `none` for a constant that only LOOKS like
 *            a key. `none` entries carry no destination; they carry an explanation.
 * `kind`   — `key` (one document) or `prefix` (one document per something).
 * `to`     — where it goes:
 *              `account`    the control plane's account store. NOT any workspace.
 *              `workspace`  the workspace Durable Object (src/tenant-do.js).
 *              `r2`         shared R2, content-addressed.
 *              `drop`       transient or instance-global; recreated, never carried.
 *              `stays`      already where it belongs.
 *              `n/a`        not state.
 */
export const STATE_INVENTORY = Object.freeze([
  // ── derived, and deliberately not carried ──────────────────────────────────
  {
    id: "health:report", store: "kv", kind: "key", to: "drop",
    why: "The last report the health cron wrote. It is transient and wholly recreated on every run from the build stamp, so there is nothing here a copy could preserve that the next run would not overwrite. Carrying it would be worse than dropping it: a restored report describes a moment that has passed and would read as current, and 'healthy' must never be indistinguishable from 'nobody has looked since the restore'.",
  },
  // ── identity ───────────────────────────────────────────────────────────────
  {
    id: "users:sessionkeys", store: "kv", kind: "key", to: "workspace",
    why: "Per-person session-binding keys. NOT a credential and never checked against anything a person types — it is the value the session cookie HMACs, split out of the password hash so that ending a session and changing a credential can be separate acts. It is workspace-destined rather than account-destined for exactly that reason: a session belongs to one workspace host, and the credential that opens several does not. Losing it in a copy signs that workspace's people out once, which is recoverable; carrying it to the WRONG workspace would let a cookie cross a boundary, which is not.",
  },
  {
    id: "users:secrets", store: "kv", kind: "key", to: "account",
    why: "Password hashes. A credential is ACCOUNT-level — one address, one password, several workspaces — so it must NOT land in any workspace's store: a workspace admin who could reset it would reach every other workspace that address opens.",
  },
  {
    id: "users:roster", store: "kv", kind: "key", to: "workspace",
    why: "The invite/remove overlay on top of identity.json. Becomes rows in `members`, where the file and the overlay stop being two records of one thing.",
  },
  {
    id: "users:roles", store: "kv", kind: "key", to: "workspace",
    why: "A role per address. Becomes the `role` column on `members`.",
  },
  {
    id: "users:spaces", store: "kv", kind: "key", to: "drop",
    why: "A role per address PER SPACE, from when one deployment mounted several. A workspace is the only tier now, so this collapses into the single `role` column rather than migrating.",
  },
  {
    id: "users:names", store: "kv", kind: "key", to: "workspace",
    why: "Display-name overrides. Becomes the `name` column on `members`.",
  },
  {
    id: "users:avatars", store: "kv", kind: "key", to: "workspace",
    why: "Address → avatar pointer. Becomes the `avatar_*` columns on `members`.",
  },
  {
    id: "avatar:", store: "kv", kind: "prefix", to: "workspace",
    why: "The profile photo itself, a base64 data URI of about 20KB. Small enough for the workspace's `blobs` table — unlike a canvas image, which is megabytes and goes to R2.",
  },
  {
    id: "users:invites", store: "kv", kind: "key", to: "workspace",
    why: "Outstanding invitations. Becomes the `invites` table, hash only — a backup or an export of that storage must not be able to redeem anybody's invite.",
  },
  {
    id: "users:lastseen:", store: "kv", kind: "prefix", to: "workspace",
    why: "Last connection per address, shown in the admin list. Its own `lastseen` table, because it is written on a completely different cadence from anything else about a person.",
  },
  {
    id: "publish:tokens", store: "kv", kind: "key", to: "workspace",
    why: "Publish tokens for this workspace. Becomes `publish_tokens`, hash only, same reasoning as invites.",
  },

  // ── the content overlay ────────────────────────────────────────────────────
  {
    id: "statuses", store: "kv", kind: "key", to: "workspace",
    why: "A prototype's dev status. One row per key in `overlay`, so two people setting two different statuses stop losing one of them.",
  },
  {
    id: "names", store: "kv", kind: "key", to: "workspace",
    why: "A card's display-name override. Same table, same reason.",
  },
  {
    id: "canvases", store: "kv", kind: "key", to: "workspace",
    why: "Boards created from a folder index. Same table; creating one becomes a conditional insert, so two creates of one name stop taking each other's board.",
  },
  {
    id: "pins", store: "kv", kind: "key", to: "workspace",
    why: "A signed-out visitor's sidebar, under the bare name. Same table, empty scope.",
  },
  {
    id: "pins:", store: "kv", kind: "prefix", to: "workspace",
    why: "One person's sidebar, `pins:<address>`. Same table, scoped by address. A SEPARATE entry from the bare name above, because the live check matches a key entry exactly and this one was found by that check reporting `pins:<address>` as unaccounted for on a real instance.",
  },
  {
    id: "c:", store: "kv", kind: "prefix", to: "workspace",
    why: "A page's comment threads, one document per page. Same table, with a revision — the value is a document read whole and written back, so per-key rows alone would still lose an add that raced a delete.",
  },
  {
    id: "board:", store: "kv", kind: "prefix", to: "workspace",
    why: "A canvas board document. Same table. NOTE this is a MIRROR: while the realtime worker is separate, the authoritative copy is that worker's own BoardRoom storage, and a DO's storage belongs to the script that created it — so boards do not travel by being migrated here.",
  },
  {
    id: "pt:view", store: "kv", kind: "key", to: "workspace",
    why: "What page the cursor companion's human is looking at. Same table.",
  },
  {
    id: "pt:remarks", store: "kv", kind: "key", to: "workspace",
    why: "The queue of remarks the companion is to deliver. Same table.",
  },
  {
    id: "basset:", store: "kv", kind: "prefix", to: "r2",
    why: "Canvas image BYTES, up to 4MB. A Durable Object's SQLite caps a single value near 2MB, so these cannot go in the workspace store at all: the bytes go to R2 under `assets/<hash>` and the workspace keeps a row saying the image exists.",
  },
  {
    id: "basset-meta:", store: "kv", kind: "prefix", to: "workspace",
    why: "The row for the above — type, size, when. Written only on an instance whose workspace store is bound; on KV it is one document per image.",
  },
  {
    id: "spaces:icons", store: "kv", kind: "key", to: "workspace",
    why: "The workspace icon pointer. Becomes a row in `settings`.",
  },
  {
    id: "spaceicon:", store: "kv", kind: "prefix", to: "workspace",
    why: "The icon itself, a data URI. Same reasoning as an avatar: small enough for `blobs`.",
  },

  // ── transient ──────────────────────────────────────────────────────────────
  {
    id: "rl:login:ip:", store: "kv", kind: "prefix", to: "drop",
    why: "Login throttling counters, seconds to minutes old. Carrying them would migrate somebody's rate limit; recreating them costs one failed attempt.",
  },
  {
    id: "rl:login:em:", store: "kv", kind: "prefix", to: "drop",
    why: "The same counters keyed by address rather than by IP. Transient for the same reason: carrying them would migrate somebody's rate limit, and recreating them costs one failed attempt.",
  },
  {
    id: "rl:mail:", store: "kv", kind: "prefix", to: "drop",
    why: "Mail send caps, per recipient and per actor. Transient for the same reason.",
  },
  {
    id: "mail:suppressed", store: "kv", kind: "key", to: "workspace",
    why: "Addresses a provider has told us to stop mailing. NOT transient — it is a promise not to mail somebody again, and dropping it breaks that promise silently.",
  },
  {
    id: "pair:", store: "kv", kind: "prefix", to: "drop",
    why: "Device-pairing codes, alive five minutes. Anything in flight during a migration is re-run by the person, who is sitting at the terminal.",
  },
  {
    id: "rebake:sent:", store: "kv", kind: "prefix", to: "drop",
    why: "A five-minute debounce on asking the deploy shell to re-bake. Recreated on the next publish.",
  },
  {
    id: "freeze", store: "kv", kind: "key", to: "drop",
    why: "The migration freeze: present means this instance is refusing writes while a workspace is being moved off it. Destined for `drop` and it is the one entry where that word is load-bearing — a workspace that ARRIVED frozen would be one nobody can write to and nobody would know why, and the instance it was frozen ON is the one being retired.",
  },
  {
    id: "engine:update-check", store: "kv", kind: "key", to: "drop",
    why: "The cached answer to 'is there a newer engine'. Instance-global rather than per workspace, and re-fetched within the hour.",
  },

  // ── R2, already where it belongs ───────────────────────────────────────────
  {
    id: "config/instance.json", store: "r2", kind: "key", to: "stays",
    why: "The instance's own config, pushed by the deploy shell. `augur export` deliberately skips it — it is the shell's to write, not a workspace's to carry.",
  },
  {
    id: "spaces/", store: "r2", kind: "prefix", to: "stays",
    why: "Per-space manifests and the version history. The publish store; already content-addressed and already backed up by `augur export`.",
  },
  {
    id: "blobs/", store: "r2", kind: "prefix", to: "stays",
    why: "Published file contents, content-addressed. Same.",
  },
  {
    id: "assets/", store: "r2", kind: "prefix", to: "stays",
    why: "Canvas image bytes, content-addressed. ⚠️ NOT yet covered by `augur export`, which walks `blobs/` only — MIG-export-endpoints has to reach these or a migrated workspace's canvas images are outside both backups.",
  },

  // ── constants that look like keys and are not ──────────────────────────────
  {
    id: "pbkdf2$", store: "none", kind: "prefix", to: "n/a",
    why: "The marker at the front of a stored password hash, saying which KDF produced it. It is inside a value, never a key.",
  },
  {
    id: "u/", store: "none", kind: "prefix", to: "n/a",
    why: "A URL segment. `/__avatar/u/<hash>` tells the route to read the store rather than scan the roster for a config-baked photo.",
  },
]);

/** Everything the checker should find in the source, as a set of ids. */
export const INVENTORY_IDS = Object.freeze(STATE_INVENTORY.map((e) => e.id));

/** Look one up. */
export function inventoryEntry(id) {
  return STATE_INVENTORY.find((e) => e.id === id) || null;
}

/**
 * Whether a LIVE key belongs to an inventory entry. A `key` entry matches exactly; a
 * `prefix` entry matches anything under it.
 */
export function accountsFor(liveKey) {
  const k = String(liveKey || "");
  for (const e of STATE_INVENTORY) {
    if (e.store === "none") continue;
    if (e.kind === "key" ? k === e.id : k.startsWith(e.id)) return e;
  }
  return null;
}
