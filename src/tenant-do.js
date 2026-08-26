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
// below therefore contains no password, no hash of one, and no reusable secret of any kind
// — `test/tenant-do.test.mjs` asserts that by reading the schema, so the claim is checked
// rather than promised.
//
// WHAT IS HERE AND WHY IT LOOKS SIMPLER THAN THE KV IT REPLACES. `users:spaces` mapped an
// address to a role PER SPACE, because one deployment used to mount several. A workspace is
// now the only tier, so a member has one role in this workspace and the table has one
// column for it. Anyone reinstating a per-space role should put it in the membership model
// rather than resurrect the map.

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
  async init(workspaceId) {
    if (this.ready) return;
    const run = () => { applyTenantSchema(this.sql, workspaceId); this.ready = true; };
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
}
