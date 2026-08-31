// The workspace Durable Object: everything mutable a workspace owns, in its own storage.
//
// `B-do-schema-core`. Today these live as flat KV documents in one namespace shared by
// every workspace an isolate serves — `users:roster`, `users:roles`, `users:names`,
// `users:avatars`, `users:invites`, `publish:tokens`, `users:lastseen:<email>`,
// `spaces:icons`. That is the second axis of the isolation problem, and the one keying the
// per-request caches did NOT close: an isolate serving two workspaces through one binding
// answers a neighbour's roster even with every memo cold.
//
// ONE DURABLE OBJECT PER WORKSPACE MAKES THAT STRUCTURAL. A DO's storage belongs to that
// object; there is no key you can construct in workspace A that reads workspace B, because
// there is no shared namespace to construct it in. The isolation stops being a rule about
// key naming that reviewers have to hold, and becomes a property of where the bytes live.
//
// ⛔ THE CREDENTIAL DOES NOT COME HERE, and that is the load-bearing omission.
// `users:secrets` holds password hashes. Under the settled architecture a credential is
// ACCOUNT-level — one address, one password, several workspaces — so it belongs to the
// control plane's account store. This object is the authority on MEMBERSHIP and ROLE and on
// nothing else about identity.
//
// The reason is not tidiness. A workspace that could reset a credential could reach every
// other workspace that address opens: a workspace admin would silently become an admin of
// their colleague's unrelated workspace, by resetting a password they share. The schema
// below therefore contains no password and no hash of one —
// `test/tenant-do.test.mjs` asserts that by reading the tables SQLite actually built, so
// the claim is checked rather than promised.
//
// THE ONE SECRET THAT IS HERE, NAMED RATHER THAN SMUGGLED: `signing_keys`. A workspace's
// session cookies are HMACs, and the key they sign with has to live SOMEWHERE. Today it is
// `env.SESSION_SECRET`, one value for the whole Worker — which is fine while a Worker
// serves one workspace and forgeable across every workspace the moment it serves several:
// anyone holding it could mint a valid cookie for a neighbour. Per-workspace is the fix,
// and a per-workspace key can only live in the per-workspace store.
//
// The rule this does not break: NOTHING HERE AUTHENTICATES A PERSON. A password is a
// person's, reused across workspaces, and reachable by whoever administers any one of
// them — that is what must never be here. A signing key is the workspace's own, used
// nowhere else, and the blast radius of reading it is exactly the workspace whose storage
// it was read from. `test/tenant-provisioning.test.mjs` pins that distinction rather than
// leaving it to a reader's judgement.
//
// WHAT IS HERE AND WHY IT LOOKS SIMPLER THAN THE KV IT REPLACES. `users:spaces` mapped an
// address to a role PER SPACE, because one deployment used to mount several. A workspace is
// now the only tier, so a member has one role in this workspace and the table has one
// column for it. Anyone reinstating a per-space role should put it in the membership model
// rather than resurrect the map.

import { PLANS, DEFAULT_PLAN, QUOTA_FIELDS, quotasForPlan } from "./tenant-quotas.mjs";
import { purgeThreads, personIdFor, idCollisions } from "./purge.mjs";
import { deleteConfirmation, backupRetentionFromEnv } from "./delete-confirmation.mjs";
import { tenantLabelFromHost, normalizeHost } from "./tenant-host.mjs";

// 1 → 2: `B-kv-read-cutover`'s second slice. `publish_tokens` gained `scope`, and `members`
// gained the columns that let the roster documents be READ back rather than inferred — see
// `TENANT_SCHEMA_ADDITIONS` for why each one exists and what was wrong without it.
//
// 2 → 3: `publish_tokens` gained `caps`, the second half of the same record. Without it a
// COPY of a capability-restricted token — the control plane's purge-only bearer — landed
// here as an ordinary row, and since this object is what the request path reads FIRST, the
// narrow credential came back out of it as a full star token. A missing column read as "no
// restriction", which is the one reading a deny-by-default capability may never be given.
export const TENANT_SCHEMA_VERSION = 3;

/**
 * The schema, as a list of statements so a migration can apply them one at a time and a
 * test can execute them against a real SQLite engine rather than eyeball them.
 *
 * Every timestamp is an ISO-8601 string rather than an epoch integer: these rows are read
 * by people during incidents, and a number nobody can read at 3am is a number that gets
 * misread.
 */
export const TENANT_SCHEMA = Object.freeze([
  // Who belongs to this workspace, what they may do, and how they appear.
  // Merges users:roster, users:roles, users:names and users:avatars, which were four
  // documents describing one thing and drifting independently.
  //
  // ⚠️ THE DURABLE HALF AND THE OVERLAY HALF ARE DIFFERENT COLUMNS, and that is not
  // tidiness. `identity.json` names a person and the KV overlay changes what they are
  // called; the serving path needs to know WHICH said what, because `applyNames` DROPS a
  // config-set `initials` when there is a name override and keeps it when there is not.
  // One merged column cannot answer both, so a cut that merged them would serve one person
  // as two — see `KV_CUTOVER` in src/_worker.js.
  //
  //   name / role / initials / colour / added_by  — the DURABLE record: the config file's
  //     values, or the invitation's for somebody the file does not name yet.
  //   name_overlay / role_overlay / avatar_*      — the OVERLAY: `users:names`,
  //     `users:roles`, `users:avatars`, each of which a person or an admin set after the
  //     build, and each of which reverts to the column above it when cleared.
  //   source                                      — 'config' or 'overlay': where the
  //     MEMBERSHIP came from, which is what tells a `users:roster` `add` entry from a row
  //     the file already named. Reconstructing it by inference is exactly the guess this
  //     column exists to refuse.
  `CREATE TABLE IF NOT EXISTS members (
     email        TEXT PRIMARY KEY,
     role         TEXT NOT NULL CHECK (role IN ('admin','editor','viewer')),
     name         TEXT,
     avatar_key   TEXT,
     avatar_mime  TEXT,
     avatar_at    TEXT,
     added_at     TEXT NOT NULL,
     removed_at   TEXT,
     initials     TEXT,
     colour       TEXT,
     source       TEXT,
     added_by     TEXT,
     name_overlay TEXT,
     role_overlay TEXT
   )`,
  // A REMOVED member is a tombstone, never a deleted row. The KV design learned this the
  // hard way on the credential side: a removal that merely deletes is undone by any
  // fallback, and re-inviting an address must not inherit the last person's role.
  `CREATE INDEX IF NOT EXISTS members_active ON members (removed_at)`,

  // Outstanding invitations. Only the HASH of the token is stored, so a read of this
  // storage — a backup, an export, an operator looking — cannot redeem anybody's invite.
  `CREATE TABLE IF NOT EXISTS invites (
     token_hash TEXT PRIMARY KEY,
     email      TEXT NOT NULL,
     created_at TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     created_by TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS invites_email ON invites (email)`,

  // Publish tokens for THIS workspace. Hash only, same reasoning as invites.
  // `expires_at` is nullable because tokens minted before expiry existed have none, and
  // the check that reads it is additive on purpose.
  //
  // ⚠️ `scope` IS THE AUTHORIZATION AND NOT A LABEL. It carries KV's `space` VERBATIM:
  // a space id means that space and `*` means every one of them, which is
  // admin-equivalent because a star token pushes instance config — the user list itself.
  // `publishAuthDetailed` in src/_worker.js refuses `wrong-space` on this value, so a
  // copy that dropped it would either widen every space-scoped token to star or refuse
  // every token, and neither is visible until somebody publishes.
  //
  // NULLABLE, and the null is load-bearing: it means "a copy wrote this row before the
  // column existed and does not know". The read treats such a row as no answer at all and
  // falls through to KV, which still holds the scope — a token is never widened by a
  // missing value and never refused for one.
  //
  // ⚠️ `caps` IS THE OTHER HALF OF THE AUTHORIZATION AND IS NOT A LABEL EITHER. KV records
  // an optional `caps` array on a token, and `capabilityRefusal` in src/_worker.js reads it
  // deny-by-default: absent means unrestricted, a list means ONLY what those names grant,
  // and an unknown name grants nothing. It is what lets the control plane hold a purge-only
  // bearer instead of a star token that could publish over every workspace's content.
  //
  // Stored as the JSON of the value KV holds, so the two stores spell the same record: the
  // text `null` is a token that carries NO `caps` field (unrestricted, and this object knows
  // it), and `["purge"]` is a restricted one. SQL NULL is neither — see below.
  //
  // NULLABLE, and the null is load-bearing for the same reason `scope`'s is, with a sharper
  // consequence: it means "a copy wrote this row before the column existed and does not
  // know". The read treats such a row as no answer at all and falls through to KV, which
  // still holds the field. Reading it as "no caps field, therefore unrestricted" is exactly
  // how a narrow credential became a full one, and it is the reading a fresh mint avoids by
  // writing `null` as text rather than leaving the column empty.
  `CREATE TABLE IF NOT EXISTS publish_tokens (
     token_hash TEXT PRIMARY KEY,
     label      TEXT,
     created_at TEXT NOT NULL,
     expires_at TEXT,
     scope      TEXT,
     caps       TEXT
   )`,

  // Last connection, shown in the admin list. Its own table rather than a column on
  // members: it is written on a completely different cadence from everything else about a
  // person, and a write here must not touch a row that carries their role.
  `CREATE TABLE IF NOT EXISTS lastseen (
     email TEXT PRIMARY KEY,
     at    TEXT NOT NULL
   )`,

  // Small content-addressed blobs: profile photos and the workspace icon, which are
  // base64 data URLs today. Canvas images are NOT here — they are large and binary and go
  // to shared R2 (B-migrate-canvas-assets-to-r2); putting megabytes in DO storage would
  // make every cold start pay for them.
  `CREATE TABLE IF NOT EXISTS blobs (
     key   TEXT PRIMARY KEY,
     mime  TEXT,
     body  TEXT NOT NULL,
     at    TEXT NOT NULL
   )`,

  // The workspace's own settings that are not derivable from a build: today just the icon
  // pointer. A key/value table rather than a wide row, because the alternative is a
  // migration every time a workspace grows a preference.
  `CREATE TABLE IF NOT EXISTS settings (
     k TEXT PRIMARY KEY,
     v TEXT
   )`,

  // What this workspace is allowed: seeded at provisioning from src/tenant-quotas.mjs and
  // read by every enforcement point, so raising a limit for one customer is a row and not
  // a deploy. Separate from `settings` because these are not preferences — nobody in the
  // workspace may change them — and a table an admin UI writes to must not be the table a
  // ceiling is read from.
  //
  // A key/value shape for the same reason as settings, and one more: a quota added later
  // is an INSERT, while a column added later is a migration on every workspace that
  // exists. `n` is a number, never null — see QUOTA_FIELDS for why unlimited is a large
  // number rather than an absent one.
  `CREATE TABLE IF NOT EXISTS quotas (
     k TEXT PRIMARY KEY,
     n REAL NOT NULL
   )`,

  // The content overlay: everything the site remembers ABOUT published content rather than
  // in it. Four families today — `statuses` (a prototype's dev status), `names` (a card's
  // display-name override), `canvases` (boards created from a folder index) and `pins` (a
  // person's sidebar) — each of which was a single KV document holding the whole map.
  //
  // ONE ROW PER KEY IS THE POINT. A whole-map document is read, mutated and written back,
  // so two edits to DIFFERENT keys landing together lose one of them: the second write is
  // computed from a map that predates the first. Nobody sees an error; a status simply
  // does not stick, and the person clicks it again. Per-key rows make concurrent edits to
  // different keys independent by construction.
  //
  // `scope` is for the one family that is per person: pins. Empty for the rest. It is a
  // column rather than four tables because a fifth family should be an INSERT and not a
  // migration on every workspace that exists.
  //
  // `v` is TEXT holding JSON, not a typed column: `statuses` stores a word and `canvases`
  // stores an object, and a schema that tried to be both would be a schema that is neither.
  //
  // `rev` is what makes a read-modify-write safe for the families whose value is a
  // DOCUMENT rather than a scalar — a page's comment threads, a board's nodes. Those are
  // read, changed and written back by the worker, so per-key rows alone do not help: two
  // edits to ONE key still lose each other. The writer sends back the rev it read, the
  // update matches on it, and a mismatch is a retry rather than a silent overwrite.
  //
  // `owner` and `acl` are the DATA BASIS for per-resource permissions and nothing else —
  // nothing reads them to decide anything yet, deliberately. `owner` is stamped from the
  // authenticated caller AT ROW CREATION and never from a request body, and never moved by
  // a later writer: a board is owned by whoever made it, not by whoever last saved it.
  // `acl` is a JSON email→role map; absent means "no per-resource restriction, the
  // workspace role decides", which is the narrowing-only default the rest of the
  // permission model already uses.
  //
  // They are here rather than in a table of their own because the alternative is a join on
  // every read of every board, comment thread and status row for a check that does not
  // exist yet. Two nullable columns cost nothing until something reads them.
  `CREATE TABLE IF NOT EXISTS overlay (
     family TEXT NOT NULL,
     scope  TEXT NOT NULL DEFAULT '',
     k      TEXT NOT NULL,
     v      TEXT NOT NULL,
     rev    INTEGER NOT NULL DEFAULT 0,
     at     TEXT NOT NULL,
     owner  TEXT,
     acl    TEXT,
     PRIMARY KEY (family, scope, k)
   )`,

  // Rate and volume counters, one row per thing being counted, reset by window rather than
  // by a sweep. `window` is the bucket the count belongs to — an ISO minute for a rate, an
  // ISO day for a volume — so a new window is a comparison rather than a job that has to
  // run, and a counter for a window nobody is in costs one row until the next bump.
  //
  // A REFUSED REQUEST STILL COUNTS. The increment and the verdict are one statement, so a
  // caller cannot be told "no" without having been counted — which means hammering a
  // ceiling does not get you more than pacing yourself does, and the window still ends when
  // it ends.
  `CREATE TABLE IF NOT EXISTS counters (
     k      TEXT PRIMARY KEY,
     window TEXT NOT NULL,
     n      REAL NOT NULL
   )`,

  // The publish counter, per space. R2 keeps the payloads — the blobs, `versions/<n>.json`,
  // the manifest — and this table is the sole ISSUER of the next number.
  //
  // It exists because R2 has no compare-and-swap and the store's own counter is read,
  // incremented and written back by the client of it: two commits landing together both
  // compute the same next number, and the second PUT overwrites the first's
  // `versions/<n>.json` — destroying a point in the history that recovery depends on,
  // silently, while both publishes report success. A Durable Object is single-threaded, so
  // the increment here cannot interleave.
  //
  // `version` is what was last ISSUED, not what is live. The two differ for as long as a
  // commit is in flight, and after a failed one they differ forever — a number is burned
  // rather than reused, which is the same trade the rollback path already makes for the
  // same reason: reusing one means overwriting a version that exists.
  `CREATE TABLE IF NOT EXISTS publish_versions (
     space   TEXT PRIMARY KEY,
     version INTEGER NOT NULL
   )`,

  // The workspace's own signing keys — today exactly one, `session`, the HMAC key its
  // session cookies are signed with. See the header for why this is here and why it is not
  // the credential the rest of the file refuses to hold.
  //
  // `rotated_at` rather than an UPDATE in place: rotating a session key signs everybody
  // out, so it is an event somebody should be able to see having happened.
  `CREATE TABLE IF NOT EXISTS signing_keys (
     purpose    TEXT PRIMARY KEY CHECK (purpose IN ('session')),
     key        TEXT NOT NULL,
     created_at TEXT NOT NULL,
     rotated_at TEXT
   )`,

  // Schema version and the workspace's own id, so a stored object can say what it is
  // without being told. `meta` is deliberately separate from `settings`: one is about the
  // database, the other about the workspace, and a migration reads the first before it is
  // safe to trust the second.
  `CREATE TABLE IF NOT EXISTS meta (
     k TEXT PRIMARY KEY,
     v TEXT NOT NULL
   )`,
]);

/**
 * Column names that must never appear in this schema.
 *
 * Not a lint for its own sake: the failure it prevents is a workspace admin being able to
 * reset a credential that opens their colleague's other workspaces. `test/tenant-do.test.mjs`
 * runs this over the executed schema, so it reads the tables SQLite actually built rather
 * than the text somebody wrote.
 */
