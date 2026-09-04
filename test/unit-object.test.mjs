import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { UnitObject, UNIT_SCHEMA, applyUnitSchema, LAND_LEASE_MS } from "../src/unit-object.mjs";

function sqlHandle(db) {
  return {
    exec(stmt, ...params) {
      if (/^\s*SELECT/i.test(stmt)) return db.prepare(stmt).all(...params);
      if (params.length) { db.prepare(stmt).run(...params); return []; }
      db.exec(stmt);
      return [];
    },
  };
}
function object() {
  const db = new DatabaseSync(":memory:");
  const ctx = { storage: { sql: sqlHandle(db) }, blockConcurrencyWhile: async (f) => f() };
  return { db, obj: new UnitObject(ctx, {}) };
}
const call = async (obj, route, body, method = "POST") => {
  const res = await obj.fetch(new Request(`https://unit${route}`, method === "GET" ? undefined
    : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) }));
  return { status: res.status, body: await res.json() };
};
const T0 = "2026-09-04T12:00:00.000Z";
const later = (s) => new Date(Date.parse(T0) + s * 1000).toISOString();
const U = "/checkout/flow/";
const main1 = { [`${U}index.html`]: { h: "a".repeat(64), ct: "text/html", s: 10 } };

async function fresh() {
  const { obj, db } = object();
  const r = await call(obj, "/sync-main", { workspace: "acme", unit: U, table: main1, at: T0 });
  assert.equal(r.status, 200);
  assert.equal(r.body.revision, 1);
  return { obj, db };
}

test("the schema runs on a real SQLite engine and is idempotent", () => {
  const db = new DatabaseSync(":memory:");
  const sql = sqlHandle(db);
  applyUnitSchema(sql, "acme", U);
  applyUnitSchema(sql, "acme", U);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(tables, ["draft_saves", "drafts", "landings", "meta"]);
  assert.equal(db.prepare("SELECT v FROM meta WHERE k='unit'").get().v, U);
  assert.equal(UNIT_SCHEMA.length >= 4, true);
});

test("sync-main adopts what is live as revision one, and a changed live table as a new revision", async () => {
  const { obj } = await fresh();
  const same = await call(obj, "/sync-main", { workspace: "acme", unit: U, table: main1, at: later(1) });
  assert.equal(same.body.revision, 1, "an identical table is not a new revision");
  const moved = await call(obj, "/sync-main", { workspace: "acme", unit: U, table: { ...main1, [`${U}b.css`]: { h: "b".repeat(64), ct: "text/css", s: 1 } }, at: later(2) });
  assert.equal(moved.body.revision, 2);
  const h = await call(obj, "/history", null, "GET");
  assert.equal(h.body.landings[0].by, "live");
});

test("open hands out a draft on main, and presence shows it", async () => {
  const { obj } = await fresh();
  const o = await call(obj, "/open", { owner: "p1", session: "pass one", at: T0 });
  assert.equal(o.status, 200);
  assert.match(o.body.draftId, /^[a-z0-9]{6}$/);
  assert.equal(o.body.baseRevision, 1);
  assert.deepEqual(o.body.table, main1);
  const p = await call(obj, `/presence?at=${encodeURIComponent(later(10))}`, null, "GET");
  assert.deepEqual(p.body.drafts.map((d) => [d.owner, d.session, d.active]), [["p1", "pass one", true]]);
  const d = await call(obj, `/draft/${o.body.draftId}`, null, "GET");
  assert.equal(d.status, 200);
  assert.deepEqual(d.body.table, main1);
});

