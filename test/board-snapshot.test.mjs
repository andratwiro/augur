// The migration reader, driven against the REAL room class.
//
// `MIG-board-snapshot-via-ws`. The claim under test is not "a socket connects" — it is that
// what comes back off the `welcome` frame is the board as the room holds it, INCLUDING the
// edits the KV mirror has not been told about yet. So nothing here stubs a room. A real
// `BoardRoom` runs over a stand-in for Durable Object storage and a stand-in for KV, and the
// reader talks to it through a socket pair, exactly as it talks to a deployed one.
//
// The mirror is never written during these tests, and that is the fixture rather than an
// omission: `setAlarm` is a no-op here, so the 45-second dirty alarm never fires and KV
// stays at whatever it was seeded with — which is precisely the state a live board is in for
// up to 45 seconds after every edit, and precisely the state a KV-sourced migration would
// copy.
//
// ⚠️ The trap this file exists to avoid is a green run that proves nothing. A previous
// harness in this repo drove a room with a client that skipped the seed handshake: every
// frame arrived, nothing failed, and the room was doing a fraction of its work. So the
// handshake assertions below are not decoration — they are the reason a passing read here
// means anything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BoardRoom } from "../src/board-room.mjs";
import {
  roomUrl, readWelcome, checkDoc, digestDoc, compareDocs, docSummary,
  connectRoom, joinAndRead, snapshotRoom, seedRoom, measureLag, readMirror, SnapshotError,
} from "../scripts/lib/board-snapshot.mjs";

// ---- a stand-in for workerd -------------------------------------------------
// Two globals the room touches that Node does not have, plus the hibernation-API socket
// surface. Stubbed here rather than guarded in the class: the class is correct as it is.
globalThis.WebSocketRequestResponsePair = class { constructor(req, res) { this.request = req; this.response = res; } };
class UpgradeResponse { constructor(body, init = {}) { this.status = init.status; this.webSocket = init.webSocket; } }
globalThis.Response = UpgradeResponse;

/** One end of a socket. Buffers until somebody is listening — the room sends the welcome
 *  inside `fetch()`, before the caller of `fetch()` has had a chance to attach anything. */
function socketEnd() {
  const listeners = { message: [], close: [], error: [], open: [] };
  const pending = [];
  let closeEvent = null;
  const e = {
    readyState: 1,
    peer: null,
    attachment: null,
    onRemoteClose: null,
    deliver: (data) => {
      if (!listeners.message.length) { pending.push(data); return; }
      for (const fn of listeners.message.slice()) fn({ data });
    },
    addEventListener(t, fn) {
      (listeners[t] || (listeners[t] = [])).push(fn);
      if (t === "message") for (const d of pending.splice(0)) fn({ data: d });
      if (t === "close" && closeEvent) fn(closeEvent);
    },
    send(data) {
      if (e.readyState !== 1) return;
      queueMicrotask(() => e.peer.deliver(data));
    },
    close() {
      if (e.readyState === 3) return;
      e.readyState = 3;
      closeEvent = { code: 1000 };
      for (const fn of listeners.close.slice()) fn(closeEvent);
      queueMicrotask(() => e.peer.remoteClosed());
    },
    remoteClosed() {
      if (e.readyState === 3) return;
      e.readyState = 3;
      closeEvent = { code: 1006 };
      for (const fn of listeners.close.slice()) fn(closeEvent);
      if (e.onRemoteClose) e.onRemoteClose();
    },
    serializeAttachment(a) { e.attachment = a; },
    deserializeAttachment() { return e.attachment; },
  };
  return e;
}
globalThis.WebSocketPair = function WebSocketPair() {
  const client = socketEnd(), server = socketEnd();
  client.peer = server; server.peer = client;
  return { 0: client, 1: server };
};

function memStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    map: m,
    alarms: [],
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => m.has(x)).map((x) => [x, m.get(x)])) : m.get(k)),
    put: async (k, v) => {
      if (typeof k === "object" && k !== null) { for (const [kk, vv] of Object.entries(k)) m.set(kk, vv); return; }
      m.set(k, v);
    },
    delete: async (k) => { if (Array.isArray(k)) { let n = 0; for (const x of k) if (m.delete(x)) n++; return n; } return m.delete(k); },
    list: async ({ prefix = "" } = {}) => new Map([...m.entries()].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1))),
    // The alarm is NEVER fired. That is the fixture: it is what keeps KV at the value a
    // migration would have read, for the whole of the test, the way it is on a live board
    // for the whole of the 45-second cadence.
    setAlarm: async (t) => { m.set("__alarm", t); },
    getAlarm: async () => m.get("__alarm") || null,
    deleteAlarm: async () => { m.delete("__alarm"); },
  };
}
const memKV = (seed = {}) => {
  const m = new Map(Object.entries(seed));
  return { map: m, get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); } };
};

/** A live room plus the two things the reader needs to reach it: an opener and a fetch. */
function instance({ kv = memKV(), storage = memStorage() } = {}) {
  const sockets = [];
  let room;
  const ctx = {
    storage,
    getWebSockets: () => sockets.filter((s) => s.readyState !== 3),
    acceptWebSocket: (server) => {
      sockets.push(server);
      server.deliver = (data) => { room.webSocketMessage(server, data); };
      server.onRemoteClose = () => { room.webSocketClose(server); };
    },
    setWebSocketAutoResponse: () => {},
    getWebSocketAutoResponseTimestamp: () => null,
    blockConcurrencyWhile: async (f) => f(),
  };
  room = new BoardRoom(ctx, { BOARD_KV: kv });

  /** The reader's socket opener, wired to the room instead of to a network. */
  const open = (url) => {
    const facade = socketEnd();
    const outbox = [];
    let real = null;
    const send = facade.send;
    facade.send = (data) => { if (real) real.send(data); else outbox.push(data); };
    facade.close = () => { if (real) real.close(); else facade.readyState = 3; };
    void send;
    room.fetch(new Request(url)).then((res) => {
      real = res.webSocket;
      real.addEventListener("message", (ev) => facade.deliver(ev.data));
      real.addEventListener("close", (ev) => {
        facade.readyState = 3;
        for (const fn of (facade.__closeFns || [])) fn(ev);
      });
      for (const d of outbox.splice(0)) real.send(d);
    }).catch((e) => { for (const fn of (facade.__errFns || [])) fn({ message: String(e) }); });
    // route close/error listeners to arrays the async wiring above can reach
    const addEventListener = facade.addEventListener;
    facade.__closeFns = []; facade.__errFns = [];
    facade.addEventListener = (t, fn) => {
      if (t === "close") { facade.__closeFns.push(fn); return; }
      if (t === "error") { facade.__errFns.push(fn); return; }
      addEventListener(t, fn);
    };
    return facade;
  };

  /** `GET /__board` — the public rail, which serves the mirror and nothing else. */
  const fetchImpl = async (url) => {
    const u = new URL(url);
    const raw = await kv.get("board:" + u.searchParams.get("path"));
    return { ok: true, json: async () => ({ doc: raw ? JSON.parse(raw) : null }) };
  };

  return { room, kv, storage, open, fetchImpl, sockets };
}

const ORIGIN = "https://example.test";
const PATH = "/lab/board/";
const nap = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const noSleep = async () => nap();
const node = (id, extra = {}) => ({ id, t: "note", x: 0, y: 0, v: 1, vn: 100, ...extra });
const mirrorDoc = (nodes, extra = {}) => JSON.stringify({ name: "Board", nameV: 1, nodes, tombs: {}, clock: 1, ...extra });

/**
 * An editor tab: joins, stays, and can draw. Exactly what keeps a room from flushing.
 *
 * ⚠️ IT COMPLETES THE SEED HANDSHAKE, and leaving that out is the trap this file's header
 * names — the first draft of this harness did leave it out. A room that has never been
 * seeded holds `this.doc === null`, and the ops branch then RELAYS without applying: no
 * node lands, no version moves, nothing is marked dirty, and every assertion about what the
 * room holds passes vacuously because the room holds nothing and the reader honestly says
 * so. The real client seeds on `needDoc` (`canvas.js`), so this one does too.
 */
