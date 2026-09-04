# Drafts That Land — Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent can open one prototype into a folder of its own, save files that are live at once at a draft address, and land the draft onto the prototype's real URL by compare-and-set, with a refused landing resolved by a local three-way merge.

**Architecture:** One Durable Object per unit (`UnitObject`) is the authority on main revision, per-draft file tables, the landing history and a short landing lease. The worker exposes it under `/__unit/<verb>`, serves draft addresses from the draft's table, and on landing rewrites the space manifest so every existing serve, rollback and export path keeps working unchanged. The CLI gains `open`, `save`, `land`, `sync` and `close`, all pure functions over an injected request client. Presence chips, live reload, hooks, `read`, `watch`, derived pages and retirement of the old publish path are later slices.

**Tech Stack:** Plain Node (no dependencies), Cloudflare Workers + Durable Objects with SQLite storage, R2 content-addressed blobs, `node:test` and `node:sqlite` for tests (Node 24 in this repo).

## Global Constraints

- Spec: `docs/drafts-that-land.md`. Read sections 3, 4, 6 and 7 before any task.
- **Zero product words.** The engine may not name another company's product or any workspace's private vocabulary. `npm run check` runs `scripts/no-product-names.mjs` and `scripts/no-foreign-vocabulary.mjs`; both must stay green.
- **Plain Node, no dependencies.** No new `package.json` dependencies.
- **Never `git add -A`.** Stage the paths you changed.
- **Unit paths** are URL prefixes with leading and trailing slash, exactly as `routing.publicPrefixes` spells them: `/checkout/flow/`.
- **Draft ids** are six lowercase base-36 characters. A draft address is `<unit>@<id>/`, for example `/checkout/flow/@k7f3q1/`.
- **The server never merges.** A save is refused with the fresh state or accepted verbatim.
- **Presence is derived** from `lastSaveAt`/`openedAt`: active within five minutes, idle after.
- **Landing lease** is ten seconds. A lease that expires is simply gone.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Run `npm test` before every commit; run `npm run check` before the last commit of each task.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/unit-core.mjs` (new) | Pure decisions: unit path normalisation, draft ids and addresses, table extraction from a manifest, applying a save's changes with per-file compare-and-set, deltas between tables, presence derivation. No I/O. |
| `src/unit-object.mjs` (new) | `UnitObject` Durable Object: SQLite schema, verbs `sync-main`, `open`, `save`, `land`, `landed`, `abandon-land`, `restore`, `sync`, `discard`, `presence`, `history`, `draft/<id>`. Talks to nothing outside its storage. |
| `src/entry.js` (modify) | Export `UnitObject` so wrangler can bind it. |
| `templates/shell/wrangler.example.toml` (modify) | Commented `UNITS` binding + migration block. |
| `src/_worker.js` (modify) | `unitNamespace`/`unitStub`, `unitApi` under `/__unit/`, `writeUnitLanding`, draft-address serving in `assetFetch`, `isPublicPath` refusing draft segments, `FROZEN_WRITES` entry. |
| `scripts/lib/merge3.mjs` (new) | Line-based diff and three-way merge that reports overlaps instead of guessing. |
| `scripts/lib/draft.mjs` (new) | CLI core: draft state file, folder scan and hashing, MIME map, change detection, blob upload, and the five verbs as functions over an injected client. |
| `scripts/open.mjs`, `scripts/save.mjs`, `scripts/land.mjs`, `scripts/sync.mjs`, `scripts/close.mjs` (new) | Thin command entry points. |
| `scripts/cli.mjs` (modify) | Route the five verbs. |
| `test/unit-core.test.mjs`, `test/unit-object.test.mjs`, `test/unit-api.test.mjs`, `test/unit-serve.test.mjs`, `test/merge3.test.mjs`, `test/draft-lib.test.mjs`, `test/drafts-drill.test.mjs` (new) | One test file per unit above, plus the two-session drill over the real worker. |
| `test/fixtures/unit-env.mjs` (new) | A bundle-mode env with a memory store, a memory KV holding a publish token, and a `UNITS` namespace running the real `UnitObject` over `node:sqlite`. Shared by the api, serve and drill tests. |

---

### Task 1: The pure core (`src/unit-core.mjs`)

**Files:**
- Create: `src/unit-core.mjs`
- Test: `test/unit-core.test.mjs`

**Interfaces:**
- Produces:
  - `normUnit(s) → string|null` — `"checkout/flow"` and `"/checkout/flow/"` both give `"/checkout/flow/"`; anything with `@`, `..`, or no segment gives `null`.
  - `DRAFT_ID_RE`, `newDraftId(random = Math.random) → string` (six base-36 chars).
  - `draftAddress(unit, id) → string` — `"/checkout/flow/@k7f3q1/"`.
  - `splitDraftPath(pathname) → {unit, id, rest}|null` — `rest` always starts with `/`.
  - `unitTable(files, unit) → table` — the manifest entries under `unit`, each `{h, ct, s, by?, editedAt?}`.
  - `sameTable(a, b) → boolean` — same paths, same hashes.
  - `applyChanges(table, changes) → {ok, table, stale}` — `changes` is `[{path, h?, ct?, s?, baseHash, delete?}]`; a change whose `baseHash` differs from the table's current hash (or `null` when absent) is `stale` and nothing is applied.
  - `tableDelta(from, to) → {changed: [{path, ...to[path]}], removed: [path]}`.
  - `presenceOf(drafts, nowMs) → [{id, owner, session, openedAt, lastSaveAt, active}]` — open drafts only.
  - `ACTIVE_MS = 300000`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit-core.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normUnit, newDraftId, draftAddress, splitDraftPath, unitTable, sameTable,
  applyChanges, tableDelta, presenceOf, ACTIVE_MS, DRAFT_ID_RE,
} from "../src/unit-core.mjs";

test("normUnit spells a unit the way publicPrefixes does", () => {
  assert.equal(normUnit("checkout/flow"), "/checkout/flow/");
  assert.equal(normUnit("/checkout/flow/"), "/checkout/flow/");
  assert.equal(normUnit("//checkout//flow"), "/checkout/flow/");
  assert.equal(normUnit(""), null);
  assert.equal(normUnit("/"), null);
  assert.equal(normUnit("/a/@k7f3q1/"), null);
  assert.equal(normUnit("/a/../b/"), null);
});

test("draft ids are six base-36 characters and addresses carry them", () => {
  const id = newDraftId(() => 0.5);
  assert.match(id, DRAFT_ID_RE);
  assert.equal(draftAddress("/checkout/flow/", "k7f3q1"), "/checkout/flow/@k7f3q1/");
});

test("splitDraftPath finds the unit, the id and the rest", () => {
  assert.deepEqual(splitDraftPath("/checkout/flow/@k7f3q1/"), { unit: "/checkout/flow/", id: "k7f3q1", rest: "/" });
  assert.deepEqual(splitDraftPath("/checkout/flow/@k7f3q1/css/a.css"), { unit: "/checkout/flow/", id: "k7f3q1", rest: "/css/a.css" });
  assert.deepEqual(splitDraftPath("/checkout/flow/@k7f3q1"), { unit: "/checkout/flow/", id: "k7f3q1", rest: "/" });
  assert.equal(splitDraftPath("/checkout/flow/"), null);
  assert.equal(splitDraftPath("/@k7f3q1/"), null);
  assert.equal(splitDraftPath("/checkout/flow/@TOOLONGID/"), null);
});

test("unitTable takes the unit's files and nothing else", () => {
  const files = {
    "/checkout/flow/index.html": { h: "a".repeat(64), ct: "text/html", s: 10, by: "p1", editedAt: "2026-09-01T00:00:00.000Z" },
    "/checkout/flow/a.css": { h: "b".repeat(64), ct: "text/css", s: 3 },
    "/checkout/other/index.html": { h: "c".repeat(64), ct: "text/html", s: 5 },
    "/checkout/flowers/index.html": { h: "d".repeat(64), ct: "text/html", s: 5 },
  };
  const t = unitTable(files, "/checkout/flow/");
  assert.deepEqual(Object.keys(t).sort(), ["/checkout/flow/a.css", "/checkout/flow/index.html"]);
  assert.equal(t["/checkout/flow/index.html"].by, "p1");
  assert.equal(t["/checkout/flow/a.css"].by, undefined);
});

test("sameTable compares paths and hashes only", () => {
  const a = { "/u/x": { h: "1", ct: "a", s: 1 } };
  assert.equal(sameTable(a, { "/u/x": { h: "1", ct: "b", s: 9, by: "z" } }), true);
  assert.equal(sameTable(a, { "/u/x": { h: "2", ct: "a", s: 1 } }), false);
  assert.equal(sameTable(a, { "/u/x": { h: "1", ct: "a", s: 1 }, "/u/y": { h: "3", ct: "a", s: 1 } }), false);
  assert.equal(sameTable({}, {}), true);
});

test("applyChanges refuses a stale base and applies nothing", () => {
  const table = { "/u/index.html": { h: "old", ct: "text/html", s: 3 } };
  const r = applyChanges(table, [
    { path: "/u/index.html", h: "new", ct: "text/html", s: 4, baseHash: "not-old" },
    { path: "/u/b.css", h: "css", ct: "text/css", s: 1, baseHash: null },
  ]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.stale, [{ path: "/u/index.html", h: "old" }]);
  assert.deepEqual(r.table, table, "nothing applied");
});

test("applyChanges applies adds, edits and deletes against matching bases", () => {
  const table = { "/u/index.html": { h: "old", ct: "text/html", s: 3 }, "/u/gone.js": { h: "g", ct: "application/javascript", s: 1 } };
  const r = applyChanges(table, [
    { path: "/u/index.html", h: "new", ct: "text/html", s: 4, baseHash: "old" },
    { path: "/u/b.css", h: "css", ct: "text/css", s: 1, baseHash: null },
    { path: "/u/gone.js", baseHash: "g", delete: true },
  ]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.table, {
    "/u/index.html": { h: "new", ct: "text/html", s: 4 },
    "/u/b.css": { h: "css", ct: "text/css", s: 1 },
  });
  assert.deepEqual(table["/u/gone.js"], { h: "g", ct: "application/javascript", s: 1 }, "input untouched");
});

test("applyChanges treats a delete of an absent file as stale", () => {
  const r = applyChanges({}, [{ path: "/u/x", baseHash: "h", delete: true }]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.stale, [{ path: "/u/x", h: null }]);
});

test("tableDelta names changed and removed paths with the target's metadata", () => {
  const from = { "/u/a": { h: "1", ct: "t", s: 1 }, "/u/b": { h: "2", ct: "t", s: 1 }, "/u/c": { h: "3", ct: "t", s: 1 } };
  const to = { "/u/a": { h: "1", ct: "t", s: 1 }, "/u/b": { h: "9", ct: "t", s: 2, by: "p" }, "/u/d": { h: "4", ct: "t", s: 1 } };
  assert.deepEqual(tableDelta(from, to), {
    changed: [{ path: "/u/b", h: "9", ct: "t", s: 2, by: "p" }, { path: "/u/d", h: "4", ct: "t", s: 1 }],
    removed: ["/u/c"],
  });
});

test("presenceOf derives active from the last save and hides closed drafts", () => {
  const now = Date.parse("2026-09-04T12:00:00.000Z");
  const drafts = [
    { id: "aaaaaa", owner: "p1", session: "s1", openedAt: "2026-09-04T11:00:00.000Z", lastSaveAt: "2026-09-04T11:58:00.000Z" },
    { id: "bbbbbb", owner: "p2", session: "s2", openedAt: "2026-09-04T11:00:00.000Z", lastSaveAt: null },
    { id: "cccccc", owner: "p3", session: "s3", openedAt: "2026-09-04T11:59:30.000Z", lastSaveAt: null },
    { id: "dddddd", owner: "p4", session: "s4", openedAt: "2026-09-04T11:59:30.000Z", lastSaveAt: null, closedAt: "2026-09-04T11:59:40.000Z" },
  ];
  const p = presenceOf(drafts, now);
  assert.deepEqual(p.map((d) => [d.id, d.active]), [["aaaaaa", true], ["bbbbbb", false], ["cccccc", true]]);
  assert.equal(ACTIVE_MS, 5 * 60 * 1000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit-core.test.mjs`
Expected: FAIL — `Cannot find module '../src/unit-core.mjs'`.

- [ ] **Step 3: Write the implementation**

