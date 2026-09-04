// src/unit-object.mjs — one Durable Object per unit: the authority on main, drafts,
// landings and the landing lease. See docs/drafts-that-land.md §6.
//
// File BODIES never live here. A table row names a content hash; the bytes are in the
// bundle store under `blobs/<hash>`, shared and content-addressed, exactly as a publish
// leaves them. A table is stored as one JSON document per revision, well under the row
// limit for any prototype this engine has met.
//
// THE OBJECT NEVER MERGES. `save` applies a batch of changes with per-file compare-and-set
// or refuses the whole batch with the fresh hashes; `land` refuses when main moved since
// the draft's base. What to do about a refusal is the client's, on its own disk.
//
// THE LANDING LEASE. Landing writes the space manifest, and that write happens in the
// worker, outside this object's single thread. So `land` hands out a ten-second lease and
// refuses every other landing while it is held; `landed` commits under that lease. A
// worker that dies between the two leaves a lease that simply expires — nothing depends on
// it being released, and `abandon-land` is a courtesy.
import {
  newDraftId, unitTable, sameTable, applyChanges, tableDelta, presenceOf,
} from "./unit-core.mjs";

export const LAND_LEASE_MS = 10_000;
export const UNIT_SCHEMA_VERSION = 1;
// A literal, not a constructed RegExp — its group mirrors DRAFT_ID_RE in unit-core.mjs.
const DRAFT_ROUTE_RE = /^\/draft\/([a-z0-9]{6})$/;