async function editor(inst, name = "editor") {
  const h = await connectRoom(inst.open, { url: roomUrl({ origin: ORIGIN, path: PATH, name }) });
  const w = readWelcome(h.welcome);
  if (w.empty) { h.send({ t: "doc", doc: { name: "Board", nameV: 1, nodes: [], tombs: {}, clock: 1 } }); await nap(); }
  return {
    handle: h,
    seededFromEmpty: w.empty,
    async draw(n) {
      h.send({ t: "ops", ops: [{ op: "upsert", node: n }] });
      await nap();
      return n;
    },
    close: () => h.close(),
  };
}

// ---- the address ------------------------------------------------------------

test("a room is addressed at the site's own front door, which is the same on both deployment shapes", () => {
  assert.equal(
    roomUrl({ origin: "https://site.example", path: "/a/b/", name: "r" }),
    "wss://site.example/__rt?path=%2Fa%2Fb%2F&name=r",
  );
  // The reader never computes a room name. Whether this deployment proxies to a standalone
  // realtime worker (room named by the bare path) or holds the rooms itself (room named
  // `<workspace>:<path>`) is decided by the worker from the request, and a reader that
  // decided it would be a second place the isolation boundary is drawn.
  const q = new URL(roomUrl({ origin: "https://site.example", path: "/a/b/" })).searchParams;
  assert.deepEqual([...q.keys()].sort(), ["name", "path"], "a path and a display name — no workspace, nothing steerable");
  assert.equal(q.get("path"), "/a/b/", "the path is sent verbatim, unprefixed");
});

test("--direct addresses a standalone realtime worker instead, and only it", () => {
  assert.equal(
    roomUrl({ origin: "https://rt.example", path: "/a/", name: "r", direct: true }),
    "wss://rt.example/room?path=%2Fa%2F&name=r",
  );
});

test("an origin given as ws(s) or http(s) names the same room", () => {
  const a = roomUrl({ origin: "https://s.example/", path: "/a/", name: "r" });
  const b = roomUrl({ origin: "wss://s.example", path: "/a/", name: "r" });
  assert.equal(a, b);
});

// ---- the handshake, which is the whole of the trust ------------------------

test("a welcome without a sid is not a completed join", () => {
  assert.throws(() => readWelcome({ t: "welcome", doc: { nodes: [] } }), (e) => e.code === "welcome-without-sid");
});

test("a welcome carrying NEITHER a doc nor needDoc is refused, never read as an empty board", () => {
  assert.throws(() => readWelcome({ t: "welcome", sid: "p1", peers: [] }), (e) => e.code === "welcome-ambiguous");
});

test("a welcome carrying BOTH is refused", () => {
  assert.throws(() => readWelcome({ t: "welcome", sid: "p1", doc: { nodes: [] }, needDoc: true }), (e) => e.code === "welcome-ambiguous");
});

test("needDoc is an ANSWER — a board nobody has drawn on reads as empty, not as a failure", async () => {
  const inst = instance();
  const r = await joinAndRead(inst.open, { url: roomUrl({ origin: ORIGIN, path: PATH }) });
  assert.equal(r.empty, true);
  assert.equal(r.doc, null);
  assert.ok(r.sid, "the join still completed");
  assert.equal(r.frames.welcome, 1);
});

test("a document with two nodes of one id is refused rather than snapshotted", () => {
  assert.throws(() => checkDoc({ nodes: [node("a"), node("a")] }), (e) => /two nodes share/.test(e.message));
});

test("tombs as an ARRAY is accepted, because that is what a real board carries", () => {
  // Found on a live board, not imagined: an older client seeded `tombs: []`, `adoptDoc`
  // kept it (an array passes `typeof x === "object"`), and every read of the map goes
  // through hasOwnProperty, so it behaves as the empty tombstone set it is. The first
  // draft of this reader refused it — and would therefore have refused the only board on
  // the instance it was pointed at.
  const doc = { name: "Real", nameV: 0, nodes: [node("a")], tombs: [], clock: 11 };
  assert.equal(checkDoc(doc), doc);
  assert.equal(docSummary(doc).tombs, 0);
  assert.equal(compareDocs(doc, { ...doc, tombs: {} }).same, true, "an empty array and an empty map are the same empty set");
  assert.throws(() => checkDoc({ nodes: [], tombs: "none" }), (e) => /neither a map nor absent/.test(e.message));
});

