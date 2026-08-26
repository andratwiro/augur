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

export const TENANT_SCHEMA_VERSION = 1;

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
  `CREATE TABLE IF NOT EXISTS members (
     email       TEXT PRIMARY KEY,
     role        TEXT NOT NULL CHECK (role IN ('admin','editor','viewer')),
     name        TEXT,
     avatar_key  TEXT,
     avatar_mime TEXT,
     avatar_at   TEXT,
     added_at    TEXT NOT NULL,
     removed_at  TEXT
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
  `CREATE TABLE IF NOT EXISTS publish_tokens (
     token_hash TEXT PRIMARY KEY,
     label      TEXT,
     created_at TEXT NOT NULL,
     expires_at TEXT
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

/** Apply the schema to a SQLite-backed store. Idempotent — every statement is IF NOT EXISTS. */
export function applyTenantSchema(sql, workspaceId) {
  for (const stmt of TENANT_SCHEMA) sql.exec(stmt);
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
 * delete-confirmation screen has to say the same thing (`F-tenant-delete-ux`), and the
 * backup rotation is what makes the second number true (`D-2-nightly-backup-worm`, 30 kept
 * plus 40). Change this and all three change the same day, or the platform is promising
 * something it does not do.
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
  "provision", "status", "suspend", "resume", "rotate", "delete",
]);

export function newSigningKey(random = (b) => crypto.getRandomValues(b)) {
  const bytes = new Uint8Array(32);
  random(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
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
export function applyProvisioning(sql, {
  workspaceId, adminEmail, adminName = "", plan = DEFAULT_PLAN, now, sessionKey,
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
    `INSERT INTO members (email, role, name, added_at) VALUES (?, 'admin', ?, ?)
       ON CONFLICT(email) DO NOTHING`,
    String(adminEmail).trim().toLowerCase(), adminName || "", at,
  );
  seedQuotas(sql, plan);
  sql.exec(`INSERT INTO meta (k, v) VALUES ('created_at', ?) ON CONFLICT(k) DO NOTHING`, at);
  // LAST. Everything above is invisible until this row exists.
  sql.exec(`INSERT INTO meta (k, v) VALUES ('provisioned_at', ?) ON CONFLICT(k) DO NOTHING`, at);
  return { provisionedAt: at, created: true };
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
      createdAt: meta.created_at || null,
      lastActivityAt: meta.last_activity_at || null,
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
   * catastrophe. Actually erasing it — the R2 prefix, this object's storage, dedup-safely —
   * is `E-gdpr-delete-tenant`, and `destroy()` is the primitive it will use.
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
    if (!this.hasMeta()) return { suspended: false, reason: null, at: null, deleted: false };
    return {
      suspended: this.readMeta("suspended") === "1",
      reason: this.readMeta("suspended_reason"),
      at: this.readMeta("suspended_at"),
      deleted: !!this.readMeta("deleted_at"),
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
    const stamp = at || new Date().toISOString();
    const written = [];
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
    };
    const atomic = typeof this.ctx.storage.transactionSync === "function";
    if (atomic) this.ctx.storage.transactionSync(body); else body();
    return { written, atomic };
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
          const out = await this.provision(body);
          return Response.json({ ok: true, ...out });
        }
        case "suspend": return this.controlResult(this.suspend(body && body.reason, at));
        case "resume": return this.controlResult(this.resume(at));
        case "rotate": return this.controlResult(this.rotate(at));
        case "delete": return this.controlResult(this.deleteWorkspace(at));
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
    // NO init() ON THIS ONE. See status() — a call on a typo must not create a workspace.
    if (url.pathname === "/status" && request.method === "GET") {
      return Response.json(this.status());
    }
    // The request path's question, and the reason it is not /status. No init() either.
    if (url.pathname === "/suspension" && request.method === "GET") {
      return Response.json(this.suspension());
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
      return Response.json(this.importOverlay(body.overlay, null, !!body.prune));
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
    if (url.pathname.startsWith("/overlay/") && request.method === "POST") {
      let body = null;
      try { body = await request.json(); } catch (e) { /* handled below */ }
      if (!body || !body.family) return Response.json({ error: "no-family" }, { status: 400 });
      await this.init(body.workspaceId);
      const scope = body.scope || "";
      switch (url.pathname) {
        case "/overlay/read":
          return Response.json({ map: this.overlayRead(body.family, scope) });
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
