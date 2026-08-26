// The ROUTE SWEEP — two workspaces, one isolate, BUNDLE mode, through the real default
// export, over every route a leak has somewhere to come out of.
//
// ---- WHY THIS FILE EXISTS AND WHAT IT REPLACES ---------------------------------------
//
// Three independent adversarial rounds each found a cross-tenant leak that every ratchet
// in this repo passed green: the board registry, the remark queue, and the roster overlay
// — the last an AUTHORIZATION boundary, where a viewer in one workspace came back ADMIN
// out of a neighbour's role overlay, on an UNGATED route, to a signed-out stranger.
//
// The third round then established the two facts this file is built on:
//
//   MODULE SCOPE IS CLEAN. Every binding the worker's module graph carries was
//   enumerated and driven with two workspaces over the real request path. Nothing
//   crossed. The leaks were never a binding somebody forgot to thread.
//
//   THE GUARD IS WHAT LEAKS. Seven genuinely-unsafe shapes were injected into a scratch
//   copy of src/ and the shipped lint caught three. The decisive bypass needs no new
//   declaration and no allowlist edit at all: ordinary memoisation hung off a FUNCTION
//   OBJECT (`statusApi.__memo = …`). Two successive rebuilds of that lint have each
//   caught the shape in front of them and missed the next one.
//
// So this is not another attempt to make a static lint adjudicate. It is the thing that
// actually found the leaks — drive both workspaces through the real routes and compare
// each answer against what that workspace's OWN documents say — turned into checked-in
// coverage. `scripts/no-tenant-globals.mjs` stays, as a cheap first filter that says so
// in its own header; THIS is the backstop.
//
// ---- WHY BUNDLE MODE ------------------------------------------------------------------
//
// Every deployed instance serves in bundle mode: routing is DERIVED from the live
// manifests in the store, not read from a document a build shipped. Assets mode is the
// local path (`augur dev`, `npm run offline`, a raw engine build). Before this file, every
// fetch()-driven case in the suite — including the byte snapshot — ran in ASSETS mode, so
// the branch of `loadTenantContext` that every live instance actually takes, and the
// store caches behind it, had no end-to-end two-workspace coverage at all.
//
// ---- WHY IT DRIVES fetch() AND NOT THE HANDLERS --------------------------------------
//
// Half the routes below are reached from EARLY EXITS, ahead of the login page: /__people,
// /__avatar/, /__piti, a board's loader page, /__version, the OG card, the unfurl meta on
// the login page itself. For those the leak is not "a signed-in member of one workspace
// sees a neighbour's colleague" — it is "a stranger with no cookie does", and only the
// router can tell those apart. The authenticated half then rides the same table, because
// the caches are shared between the two halves and a fix that keys one is not evidence
// about the other.
//
// ---- HOW A GREEN RESULT IS KEPT FROM BEING VACUOUS -----------------------------------
//
// Five ways, all of them mechanical:
//
//   1. EVERY ROUTE IS COMPARED AGAINST ITS OWN WORKSPACE'S EXPECTED ANSWER, never against
//      the other workspace's answer. A cache that hands every workspace one wrong answer
//      makes two loads compare EQUAL, so same-vs-same comparison is blind to exactly the
//      leak that matters most. `own(n)` is written from the fixture.
//   2. THE TWO ANSWERS ARE ASSERTED TO DIFFER before anything else runs (`shared` routes
//      declare, in writing, why they cannot). A route both workspaces answer identically
//      by accident is a route whose isolation assertion proves nothing, forever.
//   3. THE SECOND WORKSPACE MUST HAVE READ ITS OWN KEYS. Each route names a `witness` —
//      a KV key or a store object that this workspace's own store must have been asked
//      for while the request was served. An answer that is correct but came out of a
//      neighbour's tick is not isolation, it is luck, and the next TTL spends it.
//   4. AND THE CONCURRENT PHASE IS NOT A LUXURY. Measured, by collapsing each keyed cache
//      to one slot in a scratch tree: an unkeyed roster overlay, board registry, remark
//      queue or storage gauge reds the SEQUENTIAL phase — but an unkeyed MANIFESTS cache
//      reds ONLY the concurrent one. Every config load re-reads the manifests with
//      `force`, so two workspaces taking turns keep overwriting the shared slot with the
//      right content and the leak self-heals between requests; it takes two requests
//      genuinely in flight for one to read what the other put there. A sequential-only
//      sweep would be green on the cache that holds a workspace's whole published site.
//   5. THE CACHES MUST STILL BE CACHES. Deleting a cache satisfies every isolation
//      assertion above and puts the KV reads that exhausted the daily get() budget
//      (2026-08-20) straight back. A route that declares a witness is also asserted NOT
//      to re-read it on an immediate repeat for the same workspace.
//
// ---- ADDING A ROUTE IS ONE LINE ------------------------------------------------------
//
// The next leak will be on a route nobody thought to list, so listing one has to be
// cheap. Append to ROUTES:
//
//   route("my-thing", {
//     path: (n) => `/__mything?path=/prototypes/${n}-one/`,
//     read: async (res) => (await res.json()).thing,   // the observation
//     own:  (n) => `thing of ${n}`,                    // what THIS workspace must answer
//     witness: (n) => ["mything:key"],                 // its own store keys, optional
//     auth: "admin",                                   // omit for an ungated route
//     neighbour: () => null,                           // what n gets asking for other's URL
//   }),
//
// and every phase below picks it up: cold-and-alone, sequential inside every TTL in both
// orders, the neighbour's-URL probe, the still-a-cache check, and the concurrent
// interleave. Nothing else needs touching.
//
// ---- WHAT IT ALREADY CAUGHT ----------------------------------------------------------
//
// On its first run, before it had ever been used against a sabotage: `loadManifests`
// stamped its 1.5s tick BEFORE reading the store and handed the not-yet-filled
// placeholder view to every request that arrived alongside the first one. At a cold
// isolate that view is empty, so a burst was answered with a 404 for every published page
// and a /_build.json describing an empty site. Not a cross-tenant bug — it reproduces with
// ONE workspace — but it needed a cold isolate AND concurrency AND bundle mode, and no
// fetch()-driven case in the suite had all three. It has its own case at the bottom.
//
// ---- WHAT THIS COSTS -----------------------------------------------------------------
//
// MEASURED: 0.26 s of test time, 0.29 s wall clock for this file alone. The whole suite is
// 12.2 s without it and 12.3 s with it — node --test forks per file and runs them in
// parallel, so it adds nothing anyone waits for. The expensive thing here is PBKDF2, and
// the two password hashes the admin cookies need are computed ONCE per workspace at setup,
// never per request.
//
// That budget is load-bearing. node --test FORKS PER FILE, so this file and
// test/tenant-isolation.test.mjs are the only two places in the whole suite where two
// workspaces share an isolate; a backstop nobody runs is not a backstop. If a phase ever
// starts costing seconds, cut ROUNDS — never routes.