test("the reader NEVER seeds — a read of an empty board leaves the room with nothing in it", async () => {
  const inst = instance();
  const r = await snapshotRoom(inst.open, { origin: ORIGIN, path: PATH, sleep: noSleep, allowUnstable: true });
  assert.equal(r.empty, true);
  // Not one node row, not a meta row. A reader that answered `needDoc` the way a client does
  // would create the board it was sent to copy, and the copy would be of its own answer.
  assert.deepEqual([...inst.storage.map.keys()].filter((k) => k !== "path"), []);
});

test("a client that skips the handshake has its ops RELAYED AND NEVER APPLIED — the trap this reader must not be measured against", async () => {
  const inst = instance();
  const h = await connectRoom(inst.open, { url: roomUrl({ origin: ORIGIN, path: PATH, name: "careless" }) });
  assert.equal(readWelcome(h.welcome).empty, true, "the room asked to be seeded");
  h.send({ t: "ops", ops: [{ op: "upsert", node: node("ghost") }] }); // and it was not
  await nap();
  const ack = await h.next((m) => m.t === "docreq", 50).catch(() => null);
  assert.ok(ack, "the room asks again rather than applying — nothing failed, and nothing landed");
  assert.equal(inst.storage.map.has("n:ghost"), false);
  h.close();
});

// ---- THE VERIFY -------------------------------------------------------------

test("the reader captures an edit the KV mirror has not been told about yet", async () => {
  // A board as it stands in KV: one node, mirrored some time ago.
  const kv = memKV({ ["board:" + PATH]: mirrorDoc([node("old", { text: "mirrored" })]) });
  const inst = instance({ kv });

  // Somebody opens the board and draws. The room applies it and arms the 45s alarm; the
  // alarm never fires here, exactly as it has not yet fired on a live board for the first
  // 45 seconds after every edit.
  const ed = await editor(inst);
  await ed.draw(node("fresh", { v: 2, vn: 7, text: "drawn just now" }));

  // The mirror, read the way `GET /__board` and every state export read it.
  const mirror = await readMirror({ origin: ORIGIN, path: PATH, fetchImpl: inst.fetchImpl });
  assert.deepEqual(mirror.doc.nodes.map((n) => n.id), ["old"], "the mirror does not have the new node");

  // The reader, reading the room.
  const snap = await snapshotRoom(inst.open, { origin: ORIGIN, path: PATH, sleep: noSleep });
  assert.equal(snap.ok, true);
  assert.equal(snap.stable, true);
  assert.deepEqual(snap.doc.nodes.map((n) => n.id).sort(), ["fresh", "old"]);
  assert.equal(snap.observers.length, 2, "two independent joins agreed");
  assert.notEqual(snap.observers[0].sid, snap.observers[1].sid);

  // And the contrast, stated as the migration would have suffered it.
  const lag = await measureLag(inst.open, { origin: ORIGIN, path: PATH, fetchImpl: inst.fetchImpl, sleep: noSleep });
  assert.equal(lag.mirrorWasBehind, true);
  assert.equal(lag.wouldHaveLost.nodes, 1);
  assert.deepEqual(lag.wouldHaveLost.missing, ["fresh"]);
  assert.equal(lag.room.nodes, 2);
  assert.equal(lag.mirrorBefore.nodes, 1);
  ed.close();
});

test("a node the room holds at a HIGHER version counts as lost too, not only a missing one", async () => {
  const kv = memKV({ ["board:" + PATH]: mirrorDoc([node("a", { text: "before", v: 1, vn: 1 })]) });
  const inst = instance({ kv });
  const ed = await editor(inst);
  await ed.draw(node("a", { text: "after", v: 9, vn: 9 }));
  const lag = await measureLag(inst.open, { origin: ORIGIN, path: PATH, fetchImpl: inst.fetchImpl, sleep: noSleep });
  assert.deepEqual(lag.wouldHaveLost.missing, []);
  assert.deepEqual(lag.wouldHaveLost.stale, ["a"]);
  assert.equal(lag.wouldHaveLost.nodes, 1);
  assert.equal(lag.snapshot.doc.nodes.find((n) => n.id === "a").text, "after");
  ed.close();
});

