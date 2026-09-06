// `/__welcome` — the five-step onboarding flow, and the gate that sends a member to it.
//
// Two halves, and they fail in opposite directions on purpose. The PAGE is a
// self-contained document served to a signed-in editor or admin; a viewer is never shown
// it, because a viewer publishes nothing and has nothing to connect. The GATE is one
// redirect on `/`, and its only job is to be liftable: "do this later" writes a flag and
// the redirect stops, forever, for that person. Everything here drives the real worker
// through `worker.fetch` with a real session cookie and a real `TenantStore` behind
// `env.TENANTS` — the same shape test/first-publish-signal.test.mjs and
// test/onboarding-me.test.mjs use — because a gate asserted about in pieces is a gate
// whose placement in the router is untested, and its placement is the whole risk.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import worker, { __testables as W } from "../src/_worker.js";
import { TenantStore } from "../src/tenant-do.js";
import { memKV, cookieFor, ADA_MEMBER, VERA } from "./fixtures/unit-env.mjs";

// ---- the one Cloudflare global Node lacks ---------------------------------------------
// serveContent's withLiveReload() appends the live-reload <script> to <body> of every
// HTML response through HTMLRewriter — needed once a test here fetches a real public
// prototype path rather than only /__* routes. Identical stand-in to the one
// test/tenant-route-sweep.test.mjs and test/response-snapshot.test.mjs install; not
// shared between the files on purpose (see their own comments).
if (!globalThis.HTMLRewriter) {
  globalThis.HTMLRewriter = class {
    constructor() { this._handlers = []; }
    on(selector, handlers) { this._handlers.push({ selector, handlers }); return this; }
    transform(res) {
      const handlers = this._handlers;
      const stream = new ReadableStream({
        async start(controller) {
          let text = await res.text();
          for (const { selector, handlers: h } of handlers) {
            if (selector === "body" && h.element) {
              let appended = "";
              h.element({ append(html) { appended += html; } });
              text = /<\/body>/i.test(text) ? text.replace(/<\/body>/i, appended + "</body>") : text + appended;
            }
          }
          controller.enqueue(new TextEncoder().encode(text));
          controller.close();
        },
      });
      return new Response(stream, { status: res.status, statusText: res.statusText, headers: res.headers });
    }
  };
}

const ORIGIN = "https://acme.example";
let SEQ = 0;

// A DO storage stub with REAL transaction semantics — copied from
// test/onboarding-me.test.mjs, which copied it from test/first-publish-signal.test.mjs.
function storage(db) {
  const sql = {
    exec(stmt, ...params) {
      if (params.length) {
        const s = db.prepare(stmt);
        return /^\s*SELECT|RETURNING/i.test(stmt) ? s.all(...params) : (s.run(...params), []);
      }
      if (/^\s*SELECT/i.test(stmt)) return db.prepare(stmt).all();
      db.exec(stmt);
      return [];
    },
  };
  return {
    sql,
    transactionSync(cb) {
      db.exec("BEGIN");
      try { const out = cb(); db.exec("COMMIT"); return out; }
      catch (e) { db.exec("ROLLBACK"); throw e; }
    },
  };
}

// TWO per-isolate caches have to be cleared between fixtures — the tenant memo and the
// config cache — or every fixture after the first answers as the first one. See the same
// note in test/device-pairing.test.mjs, which learned it the hard way.
function freshIsolate() {
  W.__setTenantTestState({ memo: null });
  W.__setConfigTestState({ cfgAt: 0, cfgGoodAt: 0, roster: null, manifests: null, storage: null, suspension: null });
}

// A published prototype path, for the "public prototype stays public" regression pin —
// under routing.publicPrefixes in the fixture's manifest, so isPublicPath() opens it
// before the gate (and the welcome redirect) ever gets a say.
const PUBLIC_PROTO = "/proj/proto/";

