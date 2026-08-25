// Byte-level HTTP response snapshot harness (Phase A, commit S0).
//
// The sweep that Phase A is building toward replaces ~28 module-scope config globals
// with a threaded per-request context, read at ~110 sites. The claim at each step is
// "observable no-op". Unit tests (worker-gate/worker-board) assert FUNCTION returns;
// this harness asserts the actual BYTES of real HTTP responses, so a mechanical move
// that changes a status line, a header, or one character of a rendered page is caught.
//
// It is a BASELINE, in the same spirit as worker-gate.test.mjs: it describes what the
// worker does TODAY (warts included) so the refactor has to reproduce it byte-for-byte.
// It is TEST INFRA ONLY — it imports the worker's exported `default.fetch` and drives it
// over a FROZEN in-file fixture tree; it never touches src/ or build.js, and it does no
// git/branch introspection (§3c) — it is pure fetch() over a fixed env.
//
// The single most important case is the COLD ISOLATE (§2a): a fresh isolate whose first
// config read FAILS must FAIL CLOSED (serve the login page, not the gated content).
// `CONFIG_LOADED` is the flag that guarantees this; the dedicated test below proves the
// guard can actually fire.
//
// Regenerate the baseline after a DELIBERATE, reviewed behaviour change:
//     UPDATE_SNAPSHOTS=1 node --test test/response-snapshot.test.mjs
// (never mix a baseline update with a mechanical move — the gate test's rule, and this
// harness exists to enforce it.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ---- Cloudflare runtime shim Node lacks -------------------------------------
// The worker references HTMLRewriter (a Workers global) exactly once — withLiveReload()
// appends the live-reload <script> to <body> of every HTML asset response. Node has no
// HTMLRewriter, so install a minimal, faithful stand-in BEFORE the first fetch(). It
// supports ONLY what withLiveReload uses: .on("body", { element(el){ el.append(html,
// {html:true}) } }).transform(res) — append as the last child of <body>. Everything else
// the worker needs (Response/Request/URL/crypto.subtle/atob/TextEncoder/ReadableStream)
// is already a Node 18+ global. This shim is deterministic, so the snapshot it produces
// is self-consistent; the harness is the authority for its own baseline.
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
              text = /<\/body>/i.test(text)
                ? text.replace(/<\/body>/i, appended + "</body>")
                : text + appended;
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

import { default as worker, __testables as W } from "../src/_worker.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = join(HERE, "response-snapshot.baseline.json");
const UPDATE = !!process.env.UPDATE_SNAPSHOTS;

// ---- The env: a memKV (board test's shape) + an ASSETS stub over a FROZEN tree ----
function memKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
  };
}

// A fixed session secret so the signed-in cookie is derivable and stable. NEVER a real
// secret — a literal, checked in, exactly as a build would inject one at runtime.
const SESSION_SECRET = "s0-snapshot-fixed-session-secret";

// The session cookie's wire name, spelled out rather than imported: the corpus records
// what a real browser sends, and pinning the literal is what makes a rename show up here
// instead of sliding through. The `__Host-` prefix is browser-enforced — see USER_COOKIE
// in the worker.
const SESSION_COOKIE = "__Host-gv_user";

// The one roster user, mirrored into instance.json below. Its passHash need only be a
// truthy fixed string: with KV bound but no users:secrets key, effectiveSecret() falls
// back to u.passHash, so the cookie derivation and identify() agree on this value.
const USER = {
  email: "ada@example.test", name: "Ada Admin", initials: "AA",
  color: "#2c2150", role: "admin", passHash: "s0-seed-passhash",
};

// A 1x1 PNG — real bytes so /space-icon.png is a genuine binary asset, not text.
const PNG_1x1 = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC"),
  (c) => c.charCodeAt(0));

const INSTANCE_JSON = {
  users: [USER],
  engineVersion: "1.0.0-s0",
  updateFeed: "",
  mcpHostSuffixes: [], mcpHostAllowlistUrl: "", vanityRedirects: {},
  rtOrigin: "", sentinels: [],
};

const ROUTING_JSON = {
  buildId: "s0-build-000",
  versionMap: { "/prototypes/garden/": "v-garden" },
  publicPrefixes: ["/prototypes/garden/"],
  publicSkillPrefixes: ["/skills/delta-ui/"],
  restrictedBases: ["/sealed"],
  canvasLoaderExtras: "",
  canvasCatalog: [], canvasTracks: [],
  mcpAllowlist: [],
  spaces: [
    { id: "delta", name: "Delta", badge: "D", default: true, base: "", adminOnly: false },
    { id: "sealed", name: "Sealed", badge: "S", default: false, base: "/sealed", adminOnly: true },
  ],
  defaultSpace: "delta",
};