test("a mirror that IS level reports zero, so the measure can say a KV copy would have been fine", async () => {
  const kv = memKV({ ["board:" + PATH]: mirrorDoc([node("a")]) });
  const inst = instance({ kv });
  const ed = await editor(inst); // holds the room open; nothing is drawn
  const lag = await measureLag(inst.open, { origin: ORIGIN, path: PATH, fetchImpl: inst.fetchImpl, sleep: noSleep });
  assert.equal(lag.wouldHaveLost.nodes, 0);
  assert.equal(lag.mirrorWasBehind, false);
  ed.close();
});

// ---- stability: a read taken mid-stroke is a failed read -------------------

test("a board being drawn on right now fails the read instead of being sliced in half", async () => {
  const inst = instance();
  const ed = await editor(inst);
  await ed.draw(node("a"));
  let n = 0;
  // An edit lands in every gap between the two observer joins — the exact case the two
  // observers exist to catch.
  const sleep = async () => { await ed.draw(node("n" + n++, { v: 1, vn: n })); };
  await assert.rejects(
    () => snapshotRoom(inst.open, { origin: ORIGIN, path: PATH, sleep, attempts: 2 }),
    (e) => e instanceof SnapshotError && e.code === "unstable",
  );
  ed.close();
});

test("--allow-unstable reports the read AND says it is unstable, rather than lying about it", async () => {
  const inst = instance();
  const ed = await editor(inst);
  await ed.draw(node("a"));
  let n = 0;
  const sleep = async () => { await ed.draw(node("n" + n++, { v: 1, vn: n })); };
  const snap = await snapshotRoom(inst.open, { origin: ORIGIN, path: PATH, sleep, attempts: 2, allowUnstable: true });
  assert.equal(snap.stable, false);
  assert.equal(snap.ok, false);
  assert.ok(snap.agreement.onlyInB.length > 0, "the report names what moved between the two reads");
  ed.close();
});

// ---- seeding the new room, and proving it landed ---------------------------

test("a seeded room is read back over a socket the seeder had already closed", async () => {
  const src = instance({ kv: memKV({ ["board:" + PATH]: mirrorDoc([node("old")]) }) });
  const ed = await editor(src);
  await ed.draw(node("fresh", { v: 3, vn: 3, text: "not in the mirror" }));
  const snap = await snapshotRoom(src.open, { origin: ORIGIN, path: PATH, sleep: noSleep });
  ed.close();

  const dst = instance();
  const r = await seedRoom(dst.open, { origin: "https://new.test", path: PATH, doc: snap.doc, sleep: noSleep });
  assert.equal(r.destinationWasEmpty, true);
  assert.equal(r.ok, true, "every node landed at the version it left with");
  assert.deepEqual(r.landed.nodes, 2);
  assert.deepEqual(r.comparison.onlyInA, []);
  assert.deepEqual(r.comparison.differing, []);

  // Not a claim about the reply frames: the destination's own storage holds the nodes.
  assert.ok(dst.storage.map.has("n:fresh"), "the node is in the destination room's storage");
  assert.ok(dst.storage.map.has("n:old"));
});

test("seeding a destination that already holds a board is refused unless it is asked for", async () => {
  const dst = instance({ kv: memKV({ ["board:" + PATH]: mirrorDoc([node("theirs")]) }) });
  await assert.rejects(
    () => seedRoom(dst.open, { origin: "https://new.test", path: PATH, doc: { name: "x", nameV: 1, nodes: [node("mine")], tombs: {}, clock: 1 }, sleep: noSleep }),
    (e) => e.code === "destination-not-empty",
  );
});