/**
 * A provisioned workspace object behind `env.TENANTS`, rostered with `users`, and an
 * instance config naming the same people — everything the gate and the page touch.
 *
 * `pairing` defaults ON: the welcome flow only stands in its slot where device pairing
 * is on (welcomeFlow in _worker.js), and this fixture is the one that drives the flow
 * end to end, so it has to mirror `instance({pairing: true})` in
 * test/device-pairing.test.mjs rather than the flag's own off-by-default.
 */
async function wired(users, { pairing = true, publicPrefixes = [] } = {}) {
  freshIsolate();
  const tenantId = `welcome-${++SEQ}`;
  const db = new DatabaseSync(":memory:");
  const object = new TenantStore({ storage: storage(db), blockConcurrencyWhile: async (f) => f() }, {});
  await object.provision({ workspaceId: tenantId, adminEmail: users[0].email, adminName: users[0].name || "" });
  await object.fetch(new Request("https://workspace/identity/roster/write", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspaceId: tenantId,
      configUsers: users.map((u) => ({ email: u.email, role: u.role, name: u.name })),
    }),
  }));
  const env = {
    SESSION_SECRET: "welcome-page-fixed-secret",
    COMMENTS: memKV(),
    ASSETS: {
      fetch: async (req) => {
        const p = new URL(typeof req === "string" ? req : req.url).pathname;
        if (p === "/__config/instance.json") {
          return new Response(JSON.stringify({ users, tenantId, devicePairing: pairing }), { headers: { "content-type": "application/json" } });
        }
        if (p === "/__config/routing.json") {
          return new Response(JSON.stringify({ spaces: [{ id: "acme", default: true }], publicPrefixes }), { headers: { "content-type": "application/json" } });
        }
        if (p === "/") {
          return new Response("<!doctype html><title>gallery</title>the gallery", { headers: { "content-type": "text/html" } });
        }
        if (p === PUBLIC_PROTO) {
          return new Response("<!doctype html><title>proto</title>the public prototype", { headers: { "content-type": "text/html" } });
        }
        return new Response("Not Found", { status: 404 });
      },
    },
    TENANTS: {
      idFromName: (n) => n,
      get: () => ({ fetch: (input, init) => object.fetch(new Request(input, init)) }),
    },
  };
  return { env, object, tenantId };
}

/**
 * What a redeemed invite does to a member's row — the ONE thing that makes the welcome
 * flow owed (`noteInviteRedeemed` in _worker.js, over this same route). Driven against the
 * object here because these tests reach the worker through `worker.fetch` and hold no
 * `tctx` of their own.
 */
const owe = (object, tenantId, user) => object.fetch(new Request("https://workspace/onboarding/welcome-set", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ workspaceId: tenantId, email: user.email, owed: true }),
}));

async function fetchAs(env, user, path, init = {}) {
  freshIsolate();
  const headers = { ...(init.headers || {}) };
  if (user) headers.Cookie = await cookieFor(env, user);
  const orig = console.log; console.log = () => {};
  try {
    return await worker.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }), env, { waitUntil() {} });
  } finally { console.log = orig; }
}

test("/ sends an OWED editor to /__welcome and leaves a viewer alone", async () => {
  const { env, object, tenantId } = await wired([ADA_MEMBER, VERA]);
  await owe(object, tenantId, ADA_MEMBER);
  const r = await fetchAs(env, ADA_MEMBER, "/");
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/__welcome");
  const v = await fetchAs(env, VERA, "/");
  assert.notEqual(v.status, 303, "a viewer is never gated");
  const later = await fetchAs(env, ADA_MEMBER, "/__onboarding/me", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ later: true }),
  });
  assert.equal(later.status, 200);
  assert.notEqual((await fetchAs(env, ADA_MEMBER, "/")).status, 303, "later lifts the gate");
});

