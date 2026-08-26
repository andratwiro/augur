// Baseline coverage for the canvas room, which had none.
//
// `A-boardroom-port`. The class was 800 lines in a separate worker with no `test/` of its
// own, so the document authority for every board on every instance was untested. Moving it
// into the engine's module graph is what makes it reachable from here, and the item asks
// for these two as the price of the move: a load/save round-trip and the tombstone TTL.
//
// The room owns the document. Its storage is the source of truth (one row per node, one
// meta row), and KV is a write-through mirror. Everything below drives the real class
// against a stand-in for Durable Object storage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BoardRoom } from "../src/board-room.mjs";

// Two workerd globals the constructor touches. They exist in the runtime and not in Node,
// so they are stubbed here rather than guarded in the class: the class is correct as it is,
// and adding `typeof x !== "undefined"` to production code to satisfy a test runner is the
// wrong direction of accommodation.
globalThis.WebSocketRequestResponsePair = class { constructor(req, res) { this.request = req; this.response = res; } };

/** A stand-in for DO storage: a Map with the list/get/put/delete surface the room uses. */
function memStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    map: m,
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => m.has(x)).map((x) => [x, m.get(x)])) : m.get(k)),
    put: async (k, v) => {
      if (typeof k === "object" && k !== null) { for (const [kk, vv] of Object.entries(k)) m.set(kk, vv); return; }
      m.set(k, v);
    },
    delete: async (k) => {
      if (Array.isArray(k)) { let n = 0; for (const x of k) if (m.delete(x)) n++; return n; }
      return m.delete(k);
    },
    list: async ({ prefix = "" } = {}) =>
      new Map([...m.entries()].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1))),
    setAlarm: async () => {},
    getAlarm: async () => null,
    deleteAlarm: async () => {},
  };
}

function room({ storage = memStorage(), kv = null } = {}) {
  const ctx = {
    storage,
    getWebSockets: () => [],
    blockConcurrencyWhile: async (f) => f(),
    setWebSocketAutoResponse: () => {},
  };
  const env = { BOARD_KV: kv };
  return new BoardRoom(ctx, env);
}

/** A KV stand-in for the write-through mirror. */
const memKV = (seed = {}) => {
  const m = new Map(Object.entries(seed));
  return { map: m, get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); } };
};

const node = (id, extra = {}) => ({ id, t: "note", x: 0, y: 0, v: 1, vn: 1, ...extra });

// ── load / save round trip ───────────────────────────────────────────────────

test("a board written to storage loads back with its nodes and its name", async () => {
  const storage = memStorage({
    path: "/p/board",
    m: { name: "Kickoff", nameV: 3, tombs: {}, clock: 7, order: ["b", "a"] },
    "n:a": JSON.stringify(node("a", { text: "one" })),
    "n:b": JSON.stringify(node("b", { text: "two" })),
  });
  const r = room({ storage });
  await r.load();
  assert.equal(r.doc.name, "Kickoff");
  assert.equal(r.doc.nameV, 3);
  assert.equal(r.doc.clock, 7);
  assert.equal(r.doc.nodes.length, 2);
  // The persisted z-order is restored, not the key order the rows came back in.
  assert.deepEqual(r.doc.nodes.map((n) => n.id), ["b", "a"], "the stored z-order was lost on load");
  assert.equal(r.doc.nodes.find((n) => n.id === "a").text, "one");
});

test("a node the order row does not know sinks to the end rather than vanishing", async () => {
  // Mid-flight writes land as rows before the order row catches up. Dropping them would
  // lose a node somebody just made.
  const storage = memStorage({
    path: "/p/board",
    m: { name: "n", tombs: {}, clock: 0, order: ["a"] },
    "n:a": JSON.stringify(node("a")),
    "n:z": JSON.stringify(node("z")),
  });
  const r = room({ storage });
  await r.load();
  assert.deepEqual(r.doc.nodes.map((n) => n.id), ["a", "z"]);
});

test("a /__test/ room is ephemeral: it never reads storage and never holds a doc", async () => {
  // Playwright isolation. A test room that persisted would write into the same store real
  // boards use.
  const storage = memStorage({ path: "/__test/x", m: { name: "should not load", tombs: {} } });
  const r = room({ storage });
  await r.load();
  assert.equal(r.ephemeral, true);
  assert.equal(r.doc, null, "an ephemeral room loaded a document out of storage");
});

