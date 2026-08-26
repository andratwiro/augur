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
  `CREATE TABLE IF NOT EXISTS overlay (
     family TEXT NOT NULL,
     scope  TEXT NOT NULL DEFAULT '',
     k      TEXT NOT NULL,
     v      TEXT NOT NULL,
     at     TEXT NOT NULL,
     PRIMARY KEY (family, scope, k)
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

  /** Whether this workspace exists as far as anything else is concerned. */
  isProvisioned() {
    return [...this.sql.exec(`SELECT v FROM meta WHERE k = 'provisioned_at'`)].length > 0;
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
  overlaySet(family, scope, k, v, at) {
    if (v === null || v === undefined) {
      this.sql.exec(`DELETE FROM overlay WHERE family = ? AND scope = ? AND k = ?`,
        String(family), String(scope), String(k));
      return null;
    }
    this.sql.exec(
      `INSERT INTO overlay (family, scope, k, v, at) VALUES (?,?,?,?,?)
         ON CONFLICT(family, scope, k) DO UPDATE SET v = excluded.v, at = excluded.at`,
      String(family), String(scope), String(k), JSON.stringify(v), at || new Date().toISOString(),
    );
    return v;
  }

  /**
   * Create a key only if it is absent, and say which happened.
   *
   * Creating a board reads the map, checks the slug is free, then writes — so two creates
   * of one name both pass the check and the second silently takes the first's board. One
   * statement in one object cannot.
   */
  overlayInsert(family, scope, k, v, at) {
    const rows = [...this.sql.exec(
      `INSERT INTO overlay (family, scope, k, v, at) VALUES (?,?,?,?,?)
         ON CONFLICT(family, scope, k) DO NOTHING
       RETURNING k`,
      String(family), String(scope), String(k), JSON.stringify(v), at || new Date().toISOString(),
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
    if (url.pathname === "/publish-version" && request.method === "POST") {
      let body = null;
      try { body = await request.json(); } catch (e) { /* handled below */ }
      const space = body && body.space;
      if (!space) return Response.json({ error: "no-space" }, { status: 400 });
      await this.init(body.workspaceId);
      const version = this.nextPublishVersion(space, body.floor);
      return Response.json({ version });
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
          this.overlaySet(body.family, scope, body.k, body.v === undefined ? null : body.v);
          return Response.json({ map: this.overlayRead(body.family, scope) });
        case "/overlay/insert": {
          if (!body.k) return Response.json({ error: "no-key" }, { status: 400 });
          const inserted = this.overlayInsert(body.family, scope, body.k, body.v);
          return Response.json({ inserted, map: this.overlayRead(body.family, scope) });
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