import { test } from "node:test";
import assert from "node:assert/strict";

// ---- the one Cloudflare global Node lacks ---------------------------------------------
// `withLiveReload()` appends the live-reload <script> to <body> of every HTML response
// through HTMLRewriter. Installed BEFORE the worker is imported, and identical in
// behaviour to the stand-in test/response-snapshot.test.mjs installs (it supports only
// what withLiveReload uses: .on("body", {element}) → append as body's last child). Not
// shared between the two files on purpose: the snapshot is a byte ratchet whose harness
// is the authority for its own baseline, and a shim it imported from here could move its
// bytes from a file that is not about bytes.
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

const { default: worker, __testables: W } = await import("../src/_worker.js");

const NAMES = ["alpha", "beta"];
const other = (n) => NAMES.find((x) => x !== n);

// KV keys the worker does not export. Spelled out here on purpose: the sweep asserts each
// workspace's own key was READ, so a rename that made one of these dead would turn a
// witness silent — and the route's answer would go wrong in the same commit, loudly.
const ROSTER_KEY = "users:roster";
const REMARKS_KEY = "pt:remarks";
const STATUS_KEY = "statuses";
const NAMES_KEY = "names";

// ---- the two workspaces ---------------------------------------------------------------
//
// Every value is woven with the workspace's name, so a leaked one names its owner in the
// failure message instead of merely being "not what was expected".

const PASSWORD = "correct horse battery staple";
const ADMIN_EMAIL = (n) => `one@${n}.invalid`;
const GUEST_EMAIL = (n) => `two@${n}.invalid`;

const PNG = (tag) => "data:image/png;base64," + Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]),
  Buffer.from((tag + "................................").slice(0, 32)),
]).toString("base64");

const instanceDoc = (n) => ({
  tenantId: n,
  users: [{ email: ADMIN_EMAIL(n), name: `One of ${n}`, role: "admin" }],
  engineVersion: `0.14.0-${n}`,
  updateFeed: `https://feed.${n}.invalid/releases`,
  rtOrigin: `https://rt.${n}.invalid`,
  mcpHostSuffixes: [`.${n}.invalid`],
  vanityRedirects: {},
  sentinels: [],
  loginHint: `the ${n} hint`,
});

// The prototype this workspace publishes, as bytes in its own store. The HTML carries a
// stale chrome reference on purpose: composeChrome rewrites it to the CALLING workspace's
// pointer, so the served page is evidence about which workspace's _engine manifest was read.
const protoHtml = (n) =>
  `<!doctype html><html><head><link rel="stylesheet" href="/_chrome.0.0.00000000.css" />` +
  `</head><body><h1>Prototype of ${n}</h1></body></html>`;
const ogBytes = (n) => `JPEG-BYTES-OF-${n}`;
const adminHtml = (n) =>
  `<!doctype html><html><body><main>Admin panel of ${n}</main>` +
  `<script src="/_chrome.0.0.00000000.js"></script></body></html>`;
const CHROME_CSS = (n) => `_chrome.1.0.${n === "alpha" ? "aaaaaaaa" : "bbbbbbbb"}.css`;
const CHROME_JS = (n) => `_chrome.1.0.${n === "alpha" ? "aaaaaaaa" : "bbbbbbbb"}.js`;

const proto = (n) => `/prototypes/${n}-one/`;
const board = (n) => `/boards/${n}-board/`;

function manifestsFor(n) {
  const file = (body, ct) => ({ h: "", ct, s: Buffer.byteLength(body) });
  const html = protoHtml(n), og = ogBytes(n), admin = adminHtml(n);
  const files = {
    [proto(n) + "index.html"]: { ...file(html, "text/html; charset=utf-8"), h: `h-${n}-proto` },
    [proto(n) + "og.jpg"]: { ...file(og, "image/jpeg"), h: `h-${n}-og` },
  };
  const engineFiles = { "/admin/index.html": { ...file(admin, "text/html; charset=utf-8"), h: `h-${n}-admin` } };
  return {
    _engine: {
      space: { id: "_engine" },
      version: 7,
      source: { sha: `engine-sha-${n}`, dirty: false },
      files: engineFiles,
      routing: {
        canvasLoaderExtras: `<script src="/${n}-loader.js"></script>`,
        chrome: { css: CHROME_CSS(n), js: CHROME_JS(n) },
        runtimeChrome: true,
        shellSig: `engine-${n}`,
      },
    },
    [n]: {
      space: { id: n, name: `Workspace ${n}`, description: `The ${n} workspace`, default: true },
      version: n.length,
      source: { sha: `sha-${n}`, dirty: false },
      publishedAt: `2026-08-2${n.length % 9}T00:00:00.000Z`,
      publishedBy: `publisher@${n}.invalid`,
      files,
      routing: {
        publicPrefixes: [proto(n)],
        publicSkillPrefixes: [`/skills/${n}-ui/`],
        versionMap: { [proto(n)]: `v-${n}` },
        canvasCatalog: [{ id: `${n}-card`, href: proto(n) }],
        canvasTracks: [{ id: `${n}-track` }],
        mcpAllowlist: [`mcp.${n}.invalid`],
        mcpPaths: [`/${n}/api`],
        shellSig: `sig-${n}`,
      },
    },
  };
}

