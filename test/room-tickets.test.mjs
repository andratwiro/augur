// A-room-tickets. Signed short-lived HMAC tickets gate the /__rt socket: the worker mints
// one after its board-auth check, the room refuses the Upgrade without a valid one, and the
// binding it proves is workspace+path — the isolation boundary the room fold relies on.
//
// Three layers, each its own section: the ticket primitive (sign/verify matrix), the worker
// MINT (rtProxy: 501 unconfigured, a verifiable ticket when configured), and the room's
// ENFORCEMENT (BoardRoom.fetch refuses a bad ticket BEFORE it accepts the socket).
import { test } from "node:test";
import assert from "node:assert/strict";
import { signRoomTicket, verifyRoomTicket } from "../src/room-ticket.mjs";
import { __testables as W } from "../src/_worker.js";
import { BoardRoom } from "../src/board-room.mjs";
import { RT_WORKSPACE_HEADER } from "../src/board-key.mjs";

const SECRET = "test-room-ticket-secret";

// ── the primitive ─────────────────────────────────────────────────────────────

test("a fresh ticket verifies for the workspace+path it was minted for", async () => {
  const { ticket, expiresAt } = await signRoomTicket(SECRET, { workspace: "acme", path: "/p/board", who: "ada@example.test" });
  assert.ok(expiresAt > Date.now());
  assert.equal(await verifyRoomTicket(SECRET, ticket, { workspace: "acme", path: "/p/board" }), true);
});

test("an anon ticket (signed-out visitor on a public board) verifies", async () => {
  const { ticket } = await signRoomTicket(SECRET, { workspace: "acme", path: "/p/b", who: null });
  assert.equal(await verifyRoomTicket(SECRET, ticket, { workspace: "acme", path: "/p/b" }), true);
});

test("an email with a dot in it round-trips (the delimiter must not collide)", async () => {
  const { ticket } = await signRoomTicket(SECRET, { workspace: "acme", path: "/p/b", who: "john.doe@a.b.co" });
  assert.equal(await verifyRoomTicket(SECRET, ticket, { workspace: "acme", path: "/p/b" }), true);
});

test("a ticket for one workspace does not open another's board", async () => {
  const { ticket } = await signRoomTicket(SECRET, { workspace: "acme", path: "/p/b", who: "a@x.test" });
  assert.equal(await verifyRoomTicket(SECRET, ticket, { workspace: "other", path: "/p/b" }), false);
});

test("a ticket for one path does not open another", async () => {
  const { ticket } = await signRoomTicket(SECRET, { workspace: "acme", path: "/p/b", who: "a@x.test" });
  assert.equal(await verifyRoomTicket(SECRET, ticket, { workspace: "acme", path: "/p/other" }), false);
});

test("an expired ticket is rejected", async () => {
  const past = Date.now() - 5 * 60 * 1000;
  const { ticket } = await signRoomTicket(SECRET, { workspace: "acme", path: "/p/b", who: "a@x.test" }, past);
  assert.equal(await verifyRoomTicket(SECRET, ticket, { workspace: "acme", path: "/p/b" }), false);
});

test("a tampered MAC is rejected", async () => {
  const { ticket } = await signRoomTicket(SECRET, { workspace: "acme", path: "/p/b", who: "a@x.test" });
  const parts = ticket.split(".");
  parts[2] = parts[2].slice(0, -1) + (parts[2].endsWith("0") ? "1" : "0");
  assert.equal(await verifyRoomTicket(SECRET, parts.join("."), { workspace: "acme", path: "/p/b" }), false);
});

test("a rewritten who is rejected — who is bound by the MAC", async () => {
  const { ticket } = await signRoomTicket(SECRET, { workspace: "acme", path: "/p/b", who: "viewer@x.test" });
  const parts = ticket.split(".");
  parts[1] = Buffer.from("admin@x.test").toString("base64url"); // swap the identity, keep the MAC
  assert.equal(await verifyRoomTicket(SECRET, parts.join("."), { workspace: "acme", path: "/p/b" }), false);
});

test("a ticket signed with a different secret is rejected", async () => {
  const { ticket } = await signRoomTicket(SECRET, { workspace: "acme", path: "/p/b", who: "a@x.test" });
  assert.equal(await verifyRoomTicket("some-other-secret", ticket, { workspace: "acme", path: "/p/b" }), false);
});

test("verify with no secret or a garbage ticket is a clean false, never a throw", async () => {
  assert.equal(await verifyRoomTicket("", "anything", { workspace: "a", path: "/p" }), false);
  assert.equal(await verifyRoomTicket(SECRET, "", { workspace: "a", path: "/p" }), false);
  assert.equal(await verifyRoomTicket(SECRET, "one.two", { workspace: "a", path: "/p" }), false);
  assert.equal(await verifyRoomTicket(SECRET, "x.y.z", { workspace: "a", path: "/p" }), false);
});

// ── the worker mint (rtProxy) ──────────────────────────────────────────────────

const mintReq = (path) =>
  new Request(`https://acme.example.test/__rt?mint=1&path=${encodeURIComponent(path)}`, { method: "GET" });