```js
// src/unit-core.mjs — the pure half of drafts that land.
//
// A UNIT is a prototype folder, spelled as its URL prefix with a leading and a trailing
// slash, exactly as `routing.publicPrefixes` spells it. A DRAFT is one session's live
// working copy of a unit, addressed at `<unit>@<id>/`. Everything here is a decision over
// plain objects: the Durable Object, the worker and the CLI all import it, and none of them
// re-derive what a unit, a draft or a stale save is. See docs/drafts-that-land.md.
//
// ⚠️ NO NODE IMPORTS. The worker and the Durable Object run this too.

export const ACTIVE_MS = 5 * 60_000;
export const DRAFT_ID_RE = /^[a-z0-9]{6}$/;
// A draft address: one or more path segments, then `@` + six chars, then the rest.
const DRAFT_PATH_RE = /^(\/(?:[^/@][^/]*\/)+)@([a-z0-9]{6})(\/.*)?$/;

/** `"checkout/flow"` → `"/checkout/flow/"`; null for anything that is not a unit path. */
export function normUnit(s) {
  const raw = String(s == null ? "" : s).trim().replace(/\/{2,}/g, "/");
  const segs = raw.split("/").filter(Boolean);
  if (!segs.length) return null;
  for (const seg of segs) if (seg === "." || seg === ".." || seg.startsWith("@")) return null;
  return "/" + segs.join("/") + "/";
}

export function newDraftId(random = Math.random) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(random() * alphabet.length) % alphabet.length];
  return out;
}

export const draftAddress = (unit, id) => `${unit}@${id}/`;

export function splitDraftPath(pathname) {
  const m = DRAFT_PATH_RE.exec(String(pathname || ""));
  if (!m) return null;
  return { unit: m[1], id: m[2], rest: m[3] || "/" };
}

/** The manifest's entries under `unit`, with only the fields a table carries. */
export function unitTable(files, unit) {
  const out = {};
  for (const [p, f] of Object.entries(files || {})) {
    if (!p.startsWith(unit) || !f) continue;
    const row = { h: f.h, ct: f.ct, s: f.s };
    if (f.by) row.by = f.by;
    if (f.editedAt) row.editedAt = f.editedAt;
    out[p] = row;
  }
  return out;
}

export function sameTable(a, b) {
  const ka = Object.keys(a || {}), kb = Object.keys(b || {});
  if (ka.length !== kb.length) return false;
  return ka.every((p) => b[p] && b[p].h === a[p].h);
}

/**
 * Apply a save's changes with per-file compare-and-set. All or nothing: one stale base
 * refuses the whole batch, and the caller gets the current hash of every stale file.
 */
export function applyChanges(table, changes) {
  const stale = [];
  for (const c of changes || []) {
    const cur = table[c.path];
    const curHash = cur ? cur.h : null;
    const base = c.baseHash == null ? null : c.baseHash;
    if (base !== curHash) stale.push({ path: c.path, h: curHash });
  }
  if (stale.length) return { ok: false, table, stale };
  const next = { ...table };
  for (const c of changes || []) {
    if (c.delete) delete next[c.path];
    else next[c.path] = { h: c.h, ct: c.ct, s: c.s };
  }
  return { ok: true, table: next, stale: [] };
}

/** What `to` has that `from` does not: changed/added with `to`'s metadata, and removed paths. */
export function tableDelta(from, to) {
  const changed = [], removed = [];
  for (const [p, f] of Object.entries(to || {})) {
    if (!from[p] || from[p].h !== f.h) changed.push({ path: p, ...f });
  }
  for (const p of Object.keys(from || {})) if (!to[p]) removed.push(p);
  changed.sort((a, b) => a.path.localeCompare(b.path));
  removed.sort();
  return { changed, removed };
}

/** Open drafts, each with `active` derived from its last save (or its opening). */
export function presenceOf(drafts, nowMs) {
  return (drafts || [])
    .filter((d) => !d.closedAt)
    .map((d) => {
      const last = Date.parse(d.lastSaveAt || d.openedAt || "") || 0;
      return {
        id: d.id, owner: d.owner, session: d.session || "", openedAt: d.openedAt,
        lastSaveAt: d.lastSaveAt || null, active: nowMs - last < ACTIVE_MS,
      };
    });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit-core.test.mjs`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/unit-core.mjs test/unit-core.test.mjs
git commit -m "units: the pure core of drafts that land

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The unit Durable Object (`src/unit-object.mjs`)

**Files:**
- Create: `src/unit-object.mjs`
- Test: `test/unit-object.test.mjs`

