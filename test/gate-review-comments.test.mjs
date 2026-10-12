// E-28. /__review/api keys off a caller-supplied ?path= and is dispatched before the gate,
// so it has to ask the gate's own question about THAT path: may a caller with no session
// see this page? Until it did, the threads of a gated page (the workspace home, a gallery,
// a prototype nobody made public) were readable and writable by anyone who knew the
// hostname and guessed a path.
//
// The rule under test: a signed-out caller is answered only where the page itself is open
// to them (a public path by isPublicPath, or a created canvas board); a member is answered
// everywhere, as before; a draft address is never a stranger's. Harness as in
// gate-rt-board.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { default as worker, __testables as W } from "../src/_worker.js";

const SESSION_SECRET = "gate-review-comments-fixed-session-secret";
const SESSION_COOKIE = "__Host-augur_user";

const ADMIN = { email: "ada@example.test", name: "Ada", initials: "AA", color: "#2c2150", role: "admin", passHash: "seed-admin" };
const VIEWER = { email: "bob@example.test", name: "Bob", initials: "BB", color: "#204030", role: "viewer", passHash: "seed-viewer" };
// On the roster, but a member of some other workspace only: the page gate answers 404.
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

// What this workspace publishes. A stranger may start a thread only where a page is.
const PAGES = new Set(["/prototypes/garden/", "/prototypes/garden/index.html", "/prototypes/garden/og.jpg", "/prototypes/secret/"]);

function memKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return { store, async get(k) { return store.has(k) ? store.get(k) : null; }, async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); } };
}

const assetsStub = (instance) => ({
  async fetch(req) {
    const p = new URL(typeof req === "string" ? req : req.url).pathname;
    if (p === "/__config/instance.json") return new Response(JSON.stringify(instance), { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } });
    if (p === "/__config/routing.json") return new Response(JSON.stringify(ROUTING_JSON), { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } });
    if (PAGES.has(p)) return new Response("<h1>page</h1>", { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
    return new Response("Not Found", { status: 404 });
  },
});

const env = (instance = INSTANCE_JSON) => ({ COMMENTS: memKV(), ASSETS: assetsStub(instance), SESSION_SECRET });
const ctx = { waitUntil() {} };

async function cookieFor(e, user) {
  const token = await W.userToken(e, user, user.passHash);
  return `${SESSION_COOKIE}=${user.email}.${token}`;
}

const GATED = "/prototypes/secret/";   // published, not in publicPrefixes
const PUBLIC = "/prototypes/garden/";  // in publicPrefixes
const api = (p) => "/__review/api" + (p == null ? "" : `?path=${encodeURIComponent(p)}`);

const get = (e, p, cookie) =>
  worker.fetch(new Request("https://example.test" + api(p), { headers: cookie ? { Cookie: cookie } : {} }), e, ctx);

const add = (e, p, cookie, id = "t1") =>
  worker.fetch(new Request("https://example.test" + api(p), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ op: "add", thread: { id, sel: "h1", messages: [{ name: "Someone", text: "a word" }] } }),
  }), e, ctx);

const threadsOf = async (res) => (await res.json()).threads;

// ── A gated page keeps its threads behind the gate ──────────────────────────────

test("signed-out READ on a gated path is 401, and carries no threads", async () => {
  const e = env();
  assert.equal((await add(e, GATED, await cookieFor(e, VIEWER))).status, 200);
  const res = await get(e, GATED);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).threads, undefined);
});

test("signed-out WRITE on a gated path is 401, and nothing is stored", async () => {
  const e = env();
  assert.equal((await add(e, GATED)).status, 401);
  assert.deepEqual(await threadsOf(await get(e, GATED, await cookieFor(e, VIEWER))), []);
});

test("signed-out with NO ?path= is the workspace home: 401", async () => {
  const e = env();
  assert.equal((await get(e, null)).status, 401);
  assert.equal((await get(e, "/")).status, 401);
  assert.equal((await add(e, null)).status, 401);
});

test("signed-out on a draft address is 401, even when the unit it hangs off is public", async () => {
  const e = env();
  for (const p of ["/prototypes/garden@d1/", "/prototypes/garden%40d1/"]) {
    assert.equal((await get(e, p)).status, 401, p);
    assert.equal((await add(e, p)).status, 401, p);
  }
});

test("a path that is not a path is not public", async () => {
  const e = env();
  assert.equal((await get(e, "prototypes/garden/")).status, 401);
});

// ── A public page keeps the share-link model ────────────────────────────────────