// ⚠️ THE REGRESSION THIS PINS. The gate's conditions were role plus two absent flags,
// which every member of an existing roster satisfies — so the first deployment onto a
// workspace with people already in it redirected all of them, every load, to a flow about
// connecting a terminal they had never asked for. Nothing on the row could have said
// otherwise: being owed the flow had no record at all until `welcome_owed_at`.
test("an editor who was already a member is served the gallery, never the welcome flow", async () => {
  const { env } = await wired([ADA_MEMBER, VERA]);
  const r = await fetchAs(env, ADA_MEMBER, "/");
  assert.notEqual(r.status, 303, "a pre-existing member must never be gated by an onboarding flow");
  assert.equal(r.status, 200);
  assert.match(await r.text(), /the gallery/);
  // And the read the page itself polls agrees with the redirect, which is the property
  // two formulas would break on exactly the tick they disagreed.
  const me = await fetchAs(env, ADA_MEMBER, "/__onboarding/me");
  assert.equal((await me.json()).gated, false);
});

test("/__welcome is one self-contained page with the five steps and the command", async () => {
  const { env } = await wired([ADA_MEMBER]);
  const r = await fetchAs(env, ADA_MEMBER, "/__welcome");
  assert.equal(r.status, 200);
  const html = await r.text();
  for (const s of ['data-step="agent"', 'data-step="install"', 'data-step="connect"', 'data-step="change"', 'data-step="done"']) {
    assert.ok(html.includes(s), s);
  }
  assert.match(html, /npx @augurworks\/augur connect --origin https:\/\/acme\.example/);
  assert.match(html, /\/__onboarding\/me/);
  assert.match(html, /\/__onboarding\/installer\/mac/);
  // The download is a zip, so the file a person opens is not the file they downloaded —
  // the page names it, from the same helper that names it inside the archive.
  assert.match(html, /connect-acme\.example\.command/, "the page says which file to open after unpacking");
  assert.doesNotMatch(html, /<script src=|<link rel="stylesheet"/, "no external request leaves this page");
  assert.match(html, /do this later/i);
});

test("a viewer asking for /__welcome is sent to /", async () => {
  const { env } = await wired([VERA]);
  const r = await fetchAs(env, VERA, "/__welcome");
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/");
});

// ── the flow exists only where device pairing is on ─────────────────────────────────
//
// welcomeFlow(tctx) in _worker.js is `!!tctx && !tctx.FIRST_RUN && !!tctx.DEVICE_PAIRING`:
// the flow's own middle (connect/install → approve a code) is `pairApi`, which answers
// null with pairing off, so a deployment that has not turned pairing on would show a
// flow with no way past step two. With pairing off the surface reverts to what it was
// before this feature existed at all — no route, no redirect — and every test above
// this one turns pairing ON (see `wired`'s default) to exercise the flow itself.
test("with device pairing off, an OWED editor's / is not redirected and /__onboarding/me still answers", async () => {
  const { env, object, tenantId } = await wired([ADA_MEMBER, VERA], { pairing: false });
  await owe(object, tenantId, ADA_MEMBER);   // owed, so the pairing clause is the only thing lifting the gate
  const r = await fetchAs(env, ADA_MEMBER, "/");
  assert.notEqual(r.status, 303, "no route stands in the slot with pairing off, so nothing gates /");
  const me = await fetchAs(env, ADA_MEMBER, "/__onboarding/me");
  assert.equal(me.status, 200, "the member's own onboarding read is unconditional, pairing or not");
});

// ── regression pins ──────────────────────────────────────────────────────────────────

test("a signed-in gated editor fetching a public prototype path is served it, not redirected", async () => {
  const { env, object, tenantId } = await wired([ADA_MEMBER, VERA], { publicPrefixes: [PUBLIC_PROTO] });
  await owe(object, tenantId, ADA_MEMBER);   // genuinely gated, or this pin proves nothing
  // Same person, same request shape as the very first test above — only the path
  // differs — so this pins that isPublicPath (checked ahead of the welcome gate, see
  // the placement note above owedWelcome's call site) still wins for a share link.
  const r = await fetchAs(env, ADA_MEMBER, PUBLIC_PROTO);
  assert.notEqual(r.status, 303, "a public prototype must never become an onboarding redirect");
  assert.equal(r.status, 200);
  assert.match(await r.text(), /the public prototype/);
});