**Interfaces:**
- Consumes: everything from Task 1.
- Produces: `export class UnitObject`, `export const UNIT_SCHEMA`, `export function applyUnitSchema(sql, workspace, unit)`, `export const LAND_LEASE_MS = 10000`. The object answers HTTP on these routes (all bodies JSON, all `at` values ISO strings supplied by the caller):
  - `POST /sync-main {workspace, unit, table, at}` → `{revision}`. Applies the schema on first touch; adopts `table` as a new main revision if it differs from the recorded main (`by: "live"`), so a landing made by the old publish path is never fought.
  - `POST /open {owner, session, at}` → `{draftId, baseRevision, table, presence}`.
  - `POST /save {draftId, draftRevision, changes, baseRevision?, at}` → `{draftRevision, table}`; `404 {error:"unknown-draft"}`; `409 {error:"stale-draft-revision", draftRevision}`; `409 {error:"stale-draft", stale}`; `400 {error:"bad-base"}` when `baseRevision` is above main.
  - `POST /land {draftId, baseRevision, at}` → `{lease, revision, table, changed, removed}`; `409 {error:"main-moved", mainRevision, changed, removed}`; `409 {error:"landing-in-progress"}`.
  - `POST /restore {revision, at}` → same shape as land, table from that landing.
  - `POST /landed {lease, draftId?, note, by, session, at, restoredFrom?}` → `{revision}`; `409 {error:"bad-lease"}`.
  - `POST /abandon-land {lease}` → `{ok:true}`.
  - `POST /sync {draftId}` → `{mainRevision, baseRevision, changed, removed}`.
  - `POST /discard {draftId, at}` → `{closed:true}`.
  - `GET /presence?at=<iso>` → `{drafts:[…]}` (presenceOf).
  - `GET /history` → `{revision, landings:[{revision, by, session, at, note, draftId, restoredFrom, files}]}` newest first.
  - `GET /draft/<id>` → `{draftId, table, owner, session, baseRevision, revision, closedAt}` or 404.
  - `GET /main` → `{revision, table}`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit-object.test.mjs
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit-object.test.mjs`
Expected: FAIL — `Cannot find module '../src/unit-object.mjs'`.

- [ ] **Step 3: Write the implementation**

```js
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

  takeLease({ draftId, table, at }) {
    const nowMs = Date.parse(at);
    const held = this.lease(nowMs);
    if (held && held.draftId !== (draftId || null)) return [409, { error: "landing-in-progress" }];
    const lease = newDraftId() + newDraftId();
    const revision = this.mainRevision() + 1;
    this.metaSet("lease", JSON.stringify({ token: lease, draftId: draftId || null, revision, until: nowMs + LAND_LEASE_MS }));
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
    return this.takeLease({ draftId, table: d.table, at });
  }

  restore({ revision, at }) {
    const l = this.landing(Number(revision));
    if (!l) return [404, { error: "unknown-revision" }];
    return this.takeLease({ draftId: null, table: JSON.parse(l.tbl), at });
  }

  landed({ lease, draftId, note, by, session, at, restoredFrom }) {
    const held = this.lease(Date.parse(at));
    if (!held || held.token !== lease) return [409, { error: "bad-lease" }];
    let table;
    if (held.draftId) {
      const d = this.draft(held.draftId);
      if (!d) return [404, { error: "unknown-draft" }];
      table = d.table;
    } else {
      const from = this.landing(Number(restoredFrom));
      if (!from) return [400, { error: "bad-restore" }];
      table = JSON.parse(from.tbl);
    }
    const revision = this.writeLanding({ table, by, session, at, note, draftId: held.draftId || draftId || null, restoredFrom });
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
      const m = /^\/draft\/([a-z0-9]{6})$/.exec(route);
      if (m) {
        const d = this.draft(m[1]);
        if (!d) return json({ error: "unknown-draft" }, 404);
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit-object.test.mjs`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/unit-object.mjs test/unit-object.test.mjs
git commit -m "units: the unit Durable Object — main, drafts, landings, lease

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Bind the object (`src/entry.js`, wrangler template, worker stub)

**Files:**
- Modify: `src/entry.js` (after the `TenantStore` export)
- Modify: `templates/shell/wrangler.example.toml` (after the `TenantStore` block, before `[vars]`)
- Modify: `src/_worker.js` — add `unitNamespace`, `unitStub`, `unitCall` directly after `tenantStub` (around line 902); import the core at the top of the file beside the other `src/` imports.
- Test: `test/unit-object.test.mjs` (extend with one entry test)

**Interfaces:**
- Produces: `unitStub(env, tenantId, unit) → stub|null` (object id is `${tenantId}:${unit}`); `unitCall(stub, route, body, method = "POST") → {status, body}`.

- [ ] **Step 1: Write the failing test**

Append to `test/unit-object.test.mjs`:

```js
test("the deploy entry exports the class so wrangler can bind it", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/entry.js", import.meta.url), "utf8");
  assert.match(src, /export \{ UnitObject \} from "\.\/unit-object\.mjs";/);
  const toml = readFileSync(new URL("../templates/shell/wrangler.example.toml", import.meta.url), "utf8");
  assert.match(toml, /name = "UNITS"/);
  assert.match(toml, /class_name = "UnitObject"/);
  assert.match(toml, /new_sqlite_classes = \["UnitObject"\]/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit-object.test.mjs`
Expected: FAIL on the new test (no such export line).

- [ ] **Step 3: Add the export, the template block and the worker helpers**

`src/entry.js`, after the `TenantStore` export:

```js
// One unit's drafts, landings and lease — see docs/drafts-that-land.md. Named here for the
// same reason as the two above: inert until a wrangler.toml binds it as UNITS.
export { UnitObject } from "./unit-object.mjs";
```

`templates/shell/wrangler.example.toml`, before `[vars]`:

```toml
# ── The unit store: drafts that land ────────────────────────────────────────────────────
#
# One Durable Object per prototype, holding its main revision, open drafts, landing history
# and the landing lease. Without it `augur open` answers 501 and nothing else changes.
# Schema and reasoning: engine/src/unit-object.mjs, design: engine/docs/drafts-that-land.md.
#
# [[durable_objects.bindings]]
# name = "UNITS"
# class_name = "UnitObject"
#
# [[migrations]]
# tag = "v2"
# new_sqlite_classes = ["UnitObject"]
```

`src/_worker.js`, top of file beside the other `./` imports:

```js
import { normUnit, splitDraftPath, unitTable, draftAddress } from "./unit-core.mjs";
```

`src/_worker.js`, directly after `tenantStub`:

```js
// ── The unit objects (drafts that land) ────────────────────────────────────────────────
// Same jurisdiction rule as the workspace object, same reason: the jurisdiction is part of
// the address, so both namespaces take it or neither does.
function unitNamespace(env) {
  const ns = env && env.UNITS;
  if (!ns) return null;
  const j = env && typeof env.TENANT_JURISDICTION === "string" ? env.TENANT_JURISDICTION.trim() : "";
  if (!j) return ns;
  if (typeof ns.jurisdiction !== "function") throw new Error(`TENANT_JURISDICTION is "${j}", but the UNITS binding cannot be restricted to a jurisdiction.`);
  return ns.jurisdiction(j);
}
/** The object for one unit of one workspace, or null on a deployment that binds none. */
function unitStub(env, tenantId, unit) {
  const ns = unitNamespace(env);
  if (!ns || !tenantId || !unit) return null;
  return ns.get(ns.idFromName(`${tenantId}:${unit}`));
}
async function unitCall(stub, route, body, method = "POST") {
  const res = await stub.fetch(`https://unit${route}`, method === "GET" ? undefined
    : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  let out = {};
  try { out = await res.json(); } catch (e) { /* a non-JSON answer is reported by status alone */ }
  return { status: res.status, body: out };
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/unit-object.test.mjs test/worker-entry.test.mjs test/tenant-jurisdiction.test.mjs`
Expected: PASS. If `tenant-jurisdiction.test.mjs` counts `idFromName` sites, it counts `TENANTS.idFromName`, and the new site is on `UNITS`; if it fails, read its assertion and add `UNITS` to whatever allowlist it keeps rather than weakening it.

- [ ] **Step 5: Commit**

```bash
git add src/entry.js templates/shell/wrangler.example.toml src/_worker.js test/unit-object.test.mjs
git commit -m "units: bind UnitObject — entry export, wrangler template, worker stub

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The unit API in the worker (`/__unit/<verb>`)

**Files:**
- Create: `test/fixtures/unit-env.mjs`
- Modify: `src/_worker.js` — new `unitApi` + `writeUnitLanding` placed directly before `async function publishApi`; one dispatch line in `handleRequest` beside the `/__publish/` line (around 11398); `FROZEN_WRITES` gains `"/__unit/"`; `__testables` gains `unitApi`.
- Test: `test/unit-api.test.mjs`

**Interfaces:**
- Consumes: `unitStub`, `unitCall` (Task 3); `normUnit`, `unitTable`, `draftAddress` (Task 1); existing `publishAuthDetailed`, `publishRefusalBody`, `capabilityRefusal`, `personId`, `loadManifests`, `bundlesFor`, `manifestCeiling`, `bytesReferencedOf`, `nextPublishVersion`, `bustManifests`, `touchWorkspaceActivity`, `jsonResponse`.
- Produces: HTTP routes, bearer-authenticated with a publish token, unit named by `body.unit` (POST) or `?unit=` (GET), session label in header `X-Augur-Session`:
  - `POST /__unit/open {unit}` → `{draftId, baseRevision, table, address, presence}`
  - `POST /__unit/save {unit, draftId, draftRevision, changes, baseRevision?}` → `{draftRevision, table}`; `409 {error:"missing-blobs", missing:[hash]}` before the object is asked.
  - `POST /__unit/land {unit, draftId, baseRevision, note}` → `{ok, revision, version, url, changed, removed}`
  - `POST /__unit/restore {unit, revision, note}` → same shape
  - `POST /__unit/sync {unit, draftId}`, `POST /__unit/discard {unit, draftId}`
  - `GET /__unit/presence?unit=`, `GET /__unit/history?unit=`, `GET /__unit/main?unit=`
  - Every verb first calls the object's `sync-main` with the live manifest's unit table.
- The fixture exports `makeEnv({live, tenantId, token}) → env` and `ctxFor(tenantId) → tctx`.

- [ ] **Step 1: Write the fixture**

```js
// test/fixtures/unit-env.mjs — a bundle-mode env for the drafts routes: memory store,
// memory KV with one publish token, and a UNITS namespace running the real UnitObject
// over node:sqlite. Shared by unit-api, unit-serve and the drill.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { UnitObject } from "../../src/unit-object.mjs";
import { __testables as W } from "../../src/_worker.js";

export const sha = (s) => createHash("sha256").update(s).digest("hex");
export const ADA = { email: "ada@example.test", name: "Ada", initials: "AD", role: "editor" };
export const ctxFor = (tenantId) => ({ ...W.applyInstance({ users: [ADA] }), tenantId });

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

export function memR2(initial = {}) {
  const store = new Map(Object.entries(initial));
  const etags = new Map([...store.keys()].map((k) => [k, "e0"]));
  let seq = 0;
  const text = (v) => typeof v === "string" ? v : (v && v.byteLength !== undefined ? new TextDecoder().decode(v) : JSON.stringify(v));
  return {
    store,
    async get(k, opts) {
      if (!store.has(k)) return null;
      const v = store.get(k);
      const bytes = new TextEncoder().encode(v);
      const slice = opts && opts.range ? bytes.slice(opts.range.offset, opts.range.offset + opts.range.length) : bytes;
      return { text: async () => v, arrayBuffer: async () => slice.buffer, body: new Blob([slice]).stream(), etag: etags.get(k) };
    },
    async put(k, v) { store.set(k, text(v)); etags.set(k, `e${++seq}`); },
    async head(k) { return store.has(k) ? { etag: etags.get(k) } : null; },
    async delete(k) { store.delete(k); },
    async list({ prefix = "", delimiter } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix));
      if (delimiter) {
        const set = new Set();
        for (const k of keys) { const i = k.indexOf(delimiter, prefix.length); if (i >= 0) set.add(k.slice(0, i + 1)); }
        return { delimitedPrefixes: [...set], objects: [], truncated: false };
      }
      return { objects: keys.map((k) => ({ key: k })), truncated: false };
    },
  };
}

export function memKV() {
  const map = new Map();
  return {
    async get(k) { return map.has(k) ? map.get(k) : null; },
    async getWithMetadata(k) { return { value: map.get(k) ?? null, metadata: null }; },
    async put(k, v) { map.set(k, typeof v === "string" ? v : JSON.stringify(v)); },
    async delete(k) { map.delete(k); },
    async list({ prefix = "" } = {}) { return { keys: [...map.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
  };
}

/** A UNITS namespace: one real object per name, each over its own in-memory database. */
export function unitsNamespace() {
  const objects = new Map();
  return {
    objects,
    idFromName: (n) => n,
    get(name) {
      if (!objects.has(name)) {
        const db = new DatabaseSync(":memory:");
        const ctx = { storage: { sql: sqlHandle(db) }, blockConcurrencyWhile: async (f) => f() };
        objects.set(name, new UnitObject(ctx, {}));
      }
      const obj = objects.get(name);
      return { fetch: (input, init) => obj.fetch(new Request(input, init)) };
    },
  };
}

export const file = (body, ct = "text/html; charset=utf-8") => ({ h: sha(body), ct, s: body.length });

export function manifestOf(version, units) {
  const files = {};
  for (const [u, entries] of Object.entries(units)) for (const [name, body] of Object.entries(entries)) {
    files[`${u}${name}`] = file(body, name.endsWith(".css") ? "text/css; charset=utf-8" : "text/html; charset=utf-8");
  }
  return {
    id: "alpha", version, format: 1,
    space: { id: "alpha", default: true, adminOnly: false, name: "Alpha" },
    source: { sha: "a".repeat(40), dirty: false },
    builtWith: { engine: "e".repeat(40), version: "0.15.0" },
    publishedAt: "2026-08-20T09:14:02.000Z", publishedBy: ADA.email,
    files, routing: { publicPrefixes: Object.keys(units), versionMap: {}, unitSources: {} },
  };
}

/** Bundle-mode env holding `live` as the alpha manifest, every blob it names, and one token. */
export async function makeEnv({ live, token = "tok", label = ADA.email, units = unitsNamespace() } = {}) {
  const objects = { "spaces/alpha/manifest.json": JSON.stringify(live) };
  for (const [p, f] of Object.entries(live.files)) objects[`blobs/${f.h}`] = bodyOf(live, p);
  const env = { GV_ASSET_SOURCE: "r2", BUNDLES: memR2(objects), COMMENTS: memKV(), UNITS: units, SESSION_SECRET: "unit-fixed-secret" };
  await env.COMMENTS.put("publish:tokens", JSON.stringify({ [await W.tokenFor(`pub:${token}`)]: { space: "alpha", label } }));
  return env;
}
// The fixture's bodies are recoverable from the manifest: `manifestOf` hashed them.
const BODIES = new Map();
export function bodyOf(live, p) { return BODIES.get(live.files[p].h) || ""; }
export function remember(body) { BODIES.set(sha(body), body); return body; }

export const liveNow = (env) => JSON.parse(env.BUNDLES.store.get("spaces/alpha/manifest.json"));
```

- [ ] **Step 2: Write the failing test**

```js
// test/unit-api.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";
import { makeEnv, ctxFor, manifestOf, remember, sha, liveNow } from "./fixtures/unit-env.mjs";

let n = 0;
const tenant = () => `unit-api-${++n}`;
const U = "/checkout/flow/";
const INDEX = remember("<h1>flow</h1>");
const CSS = remember("h1{color:red}");

const call = (ctx, env, verb, body, { method = "POST", session = "pass one", token = "tok" } = {}) => {
  const url = method === "GET"
    ? `https://x.test/__unit/${verb}?unit=${encodeURIComponent(body.unit)}`
    : `https://x.test/__unit/${verb}`;
  return W.unitApi(ctx, new Request(url, {
    method, headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", "X-Augur-Session": session },
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
  }), new URL(url), env);
};
const json = async (res) => ({ status: res.status, body: await res.json() });

async function setup() {
  const t = tenant(), ctx = ctxFor(t);
  const live = manifestOf(7, { [U]: { "index.html": INDEX, "a.css": CSS } });
  const env = await makeEnv({ live });
  W.__setTenantTestState({ memo: { at: Date.now(), tenantId: t } });
  return { ctx, env };
}

test("open needs a token, answers the live table, and names the draft address", async () => {
  const { ctx, env } = await setup();
  const refused = await json(await call(ctx, env, "open", { unit: U }, { token: "nope" }));
  assert.equal(refused.status, 403);
  const o = await json(await call(ctx, env, "open", { unit: U }));
  assert.equal(o.status, 200, JSON.stringify(o.body));
  assert.equal(o.body.baseRevision, 1);
  assert.equal(o.body.table[`${U}index.html`].h, sha(INDEX));
  assert.equal(o.body.address, `${U}@${o.body.draftId}/`);
  const p = await json(await call(ctx, env, "presence", { unit: U }, { method: "GET" }));
  assert.deepEqual(p.body.drafts.map((d) => [d.session, d.active]), [["pass one", true]]);
});

test("save refuses a change whose blob is not in the store, then accepts it", async () => {
  const { ctx, env } = await setup();
  const o = (await json(await call(ctx, env, "open", { unit: U }))).body;
  const body = "<h1>flow v2</h1>";
  const change = { path: `${U}index.html`, h: sha(body), ct: "text/html; charset=utf-8", s: body.length, baseHash: sha(INDEX) };
  const missing = await json(await call(ctx, env, "save", { unit: U, draftId: o.draftId, draftRevision: 0, changes: [change] }));
  assert.equal(missing.status, 409);
  assert.deepEqual(missing.body, { error: "missing-blobs", missing: [sha(body)] });
  await env.BUNDLES.put(`blobs/${sha(body)}`, body);
  const ok = await json(await call(ctx, env, "save", { unit: U, draftId: o.draftId, draftRevision: 0, changes: [change] }));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.draftRevision, 1);
});

test("land rewrites the space manifest for that unit only, stamps changed files, and closes the draft", async () => {
  const { ctx, env } = await setup();
  const before = liveNow(env);
  const o = (await json(await call(ctx, env, "open", { unit: U }))).body;
  const body = "<h1>flow v2</h1>";
  await env.BUNDLES.put(`blobs/${sha(body)}`, body);
  await call(ctx, env, "save", { unit: U, draftId: o.draftId, draftRevision: 0,
    changes: [{ path: `${U}index.html`, h: sha(body), ct: "text/html; charset=utf-8", s: body.length, baseHash: sha(INDEX) }] });
  const l = await json(await call(ctx, env, "land", { unit: U, draftId: o.draftId, baseRevision: 1, note: "v2" }));
  assert.equal(l.status, 200, JSON.stringify(l.body));
  assert.equal(l.body.version, 8);
  assert.equal(l.body.revision, 2);
  assert.equal(l.body.url, `https://x.test${U}`);
  const after = liveNow(env);
  assert.equal(after.version, 8);
  assert.equal(after.files[`${U}index.html`].h, sha(body));
  assert.equal(after.files[`${U}index.html`].by, W.personId("ada@example.test"));
  assert.equal(typeof after.files[`${U}index.html`].editedAt, "string");
  assert.deepEqual(after.files[`${U}a.css`], before.files[`${U}a.css`], "an untouched file keeps its entry verbatim");
  assert.deepEqual(after.routing.publicPrefixes, [U]);
  assert.equal(after.routing.unitSources[U].landed, true);
  assert.equal(env.BUNDLES.store.has("spaces/alpha/versions/8.json"), true);
  const h = await json(await call(ctx, env, "history", { unit: U }, { method: "GET" }));
  assert.deepEqual(h.body.landings.map((x) => [x.revision, x.note]), [[2, "v2"], [1, "adopted from live"]]);
});

test("a landing made by the old publish path is adopted, so the next land is refused with the delta", async () => {
  const { ctx, env } = await setup();
  const o = (await json(await call(ctx, env, "open", { unit: U }))).body;
  // somebody publishes the unit the old way: the manifest moves under the draft
  const live = liveNow(env);
  const other = "<h1>flow by publish</h1>";
  await env.BUNDLES.put(`blobs/${sha(other)}`, other);
  live.files[`${U}index.html`] = { h: sha(other), ct: "text/html; charset=utf-8", s: other.length };
  live.version = 9;
  await env.BUNDLES.put("spaces/alpha/manifest.json", JSON.stringify(live));
  const l = await json(await call(ctx, env, "land", { unit: U, draftId: o.draftId, baseRevision: 1, note: "" }));
  assert.equal(l.status, 409);
  assert.equal(l.body.error, "main-moved");
  assert.equal(l.body.mainRevision, 2);
  assert.deepEqual(l.body.changed.map((c) => [c.path, c.h]), [[`${U}index.html`, sha(other)]]);
});

test("a new unit lands into publicPrefixes", async () => {
  const { ctx, env } = await setup();
  const NEW = "/checkout/fresh/";
  const o = (await json(await call(ctx, env, "open", { unit: NEW }))).body;
  assert.deepEqual(o.table, {});
  const body = "<h1>fresh</h1>";
  await env.BUNDLES.put(`blobs/${sha(body)}`, body);
  await call(ctx, env, "save", { unit: NEW, draftId: o.draftId, draftRevision: 0,
    changes: [{ path: `${NEW}index.html`, h: sha(body), ct: "text/html; charset=utf-8", s: body.length, baseHash: null }] });
  const l = await json(await call(ctx, env, "land", { unit: NEW, draftId: o.draftId, baseRevision: o.baseRevision, note: "" }));
  assert.equal(l.status, 200, JSON.stringify(l.body));
  assert.deepEqual(liveNow(env).routing.publicPrefixes, [U, NEW]);
});

test("a bad unit, a missing store and a missing binding are each named", async () => {
  const { ctx, env } = await setup();
  const bad = await json(await call(ctx, env, "open", { unit: "/a/@zzzzzz/" }));
  assert.equal(bad.status, 400);
  const noUnits = await json(await call(ctx, { ...env, UNITS: undefined }, "open", { unit: U }));
  assert.equal(noUnits.status, 501);
  assert.equal(noUnits.body.error, "units-not-configured");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/unit-api.test.mjs`
Expected: FAIL — `W.unitApi is not a function`.

- [ ] **Step 4: Write the worker code**

In `src/_worker.js`, directly before `async function publishApi(...)`:

```js
// ── Drafts that land: /__unit/<verb> ───────────────────────────────────────────────────
// One unit's drafts, served by that unit's object. The worker does three things the object
// cannot: authenticate the caller, check that a save's blobs exist in the store, and — on a
// landing — rewrite the space manifest so every existing serve, rollback and export path
// sees the landed files as a publish. See docs/drafts-that-land.md §6.
const UNIT_API_PREFIX = "/__unit/";
const shortText = (s, n) => String(s == null ? "" : s).slice(0, n);
function defaultSpaceId(tctx) {
  const spaces = (tctx && tctx.SPACES) || [];
  return ((spaces.find((s) => s.default) || spaces[0]) || {}).id || null;
}

/**
 * Write a landed table into the live manifest as a new version. Changed files are stamped
 * with the lander; unchanged entries are carried verbatim, which is the per-file provenance
 * rule the commit handler already keeps. `unitSources` records the landing so the old
 * composed publish treats the unit as somebody's work rather than as a fast-forward.
 */
async function writeUnitLanding(tctx, env, spaceId, unit, table, who, now) {
  const bundles = bundlesFor(env, tctx.tenantId);
  const cur = (await loadManifests(tctx.tenantId, env, true))[spaceId];
  if (!cur) return { error: "unknown-space", status: 404 };
  const files = {};
  for (const [p, f] of Object.entries(cur.files || {})) if (!p.startsWith(unit)) files[p] = f;
  for (const [p, f] of Object.entries(table)) {
    const prior = (cur.files || {})[p];
    const carried = prior && prior.h === f.h && prior.by ? { by: prior.by, editedAt: prior.editedAt } : { by: who.personId, editedAt: now };
    files[p] = { h: f.h, ct: f.ct, s: f.s, ...carried };
  }
  const routing = { ...(cur.routing || {}) };
  routing.publicPrefixes = [...new Set([...(routing.publicPrefixes || []), unit])];
  routing.unitSources = { ...(routing.unitSources || {}), [unit]: { sha: null, dirty: false, landed: true, by: who.personId, at: now } };
  const m = { ...cur, files, routing };
  const ceiling = manifestCeiling(m);
  if (ceiling) return { error: "manifest-ceiling", ...ceiling, status: 413 };
  const issued = await nextPublishVersion(env, tctx, spaceId, cur);
  if (issued.error) return { error: "version-unavailable", status: 503 };
  const out = { ...m, version: issued.version, bytesReferenced: bytesReferencedOf(m), publishedAt: now, publishedBy: who.label || "" };
  await bundles.put(`spaces/${spaceId}/versions/${issued.version}.json`, JSON.stringify(out));
  await bundles.put(`spaces/${spaceId}/manifest.json`, JSON.stringify(out));
  bustManifests(tctx.tenantId); cfgAt = 0;
  touchWorkspaceActivity(env, tctx, null);
  return { version: issued.version };
}

async function unitApi(tctx, request, url, env) {
  const verb = url.pathname.slice(UNIT_API_PREFIX.length);
  if (!/^[a-z-]+$/.test(verb)) return jsonResponse({ error: "bad-path" }, 400);
  if (!env.BUNDLES) return jsonResponse({ error: "bundle-store-not-configured" }, 501);
  if (!unitNamespace(env)) return jsonResponse({ error: "units-not-configured" }, 501);
  const spaceId = defaultSpaceId(tctx);
  if (!spaceId) return jsonResponse({ error: "no-space" }, 404);
  const a = await publishAuthDetailed(tctx, request, env, spaceId, false);
  if (!a.entry) return jsonResponse(publishRefusalBody(a.refusal), 403);
  if (capabilityRefusal(a.entry, spaceId, "commit")) return jsonResponse({ error: "forbidden", reason: "capability-not-granted" }, 403);
  const who = { personId: personId(a.entry.label || ""), label: a.entry.label || "" };
  const session = shortText(request.headers.get("X-Augur-Session"), 40);

  let body = {};
  if (request.method === "POST") {
    try { body = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
  }
  const unit = normUnit(request.method === "GET" ? url.searchParams.get("unit") : body.unit);
  if (!unit) return jsonResponse({ error: "bad-unit" }, 400);
  const stub = unitStub(env, tctx.tenantId, unit);
  const now = new Date().toISOString();

  // Keep the object's main in step with what is live, every time: a landing made by the
  // old publish path is adopted as a revision, never fought.
  const live = (await loadManifests(tctx.tenantId, env, true))[spaceId] || null;
  const liveTable = unitTable((live && live.files) || {}, unit);
  const synced = await unitCall(stub, "/sync-main", { workspace: tctx.tenantId, unit, table: liveTable, at: now });
  if (synced.status !== 200) return jsonResponse({ error: "unit-unavailable" }, 503);

  if (request.method === "GET") {
    if (verb === "presence") return jsonResponse((await unitCall(stub, `/presence?at=${encodeURIComponent(now)}`, null, "GET")).body);
    if (verb === "history") return jsonResponse((await unitCall(stub, "/history", null, "GET")).body);
    if (verb === "main") return jsonResponse((await unitCall(stub, "/main", null, "GET")).body);
    return jsonResponse({ error: "unknown-verb" }, 404);
  }

  if (verb === "open") {
    const r = await unitCall(stub, "/open", { owner: who.personId, session, at: now });
    if (r.status !== 200) return jsonResponse(r.body, r.status);
    return jsonResponse({ ...r.body, address: draftAddress(unit, r.body.draftId) });
  }
  if (verb === "save") {
    const changes = Array.isArray(body.changes) ? body.changes : [];
    const missing = [];
    for (const c of changes) {
      if (c.delete || !c.h) continue;
      if (!/^[0-9a-f]{64}$/.test(c.h)) return jsonResponse({ error: "bad-hash", path: c.path }, 400);
      if (!(await env.BUNDLES.head("blobs/" + c.h))) missing.push(c.h);
    }
    if (missing.length) return jsonResponse({ error: "missing-blobs", missing: [...new Set(missing)] }, 409);
    const r = await unitCall(stub, "/save", { draftId: body.draftId, draftRevision: body.draftRevision, changes, baseRevision: body.baseRevision, at: now });
    return jsonResponse(r.body, r.status);
  }
  if (verb === "land" || verb === "restore") {
    const r = await unitCall(stub, `/${verb}`, verb === "land"
      ? { draftId: body.draftId, baseRevision: body.baseRevision, at: now }
      : { revision: body.revision, at: now });
    if (r.status !== 200) return jsonResponse(r.body, r.status);
    const written = await writeUnitLanding(tctx, env, spaceId, unit, r.body.table, who, now);
    if (written.error) {
      await unitCall(stub, "/abandon-land", { lease: r.body.lease });
      const { status, ...rest } = written;
      return jsonResponse(rest, status || 503);
    }
    const done = await unitCall(stub, "/landed", {
      lease: r.body.lease, draftId: body.draftId, note: shortText(body.note, 200), by: who.personId, session, at: now,
      ...(verb === "restore" ? { restoredFrom: body.revision } : {}),
    });
    if (done.status !== 200) return jsonResponse(done.body, done.status);
    return jsonResponse({ ok: true, revision: done.body.revision, version: written.version, url: `${url.origin}${unit}`, changed: r.body.changed, removed: r.body.removed });
  }
  if (verb === "sync" || verb === "discard") {
    const r = await unitCall(stub, `/${verb}`, { draftId: body.draftId, at: now });
    return jsonResponse(r.body, r.status);
  }
  return jsonResponse({ error: "unknown-verb" }, 404);
}
```

In `handleRequest`, directly after the `/__publish/` dispatch line:

```js
    if (url.pathname.startsWith(UNIT_API_PREFIX)) return unitApi(tctx, request, url, env);
```

In `FROZEN_WRITES`, after the `/__publish/` entry:

```js
  "/__unit/",      // open, save, land — drafts that land
```

In `__testables`, add `unitApi,` after `publishAuthDetailed,`.

- [ ] **Step 5: Run the tests**

Run: `node --test test/unit-api.test.mjs && npm test`
Expected: the six new tests PASS; the full suite stays green. If `test/frontdoor-parity.test.mjs` or `test/dist-emission-snapshot.test.mjs` reports a changed baseline because of the new import, follow that test's own instructions for refreshing its baseline in the same commit.

- [ ] **Step 6: Commit**

```bash
git add src/_worker.js test/unit-api.test.mjs test/fixtures/unit-env.mjs
git commit -m "units: /__unit/<verb> — open, save, land, restore, sync, discard, presence, history

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Serve draft addresses, member-only

**Files:**
- Modify: `src/_worker.js` — `isPublicPath` (line ~333, first statement), `assetFetch` (line ~4291: factor the blob-serving tail into `blobResponse(env, request, f)` and add the draft branch), `__testables` gains `isPublicPath` and `splitDraftPath`.
- Test: `test/unit-serve.test.mjs`

**Interfaces:**
- Consumes: `splitDraftPath` (Task 1), `unitStub`/`unitCall` (Task 3), `assetFetch` (existing, exported in `__testables`).
- Produces: `blobResponse(env, request, f) → Response` (ETag/304/Range/body, exactly the existing tail of `assetFetch`); `assetFetch` answers a draft address from the draft's table; `isPublicPath` returns `false` for any draft address.

- [ ] **Step 1: Write the failing test**

```js
// test/unit-serve.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";
import { makeEnv, ctxFor, manifestOf, remember, sha } from "./fixtures/unit-env.mjs";

let n = 0;
const U = "/checkout/flow/";
const INDEX = remember("<h1>flow</h1>");
const CSS = remember("h1{color:red}");

async function draftWithEdit() {
  const t = `unit-serve-${++n}`, ctx = ctxFor(t);
  const env = await makeEnv({ live: manifestOf(3, { [U]: { "index.html": INDEX, "a.css": CSS } }) });
  W.__setTenantTestState({ memo: { at: Date.now(), tenantId: t } });
  const api = async (verb, body) => (await W.unitApi(ctx, new Request(`https://x.test/__unit/${verb}`, {
    method: "POST", headers: { Authorization: "Bearer tok", "content-type": "application/json" }, body: JSON.stringify(body),
  }), new URL(`https://x.test/__unit/${verb}`), env)).json();
  const o = await api("open", { unit: U });
  const v2 = "<h1>flow v2</h1>";
  await env.BUNDLES.put(`blobs/${sha(v2)}`, v2);
  await api("save", { unit: U, draftId: o.draftId, draftRevision: 0,
    changes: [{ path: `${U}index.html`, h: sha(v2), ct: "text/html; charset=utf-8", s: v2.length, baseHash: sha(INDEX) }] });
  return { t, ctx, env, draftId: o.draftId, v2 };
}

test("a draft address serves the draft's bytes while the real URL serves main", async () => {
  const { t, env, draftId, v2 } = await draftWithEdit();
  const draft = await W.assetFetch(t, env, new Request(`https://x.test${U}@${draftId}/`));
  assert.equal(draft.status, 200);
  assert.equal(await draft.text(), v2);
  assert.equal(draft.headers.get("Content-Type"), "text/html; charset=utf-8");
  const main = await W.assetFetch(t, env, new Request(`https://x.test${U}`));
  assert.equal(await main.text(), INDEX);
  const css = await W.assetFetch(t, env, new Request(`https://x.test${U}@${draftId}/a.css`));
  assert.equal(await css.text(), CSS, "an untouched file resolves through the draft table too");
  const missing = await W.assetFetch(t, env, new Request(`https://x.test${U}@zzzzzz/`));
  assert.equal(missing.status, 404);
});

test("a draft address is never public, whatever the unit's own gate says", async () => {
  const { ctx, draftId } = await draftWithEdit();
  const tctx = { ...ctx, PUBLIC_PREFIXES: [U], PUBLIC_SKILL_PREFIXES: [] };
  assert.equal(W.isPublicPath(tctx, `${U}index.html`), true);
  assert.equal(W.isPublicPath(tctx, `${U}@${draftId}/index.html`), false);
  assert.equal(W.isPublicPath(tctx, `${U}@${draftId}/`), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit-serve.test.mjs`
Expected: FAIL — the draft address answers 404 and `W.isPublicPath` is not a function.

- [ ] **Step 3: Write the code**

`isPublicPath`, first statement in the function body:

```js
  // A draft address (`<unit>@<id>/…`) is a member's working copy: never public, whatever
  // the unit it hangs off is. See docs/drafts-that-land.md §6.3.
  if (splitDraftPath(pathname)) return false;
```

`assetFetch`: replace the body from `const f = r.f;` to the end of the function with a call, and add the draft branch. The result:

```js
async function assetFetch(tenantId, env, request) {
  if (!bundleMode(env)) return env.ASSETS.fetch(request);
  const url = new URL(request.url);
  // ── a draft address: the draft's table, not the manifest ─────────────────────────
  let decoded = null;
  try { decoded = decodeURIComponent(url.pathname); } catch (e) { decoded = null; }
  const d = decoded && splitDraftPath(decoded);
  if (d) {
    const stub = unitStub(env, tenantId, d.unit);
    if (!stub) return new Response("Not Found", { status: 404 });
    const r = await unitCall(stub, `/draft/${d.id}`, null, "GET");
    if (r.status !== 200 || !r.body.table) return new Response("Not Found", { status: 404 });
    const table = r.body.table;
    const rel = d.rest === "/" ? "index.html" : d.rest.slice(1);
    const f = table[d.unit + rel] || (d.rest.endsWith("/") ? table[d.unit + rel + "index.html"] : null);
    if (!f) return new Response("Not Found", { status: 404 });
    return blobResponse(env, request, f);
  }
  const manifests = await loadManifests(tenantId, env);
  const r = resolveBundlePath(manifests, url.pathname);
  if (r.redirect) return Response.redirect(new URL(r.redirect + url.search, url).toString(), 308);
  if (r.miss) return new Response("Not Found", { status: 404 });
  if (r.id === "_engine" && env.ASSETS && manifests._engine && manifests._engine.__fromAssets) {
    return env.ASSETS.fetch(request);
  }
  return blobResponse(env, request, r.f);
}

/** One manifest entry, as a response: ETag/304, byte ranges, the revalidating cache header. */
async function blobResponse(env, request, f) {
  const inm = request.headers.get("If-None-Match");
  if (inm && inm.replace(/W\/|"/g, "") === f.h) {
    return new Response(null, { status: 304, headers: { ETag: `"${f.h}"`, "Cache-Control": ASSET_REVALIDATE } });
  }
  const headers = {
    "Content-Type": f.ct, ETag: `"${f.h}"`, "Accept-Ranges": "bytes",
    "Cache-Control": ASSET_REVALIDATE,
  };
  const rm = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("Range") || "");
  if (rm && (rm[1] || rm[2])) {
    let start = rm[1] ? parseInt(rm[1], 10) : Math.max(0, f.s - parseInt(rm[2], 10));
    let end = rm[1] && rm[2] ? Math.min(parseInt(rm[2], 10), f.s - 1) : f.s - 1;
    if (start > end || start >= f.s) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${f.s}` } });
    }
    const obj = await env.BUNDLES.get("blobs/" + f.h, { range: { offset: start, length: end - start + 1 } });
    if (!obj) return new Response("Not Found", { status: 404 });
    headers["Content-Range"] = `bytes ${start}-${end}/${f.s}`;
    headers["Content-Length"] = String(end - start + 1);
    return new Response(obj.body, { status: 206, headers });
  }
  const obj = await env.BUNDLES.get("blobs/" + f.h);
  if (!obj) return new Response("Not Found", { status: 404 });
  headers["Content-Length"] = String(f.s);
  return new Response(request.method === "HEAD" ? null : obj.body, { status: 200, headers });
}
```

The body of `blobResponse` is the old tail of `assetFetch` from `const inm = …` down, character for character; only its home moves. Keep the existing header comments above `assetFetch` where they are.

In `__testables`, add `isPublicPath,` and `splitDraftPath,` after `unitApi,`.

- [ ] **Step 4: Run the tests**

Run: `node --test test/unit-serve.test.mjs test/asset-cache.test.mjs && npm test`
Expected: PASS. `asset-cache.test.mjs` pins the cache headers `blobResponse` now emits; it must stay green untouched.

- [ ] **Step 5: Commit**

```bash
git add src/_worker.js test/unit-serve.test.mjs
git commit -m "units: serve draft addresses from the draft table, members only

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Line diff and three-way merge (`scripts/lib/merge3.mjs`)

**Files:**
- Create: `scripts/lib/merge3.mjs`
- Test: `test/merge3.test.mjs`

**Interfaces:**
- Produces:
  - `diffLines(a, b) → [{aStart, aEnd, bStart, bEnd}]` — replace hunks over line arrays, `aStart..aEnd` (exclusive) in `a` replaced by `bStart..bEnd` in `b`. Insertions have `aStart === aEnd`.
  - `merge3(base, mine, theirs) → {ok, text, conflicts: [{baseStart, baseEnd, mine: string[], theirs: string[]}]}` — strings in, merged string out; `ok` is false when any hunk of mine overlaps a hunk of theirs with different content. When `ok` is false, `text` is still produced with the conflicting regions taken from `mine`.

- [ ] **Step 1: Write the failing test**

```js
// test/merge3.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { diffLines, merge3 } from "../scripts/lib/merge3.mjs";

const L = (s) => s.split("\n");

test("diffLines reports replace hunks in both coordinate systems", () => {
  assert.deepEqual(diffLines(L("a\nb\nc"), L("a\nb\nc")), []);
  assert.deepEqual(diffLines(L("a\nb\nc"), L("a\nX\nc")), [{ aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 }]);
  assert.deepEqual(diffLines(L("a\nc"), L("a\nb\nc")), [{ aStart: 1, aEnd: 1, bStart: 1, bEnd: 2 }]);
  assert.deepEqual(diffLines(L("a\nb\nc"), L("a\nc")), [{ aStart: 1, aEnd: 2, bStart: 1, bEnd: 1 }]);
  assert.deepEqual(diffLines(L("a\nb\nc\nd\ne"), L("A\nb\nc\nd\nE")), [
    { aStart: 0, aEnd: 1, bStart: 0, bEnd: 1 }, { aStart: 4, aEnd: 5, bStart: 4, bEnd: 5 },
  ]);
});

test("non-overlapping edits from both sides merge", () => {
  const base = "<h1>t</h1>\n<p>one</p>\n<p>two</p>\n<p>three</p>\n<footer/>";
  const mine = base.replace("<p>one</p>", "<p>ONE</p>");
  const theirs = base.replace("<footer/>", "<footer>x</footer>");
  const r = merge3(base, mine, theirs);
  assert.equal(r.ok, true);
  assert.equal(r.text, "<h1>t</h1>\n<p>ONE</p>\n<p>two</p>\n<p>three</p>\n<footer>x</footer>");
  assert.deepEqual(r.conflicts, []);
});

test("identical edits on both sides merge once", () => {
  const base = "a\nb\nc";
  const r = merge3(base, "a\nB\nc", "a\nB\nc");
  assert.equal(r.ok, true);
  assert.equal(r.text, "a\nB\nc");
});

test("one side unchanged takes the other side verbatim", () => {
  const base = "a\nb\nc";
  assert.equal(merge3(base, base, "a\nb\nc\nd").text, "a\nb\nc\nd");
  assert.equal(merge3(base, "z\na\nb\nc", base).text, "z\na\nb\nc");
});

test("overlapping edits are a conflict, reported with both versions and mine kept in the text", () => {
  const base = "a\nb\nc\nd";
  const r = merge3(base, "a\nMINE\nc\nd", "a\nTHEIRS\nc\nd");
  assert.equal(r.ok, false);
  assert.deepEqual(r.conflicts, [{ baseStart: 1, baseEnd: 2, mine: ["MINE"], theirs: ["THEIRS"] }]);
  assert.equal(r.text, "a\nMINE\nc\nd");
});

test("insertions at the same point conflict, adjacent edits do not", () => {
  const same = merge3("a\nb", "a\nX\nb", "a\nY\nb");
  assert.equal(same.ok, false);
  const adjacent = merge3("a\nb\nc\nd", "A\nb\nc\nd", "a\nB\nc\nd");
  assert.equal(adjacent.ok, true);
  assert.equal(adjacent.text, "A\nB\nc\nd");
});

test("a trailing newline survives", () => {
  const r = merge3("a\nb\n", "a\nb\nc\n", "a\nb\n");
  assert.equal(r.text, "a\nb\nc\n");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/merge3.test.mjs`
Expected: FAIL — `Cannot find module '../scripts/lib/merge3.mjs'`.

- [ ] **Step 3: Write the implementation**

```js
// merge3.mjs — line diff and three-way merge, for `augur sync`.
//
// The server never merges (docs/drafts-that-land.md). What the CLI may do, on the agent's
// own disk and for the agent to check, is fold a landing on main into a draft where the two
// sets of changes touch DIFFERENT lines. Where they touch the same lines it stops and says
// so — both versions are handed over, nothing is guessed.
//
// Plain Node, no dependencies. The diff trims the common prefix and suffix first — an
// agent's edit is a few hunks in a mostly identical file — and runs a plain longest-common-
// subsequence table over what is left. A middle region too large for the table (a rewrite,
// not an edit) becomes ONE hunk: coarser, so it conflicts more readily, and never wrong.

/** Cells the LCS table may hold before the middle is treated as one hunk (2000 × 2000). */
export const LCS_CELLS = 4_000_000;

/** Replace hunks turning `a` into `b`, both arrays of lines. */
export function diffLines(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf), B = b.slice(pre, b.length - suf);
  return hunksLCS(A, B).map((h) => ({ aStart: h.aStart + pre, aEnd: h.aEnd + pre, bStart: h.bStart + pre, bEnd: h.bEnd + pre }));
}

function hunksLCS(a, b) {
  const N = a.length, M = b.length;
  if (!N && !M) return [];
  if (!N) return [{ aStart: 0, aEnd: 0, bStart: 0, bEnd: M }];
  if (!M) return [{ aStart: 0, aEnd: N, bStart: 0, bEnd: 0 }];
  if (N * M > LCS_CELLS) return [{ aStart: 0, aEnd: N, bStart: 0, bEnd: M }];
  // dp[i][j] = length of the longest common subsequence of a[i..] and b[j..]
  const dp = new Array(N + 1);
  for (let i = 0; i <= N; i++) dp[i] = new Uint32Array(M + 1);
  for (let i = N - 1; i >= 0; i--) {
    for (let j = M - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const hunks = [];
  let i = 0, j = 0, open = null;
  const close = () => { if (open) { open.aEnd = i; open.bEnd = j; hunks.push(open); open = null; } };
  while (i < N || j < M) {
    if (i < N && j < M && a[i] === b[j]) { close(); i++; j++; continue; }
    if (!open) open = { aStart: i, aEnd: i, bStart: j, bEnd: j };
    if (j < M && (i >= N || dp[i][j + 1] >= dp[i + 1][j])) j++; // a line of b is inserted
    else i++;                                                    // a line of a is deleted
  }
  close();
  return hunks;
}

const split = (s) => {
  const lines = String(s).split("\n");
  const trailing = lines[lines.length - 1] === "";
  if (trailing) lines.pop();
  return { lines, trailing };
};

/** Three-way merge of strings. Overlaps are conflicts, never guesses. */
export function merge3(base, mine, theirs) {
  const B = split(base), A = split(mine), C = split(theirs);
  const ha = diffLines(B.lines, A.lines).map((h) => ({ ...h, side: "mine", lines: A.lines.slice(h.bStart, h.bEnd) }));
  const hc = diffLines(B.lines, C.lines).map((h) => ({ ...h, side: "theirs", lines: C.lines.slice(h.bStart, h.bEnd) }));
  const out = [];
  const conflicts = [];
  let pos = 0;
  let i = 0, j = 0;
  const overlaps = (p, q) => p.aStart < q.aEnd && q.aStart < p.aEnd || (p.aStart === p.aEnd && q.aStart === q.aEnd && p.aStart === q.aStart);
  const same = (p, q) => p.aStart === q.aStart && p.aEnd === q.aEnd && p.lines.length === q.lines.length && p.lines.every((l, k) => l === q.lines[k]);
  while (i < ha.length || j < hc.length) {
    const p = ha[i], q = hc[j];
    let take, region;
    if (p && q && overlaps(p, q)) {
      // Grow the region until neither side overlaps it any further.
      let start = Math.min(p.aStart, q.aStart), end = Math.max(p.aEnd, q.aEnd);
      let ii = i + 1, jj = j + 1;
      for (;;) {
        let grew = false;
        while (ii < ha.length && ha[ii].aStart < end) { end = Math.max(end, ha[ii].aEnd); ii++; grew = true; }
        while (jj < hc.length && hc[jj].aStart < end) { end = Math.max(end, hc[jj].aEnd); jj++; grew = true; }
        if (!grew) break;
      }
      const mineLines = applyHunks(B.lines, ha.slice(i, ii), start, end);
      const theirLines = applyHunks(B.lines, hc.slice(j, jj), start, end);
      const identical = mineLines.length === theirLines.length && mineLines.every((l, k) => l === theirLines[k]);
      if (!identical) conflicts.push({ baseStart: start, baseEnd: end, mine: mineLines, theirs: theirLines });
      take = mineLines; region = { aStart: start, aEnd: end };
      i = ii; j = jj;
    } else if (!q || (p && p.aStart <= q.aStart)) {
      take = p.lines; region = p; i++;
    } else {
      take = q.lines; region = q; j++;
    }
    out.push(...B.lines.slice(pos, region.aStart), ...take);
    pos = region.aEnd;
  }
  out.push(...B.lines.slice(pos));
  const trailing = A.trailing || C.trailing;
  return { ok: conflicts.length === 0, text: out.join("\n") + (trailing ? "\n" : ""), conflicts };
}

/** The lines `base[start..end)` become after applying `hunks` (all inside that range). */
function applyHunks(base, hunks, start, end) {
  const out = [];
  let pos = start;
  for (const h of hunks) {
    out.push(...base.slice(pos, h.aStart), ...h.lines);
    pos = h.aEnd;
  }
  out.push(...base.slice(pos, end));
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/merge3.test.mjs`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/merge3.mjs test/merge3.test.mjs
git commit -m "cli: line diff and three-way merge that reports overlaps instead of guessing

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: The CLI core (`scripts/lib/draft.mjs`)

**Files:**
- Create: `scripts/lib/draft.mjs`
- Test: `test/draft-lib.test.mjs`

**Interfaces:**
- Consumes: `merge3` (Task 6); `markPathFor` from `scripts/lib/marks.mjs` (translates a repo folder to a unit URL); `apiClient`/`target` from `scripts/lib/store.mjs` are used by the entry points, not here.
- Produces (all pure over an injected `client` where a network is involved):
  - `STATE_FILE = ".augur/draft.json"`, `THEIRS_DIR = ".augur/theirs"`, `REGISTRY = ~/.config/augur/drafts.json`.
  - `mimeOf(name) → string`.
  - `hashBytes(buf) → hex sha256`.
  - `scanFolder(dir) → {[rel]: {h, ct, s}}` — every file under `dir` except `.augur/`, relative paths with `/`.
  - `readState(dir) → state|null`, `writeState(dir, state)`; state is `{origin, space, unit, address, draftId, session, baseRevision, draftRevision, table}` where `table` is keyed by URL path.
  - `relOf(unit, urlPath) → rel`, `urlOf(unit, rel) → urlPath`.
  - `changesBetween(unit, savedTable, localScan) → changes[]` (per Task 1's `applyChanges` shape, with `baseHash` from `savedTable`).
  - `unitClient({origin, token, space, session}) → {open, save, land, sync, discard, presence, blobPut, blobGet}` — unit verbs post JSON to `/__unit/<verb>`, blobs go through `/__publish/<space>/blob/<hash>`; a non-2xx answer comes back as `{status, ...body}` rather than throwing, because a 409 is an answer.
  - State also carries `baseTable`: the main table at the draft's base revision, which `sync` merges from and advances; `table` is what the draft last saved, which `save` checks per-file bases against.
  - `registryAdd(entry)`, `registryRemove(dir)`, `registryList()` — the machine-wide list of open draft folders, written by atomic rename.
  - `doOpen({client, unit, dir, origin, space, session, now})`, `doSave({client, dir})`, `doLand({client, dir, note})`, `doSync({client, dir})`, `doClose({client, dir, discard})` — each returns a plain result object; entry points print it.

- [ ] **Step 1: Write the failing test**

```js
// test/draft-lib.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  mimeOf, hashBytes, scanFolder, readState, writeState, relOf, urlOf, changesBetween,
  doOpen, doSave, doLand, doSync, doClose, STATE_FILE, THEIRS_DIR,
} from "../scripts/lib/draft.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "augur-draft-"));
const U = "/checkout/flow/";
// Never the developer's own registry.
process.env.AUGUR_DRAFTS_REGISTRY = path.join(tmp(), "drafts.json");

/** A fake instance: main table + blobs + drafts, answering the unit routes the CLI speaks. */
function fakeInstance(mainFiles) {
  const blobs = new Map();
  const put = (body) => { blobs.set(sha(body), body); return sha(body); };
  const main = {};
  for (const [rel, body] of Object.entries(mainFiles)) main[U + rel] = { h: put(body), ct: mimeOf(rel), s: body.length };
  const drafts = new Map();
  let mainRevision = 1;
  const inst = {
    blobs, drafts, get mainRevision() { return mainRevision; }, main,
    landMain(table) { Object.keys(main).forEach((k) => delete main[k]); Object.assign(main, table); mainRevision++; },
    client: {
      async open() { const id = `d${drafts.size + 1}xxxx`.slice(0, 6); drafts.set(id, { table: { ...main }, revision: 0, base: mainRevision }); return { draftId: id, baseRevision: mainRevision, table: { ...main }, address: `${U}@${id}/`, presence: [] }; },
      async save({ draftId, draftRevision, changes, baseRevision }) {
        const d = drafts.get(draftId);
        if (d.revision !== draftRevision) return { status: 409, error: "stale-draft-revision", draftRevision: d.revision };
        for (const c of changes) if (!c.delete && !blobs.has(c.h)) return { status: 409, error: "missing-blobs", missing: [c.h] };
        for (const c of changes) { if (c.delete) delete d.table[c.path]; else d.table[c.path] = { h: c.h, ct: c.ct, s: c.s }; }
        d.revision++; if (baseRevision !== undefined) d.base = baseRevision;
        return { draftRevision: d.revision, table: { ...d.table } };
      },
      async land({ draftId, baseRevision }) {
        const d = drafts.get(draftId);
        if (baseRevision !== mainRevision) return { status: 409, error: "main-moved", mainRevision, changed: Object.entries(main).map(([p, f]) => ({ path: p, ...f })), removed: [] };
        inst.landMain(d.table); return { ok: true, revision: mainRevision, version: 99, url: `https://x.test${U}` };
      },
      // Coarse on purpose: every main file is reported as changed, and the library must
      // skip the ones the draft's base already had. That is exactly what a real instance
      // returns for a file untouched on main since the base, so no shortcut can hide here.
      async sync({ draftId }) {
        const d = drafts.get(draftId);
        return { mainRevision, baseRevision: d.base, changed: Object.entries(main).map(([p, f]) => ({ path: p, ...f })), removed: [] };
      },
      async discard({ draftId }) { drafts.delete(draftId); return { closed: true }; },
      async presence() { return { drafts: [] }; },
      async blobPut(h, body) { blobs.set(h, Buffer.from(body).toString()); },
      async blobGet(h) { return Buffer.from(blobs.get(h)); },
    },
  };
  return inst;
}

test("mime, hashing and path mapping", () => {
  assert.equal(mimeOf("index.html"), "text/html; charset=utf-8");
  assert.equal(mimeOf("a.css"), "text/css; charset=utf-8");
  assert.equal(mimeOf("x.webp"), "image/webp");
  assert.equal(mimeOf("blob.unknown"), "application/octet-stream");
  assert.equal(hashBytes(Buffer.from("abc")), sha("abc"));
  assert.equal(relOf(U, `${U}css/a.css`), "css/a.css");
  assert.equal(urlOf(U, "css/a.css"), `${U}css/a.css`);
});

test("scanFolder hashes every file except the state folder", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "index.html"), "<h1/>");
  fs.mkdirSync(path.join(dir, "css"));
  fs.writeFileSync(path.join(dir, "css", "a.css"), "h1{}");
  fs.mkdirSync(path.join(dir, ".augur"));
  fs.writeFileSync(path.join(dir, ".augur", "draft.json"), "{}");
  assert.deepEqual(scanFolder(dir), {
    "index.html": { h: sha("<h1/>"), ct: "text/html; charset=utf-8", s: 5 },
    "css/a.css": { h: sha("h1{}"), ct: "text/css; charset=utf-8", s: 4 },
  });
});

test("changesBetween carries the saved hash as the base, and deletes what vanished", () => {
  const saved = { [`${U}index.html`]: { h: "old", ct: "text/html; charset=utf-8", s: 1 }, [`${U}gone.js`]: { h: "g", ct: "application/javascript; charset=utf-8", s: 1 } };
  const local = { "index.html": { h: "new", ct: "text/html; charset=utf-8", s: 2 }, "b.css": { h: "b", ct: "text/css; charset=utf-8", s: 1 } };
  assert.deepEqual(changesBetween(U, saved, local), [
    { path: `${U}b.css`, h: "b", ct: "text/css; charset=utf-8", s: 1, baseHash: null },
    { path: `${U}gone.js`, baseHash: "g", delete: true },
    { path: `${U}index.html`, h: "new", ct: "text/html; charset=utf-8", s: 2, baseHash: "old" },
  ]);
  assert.deepEqual(changesBetween(U, saved, { "index.html": { h: "old", ct: "x", s: 1 }, "gone.js": { h: "g", ct: "x", s: 1 } }), []);
});

test("open materialises the unit and writes state; save pushes only what changed; land moves main", async () => {
  const inst = fakeInstance({ "index.html": "<h1>flow</h1>", "a.css": "h1{}" });
  const root = tmp();
  const dir = path.join(root, "flow");
  const opened = await doOpen({ client: inst.client, unit: U, dir, origin: "https://x.test", space: "alpha", session: "s1", now: "2026-09-04T12:00:00.000Z" });
  assert.equal(opened.address, `https://x.test${U}@${opened.draftId}/`);
  assert.equal(fs.readFileSync(path.join(dir, "index.html"), "utf8"), "<h1>flow</h1>");
  assert.equal(fs.readFileSync(path.join(dir, "a.css"), "utf8"), "h1{}");
  const st = readState(dir);
  assert.equal(st.unit, U);
  assert.equal(st.draftRevision, 0);

  fs.writeFileSync(path.join(dir, "index.html"), "<h1>flow v2</h1>");
  const saved = await doSave({ client: inst.client, dir });
  assert.deepEqual(saved.changed, ["index.html"]);
  assert.equal(inst.blobs.has(sha("<h1>flow v2</h1>")), true);
  assert.equal(readState(dir).draftRevision, 1);
  const nothing = await doSave({ client: inst.client, dir });
  assert.deepEqual(nothing.changed, []);

  const landed = await doLand({ client: inst.client, dir, note: "v2" });
  assert.equal(landed.ok, true);
  assert.equal(landed.url, `https://x.test${U}`);
  assert.equal(inst.main[`${U}index.html`].h, sha("<h1>flow v2</h1>"));
  assert.equal(readState(dir).landed, true);
});

test("a refused land is reported; sync merges a clean overlap and leaves a real one to the agent", async () => {
  const inst = fakeInstance({ "index.html": "a\nb\nc\nd", "a.css": "h1{}" });
  const root = tmp();
  const dir = path.join(root, "flow");
  await doOpen({ client: inst.client, unit: U, dir, origin: "https://x.test", space: "alpha", session: "s1", now: "2026-09-04T12:00:00.000Z" });
  // main moves: somebody lands a change to the last line of index.html and a new file
  const theirIndex = "a\nb\nc\nD";
  inst.blobs.set(sha(theirIndex), theirIndex);
  inst.blobs.set(sha("new"), "new");
  inst.landMain({ ...inst.main, [`${U}index.html`]: { h: sha(theirIndex), ct: mimeOf("index.html"), s: theirIndex.length }, [`${U}n.txt`]: { h: sha("new"), ct: mimeOf("n.txt"), s: 3 } });
  // my draft edits the first line of the same file
  fs.writeFileSync(path.join(dir, "index.html"), "A\nb\nc\nd");
  await doSave({ client: inst.client, dir });
  const refused = await doLand({ client: inst.client, dir, note: "" });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, "main-moved");

  const synced = await doSync({ client: inst.client, dir });
  assert.deepEqual(synced.merged, ["index.html"]);
  assert.deepEqual(synced.taken, ["n.txt"]);
  assert.deepEqual(synced.conflicts, []);
  assert.equal(fs.readFileSync(path.join(dir, "index.html"), "utf8"), "A\nb\nc\nD");
  assert.equal(fs.readFileSync(path.join(dir, "n.txt"), "utf8"), "new");
  assert.equal(readState(dir).baseRevision, inst.mainRevision);
  const landed = await doLand({ client: inst.client, dir, note: "" });
  assert.equal(landed.ok, true);

  // now a REAL overlap: both sides edit line one
  const dir2 = path.join(root, "flow2");
  await doOpen({ client: inst.client, unit: U, dir: dir2, origin: "https://x.test", space: "alpha", session: "s2", now: "2026-09-04T12:10:00.000Z" });
  const theirs2 = "THEIRS\nb\nc\nD";
  inst.blobs.set(sha(theirs2), theirs2);
  inst.landMain({ ...inst.main, [`${U}index.html`]: { h: sha(theirs2), ct: mimeOf("index.html"), s: theirs2.length } });
  fs.writeFileSync(path.join(dir2, "index.html"), "MINE\nb\nc\nD");
  await doSave({ client: inst.client, dir: dir2 });
  const s2 = await doSync({ client: inst.client, dir: dir2 });
  assert.deepEqual(s2.conflicts.map((c) => c.rel), ["index.html"]);
  assert.equal(fs.readFileSync(path.join(dir2, "index.html"), "utf8"), "MINE\nb\nc\nD", "mine stays in place");
  assert.equal(fs.readFileSync(path.join(dir2, THEIRS_DIR, "index.html"), "utf8"), theirs2, "theirs is beside it, outside the unit tree");
});

test("close refuses an open draft unless discarding", async () => {
  const inst = fakeInstance({ "index.html": "x" });
  const dir = path.join(tmp(), "flow");
  await doOpen({ client: inst.client, unit: U, dir, origin: "https://x.test", space: "alpha", session: "s1", now: "2026-09-04T12:00:00.000Z" });
  const kept = await doClose({ client: inst.client, dir, discard: false });
  assert.equal(kept.ok, false);
  assert.equal(fs.existsSync(dir), true);
  const gone = await doClose({ client: inst.client, dir, discard: true });
  assert.equal(gone.ok, true);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(inst.drafts.size, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/draft-lib.test.mjs`
Expected: FAIL — `Cannot find module '../scripts/lib/draft.mjs'`.

- [ ] **Step 3: Write the implementation**

```js
// draft.mjs — the CLI half of drafts that land, as functions over an injected client.
//
// Every verb here is `do<Verb>({client, dir, …}) → result`, and the entry points in
// scripts/{open,save,land,sync,close}.mjs only print the result. The client is the small
// object `unitClient` returns, so a test can stand in a fake instance and drive the whole
// loop on disk without a network. See docs/drafts-that-land.md §4 and §7.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { merge3 } from "./merge3.mjs";

export const STATE_FILE = ".augur/draft.json";
export const THEIRS_DIR = ".augur/theirs";
// The machine-wide registry of open draft folders. `AUGUR_DRAFTS_REGISTRY` exists for the
// test suite, which must never write into the developer's own home folder.
export const REGISTRY = path.join(os.homedir(), ".config", "augur", "drafts.json");
const registryPath = () => process.env.AUGUR_DRAFTS_REGISTRY || REGISTRY;

const MIME = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", css: "text/css; charset=utf-8",
  js: "application/javascript; charset=utf-8", mjs: "application/javascript; charset=utf-8",
  json: "application/json; charset=utf-8", txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8",
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
  ico: "image/x-icon", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  mp3: "audio/mpeg", mp4: "video/mp4", webm: "video/webm", pdf: "application/pdf", wasm: "application/wasm",
};
export const mimeOf = (name) => MIME[path.extname(name).slice(1).toLowerCase()] || "application/octet-stream";
export const hashBytes = (buf) => createHash("sha256").update(buf).digest("hex");
export const relOf = (unit, urlPath) => urlPath.slice(unit.length);
export const urlOf = (unit, rel) => unit + rel;

export function scanFolder(dir) {
  const out = {};
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (rel === "" && e.name === ".augur") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile()) {
        const buf = fs.readFileSync(path.join(d, e.name));
        out[r] = { h: hashBytes(buf), ct: mimeOf(e.name), s: buf.length };
      }
    }
  };
  walk(dir, "");
  return out;
}

export function readState(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), "utf8")); } catch (e) { return null; }
}
export function writeState(dir, state) {
  fs.mkdirSync(path.join(dir, ".augur"), { recursive: true });
  const p = path.join(dir, STATE_FILE);
  fs.writeFileSync(p + ".tmp", JSON.stringify(state, null, 2));
  fs.renameSync(p + ".tmp", p);
}

export function changesBetween(unit, savedTable, localScan) {
  const changes = [];
  const seen = new Set();
  for (const [rel, f] of Object.entries(localScan)) {
    const p = urlOf(unit, rel);
    seen.add(p);
    const prior = savedTable[p];
    if (prior && prior.h === f.h) continue;
    changes.push({ path: p, h: f.h, ct: f.ct, s: f.s, baseHash: prior ? prior.h : null });
  }
  for (const [p, f] of Object.entries(savedTable)) if (!seen.has(p)) changes.push({ path: p, baseHash: f.h, delete: true });
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

// ── the machine-wide registry of open draft folders ──────────────────────────
function readRegistry() {
  try { return JSON.parse(fs.readFileSync(registryPath(), "utf8")); } catch (e) { return { drafts: [] }; }
}
function writeRegistry(reg) {
  const p = registryPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p + ".tmp", JSON.stringify(reg, null, 2));
  fs.renameSync(p + ".tmp", p);
}
export function registryAdd(entry) {
  const reg = readRegistry();
  reg.drafts = reg.drafts.filter((d) => d.dir !== entry.dir).concat([entry]);
  writeRegistry(reg);
}
export function registryRemove(dir) {
  const reg = readRegistry();
  reg.drafts = reg.drafts.filter((d) => d.dir !== dir);
  writeRegistry(reg);
}
export const registryList = () => readRegistry().drafts;

// ── the client ───────────────────────────────────────────────────────────────
/**
 * `fetchJson(url, init)` is fetch with the bearer header added; the unit routes live at
 * `/__unit/<verb>` and blobs at `/__publish/<space>/blob/<hash>`. Non-2xx answers come back
 * as `{status, ...body}` rather than throwing, because a 409 is an answer, not a failure.
 */
export function unitClient({ origin, token, space, session }) {
  const headers = { Authorization: `Bearer ${token}`, "X-Augur-Session": session || "" };
  const post = async (verb, body) => {
    const r = await fetch(`${origin}/__unit/${verb}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
    const out = await r.json().catch(() => ({}));
    return r.ok ? out : { status: r.status, ...out };
  };
  const get = async (verb, unit) => {
    const r = await fetch(`${origin}/__unit/${verb}?unit=${encodeURIComponent(unit)}`, { headers });
    const out = await r.json().catch(() => ({}));
    return r.ok ? out : { status: r.status, ...out };
  };
  return {
    open: (b) => post("open", b), save: (b) => post("save", b), land: (b) => post("land", b),
    sync: (b) => post("sync", b), discard: (b) => post("discard", b), presence: (unit) => get("presence", unit),
    async blobPut(h, body) {
      const r = await fetch(`${origin}/__publish/${space}/blob/${h}`, { method: "PUT", headers, body });
      if (!r.ok && r.status !== 204) throw new Error(`blob upload failed: ${r.status}`);
    },
    async blobGet(h) {
      const r = await fetch(`${origin}/__publish/${space}/blob/${h}`, { headers });
      if (!r.ok) throw new Error(`blob fetch failed: ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    },
  };
}

// ── the verbs ────────────────────────────────────────────────────────────────
async function materialise(client, unit, table, dir) {
  for (const [p, f] of Object.entries(table)) {
    const dest = path.join(dir, relOf(unit, p));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, await client.blobGet(f.h));
  }
}