// This workspace's KV. Separate per workspace, like `servingFixture` in
// test/tenant-isolation.test.mjs and for the same reason: these documents ARE the
// workspace's own content, and "did THIS workspace's store get read" is half of what the
// sweep asserts. (The publish-token exchange in that file shares one KV between two
// workspaces on purpose — a different question, already covered there.)
function kvSeed(n) {
  return {
    [ROSTER_KEY]: JSON.stringify({ add: { [GUEST_EMAIL(n)]: { email: GUEST_EMAIL(n), name: `Two of ${n}` } }, remove: [] }),
    [W.USER_AVATARS_KEY]: JSON.stringify({ [GUEST_EMAIL(n)]: { k: `${n}face`, mime: "image/png", at: 1 } }),
    [W.USER_ROLES_KEY]: JSON.stringify({ [GUEST_EMAIL(n)]: "editor" }),
    [W.SPACE_ICONS_KEY]: JSON.stringify({ [n]: { k: `${n}icon`, mime: "image/png", at: 1 } }),
    // ⚠️ BOTH stores hold the blob at the NEIGHBOUR's avatar hash too. Avatar blobs are
    // content-addressed, so anything sharing a namespace shares them; the only thing
    // standing between a workspace and those bytes is whether its OWN photo index vouches
    // for the hash. A fixture where the blob were simply missing would 404 for a reason
    // that has nothing to do with the index — and would pass against a leaking worker.
    [W.AVATAR_BLOB_PREFIX + `${n}face`]: PNG(`${n}-face`),
    [W.AVATAR_BLOB_PREFIX + `${other(n)}face`]: PNG(`${other(n)}-face`),
    [W.SPACE_ICON_BLOB_PREFIX + `${n}icon`]: PNG(`${n}-icon`),
    [W.SPACE_ICON_BLOB_PREFIX + `${other(n)}icon`]: PNG(`${other(n)}-icon`),
    [W.CANVASES_KEY]: JSON.stringify({ [board(n)]: { name: `Board of ${n}`, by: "", t: 1 } }),
    [W.BOARD_PREFIX + board(n)]: JSON.stringify({ name: `Board doc of ${n}`, nodes: [] }),
    [REMARKS_KEY]: JSON.stringify([{ id: 1, path: "/p/", text: `${n}'s queued remark`, kind: "ux", ts: Date.now() }]),
    ["c:" + proto(n)]: JSON.stringify([{ id: "t1", path: proto(n), msgs: [{ id: "m1", text: `${n} comment`, by: "" }] }]),
    [STATUS_KEY]: JSON.stringify({ [proto(n)]: `status-of-${n}` }),
    [NAMES_KEY]: JSON.stringify({ [proto(n)]: `Name in ${n}` }),
    [`pins:${ADMIN_EMAIL(n)}`]: JSON.stringify({ [proto(n)]: { label: `Pin of ${n}`, href: proto(n) } }),
    ["publish:tokens"]: JSON.stringify({ [`hash-${n}`]: { space: n, label: `token-of-${n}`, createdAt: "2026-01-01T00:00:00.000Z" } }),
    // Seeded so /__admin/version answers from KV and never reaches for the network: the
    // suite must not make an outbound request, and a stubbed global fetch would be one
    // more shared thing between two workspaces.
    ["engine:update-check"]: JSON.stringify({ at: Date.now(), latest: `9.9.9-${n}`, url: `https://rel.${n}.invalid` }),
  };
}

// A whole serving environment for one workspace: its bundle store, its KV, and ONE log of
// every key either was asked for. Bundle mode, because that is what a live instance runs.
function workspace(n) {
  const manifests = manifestsFor(n);
  const blobs = {
    "config/instance.json": JSON.stringify(instanceDoc(n)),
    [`blobs/h-${n}-proto`]: protoHtml(n),
    [`blobs/h-${n}-og`]: ogBytes(n),
    [`blobs/h-${n}-admin`]: adminHtml(n),
  };
  for (const [id, m] of Object.entries(manifests)) blobs[`spaces/${id}/manifest.json`] = JSON.stringify(m);

  // Every object in this workspace's store, weighed. Distinct per workspace, and read
  // back by the gauge route below rather than restated there — an expectation copied by
  // hand is an expectation that can be copied wrong and still look like a leak.
  const storeObjects = Object.keys(blobs).map((k, i) => ({ key: k, size: 100 * (n.length + i) }));
  const gauge = {
    enabled: true,
    bytes: storeObjects.reduce((t, o) => t + o.size, 0),
    objects: storeObjects.length,
  };

  const store = new Map(Object.entries(kvSeed(n)));
  const reads = [];
  const seen = (k) => { reads.push(k); return k; };

  const env = {
    GV_ASSET_SOURCE: "r2",
    RT_SHARED_SECRET: `rt-${n}`,
    BUNDLES: {
      async list({ prefix, delimiter, cursor } = {}) {
        seen(`LIST ${prefix || ""}`);
        if (delimiter) {
          return { delimitedPrefixes: Object.keys(manifests).map((id) => `spaces/${id}/`), objects: [], truncated: false };
        }
        // The fill gauge's walk. Distinct per workspace, so a gauge answered out of the
        // wrong store names its owner.
        return { objects: storeObjects, truncated: false };
      },
      async head(key) { seen("HEAD " + key); return blobs[key] === undefined ? null : { etag: `"etag-${n}-${key}"` }; },
      async get(key) {
        seen(key);
        const body = blobs[key];
        if (body === undefined) return null;
        return { etag: `"etag-${n}-${key}"`, body, async text() { return body; } };
      },
    },
    COMMENTS: {
      async get(key, type) {
        seen(key);
        const v = store.has(key) ? store.get(key) : null;
        if (type === "arrayBuffer" && v !== null) return new TextEncoder().encode(v);
        return v;
      },
      async put(key, value) { store.set(key, value); },
      async delete(key) { store.delete(key); },
      async list({ cursor, limit } = {}) {
        seen("KVLIST");
        return { keys: [...store.keys()].map((name) => ({ name })), list_complete: true };
      },
    },
  };
  return { id: n, env, store, reads, manifests, gauge };
}

