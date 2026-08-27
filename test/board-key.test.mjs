// `A-room-name-derivation`. Two changes that have to ride one deploy: the room's NAME
// starts with the workspace the worker resolved, and the board document's KV key gains the
// same segment.
//
// THE FIRST THING THIS FILE PROVES IS THAT NEITHER OF THEM HAPPENS YET. An engine push
// reaches every live instance within minutes, and every live instance today serves canvas
// multiplayer from a separate `augur-realtime-*` worker reached through `/__rt`. So the
// tests that matter most here are the ones with NO `ROOMS` binding in the env: they assert
// the proxy still proxies, the key is still `board:<path>`, and nothing about a live board
// has moved. The scoped behaviour is everything below them, and it turns on exactly one
// thing — a `ROOMS` binding, which no deployment has.
//
// WHY THE TWO HALVES SHARE A SWITCH. A board document has two writers: the `/__board` rail
// and the room's write-through mirror. They are one script only where the rooms are bound
// here. Scoping the rail alone on a deployment whose room is still in another worker would
// leave `/__board` reading a key nothing writes — the board would freeze at the deploy
// while the room went on editing a document nothing served. That is the failure this file
// exists to make impossible to reintroduce.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";
import { BoardRoom } from "../src/board-room.mjs";
import { BOARD_PREFIX, boardKvKey, RT_WORKSPACE_HEADER } from "../src/board-key.mjs";
import { migrateBoardKeys } from "../scripts/migrate-board-keys.mjs";

globalThis.WebSocketRequestResponsePair = class { constructor(req, res) { this.request = req; this.response = res; } };

function memKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
    async list({ prefix = "", cursor } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name }));
      return { keys, list_complete: true, cursor: null };
    },
  };
}

const WS = "acme";
const CTX = Object.freeze({ tenantId: WS, RT_ORIGIN: "https://rt.example" });
const PATH = "/playground/board/";

const boardUrl = (path) => new URL(`https://example.test/__board?path=${encodeURIComponent(path)}`);
const postBoard = (path, doc) => new Request(boardUrl(path), {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ doc }),
});
const DOC = { nodes: [{ id: "n1", t: "note", v: 1, vn: 1 }], name: "Board" };

/** A `ROOMS` binding that records what it was asked to name, and never opens a socket. */
function roomsStub() {
  const seen = [];
  return {
    seen,
    idFromName(name) { seen.push(name); return { name }; },
    get(id) { return { async fetch(req) { return new Response(JSON.stringify({ room: id.name, ws: req.headers.get(RT_WORKSPACE_HEADER) })); } }; },
  };
}

const upgrade = (url, headers = {}) => new Request(url, { headers: { Upgrade: "websocket", ...headers } });

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE STRADDLE: a deployment with no ROOMS binding is untouched
// ─────────────────────────────────────────────────────────────────────────────

test("with no ROOMS binding /__rt still proxies to RT_ORIGIN — the live path is unmoved", async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  // A real proxied upgrade answers 101; Node's Response constructor refuses to build one,
  // so the marker is the body. What is being asserted is the REQUEST, either way.
  globalThis.fetch = async (req) => { calls.push(req); return new Response("proxied"); };
  try {
    const url = new URL(`https://example.test/__rt?path=${encodeURIComponent(PATH)}&name=Ada`);
    const res = await W.rtProxy(CTX, upgrade(url), url, { RT_SHARED_SECRET: "s3cret" });
    assert.equal(await res.text(), "proxied", "the upstream response is passed through untouched");
    assert.equal(calls.length, 1, "exactly one upstream request");
    assert.equal(new URL(calls[0].url).origin, "https://rt.example");
    assert.equal(new URL(calls[0].url).pathname, "/room", "the standalone worker's own route");
    assert.equal(new URL(calls[0].url).searchParams.get("path"), PATH, "the query rides along verbatim");
    assert.equal(calls[0].headers.get("X-Augur-RT"), "s3cret", "the shared secret still identifies this worker");
  } finally { globalThis.fetch = realFetch; }
});