export async function doOpen({ client, unit, dir, origin, space, session, now }) {
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) return { ok: false, error: "folder-not-empty", dir };
  const o = await client.open({ unit });
  if (o.status) return { ok: false, ...o };
  fs.mkdirSync(dir, { recursive: true });
  await materialise(client, unit, o.table, dir);
  // `table` is what the DRAFT last saved (the per-file bases a save is checked against);
  // `baseTable` is what MAIN held at the draft's base revision (what a sync merges from).
  const state = { origin, space, unit, address: o.address, draftId: o.draftId, session, baseRevision: o.baseRevision, draftRevision: 0, table: o.table, baseTable: o.table, openedAt: now };
  writeState(dir, state);
  registryAdd({ dir, unit, draftId: o.draftId, origin, openedAt: now });
  const others = (o.presence || []).filter((d) => d.id !== o.draftId);
  return { ok: true, draftId: o.draftId, address: `${origin}${o.address}`, files: Object.keys(o.table).length, others };
}

export async function doSave({ client, dir, baseRevision }) {
  const st = readState(dir);
  if (!st) return { ok: false, error: "not-a-draft", dir };
  const local = scanFolder(dir);
  const changes = changesBetween(st.unit, st.table, local);
  if (!changes.length && baseRevision === undefined) return { ok: true, changed: [], draftRevision: st.draftRevision };
  for (const c of changes) if (!c.delete) await client.blobPut(c.h, fs.readFileSync(path.join(dir, relOf(st.unit, c.path))));
  const r = await client.save({ unit: st.unit, draftId: st.draftId, draftRevision: st.draftRevision, changes, ...(baseRevision !== undefined ? { baseRevision } : {}) });
  if (r.status) return { ok: false, ...r };
  st.draftRevision = r.draftRevision; st.table = r.table;
  if (baseRevision !== undefined) st.baseRevision = baseRevision;
  writeState(dir, st);
  return { ok: true, changed: changes.map((c) => relOf(st.unit, c.path)), draftRevision: r.draftRevision };
}

