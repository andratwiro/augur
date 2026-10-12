// E-28, second cut. /__board and /__rt take the same caller-supplied ?path= as
// /__review/api and were answered to anyone: a canvas behind the gate had its board (and its
// room) in front of it. Same rule as the comments: a member everywhere, a stranger only
// where the canvas itself is open to them (a public path, or a created board), and a
// stranger never STARTS a document where no page is. A plain GET of /__rt keeps answering
// facts about the deployment (501 / 426): `migrate` asks exactly that, signed out.
// Harness as in gate-rt-board.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { default as worker, __testables as W } from "../src/_worker.js";

const SESSION_SECRET = "gate-board-rt-members-fixed-session-secret";
const ROOM_TICKET_SECRET = "gate-board-rt-members-room-ticket-secret";
const SESSION_COOKIE = "__Host-augur_user";

const ADMIN = { email: "ada@example.test", name: "Ada", initials: "AA", color: "#2c2150", role: "admin", passHash: "seed-admin" };
const VIEWER = { email: "bob@example.test", name: "Bob", initials: "BB", color: "#204030", role: "viewer", passHash: "seed-viewer" };
const OUTSIDER = { email: "cy@example.test", name: "Cy", initials: "CY", color: "#503020", role: "editor", passHash: "seed-outsider", spaces: { elsewhere: "editor" } };

const INSTANCE_JSON = {
  users: [ADMIN, VIEWER, OUTSIDER],
  engineVersion: "1.0.0-test", updateFeed: "",
  mcpHostSuffixes: [], mcpHostAllowlistUrl: "", vanityRedirects: {}, rtOrigin: "", sentinels: [],
};
const ROUTING_JSON = {
  buildId: "test-build", versionMap: {},
  publicPrefixes: ["/prototypes/garden/"], publicSkillPrefixes: [],
  restrictedBases: [],
  canvasLoaderExtras: "", canvasCatalog: [], canvasTracks: [], mcpAllowlist: [],
  spaces: [{ id: "delta", name: "Delta", badge: "D", default: true, base: "", adminOnly: false }],
  defaultSpace: "delta",
};
const CONFIG = {
  "/__config/instance.json": JSON.stringify(INSTANCE_JSON),
  "/__config/routing.json": JSON.stringify(ROUTING_JSON),
};
const PAGES = new Set(["/prototypes/garden/", "/prototypes/garden/second/", "/prototypes/secret/"]);

function memKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return { store, async get(k) { return store.has(k) ? store.get(k) : null; }, async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); } };
}
const assetsStub = () => ({
  async fetch(req) {
    const p = new URL(typeof req === "string" ? req : req.url).pathname;
    if (p in CONFIG) return new Response(CONFIG[p], { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } });
    if (PAGES.has(p)) return new Response("<h1>canvas</h1>", { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
    return new Response("Not Found", { status: 404 });
  },
});

const GATED = "/prototypes/secret/";
const PUBLIC = "/prototypes/garden/";
const doc = (name) => ({ name, nodes: [], tombs: {}, clock: 1 });
const env = () => ({
  COMMENTS: memKV({ ["board:" + PUBLIC]: JSON.stringify(doc("Garden")), ["board:" + GATED]: JSON.stringify(doc("Secret")) }),
  ASSETS: assetsStub(),
  SESSION_SECRET,
  ROOM_TICKET_SECRET,
});
const ctx = { waitUntil() {} };

async function cookieFor(e, user) {
  const token = await W.userToken(e, user, user.passHash);
  return `${SESSION_COOKIE}=${user.email}.${token}`;
}
const boardUrl = (p) => "/__board" + (p == null ? "" : `?path=${encodeURIComponent(p)}`);
const mintUrl = (p) => `/__rt?mint=1&path=${encodeURIComponent(p)}`;
const roomUrl = (p) => `/__rt?path=${encodeURIComponent(p)}`;

const hit = (e, path, { cookie, headers = {}, method = "GET", body } = {}) =>
  worker.fetch(new Request("https://example.test" + path, {
    method, body, headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
  }), e, ctx);
const save = (e, p, cookie, name = "Written") => hit(e, boardUrl(p), { cookie, method: "POST", body: JSON.stringify({ doc: doc(name) }) });
const nameAt = async (e, p, cookie) => ((await (await hit(e, boardUrl(p), { cookie })).json()).doc || {}).name || null;
const UPGRADE = { Upgrade: "websocket" };

// ── /__board ────────────────────────────────────────────────────────────────────

test("/__board on a gated path: signed-out read is 401 and carries no doc", async () => {
  const e = env();
  const res = await hit(e, boardUrl(GATED));
  assert.equal(res.status, 401);
  assert.equal((await res.json()).doc, undefined);
});

test("/__board on a gated path: signed-out write is 401 and the board is untouched", async () => {
  const e = env();
  assert.equal((await save(e, GATED)).status, 401);
  assert.equal(await nameAt(e, GATED, await cookieFor(e, VIEWER)), "Secret");
});

test("/__board signed out with no ?path=, on the home page, on a draft address: 401", async () => {
  const e = env();
  for (const p of [null, "/", "/prototypes/garden@d1/", "/prototypes/garden%40d1/", "prototypes/garden/"]) {
    assert.equal((await hit(e, boardUrl(p))).status, 401, String(p));
    assert.equal((await save(e, p)).status, 401, String(p));
  }
});

test("/__board on a public path: signed-out read and write are allowed (the share-link model)", async () => {
  const e = env();
  assert.equal(await nameAt(e, PUBLIC), "Garden");
  assert.equal((await save(e, PUBLIC)).status, 200);
  assert.equal(await nameAt(e, PUBLIC), "Written");
});

test("/__board: a member reads and writes on a gated path and on a public path", async () => {
  const e = env();
  const cookie = await cookieFor(e, VIEWER);
  for (const p of [GATED, PUBLIC]) {
    assert.equal((await hit(e, boardUrl(p), { cookie })).status, 200, p);
    assert.equal((await save(e, p, cookie)).status, 200, p);
    assert.equal(await nameAt(e, p, cookie), "Written", p);
  }
});

test("/__board: signed in but not a member is the stranger the page gate sees", async () => {
  const e = env();
  const cookie = await cookieFor(e, OUTSIDER);
  assert.equal((await hit(e, boardUrl(GATED), { cookie })).status, 401);
  assert.equal((await save(e, GATED, cookie)).status, 401);
  assert.equal((await hit(e, boardUrl(PUBLIC), { cookie })).status, 200);
});

test("/__board: a stranger saves the FIRST document only where a canvas is published or created", async () => {
  const e = env();
  const before = e.COMMENTS.store.size;
  for (const p of [
    "/prototypes/garden/nothing-here/", "/prototypes/garden/../x/", "/prototypes/garden/%2e%2e/x/",
    "/prototypes/garden//", "/prototypes/garden/og.jpg", "/fonts/../x", "/pages/made-up/",
  ]) {
    const res = await save(e, p);
    assert.ok(res.status === 404 || res.status === 401, `${p} answered ${res.status}`);
  }
  assert.equal(e.COMMENTS.store.size, before, "a refused save left a document behind");
  // A published page with no board yet: the first save is the canvas being used.
  assert.equal((await save(e, "/prototypes/garden/second/")).status, 200);
  // A created board: public by the registry, and its first save is a stranger's to make.
  const made = await hit(e, "/__canvases", { cookie: await cookieFor(e, ADMIN), headers: { Origin: "https://example.test" }, method: "POST", body: JSON.stringify({ dir: "/playground/", name: "Sketch" }) });
  assert.equal(made.status, 200);
  assert.equal((await save(e, "/playground/sketch/")).status, 200);
  assert.equal((await hit(e, boardUrl("/playground/other/"))).status, 401);
  // A member may start one anywhere, as before.
  assert.equal((await save(e, "/prototypes/garden/nothing-here/", await cookieFor(e, VIEWER))).status, 200);
});

// ── /__rt ───────────────────────────────────────────────────────────────────────

test("/__rt mint on a gated path: signed-out is 401, a member gets a ticket", async () => {
  const e = env();
  assert.equal((await hit(e, mintUrl(GATED))).status, 401);
  assert.equal((await hit(e, mintUrl("/"))).status, 401);
  const res = await hit(e, mintUrl(GATED), { cookie: await cookieFor(e, VIEWER) });
  assert.equal(res.status, 200);
  assert.ok((await res.json()).ticket);
});

test("/__rt mint on a public path: signed-out still gets a ticket", async () => {
  const e = env();
  const res = await hit(e, mintUrl(PUBLIC));
  assert.equal(res.status, 200);
  assert.ok((await res.json()).ticket);
});

test("/__rt socket on a gated path: signed-out is 401 before any room; a member and a public path pass the gate", async () => {
  const e = env();
  assert.equal((await hit(e, roomUrl(GATED), { headers: UPGRADE })).status, 401);
  assert.equal((await hit(e, roomUrl(GATED), { headers: UPGRADE, cookie: await cookieFor(e, OUTSIDER) })).status, 401);
  // This env binds no rooms and names no realtime origin, so past the gate the honest
  // answer is 501: that it is 501 and not 401 is the gate letting the caller through.
  assert.equal((await hit(e, roomUrl(GATED), { headers: UPGRADE, cookie: await cookieFor(e, VIEWER) })).status, 501);
  assert.equal((await hit(e, roomUrl(PUBLIC), { headers: UPGRADE })).status, 501);
});

test("/__rt plain GET, signed out, any path: the deployment's own answer, as before (migrate's rooms probe)", async () => {
  const e = env();
  for (const p of ["/", GATED, PUBLIC]) {
    const res = await hit(e, roomUrl(p), { headers: { Accept: "application/json" } });
    assert.equal(res.status, 501, p);
    assert.equal((await res.json()).error, "realtime-not-configured", p);
  }
  const rooms = { ...env(), ROOMS: { idFromName() { throw new Error("no room may be reached"); }, get() { throw new Error("no room may be reached"); } } };
  assert.equal((await hit(rooms, roomUrl("/"))).status, 426);
});