// ---- driving the real worker ----------------------------------------------------------
//
// ⚠️ THE RESOLVER'S ANSWER IS PINNED, AND NOTHING ELSE IS. `resolveTenant()` is static in
// Phase A — it reads one id out of instance.json and memoises it for the isolate's life —
// so an isolate cannot produce two workspaces on its own, and a suite that let the memo
// run would be two requests for whoever warmed it. Setting the memo immediately before
// `worker.fetch(...)` is what a Host-reading resolver will do for itself, and it is
// SYNCHRONOUS on purpose: `fetch()` calls `resolveTenant()` before its first await and the
// memo-hit branch returns without yielding, so the id is captured before any other request
// in flight can touch the slot. That is what makes the concurrent phase below honest
// rather than a race between fixtures.
//
// EVERY OTHER PER-ISOLATE MEMO IS LEFT EXACTLY AS THE PREVIOUS REQUEST LEFT IT. A memo a
// helper resets is a memo no case in this file can observe — the roster leak was pinned as
// a "known gap" for as long as a helper in the neighbouring file reset its clock on every
// call. There are no blanket resets here; `coldIsolate()` is called from a phase's own
// body, where the reset is visible beside the assertion it stands behind.
function fire(ws, path, init) {
  W.__setTenantTestState({ memo: { at: Date.now(), tenantId: ws.id } });
  return worker.fetch(new Request("https://x.test" + path, init), ws.env, { waitUntil() {} });
}

// Every per-isolate cache the request path can reach, back to cold.
function coldIsolate() {
  W.__setConfigTestState({
    cfgAt: 0, cfgGoodAt: 0, mcpHostAllowlist: null,
    manifests: null, storage: null, canvasRegistry: null, pitiRemarks: null, roster: null,
  });
}

// An admin session for this workspace. PBKDF2 is the expensive thing in this file, so it
// runs twice in total — once per workspace — and never per request.
async function adminCookie(ws) {
  const user = { email: ADMIN_EMAIL(ws.id), name: `One of ${ws.id}`, role: "admin" };
  ws.store.set("users:secrets", JSON.stringify({ [user.email]: await W.hashPassword(PASSWORD) }));
  const secret = await W.effectiveSecret(ws.env, user);
  assert.ok(secret, `${ws.id}'s fixture gave its admin no resolvable secret`);
  return { headers: { Cookie: `__Host-augur_user=${user.email}.${await W.userToken(ws.env, user, secret)}` } };
}

// Reading helpers for the table below — each returns a plain JSON-comparable observation.
const asJson = async (res) => res.json();
const asText = async (res) => res.text();
const status = (res) => res.status;
// A page is summarized by the lines that name a workspace, never by its whole bytes: the
// sweep is about WHOSE answer this is, and the byte ratchet is a different guard.
const marks = (re) => async (res) => {
  const body = await res.text();
  return [...body.matchAll(re)].map((m) => m[1] ?? m[0]).sort();
};

// ---- THE ROUTE TABLE -------------------------------------------------------------------

// `witness(n)` — store keys this workspace's OWN store must have been asked for while the
// request was served. `cached(n)` — the subset that must NOT be asked for again on an
// immediate repeat, i.e. what the cache in front of the route is for; it defaults to the
// witness, and a route that deliberately caches nothing says `cached: () => []`.
const route = (id, spec) => ({
  id, auth: null, witness: () => [], neighbour: undefined,
  ...spec,
  cached: spec.cached || spec.witness || (() => []),
});