test("save applies against the draft revision and per-file bases, and refuses stale ones", async () => {
  const { obj } = await fresh();
  const { draftId } = (await call(obj, "/open", { owner: "p1", session: "s", at: T0 })).body;
  const ok = await call(obj, "/save", {
    draftId, draftRevision: 0, at: later(1),
    changes: [{ path: `${U}index.html`, h: "c".repeat(64), ct: "text/html", s: 11, baseHash: "a".repeat(64) }],
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.draftRevision, 1);
  assert.equal(ok.body.table[`${U}index.html`].h, "c".repeat(64));

  const wrongRev = await call(obj, "/save", { draftId, draftRevision: 0, at: later(2), changes: [] });
  assert.equal(wrongRev.status, 409);
  assert.equal(wrongRev.body.error, "stale-draft-revision");
  assert.equal(wrongRev.body.draftRevision, 1);

  const staleBase = await call(obj, "/save", {
    draftId, draftRevision: 1, at: later(3),
    changes: [{ path: `${U}index.html`, h: "d".repeat(64), ct: "text/html", s: 1, baseHash: "a".repeat(64) }],
  });
  assert.equal(staleBase.status, 409);
  assert.equal(staleBase.body.error, "stale-draft");
  assert.deepEqual(staleBase.body.stale, [{ path: `${U}index.html`, h: "c".repeat(64) }]);

  const unknown = await call(obj, "/save", { draftId: "zzzzzz", draftRevision: 0, at: later(4), changes: [] });
  assert.equal(unknown.status, 404);
});

test("land takes a lease, landed commits it, and the draft closes", async () => {
  const { obj } = await fresh();
  const { draftId } = (await call(obj, "/open", { owner: "p1", session: "s", at: T0 })).body;
  await call(obj, "/save", { draftId, draftRevision: 0, at: later(1),
    changes: [{ path: `${U}index.html`, h: "c".repeat(64), ct: "text/html", s: 11, baseHash: "a".repeat(64) }] });
  const l = await call(obj, "/land", { draftId, baseRevision: 1, at: later(2) });
  assert.equal(l.status, 200, JSON.stringify(l.body));
  assert.equal(l.body.revision, 2);
  assert.equal(typeof l.body.lease, "string");
  assert.deepEqual(l.body.changed.map((c) => c.path), [`${U}index.html`]);

  const other = await call(obj, "/open", { owner: "p2", session: "t", at: later(2) });
  const blocked = await call(obj, "/land", { draftId: other.body.draftId, baseRevision: 1, at: later(3) });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error, "landing-in-progress");

  const done = await call(obj, "/landed", { lease: l.body.lease, draftId, note: "first", by: "p1", session: "s", at: later(4) });
  assert.equal(done.status, 200);
  assert.equal(done.body.revision, 2);
  const m = await call(obj, "/main", null, "GET");
  assert.equal(m.body.revision, 2);
  assert.equal(m.body.table[`${U}index.html`].h, "c".repeat(64));
  const d = await call(obj, `/draft/${draftId}`, null, "GET");
  assert.equal(typeof d.body.closedAt, "string");
  const h = await call(obj, "/history", null, "GET");
  assert.deepEqual(h.body.landings.map((x) => [x.revision, x.by, x.note]), [[2, "p1", "first"], [1, "live", "adopted from live"]]);
});

test("a second draft opened on the old base is refused at land, sync names the delta, and a rebased save lands", async () => {
  const { obj } = await fresh();
  const a = (await call(obj, "/open", { owner: "p1", session: "a", at: T0 })).body;
  const b = (await call(obj, "/open", { owner: "p2", session: "b", at: T0 })).body;
  await call(obj, "/save", { draftId: a.draftId, draftRevision: 0, at: later(1),
    changes: [{ path: `${U}index.html`, h: "c".repeat(64), ct: "text/html", s: 11, baseHash: "a".repeat(64) }] });
  const la = await call(obj, "/land", { draftId: a.draftId, baseRevision: 1, at: later(2) });
  await call(obj, "/landed", { lease: la.body.lease, draftId: a.draftId, note: "", by: "p1", session: "a", at: later(3) });

  await call(obj, "/save", { draftId: b.draftId, draftRevision: 0, at: later(4),
    changes: [{ path: `${U}b.css`, h: "b".repeat(64), ct: "text/css", s: 1, baseHash: null }] });
  const lb = await call(obj, "/land", { draftId: b.draftId, baseRevision: 1, at: later(5) });
  assert.equal(lb.status, 409);
  assert.equal(lb.body.error, "main-moved");
  assert.equal(lb.body.mainRevision, 2);
  assert.deepEqual(lb.body.changed.map((c) => [c.path, c.h]), [[`${U}index.html`, "c".repeat(64)]]);

  const s = await call(obj, "/sync", { draftId: b.draftId });
  assert.equal(s.body.mainRevision, 2);
  assert.equal(s.body.baseRevision, 1);
  assert.deepEqual(s.body.changed.map((c) => c.path), [`${U}index.html`]);

  const rebased = await call(obj, "/save", { draftId: b.draftId, draftRevision: 1, baseRevision: 2, at: later(6),
    changes: [{ path: `${U}index.html`, h: "c".repeat(64), ct: "text/html", s: 11, baseHash: "a".repeat(64) }] });
  assert.equal(rebased.status, 200, JSON.stringify(rebased.body));
  const lb2 = await call(obj, "/land", { draftId: b.draftId, baseRevision: 2, at: later(7) });
  assert.equal(lb2.status, 200, JSON.stringify(lb2.body));
  assert.deepEqual(lb2.body.changed.map((c) => c.path), [`${U}b.css`]);
});