export const FORBIDDEN_COLUMNS = Object.freeze([
  "password", "passhash", "pass_hash", "pass", "secret", "credential", "pbkdf2", "salt",
]);

/**
 * Columns added to a table that already exists, for objects built at an earlier version.
 *
 * ⚠️ `CREATE TABLE IF NOT EXISTS` IS NOT A MIGRATION, and that is the trap this closes. An
 * object provisioned at version 1 has a `members` table, so every statement above is a
 * no-op on it — including the one that now names six more columns. Without this list the
 * new columns exist on a workspace created today and on no workspace created before today,
 * and the difference shows up as a roster read answering `undefined` on exactly the
 * instances that have been running longest.
 *
 * Every entry is additive and nullable by construction: SQLite can add a column to a
 * populated table only if it needs no default, which is the same constraint that makes
 * this safe to run against a live workspace. Nothing is renamed, nothing is dropped, and
 * a downgrade to an engine that does not know these columns still reads every row it wrote.
 *
 * `test/tenant-do.test.mjs` executes the schema and asserts this list and the CREATE
 * statements name the same columns, so the two cannot drift.
 */
export const TENANT_SCHEMA_ADDITIONS = Object.freeze([
  { table: "members", column: "initials", type: "TEXT" },
  { table: "members", column: "colour", type: "TEXT" },
  { table: "members", column: "source", type: "TEXT" },
  { table: "members", column: "added_by", type: "TEXT" },
  { table: "members", column: "name_overlay", type: "TEXT" },
  { table: "members", column: "role_overlay", type: "TEXT" },
  { table: "publish_tokens", column: "scope", type: "TEXT" },
  { table: "publish_tokens", column: "caps", type: "TEXT" },
]);

/**
 * The text a `caps` column holds, from the value a KV record carries.
 *
 * `undefined` — the caller does not know, so the column stays SQL NULL and the read declines
 * to answer for the row. Anything else, including `null`, is a statement about the token and
 * is written as JSON: `null` is "no caps field, therefore unrestricted", which is a fact the
 * mint knows and a copy from a pre-`caps` source does not.
 */
function capsColumn(caps) {
  return caps === undefined ? null : JSON.stringify(caps);
}

/**
 * The value a `caps` column states, or `undefined` for a column that cannot answer.
 *
 * A row a pre-`caps` copy wrote and a row this build cannot parse are the same thing: no
 * answer. Neither may be guessed at, because the only guess available — "no restriction" —
 * is the one that turns a narrow credential into a full one.
 */
function capsValue(text) {
  if (text == null) return undefined;
  try { return JSON.parse(String(text)); } catch (e) { return undefined; }
}

/**
 * Add any column in `TENANT_SCHEMA_ADDITIONS` that this object's tables are missing.
 *
 * ⚠️ IT ASKS BY TRYING, NOT BY INTROSPECTING. The obvious shape is `PRAGMA table_info` and
 * a set difference, and it is wrong in a way that passes every test: a PRAGMA is neither a
 * SELECT nor a plain statement, so a harness that routes by keyword answers it with no rows
 * — and "no rows" reads as "this table has no columns", which skips every addition. The
 * migration would then exist only in the source. `ALTER TABLE … ADD COLUMN` is the same
 * question asked of the engine itself, and a column that is already there is the one error
 * it can raise that means success.
 *
 * Nothing else is swallowed. A failure that is not "the column is already there" is a
 * schema this build cannot read, and carrying on would serve wrong answers rather than
 * refuse.
 */
export function applySchemaAdditions(sql) {
  const added = [];
  for (const { table, column, type } of TENANT_SCHEMA_ADDITIONS) {
    try {
      sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      added.push(`${table}.${column}`);
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (!/duplicate column/i.test(msg)) throw e;
    }
  }
  return added;
}