const ROUTES = [
  // ---- ungated: reachable with no cookie at all, at an early exit ahead of the gate ----

  route("people", {
    path: (n) => `/__people?names=${encodeURIComponent(`Two of ${n}`)}`,
    read: async (res) => (await asJson(res)).people.map((p) => `${p.name}/${p.avatar}`),
    own: (n) => [`Two of ${n}//__avatar/u/${n}face`],
    witness: () => [ROSTER_KEY, W.USER_AVATARS_KEY],
    neighbour: () => [],
  }),

  route("avatar", {
    path: (n) => `/__avatar/u/${n}face`,
    read: async (res) => `${res.status} ${res.headers.get("Content-Type") || ""} ${(await res.arrayBuffer()).byteLength}`,
    own: (n) => `200 image/png 40`,
    shared: "the two faces are the same number of PNG bytes — the leak this route can have is the NEIGHBOUR probe below, which is where it is asserted",
    witness: (n) => [W.USER_AVATARS_KEY, W.AVATAR_BLOB_PREFIX + `${n}face`],
    cached: () => [W.USER_AVATARS_KEY],
    // The sharp one: the neighbour's hash, whose BLOB is present in this store too. Only
    // this workspace's own photo index deciding it may not be served can produce a 404.
    neighbour: () => "404 text/plain;charset=UTF-8 9",
  }),

  route("piti", {
    path: () => `/__piti?path=/p/&since=0`,
    read: async (res) => (await asJson(res)).remarks.map((r) => r.text),
    own: (n) => [`${n}'s queued remark`],
    witness: () => [REMARKS_KEY],
  }),

  route("board-page", {
    path: (n) => board(n),
    read: marks(/<title>([^<]*)<\/title>/g),
    own: (n) => [`Board of ${n}`],
    witness: () => [W.CANVASES_KEY],
    // A stranger asking for the neighbour's board URL gets this workspace's login page,
    // whose <title> is its OWN workspace name — never the neighbour's board.
    neighbour: (n) => [`Workspace ${n} · Augur`],
  }),

  route("version", {
    path: (n) => `/__version?path=${proto(n)}`,
    read: asText,
    own: (n) => `v-${n}`,
    witness: (n) => [`spaces/${n}/manifest.json`],
    // An unknown path falls back to this workspace's own BUILD_ID, which is a hash of its
    // own manifest signatures. Asserted as "not the neighbour's version" rather than by
    // value, since the hash is not worth restating.
    neighbour: undefined,
  }),

  route("og-card", {
    path: (n) => proto(n) + "og.jpg",
    read: async (res) => `${res.status} ${res.headers.get("Content-Type") || ""} ${await res.text()}`,
    own: (n) => `200 image/jpeg JPEG-BYTES-OF-${n}`,
    witness: (n) => [`blobs/h-${n}-og`],
    cached: (n) => [`spaces/${n}/manifest.json`],
    // A card the neighbour published is simply not in this workspace's file table, so the
    // honest answer is this workspace's own branded 404 — summarized by its <title>.
    neighbour: () => ["Not found · Augur"],
    neighbourRead: marks(/<title>([^<]*)<\/title>/g),
  }),

  route("login-unfurl", {
    // The gate is a gated instance's only public HTML, so its <head> IS the instance's
    // link preview. The workspace name in it comes from the live manifests.
    path: () => "/",
    read: marks(/<meta property="og:(?:title|description)" content="([^"]*)"/g),
    own: (n) => [`The ${n} workspace`, `Workspace ${n}`],
    witness: (n) => [`spaces/${n}/manifest.json`],
  }),

  route("prototype", {
    path: (n) => proto(n),
    read: marks(/(Prototype of \w+|_chrome\.[\d.]+\.[0-9a-f]{8}\.css)/g),
    own: (n) => [`Prototype of ${n}`, CHROME_CSS(n)].sort(),
    witness: (n) => [`blobs/h-${n}-proto`],
    cached: (n) => [`spaces/${n}/manifest.json`],
    // A prototype the neighbour published is not in THIS workspace's public prefixes, so
    // a stranger gets this workspace's own login page — never the neighbour's page, and
    // never a 404 that would confirm the path exists next door.
    neighbour: (n) => [`Workspace ${n} · Augur`],
    neighbourRead: marks(/<title>([^<]*)<\/title>/g),
  }),

  route("build-stamp", {
    path: () => "/_build.json",
    read: async (res) => {
      const b = await asJson(res);
      const first = Object.keys(b.spaces).sort()[0];
      return { spaces: Object.keys(b.spaces).sort(), sha: (b.spaces[first] || {}).sha, engineSha: b.engine.sha };
    },
    own: (n) => ({ spaces: [n], sha: `sha-${n}`, engineSha: `engine-sha-${n}` }),
    witness: (n) => [`spaces/${n}/manifest.json`],
  }),

  route("space-icon", {
    path: (n) => `/__space-icon/${n}icon`,
    read: async (res) => `${res.status} ${res.headers.get("Content-Type") || ""} ${(await res.arrayBuffer()).byteLength}`,
    own: () => `200 image/png 40`,
    shared: "both icons are the same number of PNG bytes — the NEIGHBOUR probe is where this route's leak would show",
    witness: (n) => [W.SPACE_ICONS_KEY, W.SPACE_ICON_BLOB_PREFIX + `${n}icon`],
    cached: () => [W.SPACE_ICONS_KEY],
    neighbour: () => "404 text/plain;charset=UTF-8 9",
  }),

  route("review-threads", {
    path: (n) => `/__review/api?path=${proto(n)}`,
    read: async (res) => (await asJson(res)).threads.flatMap((t) => t.msgs.map((m) => m.text)),
    own: (n) => [`${n} comment`],
    witness: (n) => ["c:" + proto(n)],
    cached: () => [],
    neighbour: () => [],
  }),

  route("board-doc", {
    path: (n) => `/__board?path=${board(n)}`,
    read: async (res) => ((await asJson(res)).doc || {}).name || null,
    own: (n) => `Board doc of ${n}`,
    witness: (n) => [W.BOARD_PREFIX + board(n)],
    cached: () => [],
    neighbour: () => null,
  }),

  route("catalog-anon", {
    path: () => "/__canvas/catalog.json",
    read: asJson,
    own: () => [],
    shared: "the insert picker is served EMPTY to a signed-out visitor in every workspace — the full list is a directory of every URL on the site",
  }),

  route("config-sealed", {
    path: () => "/__config/instance.json",
    read: async (res) => `${res.status} ${/tenantId|users/.test(await res.text())}`,
    own: () => "404 false",
    shared: "the refusal predates the resolve, takes no context at all (configSealedResponse), and is therefore the same answer for every workspace by construction; what it must never do — echo a config document — is what is asserted",
  }),

  route("me-anon", {
    path: () => "/__me",
    read: async (res) => { const b = await asJson(res); return { user: b.user, accounts: b.accounts, spaces: b.spaces }; },
    own: () => ({ user: null, accounts: true, spaces: [] }),
    shared: "a signed-out visitor is told nothing about any workspace but that accounts exist — identical everywhere on purpose",
  }),

  // ---- authenticated: an admin of THIS workspace, with a session cookie ----------------

  route("me", {
    auth: "admin",
    path: () => "/__me",
    read: async (res) => {
      const b = await asJson(res);
      return { email: b.user.email, role: b.user.role, admin: b.user.admin, spaces: b.spaces.map((s) => s.name) };
    },
    own: (n) => ({ email: ADMIN_EMAIL(n), role: "admin", admin: true, spaces: [`Workspace ${n}`] }),
    witness: () => [ROSTER_KEY],
  }),

  route("admin-users", {
    auth: "admin",
    path: () => "/__admin/users",
    read: async (res) => (await asJson(res)).users.map((u) => `${u.email}/${u.role}`).sort(),
    own: (n) => [`${ADMIN_EMAIL(n)}/admin`, `${GUEST_EMAIL(n)}/editor`].sort(),
    witness: () => [ROSTER_KEY, W.USER_ROLES_KEY],
  }),

  route("spaces", {
    auth: "admin",
    path: () => "/__spaces",
    read: async (res) => (await asJson(res)).spaces.map((s) => `${s.id}/${s.name}/${s.icon || ""}`),
    own: (n) => [`${n}/Workspace ${n}//__space-icon/${n}icon`],
    witness: (n) => [`spaces/${n}/manifest.json`],
  }),

  route("status-map", {
    auth: "admin",
    path: (n) => `/__status?path=${proto(n)}`,
    read: async (res) => (await asJson(res)).map,
    own: (n) => ({ [proto(n)]: `status-of-${n}` }),
    witness: () => [STATUS_KEY],
    // ⚠️ statusApi's GET path is where the adversary's decisive lint bypass was injected
    // (memoisation hung off the function object, which needs no declaration and no
    // allowlist edit). It reads KV on every call today, so it caches nothing — and if a
    // memo ever appears there, this route is what makes it observable from two workspaces.
    cached: () => [],
  }),

  route("names-map", {
    auth: "admin",
    path: (n) => `/__name?path=${proto(n)}`,
    read: async (res) => (await asJson(res)).map,
    own: (n) => ({ [proto(n)]: `Name in ${n}` }),
    witness: () => [NAMES_KEY],
    cached: () => [],
  }),

  route("pins", {
    auth: "admin",
    path: () => "/__pins",
    read: async (res) => Object.values((await asJson(res)).map).map((p) => p.label),
    own: (n) => [`Pin of ${n}`],
    witness: (n) => [`pins:${ADMIN_EMAIL(n)}`],
    cached: () => [],
  }),

  route("canvases", {
    auth: "admin",
    path: () => "/__canvases",
    read: async (res) => Object.entries((await asJson(res)).map).map(([k, v]) => `${k}=${v.name}`),
    own: (n) => [`${board(n)}=Board of ${n}`],
    witness: () => [W.CANVASES_KEY],
    // The registry cache sits in front of the BOARD PAGE (the asset-404 path), not in
    // front of this list — the admin list is read straight from KV on every call.
    cached: () => [],
  }),

  route("catalog-auth", {
    auth: "admin",
    path: () => "/__canvas/catalog.json",
    read: async (res) => (await asJson(res)).map((c) => c.id),
    own: (n) => [`${n}-card`],
    witness: (n) => [`spaces/${n}/manifest.json`],
  }),

  route("tracks", {
    auth: "admin",
    path: () => "/__canvas/tracks.json",
    read: async (res) => (await asJson(res)).map((t) => t.id),
    own: (n) => [`${n}-track`],
    witness: (n) => [`spaces/${n}/manifest.json`],
  }),

  route("storage-gauge", {
    auth: "admin",
    path: () => "/__admin/storage",
    read: async (res) => { const b = await asJson(res); return { enabled: b.enabled, bytes: b.bytes, objects: b.objects }; },
    own: (n) => WS[n].gauge,
    witness: () => ["LIST "],
  }),

  route("publish-tokens", {
    auth: "admin",
    path: () => "/__admin/tokens",
    read: async (res) => Object.entries((await asJson(res)).tokens).map(([h, t]) => `${h}=${t.space}/${t.label}`),
    own: (n) => [`hash-${n}=${n}/token-of-${n}`],
    witness: () => ["publish:tokens"],
    cached: () => [],
  }),

  route("engine-version", {
    auth: "admin",
    path: () => "/__admin/version",
    read: async (res) => { const b = await asJson(res); return { current: b.current, latest: b.latest, url: b.url }; },
    own: (n) => ({ current: `0.14.0-${n}`, latest: `9.9.9-${n}`, url: `https://rel.${n}.invalid` }),
    witness: () => ["engine:update-check"],
    cached: () => [],
  }),

  route("kv-backup", {
    auth: "admin",
    path: () => "/__admin/backup",
    read: async (res) => {
      const doc = JSON.parse(await res.text());
      return Object.keys(doc.data).filter((k) => k === ROSTER_KEY || k === STATUS_KEY)
        .map((k) => `${k}=${doc.data[k]}`).sort();
    },
    own: (n) => [
      `${ROSTER_KEY}=${JSON.stringify({ add: { [GUEST_EMAIL(n)]: { email: GUEST_EMAIL(n), name: `Two of ${n}` } }, remove: [] })}`,
      `${STATUS_KEY}=${JSON.stringify({ [proto(n)]: `status-of-${n}` })}`,
    ].sort(),
    witness: () => ["KVLIST"],
    cached: () => [],
  }),

  route("admin-page", {
    auth: "admin",
    path: () => "/admin/",
    read: marks(/(Admin panel of \w+|_chrome\.[\d.]+\.[0-9a-f]{8}\.js)/g),
    own: (n) => [`Admin panel of ${n}`, CHROME_JS(n)].sort(),
    witness: (n) => [`blobs/h-${n}-admin`],
    cached: (n) => [`spaces/${n}/manifest.json`],
  }),
];