test("a lease expires on its own and abandon-land releases it early", async () => {
  const { obj } = await fresh();
  const a = (await call(obj, "/open", { owner: "p1", session: "a", at: T0 })).body;
  const b = (await call(obj, "/open", { owner: "p2", session: "b", at: T0 })).body;
  const la = await call(obj, "/land", { draftId: a.draftId, baseRevision: 1, at: later(1) });
  const stillHeld = await call(obj, "/land", { draftId: b.draftId, baseRevision: 1, at: later(1 + LAND_LEASE_MS / 1000 - 1) });
  assert.equal(stillHeld.status, 409);
  const expired = await call(obj, "/land", { draftId: b.draftId, baseRevision: 1, at: later(1 + LAND_LEASE_MS / 1000 + 1) });
  assert.equal(expired.status, 200);
  const stale = await call(obj, "/landed", { lease: la.body.lease, draftId: a.draftId, note: "", by: "p1", session: "a", at: later(30) });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "bad-lease");
  await call(obj, "/abandon-land", { lease: expired.body.lease });
  const again = await call(obj, "/land", { draftId: a.draftId, baseRevision: 1, at: later(31) });
  assert.equal(again.status, 200);
});

test("restore lands an earlier revision as a new one", async () => {
  const { obj } = await fresh();
  const a = (await call(obj, "/open", { owner: "p1", session: "a", at: T0 })).body;
  await call(obj, "/save", { draftId: a.draftId, draftRevision: 0, at: later(1),
    changes: [{ path: `${U}index.html`, h: "c".repeat(64), ct: "text/html", s: 11, baseHash: "a".repeat(64) }] });
  const la = await call(obj, "/land", { draftId: a.draftId, baseRevision: 1, at: later(2) });
  await call(obj, "/landed", { lease: la.body.lease, draftId: a.draftId, note: "", by: "p1", session: "a", at: later(3) });
  const r = await call(obj, "/restore", { revision: 1, at: later(4) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.table, main1);
  const done = await call(obj, "/landed", { lease: r.body.lease, note: "back", by: "p1", session: "a", at: later(5), restoredFrom: 1 });
  assert.equal(done.body.revision, 3);
  const h = await call(obj, "/history", null, "GET");
  assert.equal(h.body.landings[0].restoredFrom, 1);
  assert.equal(h.body.landings.length, 3, "history is never rewritten");
});

test("discard closes a draft and it leaves presence", async () => {
  const { obj } = await fresh();
  const a = (await call(obj, "/open", { owner: "p1", session: "a", at: T0 })).body;
  const d = await call(obj, "/discard", { draftId: a.draftId, at: later(1) });
  assert.deepEqual(d.body, { closed: true });
  const p = await call(obj, `/presence?at=${encodeURIComponent(later(2))}`, null, "GET");
  assert.deepEqual(p.body.drafts, []);
  const s = await call(obj, "/save", { draftId: a.draftId, draftRevision: 0, at: later(3), changes: [] });
  assert.equal(s.status, 404);
});