const mintUrl = (path) => new URL(`https://acme.example.test/__rt?mint=1&path=${encodeURIComponent(path)}`);
const tctx = { tenantId: "acme" };

test("mint returns 501 when ROOM_TICKET_SECRET is unconfigured", async () => {
  const res = await W.rtProxy(tctx, mintReq("/p/b"), mintUrl("/p/b"), {}, null);
  assert.equal(res.status, 501);
});

test("mint returns a ticket that verifies for the resolved workspace+path", async () => {
  const me = { email: "ada@example.test" };
  const res = await W.rtProxy(tctx, mintReq("/p/b"), mintUrl("/p/b"), { ROOM_TICKET_SECRET: SECRET }, me);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.ticket && body.expiresAt);
  assert.equal(await verifyRoomTicket(SECRET, body.ticket, { workspace: "acme", path: "/p/b" }), true);
  // and NOT for a neighbour naming the same path
  assert.equal(await verifyRoomTicket(SECRET, body.ticket, { workspace: "evil", path: "/p/b" }), false);
});

test("mint refuses without a path", async () => {
  const noPath = new URL("https://acme.example.test/__rt?mint=1");
  const res = await W.rtProxy(tctx, new Request(noPath, { method: "GET" }), noPath, { ROOM_TICKET_SECRET: SECRET }, null);
  assert.equal(res.status, 400);
});

// ── the room enforcement (BoardRoom.fetch) ─────────────────────────────────────

globalThis.WebSocketRequestResponsePair = class { constructor(req, res) { this.request = req; this.response = res; } };
globalThis.WebSocketPair = function () {
  const mk = () => ({ serializeAttachment() {}, send() {}, addEventListener() {}, close() {} });
  this[0] = mk(); this[1] = mk();
};

function memStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => m.has(x)).map((x) => [x, m.get(x)])) : m.get(k)),
    put: async (k, v) => { if (k && typeof k === "object") { for (const [kk, vv] of Object.entries(k)) m.set(kk, vv); return; } m.set(k, v); },
    delete: async (k) => (Array.isArray(k) ? k.reduce((n, x) => n + (m.delete(x) ? 1 : 0), 0) : m.delete(k)),
    list: async ({ prefix = "" } = {}) => new Map([...m.entries()].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {}, getAlarm: async () => null, deleteAlarm: async () => {},
  };
}

function room(env = {}) {
  let accepted = 0;
  const ctx = {
    storage: memStorage(),
    getWebSockets: () => [],
    blockConcurrencyWhile: async (f) => f(),
    setWebSocketAutoResponse: () => {},
    acceptWebSocket: () => { accepted++; },
  };
  const r = new BoardRoom(ctx, env);
  return { r, accepted: () => accepted };
}

const joinReq = (workspace, path, ticket) => {
  const u = new URL(`https://room.internal/?path=${encodeURIComponent(path)}&name=Ada`);
  if (ticket != null) u.searchParams.set("ticket", ticket);
  const headers = new Headers({ Upgrade: "websocket" });
  headers.set(RT_WORKSPACE_HEADER, workspace);
  return new Request(u, { headers });
};

test("with a secret set, the room refuses the Upgrade without a ticket — before accepting the socket", async () => {
  const { r, accepted } = room({ ROOM_TICKET_SECRET: SECRET });
  const res = await r.fetch(joinReq("acme", "/p/b", null));
  assert.equal(res.status, 403);
  assert.equal(accepted(), 0, "the socket must not be accepted for a ticketless join");
});

test("with a secret set, a ticket for the wrong workspace is refused", async () => {
  const { ticket } = await signRoomTicket(SECRET, { workspace: "evil", path: "/p/b", who: "a@x.test" });
  const { r, accepted } = room({ ROOM_TICKET_SECRET: SECRET });
  const res = await r.fetch(joinReq("acme", "/p/b", ticket));
  assert.equal(res.status, 403);
  assert.equal(accepted(), 0);
});

// The room ACCEPTS by reaching ctx.acceptWebSocket and returning a 101 Upgrade. Node's
// undici refuses to construct a status-101 Response (workerd allows it, which is why the
// class is correct as written and the existing board-room.test.mjs never drives this
// return either) — so we assert the gate was passed by acceptWebSocket being called, and
// swallow the Node-only construction throw that lands after it.
const fetchPastGate = async (r, req) => { try { return await r.fetch(req); } catch (e) {
  if (!/status.*range of 200 to 599/.test(String(e))) throw e; return null; } };

test("with a secret set, a valid ticket passes the gate (socket accepted)", async () => {
  const { ticket } = await signRoomTicket(SECRET, { workspace: "acme", path: "/p/b", who: "a@x.test" });
  const { r, accepted } = room({ ROOM_TICKET_SECRET: SECRET });
  await fetchPastGate(r, joinReq("acme", "/p/b", ticket));
  assert.equal(accepted(), 1, "a valid ticket must let the join reach acceptWebSocket");
});

test("with NO secret (legacy/offline), a ticketless join passes the gate as before", async () => {
  const { r, accepted } = room({});
  await fetchPastGate(r, joinReq("acme", "/p/b", null));
  assert.equal(accepted(), 1);
});
