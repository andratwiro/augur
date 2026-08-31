// A-gate-rt-board. /__board and /__rt (the ticket mint and the socket) must obey the same
// auth + isRestrictedPath rule the page-serving path already applies: a board whose path
// falls under an admin-only space is admin-only, and a public board keeps the share-link
// model ("the board is the credential") unchanged.
//
// The gate itself is one block in src/_worker.js (the data-API restricted-path seal that
// runs BEFORE /__board and /__rt dispatch, because these route off a caller-supplied
// ?path=). It predates this item — the A-thread-gate routing-cluster refactor threaded it
// — so this file is the acceptance test the item's VERIFY asks for and did not yet have:
// restricted /__board AND /__rt/mint 403 for a non-admin/signed-out caller, admin still in,
// public boards untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { default as worker, __testables as W } from "../src/_worker.js";

const SESSION_SECRET = "gate-rt-board-fixed-session-secret";
const ROOM_TICKET_SECRET = "gate-rt-board-room-ticket-secret";
const SESSION_COOKIE = "__Host-augur_user";

// Two roster users, both with a truthy passHash so effectiveSecret() falls back to it (no
// users:secrets key) and the cookie derivation and identify() agree.
const ADMIN = { email: "ada@example.test", name: "Ada", initials: "AA", color: "#2c2150", role: "admin", passHash: "seed-admin" };
const VIEWER = { email: "bob@example.test", name: "Bob", initials: "BB", color: "#204030", role: "viewer", passHash: "seed-viewer" };

const INSTANCE_JSON = {
  users: [ADMIN, VIEWER],
  engineVersion: "1.0.0-test", updateFeed: "",
  mcpHostSuffixes: [], mcpHostAllowlistUrl: "", vanityRedirects: {}, rtOrigin: "", sentinels: [],
};
const ROUTING_JSON = {
  buildId: "test-build", versionMap: {},
  publicPrefixes: ["/prototypes/garden/"], publicSkillPrefixes: [],
  restrictedBases: ["/sealed"],
  canvasLoaderExtras: "", canvasCatalog: [], canvasTracks: [], mcpAllowlist: [],
  spaces: [
    { id: "delta", name: "Delta", badge: "D", default: true, base: "", adminOnly: false },
    { id: "sealed", name: "Sealed", badge: "S", default: false, base: "/sealed", adminOnly: true },
  ],
  defaultSpace: "delta",
};

const CONFIG = {
  "/__config/instance.json": JSON.stringify(INSTANCE_JSON),
  "/__config/routing.json": JSON.stringify(ROUTING_JSON),
};

function memKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return { store, async get(k) { return store.has(k) ? store.get(k) : null; }, async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); } };
}

const assetsStub = () => ({
  async fetch(req) {
    const p = new URL(typeof req === "string" ? req : req.url).pathname;
    if (p in CONFIG) return new Response(CONFIG[p], { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } });
    return new Response("Not Found", { status: 404 });
  },
});

// A public board and a sealed board, both seeded so the admin/open paths return a real doc.
const board = (name) => JSON.stringify({ name, nodes: [], tombs: {}, clock: 1 });
const env = () => ({
  COMMENTS: memKV({ "board:/prototypes/garden/": board("Garden"), "board:/sealed/board/": board("Sealed") }),
  ASSETS: assetsStub(),
  SESSION_SECRET,
  ROOM_TICKET_SECRET,
});
const ctx = { waitUntil() {} };

async function cookieFor(e, user) {
  const token = await W.userToken(e, user, user.passHash); // effectiveSecret() with no users:secrets key
  return `${SESSION_COOKIE}=${user.email}.${token}`;
}

const hit = (e, path, cookie) => {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  return worker.fetch(new Request("https://example.test" + path, { headers }), e, ctx);
};

const boardUrl = (p) => `/__board?path=${encodeURIComponent(p)}`;
const mintUrl = (p) => `/__rt?mint=1&path=${encodeURIComponent(p)}`;

// ── /__board on a restricted space ──────────────────────────────────────────────

test("/__board on a sealed path: signed-out is 403", async () => {
  const e = env();
  assert.equal((await hit(e, boardUrl("/sealed/board/"))).status, 403);
});

test("/__board on a sealed path: a viewer (non-admin) is 403", async () => {
  const e = env();
  const cookie = await cookieFor(e, VIEWER);
  assert.equal((await hit(e, boardUrl("/sealed/board/"), cookie)).status, 403);
});

test("/__board on a sealed path: an admin is let through", async () => {
  const e = env();
  const cookie = await cookieFor(e, ADMIN);
  const res = await hit(e, boardUrl("/sealed/board/"), cookie);
  assert.notEqual(res.status, 403);
  assert.equal(res.status, 200);
});

// ── /__rt mint on a restricted space ────────────────────────────────────────────

test("/__rt mint on a sealed path: signed-out is 403 (no ticket for a board it may not join)", async () => {
  const e = env();
  assert.equal((await hit(e, mintUrl("/sealed/board/"))).status, 403);
});

test("/__rt mint on a sealed path: a viewer is 403", async () => {
  const e = env();
  const cookie = await cookieFor(e, VIEWER);
  assert.equal((await hit(e, mintUrl("/sealed/board/"), cookie)).status, 403);
});

test("/__rt mint on a sealed path: an admin gets a ticket", async () => {
  const e = env();
  const cookie = await cookieFor(e, ADMIN);
  const res = await hit(e, mintUrl("/sealed/board/"), cookie);
  assert.equal(res.status, 200);
  assert.ok((await res.json()).ticket, "an admin should be minted a ticket for a sealed board");
});

// ── public boards: the share-link model is UNCHANGED ────────────────────────────

test("/__board on a public path stays open to a signed-out caller", async () => {
  const e = env();
  const res = await hit(e, boardUrl("/prototypes/garden/"));
  assert.equal(res.status, 200);
});

test("/__rt mint on a public path stays open to a signed-out caller (anon ticket)", async () => {
  const e = env();
  const res = await hit(e, mintUrl("/prototypes/garden/"));
  assert.equal(res.status, 200);
  assert.ok((await res.json()).ticket);
});