test("with merge, the destination reconciles and the seed's own nodes arrive", async () => {
  const dst = instance({ kv: memKV({ ["board:" + PATH]: mirrorDoc([node("theirs")]) }) });
  const doc = { name: "Board", nameV: 1, nodes: [node("mine", { v: 4, vn: 4 })], tombs: {}, clock: 1 };
  const r = await seedRoom(dst.open, { origin: "https://new.test", path: PATH, doc, merge: true, sleep: noSleep });
  assert.equal(r.destinationWasEmpty, false);
  assert.equal(r.merged, true);
  // The room keeps what it had — an absence in an offer is not a deletion — so the
  // comparison reports the extra node rather than calling the merge a failure to land.
  assert.deepEqual(r.comparison.onlyInA, []);
  assert.deepEqual(r.comparison.onlyInB, ["theirs"]);
  assert.deepEqual(r.comparison.differing, []);
  assert.equal(r.nodesLanded, true);
  assert.equal(r.identical, false, "the destination is not the source document whole, and says so");
  assert.equal(r.ok, true, "a merge is judged on whether the offer landed, not on whether the room forgot what it had");
  assert.deepEqual(r.kept.nodes, ["theirs"]);
});

test("a merge that keeps the destination's own board NAME is not a failed seed", async () => {
  // The room takes a name only when the offer's nameV beats its own. A verdict that folded
  // that in printed FAILED over "0 never arrived, 0 differ" — a report nobody can act on.
  const dst = instance({ kv: memKV({ ["board:" + PATH]: mirrorDoc([node("theirs")], { name: "Theirs", nameV: 9 }) }) });
  const doc = { name: "Mine", nameV: 1, nodes: [node("mine", { v: 4, vn: 4 })], tombs: {}, clock: 1 };
  const r = await seedRoom(dst.open, { origin: "https://new.test", path: PATH, doc, merge: true, sleep: noSleep });
  assert.equal(r.landed.name, "Theirs", "the room's higher nameV won, as the version rules say it must");
  assert.equal(r.nodesLanded, true);
  assert.equal(r.ok, true);
  assert.equal(r.kept.name, "Theirs");
});

test("a fresh destination is held to the STRONGER verdict — the document whole, name and all", async () => {
  const dst = instance();
  const doc = { name: "Mine", nameV: 3, nodes: [node("a"), node("b")], tombs: {}, clock: 8 };
  const r = await seedRoom(dst.open, { origin: "https://new.test", path: PATH, doc, sleep: noSleep });
  assert.equal(r.destinationWasEmpty, true);
  assert.equal(r.identical, true);
  assert.equal(r.ok, true);
  assert.equal(r.landed.name, "Mine");
  assert.deepEqual(r.kept.nodes, []);
});

// ---- what a comparison is allowed to care about ----------------------------

test("clock is NOT part of a document's identity — adoptDoc resets it, and folding it in would fail every correct move", () => {
  const a = { name: "B", nameV: 1, nodes: [node("a")], tombs: {}, clock: 47 };
  const b = { name: "B", nameV: 1, nodes: [node("a")], tombs: {}, clock: 0 };
  assert.equal(digestDoc(a).full, digestDoc(b).full);
  assert.equal(compareDocs(a, b).same, true);
  assert.deepEqual(compareDocs(a, b).clock, { a: 47, b: 0 });
});

test("z-order IS part of it — the same nodes stacked differently is a different board", () => {
  const a = { name: "B", nameV: 1, nodes: [node("a"), node("b")], tombs: {}, clock: 0 };
  const b = { name: "B", nameV: 1, nodes: [node("b"), node("a")], tombs: {}, clock: 0 };
  const cmp = compareDocs(a, b);
  assert.equal(cmp.sameContent, true);
  assert.equal(cmp.same, false);
  assert.equal(cmp.orderChanged, true);
});

test("an empty board and a board are never reported as the same thing", () => {
  const cmp = compareDocs(null, { name: "B", nameV: 0, nodes: [node("a")], tombs: {}, clock: 0 });
  assert.equal(cmp.same, false);
  assert.equal(cmp.oneEmpty, "a");
  assert.deepEqual(cmp.onlyInB, ["a"]);
  assert.equal(compareDocs(null, null).same, true);
});

test("a summary names the board without printing it", () => {
  const s = docSummary({ name: "Plans", nameV: 2, nodes: [node("a")], tombs: { z: { v: 1, t: 0 } }, clock: 5 });
  assert.equal(s.nodes, 1);
  assert.equal(s.tombs, 1);
  assert.equal(s.name, "Plans");
  assert.equal(s.digest.length, 64);
});