test("with no ROOMS binding and no RT_ORIGIN, /__rt still answers 501 — unchanged", async () => {
  const url = new URL("https://example.test/__rt?path=/x/");
  const res = await W.rtProxy({ tenantId: WS, RT_ORIGIN: "" }, upgrade(url), url, {});
  assert.equal(res.status, 501);
  assert.deepEqual(await res.json(), { error: "realtime-not-configured" });
});

test("the sandbox seal beats a ROOMS binding, not only a configured origin", async () => {
  const url = new URL("https://example.test/__rt?path=/x/");
  const rooms = roomsStub();
  const res = await W.rtProxy(CTX, upgrade(url), url, { ROOMS: rooms, GV_RT_DISABLE: "1" });
  assert.equal(res.status, 501);
  assert.deepEqual(await res.json(), { error: "realtime-disabled" });
  assert.deepEqual(rooms.seen, [], "a sealed sandbox must not reach a room at all");
});

test("with no ROOMS binding the board key is the legacy one, byte for byte", async () => {
  const kv = memKV();
  const env = { COMMENTS: kv };
  await W.boardApi(CTX, postBoard(PATH, DOC), boardUrl(PATH), env);
  assert.deepEqual([...kv.store.keys()], [`board:${PATH}`], "no workspace segment on a deployment that has none");
  const read = await W.boardApi(CTX, new Request(boardUrl(PATH)), boardUrl(PATH), env);
  assert.deepEqual((await read.json()).doc, DOC);
});