test("a roster member who is not in the default space gets the membership gate's 404, not the welcome redirect", async () => {
  const nonMember = { ...ADA_MEMBER, email: "nomember@example.test", name: "Nomi", initials: "NM" };
  const { env, object, tenantId } = await wired([ADA_MEMBER, nonMember]);
  await owe(object, tenantId, nonMember);   // owed the flow, so the ORDER of the two gates is what this reads
  // `users:spaces` is the overlay isMemberOf reads (see membership-gate.test.mjs): an
  // entry present but empty means "a member of nothing", including the default space.
  await env.COMMENTS.put("users:spaces", JSON.stringify({ "nomember@example.test": {} }));
  const r = await fetchAs(env, nonMember, "/");
  assert.equal(r.status, 404, "a non-member must see the same refusal a stranger's guess would get");
  assert.notEqual(r.headers.get("location"), "/__welcome", "the welcome gate sits below the membership gate and must never fire first");
});

// ── /__onboarding/installer/mac ──────────────────────────────────────────────────────
//
// Same guard as /__welcome itself (welcomeFlow(tctx): device pairing on), since the
// installer only exists to serve that flow's "not yet" branch.

test("an editor downloads the mac installer as a ZIP whose one entry is the .command", async () => {
  const { env } = await wired([ADA_MEMBER, VERA]);
  const r = await fetchAs(env, ADA_MEMBER, "/__onboarding/installer/mac");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/zip");
  assert.equal(r.headers.get("content-disposition"), 'attachment; filename="connect-acme.example.zip"');
  const body = new Uint8Array(await r.arrayBuffer());
  // A zip is what makes the file arrive executable — HTTP carries no mode, and a bare
  // .command saves 0644, which Terminal refuses. src/zip-store.mjs writes the mode; the
  // unpack itself is proven in test/installer-mac.test.mjs against a real `unzip`.
  assert.deepEqual([...body.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04], "PK\\x03\\x04 — a local file header");
  const text = new TextDecoder().decode(body);
  assert.match(text, /connect-acme\.example\.command/, "the entry is named for this workspace");
  // STORE, not DEFLATE, so the script is legible in the archive's own bytes.
  assert.match(text, /set -euo pipefail/);
  assert.match(text, /connect --origin https:\/\/acme\.example/);
});

test("a viewer asking for the mac installer is forbidden", async () => {
  const { env } = await wired([ADA_MEMBER, VERA]);
  const r = await fetchAs(env, VERA, "/__onboarding/installer/mac");
  assert.equal(r.status, 403);
  assert.match(r.headers.get("content-type") || "", /application\/json/);
  assert.deepEqual(await r.json(), { error: "forbidden" });
});

// ⚠️ THE LINK ON THE PAGE USED TO CARRY `download`, and a `download` anchor saves whatever
// body a navigation ends on — redirects included — under the filename in the header.
// Answering a signed-out request with the login page directly — which is what this route
// used to do, mirroring /__welcome — therefore put the sign-in HTML on somebody's disk as
// connect-<host>.zip, with nothing on screen. The attribute is gone now (it was redundant:
// the 200 response already forces the save via Content-Disposition), so a plain 303 to
// /__welcome genuinely renders the login page rather than saving it.
test("signed out, the mac installer route redirects to /__welcome rather than serving a page as a file", async () => {
  const { env } = await wired([ADA_MEMBER]);
  const r = await fetchAs(env, null, "/__onboarding/installer/mac");
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/__welcome");
  assert.equal(await r.text(), "", "no body at all — a stray body here would have been saved to disk under the old download-anchor behavior");
});
