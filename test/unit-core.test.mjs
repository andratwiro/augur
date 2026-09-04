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