test("kvWorkspaceSegment is empty without ROOMS and named with it", () => {
  assert.deepEqual(W.kvWorkspaceSegment({ COMMENTS: {} }, CTX), { workspace: "", legacyIsOurs: true });
  assert.deepEqual(W.kvWorkspaceSegment({ ROOMS: {} }, CTX), { workspace: WS, legacyIsOurs: true });
  // A context with no id at all — a raw or offline build — still names something rather
  // than falling back to the unscoped key, which would be a third state to reason about.
  assert.deepEqual(W.kvWorkspaceSegment({ ROOMS: {} }, {}), { workspace: "default", legacyIsOurs: true });
  // Host-resolved: an unscoped key belongs to nobody this deployment can name.
  assert.deepEqual(
    W.kvWorkspaceSegment({ ROOMS: {}, TENANT_HOST_SUFFIX: ".example.com" }, CTX),
    { workspace: WS, legacyIsOurs: false });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE ROOM NAME: never a bare client path
// ─────────────────────────────────────────────────────────────────────────────

test("the room name always starts with the resolved workspace", () => {
  for (const p of ["/a/", "/playground/x/", "", "/__test/iso", "other:/a/", "../../a", "\u0000"]) {
    assert.ok(W.roomName(CTX, p).startsWith(WS + ":"), `"${p}" produced ${W.roomName(CTX, p)}`);
  }
  assert.equal(W.roomName(CTX, PATH), `${WS}:${PATH}`);
  assert.equal(W.roomName({}, PATH), `default:${PATH}`, "no resolved id still names one");
});

test("idFromName is handed the workspace and never the client's own string", async () => {
  const rooms = roomsStub();
  // The hostile case: a path that spells out another workspace's name and separator. The
  // name is built by concatenation from the RESOLVED id, so the client's string can only
  // ever land after the separator — it cannot become the segment.
  const hostile = "victim:/secret/board/";
  const url = new URL(`https://example.test/__rt?path=${encodeURIComponent(hostile)}`);
  const res = await W.rtProxy(CTX, upgrade(url), url, { ROOMS: rooms });
  assert.equal(rooms.seen.length, 1);
  assert.ok(rooms.seen[0].startsWith(WS + ":"), `named ${rooms.seen[0]}`);
  assert.equal(rooms.seen[0], `${WS}:${hostile}`);
  assert.notEqual(rooms.seen[0], hostile, "the client's string is never the whole name");
  const body = await res.json();
  assert.equal(body.ws, WS, "the room is told whose board it is");
});

test("a client-supplied workspace header is overwritten, never merged", async () => {
  const rooms = roomsStub();
  const url = new URL(`https://example.test/__rt?path=${encodeURIComponent(PATH)}`);
  const res = await W.rtProxy(CTX, upgrade(url, { [RT_WORKSPACE_HEADER]: "victim" }), url, { ROOMS: rooms });
  assert.equal((await res.json()).ws, WS, "the caller's header must not reach the room");
});

test("with ROOMS bound, a non-websocket or path-less request is refused before the room", async () => {
  const rooms = roomsStub();
  const plain = new URL(`https://example.test/__rt?path=${encodeURIComponent(PATH)}`);
  assert.equal((await W.rtProxy(CTX, new Request(plain), plain, { ROOMS: rooms })).status, 426);
  const bare = new URL("https://example.test/__rt");
  assert.equal((await W.rtProxy(CTX, upgrade(bare), bare, { ROOMS: rooms })).status, 400);
  assert.deepEqual(rooms.seen, [], "neither refusal named a room");
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. ONE SPELLING: the rail and the room build the same key
// ─────────────────────────────────────────────────────────────────────────────

test("the overlay accessor's board key and the room's board key are the same string", () => {
  for (const ws of ["", "acme", "default"]) {
    for (const p of ["/a/", "/playground/deep/board/", "/x"]) {
      assert.equal(W.overlayKvKey("boards", "", p, ws), boardKvKey(ws, p),
        `the two spellings drifted at workspace "${ws}", path "${p}"`);
    }
  }
  assert.equal(W.BOARD_PREFIX, BOARD_PREFIX, "the worker re-exports the shared constant, not a copy");
  assert.equal(boardKvKey("", PATH), `board:${PATH}`);
  assert.equal(boardKvKey(WS, PATH), `board:${WS}:${PATH}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. READ-THROUGH: a board written before the segment is still found and served
// ─────────────────────────────────────────────────────────────────────────────

test("a legacy board is served through the read-through and written back scoped", async () => {
  const legacyKey = boardKvKey("", PATH);
  const kv = memKV({ [legacyKey]: JSON.stringify(DOC) });
  const env = { COMMENTS: kv, ROOMS: roomsStub() };

  const first = await W.boardApi(CTX, new Request(boardUrl(PATH)), boardUrl(PATH), env);
  assert.deepEqual((await first.json()).doc, DOC, "the legacy document is served, not a 'never saved' null");
  assert.equal(kv.store.get(boardKvKey(WS, PATH)), JSON.stringify(DOC), "and written back under the scoped key");
  assert.ok(kv.store.has(legacyKey), "the legacy key is LEFT — a rollback has to find the board");

  // Second read: the scoped key is there now, so the fallback is not paid again. Prove it
  // by removing the legacy key entirely — the answer must not change.
  kv.store.delete(legacyKey);
  const second = await W.boardApi(CTX, new Request(boardUrl(PATH)), boardUrl(PATH), env);
  assert.deepEqual((await second.json()).doc, DOC, "the direct path resolves the same document");
});

test("a scoped board wins over a legacy one at the same path", async () => {
  const older = { nodes: [{ id: "old" }], name: "Older" };
  const kv = memKV({
    [boardKvKey("", PATH)]: JSON.stringify(older),
    [boardKvKey(WS, PATH)]: JSON.stringify(DOC),
  });
  const res = await W.boardApi(CTX, new Request(boardUrl(PATH)), boardUrl(PATH), { COMMENTS: kv, ROOMS: roomsStub() });
  assert.deepEqual((await res.json()).doc, DOC, "the scoped copy is the only one read once it exists");
});

test("the read-through is OFF where a workspace comes from the Host header", async () => {
  // There, an unscoped key predates nothing this deployment can attribute, and serving it
  // would hand one workspace a board that may be another's.
  const kv = memKV({ [boardKvKey("", PATH)]: JSON.stringify(DOC) });
  const env = { COMMENTS: kv, ROOMS: roomsStub(), TENANT_HOST_SUFFIX: ".example.com" };
  const res = await W.boardApi(CTX, new Request(boardUrl(PATH)), boardUrl(PATH), env);
  assert.equal((await res.json()).doc, null, "a miss is a miss");
  assert.ok(!kv.store.has(boardKvKey(WS, PATH)), "and nothing was copied across");
});

test("deleting a board reaches the legacy key too, so it cannot come back", async () => {
  const kv = memKV({ [boardKvKey("", PATH)]: JSON.stringify(DOC), [boardKvKey(WS, PATH)]: JSON.stringify(DOC) });
  const store = W.overlayFor({ COMMENTS: kv, ROOMS: roomsStub() }, CTX);
  await store.set("boards", "", PATH, null);
  assert.deepEqual([...kv.store.keys()], [], "both spellings gone");
});

test("the whole-family listing still sees a board that has not migrated", async () => {
  // The canvas-image garbage collection reads image references OFF the boards, so a board
  // it cannot see is a set of images it deletes while somebody is looking at them.
  const kv = memKV({
    [boardKvKey("", "/old/")]: JSON.stringify({ nodes: [{ id: "a" }] }),
    [boardKvKey(WS, "/new/")]: JSON.stringify({ nodes: [{ id: "b" }] }),
  });
  const store = W.overlayFor({ COMMENTS: kv, ROOMS: roomsStub() }, CTX);
  const all = await store.read("boards");
  assert.deepEqual(Object.keys(all).sort(), ["/new/", "/old/"]);
});

test("where workspaces SHARE a namespace, the listing reaches only this one's boards", async () => {
  // Two workspaces behind one deployment is the Host-resolved shape, and it is exactly the
  // shape in which the legacy sweep is off — an unscoped key there is unattributable, and a
  // neighbour's SCOPED key matches the unscoped prefix. Both would leak through one sweep.
  // (On a single-workspace deployment `legacyIsOurs` is true and the sweep runs, which is
  // sound only because such a namespace has one workspace's rows in it by definition —
  // that invariant IS the flag, and this test is the case where it does not hold.)
  const kv = memKV({
    [boardKvKey("neighbour", "/theirs/")]: JSON.stringify({ nodes: [] }),
    [boardKvKey("", "/unattributable/")]: JSON.stringify({ nodes: [] }),
    [boardKvKey(WS, "/mine/")]: JSON.stringify({ nodes: [] }),
  });
  const env = { COMMENTS: kv, ROOMS: roomsStub(), TENANT_HOST_SUFFIX: ".example.com" };
  const store = W.overlayFor(env, CTX);
  assert.deepEqual(Object.keys(await store.read("boards")), ["/mine/"]);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. THE ROOM'S MIRROR: same key, same read-through
// ─────────────────────────────────────────────────────────────────────────────

function memStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    map: m,
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => m.has(x)).map((x) => [x, m.get(x)])) : m.get(k)),
    put: async (k, v) => { if (typeof k === "object" && k !== null) { for (const [kk, vv] of Object.entries(k)) m.set(kk, vv); return; } m.set(k, v); },
    delete: async (k) => { if (Array.isArray(k)) { let n = 0; for (const x of k) if (m.delete(x)) n++; return n; } return m.delete(k); },
    list: async ({ prefix = "" } = {}) => new Map([...m.entries()].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1))),
    setAlarm: async () => {}, getAlarm: async () => null, deleteAlarm: async () => {},
  };
}

function room({ storage = memStorage(), kv = null, binding = "COMMENTS" } = {}) {
  const ctx = { storage, getWebSockets: () => [], blockConcurrencyWhile: async (f) => f(), setWebSocketAutoResponse: () => {} };
  return new BoardRoom(ctx, { [binding]: kv });
}

test("a room told no workspace mirrors to the legacy key — the standalone worker's path", async () => {
  const kv = memKV();
  const r = room({ storage: memStorage({ path: PATH, m: { name: "n", tombs: {}, clock: 0, order: ["a"] }, "n:a": JSON.stringify({ id: "a", v: 1, vn: 1 }) }), kv, binding: "BOARD_KV" });
  await r.load();
  r.markDirty();
  await r.mirror();
  assert.deepEqual([...kv.store.keys()], [boardKvKey("", PATH)]);
});

test("a room told a workspace mirrors under it, and reads a legacy mirror through", async () => {
  const legacy = { name: "Legacy", nodes: [{ id: "kv1", v: 5, vn: 1 }], tombs: {}, clock: 1 };
  const kv = memKV({ [boardKvKey("", PATH)]: JSON.stringify(legacy) });
  const storage = memStorage({ path: PATH, ws: WS, m: { name: "n", tombs: {}, clock: 0, order: [] } });
  const r = room({ storage, kv });
  await r.load();
  // The fold-the-mirror-back-in on load found the LEGACY document — this is the board a
  // live instance is holding at the moment of the cutover.
  assert.ok(r.doc.nodes.some((n) => n.id === "kv1"), "the legacy mirror was not read through");
  r.markDirty();
  await r.mirror();
  assert.ok(kv.store.has(boardKvKey(WS, PATH)), "the mirror write lands scoped");
  assert.ok(kv.store.has(boardKvKey("", PATH)), "and leaves the legacy copy alone");
});

test("the workspace survives hibernation — an alarm wake reads it from storage", async () => {
  const storage = memStorage({ path: PATH, ws: WS, dirty: 1, m: { name: "n", tombs: {}, clock: 0, order: ["a"] }, "n:a": JSON.stringify({ id: "a", v: 1, vn: 1 }) });
  const kv = memKV();
  const r = room({ storage, kv });          // a brand-new instance: nothing in memory
  await r.alarm();
  assert.deepEqual([...kv.store.keys()], [boardKvKey(WS, PATH)],
    "an alarm that woke with no request must still know whose board it is");
});

test("the room records the workspace the header names", async () => {
  const storage = memStorage();
  const r = room({ storage, kv: memKV() });
  // fetch() opens a socket, which this stand-in cannot do; drive the two lines that matter
  // exactly as fetch() runs them.
  const req = new Request(`https://room/?path=${encodeURIComponent(PATH)}`, { headers: { [RT_WORKSPACE_HEADER]: WS } });
  r.path = PATH;
  const ws = (req.headers.get(RT_WORKSPACE_HEADER) || "").slice(0, 128);
  r.workspace = ws; await storage.put("ws", ws);
  assert.equal(await r.workspaceId(), WS);
  assert.equal(storage.map.get("ws"), WS, "durable, because the mirror alarm has no request to read");
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. THE BATCH: migrate-board-keys, dry run and apply
// ─────────────────────────────────────────────────────────────────────────────

/** The four-call namespace the migration runs against, over a Map of byte strings. */
function migStore(seed = {}) {
  const enc = new TextEncoder();
  const m = new Map(Object.entries(seed).map(([k, v]) => [k, enc.encode(v)]));
  return {
    map: m,
    async list(prefix) { return [...m.keys()].filter((k) => k.startsWith(prefix)).sort(); },
    async get(name) { return m.has(name) ? m.get(name).buffer.slice(m.get(name).byteOffset, m.get(name).byteOffset + m.get(name).byteLength) : null; },
    async put(name, body) { m.set(name, new Uint8Array(body)); },
    text(name) { return m.has(name) ? new TextDecoder().decode(m.get(name)) : null; },
  };
}

test("a dry run writes nothing and reports what it would copy", async () => {
  const store = migStore({
    [boardKvKey("", "/a/")]: '{"nodes":[]}',
    [boardKvKey("", "/b/")]: '{"nodes":[{"id":"x"}]}',
    "c:/a/": "{}",                                  // another family — not a board
  });
  const before = [...store.map.keys()].sort();
  const res = await migrateBoardKeys(store, { workspace: WS });
  assert.equal(res.scanned, 2, "the comment thread is not a board");
  assert.deepEqual(res.copied.sort(), ["/a/", "/b/"]);
  assert.deepEqual(res.differing, [], "a dry run reporting zero differences is the acceptance test");
  assert.deepEqual([...store.map.keys()].sort(), before, "a dry run WROTE something");
});

test("apply copies the bytes verbatim and leaves the legacy key", async () => {
  const body = '{"nodes":[{"id":"x"}],"name":"Board"}';
  const store = migStore({ [boardKvKey("", "/b/")]: body });
  const res = await migrateBoardKeys(store, { workspace: WS, apply: true });
  assert.deepEqual(res.copied, ["/b/"]);
  assert.equal(store.text(boardKvKey(WS, "/b/")), body, "byte for byte");
  assert.equal(store.text(boardKvKey("", "/b/")), body, "the legacy key survives, so a rollback still serves");
});

test("re-running is a no-op, and a scoped copy that has moved on is SKIPPED not reverted", async () => {
  const store = migStore({ [boardKvKey("", "/b/")]: '{"v":1}' });
  await migrateBoardKeys(store, { workspace: WS, apply: true });
  const again = await migrateBoardKeys(store, { workspace: WS, apply: true });
  assert.equal(again.identical, 1);
  assert.deepEqual(again.copied, []);

  // The room has been running since the batch and the scoped copy is newer.
  await store.put(boardKvKey(WS, "/b/"), new TextEncoder().encode('{"v":2}'));
  const third = await migrateBoardKeys(store, { workspace: WS, apply: true });
  assert.deepEqual(third.differing, ["/b/"], "a live board must be named, not overwritten");
  assert.equal(store.text(boardKvKey(WS, "/b/")), '{"v":2}', "the newer copy stands");
});

test("the batch refuses a workspace it cannot spell", async () => {
  await assert.rejects(() => migrateBoardKeys(migStore(), {}), /workspace id is required/);
  await assert.rejects(() => migrateBoardKeys(migStore(), { workspace: "a:b" }), /may not contain/);
});

test("the batch skips this workspace's own scoped keys, which the prefix also matches", async () => {
  const store = migStore({
    [boardKvKey("", "/legacy/")]: "{}",
    [boardKvKey(WS, "/already/")]: "{}",
  });
  const res = await migrateBoardKeys(store, { workspace: WS });
  assert.equal(res.scanned, 1, "an already-scoped key is not a legacy key to migrate");
  assert.deepEqual(res.copied, ["/legacy/"]);
});

test("⚠️ the batch belongs to a namespace holding ONE workspace's boards, and says so", async () => {
  // It CANNOT tell a neighbour's scoped key from a legacy key — `board:neighbour:/x/` and
  // `board:/x/` differ only in a segment it is the job of this run to add. That is safe
  // because the run happens on the deploy that first scopes a single-workspace instance's
  // keys, where by definition there is no neighbour. Pinned here so the assumption is
  // written down at the place that relies on it rather than assumed at the place that
  // would break: run this against a namespace two workspaces share and it will copy one
  // of them under the other's name.
  const store = migStore({ [boardKvKey("neighbour", "/theirs/")]: "{}" });
  const res = await migrateBoardKeys(store, { workspace: WS });
  assert.deepEqual(res.copied, ["neighbour:/theirs/"], "a neighbour's key is indistinguishable from a legacy one");
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. THE HAND-OVER: read-through before the batch, direct path after
// ─────────────────────────────────────────────────────────────────────────────

test("the same board resolves through the read-through before the batch and directly after", async () => {
  const body = JSON.stringify(DOC);
  const kv = memKV({ [boardKvKey("", PATH)]: body });
  const env = { COMMENTS: kv, ROOMS: roomsStub() };

  // BEFORE: only the legacy key exists. The rail finds it anyway.
  const before = await W.boardApi(CTX, new Request(boardUrl(PATH)), boardUrl(PATH), env);
  const beforeDoc = (await before.json()).doc;

  // The batch, over the SAME bytes, into a store the rail has not touched yet.
  const store = migStore({ [boardKvKey("", PATH)]: body });
  const res = await migrateBoardKeys(store, { workspace: WS, apply: true });
  assert.deepEqual(res.differing, [], "zero content diffs");
  assert.equal(store.text(boardKvKey(WS, PATH)), body);

  // AFTER: the scoped key is the only one. Same document.
  const kv2 = memKV({ [boardKvKey(WS, PATH)]: body });
  const after = await W.boardApi(CTX, new Request(boardUrl(PATH)), boardUrl(PATH), { COMMENTS: kv2, ROOMS: roomsStub() });
  const afterDoc = (await after.json()).doc;
  assert.deepEqual(afterDoc, beforeDoc, "the path the document was reached by changed; the document did not");
});