// ---- the sweep -------------------------------------------------------------------------

// One request for one workspace, returning what the route says to observe. `reads` is
// everything this workspace's own store was asked for while it was served.
async function ask(ws, r, { auth, path, read }) {
  const before = ws.reads.length;
  const res = await fire(ws, path, auth);
  const status = res.status;
  const seen = await (read || r.read)(res);
  return { seen, status, reads: ws.reads.slice(before) };
}

const WS = {};
const AUTH = {};
let ready = false;
async function setup() {
  if (ready) return;
  for (const n of NAMES) {
    WS[n] = workspace(n);
    AUTH[n] = await adminCookie(WS[n]);
  }
  ready = true;
}
// The init a route's `auth` asks for. Ungated routes get NO cookie, which is the whole
// point of the ungated half: the leak they had was to a stranger.
const initFor = (r, n) => (r.auth ? AUTH[n] : undefined);

test("the table is well formed — every route names what it observes", async () => {
  await setup();
  const ids = new Set();
  for (const r of ROUTES) {
    assert.ok(!ids.has(r.id), `two routes are called ${r.id}`);
    ids.add(r.id);
    for (const f of ["path", "read", "own"]) {
      assert.equal(typeof r[f], "function", `${r.id} has no ${f}()`);
    }
    if (r.shared) assert.ok(r.shared.length > 30, `${r.id} is declared shared without a reason`);
  }
  assert.ok(ROUTES.filter((r) => !r.auth).length >= 12, "the ungated half of the table has thinned out");
  assert.ok(ROUTES.filter((r) => r.auth).length >= 10, "the authenticated half of the table has thinned out");
});