export async function doLand({ client, dir, note }) {
  const st = readState(dir);
  if (!st) return { ok: false, error: "not-a-draft", dir };
  const saved = await doSave({ client, dir });
  if (!saved.ok) return saved;
  const r = await client.land({ unit: st.unit, draftId: st.draftId, baseRevision: st.baseRevision, note: note || "" });
  if (r.status) return { ok: false, ...r };
  st.landed = true; st.landedRevision = r.revision;
  writeState(dir, st);
  registryRemove(dir);
  return { ok: true, url: r.url, revision: r.revision, version: r.version };
}

export async function doSync({ client, dir }) {
  const st = readState(dir);
  if (!st) return { ok: false, error: "not-a-draft", dir };
  const r = await client.sync({ unit: st.unit, draftId: st.draftId });
  if (r.status) return { ok: false, ...r };
  const local = scanFolder(dir);
  const baseTable = st.baseTable || {};
  const nextBase = { ...baseTable };
  const taken = [], merged = [], conflicts = [], kept = [];
  const isText = (ct) => /^text\//.test(ct) || /javascript|json|svg/.test(ct);
  for (const c of r.changed) {
    const rel = relOf(st.unit, c.path);
    const base = baseTable[c.path] || null;             // what main held when this draft was based
    nextBase[c.path] = { h: c.h, ct: c.ct, s: c.s };
    if (base && base.h === c.h) continue;                // main's file is what my base already had
    const mine = local[rel] || null;
    const theirBytes = await client.blobGet(c.h);
    const dest = path.join(dir, rel);
    if (!mine || (base && mine.h === base.h)) {          // I did not touch it: take theirs
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, theirBytes);
      taken.push(rel);
      continue;
    }
    if (mine.h === c.h) { kept.push(rel); continue; }    // we made the same change
    if (!base || !isText(c.ct)) {                        // no common base, or binary: theirs beside, mine stays
      writeTheirs(dir, rel, theirBytes); conflicts.push({ rel, hunks: [] }); continue;
    }
    const baseBytes = await client.blobGet(base.h);
    const m = merge3(baseBytes.toString("utf8"), fs.readFileSync(dest, "utf8"), theirBytes.toString("utf8"));
    if (m.ok) { fs.writeFileSync(dest, m.text); merged.push(rel); }
    else { writeTheirs(dir, rel, theirBytes); conflicts.push({ rel, hunks: m.conflicts }); }
  }
  for (const p of r.removed) {
    const rel = relOf(st.unit, p);
    const base = baseTable[p], mine = local[rel];
    delete nextBase[p];
    if (mine && base && mine.h === base.h) { fs.rmSync(path.join(dir, rel), { force: true }); taken.push(rel); }
    else if (mine) kept.push(rel);
  }
  // The draft is now based on main's current revision: record that base, then save the
  // merged tree against it.
  st.baseTable = nextBase;
  writeState(dir, st);
  const saved = await doSave({ client, dir, baseRevision: r.mainRevision });
  if (!saved.ok) return saved;
  return { ok: true, mainRevision: r.mainRevision, taken, merged, kept, conflicts };
}