// A small HTML asset with a <body> (so the live-reload snippet has somewhere to land)
// and a unique marker so a fail-OPEN gate that wrongly serves it is unmistakable.
const html = (marker) =>
  `<!doctype html><html><head><title>Augur</title></head><body><main>${marker}</main></body></html>`;

// path -> { ct, body }. The whole serving surface the corpus touches. Frozen: a change
// here is a change to the baseline, on purpose.
const TREE = {
  "/__config/instance.json": { ct: "application/json; charset=utf-8", body: JSON.stringify(INSTANCE_JSON) },
  "/__config/routing.json": { ct: "application/json; charset=utf-8", body: JSON.stringify(ROUTING_JSON) },
  "/": { ct: "text/html; charset=utf-8", body: html("INDEX-FIXTURE") },
  "/prototypes/garden/index.html": { ct: "text/html; charset=utf-8", body: html("GARDEN-PROTOTYPE") },
  "/pages/buttons/": { ct: "text/html; charset=utf-8", body: html("PAGES-DOOR") },
  "/_build.json": { ct: "application/json; charset=utf-8", body: JSON.stringify({ builtAt: "2026-01-01T00:00:00.000Z", engine: { sha: "s0eng" }, spaces: { delta: { sha: "s0del" } } }) },
  "/space-icon.png": { ct: "image/png", body: PNG_1x1 },
  "/__review/comments.js": { ct: "application/javascript; charset=utf-8", body: "/* s0 review overlay stub */\n" },
};

function assetsStub(tree, { failConfig = false } = {}) {
  return {
    // loadConfig()'s grab() calls ASSETS.fetch with a STRING url ("https://config/
    // __config/<name>"); assetFetch() calls it with a Request. Accept both, exactly as
    // the real Pages ASSETS binding does.
    async fetch(req) {
      const p = new URL(typeof req === "string" ? req : req.url).pathname;
      if (failConfig && p.startsWith("/__config/")) throw new Error("cold-isolate: config read forced to fail");
      const f = tree[p];
      if (!f) return new Response("Not Found", { status: 404 });
      return new Response(f.body, { status: 200, headers: { "Content-Type": f.ct } });
    },
  };
}

const baseEnv = (opts = {}) => ({
  COMMENTS: memKV(),
  ASSETS: assetsStub(TREE, opts),
  SESSION_SECRET,
});

// ---- Recording: status + normalised headers + a body-bytes hash --------------
async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Normalise away only genuinely volatile things — the same spirit as stripVolatileHead
// in publish. Headers: drop Date (Node doesn't set it, but a live edge would). Body: for
// HTML, strip the marker-wrapped live-reload snippet, whose token is versionFor() — the
// one deliberately-volatile field embedded in every served HTML page.
const RELOAD_SNIPPET = /<!--gv-reload-start-->[\s\S]*?<!--gv-reload-end-->/g;