test("cold and alone, every route answers each workspace with its own — and the two differ", async () => {
  await setup();
  for (const r of ROUTES) {
    for (const n of NAMES) {
      coldIsolate();
      const { seen } = await ask(WS[n], r, { auth: initFor(r, n), path: r.path(n) });
      assert.deepStrictEqual(
        seen, r.own(n),
        `${r.id}: ${n} alone, on a cold isolate, does not answer what its own documents describe`,
      );
    }
    // NON-VACUITY. Two workspaces that answer a route identically make its isolation
    // assertion prove nothing — including against the leak that hands every workspace one
    // wrong answer. A route that genuinely cannot differ says so, in writing.
    const differ = !sameValue(r.own("alpha"), r.own("beta"));
    if (r.shared) {
      assert.ok(!differ, `${r.id} is declared shared but its expected answers differ — drop the \`shared\` note`);
    } else {
      assert.ok(differ, `${r.id}: both workspaces expect the same answer, so every isolation assertion about it is vacuous. Vary it in the fixture, or declare \`shared\` with a reason.`);
    }
  }
});

test("a workspace asking SECOND, inside every TTL, is answered from its OWN store", async () => {
  // The shape that actually leaks. Concurrency is the weaker one — six simultaneous loads
  // filling a slot read it back with no await in between, so each sees what it wrote
  // itself. SEQUENTIAL is one isolate answering two requests in a row: prime the
  // neighbour, then ask, inside the tick the neighbour just stamped. That is how the
  // roster overlay, the board registry and the remark queue all leaked.
  await setup();
  for (const r of ROUTES) {
    for (const plan of [["alpha", "beta"], ["beta", "alpha"]]) {
      const [first, second] = plan;
      coldIsolate();

      const primed = await ask(WS[first], r, { auth: initFor(r, first), path: r.path(first) });
      assert.deepStrictEqual(
        primed.seen, r.own(first),
        `${r.id}: ${first} is wrong before any interleaving — nothing after this means anything`,
      );

      // No reset. That is the whole case.
      const got = await ask(WS[second], r, { auth: initFor(r, second), path: r.path(second) });
      assert.deepStrictEqual(
        got.seen, r.own(second),
        `${r.id}: ${second} asked inside ${first}'s tick and was answered out of ${first}'s cache`,
      );

      // …and it read its OWN keys getting there. A correct answer taken from a
      // neighbour's warm entry is not isolation; it is a coincidence with a TTL on it.
      for (const key of r.witness(second)) {
        assert.ok(
          got.reads.includes(key),
          `${r.id}: ${second} never read its own ${key} — it was answered out of ${first}'s tick`,
        );
      }

      // And the first workspace's view was not rewritten by the second's request.
      const again = await ask(WS[first], r, { auth: initFor(r, first), path: r.path(first) });
      assert.deepStrictEqual(again.seen, r.own(first), `${r.id}: ${second}'s request rewrote ${first}'s answer`);
    }
  }
});

test("asking for the NEIGHBOUR's URL gets this workspace's answer, never the neighbour's", async () => {
  // The other half of the leak, and the one that reads as a breach rather than a bug: a
  // workspace answering a URL only its neighbour ever published. Every route that can be
  // asked this way declares what the honest answer is — an empty list, a 404, its own
  // login page — never the neighbour's content.
  await setup();
  for (const r of ROUTES) {
    if (r.neighbour === undefined) continue;
    for (const plan of [["alpha", "beta"], ["beta", "alpha"]]) {
      const [first, second] = plan;
      coldIsolate();
      // Prime the neighbour with the very document being asked for, so the leak has
      // something warm to leak.
      const primed = await ask(WS[first], r, { auth: initFor(r, first), path: r.path(first) });
      assert.deepStrictEqual(primed.seen, r.own(first), `${r.id}: ${first} is wrong before the probe`);

      const got = await ask(WS[second], r, {
        auth: initFor(r, second), path: r.path(first), read: r.neighbourRead,
      });
      assert.deepStrictEqual(
        got.seen, r.neighbour(second, first),
        `${r.id}: ${second} was served ${first}'s content at ${first}'s own URL`,
      );
    }
  }
});