export const UNIT_SCHEMA = Object.freeze([
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS landings (
     revision      INTEGER PRIMARY KEY,
     tbl           TEXT NOT NULL,
     by            TEXT,
     session       TEXT,
     at            TEXT NOT NULL,
     note          TEXT,
     draft_id      TEXT,
     restored_from INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS drafts (
     id            TEXT PRIMARY KEY,
     owner         TEXT NOT NULL,
     session       TEXT,
     opened_at     TEXT NOT NULL,
     last_save_at  TEXT,
     base_revision INTEGER NOT NULL,
     revision      INTEGER NOT NULL,
     tbl           TEXT NOT NULL,
     closed_at     TEXT,
     discarded     INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS draft_saves (
     draft_id  TEXT NOT NULL,
     revision  INTEGER NOT NULL,
     tbl       TEXT NOT NULL,
     at        TEXT NOT NULL,
     PRIMARY KEY (draft_id, revision)
   )`,
]);

export function applyUnitSchema(sql, workspace, unit) {
  for (const stmt of UNIT_SCHEMA) sql.exec(stmt);
  sql.exec(`INSERT INTO meta (k, v) VALUES ('schema_version', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, String(UNIT_SCHEMA_VERSION));
  if (workspace) sql.exec(`INSERT INTO meta (k, v) VALUES ('workspace', ?) ON CONFLICT(k) DO NOTHING`, String(workspace));
  if (unit) sql.exec(`INSERT INTO meta (k, v) VALUES ('unit', ?) ON CONFLICT(k) DO NOTHING`, String(unit));
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const rowDraft = (r) => r && ({
  id: r.id, owner: r.owner, session: r.session || "", openedAt: r.opened_at, lastSaveAt: r.last_save_at || null,
  baseRevision: Number(r.base_revision), revision: Number(r.revision), table: JSON.parse(r.tbl),
  closedAt: r.closed_at || null, discarded: !!r.discarded,
});

export class UnitObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.ready = false;
  }

  get sql() { return this.ctx.storage.sql; }

  async init(workspace, unit) {
    if (this.ready) return;
    const run = () => { applyUnitSchema(this.sql, workspace, unit); this.ready = true; };
    if (this.ctx.blockConcurrencyWhile) await this.ctx.blockConcurrencyWhile(async () => run());
    else run();
  }

  // ── meta ──────────────────────────────────────────────────────────────────
  metaGet(k) {
    const rows = [...this.sql.exec(`SELECT v FROM meta WHERE k = ?`, k)];
    return rows.length ? rows[0].v : null;
  }
  metaSet(k, v) {
    if (v === null) this.sql.exec(`DELETE FROM meta WHERE k = ?`, k);
    else this.sql.exec(`INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, k, String(v));
  }
  mainRevision() { return Number(this.metaGet("main_revision") || 0); }
  landing(revision) {
    const rows = [...this.sql.exec(`SELECT * FROM landings WHERE revision = ?`, revision)];
    return rows.length ? rows[0] : null;
  }
  mainTable() {
    const l = this.landing(this.mainRevision());
    return l ? JSON.parse(l.tbl) : {};
  }
  draft(id) {
    const rows = [...this.sql.exec(`SELECT * FROM drafts WHERE id = ?`, id)];
    return rows.length ? rowDraft(rows[0]) : null;
  }
  openDrafts() {
    return [...this.sql.exec(`SELECT * FROM drafts WHERE closed_at IS NULL ORDER BY opened_at`)].map(rowDraft);
  }
  lease(nowMs) {
    const raw = this.metaGet("lease");
    if (!raw) return null;
    const l = JSON.parse(raw);
    if (Number(l.until) <= nowMs) { this.metaSet("lease", null); return null; }
    return l;
  }
  writeLanding({ table, by, session, at, note, draftId, restoredFrom }) {
    const revision = this.mainRevision() + 1;
    this.sql.exec(
      `INSERT INTO landings (revision, tbl, by, session, at, note, draft_id, restored_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      revision, JSON.stringify(table), by || null, session || null, at, note || null, draftId || null, restoredFrom == null ? null : restoredFrom,
    );
    this.metaSet("main_revision", revision);
    return revision;
  }

  // ── verbs ─────────────────────────────────────────────────────────────────
  syncMain({ table, at }) {
    const cur = this.mainTable();
    if (this.mainRevision() > 0 && sameTable(cur, table)) return { revision: this.mainRevision() };
    return { revision: this.writeLanding({ table, by: "live", at, note: "adopted from live" }) };
  }

  open({ owner, session, at }) {
    let id = newDraftId();
    while (this.draft(id)) id = newDraftId();
    const base = this.mainRevision();
    const table = this.mainTable();
    this.sql.exec(
      `INSERT INTO drafts (id, owner, session, opened_at, base_revision, revision, tbl) VALUES (?, ?, ?, ?, ?, 0, ?)`,
      id, String(owner || ""), String(session || ""), at, base, JSON.stringify(table),
    );
    return { draftId: id, baseRevision: base, table, presence: presenceOf(this.openDrafts(), Date.parse(at)) };
  }

  save({ draftId, draftRevision, changes, baseRevision, at }) {
    const d = this.draft(draftId);
    if (!d || d.closedAt) return [404, { error: "unknown-draft" }];
    const held = this.lease(Date.parse(at));
    if (held && held.draftId === draftId) return [409, { error: "landing-in-progress" }];
    if (Number(draftRevision) !== d.revision) return [409, { error: "stale-draft-revision", draftRevision: d.revision }];
    if (baseRevision !== undefined) {
      const b = Number(baseRevision);
      if (!Number.isInteger(b) || b < d.baseRevision || b > this.mainRevision()) return [400, { error: "bad-base", mainRevision: this.mainRevision() }];
    }
    const r = applyChanges(d.table, Array.isArray(changes) ? changes : []);
    if (!r.ok) return [409, { error: "stale-draft", stale: r.stale }];
    const revision = d.revision + 1;
    this.sql.exec(
      `UPDATE drafts SET revision = ?, tbl = ?, last_save_at = ?, base_revision = ? WHERE id = ?`,
      revision, JSON.stringify(r.table), at, baseRevision === undefined ? d.baseRevision : Number(baseRevision), draftId,
    );
    this.sql.exec(`INSERT INTO draft_saves (draft_id, revision, tbl, at) VALUES (?, ?, ?, ?)`, draftId, revision, JSON.stringify(r.table), at);
    return [200, { draftRevision: revision, table: r.table }];
  }

  takeLease({ draftId, table, at, restoredFrom }) {
    const nowMs = Date.parse(at);
    const held = this.lease(nowMs);
    if (held && held.draftId !== (draftId || null)) return [409, { error: "landing-in-progress" }];
    const lease = newDraftId() + newDraftId();
    const revision = this.mainRevision() + 1;
    this.metaSet("lease", JSON.stringify({
      token: lease, draftId: draftId || null, revision, until: nowMs + LAND_LEASE_MS,
      table, restoredFrom: restoredFrom == null ? null : restoredFrom,
    }));
    const delta = tableDelta(this.mainTable(), table);
    return [200, { lease, revision, table, ...delta }];
  }

  land({ draftId, baseRevision, at }) {
    const d = this.draft(draftId);
    if (!d || d.closedAt) return [404, { error: "unknown-draft" }];
    const main = this.mainRevision();
    if (d.baseRevision !== main || Number(baseRevision) !== main) {
      const base = this.landing(d.baseRevision);
      const delta = tableDelta(base ? JSON.parse(base.tbl) : {}, this.mainTable());
      return [409, { error: "main-moved", mainRevision: main, ...delta }];
    }
    // AN EMPTIED DRAFT IS NOT AN UNPUBLISH REQUEST. A draft whose every file is gone lands
    // a unit with nothing behind it: the URL goes dark for everyone, the prefix is left
    // declared, and the landing reads as a success. The one thing that reliably produces
    // it is a folder that failed to materialise — a killed open, a disk that filled — so
    // the answer is a refusal rather than a confirmation the object has no way to ask for.
    // Deleting a prototype is its own verb, with its own confirmation.
    if (!Object.keys(d.table).length && Object.keys(this.mainTable()).length) {
      return [409, { error: "would-unpublish" }];
    }
    return this.takeLease({ draftId, table: d.table, at });
  }

  restore({ revision, at }) {
    const l = this.landing(Number(revision));
    if (!l) return [404, { error: "unknown-revision" }];
    return this.takeLease({ draftId: null, table: JSON.parse(l.tbl), at, restoredFrom: Number(revision) });
  }

  landed({ lease, draftId, note, by, session, at }) {
    const held = this.lease(Date.parse(at));
    if (!held || held.token !== lease) return [409, { error: "bad-lease" }];
    const table = held.table;
    const revision = this.writeLanding({
      table, by, session, at, note, draftId: held.draftId || draftId || null, restoredFrom: held.restoredFrom,
    });
    if (held.draftId) this.sql.exec(`UPDATE drafts SET closed_at = ? WHERE id = ?`, at, held.draftId);
    this.metaSet("lease", null);
    return [200, { revision }];
  }

  abandonLand({ lease }) {
    const raw = this.metaGet("lease");
    if (raw && JSON.parse(raw).token === lease) this.metaSet("lease", null);
    return [200, { ok: true }];
  }

  sync({ draftId }) {
    const d = this.draft(draftId);
    if (!d || d.closedAt) return [404, { error: "unknown-draft" }];
    const base = this.landing(d.baseRevision);
    const delta = tableDelta(base ? JSON.parse(base.tbl) : {}, this.mainTable());
    return [200, { mainRevision: this.mainRevision(), baseRevision: d.baseRevision, ...delta }];
  }

  discard({ draftId, at }) {
    const d = this.draft(draftId);
    if (!d || d.closedAt) return [404, { error: "unknown-draft" }];
    this.sql.exec(`UPDATE drafts SET closed_at = ?, discarded = 1 WHERE id = ?`, at, draftId);
    return [200, { closed: true }];
  }

  history() {
    const rows = [...this.sql.exec(`SELECT * FROM landings ORDER BY revision DESC`)];
    return {
      revision: this.mainRevision(),
      landings: rows.map((r) => ({
        revision: Number(r.revision), by: r.by || null, session: r.session || "", at: r.at, note: r.note || "",
        draftId: r.draft_id || null, restoredFrom: r.restored_from == null ? null : Number(r.restored_from),
        files: Object.keys(JSON.parse(r.tbl)).length,
      })),
    };
  }

  // ── router ────────────────────────────────────────────────────────────────
  async fetch(request) {
    const url = new URL(request.url);
    const route = url.pathname;
    let body = {};
    if (request.method === "POST") {
      try { body = await request.json(); } catch (e) { return json({ error: "bad-json" }, 400); }
    }
    // Every verb but sync-main assumes the schema is there; sync-main is what the worker
    // calls first on every request, carrying the names the schema is stamped with.
    if (route === "/sync-main") {
      await this.init(body.workspace, body.unit);
      return json(this.syncMain({ table: unitTable(body.table || {}, body.unit || ""), at: body.at || new Date().toISOString() }));
    }
    await this.init(null, null);
    if (request.method === "GET") {
      if (route === "/presence") return json({ drafts: presenceOf(this.openDrafts(), Date.parse(url.searchParams.get("at") || "") || Date.now()) });
      if (route === "/history") return json(this.history());
      if (route === "/main") return json({ revision: this.mainRevision(), table: this.mainTable() });
      const m = DRAFT_ROUTE_RE.exec(route);
      if (m) {
        const d = this.draft(m[1]);
        if (!d || d.discarded) return json({ error: "unknown-draft" }, 404);
        return json({ draftId: d.id, table: d.table, owner: d.owner, session: d.session, baseRevision: d.baseRevision, revision: d.revision, closedAt: d.closedAt });
      }
      return json({ error: "unknown-route" }, 404);
    }
    const at = body.at || new Date().toISOString();
    const verbs = {
      "/open": () => [200, this.open({ ...body, at })],
      "/save": () => this.save({ ...body, at }),
      "/land": () => this.land({ ...body, at }),
      "/restore": () => this.restore({ ...body, at }),
      "/landed": () => this.landed({ ...body, at }),
      "/abandon-land": () => this.abandonLand(body),
      "/sync": () => this.sync(body),
      "/discard": () => this.discard({ ...body, at }),
    };
    if (!verbs[route]) return json({ error: "unknown-route" }, 404);
    const [status, out] = verbs[route]();
    return json(out, status);
  }
}