test("signed-out READ and WRITE on a public path are allowed", async () => {
  const e = env();
  assert.equal((await get(e, PUBLIC)).status, 200);
  assert.equal((await add(e, PUBLIC)).status, 200);
  const threads = await threadsOf(await get(e, PUBLIC));
  assert.equal(threads.length, 1);
  assert.notEqual(threads[0].messages[0].verified, true); // a stranger's word stays unverified
});

test("signed-out on a created canvas board is allowed; the same folder without a board is not", async () => {
  const e = env();
  const made = await worker.fetch(new Request("https://example.test/__canvases", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://example.test", Cookie: await cookieFor(e, ADMIN) },
    body: JSON.stringify({ dir: "/playground/", name: "Sketch" }),
  }), e, ctx);
  assert.equal(made.status, 200);
  assert.equal((await made.json()).path, "/playground/sketch/");
  assert.equal((await get(e, "/playground/sketch/")).status, 200);
  assert.equal((await add(e, "/playground/sketch/")).status, 200);
  assert.equal((await get(e, "/playground/sketch/index.html")).status, 200);
  assert.equal((await get(e, "/playground/other/")).status, 401);
  assert.equal((await get(e, "/playground/")).status, 401);
});

// ── A stranger may add to a page's threads, not open a document where no page is ──

test("signed-out FIRST thread at a public-looking address with no page behind it is 404, and stores nothing", async () => {
  const e = env();
  const before = e.COMMENTS.store.size;
  for (const p of [
    "/prototypes/garden/nothing-here/",   // under the public prefix, never published
    "/prototypes/garden/../x/",           // folds to somewhere else
    "/prototypes/garden/%2e%2e/x/",
    "/prototypes/garden//",
    "/prototypes/garden/og.jpg",          // a real file, not a page
    "/prototypes/garden/nothing/og.jpg",
    "/fonts/../x",
    "/pages/made-up/",
  ]) {
    const res = await add(e, p);
    assert.ok(res.status === 404 || res.status === 401, `${p} answered ${res.status}`);
  }
  assert.equal(e.COMMENTS.store.size, before, "a refused write left a document behind");
});

test("signed-out reply at an odd address that ALREADY holds a thread still works (a conversation in progress)", async () => {
  const e = env();
  const odd = "/prototypes/garden/nothing-here/";
  assert.equal((await add(e, odd, await cookieFor(e, VIEWER), "m1")).status, 200); // a member may start anywhere
  assert.equal((await add(e, odd, null, "s1")).status, 200);
  assert.equal((await threadsOf(await get(e, odd))).length, 2);
});

test("signed-out first thread on the page's index.html spelling is allowed", async () => {
  const e = env();
  assert.equal((await add(e, "/prototypes/garden/index.html")).status, 200);
});

// ── A member is answered everywhere, as before ──────────────────────────────────

test("a member reads and writes on a gated path and on a public path", async () => {
  const e = env();
  const cookie = await cookieFor(e, VIEWER);
  for (const p of [GATED, PUBLIC, "/"]) {
    assert.equal((await add(e, p, cookie)).status, 200, p);
    const threads = await threadsOf(await get(e, p, cookie));
    assert.equal(threads.length, 1, p);
    assert.equal(threads[0].messages[0].verified, true, p);
  }
});

test("signed in but not a member of this workspace: treated as the stranger the page gate sees", async () => {
  const e = env();
  const cookie = await cookieFor(e, OUTSIDER);
  assert.equal((await get(e, GATED, cookie)).status, 401);
  assert.equal((await add(e, GATED, cookie)).status, 401);
  assert.equal((await get(e, PUBLIC, cookie)).status, 200);
});

// ── No roster: the shared password (or nothing at all) is the whole gate ─────────
//
// Asked of the helper, not through fetch: the worker keeps one loaded config per isolate,
// so a second instance.json in this file would be answered from the first.

test("legacy and open mode: past the gate is the whole answer, there is no membership to ask", () => {
  const tctx = { SPACES: ROUTING_JSON.spaces };
  assert.equal(W.isWorkspaceMember(tctx, false, true, null), true);   // open build, or the password cookie
  assert.equal(W.isWorkspaceMember(tctx, false, false, null), false); // password set, no cookie
  assert.equal(W.isWorkspaceMember(tctx, true, false, null), false);  // roster, signed out
  assert.equal(W.isWorkspaceMember(tctx, true, true, VIEWER), true);
  assert.equal(W.isWorkspaceMember(tctx, true, true, OUTSIDER), false);
});