function writeTheirs(dir, rel, bytes) {
  const dest = path.join(dir, THEIRS_DIR, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, bytes);
}

export async function doClose({ client, dir, discard }) {
  const st = readState(dir);
  if (!st) return { ok: false, error: "not-a-draft", dir };
  if (!st.landed && !discard) return { ok: false, error: "draft-still-open", draftId: st.draftId, address: st.address };
  if (!st.landed && discard) {
    const r = await client.discard({ unit: st.unit, draftId: st.draftId });
    if (r.status && r.status !== 404) return { ok: false, ...r };
  }
  registryRemove(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true, discarded: !st.landed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/draft-lib.test.mjs`
Expected: PASS, 6 tests. Note the test's fake `sync` returns every main file as `changed`; the library must treat an untouched, identical file as `kept` or `taken` without error, which the `mine.h === c.h` branch covers.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/draft.mjs test/draft-lib.test.mjs
git commit -m "cli: the draft library — open, save, land, sync, close as pure verbs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: The five commands and the router

**Files:**
- Create: `scripts/open.mjs`, `scripts/save.mjs`, `scripts/land.mjs`, `scripts/sync.mjs`, `scripts/close.mjs`
- Modify: `scripts/cli.mjs` (the `map`), `CLAUDE.md` (the "Local commands" paragraph: one sentence naming the five verbs and pointing at `docs/drafts-that-land.md`)
- Test: `test/draft-cli.test.mjs`

**Interfaces:**
- Consumes: `target`, `resolveOrigin`, `resolveToken` from `scripts/lib/store.mjs`; `markPathFor` from `scripts/lib/marks.mjs`; everything from Task 7.
- Produces: `augur open <unit> [--dir <folder>] [--session <label>]`, `augur save`, `augur land [-m note]`, `augur sync`, `augur close [--discard]`. Contract: stderr is progress, stdout's last line is the address (open) or the live URL (land), exit code is truth. `AUGUR_SESSION` env names the session; else `--session`; else `session-<pid>`.

- [ ] **Step 1: Write the failing test**

```js
// test/draft-cli.test.mjs — the entry points parse their arguments and print the contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const run = (script, args, cwd) => spawnSync(process.execPath, [path.resolve(`scripts/${script}`), ...args], { cwd, encoding: "utf8", env: { ...process.env, AUGUR_ORIGIN: "", AUGUR_TOKEN: "" } });

test("every verb is routed and refuses to run outside a draft folder with a sentence, not a stack", () => {
  const cli = fs.readFileSync("scripts/cli.mjs", "utf8");
  for (const v of ["open", "save", "land", "sync", "close"]) assert.match(cli, new RegExp(`\\b${v}: "${v}\\.mjs"`));
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "augur-cli-"));
  for (const v of ["save", "land", "sync", "close"]) {
    const r = run(`${v}.mjs`, [], dir);
    assert.equal(r.status, 1, `${v}: ${r.stderr}`);
    assert.match(r.stderr, /not a draft folder/);
    assert.doesNotMatch(r.stderr, /at .*\.mjs:\d+/, "no stack trace");
  }
});