test("the neighbour's URL on /__version falls back to THIS workspace's build stamp", async () => {
  // Spelled out rather than tabled: the honest answer is a hash of this workspace's own
  // manifest signatures, which is not worth restating in the table — but "not the
  // neighbour's version" is exactly the assertion the route needs.
  await setup();
  coldIsolate();
  await fire(WS.alpha, `/__version?path=${proto("alpha")}`);
  const got = await (await fire(WS.beta, `/__version?path=${proto("alpha")}`)).text();
  assert.notEqual(got, "v-alpha", "beta reported ALPHA's published version for a path beta never published");
  assert.equal(got, await (await fire(WS.beta, "/__version")).text(), "and it is not beta's own build stamp either");
});

test("every cache is still a cache — a repeat inside the TTL does not go back to the store", async () => {
  // Isolation alone is satisfied by deleting every cache, which puts the KV reads that
  // exhausted the daily get() budget (2026-08-20) straight back on the ungated routes.
  // Both properties, or neither is pinned.
  await setup();
  for (const r of ROUTES) {
    const keys = r.cached("alpha");
    if (!keys.length) continue;
    coldIsolate();
    const ws = WS.alpha;
    await ask(ws, r, { auth: initFor(r, "alpha"), path: r.path("alpha") });
    const repeat = await ask(ws, r, { auth: initFor(r, "alpha"), path: r.path("alpha") });
    for (const key of keys) {
      assert.equal(
        repeat.reads.includes(key), false,
        `${r.id}: the cache in front of ${key} stopped working — every request goes back to the store`,
      );
    }
  }
});

test("concurrently, several requests in flight, every answer is still its own workspace's", async () => {
  // Four requests in flight, both workspaces, both halves of the table, repeated. The
  // point is the awaits INSIDE the request path: a value read before one and used after it
  // can belong to another workspace by the time it is used.
  await setup();
  const ROUNDS = 30;
  for (let i = 0; i < ROUNDS; i++) {
    coldIsolate();
    // A shuffled plan of (route, workspace) pairs, four at a time.
    const plan = [];
    for (const r of ROUTES) for (const n of NAMES) plan.push([r, n]);
    for (let j = plan.length - 1; j > 0; j--) {
      const k = Math.floor(Math.random() * (j + 1));
      [plan[j], plan[k]] = [plan[k], plan[j]];
    }
    for (let s = 0; s < plan.length; s += 4) {
      const batch = plan.slice(s, s + 4);
      const got = await Promise.all(batch.map(([r, n]) =>
        ask(WS[n], r, { auth: initFor(r, n), path: r.path(n) })));
      got.forEach(({ seen, status }, idx) => {
        const [r, n] = batch[idx];
        assert.deepStrictEqual(
          seen, r.own(n),
          `round ${i}, in flight with ${batch.map(([q, m]) => `${q.id}@${m}`).join(", ")}: ${r.id} answered ${n} (HTTP ${status}) with something that is not ${n}'s`,
        );
      });
    }
  }
});

test("a burst at a COLD isolate is never answered out of a half-filled store", async () => {
  // WHAT THIS SWEEP CAUGHT ON ITS FIRST RUN, kept as its own case because the property is
  // worth naming. `loadManifests` stamps its tick BEFORE the store read, so a concurrent
  // request keeps being served the previous manifests while a refresh runs. On a COLD
  // isolate the previous manifests are nothing at all, and that placeholder was handed
  // out as if it were a view: every published page 404, /_build.json an empty site, for
  // whichever requests arrived alongside the first one. It reads exactly like an
  // unpublish — the gate answers a now-unknown path with the login page — which is the
  // failure class the unpublish guard exists for, arriving without anybody publishing.
  //
  // It is not a cross-tenant bug: all four requests below are for ONE workspace. It went
  // unseen because it needs a cold isolate AND concurrency AND bundle mode, and no
  // fetch()-driven case in the suite had all three.
  await setup();

  // The unit, deterministically. A forced load runs synchronously up to its first await —
  // which is where it stamps the tick — so calling it WITHOUT awaiting puts the isolate in
  // exactly the state a second request arrives into. The unforced read that follows must
  // not be handed the placeholder.
  coldIsolate();
  const inflight = W.loadManifests("alpha", WS.alpha.env, true);
  const racer = await W.loadManifests("alpha", WS.alpha.env);
  assert.deepStrictEqual(
    Object.keys(racer).sort(), ["_engine", "alpha"],
    "a read arriving inside a tick whose load has not returned was handed the empty placeholder view — every published page is a 404 while that lasts",
  );
  await inflight;

  // …and end to end, which is the shape it was found in.
  for (let i = 0; i < 12; i++) {
    for (const n of NAMES) {
      coldIsolate();
      const answers = await Promise.all([
        ask(WS[n], ROUTES.find((r) => r.id === "prototype"), { path: proto(n) }),
        ask(WS[n], ROUTES.find((r) => r.id === "og-card"), { path: proto(n) + "og.jpg" }),
        ask(WS[n], ROUTES.find((r) => r.id === "build-stamp"), { path: "/_build.json" }),
        ask(WS[n], ROUTES.find((r) => r.id === "version"), { path: `/__version?path=${proto(n)}` }),
      ]);
      for (const [idx, id] of ["prototype", "og-card", "build-stamp", "version"].entries()) {
        const r = ROUTES.find((q) => q.id === id);
        assert.deepStrictEqual(
          answers[idx].seen, r.own(n),
          `round ${i}: ${n} asked for ${id} in a cold burst and was answered from a store view that had not been read yet`,
        );
      }
    }
  }
});

// Deep equality as a predicate — used to compare two expected answers rather than to
// assert one.
function sameValue(a, b) {
  try { assert.deepStrictEqual(a, b); return true; } catch (e) { return false; }
}