/** Apply the schema to a SQLite-backed store. Idempotent — every statement is IF NOT EXISTS. */
export function applyTenantSchema(sql, workspaceId) {
  for (const stmt of TENANT_SCHEMA) sql.exec(stmt);
  // AFTER the creates, so a table that does not exist yet is created in today's shape and
  // this pass is the no-op it should be on it.
  applySchemaAdditions(sql);
  sql.exec(
    `INSERT INTO meta (k, v) VALUES ('schema_version', ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
    String(TENANT_SCHEMA_VERSION),
  );
  if (workspaceId) {
    // The id is written ONCE and never updated: an object that could be told it is a
    // different workspace is an object that can be pointed at somebody else's data.
    sql.exec(
      `INSERT INTO meta (k, v) VALUES ('workspace', ?) ON CONFLICT(k) DO NOTHING`,
      String(workspaceId),
    );
  }
}

/**
 * Seed this workspace's quotas from its plan. Provisioning calls it once.
 *
 * INSERT ... DO NOTHING, so it is safe to re-run and so an operator's raise for one
 * customer is not undone by anything that re-seeds. Changing a plan is a deliberate write
 * (`setWorkspacePlan` below), never a side effect of the schema being applied again.
 *
 * The `plans` parameter exists so the defaults have exactly one home: a test proves that
 * changing a value in that table is the whole change, with nothing else to keep in step.
 */
export function seedQuotas(sql, plan = DEFAULT_PLAN, plans = PLANS) {
  const q = quotasForPlan(plan, plans);
  sql.exec(`INSERT INTO meta (k, v) VALUES ('plan', ?) ON CONFLICT(k) DO NOTHING`, q.plan);
  for (const field of QUOTA_FIELDS) {
    sql.exec(`INSERT INTO quotas (k, n) VALUES (?, ?) ON CONFLICT(k) DO NOTHING`, field, q[field]);
  }
}

/**
 * Move this workspace onto another plan: the plan name AND every quota it implies, in one
 * statement each. A plan change that moved the label and left the ceilings behind would be
 * a workspace that has paid and is still refused.
 *
 * It overwrites, which means it also DISCARDS a per-customer raise. That is the honest
 * behaviour for "put this workspace on the paid plan" and the reason a raise should be
 * re-applied after a plan change rather than assumed to survive one.
 */
export function setWorkspacePlan(sql, plan, plans = PLANS) {
  const q = quotasForPlan(plan, plans);
  sql.exec(`INSERT INTO meta (k, v) VALUES ('plan', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, q.plan);
  for (const field of QUOTA_FIELDS) {
    sql.exec(
      `INSERT INTO quotas (k, n) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET n = excluded.n`,
      field, q[field],
    );
  }
  return q.plan;
}

/**
 * A fresh session-signing key: 32 bytes of CSPRNG, hex.
 *
 * NEVER an env var, and that is the whole point of generating it here. `env.SESSION_SECRET`
 * is ONE value for the whole Worker: fine while a Worker serves one workspace, and
 * forgeable across every workspace the moment it serves several — anyone holding it could
 * mint a valid session cookie for a neighbour. A key that is generated per workspace, into
 * that workspace's own storage, cannot be that.
 */
/**
 * How long a deleted workspace's data survives the delete.
 *
 * ⚠️ THIS NUMBER IS PUBLISHED, so it is not a tuning knob. The hosted lifecycle page tells
 * customers "gone from the service in 30 days, gone from the backups within 70", the
 * delete-confirmation screen says the same thing (`F-tenant-delete-ux`), and the backup
 * rotation is what makes the second number true (`D-2-nightly-backup-worm`, 30 kept plus
 * 40). Change this and all three change the same day, or the platform is promising
 * something it does not do.
 *
 * The screen is the one of the three that CANNOT fall behind: `src/delete-confirmation.mjs`
 * derives every number it shows from this constant, and `GET /__control/delete` serves that
 * to whatever renders the confirmation, so no surface holds a second copy of "30". The page
 * and the rotation are still hand-kept, and still have to move on the same day.
 */
export const DELETE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Every verb the outside world may ask a workspace to perform on itself.
 *
 * ⚠️ IT MUST MATCH `TENANT_RPC` in the control plane's src/provisioning.js EXACTLY. The two
 * are separate repos and neither can import the other, so the list is written twice on
 * purpose and the seam between them was open for a while: the control plane POSTed
 * `/__control/<verb>` and this object routed `/status`, `/activity`, `/destroy` and nothing
 * else, so every control-plane call was a 404 that nothing was watching for.
 */
export const CONTROL_VERBS = Object.freeze([
  "provision", "status", "suspend", "resume", "rotate", "delete", "purge", "rename", "claim", "chrome",
]);

/**
 * The KV document the front door's alias lookup reads, for one hostname. ONE key shape for
 * every kind of alias — a platform label the resolver refuses (`demo.<suffix>`) and, later,
 * a customer's own hostname that carries no suffix at all — so the resolver ever makes ONE
 * lookup, keyed on the full normalized hostname, rather than growing a second table when
 * custom hostnames arrive.
 */
export const HOST_ALIAS_KEY_PREFIX = "host:alias:";
export const hostAliasKey = (hostname) => `${HOST_ALIAS_KEY_PREFIX}${hostname}`;

/**
 * A hostname a claim may carry: a normalized, dotted DNS name — at least two labels, each
 * of legal shape, 253 characters or fewer. Deliberately NARROW: no port, no trailing dot,
 * no case (normalizeHost has already folded those away for a live request, and a stored
 * key must hold exactly the form the lookup asks for).
 */
export function normalizeClaimHostname(hostname) {
  const h = normalizeHost(hostname);
  if (!h || h.length > 253 || h.startsWith("[")) return null;
  const labels = h.split(".");
  if (labels.length < 2) return null;
  const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  for (const l of labels) if (!LABEL.test(l)) return null;
  return h;
}

/**
 * The suspension reasons a member can lift by signing in — an ALLOWLIST, and the WHOLE of
 * `E-dormancy-resume` is this list rather than the resume that stands beside it.
 *
 * The hosted lifecycle page promises that a workspace suspended for dormancy "reactivates
 * on the first successful sign-in by an admin". Every OTHER suspension has to survive that
 * same sign-in: an acceptable-use takedown is lifted by whoever imposed it, a tombstone is
 * lifted by a restore, and neither is something the suspended workspace's own admin may do
 * by proving they are the admin. A resume that fired on the wrong reason would un-take-down
 * a phishing page on the strength of its own owner signing in, which is the one failure
 * here that reaches people who are not customers.
 *
 * ⚠️ AN ALLOWLIST, NEVER A DENYLIST, and that is a decision rather than a style. A denylist
 * — "resume unless the reason is `deleted`, or starts with the acceptable-use word" —
 * resumes on every suspension kind invented after it, the day that kind ships, silently and
 * with nobody having decided it. This list makes a new kind INERT instead: an unrecognised
 * reason never resumes, and somebody has to come here on purpose and add it.
 * `test/dormancy-resume.test.mjs` pins the contents, so growing the list is a visible act.
 *
 * ⚠️ MATCHED EXACTLY, byte for byte. Not a prefix, not case-folded, not trimmed. An
 * operator's free-text reason that merely CONTAINS the word is not a dormancy suspension,
 * and every near miss therefore fails to "it stays paused", which is the safe side of this
 * particular wrong answer.
 *
 * ⚠️ NOTHING WRITES THIS WORD YET. The 90-day sweep the lifecycle page describes is not
 * built; when it is, it must call `suspend()` with exactly this string, and this constant is
 * the definition it has to match. Same shape as CONTROL_VERBS and the control plane's
 * `TENANT_RPC` — the two repos cannot import each other, so the value is written twice and
 * each side's suite asserts the other's copy. Until the sweep exists, no live workspace can
 * carry a reason on this list, so the resume below is reachable only by an operator who
 * suspends with that exact word.
 */
export const DORMANCY_SUSPENSION_REASONS = Object.freeze(["dormant"]);

export function newSigningKey(random = (b) => crypto.getRandomValues(b)) {
  const bytes = new Uint8Array(32);
  random(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * How long a chrome-refresh token lives. Long enough to build the engine and publish
 * `--engine`, short enough that a forgotten one is dead soon. The credential is minted by the
 * operator `chrome` verb and used once from a laptop; it is not a machine token.
 */
export const CHROME_TOKEN_TTL_MS = 60 * 60 * 1000;

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Everything provisioning writes, as ONE synchronous body a transaction can wrap.
 *
 * ORDER IS PART OF THE CONTRACT. `provisioned_at` is written LAST, and it is the only row
 * anything else reads to decide whether this workspace exists. So even without a
 * transaction there is no observable half-state: a crash anywhere above leaves the flag
 * unset and the workspace unresolvable. The transaction is the belt on top of that brace,
 * and `TenantStore.provision` supplies it.
 *
 * WHAT IT DOES NOT DO, both deliberate:
 *   · It does not mint a password. The credential is account-level, so this BINDS an
 *     already-verified account as the first admin. Nothing here takes a secret from a
 *     caller, which is why the signature has nowhere to put one.
 *   · It does not seed a default space. The workspace IS the space; there is no inner
 *     tier to create, and no `no-default-space` failure left to design around.
 *
 * Re-running it on a provisioned workspace is a NO-OP that returns the existing state.
 * That is not politeness — two concurrent provisions of one slug reach the same object,
 * and the second must not mint a second signing key (which would sign the first one's
 * sessions out) or overwrite the first admin.
 */
/**
 * The families a seed pack may write, as a frozen list.
 *
 * ⚠️ AN ALLOWLIST, NOT THE OVERLAY'S OWN FAMILY LIST. A seed arrives from outside this object
 * — the control plane hands it over at provisioning — and the families it may touch are the
 * ones a NEW workspace can meaningfully have content in. `assets` is not here (canvas image
 * metadata whose bytes live in R2, so a seeded row would point at nothing) and neither is
 * `piti`. Adding one is a deliberate edit, which is the point.
 */
export const SEEDABLE_FAMILIES = Object.freeze(["comments", "boards", "statuses", "names", "canvases", "pins"]);

/**
 * The identity families a copy may carry, and the roles a member row may hold.
 *
 * `B-kv-to-do-migration-tool`. These have had tables since `B-do-schema-core` and no write
 * path, so a copy of a workspace's state landed the content and left the roster, the
 * invites and the publish tokens in KV. This is that write path — and it is a COPY:
 * nothing reads what it writes until `B-kv-read-cutover` moves the reads over.
 *
 * ⚠️ THERE IS NO CREDENTIAL FAMILY HERE AND THERE MUST NEVER BE ONE. A password is
 * account-level — one address, one credential, several workspaces — so a workspace that
 * held a hash could reach every other workspace that address opens. The object writes only
 * what this list names, so a caller that sends a `secrets` key is ignored rather than
 * trusted to have meant something else.
 */
export const IDENTITY_FAMILIES = Object.freeze(["members", "invites", "publishTokens", "lastseen", "blobs"]);
const MEMBER_ROLES = Object.freeze(["admin", "editor", "viewer"]);

/** The address as an identity: lowercased and trimmed, the normalisation the gate uses. */
const lcAddr = (s) => String(s == null ? "" : s).trim().toLowerCase();

/**
 * A stored timestamp as epoch milliseconds, or null if it is not one.
 *
 * ⚠️ IT ACCEPTS TWO SPELLINGS ON PURPOSE, and only one of them is written here. Every
 * timestamp column in this schema is an ISO-8601 string, because these rows are read by
 * people during incidents. But KV stored an invite's expiry as epoch milliseconds, and a
 * copy carries what the source held — so a table filled by one holds rows whose
 * `expires_at` is a number in a text column, which `Date.parse` answers `NaN` for. Reading
 * strictly would have declared every invite carried across invalid, without a word, and the
 * first sign of it would be somebody clicking a link that has not expired.
 *
 * The numeric branch is therefore a READ accommodation and never a writing style: nothing
 * in this file produces one, and `src/kv-identity.mjs` no longer does either.
 *
 * ⚠️ AND IT HAS TO ACCEPT THE SPELLING SQLITE PRODUCES, WHICH IS NOT THE ONE JAVASCRIPT
 * DOES. The pre-fix copy did not stringify the number; it BOUND it, and a JS number bound
 * into a TEXT-affinity column is converted by SQLite from a double — which renders as
 * `"1788484474092.0"`, with a trailing `.0` no `String(n)` ever writes. So `/^\d+$/` matches
 * a fixture that spelled the row by hand and misses every row the copy actually wrote, and
 * an accommodation that only covers the hand-spelled form covers nothing. Measured on
 * workerd and on node:sqlite, which agree: `scripts/tenant-do-rehearsal.mjs` drives
 * `/state/import` with the real numeric field and was the run that found it.
 */
function stampMs(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = String(v == null ? "" : v).trim();
  if (!s) return null;
  // Digits, optionally with the fractional part SQLite's double rendering adds. Deliberately
  // NOT a general numeric grammar: exponent notation and a leading sign are not shapes any
  // producer of these rows emits, and widening this to "anything Number() likes" would start
  // reading strings that are not timestamps as timestamps.
  if (/^\d+(?:\.\d+)?$/.test(s)) return Number(s);
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Whether this object has ever been given ONE identity family's contents — by a copy, by
 * provisioning, or by a write since the reads moved.
 *
 * ⚠️ "EMPTY" AND "NEVER FILLED" ARE DIFFERENT ANSWERS AND THE CUT TURNS ON TELLING THEM
 * APART. A workspace whose roster overlay is genuinely empty and one whose copy has not run
 * yet both read as no rows, and answering the first from the object is correct while
 * answering the second from it silently un-removes everybody KV's `remove` list names. So
 * the object says which it is, and the worker falls back to KV for the second — the same
 * "the object first, KV as the fallback" rule an outstanding invite link already relies on.
 *
 * A stamp rather than a flag, because the first question anybody asks of a straddle is when
 * it started.
 */
const SEEDED_KEY = (family) => `identity_seeded:${family}`;

function markSeeded(sql, family, at) {
  sql.exec(
    `INSERT INTO meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO NOTHING`,
    SEEDED_KEY(family), at || new Date().toISOString(),
  );
}

function isSeeded(sql, family) {
  return [...sql.exec(`SELECT v FROM meta WHERE k = ?`, SEEDED_KEY(family))].length > 0;
}

/** How many rows a seed pack would write. Used to report, and to tell "none" from "empty". */
function seedCount(seed) {
  if (!seed || typeof seed !== "object") return 0;
  let n = 0;
  for (const family of SEEDABLE_FAMILIES) {
    const scopes = seed[family];
    if (!scopes || typeof scopes !== "object") continue;
    for (const scope of Object.keys(scopes)) {
      const map = scopes[scope];
      if (map && typeof map === "object") n += Object.keys(map).length;
    }
  }
  return n;
}

/**
 * Write the identity families. Rows arrive translated and hashed; see `IDENTITY_FAMILIES`.
 *
 * Every insert is an UPSERT rather than a plain insert, because the copy has to be safe to
 * re-run: a run killed halfway is fixed by running it again, and that is only true if the
 * second run lands on top of the first instead of colliding with it.
 *
 * A REMOVED MEMBER IS A TOMBSTONE, never an absent row. KV records a removal in
 * `users:roster`'s `remove` list, and dropping the person here instead would let a
 * re-invite inherit the role the last holder of that address had.
 */
function writeIdentity(sql, identity, at, written = [], refused = []) {
  if (!identity || typeof identity !== "object") return { written, refused };
  const list = (k) => (Array.isArray(identity[k]) ? identity[k] : []);
  const touched = (family, n) => { if (n) written.push(family); };

  let n = 0;
  for (const m of list("members")) {
    if (!m || !m.email) continue;
    // A role the schema does not allow is the source's shape, not the caller's bug.
    if (!MEMBER_ROLES.includes(m.role)) {
      refused.push({ family: "members", key: String(m.email), why: `role '${m.role}' is not admin, editor or viewer` });
      continue;
    }
    sql.exec(
      `INSERT INTO members (email, role, name, avatar_key, avatar_mime, avatar_at, added_at,
                            removed_at, initials, colour, source, added_by, name_overlay, role_overlay)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
         ON CONFLICT(email) DO UPDATE SET
           role = ?2, name = ?3, avatar_key = ?4, avatar_mime = ?5,
           avatar_at = ?6, added_at = ?7, removed_at = ?8, initials = ?9, colour = ?10,
           source = ?11, added_by = ?12, name_overlay = ?13, role_overlay = ?14`,
      String(m.email), m.role, m.name ?? null, m.avatarKey ?? null, m.avatarMime ?? null,
      m.avatarAt ?? null, m.addedAt || at, m.removedAt ?? null,
      m.initials ?? null, m.colour ?? null, m.source === "overlay" ? "overlay" : "config",
      m.addedBy ?? null,
      // The overlay name travels as the JSON the KV document held, not as a string. See
      // `rosterRead` — `users:names` has TWO live shapes and `applyNames` honours one of
      // them, so normalising here would start applying a display name the KV path ignores.
      m.nameOverlay === undefined || m.nameOverlay === null ? null : JSON.stringify(m.nameOverlay),
      m.roleOverlay ?? null,
    );
    n++;
  }
  touched("members", n);
  if (n) markSeeded(sql, "roster", at);

  n = 0;
  for (const i of list("invites")) {
    if (!i || !i.tokenHash) continue;
    sql.exec(
      `INSERT INTO invites (token_hash, email, created_at, expires_at, created_by)
         VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT(token_hash) DO UPDATE SET email = ?2, created_at = ?3, expires_at = ?4, created_by = ?5`,
      String(i.tokenHash), String(i.email || ""), i.createdAt || at, i.expiresAt || at, i.createdBy ?? null,
    );
    n++;
  }
  touched("invites", n);

  n = 0;
  for (const t of list("publishTokens")) {
    if (!t || !t.tokenHash) continue;
    sql.exec(
      `INSERT INTO publish_tokens (token_hash, label, created_at, expires_at, scope, caps)
         VALUES (?1,?2,?3,?4,?5,?6)
         ON CONFLICT(token_hash) DO UPDATE SET label = ?2, created_at = ?3, expires_at = ?4,
           -- COALESCE, so re-running a copy from a source that has no scope cannot blank a
           -- scope a later one carried. A null here means "not known", never "star".
           scope = COALESCE(?5, publish_tokens.scope),
           -- The same, and for a sharper reason: a copy that predates the column carries no
           -- caps key at all, and letting it blank the column would turn the control
           -- plane's purge-only bearer back into a credential that can publish anything.
           caps = COALESCE(?6, publish_tokens.caps)`,
      String(t.tokenHash), t.label ?? null, t.createdAt || at, t.expiresAt ?? null,
      t.scope == null ? null : String(t.scope),
      // ⚠️ ABSENT AND `null` ARE DIFFERENT HERE. No `caps` key is a copy that does not know,
      // and leaves the column alone; a `caps` of null is the translation saying KV's record
      // carries no capability, which is a statement this object may hold.
      Object.prototype.hasOwnProperty.call(t, "caps") ? capsColumn(t.caps) : null,
    );
    n++;
  }
  touched("publishTokens", n);
  if (n) markSeeded(sql, "publishTokens", at);

  n = 0;
  for (const s of list("lastseen")) {
    if (!s || !s.email) continue;
    sql.exec(
      `INSERT INTO lastseen (email, at) VALUES (?1,?2)
         ON CONFLICT(email) DO UPDATE SET at = ?2`,
      String(s.email), s.at || at,
    );
    n++;
  }
  touched("lastseen", n);

  n = 0;
  for (const b of list("blobs")) {
    if (!b || !b.key) continue;
    sql.exec(
      `INSERT INTO blobs (key, mime, body, at) VALUES (?1,?2,?3,?4)
         ON CONFLICT(key) DO UPDATE SET mime = ?2, body = ?3, at = ?4`,
      String(b.key), b.mime ?? null, b.body, b.at || at,
    );
    n++;
  }
  touched("blobs", n);

  return { written, refused };
}

/**
 * Write a seed pack into the overlay. Shape: `{ <family>: { <scope>: { <key>: <value> } } }`.
 *
 * ⚠️ EVERY INSERT IS `DO NOTHING`. Re-provisioning an existing workspace is a no-op that keeps
 * the first admin, and it must be a no-op here too: a second provision must not overwrite a
 * board somebody has been editing for a month with the sample it started as.
 *
 * A family that is not on the allowlist is SKIPPED, not an error. The seed comes from the
 * control plane rather than from a stranger, and refusing the whole provision because a pack
 * carried one unknown key would turn a cosmetic mismatch into a failed signup.
 */
function seedOverlay(sql, seed, at) {
  if (!seed || typeof seed !== "object") return 0;
  let written = 0;
  for (const family of SEEDABLE_FAMILIES) {
    const scopes = seed[family];
    if (!scopes || typeof scopes !== "object" || Array.isArray(scopes)) continue;
    for (const [scope, map] of Object.entries(scopes)) {
      if (!map || typeof map !== "object" || Array.isArray(map)) continue;
      for (const [k, v] of Object.entries(map)) {
        if (v === null || v === undefined) continue;
        sql.exec(
          `INSERT INTO overlay (family, scope, k, v, at) VALUES (?1,?2,?3,?4,?5)
             ON CONFLICT(family, scope, k) DO NOTHING`,
          family, String(scope), String(k), JSON.stringify(v), at,
        );
        written++;
      }
    }
  }
  return written;
}

export function applyProvisioning(sql, {
  workspaceId, adminEmail, adminName = "", plan = DEFAULT_PLAN, now, sessionKey, seed = null,
} = {}) {
  if (!workspaceId) throw new Error("provisioning needs a workspace id");
  if (!adminEmail) throw new Error("provisioning needs an admin address");
  const at = now || new Date().toISOString();

  const existing = [...sql.exec(`SELECT v FROM meta WHERE k = 'provisioned_at'`)];
  if (existing.length) return { provisionedAt: existing[0].v, created: false };

  sql.exec(`INSERT INTO meta (k, v) VALUES ('workspace', ?) ON CONFLICT(k) DO NOTHING`, String(workspaceId));
  sql.exec(
    `INSERT INTO signing_keys (purpose, key, created_at) VALUES ('session', ?, ?)
       ON CONFLICT(purpose) DO NOTHING`,
    sessionKey || newSigningKey(), at,
  );
  sql.exec(
    `INSERT INTO members (email, role, name, added_at, source) VALUES (?, 'admin', ?, ?, 'config')
       ON CONFLICT(email) DO NOTHING`,
    String(adminEmail).trim().toLowerCase(), adminName || "", at,
  );
  // A workspace PROVISIONED here has no KV era behind it, so this object is the record for
  // both identity families from its first moment and there is nothing to fall back to. A
  // workspace that ARRIVES from KV is marked by the copy instead — see `markSeeded`.
  markSeeded(sql, "roster", at);
  markSeeded(sql, "publishTokens", at);
  seedQuotas(sql, plan);
  // ── the seed, INSIDE the same body ────────────────────────────────────────────────
  //
  // `F-atomic-tenant-seed-write`. A workspace whose admin exists and whose first thread does
  // not is a workspace whose owner arrives at an empty room the product promised would not
  // be empty — and the repair is a second write that can fail on its own, at a moment nobody
  // is watching. So the seed goes here, above `provisioned_at`, and inherits the ordering the
  // admin and the signing key already have: a crash anywhere leaves the workspace
  // unresolvable rather than half-furnished.
  //
  // ⚠️ WHAT IT CAN SEED IS THE OVERLAY, AND THAT IS THE HONEST BOUNDARY. The sample comment
  // thread, a status, a card name — everything this object owns. PUBLISHED CONTENT IS NOT
  // HERE and cannot be: prototypes are blobs in R2, a different store with no transaction in
  // common with this one, and a seed pack that claimed otherwise would be claiming an
  // atomicity nothing can provide. The order that makes that safe is the same one used
  // everywhere else here — publish the content FIRST, then provision; content nobody can
  // reach yet is invisible, an admin with no content is a promise broken on the first screen.
  seedOverlay(sql, seed, at);
  sql.exec(`INSERT INTO meta (k, v) VALUES ('created_at', ?) ON CONFLICT(k) DO NOTHING`, at);
  // LAST. Everything above is invisible until this row exists.
  sql.exec(`INSERT INTO meta (k, v) VALUES ('provisioned_at', ?) ON CONFLICT(k) DO NOTHING`, at);
  return { provisionedAt: at, created: true, seeded: seedCount(seed) };
}

/**
 * One workspace's mutable state.
 *
 * Deliberately thin at this stage: the schema and its migration are what `B-do-schema-core`
 * is for, and the read/write verbs arrive with the families that move onto them
 * (`B-do-schema-content-overlay`, `B-do-schema-comments-boards`). Adding speculative
 * methods now would mean guessing at call sites that do not exist.
 */
export class TenantStore {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.ready = false;
  }

  /** SQLite handle. Named so a stub in a test is obviously standing in for one thing. */
  get sql() {
    return this.ctx.storage.sql;
  }

  /**
   * Apply the schema once per object lifetime. Wrapped in blockConcurrencyWhile so two
   * concurrent requests to a cold object cannot both run the migration — the statements are
   * idempotent, but a half-applied schema read by the other request is not.
   */
  async init(workspaceId, { plan = DEFAULT_PLAN } = {}) {
    if (this.ready) return;
    const run = () => {
      applyTenantSchema(this.sql, workspaceId);
      // Seeded here rather than at provisioning ONLY: a workspace that somehow reaches an
      // enforcement point with no quota row would be a workspace with no ceilings, and
      // "no ceilings" is the wrong way for that to fail. Seeding is DO NOTHING, so a
      // provisioned plan and any per-customer raise both survive it.
      seedQuotas(this.sql, plan);
      this.ready = true;
    };
    if (this.ctx.blockConcurrencyWhile) await this.ctx.blockConcurrencyWhile(async () => run());
    else run();
  }

  /** What this object believes it is. Reads `meta`, never the request. */
  workspaceId() {
    const rows = [...this.sql.exec(`SELECT v FROM meta WHERE k = 'workspace'`)];
    return rows.length ? rows[0].v : null;
  }

  schemaVersion() {
    const rows = [...this.sql.exec(`SELECT v FROM meta WHERE k = 'schema_version'`)];
    return rows.length ? Number(rows[0].v) : 0;
  }

  /**
   * Provision this workspace: first admin, signing key, quotas, in ONE transaction.
   *
   * `transactionSync` is what makes the crash case all-or-nothing rather than
   * nearly-always-fine; `blockConcurrencyWhile` is what stops a second request arriving
   * mid-provision and reading a workspace that is halfway there. A Durable Object is
   * single-threaded, so the two together are the whole concurrency story.
   *
   * A runtime without `transactionSync` still gets the right ANSWER, because
   * `provisioned_at` is written last — it just gets it by ordering rather than by
   * rollback.
   */
  async provision(opts = {}) {
    await this.init(opts.workspaceId, { plan: opts.plan });
    const body = () => applyProvisioning(this.sql, opts);
    const run = () => (this.ctx.storage.transactionSync
      ? this.ctx.storage.transactionSync(body)
      : body());
    if (this.ctx.blockConcurrencyWhile) return this.ctx.blockConcurrencyWhile(async () => run());
    return run();
  }

  /**
   * Note when somebody used this workspace — a sign-in OR a publish, coarsely.
   *
   * `lastActivityAt` exists nowhere else, and the four signals that do each cover a slice
   * with a hole. `publishedAt` is publishes only. `users:lastseen:<address>` is browser
   * sessions and is BLIND TO PUBLISHING, because `augur publish` carries a bearer token and
   * never touches `/__me` — a team shipping daily from CI reads as months idle. Comment
   * recency would mean reading every page's threads. The canvas registry's stamp is
   * creation, not editing, and a board document carries no wall clock at all.
   *
   * So it is one column, bumped at both, and THROTTLED: skipping the write while the stored
   * value is fresh is what stops a per-request write on a busy workspace, the same reason
   * the browser-session stamp throttles.
   *
   * The dormancy clock the lifecycle policy promises is keyed on this. Anything narrower
   * suspends workspaces that are being used, which is why "publish counts" is not an extra.
   */
  touchActivity(now = Date.now(), throttleMs = 15 * 60 * 1000) {
    const rows = [...this.sql.exec(`SELECT v FROM meta WHERE k = 'last_activity_at'`)];
    const prev = rows.length ? Date.parse(rows[0].v) || 0 : 0;
    if (now - prev < throttleMs) return false;
    this.sql.exec(
      `INSERT INTO meta (k, v) VALUES ('last_activity_at', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      new Date(now).toISOString(),
    );
    return true;
  }

  /**
   * The facts this workspace can state about itself. No customer content, ever — counts and
   * scalars only, because this is read by an operator-facing isolate and a comment body has
   * no business being anywhere near one.
   *
   * ⚠️ IT MUST NOT WRITE, AND MUST NOT init(). `ns.get(ns.idFromName(name))` always hands
   * back a live stub, and a Durable Object comes into existence on its first WRITE — so a
   * status call on a typo or a released slug that applied the schema would spring an empty
   * workspace into being and then report it as real. Everything below reads, and a workspace
   * that has never been written to answers `hasStoredData: false`.
   */
  status() {
    // OUR tables, not any table. A Durable Object's storage carries bookkeeping of its
    // own — `_cf_*` in production, and `__miniflare_do_name` under a local run — so
    // "does this object have any table at all" answers `true` for an object nobody has
    // ever written to, which is the exact question this must not get wrong.
    const ours = new Set(TENANT_SCHEMA
      .map((stmt) => (/CREATE TABLE IF NOT EXISTS (\w+)/.exec(stmt) || [])[1])
      .filter(Boolean));
    const tables = new Set([...this.sql.exec(
      `SELECT name FROM sqlite_master WHERE type = 'table'`,
    )].map((r) => String(r.name)).filter((n) => ours.has(n)));
    if (!tables.has("meta")) return { provisioned: false, hasStoredData: tables.size > 0 };

    const meta = {};
    for (const row of this.sql.exec(`SELECT k, v FROM meta`)) meta[row.k] = row.v;
    const count = (sql, ...p) => {
      const rows = [...this.sql.exec(sql, ...p)];
      return rows.length ? Number(rows[0].n) : 0;
    };
    // `dbstat` is a compile-time SQLite option, so it is asked for rather than assumed: a
    // null here means "this runtime cannot tell me", which is a different answer from zero.
    let doStoredBytes = null;
    try { doStoredBytes = count(`SELECT SUM(pgsize) AS n FROM dbstat`); } catch (e) { doStoredBytes = null; }

    return {
      provisioned: !!meta.provisioned_at,
      hasStoredData: true,
      // Reported as fields rather than omitted, so a caller never has to tell "not
      // suspended" from "this build is too old to know".
      suspended: meta.suspended === "1",
      suspendedReason: meta.suspended_reason || null,
      suspendedAt: meta.suspended_at || null,
      // A tombstone. The data is all still here until `purgeAfter`, which is why the two are
      // reported together — "deleted" without the date reads as "gone", and for thirty days
      // it is not.
      deleted: !!meta.deleted_at,
      deletedAt: meta.deleted_at || null,
      purgeAfter: meta.purge_after || null,
      // This address stopped being the workspace's address, and when. Reported here and not
      // where the workspace went: see renameAway for why that pointer is not kept.
      moved: !!meta.moved_at,
      movedAt: meta.moved_at || null,
      createdAt: meta.created_at || null,
      lastActivityAt: meta.last_activity_at || null,
      // The last time a sign-in brought this workspace back, what it had been paused for,
      // and who by. A dormancy resume CLEARS the suspension row, so without these three
      // nothing afterwards can say it ever happened. `resumedBy` is the one-way person id,
      // never an address — see resumeOnSignIn.
      resumedAt: meta.resumed_at || null,
      resumedFrom: meta.resumed_from || null,
      resumedBy: meta.resumed_by || null,
      // The chosen hostname this workspace also answers at, and when it was claimed.
      // Public by design — it is in every redirect the generated address serves.
      canonicalHost: meta.canonical_host || null,
      canonicalHostAt: meta.canonical_host_at || null,
      plan: meta.plan || DEFAULT_PLAN,
      quotas: this.quotas(),
      members: tables.has("members") ? count(`SELECT COUNT(*) AS n FROM members WHERE removed_at IS NULL`) : 0,
      invites: tables.has("invites") ? count(`SELECT COUNT(*) AS n FROM invites`) : 0,
      threads: tables.has("overlay") ? count(`SELECT COUNT(*) AS n FROM overlay WHERE family = 'comments'`) : 0,
      boards: tables.has("overlay") ? count(`SELECT COUNT(*) AS n FROM overlay WHERE family = 'boards'`) : 0,
      images: tables.has("overlay") ? count(`SELECT COUNT(*) AS n FROM overlay WHERE family = 'assets'`) : 0,
      doStoredBytes,
    };
  }

  /** Whether this workspace exists as far as anything else is concerned. */
  isProvisioned() {
    return [...this.sql.exec(`SELECT v FROM meta WHERE k = 'provisioned_at'`)].length > 0;
  }

  // ── The operator verbs ────────────────────────────────────────────────────────────
  //
  // `B-control-plane-verbs`. Four things somebody can do TO a workspace from outside it,
  // and one property they all share: THEY NEVER CREATE ONE. Each takes its name from a URL
  // path an operator typed, and a typo that provisioned a workspace would be a workspace
  // nobody knows exists, holding a signing key and a quota row, invisible to every list.
  // So each refuses `not-provisioned` by reading `meta` the way `status()` does, before
  // `init()` is anywhere near the call.

  /**
   * Stop this workspace serving, with a reason a person wrote.
   *
   * ⚠️ SETTING THE FLAG IS NOT THE ENFORCEMENT. Nothing consults it on the request path
   * yet — that is `B-suspend-check-in-resolver`, which reads it on every resolve and
   * short-circuits before any content, login gate or publish endpoint runs. Until then a
   * suspension is a fact recorded here and reported by `status()`, and an operator reading
   * "suspended" must not conclude the site is dark.
   *
   * Re-suspending an already-suspended workspace does NOT restart the clock or replace the
   * reason, for the same reason re-freezing does not: a script that retries its first step
   * must not lose why the suspension started or when.
   */
  suspend(reason = "", at = new Date().toISOString()) {
    if (!this.hasMeta()) return { ok: false, error: "not-provisioned" };
    if (!this.isProvisioned()) return { ok: false, error: "not-provisioned" };
    const already = this.readMeta("suspended") === "1";
    if (already) {
      return { ok: true, changed: false, since: this.readMeta("suspended_at"), reason: this.readMeta("suspended_reason") };
    }
    this.writeMeta("suspended", "1");
    this.writeMeta("suspended_at", at);
    this.writeMeta("suspended_reason", String(reason || ""));
    return { ok: true, changed: true, since: at, reason: String(reason || "") };
  }

  /**
   * Let it serve again, and say how long it did not.
   *
   * The duration is returned because somebody planned around it — a customer was told
   * "back within the hour", and "about an hour" from memory is not a number. Same reason
   * `augur thaw` prints one.
   *
   * ⚠️ IT REFUSES TO RESUME A DELETED WORKSPACE. A delete suspends as part of tombstoning
   * (see `deleteWorkspace`), so resume would otherwise be an undelete that puts a
   * tombstoned workspace back on the air while its purge date still stands — a workspace
   * serving traffic with a scheduled erasure behind it. Undeleting is `restore`, which is
   * `E-gdpr-delete-tenant`'s to build, and it is a different act with a different audit line.
   */
  resume(at = new Date().toISOString()) {
    if (!this.hasMeta()) return { ok: false, error: "not-provisioned" };
    if (!this.isProvisioned()) return { ok: false, error: "not-provisioned" };
    if (this.readMeta("deleted_at")) return { ok: false, error: "deleted" };
    const since = this.readMeta("suspended_at");
    if (this.readMeta("suspended") !== "1") return { ok: true, changed: false, suspendedMs: 0 };
    for (const k of ["suspended", "suspended_at", "suspended_reason"]) this.clearMeta(k);
    const ms = since ? Math.max(0, Date.parse(at) - Date.parse(since)) : 0;
    return { ok: true, changed: true, suspendedMs: Number.isFinite(ms) ? ms : 0, since, until: at };
  }

  /**
   * Bring this workspace back because an admin just signed in — if, and ONLY if, the
   * suspension is the one the lifecycle page promises a sign-in lifts.
   *
   * `E-dormancy-resume`. The page says "Sign in. That is the whole procedure", and until
   * this existed that sentence was prose: the flag was set by an operator verb and cleared
   * by an operator verb, and no sign-in touched it.
   *
   * ── ⚠️ THIS OBJECT DECIDES THE REASON; THE WORKER DECIDES THE PERSON ────────────────
   *
   * Each side checks the half it alone can know, and neither is asked to take the other's
   * word for its own half:
   *
   *   · THE WORKER authenticated the sign-in and holds the roster, so it says who this is
   *     and what role they have. This object cannot re-derive that — a live instance still
   *     authenticates against the config roster, not against `members` — so `role` arrives
   *     as a parameter. That is not a hole: a Durable Object stub is not routable, so the
   *     only caller that can reach this is the worker that did the authenticating.
   *   · THIS OBJECT holds the live suspension row. The worker's copy comes out of a cache
   *     with a TTL, so it can be seconds stale — and a workspace suspended for dormancy at
   *     10:00:00 and re-suspended for the acceptable-use policy at 10:00:03 still reads as
   *     dormancy on the worker's copy. Reading the reason HERE, inside the single-threaded
   *     object that owns the row, is what makes that race unreachable rather than unlikely.
   *
   * ── A REFUSAL IS NOT AN ERROR ───────────────────────────────────────────────────────
   *
   * This rides a sign-in that has already succeeded, and a person must never be refused
   * entry because their workspace was not eligible to come back. So every "no" is a 200
   * carrying `{resumed: false, why}` and the caller drops it. That is the opposite of
   * `controlResult`'s rule, and deliberately: an operator verb's verdict is read off the
   * status line into an audit log, and this is not an operator verb.
   */
  resumeOnSignIn({ role = "", by = "" } = {}, at = new Date().toISOString()) {
    if (!this.hasMeta()) return { resumed: false, why: "not-provisioned" };
    if (!this.isProvisioned()) return { resumed: false, why: "not-provisioned" };
    // ⚠️ ONLY AN ADMIN. The promise is "the first successful sign-in by an admin"; an
    // editor or a viewer signing in is activity, which `touchActivity` already records, and
    // is not a decision to put the public site back on the air.
    if (role !== "admin") return { resumed: false, why: "not-an-admin" };
    // A tombstone is not a pause. `resume()` refuses one as well — this is the earlier and
    // more legible refusal, and unlike that one it does not depend on the reason column
    // still saying `deleted`.
    if (this.readMeta("deleted_at")) return { resumed: false, why: "deleted" };
    if (this.readMeta("suspended") !== "1") return { resumed: false, why: "not-suspended" };
    const reason = this.readMeta("suspended_reason") || "";
    // THE DISCRIMINATOR. See DORMANCY_SUSPENSION_REASONS for why it is an allowlist and why
    // the match is exact — a reason nobody has added is inert here, not open.
    if (!DORMANCY_SUSPENSION_REASONS.includes(reason)) {
      return { resumed: false, why: "reason-not-in-allowlist", reason };
    }
    const body = () => {
      const out = this.resume(at);
      if (!out.ok || !out.changed) return { resumed: false, why: "not-suspended" };
      // ⚠️ THE RECORD, and it has to be written here because `resume()` CLEARS the reason
      // and the date. Without these three, nothing afterwards can say the workspace was
      // ever paused or who lifted it — and "an admin signed in and the site came back" is
      // exactly the event an incident asks about a week later. A SNAPSHOT, not a log: a
      // second dormancy round trip overwrites it, because the last one is what anybody
      // needs, and a growing audit table on a request path is a different decision.
      // `by` is the one-way person id the rest of the engine stamps provenance with, never
      // an address: `status()` reads out to an operator console.
      this.writeMeta("resumed_at", at);
      this.writeMeta("resumed_from", reason);
      this.writeMeta("resumed_by", String(by || ""));
      return {
        resumed: true, why: reason, reason,
        suspendedMs: out.suspendedMs, since: out.since, until: at,
      };
    };
    // One transaction, so a half-resume — flag cleared, record missing — cannot exist.
    return this.ctx.storage.transactionSync ? this.ctx.storage.transactionSync(body) : body();
  }

  /**
   * Cut off everything this workspace has handed out, in one transaction.
   *
   * The verb for "a credential of this workspace's is in somebody else's hands and we do
   * not know which one". So it takes away BOTH kinds at once rather than offering a choice:
   * an operator who has to pick which half to rotate under that pressure will pick wrong,
   * and the cost of taking both is that people sign in again and CI re-logs-in once.
   *
   * ⚠️ ONE HALF OF THIS IS REAL TODAY AND ONE IS NOT, and the difference matters more than
   * the code:
   *
   *   · PUBLISH TOKENS — really gone. The rows are deleted, and a bearer is only ever a row.
   *   · SESSIONS — NOT YET. A session cookie HMACs on the Worker-wide `env.SESSION_SECRET`
   *     (`userToken`, src/_worker.js), not on this key, so rotating the key here invalidates
   *     nothing a browser is holding. The key has existed per workspace since provisioning
   *     precisely so that swap is a read change rather than a migration, and it belongs with
   *     putting this object on the request path (`B-cross-workspace-signin`). Until it
   *     happens, ROTATE IS NOT A SESSION KILL, and an operator responding to a compromise
   *     must reset the affected people's credentials as well — which does end their sessions,
   *     because the token binds to each person's own effective secret.
   *
   * `test/tenant-verbs.test.mjs` pins that gap rather than describing it, so the day the read
   * swaps over, the failing test is the one that tells you rotate became a session kill.
   */
  rotate(at = new Date().toISOString()) {
    if (!this.hasMeta()) return { ok: false, error: "not-provisioned" };
    if (!this.isProvisioned()) return { ok: false, error: "not-provisioned" };
    const body = () => {
      const before = [...this.sql.exec(`SELECT COUNT(*) AS n FROM publish_tokens`)][0];
      const tokens = before ? Number(before.n) : 0;
      this.sql.exec(`DELETE FROM publish_tokens`);
      const key = newSigningKey();
      this.sql.exec(
        `INSERT INTO signing_keys (purpose, key, created_at, rotated_at) VALUES ('session', ?, ?, ?)
           ON CONFLICT(purpose) DO UPDATE SET key = excluded.key, rotated_at = excluded.rotated_at`,
        key, at, at,
      );
      return { ok: true, publishTokensRevoked: tokens, rotatedAt: at, sessionsEnded: false };
    };
    return this.ctx.storage.transactionSync ? this.ctx.storage.transactionSync(body) : body();
  }

  /**
   * Tombstone this workspace and set the date its data is erased.
   *
   * ⚠️ IT DELETES NOTHING. That is the point of a tombstone: for the grace window the data
   * is all still here, so a delete somebody regrets is a support mail rather than a
   * catastrophe. Actually erasing it — the spaces this workspace owns, this object's
   * storage, dedup-safely — is `E-gdpr-delete-tenant`, and `destroy()` is the primitive it
   * uses. Which spaces those are comes from `publishedSpaces()` below, because the store's
   * keys name a space and no key in it names a workspace.
   *
   * ⚠️ A DELETE SUSPENDS, and it is the same flag rather than a second one. Otherwise
   * everything that has to refuse a dead workspace — the resolver, the publish endpoints,
   * the realtime join — would need two checks, and the second check is the one somebody
   * forgets. `reason` says which it was, so an operator reading `status()` can still tell a
   * suspension from a tombstone.
   */
  deleteWorkspace(at = new Date().toISOString(), graceMs = DELETE_GRACE_MS) {
    if (!this.hasMeta()) return { ok: false, error: "not-provisioned" };
    if (!this.isProvisioned()) return { ok: false, error: "not-provisioned" };
    const existing = this.readMeta("deleted_at");
    if (existing) {
      return { ok: true, changed: false, deletedAt: existing, purgeAfter: this.readMeta("purge_after") };
    }
    const purgeAfter = new Date(Date.parse(at) + graceMs).toISOString();
    const body = () => {
      this.writeMeta("deleted_at", at);
      this.writeMeta("purge_after", purgeAfter);
      this.writeMeta("suspended", "1");
      // ⚠️ THE REASON IS REPLACED AND THE DATE IS NOT, and the asymmetry is the point.
      // Somebody reading this workspace has to know it is a tombstone rather than a pause,
      // so "deleted" wins over whatever it was suspended for. But how long it has been dark
      // is a different fact from when it was deleted, `deleted_at` already records the
      // second, and overwriting the first would lose it: a workspace suspended for the AUP
      // at 10:00 and deleted at 12:00 has been dark since 10:00, and that is the number
      // somebody asks for. (Real workerd caught this — the first version wrote both.)
      if (!this.readMeta("suspended_at")) this.writeMeta("suspended_at", at);
      this.writeMeta("suspended_reason", "deleted");
      this.sql.exec(`DELETE FROM publish_tokens`);
      return { ok: true, changed: true, deletedAt: at, purgeAfter };
    };
    return this.ctx.storage.transactionSync ? this.ctx.storage.transactionSync(body) : body();
  }

  /**
   * This address is not this workspace's address any more.
   *
   * A workspace's hostname is the FIRST LABEL of the Host header and the resolver turns that
   * label straight into this object's name (`idFromName`), with no lookup in between and no
   * round trip in front of every request. So a workspace cannot be given a second address:
   * a different label is a different object. What "rename" means here is therefore the
   * CUT-OVER and not the move — this object stops answering at this address, permanently —
   * and moving a workspace's state to the object behind its new address is what the
   * migration machinery already does (`augur migrate`, docs/migration-freeze.md). A second,
   * silent copy of that inside a verb would be the worse of the two.
   *
   * ⚠️ IT DOES NOT RECORD WHERE THE WORKSPACE WENT, and that is the whole point rather than
   * an omission. The most common honest reason to change an address that nobody chose and
   * nobody can guess is that the current one reached somebody it should not have. A
   * forwarding pointer stored here is one JSON field away from being served, and the day it
   * is served the change has undone itself for exactly the person it was made to get away
   * from. Which address replaced which is a fact the operator's registry keeps, where the
   * people who can act on it are the only ones who can read it.
   *
   * ⚠️ IT REVOKES NOTHING. This object still holds the only copy of the workspace's roster,
   * threads and boards until something moves them, so taking away the credential an export
   * runs on at the moment the address goes dark is the trap `SUSPENDED_ALLOWED` exists to
   * avoid, one step worse. The store is reachable by anything holding the namespace binding;
   * only the public address is gone.
   *
   * ⚠️ A TOMBSTONE CANNOT BE RENAMED AWAY. A deleted workspace is already promising its
   * members a page with an erasure date on it for thirty days, and a bare 404 in its place
   * takes that page away from the people the grace window exists for.
   *
   * Idempotent: the same call twice reports the first move's timestamp and changes nothing,
   * so a control plane retrying its own step cannot restate when the address went dark.
   */
  renameAway(at = new Date().toISOString()) {
    if (!this.hasMeta()) return { ok: false, error: "not-provisioned" };
    if (!this.isProvisioned()) return { ok: false, error: "not-provisioned" };
    if (this.readMeta("deleted_at")) return { ok: false, error: "deleted" };
    const already = this.readMeta("moved_at");
    if (already) return { ok: true, changed: false, movedAt: already };
    this.writeMeta("moved_at", at);
    return { ok: true, changed: true, movedAt: at };
  }

  /**
   * Give this workspace a SECOND, chosen hostname — the canonical one — while its own
   * generated address keeps working as a redirect.
   *
   * `B-claim-platform-subdomain`. The rules, each of which is a decision and not a default:
   *
   *   · A CLAIM MAY ONLY TAKE A HOSTNAME THE LITERAL RESOLVER DOES NOT RESOLVE. On a
   *     deployment with a host suffix, `tenantLabelFromHost` is asked first and a non-null
   *     answer refuses the claim — so the alias table and the literal resolver are DISJOINT
   *     by construction. A reserved label (`demo.<suffix>`) is claimable, which is the whole
   *     point of the verb; a generated-shape label is not, because the literal resolver
   *     already resolves it, which keeps the generator's namespace clean of aliases and
   *     means an alias can never shadow or race a workspace that exists or could exist.
   *     WHO may aim this verb at a reserved name is the caller's question — the operator
   *     gate in the control plane — not this object's; the resolver's own reserved refusal
   *     for every self-service path is untouched.
   *   · THE GENERATED ADDRESS IS NOT FREED. Nothing here touches the registry or the
   *     resolver's view of this workspace's own label; the front door redirects it (see
   *     the canonicalHost read in src/_worker.js). A freed label is a label somebody else
   *     can be handed, and every link ever published to it would then resolve to a
   *     stranger's workspace — the same reasoning as RELEASE_COOLDOWN_MS.
   *   · AN EXISTING ALIAS FOR ANOTHER WORKSPACE REFUSES, never re-points. The durable
   *     compare-and-swap lives in the caller's registry (the alias row's primary key);
   *     this check is the belt on the store the resolver actually reads.
   *   · ONE CANONICAL HOSTNAME PER WORKSPACE. A second, different claim refuses rather
   *     than silently moving the front door; un-claiming is a separate decision nobody
   *     has made yet.
   *
   * Idempotent: re-claiming the SAME hostname re-writes the KV row (so a crashed claim
   * converges on retry) and reports changed: false.
   */
  async claimHostname(hostname, at = new Date().toISOString()) {
    if (!this.hasMeta()) return { ok: false, error: "not-provisioned" };
    if (!this.isProvisioned()) return { ok: false, error: "not-provisioned" };
    if (this.readMeta("deleted_at")) return { ok: false, error: "deleted" };
    const host = normalizeClaimHostname(hostname);
    if (!host) return { ok: false, error: "bad-hostname" };
    const suffix = this.env && typeof this.env.TENANT_HOST_SUFFIX === "string"
      ? this.env.TENANT_HOST_SUFFIX.trim() : "";
    // Only a deployment that resolves workspaces by hostname has an alias table to write.
    if (!suffix) return { ok: false, error: "no-host-routing" };
    // The disjointness rule. `demo.<suffix>` answers null here (reserved) and is claimable;
    // `misty-fox-123.<suffix>` answers a label and is not, whoever holds it.
    if (tenantLabelFromHost(host, suffix) !== null) {
      return { ok: false, error: "hostname-resolves-literally" };
    }
    const ws = this.workspaceId();
    if (!ws) return { ok: false, error: "not-provisioned" };
    const current = this.readMeta("canonical_host");
    if (current && current !== host) {
      return { ok: false, error: "already-claimed", canonicalHost: current };
    }
    // The store the resolver reads. Same binding the worker's kvForRaw answers with; a
    // deployment that resolves by Host always has one (the login gate depends on it).
    const kv = this.env && this.env.COMMENTS;
    if (!kv) return { ok: false, error: "no-alias-store" };
    let row = null;
    try {
      row = JSON.parse((await kv.get(hostAliasKey(host))) || "null");
    } catch (e) {
      // An unreadable store is not evidence the hostname is free. Refuse, don't guess.
      return { ok: false, error: "alias-store-unreadable" };
    }
    if (row && row.workspace && row.workspace !== ws) {
      return { ok: false, error: "alias-taken" };
    }
    await kv.put(hostAliasKey(host), JSON.stringify({ workspace: ws, at }));
    if (current === host) {
      return { ok: true, changed: false, canonicalHost: host, claimedAt: this.readMeta("canonical_host_at") };
    }
    this.writeMeta("canonical_host", host);
    this.writeMeta("canonical_host_at", at);
    return { ok: true, changed: true, canonicalHost: host, claimedAt: at };
  }

  /**
   * A verb's answer, as HTTP.
   *
   * ⚠️ A REFUSAL IS A 4xx, NOT AN `ok: false` INSIDE A 200. The control plane logs a verb's
   * verdict from the status line (`operator-route.js`), so a refusal wearing a 200 would be
   * written into the audit log as a suspension that happened. 409 rather than 404 because
   * the name was fine and the state was not — a 404 reads as "wrong URL" to whoever is
   * looking at it three months later.
   */
  controlResult(out) {
    if (out && out.ok === false) {
      return Response.json(out, { status: out.error === "not-provisioned" ? 404 : 409 });
    }
    return Response.json(out);
  }

  /**
   * Erase one person from this workspace's record of itself.
   *
   * `E-gdpr-purge-user`. The same sweep the worker's admin route runs, reachable as a
   * workspace verb — because under Decision 2 an erasure has to happen in EVERY workspace
   * the account belongs to, and only the control plane knows which those are. An erasure
   * that could only be run by somebody who happens to administer each workspace is an
   * erasure that does not happen.
   *
   * ⚠️ IT REFUSES ON AN ID COLLISION RATHER THAN OVER-REDACTING. Messages carry a 32-bit
   * one-way hash of the address, so two addresses can share one, and a sweep keyed on it
   * would redact an innocent third party. A machine cannot choose between them; this names
   * the count and stops, which turns a silent over-redaction into a question for a person.
   * The roster it checks is THIS workspace's members, including removed ones — a person
   * removed last year still has messages, and their id still collides.
   *
   * ⚠️ IT DOES NOT TOUCH MEMBERSHIP. Erasure and removal are different acts and conflating
   * them is wrong in both directions: `remove` revokes access and leaves the record, this
   * de-identifies the record and says nothing about access. A caller wanting both does both.
   */
  purgeAuthor(email, at = new Date().toISOString()) {
    if (!this.hasMeta()) return { ok: false, reason: "not-provisioned" };
    const addr = String(email || "").trim().toLowerCase();
    if (!addr) return { ok: false, reason: "bad-address" };
    const id = personIdFor(addr);

    // Every member ever, not just the active ones: a person removed last year still has
    // messages in these threads, and their id still collides.
    const everyone = [...this.sql.exec(`SELECT email FROM members`)];
    const clashes = idCollisions(everyone, addr);
    if (clashes.length) return { ok: false, reason: "id-collision", id, collidesWith: clashes.length };

    // ONE TRANSACTION over the whole sweep. A half-finished erasure is the worst outcome
    // here: some pages redacted, some not, and a caller that reports success either way. The
    // handler is single-threaded so nothing interleaves, and the transaction is what makes a
    // throw mid-sweep leave the record as it was rather than partly rewritten.
    const body = () => {
      let redacted = 0, scanned = 0;
      const pathsTouched = [];
      const rows = [...this.sql.exec(
        `SELECT scope, k, v, rev FROM overlay WHERE family = 'comments'`,
      )];
      for (const row of rows) {
        scanned++;
        let threads = null;
        try { threads = JSON.parse(row.v); } catch (e) { continue; }
        const res = purgeThreads(threads, id);
        if (!res.redacted) continue;
        // `rev` is bumped so anything holding an older revision of this page loses its
        // compare-and-swap and re-reads, rather than writing the un-redacted copy back.
        this.sql.exec(
          `UPDATE overlay SET v = ?3, at = ?4, rev = rev + 1
            WHERE family = 'comments' AND scope = ?1 AND k = ?2`,
          row.scope, row.k, JSON.stringify(res.threads), at,
        );
        redacted += res.redacted;
        pathsTouched.push(row.k);
      }
      // The lastseen stamp is an address in a KEY, so it is erased rather than redacted.
      this.sql.exec(`DELETE FROM lastseen WHERE email = ?`, addr);
      return { ok: true, id, redacted, scanned, pathsTouched };
    };
    return this.ctx.storage.transactionSync ? this.ctx.storage.transactionSync(body) : body();
  }

  /**
   * Is this workspace paused, and why — three rows and nothing else.
   *
   * ⚠️ SEPARATE FROM `status()` ON PURPOSE. This one is on the REQUEST PATH: the front door
   * asks it before serving anything (`B-suspend-check-in-resolver`), so it must stay three
   * indexed reads. `status()` counts members, invites, threads, boards and images and asks
   * `dbstat` for a page total — fine for an operator console, absurd behind every page view.
   * If a field is ever wanted here, weigh it against being run on every request of every
   * workspace, not against how useful it would be on a dashboard.
   *
   * A workspace that does not exist answers `suspended: false`, the same as a live one.
   * Whether the name means anything is the front door's other question and this is not it —
   * and it must not create the workspace to find out, so nothing here calls `init()`.
   */
  suspension() {
    if (!this.hasMeta()) {
      return { suspended: false, reason: null, at: null, deleted: false, moved: false, canonicalHost: null };
    }
    return {
      suspended: this.readMeta("suspended") === "1",
      reason: this.readMeta("suspended_reason"),
      at: this.readMeta("suspended_at"),
      deleted: !!this.readMeta("deleted_at"),
      // ⚠️ A BOOLEAN, NOT THE NEW ADDRESS. This answer travels to the front door on every
      // request; the new address must not, or the old hostname becomes the way to find it.
      // See renameAway.
      moved: !!this.readMeta("moved_at"),
      // ⚠️ AND THIS ONE IS THE ADDRESS, DELIBERATELY — the opposite decision from `moved`,
      // for the opposite reason. A rename hides where the workspace went; a claim exists to
      // ADVERTISE it: the generated address keeps working precisely so every old link can be
      // walked to the canonical one, and the front door needs the destination to do it.
      // Riding this answer keeps the redirect free — the front door already pays this read.
      canonicalHost: this.readMeta("canonical_host") || null,
    };
  }

  /** Is the `meta` table there at all? The question `status()` asks, for the same reason. */
  hasMeta() {
    return [...this.sql.exec(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'`,
    )].length > 0;
  }

  readMeta(k) {
    const rows = [...this.sql.exec(`SELECT v FROM meta WHERE k = ?`, k)];
    return rows.length ? rows[0].v : null;
  }

  writeMeta(k, v) {
    this.sql.exec(
      `INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, k, String(v),
    );
  }

  clearMeta(k) {
    this.sql.exec(`DELETE FROM meta WHERE k = ?`, k);
  }

  /**
   * This workspace's session-signing key, or null before it is provisioned.
   *
   * Nothing in the request path reads this yet — `userToken()` still uses the Worker-wide
   * `env.SESSION_SECRET`, and moving it over belongs with putting the object in the
   * request path at all. What provisioning buys today is that the key EXISTS per
   * workspace from the first moment, so that move is a read swap and not a migration of
   * every live session.
   */
  sessionKey() {
    const rows = [...this.sql.exec(`SELECT key FROM signing_keys WHERE purpose = 'session'`)];
    return rows.length ? rows[0].key : null;
  }

  /** The admins and editors and viewers who have not been removed. */
  members() {
    return [...this.sql.exec(
      `SELECT email, role, name FROM members WHERE removed_at IS NULL ORDER BY added_at`,
    )];
  }

  // ── the identity families the request path now READS from here ─────────────
  //
  // `B-kv-read-cutover`. `B-kv-to-do-migration-tool` gave these tables a write path and
  // nothing that read it. These are the reads, and each is the shape ONE accessor in the
  // worker wants — a verb no call site asks for is a verb whose semantics nobody has
  // thought about, which is the rule the overlay verbs above already follow.
  //
  // ⚠️ AN INVITE'S EXPIRY IS READ TOLERANTLY AND WRITTEN STRICTLY. The column is TEXT
  // holding an ISO stamp, and that is what everything here writes. But the COPY that
  // filled this table from KV wrote what KV held, and KV holds epoch milliseconds — a
  // number, stringified, which `Date.parse` answers `NaN` for. A strict read would
  // therefore have called every invite carried across by a copy invalid, silently, and
  // the first anyone would know is somebody clicking a link that has not expired. So
  // `stampMs` accepts both, and `src/kv-identity.mjs` no longer produces the second.

  /**
   * An invite by its token HASH, or null if there is no live one.
   *
   * The raw token never reaches this object — see `inviteHash` in src/_worker.js. That is
   * the same contract the copy hashes on, so a link minted before the reads moved resolves
   * after them.
   */
  inviteRead(tokenHash, nowMs = Date.now()) {
    if (!tokenHash) return null;
    const rows = [...this.sql.exec(
      `SELECT email, expires_at FROM invites WHERE token_hash = ?`, String(tokenHash),
    )];
    if (!rows.length) return null;
    const exp = stampMs(rows[0].expires_at);
    if (exp === null || exp <= nowMs) return null;
    return rows[0].email;
  }

  /**
   * Resolve and burn an invite in ONE act.
   *
   * KV could only narrow this race — it has no compare-and-swap, so two redemptions could
   * both read before either wrote. A Durable Object is single-threaded, so the read and the
   * delete here cannot interleave and the second caller gets null. The comment on
   * `consumeInvite` in the worker describes the window this closes.
   */
  inviteConsume(tokenHash, nowMs = Date.now()) {
    const email = this.inviteRead(tokenHash, nowMs);
    if (email === null) return null;
    this.sql.exec(`DELETE FROM invites WHERE token_hash = ?`, String(tokenHash));
    return email;
  }

  /**
   * Record an invitation, dropping every outstanding one for the same address first.
   *
   * Issuing invalidates a person's other links, so there is never more than one — the rule
   * the KV path already holds, and for the same reason: two live links for one person is
   * two ways in when somebody was handed one.
   */
  inviteMint({ tokenHash, email, createdAt, expiresAt, createdBy = null }, nowMs = Date.now()) {
    if (!tokenHash || !email) return { ok: false };
    const at = new Date(nowMs).toISOString();
    this.inviteRevoke(email);
    this.sql.exec(
      `INSERT INTO invites (token_hash, email, created_at, expires_at, created_by)
         VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT(token_hash) DO UPDATE SET email = ?2, created_at = ?3, expires_at = ?4, created_by = ?5`,
      String(tokenHash), lcAddr(email), createdAt || at, expiresAt || at, createdBy ?? null,
    );
    return { ok: true };
  }

  /** Drop every outstanding invite for one address. Removal needs this without minting. */
  inviteRevoke(email) {
    if (!email) return { dropped: 0 };
    const rows = [...this.sql.exec(
      `DELETE FROM invites WHERE email = ? RETURNING token_hash`, lcAddr(email),
    )];
    return { dropped: rows.length };
  }

  /** Every last-connection stamp, as the `{address: iso}` map the admin list reads. */
  lastseenRead() {
    const out = {};
    for (const row of this.sql.exec(`SELECT email, at FROM lastseen`)) out[row.email] = row.at;
    return out;
  }

  /**
   * Stamp a person as seen, unless the stored stamp is still fresh.
   *
   * The throttle lives HERE rather than at the call site, and that is the difference the
   * move buys: KV had to read the stamp and then write it, two round trips and a race
   * between them. One call now answers whether it wrote.
   */
  lastseenTouch(email, throttleMs = 15 * 60 * 1000, nowMs = Date.now()) {
    if (!email) return { wrote: false };
    const addr = lcAddr(email);
    const rows = [...this.sql.exec(`SELECT at FROM lastseen WHERE email = ?`, addr)];
    if (rows.length) {
      const prev = stampMs(rows[0].at);
      if (prev !== null && nowMs - prev < throttleMs) return { wrote: false };
    }
    const at = new Date(nowMs).toISOString();
    this.sql.exec(
      `INSERT INTO lastseen (email, at) VALUES (?1,?2) ON CONFLICT(email) DO UPDATE SET at = ?2`,
      addr, at,
    );
    return { wrote: true, at };
  }

  // ── the roster overlay: four KV documents, one table, one round trip ───────
  //
  // ⚠️ WHAT THESE ANSWER WITH IS THE FOUR KV DOCUMENTS, NOT A ROSTER. `users:roster`,
  // `users:roles`, `users:names` and `users:avatars`, spelled exactly as KV spells them,
  // so `mergeRoster`/`applyRoles`/`applyNames`/`applyAvatars` in src/_worker.js run on
  // identical input either way. The serving pipeline is then not two pipelines that have
  // to be kept in agreement — it is one, fed from whichever store holds the documents,
  // which is what makes "the two answers are identical" a property rather than a hope.
  //
  // Six KV gets per workspace per sixty-second tick become this one call. That read volume
  // — the site's dominant KV consumer, enough to exhaust a day's `get()` budget and take
  // every KV-touching route down with it — is why this item was urgent rather than tidy.

  /** The four roster documents, as KV holds them, plus whether this object may be believed. */
  rosterRead() {
    const seeded = isSeeded(this.sql, "roster");
    const add = {};
    const remove = [];
    const roles = {};
    const names = {};
    const avatars = {};
    for (const row of this.sql.exec(
      `SELECT email, role, name, initials, colour, added_at, added_by, removed_at,
              source, name_overlay, role_overlay, avatar_key, avatar_mime, avatar_at
         FROM members ORDER BY added_at, email`,
    )) {
      const e = String(row.email);
      // A TOMBSTONE IS THE `remove` LIST. Every removed row lands there, including one for
      // somebody the config file never named — `mergeRoster` filters the config list by it,
      // so naming an address the file does not carry costs nothing and dropping the row
      // instead would let a re-invite inherit the last holder's role.
      if (row.removed_at != null) remove.push(e);
      else if (row.source === "overlay") {
        // An `add` entry, spelled the way `adminUsersApi`'s invite writes one. `color` and
        // not `colour`: the column is the schema's spelling and this is the document's, and
        // the translation belongs at exactly one edge.
        const rec = { email: e, addedAt: row.added_at };
        if (row.name != null) rec.name = row.name;
        if (row.role != null) rec.role = row.role;
        if (row.initials != null) rec.initials = row.initials;
        if (row.colour != null) rec.color = row.colour;
        if (row.added_by != null) rec.addedBy = row.added_by;
        add[e] = rec;
      }
      if (row.role_overlay != null) roles[e] = row.role_overlay;
      if (row.name_overlay != null) {
        // ⚠️ TWO SHAPES, BOTH LIVE, AND ONLY ONE OF THEM IS HONOURED. `users:names` holds
        // `{name, at}` today and a bare string on instances that have not written a name
        // since the shape changed — and `applyNames` reads `rec.name`, so it applies the
        // first and IGNORES the second. Normalising a bare string into an object here would
        // therefore start showing a display name the KV path does not, on exactly the oldest
        // instances. The column holds the document's own JSON so the shape survives the
        // round trip and neither path invents an answer the other would not give.
        try { names[e] = JSON.parse(row.name_overlay); } catch (err) { /* a corrupt row is not a corrupt map */ }
      }
      if (row.avatar_key != null) {
        avatars[e] = { k: row.avatar_key, mime: row.avatar_mime ?? null, at: row.avatar_at ?? null };
      }
    }
    return { seeded, roster: { add, remove }, roles, names, avatars };
  }

  /**
   * Write whichever of the four documents the caller is holding.
   *
   * ⚠️ IT TAKES THE WHOLE DOCUMENT, because that is what the KV path computes and what the
   * straddle has to mirror. Per-key rows are what the content overlay moved to and what
   * this table will move to when KV is gone; while both stores are live the document is the
   * unit, and a mirror written key-by-key from a document the other store wrote whole would
   * diverge the moment a key was deleted rather than changed.
   *
   * `configUsers` is the durable half and is not optional in practice: an overlay entry can
   * name somebody this object has no row for — a display name set by a config user on a
   * workspace whose copy has not run — and `members.role` is NOT NULL, so there is no
   * honest row to invent for them. Passing the config roster means the row is seeded from
   * the record rather than from a guess.
   */
  rosterWrite({ configUsers = null, roster = null, roles = null, names = null, avatars = null } = {}, nowMs = Date.now()) {
    const at = new Date(nowMs).toISOString();
    const wrote = [];
    const body = () => {
      if (Array.isArray(configUsers)) {
        for (const u of configUsers) {
          const e = lcAddr(u && u.email);
          if (!e) continue;
          const role = MEMBER_ROLES.includes(u.role) ? u.role : "editor";
          this.sql.exec(
            `INSERT INTO members (email, role, name, added_at, initials, colour, source)
               VALUES (?1,?2,?3,?4,?5,?6,'config')
               ON CONFLICT(email) DO UPDATE SET
                 role = ?2, name = ?3, initials = ?5, colour = ?6, source = 'config'`,
            e, role, u.name ?? null, u.addedAt || at, u.initials ?? null, u.color ?? null,
          );
        }
        wrote.push("configUsers");
      }

      if (roster && typeof roster === "object") {
        const add = roster.add && typeof roster.add === "object" ? roster.add : {};
        const removed = new Set((Array.isArray(roster.remove) ? roster.remove : []).map(lcAddr).filter(Boolean));
        const added = new Set();
        for (const rec of Object.values(add)) {
          const e = lcAddr(rec && rec.email);
          if (!e) continue;
          added.add(e);
          const role = MEMBER_ROLES.includes(rec.role) ? rec.role : "editor";
          // `source` is set on INSERT only. An address the config file also names keeps
          // 'config', which is the precedence `mergeRoster` applies: the file wins, and an
          // `add` entry for somebody it names has already stopped taking effect.
          this.sql.exec(
            `INSERT INTO members (email, role, name, added_at, initials, colour, added_by, source, removed_at)
               VALUES (?1,?2,?3,?4,?5,?6,?7,'overlay',NULL)
               ON CONFLICT(email) DO UPDATE SET
                 role = ?2, name = ?3, added_at = ?4, initials = ?5, colour = ?6, added_by = ?7,
                 removed_at = NULL`,
            e, role, rec.name ?? null, rec.addedAt || at, rec.initials ?? null,
            rec.color ?? null, rec.addedBy ?? null,
          );
        }
        for (const e of removed) {
          this.sql.exec(
            `INSERT INTO members (email, role, added_at, removed_at, source)
               VALUES (?1,'viewer',?2,?2,'config')
               ON CONFLICT(email) DO UPDATE SET removed_at = COALESCE(members.removed_at, ?2)`,
            e, at,
          );
        }
        // An INVITED person's removal deletes their `add` entry and writes NO tombstone —
        // the KV list is only for addresses the config file names, and an unbounded one
        // would grow forever. Here they become a tombstone anyway: `mergeRoster` filters
        // the CONFIG list by `remove`, so naming somebody the file does not carry changes
        // no answer, and the row is what stops a re-invite inheriting their role.
        const orphans = [...this.sql.exec(
          `SELECT email FROM members WHERE source = 'overlay' AND removed_at IS NULL`,
        )].map((r) => String(r.email)).filter((e) => !added.has(e));
        for (const e of orphans) {
          this.sql.exec(`UPDATE members SET removed_at = ? WHERE email = ?`, at, e);
        }
        // …and the other direction: a config user the file has caught up with drops out of
        // `remove`, and the tombstone has to go with it or they stay hidden forever. Only
        // 'config' rows, so the orphan tombstones above are not undone by their own absence.
        for (const row of this.sql.exec(
          `SELECT email FROM members WHERE source = 'config' AND removed_at IS NOT NULL`,
        )) {
          if (!removed.has(String(row.email))) {
            this.sql.exec(`UPDATE members SET removed_at = NULL WHERE email = ?`, String(row.email));
          }
        }
        wrote.push("roster");
      }

      // The three flat overlays. Each is REPLACED, not merged: the KV document is written
      // whole, so a key that has gone from it has been cleared and a merge would resurrect it.
      const flat = (doc, column, encode) => {
        this.sql.exec(`UPDATE members SET ${column} = NULL WHERE ${column} IS NOT NULL`);
        for (const [key, value] of Object.entries(doc)) {
          const e = lcAddr(key);
          if (!e || value === null || value === undefined) continue;
          const v = encode(value);
          if (v === null) continue;
          const hit = [...this.sql.exec(
            `UPDATE members SET ${column} = ?2 WHERE email = ?1 RETURNING email`, e, v,
          )];
          // An overlay entry for somebody with no row is not dropped: `applyRoles` and
          // `applyNames` are asked about the MERGED roster, which includes config users this
          // object may not have been told about yet. The row is a carrier, and `source` says
          // so — 'config' means the durable half of it is elsewhere.
          if (!hit.length) {
            this.sql.exec(
              `INSERT INTO members (email, role, added_at, source, ${column})
                 VALUES (?1,'viewer',?2,'config',?3) ON CONFLICT(email) DO NOTHING`,
              e, at, v,
            );
          }
        }
      };
      if (roles && typeof roles === "object") {
        flat(roles, "role_overlay", (v) => (typeof v === "string" && v ? v : null));
        wrote.push("roles");
      }
      if (names && typeof names === "object") {
        flat(names, "name_overlay", (v) => JSON.stringify(v));
        wrote.push("names");
      }
      if (avatars && typeof avatars === "object") {
        this.sql.exec(`UPDATE members SET avatar_key = NULL, avatar_mime = NULL, avatar_at = NULL
                         WHERE avatar_key IS NOT NULL`);
        for (const [key, rec] of Object.entries(avatars)) {
          const e = lcAddr(key);
          if (!e || !rec || typeof rec !== "object" || typeof rec.k !== "string") continue;
          const hit = [...this.sql.exec(
            `UPDATE members SET avatar_key = ?2, avatar_mime = ?3, avatar_at = ?4
               WHERE email = ?1 RETURNING email`,
            e, rec.k, rec.mime ?? null, rec.at ?? null,
          )];
          if (!hit.length) {
            this.sql.exec(
              `INSERT INTO members (email, role, added_at, source, avatar_key, avatar_mime, avatar_at)
                 VALUES (?1,'viewer',?2,'config',?3,?4,?5) ON CONFLICT(email) DO NOTHING`,
              e, at, rec.k, rec.mime ?? null, rec.at ?? null,
            );
          }
        }
        wrote.push("avatars");
      }
      markSeeded(this.sql, "roster", at);
    };
    // One transaction: four documents describing one roster, half-written, is the state
    // `importAll` refuses to leave behind and this must refuse it for the same reason.
    if (typeof this.ctx.storage.transactionSync === "function") this.ctx.storage.transactionSync(body);
    else body();
    return { wrote };
  }

  // ── publish tokens ─────────────────────────────────────────────────────────

  /**
   * One token by its hash, or null when this object cannot answer for it.
   *
   * NULL MEANS TWO THINGS AND BOTH ARE "ASK KV": no such row, or a row that cannot state one
   * of the two authorization fields — a pre-`scope` copy, or a pre-`caps` one. Such a row
   * knows the token exists and not what it may do. Answering from here would have to invent
   * the missing half, and every available invention is wrong: `*` widens a space-scoped token
   * to admin-equivalent, a space id refuses a star one, and "no caps" turns the control
   * plane's purge-only bearer into a credential that can publish over every workspace.
   */
  publishTokenRead(tokenHash) {
    if (!tokenHash) return null;
    const rows = [...this.sql.exec(
      `SELECT token_hash, label, created_at, expires_at, scope, caps FROM publish_tokens
         WHERE token_hash = ?`, String(tokenHash),
    )];
    if (!rows.length || rows[0].scope == null) return null;
    const caps = capsValue(rows[0].caps);
    if (caps === undefined) return null;
    const entry = {
      space: String(rows[0].scope), label: rows[0].label ?? null,
      createdAt: rows[0].created_at, expiresAt: rows[0].expires_at ?? null,
    };
    // Spelled the way KV spells it: an unrestricted token has NO `caps` key at all, which is
    // the shape `capabilityRefusal` reads as unrestricted. A `null` column value states that
    // absence rather than being carried through as a field holding null.
    if (caps !== null) entry.caps = caps;
    return entry;
  }

  /** Every token as the `{hash: {space,label,createdAt,expiresAt,caps?}}` map the panel lists. */
  publishTokenList() {
    const out = {};
    for (const row of this.sql.exec(
      `SELECT token_hash, label, created_at, expires_at, scope, caps FROM publish_tokens`,
    )) {
      if (row.scope == null) continue;
      const rec = { space: String(row.scope), label: row.label ?? null, createdAt: row.created_at };
      if (row.expires_at != null) rec.expiresAt = row.expires_at;
      // The panel shows the union of both stores with these rows winning, so a list that
      // dropped the field would show an operator a narrow credential as a full one.
      const caps = capsValue(row.caps);
      if (caps !== undefined && caps !== null) rec.caps = caps;
      out[String(row.token_hash)] = rec;
    }
    return { seeded: isSeeded(this.sql, "publishTokens"), tokens: out };
  }

  /**
   * Record a minted token. The raw token never reaches this object — only its hash.
   *
   * `caps` DEFAULTS TO `null` AND NOT TO UNKNOWN, deliberately. Every mint the engine has is
   * a mint of an unrestricted token, and that is a fact this object may state — leaving the
   * column empty instead would send every read on a cut deployment back to KV, which is the
   * read volume this family moved to get away from. A caller minting a restricted token
   * passes the list; there is no such caller yet, and a capability nothing can mint is a
   * capability that does not exist.
   */
  publishTokenMint({ tokenHash, space, label = null, createdAt = null, expiresAt = null, caps = null }, nowMs = Date.now()) {
    if (!tokenHash || space == null) return { ok: false };
    const at = new Date(nowMs).toISOString();
    this.sql.exec(
      `INSERT INTO publish_tokens (token_hash, label, created_at, expires_at, scope, caps)
         VALUES (?1,?2,?3,?4,?5,?6)
         ON CONFLICT(token_hash) DO UPDATE SET label = ?2, created_at = ?3, expires_at = ?4,
           scope = ?5, caps = ?6`,
      String(tokenHash), label, createdAt || at, expiresAt ?? null, String(space), capsColumn(caps),
    );
    markSeeded(this.sql, "publishTokens", at);
    return { ok: true };
  }

  /**
   * Revoke by hash, or every token one person holds.
   *
   * By LABEL is not a convenience: `augur login` labels a token with the holder's address,
   * and removing or demoting somebody has to drop the tokens that outlived their role. A
   * revocation that missed this store would leave the credential live on the other one.
   */
  publishTokenRevoke({ tokenHash = null, label = null } = {}) {
    if (tokenHash) {
      const rows = [...this.sql.exec(
        `DELETE FROM publish_tokens WHERE token_hash = ? RETURNING token_hash`, String(tokenHash),
      )];
      return { dropped: rows.length };
    }
    if (label) {
      const rows = [...this.sql.exec(
        `DELETE FROM publish_tokens WHERE LOWER(label) = ? RETURNING token_hash`, lcAddr(label),
      )];
      return { dropped: rows.length };
    }
    return { dropped: 0 };
  }

  /** Forget one person's last connection — what removal and purge do to their row. */
  lastseenForget(email) {
    if (!email) return { dropped: 0 };
    const rows = [...this.sql.exec(
      `DELETE FROM lastseen WHERE email = ? RETURNING email`, lcAddr(email),
    )];
    return { dropped: rows.length };
  }

  /** Whether this workspace has anybody in it — the gate's "is the roster on" question. */
  usersActive() {
    return this.members().length > 0;
  }

  /**
   * Issue the next publish version for a space. Atomic: one statement, one object, one
   * thread.
   *
   * `floor` is the version the STORE currently holds, and it is what makes adopting this
   * safe on a workspace that has been publishing for months. The counter starts empty, so
   * without a floor the first issue would be 1 and would overwrite `versions/1.json` — the
   * exact history destruction this exists to prevent. With it, the first issue is
   * `live + 1` and every later one comes from the counter alone.
   *
   * It is a MAX rather than a trust: once the counter is ahead (a number issued for a
   * commit that then failed), a stale floor from a slow R2 read cannot drag it back.
   */
  nextPublishVersion(space, floor = 0) {
    const f = Number.isFinite(floor) && floor > 0 ? Math.floor(floor) : 0;
    const rows = [...this.sql.exec(
      `INSERT INTO publish_versions (space, version) VALUES (?1, ?2 + 1)
         ON CONFLICT(space) DO UPDATE SET version = MAX(publish_versions.version, ?2) + 1
       RETURNING version`,
      String(space), f,
    )];
    return rows.length ? Number(rows[0].version) : null;
  }

  /**
   * WHICH SPACES ARE THIS WORKSPACE'S, and the only record of it that exists.
   *
   * `spaces/<spaceId>/…` in the bundle store names a SPACE. Nothing in that key names a
   * workspace, and two workspaces may publish a space under the same id, so no listing of
   * that bucket can say whose anything is. This table can: a row lands here only when a
   * publish addressed to THIS object asked it for a version number, and a Durable Object's
   * storage belongs to its id — there is no key constructible in one workspace that writes
   * a row in another. That is the same reason the counter is here in the first place.
   *
   * ⚠️ IT IS AUTHORITATIVE, NOT PROVABLY COMPLETE. Content published before this
   * deployment bound the workspace objects went through `nextPublishVersion`'s no-object
   * branch and left no row, so an empty answer means "this workspace has issued no publish
   * version", never "this workspace owns nothing". The caller has to treat those two
   * differently, and `deleteWorkspace` does.
   *
   * NO init(), for `status()`'s reason: asking what a workspace holds must not bring one
   * into being. A workspace with no schema answers with an empty list and says it is not
   * provisioned, which is exactly what it can honestly say.
   */
  publishedSpaces() {
    if (!this.hasMeta()) return { provisioned: false, spaces: [] };
    const rows = [...this.sql.exec(`SELECT space FROM publish_versions ORDER BY space`)];
    return { provisioned: this.isProvisioned(), spaces: rows.map((r) => String(r.space)) };
  }

  // ── the content overlay ────────────────────────────────────────────────────
  // Four verbs, each the shape one of the four families actually needs. Reading them
  // together: `read` is what a page load does, `set` is a single edit, `insert` is a
  // create that must not clobber, and `replace` is a family whose client owns the whole
  // map. Nothing here is generic for its own sake — a verb that no call site wants is a
  // verb whose semantics nobody has thought about.

  /** The whole family as a plain `{key: value}` map, JSON decoded. */
  overlayRead(family, scope = "") {
    const out = {};
    for (const row of this.sql.exec(
      `SELECT k, v FROM overlay WHERE family = ? AND scope = ?`, String(family), String(scope),
    )) {
      try { out[row.k] = JSON.parse(row.v); } catch (e) { /* a corrupt row is not a corrupt map */ }
    }
    return out;
  }

  /**
   * Every scope a family holds rows under, including the empty one.
   *
   * THE ONE READ AN EXPORT NEEDS AND NO PAGE DOES. A scoped family — `pins`, whose scope is
   * the address a sidebar belongs to — is a set of maps, and every other verb here answers
   * about ONE scope because every other caller already knows which one it wants: a page load
   * is one person's. A COPY does not know, and there is no other way to find out from
   * outside: on the KV backing the scopes are visible as a key prefix, and here they are
   * rows in a column nothing could list. Without this a backup of a workspace on this
   * backing omits every person's sidebar and reports itself complete.
   */
  overlayScopes(family) {
    return [...this.sql.exec(
      `SELECT DISTINCT scope FROM overlay WHERE family = ? ORDER BY scope`, String(family),
    )].map((row) => String(row.scope));
  }

  /**
   * Set or clear ONE key. `null` clears — the same signal the KV path uses, where an empty
   * name means "revert to the build default".
   *
   * This is the verb the whole item is about: two edits to different keys are two rows and
   * cannot lose each other, where the KV document they replace lost one every time they
   * landed together.
   */
  overlaySet(family, scope, k, v, at, owner) {
    if (v === null || v === undefined) {
      this.sql.exec(`DELETE FROM overlay WHERE family = ? AND scope = ? AND k = ?`,
        String(family), String(scope), String(k));
      return null;
    }
    // The owner is set on INSERT and left alone on UPDATE. Whoever made a board owns it;
    // whoever saved it last does not, and `COALESCE` is what makes that true without the
    // caller having to know whether the row already existed.
    this.sql.exec(
      `INSERT INTO overlay (family, scope, k, v, at, owner) VALUES (?1,?2,?3,?4,?5,?6)
         ON CONFLICT(family, scope, k) DO UPDATE SET
           v = excluded.v, at = excluded.at, owner = COALESCE(overlay.owner, ?6)`,
      String(family), String(scope), String(k), JSON.stringify(v),
      at || new Date().toISOString(), owner ? String(owner) : null,
    );
    return v;
  }

  /** Who owns a row, and any per-resource ACL on it. Read by nothing yet, on purpose. */
  overlayOwner(family, scope, k) {
    const rows = [...this.sql.exec(
      `SELECT owner, acl FROM overlay WHERE family = ? AND scope = ? AND k = ?`,
      String(family), String(scope), String(k),
    )];
    if (!rows.length) return null;
    let acl = null;
    try { acl = rows[0].acl ? JSON.parse(rows[0].acl) : null; } catch (e) { acl = null; }
    return { owner: rows[0].owner || null, acl };
  }

  /** One key's value AND the revision it is at, so a caller can write it back safely. */
  overlayReadRev(family, scope, k) {
    const rows = [...this.sql.exec(
      `SELECT v, rev FROM overlay WHERE family = ? AND scope = ? AND k = ?`,
      String(family), String(scope), String(k),
    )];
    if (!rows.length) return { v: null, rev: 0 };
    try { return { v: JSON.parse(rows[0].v), rev: Number(rows[0].rev) }; }
    catch (e) { return { v: null, rev: Number(rows[0].rev) }; }
  }

  /**
   * Write a key only if it is still at the revision the caller read. Returns the new rev,
   * or null when somebody else got there first.
   *
   * This is the verb for a value that is a DOCUMENT — a page's comment threads, a board's
   * nodes — where the worker reads it, changes part of it and writes the whole thing back.
   * Per-key rows do not help there: two edits to ONE key still lose each other. Matching on
   * the revision turns "one of these two ops vanished" into "one of them retried".
   *
   * `rev 0` means "I expect this key to be absent", so a create races correctly too.
   */
  overlayCas(family, scope, k, v, expectedRev, at) {
    const stamp = at || new Date().toISOString();
    const rows = [...this.sql.exec(
      `INSERT INTO overlay (family, scope, k, v, rev, at) VALUES (?1, ?2, ?3, ?4, 1, ?6)
         ON CONFLICT(family, scope, k) DO UPDATE SET v = ?4, rev = overlay.rev + 1, at = ?6
           WHERE overlay.rev = ?5
       RETURNING rev`,
      String(family), String(scope), String(k), JSON.stringify(v), Number(expectedRev) || 0, stamp,
    )];
    return rows.length ? Number(rows[0].rev) : null;
  }

  /**
   * Create a key only if it is absent, and say which happened.
   *
   * Creating a board reads the map, checks the slug is free, then writes — so two creates
   * of one name both pass the check and the second silently takes the first's board. One
   * statement in one object cannot.
   */
  overlayInsert(family, scope, k, v, at, owner) {
    const rows = [...this.sql.exec(
      `INSERT INTO overlay (family, scope, k, v, at, owner) VALUES (?,?,?,?,?,?)
         ON CONFLICT(family, scope, k) DO NOTHING
       RETURNING k`,
      String(family), String(scope), String(k), JSON.stringify(v),
      at || new Date().toISOString(), owner ? String(owner) : null,
    )];
    return rows.length > 0;
  }

  /**
   * Replace a whole family for one scope, atomically.
   *
   * For the family whose client owns the complete map — pins, where adding, removing and
   * reordering all produce a new full map. Delete-then-insert inside a transaction, so a
   * reader never sees the gap between the two.
   */
  overlayReplace(family, scope, map, at) {
    const body = () => {
      this.sql.exec(`DELETE FROM overlay WHERE family = ? AND scope = ?`, String(family), String(scope));
      // Note the asymmetry with the KV backing, which cannot delete what a document does
      // not mention without a listing: here the family IS the rows, so a replace really
      // replaces. Both are right for their store, and a restore that means to remove
      // something has to say so rather than relying on either.
      const stamp = at || new Date().toISOString();
      for (const [k, v] of Object.entries(map || {})) {
        this.sql.exec(`INSERT INTO overlay (family, scope, k, v, at) VALUES (?,?,?,?,?)`,
          String(family), String(scope), String(k), JSON.stringify(v), stamp);
      }
    };
    if (this.ctx.storage.transactionSync) this.ctx.storage.transactionSync(body);
    else body();
    return map || {};
  }

  // ── quota counters ─────────────────────────────────────────────────────────

  /**
   * Add to a counter and say whether it is still under its ceiling — in one statement, so
   * two requests arriving together cannot both read the same number and both be let past.
   *
   * `window` is what makes this cheap: the row carries the bucket its count belongs to, so
   * a new minute or a new day resets it on the next bump rather than needing anything to
   * sweep. A ceiling of 0 or less means unlimited, matching the quota table's own rule that
   * unlimited is a number rather than an absence.
   */
  bumpCounter(k, window, by, ceiling) {
    const rows = [...this.sql.exec(
      `INSERT INTO counters (k, window, n) VALUES (?1, ?2, ?3)
         ON CONFLICT(k) DO UPDATE SET
           n = CASE WHEN counters.window = ?2 THEN counters.n + ?3 ELSE ?3 END,
           window = ?2
       RETURNING n`,
      String(k), String(window), Number(by) || 0,
    )];
    const n = rows.length ? Number(rows[0].n) : 0;
    const limit = Number(ceiling);
    return { n, limit, allowed: !Number.isFinite(limit) || limit <= 0 || n <= limit };
  }

  /** What a counter stands at, without touching it. */
  readCounter(k) {
    const rows = [...this.sql.exec(`SELECT window, n FROM counters WHERE k = ?`, String(k))];
    return rows.length ? { window: rows[0].window, n: Number(rows[0].n) } : { window: null, n: 0 };
  }

  /**
   * Write a whole snapshot of the overlay in ONE transaction.
   *
   * `MIG-do-import-endpoint`. Every other write path in this codebase is a
   * read-modify-write: read a document, change part of it, put it back. That is survivable
   * for one edit and wrong for a restore, where a failure halfway leaves a workspace with
   * some families from the copy and some from whatever was there before — a state that
   * matches no backup and no moment in time, and that nobody can tell apart from a
   * successful restore by looking.
   *
   * So it is all of it or none of it. `transactionSync` gives that for free inside a
   * Durable Object; a runtime without one gets the same ORDER but not the same guarantee,
   * and says so to its caller rather than pretending.
   *
   * The bundle is `{family: {scope: {key: value}}}` — DO families, not KV document names.
   * Translating one to the other is the worker's job: this object has never needed to know
   * what anything was called in KV, and a restore is a poor moment to teach it.
   */
  importOverlay(bundle, at, prune = false) {
    return this.importAll({ overlay: bundle, at, prune });
  }

  /**
   * The overlay AND the identity families, in ONE transaction.
   *
   * `B-kv-to-do-migration-tool`. Splitting these into two calls would put the exact seam
   * back that `importOverlay` exists to remove: a workspace holding its content from the
   * copy and its roster from before it is a state matching no moment in time, and the
   * roster is the half that decides who can get in.
   *
   * ⚠️ TWO KINDS OF BAD ROW, TREATED DIFFERENTLY ON PURPOSE. A role KV does not recognise
   * is a value the SOURCE can legitimately hold — `users:roles` is a free-text map and
   * `members.role` has a CHECK constraint — so it is refused by name and the copy carries
   * on, because one odd role must not abort a copy of somebody's whole workspace. A row
   * that violates the schema any other way is a defect in the CALLER, and it throws: the
   * transaction rolls back and nobody is left with a half-copy that looks finished.
   *
   * Everything here arrives already translated and already hashed. The object never learns
   * how a token is spelled — hashing is `crypto.subtle`, which is async, and this body runs
   * inside `transactionSync`, which is not.
   */
  importAll({ overlay, identity, at, prune = false } = {}) {
    const stamp = at || new Date().toISOString();
    const written = [];
    const refused = [];
    const bundle = overlay;
    const body = () => {
      for (const [family, scopes] of Object.entries(bundle || {})) {
        for (const [scope, map] of Object.entries(scopes || {})) {
          // PRUNE IS ASKED FOR, never assumed. Deleting the family first would make this
          // backing destructive where the KV one is not, and a restore of a copy that
          // turned out to be short a family would empty the live one. "This family is
          // exactly this" is a reset's sentence; a restore's is "at least this".
          if (prune) {
            this.sql.exec(`DELETE FROM overlay WHERE family = ? AND scope = ?`, String(family), String(scope));
          }
          for (const [k, v] of Object.entries(map || {})) {
            this.sql.exec(
              `INSERT INTO overlay (family, scope, k, v, rev, at) VALUES (?1,?2,?3,?4,1,?5)
                 ON CONFLICT(family, scope, k) DO UPDATE SET v = ?4, rev = overlay.rev + 1, at = ?5`,
              String(family), String(scope), String(k), JSON.stringify(v), stamp,
            );
          }
          written.push(scope ? `${family}/${scope}` : family);
        }
      }
      writeIdentity(this.sql, identity, stamp, written, refused);
    };
    const atomic = typeof this.ctx.storage.transactionSync === "function";
    if (atomic) this.ctx.storage.transactionSync(body); else body();
    return { written, refused, atomic };
  }

  /**
   * Destroy everything this workspace holds.
   *
   * `deleteAll` is the Durable Object's own verb and it is the only honest one: dropping
   * the tables would leave a database with a schema in it, which reads as an empty
   * workspace rather than as no workspace, and the difference matters to the status verb
   * and to anyone auditing what was actually erased.
   *
   * A runtime without `deleteAll` falls back to dropping every table this schema created —
   * named from the schema itself, so a table added later is dropped without anybody
   * remembering to add it here too.
   */
  async destroy() {
    this.ready = false;
    if (typeof this.ctx.storage.deleteAll === "function") {
      await this.ctx.storage.deleteAll();
      return { method: "deleteAll" };
    }
    const tables = TENANT_SCHEMA
      .map((stmt) => (/CREATE TABLE IF NOT EXISTS (\w+)/.exec(stmt) || [])[1])
      .filter(Boolean);
    for (const t of tables) this.sql.exec(`DROP TABLE IF EXISTS ${t}`);
    return { method: "drop-tables", tables };
  }

  /**
   * The worker's way in. A Durable Object stub is not publicly routable — only code
   * holding the binding can reach it — so this is an internal API, not a surface.
   *
   * Deliberately narrow: one verb, the one thing that cannot be done correctly anywhere
   * else. Reads that a worker can serve from KV or R2 do not belong here yet, because
   * every one added is a round trip on a request path that does not need it.
   */
  async fetch(request) {
    const url = new URL(request.url);

    // ── The control plane's door ───────────────────────────────────────────────────
    //
    // One prefix, one verb list, and the verb list is the whole of what the outside world
    // can ask. Reachable only by code holding the namespace binding — a stub is not
    // routable — so the boundary is the binding, not a token this object would have to
    // keep. What this prefix adds is that the boundary is now READABLE: "what can the
    // control plane do to a workspace" is answered by CONTROL_VERBS rather than by
    // reading the whole handler.
    //
    // ⚠️ ONLY `provision` MAY CREATE ANYTHING. Every other verb refuses `not-provisioned`
    // without calling init(), because each takes its workspace name from a URL an operator
    // typed and a typo that provisioned would leave a workspace nobody knows exists.
    if (url.pathname.startsWith("/__control/")) {
      const verb = url.pathname.slice("/__control/".length);
      if (!CONTROL_VERBS.includes(verb)) {
        return Response.json({ error: "tenant-verb-not-allowed", verb }, { status: 404 });
      }
      if (verb === "status") return Response.json(this.status());
      // ── The confirmation, as a READ on the verb that performs it ──────────────────
      //
      // `F-tenant-delete-ux`. Delete is the one verb no rollback reaches, so what a person
      // is shown before they confirm is part of the verb rather than a screen beside it.
      // Serving it from HERE is what stops the copy drifting: the two surfaces that show a
      // confirmation — a workspace's own settings and an operator console in the control
      // plane — are in different repos and cannot import this module, so a rendered-in-both
      // design means the retention window is typed twice and corrected once. This is the
      // same seam `CONTROL_VERBS` and the control plane's `TENANT_RPC` sit on, and the same
      // answer: one side owns it and the other reads it.
      //
      // ⚠️ THE DATE ON THE SCREEN AND THE DATE THE DELETE WRITES ARE ONE ARITHMETIC on one
      // instant, which is why `at` rides the query string exactly as it rides the POST body.
      // A screen that computed its own clock would agree with the delete every day except
      // the one where the reading straddled midnight.
      //
      // GET, and no init() — for `status()`'s reason. Somebody typing a workspace name to
      // see what deleting it would cost must not bring one into being by asking.
      if (verb === "delete" && request.method === "GET") {
        const s = this.status();
        if (!s.provisioned) {
          return Response.json({ ok: false, error: "not-provisioned" }, { status: 404 });
        }
        const at = Date.parse(url.searchParams.get("at") || "");
        return Response.json(deleteConfirmation({
          workspaceId: this.workspaceId() || "",
          graceMs: DELETE_GRACE_MS,
          at: Number.isFinite(at) ? at : Date.now(),
          backupRetentionMs: backupRetentionFromEnv(this.env),
          status: s,
        }));
      }
      if (request.method !== "POST") {
        return Response.json({ error: "method-not-allowed" }, { status: 405 });
      }
      let body = null;
      try { body = await request.json(); } catch (e) { /* an empty body is fine for most */ }
      const at = (body && body.at) || new Date().toISOString();
      switch (verb) {
        case "provision": {
          if (!body || !body.workspaceId || !body.adminEmail) {
            return Response.json({ error: "bad-input" }, { status: 400 });
          }
          // `seed` rides in the SAME call, so it lands in the same transaction — see
          // applyProvisioning. A second request to seed would be the exact gap this closes.
          const out = await this.provision(body);
          return Response.json({ ok: true, ...out });
        }
        case "suspend": return this.controlResult(this.suspend(body && body.reason, at));
        case "resume": return this.controlResult(this.resume(at));
        case "rotate": return this.controlResult(this.rotate(at));
        case "delete": return this.controlResult(this.deleteWorkspace(at));
        // No `to` is read off the body, and none may ever be: see renameAway. The caller
        // knows the new address; this object must not.
        case "rename": return this.controlResult(this.renameAway(at));
        case "claim": {
          if (!body || !body.hostname) return Response.json({ error: "bad-input" }, { status: 400 });
          return this.controlResult(await this.claimHostname(body.hostname, at));
        }
        case "purge": {
          if (!body || !body.email) return Response.json({ error: "bad-input" }, { status: 400 });
          const out = this.purgeAuthor(body.email, at);
          // A refusal here is not "the workspace is in the wrong state" — it is "this cannot
          // be done safely", which is what an id collision is. 409, and the reason travels.
          return out.ok ? Response.json(out) : Response.json(out, {
            status: out.reason === "not-provisioned" ? 404 : 409,
          });
        }
        // Mint the ONE credential that may write the shared page chrome: a star-scope token
        // (for reach) capped to `chrome` (for restraint), short-lived, returned exactly once.
        // Reachable only here — i.e. only by the control plane holding the namespace binding —
        // which is what keeps it out of every workspace's own Settings panel. See
        // `sharedChromeRefusal` and `CAP_ROUTES.chrome` in src/_worker.js.
        case "chrome": {
          const s = this.status();
          if (!s.provisioned) return Response.json({ ok: false, error: "not-provisioned" }, { status: 404 });
          const bearer = newSigningKey();
          // The worker's read path hashes as tokenFor("pub:"+bearer), and tokenFor(secret) is
          // SHA-256("gv:"+secret) — so the stored hash MUST be SHA-256("gv:pub:"+bearer), or
          // this token authenticates against nothing. See `publishAuthDetailed` in _worker.js.
          const tokenHash = await sha256Hex("gv:pub:" + bearer);
          const expiresAt = Date.now() + CHROME_TOKEN_TTL_MS;
          // STORE an ISO string, like every other timestamp in this schema — `stampMs`'s
          // header is explicit that nothing in this file produces a numeric one, and a
          // numeric `expiresAt` here binds into the TEXT column as SQLite's double rendering
          // ("…092.0"), which `Date.parse` in the worker's auth path answers NaN for, so the
          // TTL this token exists to bound is silently never enforced. The RESPONSE keeps the
          // numeric epoch-ms: the operator/CLI reading this wants a number, not a re-parse.
          this.publishTokenMint(
            { tokenHash, space: "*", caps: ["chrome"], label: "chrome-refresh", expiresAt: new Date(expiresAt).toISOString() },
            Date.now(),
          );
          return Response.json({ ok: true, token: bearer, expiresAt });
        }
      }
    }

    if (url.pathname === "/publish-version" && request.method === "POST") {
      let body = null;
      try { body = await request.json(); } catch (e) { /* handled below */ }
      const space = body && body.space;
      if (!space) return Response.json({ error: "no-space" }, { status: 400 });
      await this.init(body.workspaceId);
      const version = this.nextPublishVersion(space, body.floor);
      return Response.json({ version });
    }
    // The workspace's own account of which spaces are its own. NOT a control verb: like
    // `/status` and `/suspension` this is the request path asking the workspace about
    // itself, and `CONTROL_VERBS` is what the OUTSIDE may do TO one. No init() either —
    // asking what a workspace holds must not bring one into being.
    if (url.pathname === "/publish-spaces" && request.method === "GET") {
      return Response.json(this.publishedSpaces());
    }
    // NO init() ON THIS ONE. See status() — a call on a typo must not create a workspace.
    if (url.pathname === "/status" && request.method === "GET") {
      return Response.json(this.status());
    }
    // The request path's question, and the reason it is not /status. No init() either.
    if (url.pathname === "/suspension" && request.method === "GET") {
      return Response.json(this.suspension());
    }
    // A sign-in that already succeeded, offered to the workspace as a chance to come back.
    //
    // NOT a control verb, on purpose: `CONTROL_VERBS` is what the OUTSIDE may do to a
    // workspace, and this is the request path asking the workspace about itself — the same
    // side of the line `/activity` and `/suspension` are on. Adding it there would also put
    // it in the control plane's `TENANT_RPC`, which is a list of things an operator can be
    // granted, and nobody should be granted this.
    //
    // NO init(), for `status()`'s reason: the workspace id comes from a hostname, and a
    // sign-in attempt against a name nobody provisioned must not spring one into being.
    if (url.pathname === "/resume-on-sign-in" && request.method === "POST") {
      let body = null;
      try { body = await request.json(); } catch (e) { /* an empty body refuses inside */ }
      return Response.json(this.resumeOnSignIn(body || {}));
    }
    if (url.pathname === "/activity" && request.method === "POST") {
      let body = null;
      try { body = await request.json(); } catch (e) { /* an empty body is fine */ }
      await this.init(body && body.workspaceId);
      return Response.json({ wrote: this.touchActivity() });
    }
    if (url.pathname === "/destroy" && request.method === "POST") {
      // No init(): destroying a workspace that does not exist must not create one first.
      return Response.json(await this.destroy());
    }
    if (url.pathname === "/state/import" && request.method === "POST") {
      let body = null;
      try { body = await request.json(); } catch (e) { /* handled below */ }
      if (!body || !body.overlay || typeof body.overlay !== "object" || Array.isArray(body.overlay)) {
        return Response.json({ error: "bad-input" }, { status: 400 });
      }
      await this.init(body.workspaceId);
      // `identity` is optional and rides in the SAME call, so the roster and the content
      // land in one transaction. A second request for it would put back the seam this
      // route exists to remove — and the roster is the half that decides who gets in.
      return Response.json(this.importAll({
        overlay: body.overlay, identity: body.identity, at: null, prune: !!body.prune,
      }));
    }
    if (url.pathname === "/quota/bump" && request.method === "POST") {
      let body = null;
      try { body = await request.json(); } catch (e) { /* handled below */ }
      if (!body || !body.k || !body.field) return Response.json({ error: "bad-input" }, { status: 400 });
      await this.init(body.workspaceId);
      // The ceiling is read HERE rather than sent by the caller: a limit that travels in a
      // request body is a limit a caller can choose, and this object is the only thing that
      // can answer both questions in one round trip anyway.
      const ceiling = this.quotas()[body.field];
      const out = this.bumpCounter(body.k, body.window || "", body.by, ceiling);
      return Response.json(out);
    }
    // ── the identity families, read and written where they live ────────────────
    //
    // `B-kv-read-cutover`. Same shape as `/overlay/*` below, and deliberately so: that
    // straddle is the one every other family in this phase came across on, so a reader who
    // has understood one has understood both. `init()` for the same reason too — a
    // workspace the request path has reached is a workspace, and refusing to build its
    // tables here would make the first invite after a provision the one that fails.
    if (url.pathname.startsWith("/identity/") && request.method === "POST") {
      let body = null;
      try { body = await request.json(); } catch (e) { /* handled per verb below */ }
      if (!body) return Response.json({ error: "bad-input" }, { status: 400 });
      await this.init(body.workspaceId);
      const now = Number.isFinite(body.now) ? body.now : Date.now();
      switch (url.pathname) {
        // The raw token never crosses this wire — only its hash. See inviteRead.
        case "/identity/invite/read":
          return Response.json({ email: this.inviteRead(body.tokenHash, now) });
        case "/identity/invite/consume":
          return Response.json({ email: this.inviteConsume(body.tokenHash, now) });
        case "/identity/invite/mint":
          return Response.json(this.inviteMint(body, now));
        case "/identity/invite/revoke":
          return Response.json(this.inviteRevoke(body.email));
        case "/identity/lastseen/read":
          return Response.json({ map: this.lastseenRead() });
        case "/identity/lastseen/touch":
          return Response.json(this.lastseenTouch(body.email, body.throttleMs, now));
        case "/identity/lastseen/forget":
          return Response.json(this.lastseenForget(body.email));
        case "/identity/roster/read":
          return Response.json(this.rosterRead());
        case "/identity/roster/write":
          return Response.json(this.rosterWrite(body, now));
        case "/identity/token/read":
          return Response.json({ entry: this.publishTokenRead(body.tokenHash) });
        case "/identity/token/list":
          return Response.json(this.publishTokenList());
        case "/identity/token/mint":
          return Response.json(this.publishTokenMint(body, now));
        case "/identity/token/revoke":
          return Response.json(this.publishTokenRevoke(body));
        default:
          return Response.json({ error: "not-found" }, { status: 404 });
      }
    }

    if (url.pathname.startsWith("/overlay/") && request.method === "POST") {
      let body = null;
      try { body = await request.json(); } catch (e) { /* handled below */ }
      if (!body || !body.family) return Response.json({ error: "no-family" }, { status: 400 });
      await this.init(body.workspaceId);
      const scope = body.scope || "";
      switch (url.pathname) {
        case "/overlay/read":
          return Response.json({ map: this.overlayRead(body.family, scope) });
        case "/overlay/scopes":
          // No key and no scope: the question is which scopes exist at all. Only a copy asks.
          return Response.json({ scopes: this.overlayScopes(body.family) });
        case "/overlay/set":
          if (!body.k) return Response.json({ error: "no-key" }, { status: 400 });
          this.overlaySet(body.family, scope, body.k, body.v === undefined ? null : body.v, null, body.owner);
          return Response.json({ map: this.overlayRead(body.family, scope) });
        case "/overlay/insert": {
          if (!body.k) return Response.json({ error: "no-key" }, { status: 400 });
          const inserted = this.overlayInsert(body.family, scope, body.k, body.v, null, body.owner);
          return Response.json({ inserted, map: this.overlayRead(body.family, scope) });
        }
        case "/overlay/owner":
          if (!body.k) return Response.json({ error: "no-key" }, { status: 400 });
          return Response.json(this.overlayOwner(body.family, scope, body.k) || { owner: null, acl: null });
        case "/overlay/read-rev":
          if (!body.k) return Response.json({ error: "no-key" }, { status: 400 });
          return Response.json(this.overlayReadRev(body.family, scope, body.k));
        case "/overlay/cas": {
          if (!body.k) return Response.json({ error: "no-key" }, { status: 400 });
          const rev = this.overlayCas(body.family, scope, body.k, body.v, body.rev);
          return Response.json({ ok: rev !== null, rev });
        }
        case "/overlay/replace":
          return Response.json({ map: this.overlayReplace(body.family, scope, body.map) });
        default:
          return Response.json({ error: "not-found" }, { status: 404 });
      }
    }
    return Response.json({ error: "not-found" }, { status: 404 });
  }

  /** The plan this workspace is on, and every ceiling it carries, as one flat object. */
  quotas() {
    const plan = [...this.sql.exec(`SELECT v FROM meta WHERE k = 'plan'`)];
    const out = { plan: plan.length ? plan[0].v : DEFAULT_PLAN };
    for (const row of this.sql.exec(`SELECT k, n FROM quotas`)) out[row.k] = row.n;
    return out;
  }
}