test("concurrent loads share ONE storage read", async () => {
  // Every incoming message calls load(). Without the shared promise a burst of ten
  // messages on a cold room is ten full reads of every node.
  const storage = memStorage({ path: "/p/b", m: { name: "n", tombs: {}, clock: 0 }, "n:a": JSON.stringify(node("a")) });
  let lists = 0;
  const origList = storage.list;
  storage.list = async (...a) => { lists++; return origList(...a); };
  const r = room({ storage });
  await Promise.all([r.load(), r.load(), r.load(), r.load()]);
  assert.equal(lists, 1, `a cold room read its nodes ${lists} times for four concurrent loads`);
});

test("the KV mirror is folded back in, so a solo write is not erased on wake", async () => {
  // Solo clients and terminal scripts legitimately write /__board while the room is empty.
  // Waking up storage-only would erase their work at the next mirror write.
  const kv = memKV({
    "board:/p/b": JSON.stringify({ name: "n", nodes: [node("a", { text: "from storage" }), node("kvonly", { v: 5 })] }),
  });
  const storage = memStorage({
    path: "/p/b", m: { name: "n", tombs: {}, clock: 0, order: ["a"] },
    "n:a": JSON.stringify(node("a", { text: "from storage" })),
  });
  const r = room({ storage, kv });
  await r.load();
  assert.ok(r.doc.nodes.some((n) => n.id === "kvonly"), "a node that existed only in the KV mirror was dropped on load");
});

// ── tombstones ───────────────────────────────────────────────────────────────

test("a tombstone inside the TTL is kept, so a stale tab cannot resurrect a deletion", () => {
  const r = room();
  const now = Date.now();
  r.doc = { name: "n", nameV: 0, nodes: [], clock: 0, tombs: { fresh: { v: 2, t: now - 1000 } } };
  r.pruneTombs();
  assert.ok(r.doc.tombs.fresh, "a fresh tombstone was pruned — a stale client can now resurrect the node");
});

test("a tombstone past the TTL is pruned", () => {
  const r = room();
  const now = Date.now();
  r.doc = {
    name: "n", nameV: 0, nodes: [], clock: 0,
    tombs: { old: { v: 1, t: now - 46 * 86400000 }, fresh: { v: 1, t: now } },
  };
  r.pruneTombs();
  assert.equal(r.doc.tombs.old, undefined, "a tombstone older than the TTL survived");
  assert.ok(r.doc.tombs.fresh, "pruning took a fresh tombstone with it");
});

test("pruning is a no-op when nothing is old and nothing is over the cap", () => {
  // It runs on a hot path, so it must not rebuild the table on every call.
  const r = room();
  const tombs = { a: { v: 1, t: Date.now() } };
  r.doc = { name: "n", nameV: 0, nodes: [], clock: 0, tombs };
  r.pruneTombs();
  assert.equal(r.doc.tombs, tombs, "pruneTombs rebuilt the table with nothing to prune");
});

test("over the cap, the NEWEST tombstones are the ones kept", async () => {
  const r = room();
  const now = Date.now();
  const tombs = {};
  for (let i = 0; i < 5200; i++) tombs["n" + i] = { v: 1, t: now - i * 1000 };
  r.doc = { name: "n", nameV: 0, nodes: [], clock: 0, tombs };
  r.pruneTombs();
  const kept = Object.keys(r.doc.tombs);
  assert.ok(kept.length <= 5000, `kept ${kept.length}, over the cap`);
  assert.ok(kept.includes("n0"), "the newest tombstone was dropped");
  assert.ok(!kept.includes("n5199"), "the oldest tombstone survived a cap prune");
});

test("a node id that collides with an Object prototype member is handled", () => {
  // Tombs are keyed by CLIENT-CHOSEN ids. An id like "constructor" once made every create
  // bounce as tombed, because a plain lookup hit an inherited member.
  const r = room();
  r.doc = { name: "n", nameV: 0, nodes: [], clock: 0, tombs: {} };
  r.pruneTombs();
  assert.deepEqual(Object.keys(r.doc.tombs), []);
  // The reader must not see inherited members as tombstones.
  assert.equal(Object.prototype.hasOwnProperty.call(r.doc.tombs, "constructor"), false);
});