test("open without a unit or a target says what is missing", () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "augur-cli-"));
  const r = run("open.mjs", [], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /name a prototype/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/draft-cli.test.mjs`
Expected: FAIL — the scripts do not exist.

- [ ] **Step 3: Write the five entry points and route them**

`scripts/lib/draft-entry.mjs` is not needed; each script is short. Shared preamble is repeated on purpose so each script reads alone.

`scripts/open.mjs`:

```js
#!/usr/bin/env node
// augur open <prototype> [--dir <folder>] [--session <label>]
//
// Open one prototype into a folder of its own, as a draft that is live at once at its own
// address. Prints who else is drafting it. The folder holds only that prototype's files and
// a `.augur/draft.json`; nothing else on this machine is shared with any other session.
// See docs/drafts-that-land.md §4.
import fs from "node:fs";
import path from "node:path";
import { target, buildStamp } from "./lib/store.mjs";
import { markPathFor } from "./lib/marks.mjs";
import { unitClient, doOpen } from "./lib/draft.mjs";
import { normUnit } from "../src/unit-core.mjs";

const log = (m) => console.error(`\x1b[35m[open]\x1b[0m ${m}`);
const die = (m) => { console.error(`\x1b[31m[open]\x1b[0m ${m}`); process.exit(1); };
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : null; };
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));

const raw = positional[0];
if (!raw) die("name a prototype: `augur open <opportunity>/<prototype>` (a folder path works too).");
const unit = normUnit(markPathFor(raw) || raw);
if (!unit) die(`"${raw}" is not a prototype path.`);
let origin, token;
try { ({ origin, token } = target({ needToken: true })); } catch (e) { die(e.message); }
// The space id addresses blob uploads. A folder with a space.json names it; otherwise the
// instance's own build stamp does (one workspace serves one space).
let space = null;
try { space = JSON.parse(fs.readFileSync("space.json", "utf8")).id; } catch (e) { /* not in a space folder */ }
if (!space) { try { space = Object.keys((await buildStamp(origin)).spaces || {})[0] || null; } catch (e) { /* stamp unreachable */ } }
if (!space) die("could not tell which space this instance serves — run from a folder with space.json, or set AUGUR_ORIGIN.");
const session = process.env.AUGUR_SESSION || opt("--session") || `session-${process.pid}`;
const dir = path.resolve(opt("--dir") || unit.split("/").filter(Boolean).pop());

const client = unitClient({ origin, token, space, session });
const r = await doOpen({ client, unit, dir, origin, space, session, now: new Date().toISOString() });
if (!r.ok) {
  if (r.error === "folder-not-empty") die(`${r.dir} is not empty — pick another folder with --dir.`);
  if (r.error === "units-not-configured") die("this instance does not serve drafts yet (no unit store bound).");
  die(`could not open: ${r.error || r.status}`);
}
log(`draft ${r.draftId} on ${unit} — ${r.files} file(s) in ${dir}`);
if (r.others.length) {
  log("also drafting this prototype right now:");
  for (const o of r.others) log(`  ${o.session || "someone"} (${o.active ? "active" : "idle"})`);
  log("nothing here stops you; if you both land, the second one syncs first.");
}
console.log(r.address);
```

`scripts/save.mjs`:

```js
#!/usr/bin/env node
// augur save — push every changed file in this draft folder. Live at the draft address on
// return. Exit 1 with the reason when the instance refuses. See docs/drafts-that-land.md §4.
import { resolveOrigin, resolveToken } from "./lib/store.mjs";
import { readState, unitClient, doSave } from "./lib/draft.mjs";

const die = (m) => { console.error(`\x1b[31m[save]\x1b[0m ${m}`); process.exit(1); };
const dir = process.cwd();
const st = readState(dir);
if (!st) die("not a draft folder — run `augur open <prototype>` first.");
const origin = st.origin || resolveOrigin();
const token = resolveToken(origin);
if (!token) die("no publish token — run `augur connect` once.");
const client = unitClient({ origin, token, space: st.space, session: st.session });
const r = await doSave({ client, dir });
if (!r.ok) {
  if (r.error === "stale-draft" || r.error === "stale-draft-revision") die("this draft moved under you (another process saved to it) — run `augur sync`.");
  die(`save refused: ${r.error || r.status}`);
}
if (r.changed.length) console.error(`\x1b[35m[save]\x1b[0m ${r.changed.length} file(s) live at ${origin}${st.address}`);
console.log(`${origin}${st.address}`);
```

`scripts/land.mjs`:

```js
#!/usr/bin/env node
// augur land [-m "note"] — replace the prototype's main with this draft. The real URL moves;
// its address is the last line of stdout. Refused when main moved since the draft opened:
// then `augur sync`, check the draft address, and land again. See docs/drafts-that-land.md.
import { resolveOrigin, resolveToken } from "./lib/store.mjs";
import { readState, unitClient, doLand } from "./lib/draft.mjs";