function normHeaders(headers) {
  const out = {};
  for (const [k, v] of headers.entries()) {
    const key = k.toLowerCase();
    if (key === "date") continue;
    out[key] = v;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

async function normBodyHash(res, contentType) {
  const buf = new Uint8Array(await res.arrayBuffer());
  if ((contentType || "").includes("text/html")) {
    const text = new TextDecoder().decode(buf).replace(RELOAD_SNIPPET, "<!--gv-reload-->");
    return sha256Hex(new TextEncoder().encode(text));
  }
  return sha256Hex(buf);
}

async function record(fetchImpl, env, ctx, { method = "GET", path, cookie } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  const req = new Request("https://example.test" + path, { method, headers });
  const res = await fetchImpl(req, env, ctx);
  const ct = res.headers.get("Content-Type");
  return {
    status: res.status,
    headers: normHeaders(res.headers),
    bodyHash: await normBodyHash(res, ct),
  };
}

// Build the valid signed-in cookie the worker expects: "<email>.<token>" where token =
// userToken(env, u, effectiveSecret). Derived exactly as identify() will re-derive it,
// so the two cannot disagree. (This uses an exported helper, not a hand-rolled HMAC, so
// it stays correct if the derivation ever changes.)
async function signedInCookie(env) {
  const secret = USER.passHash; // effectiveSecret() with no users:secrets key
  const token = await W.userToken(env, USER, secret);
  return `${SESSION_COOKIE}=${USER.email}.${token}`;
}

// The fixed request corpus. Each entry names WHY it is here.
async function collectWarm() {
  const env = baseEnv();
  const ctx = { waitUntil() {} };
  const cookie = await signedInCookie(env);
  const snap = {};
  const cases = [
    ["index-signed-out", { path: "/" }],                                   // gated index → login HTML
    ["index-signed-in", { path: "/", cookie }],                            // valid cookie → served asset
    ["public-prototype", { path: "/prototypes/garden/index.html" }],       // public door → asset + noindex
    ["gated-internal", { path: "/research.md" }],                          // not public, signed out → login
    ["restricted-space-signed-out", { path: "/sealed/" }],                 // adminOnly base → login
    ["pages-door", { path: "/pages/buttons/" }],                           // /pages subtree public door
    ["build-json", { path: "/_build.json" }],                              // public build stamp
    ["robots", { path: "/robots.txt" }],                                   // fixed open robots
    ["login-page", { path: "/admin" }],                                    // signed-out admin → login w/ redirect
    ["space-icon", { path: "/space-icon.png" }],                           // public brand mark (binary)
    ["review-overlay-asset", { path: "/__review/comments.js" }],           // /__review/* public overlay asset
    ["version-probe", { path: "/__version?path=/prototypes/garden/" }],    // deterministic versionFor token
    ["me-signed-out", { path: "/__me" }],                                  // profile chip JSON, signed out
  ];
  for (const [name, opts] of cases) snap[name] = await record(worker.fetch, env, ctx, opts);
  return snap;
}

// The cold isolate: a FRESH module evaluation (import with a query so Node re-evaluates
// it → cfgAt=0, CONFIG_LOADED=false, USERS=[]) whose very first config read FAILS. The
// gate must FAIL CLOSED. A separate module instance so it can never taint the warm run.
async function coldRecord() {
  const Cold = await import("../src/_worker.js?cold-isolate");
  const env = { COMMENTS: memKV(), ASSETS: assetsStub(TREE, { failConfig: true }), SESSION_SECRET };
  const ctx = { waitUntil() {} };
  const res = await Cold.default.fetch(new Request("https://example.test/"), env, ctx);
  const ct = res.headers.get("Content-Type");
  const body = await res.text();
  return {
    res: { status: res.status, ct, body },
    snap: {
      status: res.status,
      headers: normHeaders(res.headers),
      bodyHash: await sha256Hex(new TextEncoder().encode(body.replace(RELOAD_SNIPPET, "<!--gv-reload-->"))),
    },
  };
}

// ---- The guard that must be able to fire (§2a) ------------------------------
test("cold isolate whose first config read fails FAILS CLOSED (CONFIG_LOADED)", async () => {
  const { res } = await coldRecord();
  // Fail-closed = the login page, NOT the gated index asset. If the gate defaulted to
  // "loaded/empty" instead of "not yet loaded", authed would flip true on this cold
  // isolate and the index fixture would be served open — exactly the regression §2a
  // names as the single most dangerous one. These two assertions ARE that guard: make
  // the gate fail open (authed = true) and this test fails.
  assert.equal(res.status, 200, "the login page is served with 200 (password-manager friendly)");
  assert.match(res.body, /action="\/__auth"/, "the login form is what a locked gate returns");
  assert.doesNotMatch(res.body, /INDEX-FIXTURE/,
    "the gated index must NOT be served on a cold isolate whose config failed to load");
});

// ---- The baseline gate -------------------------------------------------------
test("response snapshot matches the checked-in baseline", async () => {
  const snapshot = await collectWarm();
  const cold = await coldRecord();
  snapshot["cold-isolate-fail-closed"] = cold.snap;

  if (UPDATE) {
    writeFileSync(BASELINE, JSON.stringify(snapshot, null, 2) + "\n");
    console.log("UPDATE_SNAPSHOTS=1 — wrote baseline with", Object.keys(snapshot).length, "entries");
    return;
  }

  assert.ok(existsSync(BASELINE),
    "no baseline — generate it with UPDATE_SNAPSHOTS=1 node --test test/response-snapshot.test.mjs");
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));

  // Compare per entry so a diff points at the exact request that moved.
  for (const name of Object.keys(baseline)) {
    assert.deepEqual(snapshot[name], baseline[name], `response for "${name}" changed vs baseline`);
  }
  assert.deepEqual(
    Object.keys(snapshot).sort(), Object.keys(baseline).sort(),
    "the request corpus changed — a new/removed request must be a deliberate baseline update");
});