const log = (m) => console.error(`\x1b[35m[land]\x1b[0m ${m}`);
const die = (m) => { console.error(`\x1b[31m[land]\x1b[0m ${m}`); process.exit(1); };
const argv = process.argv.slice(2);
const i = argv.indexOf("-m");
const note = i > -1 ? argv[i + 1] || "" : "";
const dir = process.cwd();
const st = readState(dir);
if (!st) die("not a draft folder — run `augur open <prototype>` first.");
const origin = st.origin || resolveOrigin();
const token = resolveToken(origin);
if (!token) die("no publish token — run `augur connect` once.");
const client = unitClient({ origin, token, space: st.space, session: st.session });
const r = await doLand({ client, dir, note });
if (!r.ok) {
  if (r.error === "main-moved") {
    log(`main moved since this draft opened (now revision ${r.mainRevision}):`);
    for (const c of r.changed || []) log(`  changed  ${c.path}${c.by ? `  by ${c.by}` : ""}`);
    for (const p of r.removed || []) log(`  removed  ${p}`);
    die("run `augur sync` to fold those in, check the draft address, then `augur land` again.");
  }
  if (r.error === "landing-in-progress") die("somebody is landing this prototype right now — try again in a few seconds.");
  die(`land refused: ${r.error || r.status}`);
}
log(`landed as revision ${r.revision} (publish v${r.version})`);
console.log(r.url);
```

`scripts/sync.mjs`:

```js
#!/usr/bin/env node
// augur sync — fold what landed on main since this draft opened into the draft. One-sided
// changes are taken; a file changed on both sides is merged where the lines do not overlap
// and left to you where they do (theirs is written under .augur/theirs/). Nothing is guessed.
import { resolveOrigin, resolveToken } from "./lib/store.mjs";
import { readState, unitClient, doSync, THEIRS_DIR } from "./lib/draft.mjs";

const log = (m) => console.error(`\x1b[35m[sync]\x1b[0m ${m}`);
const die = (m) => { console.error(`\x1b[31m[sync]\x1b[0m ${m}`); process.exit(1); };
const dir = process.cwd();
const st = readState(dir);
if (!st) die("not a draft folder — run `augur open <prototype>` first.");
const origin = st.origin || resolveOrigin();
const token = resolveToken(origin);
if (!token) die("no publish token — run `augur connect` once.");
const client = unitClient({ origin, token, space: st.space, session: st.session });
const r = await doSync({ client, dir });
if (!r.ok) die(`sync refused: ${r.error || r.status}`);
for (const f of r.taken) log(`took theirs   ${f}`);
for (const f of r.merged) log(`merged        ${f}`);
for (const c of r.conflicts) {
  log(`OVERLAP       ${c.rel} — yours stays in place, theirs is at ${THEIRS_DIR}/${c.rel}`);
  for (const h of c.hunks) log(`  lines ${h.baseStart + 1}-${h.baseEnd}: yours ${JSON.stringify(h.mine.join("\n")).slice(0, 80)} · theirs ${JSON.stringify(h.theirs.join("\n")).slice(0, 80)}`);
}
log(`draft now based on revision ${r.mainRevision}${r.conflicts.length ? " — fold the overlaps in, check the draft address, then land" : " — check the draft address, then land"}`);
console.log(`${origin}${st.address}`);
if (r.conflicts.length) process.exit(2);
```

`scripts/close.mjs`:

```js
#!/usr/bin/env node
// augur close [--discard] — remove this draft folder. A landed draft closes freely; an open
// one is kept unless --discard, which also abandons the draft on the instance.
import { resolveOrigin, resolveToken } from "./lib/store.mjs";
import { readState, unitClient, doClose } from "./lib/draft.mjs";

const log = (m) => console.error(`\x1b[35m[close]\x1b[0m ${m}`);
const die = (m) => { console.error(`\x1b[31m[close]\x1b[0m ${m}`); process.exit(1); };
const discard = process.argv.includes("--discard");
const dir = process.cwd();
const st = readState(dir);
if (!st) die("not a draft folder — nothing to close here.");
const origin = st.origin || resolveOrigin();
const token = resolveToken(origin);
if (!token && !st.landed) die("no publish token — run `augur connect` once.");
const client = unitClient({ origin, token, space: st.space, session: st.session });
process.chdir("..");
const r = await doClose({ client, dir, discard });
if (!r.ok) {
  if (r.error === "draft-still-open") die(`draft ${r.draftId} has not landed — \`augur land\` first, or \`augur close --discard\` to abandon it (it stays on the instance for a while).`);
  die(`close refused: ${r.error || r.status}`);
}
log(r.discarded ? "draft abandoned and folder removed" : "folder removed");
```

`scripts/cli.mjs`: in the header comment add five lines beside `augur mark`, and in `map` add:

```js
  // Drafts that land (docs/drafts-that-land.md): one prototype, one folder, live at once.
  open: "open.mjs",
  save: "save.mjs",
  land: "land.mjs",
  sync: "sync.mjs",
  close: "close.mjs",
```

`CLAUDE.md`, in the Local commands paragraph, after the `augur mark` entry:

```
`augur open <prototype>` / `augur save` / `augur land [-m note]` / `augur sync` /
`augur close [--discard]` (drafts that land: one prototype in a folder of its own, live at
once at its draft address, landed onto the real URL by compare-and-set —
`docs/drafts-that-land.md`) ·
```

- [ ] **Step 4: Run the tests and the lints**

Run: `node --test test/draft-cli.test.mjs && npm test && npm run check`
Expected: PASS, and `check` green (`ui-copy-lint` reads CLI strings: no third-party product names, no pasteable agent prompts).

- [ ] **Step 5: Commit**

```bash
git add scripts/open.mjs scripts/save.mjs scripts/land.mjs scripts/sync.mjs scripts/close.mjs scripts/cli.mjs CLAUDE.md test/draft-cli.test.mjs
git commit -m "cli: open, save, land, sync, close

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: The drill — two sessions over the real worker

**Files:**
- Create: `test/fixtures/unit-server.mjs` (serves the real worker over HTTP with the Task 4 fixture env)
- Test: `test/drafts-drill.test.mjs`

**Interfaces:**
- Consumes: Task 4 fixture, `unitClient` and the `do*` verbs (Task 7).
- Produces: an HTTP server that answers `/__unit/*`, `/__publish/alpha/blob/*` and content paths by calling `worker.fetch` from `src/_worker.js` — so the CLI library runs the real request path end to end.

- [ ] **Step 1: Write the server fixture**

```js
// test/fixtures/unit-server.mjs — the real worker, over a socket, on the drafts env.
import http from "node:http";
import worker, { __testables as W } from "../../src/_worker.js";
import { makeEnv, ctxFor } from "./unit-env.mjs";

export async function startUnitServer({ live, tenantId }) {
  const env = await makeEnv({ live });
  const ctx = ctxFor(tenantId);
  W.__setTenantTestState({ memo: { at: Date.now(), tenantId } });
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, "https://x.test");
    const request = new Request(url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body });
    let out;
    if (url.pathname.startsWith("/__unit/")) out = await W.unitApi(ctx, request, url, env);
    else if (url.pathname.startsWith("/__publish/")) out = await W.publishApi(ctx, request, url, env);
    else out = await W.assetFetch(tenantId, env, request);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { env, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
```

If `publishApi` is not yet in `__testables`, add it there in this task (one word).

- [ ] **Step 2: Write the failing drill**

```js
// test/drafts-drill.test.mjs — the VERIFY from docs/drafts-that-land.md §11, automated:
// two sessions on one prototype; both see each other at open; both land; the second is
// refused, syncs, lands. Then a killed session resumes from its folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startUnitServer } from "./fixtures/unit-server.mjs";
import { manifestOf, remember, sha, liveNow } from "./fixtures/unit-env.mjs";
import { unitClient, doOpen, doSave, doLand, doSync, readState } from "../scripts/lib/draft.mjs";

const U = "/checkout/flow/";
const INDEX = remember("<h1>flow</h1>\n<p>one</p>\n<p>two</p>\n");
const CSS = remember("h1{color:red}\n");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "augur-drill-"));
process.env.AUGUR_DRAFTS_REGISTRY = path.join(tmp(), "drafts.json");

test("two sessions, one prototype: see each other, land, refuse, sync, land", async () => {
  const srv = await startUnitServer({ live: manifestOf(5, { [U]: { "index.html": INDEX, "a.css": CSS } }), tenantId: "drill-1" });
  try {
    const mk = (session) => unitClient({ origin: srv.origin, token: "tok", space: "alpha", session });
    const a = mk("session a"), b = mk("session b");
    const root = tmp();
    const dirA = path.join(root, "a"), dirB = path.join(root, "b");
    const oa = await doOpen({ client: a, unit: U, dir: dirA, origin: srv.origin, space: "alpha", session: "session a", now: new Date().toISOString() });
    const ob = await doOpen({ client: b, unit: U, dir: dirB, origin: srv.origin, space: "alpha", session: "session b", now: new Date().toISOString() });
    assert.equal(oa.ok, true, JSON.stringify(oa));
    assert.deepEqual(ob.others.map((o) => o.session), ["session a"], "the second opener is told about the first");

    // A edits the heading and lands. B edits the stylesheet.
    fs.writeFileSync(path.join(dirA, "index.html"), INDEX.replace("<h1>flow</h1>", "<h1>Flow</h1>"));
    await doSave({ client: a, dir: dirA });
    const draftA = await fetch(`${srv.origin}${readState(dirA).address}`);
    assert.match(await draftA.text(), /<h1>Flow<\/h1>/, "A's draft address serves A's bytes at once");
    const mainBefore = await (await fetch(`${srv.origin}${U}`)).text();
    assert.match(mainBefore, /<h1>flow<\/h1>/, "main has not moved");
    const la = await doLand({ client: a, dir: dirA, note: "heading" });
    assert.equal(la.ok, true, JSON.stringify(la));
    assert.match(await (await fetch(`${srv.origin}${U}`)).text(), /<h1>Flow<\/h1>/, "main moved on land");

    fs.writeFileSync(path.join(dirB, "a.css"), "h1{color:blue}\n");
    await doSave({ client: b, dir: dirB });
    const refused = await doLand({ client: b, dir: dirB, note: "colour" });
    assert.equal(refused.ok, false);
    assert.equal(refused.error, "main-moved");

    const synced = await doSync({ client: b, dir: dirB });
    assert.equal(synced.ok, true, JSON.stringify(synced));
    assert.deepEqual(synced.taken, ["index.html"]);
    assert.deepEqual(synced.conflicts, []);
    assert.match(fs.readFileSync(path.join(dirB, "index.html"), "utf8"), /<h1>Flow<\/h1>/);
    const lb = await doLand({ client: b, dir: dirB, note: "colour" });
    assert.equal(lb.ok, true, JSON.stringify(lb));
    const live = liveNow(srv.env);
    assert.equal(live.files[`${U}a.css`].h, sha("h1{color:blue}\n"));
    assert.match(await (await fetch(`${srv.origin}${U}`)).text(), /<h1>Flow<\/h1>/, "B's landing kept A's heading");
    assert.equal(live.version, 7, "two landings, two publish versions");
  } finally { await srv.close(); }
});

test("a killed session resumes from its folder: the draft is on the server with every save", async () => {
  const srv = await startUnitServer({ live: manifestOf(5, { [U]: { "index.html": INDEX } }), tenantId: "drill-2" });
  try {
    const c = unitClient({ origin: srv.origin, token: "tok", space: "alpha", session: "s" });
    const dir = path.join(tmp(), "flow");
    await doOpen({ client: c, unit: U, dir, origin: srv.origin, space: "alpha", session: "s", now: new Date().toISOString() });
    fs.writeFileSync(path.join(dir, "index.html"), "<h1>half done</h1>\n");
    await doSave({ client: c, dir });
    // "killed": a fresh client with no memory but the folder
    const again = unitClient({ origin: srv.origin, token: "tok", space: "alpha", session: "s" });
    const st = readState(dir);
    const r = await fetch(`${srv.origin}${st.address}`);
    assert.equal(await r.text(), "<h1>half done</h1>\n");
    const landed = await doLand({ client: again, dir, note: "" });
    assert.equal(landed.ok, true, JSON.stringify(landed));
  } finally { await srv.close(); }
});
```

- [ ] **Step 3: Run the drill**

Run: `node --test test/drafts-drill.test.mjs`
Expected: PASS, 2 tests. If the first assertion on `others` fails because presence names owners rather than sessions, the fix is in `doOpen`'s `others` mapping (Task 7), not in the drill. If the content fetch returns the login page, the fixture is routing content through the gate; it must call `assetFetch` directly as written.

- [ ] **Step 4: Run everything**

Run: `npm test && npm run check`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add test/fixtures/unit-server.mjs test/drafts-drill.test.mjs src/_worker.js
git commit -m "units: the two-session drill over the real worker

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## What this slice deliberately leaves out

Each is its own plan, in this order:

1. **Browser surfaces** — presence chips on gallery cards, the draft bar with Land and Discard, the history panel, live reload over the unit object's socket, the `?ds=` design-system overlay.
2. **Tool adapters** — `augur open` installing the deny-outside-drafts and save-after-edit hooks; `augur read`; `augur watch`; `augur status` listing drafts.
3. **Contracts** — each space's agent contract, the machine front door (`/llms.txt`, the well-known file, the machine 401) and `ship` becoming an alias that points at open and land.
4. **Derived pages server-side** and retirement of the publish client, ship, composition, evidence, forks, marks, the ship lock and the publish cache.
5. **Carrying the unit objects in a copy** — `export`, `migrate`, `restore` and the off-site backup know nothing of a unit's Durable Object, and `src/state-inventory.mjs` says so under `/__unit/` rather than leaving it unwritten. MAIN survives a copy either way: the manifest carries every landed file and `/sync-main` adopts a unit's live table as revision one on the destination, so no published byte is at risk. OPEN DRAFTS and the LANDING HISTORY do not survive, so a migration has to land or discard open drafts first. During the transition the old composed publish is safe beside a landed unit for the same reason it is safe beside anyone else's work: `unitSources` records the landing, so a stale tree's publish keeps the landed unit verbatim and forks a local edit to it — it never fast-forwards it (a landed unit records no commit, so no tree can prove itself its descendant), and it can only take it down through the explicit unpublish gate.

## Manual verify after Task 9 (on a real instance)

1. Bind `UNITS` in the hosted shell's `wrangler.toml` (the commented block), add the migration tag, deploy.
2. From two terminals in two empty folders, with a publish token each: `augur open <opportunity>/<prototype>`; confirm the second prints the first's session.
3. Edit a file in each, `augur save`, open both draft addresses in a browser signed in as a member, then signed out (expect the gate).
4. `augur land` in the first; `augur land` in the second (expect the refusal), `augur sync`, `augur land`.
5. `augur status` still reports the live version; `augur export` still walks it; `rollback` to the pre-landing version still works.
