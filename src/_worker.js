// Source for dist/_worker.js — copied VERBATIM by build.js into the deploy dir.
// Cloudflare Pages Advanced Mode: this Worker runs in front of every request.
//
// RUNTIME CONFIG: everything deployment- or build-specific (USERS, PUBLIC_PREFIXES,
// RESTRICTED_BASES, VERSION_MAP, BUILD_ID, deploy knobs) is DATA, not code. It loads
// from /__config/{instance,routing}.json — emitted by build.js next to the assets —
// at request time via loadConfig(), cached per isolate for ~1.5s. The bindings below
// start at their empty defaults, which is exactly the raw-copy behavior: no config
// emitted → no users → open gate, nothing public, nothing restricted.
// /__config/* is rejected for external requests in fetch() before any asset serving.
//
// Gate model: PER-USER accounts (email + password). instance.json carries the users;
// a login sets a cookie carrying "<email>.<token>" where token is derived from the
// user's effective password (admin-set KV override ?? seed) — see identify(). The
// internal surface (root index, per-opportunity indexes, galleries) is gated; direct
// prototype URLs, their DS assets, /pages, /_build.json, and created canvas boards
// are public — see PUBLIC_PREFIXES / isPublicPath / virtualCanvas. Admin-only spaces'
// base paths (RESTRICTED_BASES) are sealed to admins. Legacy fallback: with no users
// configured but SITE_PASSWORD set, a single shared-password gate applies; with
// neither, the site is open (raw/local builds).
//
// Casual gate against link leakage — NOT Zero Trust.

const COOKIE = "gv_auth";
const MAX_AGE = 60 * 60 * 24 * 7; // 7 days

// ---- Users / identity -------------------------------------------------------
// Augur is a private internal tool — the only real risk is impersonation, and the
// real work happens through git commits, so this is a casual identity layer, not
// auth hardening. USERS is the seed identity + DEFAULT password, filled at runtime
// from instance.json (loadConfig). Empty in a raw copy → no users → the gate stays
// open (offline/local builds with no identity configured). Effective password =
// admin-set KV override (USER_SECRETS_KEY) ?? this default — so passwords are editable
// at runtime from the admin panel without redeploying. Each entry:
//   { email, name, pass, initials, color, role? }   role:"admin" → can edit passwords.
let USERS = [];
// Deploy-specific knobs, filled at runtime from instance.json (all empty in a raw
// engine build): gate-exempt skill-asset path prefixes, MCP-proxy host allowlist
// (suffix rule + space-declared exact hosts + the URL of an exact-host list),
// vanity-host redirects, and the optional AI project-builder prompts + schema.
// MCP_HOST_ALLOWLIST alone comes from routing.json: the union of the {"hosts":[…]}
// files the spaces declare via space.json "mcpAllowlists" (see build.js).
let PUBLIC_SKILL_PREFIXES = [];
let MCP_HOST_SUFFIXES = [];
let MCP_HOST_ALLOWLIST = [];
let MCP_HOST_ALLOWLIST_URL = "";
let VANITY_REDIRECTS = {};
let BUILDER_CONFIG = null;
const USER_COOKIE = "gv_user";              // value: "<email>.<token>"
const USER_SECRETS_KEY = "users:secrets";   // KV {email: password} — admin overrides
const LASTSEEN_PREFIX = "users:lastseen:";  // KV per-user ISO stamp — admin list column

// Build id for the live-reload poller — routing.json carries this build's id; it's
// the FALLBACK version for any path not in VERSION_MAP (index/shell pages, assets).
// "dev" in a raw/local copy just means a stable id.
let BUILD_ID = "dev";

// Per-page live-reload versions: URL-prefix → token that changes only when that
// folder's content changes (routing.json). Lets a tab reload only when ITS
// own prototype changed, so unrelated deploys (e.g. another agent's prototype) don't
// reload it. versionFor() returns the longest-prefix match, else BUILD_ID.
let VERSION_MAP = {};

function versionFor(pathname) {
  let best = null, bestLen = -1;
  for (const k in VERSION_MAP) {
    if ((pathname === k || pathname === k.slice(0, -1) || pathname.startsWith(k)) && k.length > bestLen) {
      best = VERSION_MAP[k];
      bestLen = k.length;
    }
  }
  return best == null ? BUILD_ID : best;
}

// PUBLIC prototype path-prefixes — served WITHOUT the password. routing.json carries
// the real list of `/<opportunity>/<prototype>/` prefixes, derived from the same
// build that shipped them, so it can never drift from what actually ships. Empty
// default so a raw/local copy of this file gates nothing differently (local builds
// have no password anyway).
let PUBLIC_PREFIXES = [];

// A request is public if it lands inside a published prototype folder (the index
// page or any asset it loads), or is the dormant review-overlay script that every
// prototype embeds. Everything else falls through to the password gate.
function isPublicPath(pathname) {
  // The build stamp ({builtAt, spaces:{<id>:{sha}}}). Space-repo collaborators can't
  // see this repo's CI, so this is their only way to verify "my commit is live" —
  // curl it and compare sha to git rev-parse HEAD. Public by design; contains nothing
  // but commit SHAs that those collaborators already have.
  if (pathname === "/_build.json") return true;
  // The dormant review overlay + its avatar asset — both embedded into public
  // prototypes, so both must bypass the gate (else the <img> gets the login page).
  if (pathname === "/__review/comments.js" || pathname === "/__review/aslam.png") return true;
  // The composition graph the overlay recurses (window.__GV_GRAPH) — embedded into
  // every public prototype before comments.js, so it must bypass the gate too.
  if (pathname === "/__review/graph.js") return true;
  // The shared infinite-canvas engine (canvas.js/.css) is embedded by absolute /__canvas/
  // path into canvas prototypes, so its assets must bypass the gate too (else the
  // <script>/<link> fetches the login page instead of the asset). RENDERED ASSET extensions
  // only — never a blanket prefix; the board DATA API (/__board) has its own public route below.
  if (pathname.startsWith("/__canvas/") &&
      /\.(css|js|mjs|json|map|svg|png|webp|woff2?)$/i.test(pathname)) return true;
  // Canvas session music: a space's tracks/ folder, at the root for the default space and
  // under /<space>/ for the rest. A public board plays the same track as a gated one, so the
  // audio has to clear the gate too. AUDIO EXTENSIONS ONLY — a README or a stray export that
  // lands in the same folder stays gated. Admin-only spaces are unaffected: isRestrictedPath
  // is checked BEFORE this door, so their tracks stay sealed with everything else.
  if (/^(\/[a-z0-9-]+)?\/tracks\/[^?]+\.(mp3|m4a|aac|ogg|opus|wav|flac|webm)$/i.test(pathname)) return true;
  // The cursor companion engine + self-hosted fonts are embedded into public
  // prototypes by absolute path, so they must bypass the gate too (else the
  // <script>/<link> fetches the login page instead of the asset).
  if (pathname === "/piti.js" || pathname.startsWith("/fonts/")) return true;
  // Shared canonical design-system assets. Linked prototypes (the default — INV-10)
  // reference these via the space's public skill dir (injected at build from the
  // detected UI skill), so they must bypass the gate or a public prototype renders
  // unstyled for anyone without the password. Scope to RENDERED ASSET extensions only
  // — never a blanket prefix — so any doc that ships into this dir (e.g. an
  // img/.../MANIFEST.md, gallery.html) stays gated, not exposed.
  if (PUBLIC_SKILL_PREFIXES.some((p) => pathname.startsWith(p)) &&
      /\.(css|js|mjs|woff2?|ttf|otf|svg|png|jpe?g|webp|gif|ico|json|map)$/i.test(pathname)) return true;
  // Composed OG/unfurl card for any page — always fetchable so link-preview bots
  // (Slack, iMessage, Twitter) can load the image even if its folder is gated.
  if (pathname.endsWith("/og.jpg")) return true;
  // The composed reference Pages (DS gallery, shipped under /pages/<slug>/) are
  // public so they can be shared without the password. They're self-contained and
  // load their assets from already-public paths (the public skill dir, /fonts/), so
  // the whole subtree — index pages and any page-local assets — bypasses the gate.
  if (pathname === "/pages" || pathname.startsWith("/pages/")) return true;
  // NOTE: the /skills and /pages doors above are DEFAULT-SPACE-ONLY (root paths). A
  // future non-default, non-adminOnly space needs base-aware equivalents
  // (/<id>/skills/…, /<id>/pages/…) or its public prototypes render unstyled to
  // signed-out visitors. Revisit when the first public second space mounts.
  return PUBLIC_PREFIXES.some(
    (p) => pathname === p || pathname === p.slice(0, -1) || pathname.startsWith(p)
  );
}

// ADMIN-ONLY space base paths. routing.json carries the base path of every space
// whose space.json sets "adminOnly": true, so it can never drift from what shipped.
// Everything under one of these prefixes requires an admin user — regular users are
// bounced home, signed-out visitors get the login page. Empty default → no space
// is restricted (a local build with no identity gates nothing extra).
let RESTRICTED_BASES = [];

// Does this path live inside an admin-only space? Matches the base ("/space-2"),
// its root ("/space-2/") and everything beneath it.
function isRestrictedPath(pathname) {
  return RESTRICTED_BASES.some(
    (b) => pathname === b || pathname.startsWith(b + "/")
  );
}

// ---- Runtime config loader --------------------------------------------------
// Fills every binding above from /__config/{instance,routing}.json — the two
// documents build.js emits next to the assets. Cached per isolate for ~1.5s: fast
// enough that a fresh deploy (or an offline rebuild) flips the gate's view of the
// world almost immediately, cheap enough to run on the hot path (between refreshes
// the call is a sync timestamp check). A missing or unreadable document leaves the
// current values in place — so a raw copy (no config emitted) keeps its empty
// defaults, and a transient read failure never wipes a working gate.
let SPACES = [];
let INSTANCE_SENTINELS = [];
// Engine version of the build that produced the live config/chrome (from
// package.json via build.js) + the release feed the update nudge polls.
let INSTANCE_ENGINE_VERSION = "";
let UPDATE_FEED = "";
const DEFAULT_UPDATE_FEED = "https://api.github.com/repos/andratwiro/augur/releases/latest";
let cfgAt = 0;
function applyInstance(inst) {
  USERS = Array.isArray(inst.users) ? inst.users : [];
  INSTANCE_ENGINE_VERSION = inst.engineVersion || "";
  UPDATE_FEED = inst.updateFeed || "";
  MCP_HOST_SUFFIXES = inst.mcpHostSuffixes || [];
  MCP_HOST_ALLOWLIST_URL = inst.mcpHostAllowlistUrl || "";
  VANITY_REDIRECTS = inst.vanityRedirects || {};
  BUILDER_CONFIG = inst.builder || null;
  RT_ORIGIN = inst.rtOrigin || "";
  INSTANCE_SENTINELS = Array.isArray(inst.sentinels) ? inst.sentinels : [];
}
async function loadConfig(env) {
  if (!env || Date.now() - cfgAt < 1500) return;
  cfgAt = Date.now(); // stamp first — a failed load retries next tick, never stampedes
  // Bundle mode: instance config lives in the store (pushed via /__publish/
  // _instance/config) and routing derives from the live manifests.
  if (bundleMode(env)) {
    try {
      const [instObj, manifests] = await Promise.all([
        env.BUNDLES.get("config/instance.json"),
        loadManifests(env, true),
      ]);
      if (instObj) applyInstance(JSON.parse(await instObj.text()));
      applyDerivedRouting(manifests);
    } catch (e) {}
    return;
  }
  if (!env.ASSETS) return;
  const grab = async (name) => {
    try {
      const r = await env.ASSETS.fetch("https://config/__config/" + name);
      return r.ok ? await r.json() : null;
    } catch (e) { return null; }
  };
  const [inst, routing] = await Promise.all([grab("instance.json"), grab("routing.json")]);
  if (inst) applyInstance(inst);
  if (routing) {
    BUILD_ID = routing.buildId || "dev";
    VERSION_MAP = routing.versionMap || {};
    PUBLIC_PREFIXES = routing.publicPrefixes || [];
    PUBLIC_SKILL_PREFIXES = routing.publicSkillPrefixes || [];
    RESTRICTED_BASES = routing.restrictedBases || [];
    CANVAS_LOADER_EXTRAS = routing.canvasLoaderExtras || "";
    MCP_HOST_ALLOWLIST = routing.mcpAllowlist || [];
    mcpStaticHosts = new Set(MCP_HOST_ALLOWLIST);
    SPACES = Array.isArray(routing.spaces) ? routing.spaces : [];
  }
}

async function tokenFor(secret) {
  const data = new TextEncoder().encode("gv:" + secret);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---- Identity helpers -------------------------------------------------------
function userByEmail(email) {
  const e = String(email == null ? "" : email).trim().toLowerCase();
  return USERS.find((u) => u.email.toLowerCase() === e) || null;
}

// Safe-to-expose view of a user — never includes the password.
function publicUser(u) {
  return u ? {
    email: u.email, name: u.name,
    initials: u.initials || "", color: u.color || "#4f46e5",
    avatar: avatarUrl(u), admin: u.role === "admin",
  } : null;
}

// A data-URI avatar in the user list is SERVED at a stable /__avatar/ URL rather than
// inlined everywhere: the canvas multiplayer join carries the URL to peers, and inline
// data: images in overlay UI are a known trap. The key hashes email + content length, so
// a changed photo changes the URL and immutable caching stays safe.
function avatarKey(u) {
  const s = u.email + ":" + u.avatar.length;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
function avatarUrl(u) {
  if (!u || !u.avatar) return null;
  return u.avatar.startsWith("data:") ? "/__avatar/" + avatarKey(u) : u.avatar;
}

// Effective password = admin-set KV override ?? the seeded default. One kv.get.
async function effectivePass(env, u) {
  if (!u) return "";
  try {
    const k = kvFor(env);
    const raw = k ? await k.get(USER_SECRETS_KEY) : null;
    const ov = raw ? JSON.parse(raw) : {};
    if (ov && typeof ov[u.email] === "string" && ov[u.email]) return ov[u.email];
  } catch (e) {}
  return u.pass || "";
}

// Cookie token binds the email to the (effective) password: SHA-256("gv:email:pass").
// Changing a password invalidates that user's existing cookies (token no longer
// matches) — a free "log everyone out on password change", which is what we want.
async function userToken(env, u) {
  return tokenFor(u.email + ":" + (await effectivePass(env, u)));
}

// Resolve the signed-in user from the gv_user cookie ("<email>.<token>"), verifying
// the token against that user's effective password. Stateless — no session store.
async function identify(request, env) {
  if (!USERS.length) return null;
  const cookies = request.headers.get("Cookie") || "";
  const c = cookies.split(/;\s*/).find((x) => x.startsWith(USER_COOKIE + "="));
  if (!c) return null;
  const val = c.slice(USER_COOKIE.length + 1);
  const dot = val.lastIndexOf(".");
  if (dot < 1) return null;
  const u = userByEmail(val.slice(0, dot));
  if (!u) return null;
  const token = val.slice(dot + 1);
  const expect = await userToken(env, u);
  return token.length === expect.length && token === expect ? u : null;
}

// Record when a signed-in user was last seen ("last connection" in the admin list).
// Fired only from /__me (one call per page view, the profile chip's fetch) and from a
// successful login — never from asset requests. Throttled: while the stored stamp is
// fresh (<15 min) a browsing burst costs one KV read and zero writes (KV allows ~1
// write/sec/key). Fire-and-forget via ctx.waitUntil; telemetry must never break a
// request, hence the blanket catch.
async function touchLastSeen(env, u) {
  try {
    const kv = kvFor(env);
    if (!kv || !u) return;
    const key = LASTSEEN_PREFIX + u.email;
    const prev = await kv.get(key);
    if (prev && Date.now() - Date.parse(prev) < 15 * 60 * 1000) return;
    await kv.put(key, new Date().toISOString());
  } catch (e) {}
}

// ---- KV access: the binding, or a REST shim to the REAL (prod) namespace --------
// "Offline-live" mode: offline.mjs serves LOCAL assets (your working-tree prototypes)
// but injects GV_KV_TOKEN/_ACCOUNT/_NS so the overlay data (comments/pins/status/
// renames/etc.) reads & writes the PRODUCTION KV — the shared live-overlay layer.
// (wrangler's remote KV bindings 500 on every op, so we go straight to the KV REST
// API.) Active ONLY when GV_KV_TOKEN is present; in prod it's unset → the normal
// env.COMMENTS binding is returned and nothing changes. The shim mirrors the subset of
// the KV API the worker uses: get / put / list.
function kvFor(env) {
  if (!env || !env.GV_KV_TOKEN) return env && env.COMMENTS;
  const base = `https://api.cloudflare.com/client/v4/accounts/${env.GV_KV_ACCOUNT}/storage/kv/namespaces/${env.GV_KV_NS}`;
  const auth = { Authorization: `Bearer ${env.GV_KV_TOKEN}` };
  return {
    async get(key, opts) {
      const r = await fetch(`${base}/values/${encodeURIComponent(key)}`, { headers: auth });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`REST KV get ${r.status}`);
      return opts && opts.type === "arrayBuffer" ? await r.arrayBuffer() : await r.text();
    },
    // binding-compatible getWithMetadata — the REST API keeps metadata on a separate
    // endpoint, so this costs two calls (offline-only; the real binding does it in one)
    async getWithMetadata(key, opts) {
      const value = await this.get(key, opts);
      if (value === null) return { value: null, metadata: null };
      let metadata = null;
      try {
        const m = await fetch(`${base}/metadata/${encodeURIComponent(key)}`, { headers: auth });
        if (m.ok) metadata = (await m.json()).result || null;
      } catch (e) {}
      return { value, metadata };
    },
    async put(key, value, opts) {
      let init;
      if (opts && opts.metadata) {
        // metadata rides a multipart form on the REST rail (a plain body PUT drops it)
        const fd = new FormData();
        fd.append("value", value instanceof ArrayBuffer ? new Blob([value]) : value);
        fd.append("metadata", JSON.stringify(opts.metadata));
        init = { method: "PUT", headers: auth, body: fd };
      } else {
        init = { method: "PUT", headers: auth, body: value };
      }
      const r = await fetch(`${base}/values/${encodeURIComponent(key)}`, init);
      if (!r.ok) throw new Error(`REST KV put ${r.status}`);
    },
    async delete(key) {
      const r = await fetch(`${base}/values/${encodeURIComponent(key)}`, { method: "DELETE", headers: auth });
      if (!r.ok && r.status !== 404) throw new Error(`REST KV delete ${r.status}`);
    },
    async list(opts) {
      const u = new URL(`${base}/keys`);
      if (opts && opts.prefix) u.searchParams.set("prefix", opts.prefix);
      if (opts && opts.cursor) u.searchParams.set("cursor", opts.cursor);
      const r = await fetch(u.toString(), { headers: auth });
      if (!r.ok) throw new Error(`REST KV list ${r.status}`);
      const d = await r.json();
      const ri = d.result_info || {};
      return { keys: (d.result || []).map((k) => ({ name: k.name })), list_complete: !ri.cursor, cursor: ri.cursor || undefined };
    },
  };
}

// ---- Bundle store: direct-publish serving + publish API ---------------------
// Optional second asset source. When GV_ASSET_SOURCE="r2" AND the BUNDLES R2
// binding exists, assets serve from content-addressed blobs (blobs/<sha256>)
// resolved through per-space manifests (spaces/<id>/manifest.json) that
// `augur publish` commits over /__publish/* — no git relay, no site rebuild,
// and a publish is atomic: immutable blobs first, then ONE manifest PUT.
// Rollback = re-commit a prior versions/<n>.json. Site routing (public prefixes,
// version map, restricted bases, space list) is DERIVED from the live manifests
// on every config refresh — never stored, so it can't go stale or partial.
// Without the flag/binding none of this runs and assets come from Pages' ASSETS
// exactly as before. Publishing (the API below) needs only the binding, so a
// store can be seeded before serving is flipped.
const bundleMode = (env) => !!(env && env.GV_ASSET_SOURCE === "r2" && env.BUNDLES);

const PUBLISH_TOKENS_KEY = "publish:tokens"; // KV {sha256("pub:"+token): {space,label,createdAt}}
const BLOB_MAX_BYTES = 25 * 1024 * 1024;
// Inline-commit caps: enough for a typical few-file edit in one round trip,
// small enough to keep a commit's R2 subrequests inside the free-plan budget.
const INLINE_MAX_BLOBS = 16;
const INLINE_MAX_BYTES = 1_000_000;
// Publish-protocol version, echoed in check responses so a CLI can detect skew
// against the deployed worker. History: 1 = check/blob/commit; 2 = + inline-blob
// commits, filesUnchanged/liveSource on check.
const PUBLISH_PROTOCOL = 2;

let MANIFESTS = { at: 0, spaces: {} };
async function loadManifests(env, force) {
  if (!force && Date.now() - MANIFESTS.at < 1500) return MANIFESTS.spaces;
  MANIFESTS.at = Date.now();
  try {
    const list = await env.BUNDLES.list({ prefix: "spaces/", delimiter: "/" });
    const ids = (list.delimitedPrefixes || []).map((p) => p.slice("spaces/".length, -1));
    const out = {};
    await Promise.all(ids.map(async (id) => {
      const obj = await env.BUNDLES.get(`spaces/${id}/manifest.json`);
      if (obj) out[id] = JSON.parse(await obj.text());
    }));
    MANIFESTS.spaces = out;
  } catch (e) {} // a transient list/get failure keeps serving the last good view
  return MANIFESTS.spaces;
}

// Site routing from the live manifests (the bundle-mode replacement for
// routing.json): merge every space's fragment, fold per-space shell signatures
// into one buildId, and read the chrome pieces off the _engine manifest.
function applyDerivedRouting(manifests) {
  const vmap = {}, prefixes = [], restricted = [], mcp = new Set(), spacesList = [];
  const sigs = [];
  let skillPrefixes = [], loaderExtras = "";
  for (const id of Object.keys(manifests).sort()) {
    const m = manifests[id];
    if (id === "_engine") { loaderExtras = (m.routing && m.routing.canvasLoaderExtras) || ""; continue; }
    const r = m.routing || {};
    prefixes.push(...(r.publicPrefixes || []));
    Object.assign(vmap, r.versionMap || {});
    for (const h of r.mcpAllowlist || []) mcp.add(h);
    if (r.publicSkillPrefixes) skillPrefixes = r.publicSkillPrefixes;
    const sp = m.space || { id };
    spacesList.push(sp);
    if (sp.adminOnly && !sp.default) restricted.push("/" + id);
    sigs.push(`${id}:${r.shellSig || m.version || 0}`);
  }
  let h = 5381;
  const s = sigs.sort().join("\n");
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  BUILD_ID = h.toString(36);
  VERSION_MAP = vmap;
  PUBLIC_PREFIXES = prefixes;
  PUBLIC_SKILL_PREFIXES = skillPrefixes;
  RESTRICTED_BASES = restricted;
  CANVAS_LOADER_EXTRAS = loaderExtras;
  MCP_HOST_ALLOWLIST = [...mcp].sort();
  mcpStaticHosts = new Set(MCP_HOST_ALLOWLIST);
  SPACES = spacesList.sort((a, b) => (b.default === true) - (a.default === true) || String(a.id).localeCompare(String(b.id)));
}

// Path → manifest entry. Manifest keys are the built files' real (decoded) paths.
function lookupBundleFile(manifests, pathname) {
  for (const id in manifests) {
    const f = manifests[id].files && manifests[id].files[pathname];
    if (f) return f;
  }
  return null;
}
function resolveBundlePath(manifests, pathname) {
  let p;
  try { p = decodeURIComponent(pathname); } catch (e) { return { miss: true }; }
  const direct = lookupBundleFile(manifests, p) ||
    (p.endsWith("/") ? lookupBundleFile(manifests, p + "index.html") : null);
  if (direct) return { f: direct };
  if (!p.endsWith("/") && lookupBundleFile(manifests, p + "/index.html")) return { redirect: p + "/" };
  return { miss: true };
}

// The env.ASSETS.fetch drop-in: identical contract (a plain 404 Response means
// "not found" — callers brand it / try virtual canvases), plus ETag/304 and
// byte ranges (audio scrubbing) in bundle mode. Edge-cache layering is a later
// optimization; R2 reads are fine at internal traffic.
async function assetFetch(env, request) {
  if (!bundleMode(env)) return env.ASSETS.fetch(request);
  const url = new URL(request.url);
  const manifests = await loadManifests(env);
  const r = resolveBundlePath(manifests, url.pathname);
  if (r.redirect) return Response.redirect(new URL(r.redirect + url.search, url).toString(), 308);
  if (r.miss) return new Response("Not Found", { status: 404 });
  const f = r.f;
  const inm = request.headers.get("If-None-Match");
  if (inm && inm.replace(/W\/|"/g, "") === f.h) {
    return new Response(null, { status: 304, headers: { ETag: `"${f.h}"` } });
  }
  const headers = { "Content-Type": f.ct, ETag: `"${f.h}"`, "Accept-Ranges": "bytes" };
  const rm = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("Range") || "");
  if (rm && (rm[1] || rm[2])) {
    let start = rm[1] ? parseInt(rm[1], 10) : Math.max(0, f.s - parseInt(rm[2], 10));
    let end = rm[1] && rm[2] ? Math.min(parseInt(rm[2], 10), f.s - 1) : f.s - 1;
    if (start > end || start >= f.s) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${f.s}` } });
    }
    const obj = await env.BUNDLES.get("blobs/" + f.h, { range: { offset: start, length: end - start + 1 } });
    if (!obj) return new Response("Not Found", { status: 404 });
    headers["Content-Range"] = `bytes ${start}-${end}/${f.s}`;
    headers["Content-Length"] = String(end - start + 1);
    return new Response(obj.body, { status: 206, headers });
  }
  const obj = await env.BUNDLES.get("blobs/" + f.h);
  if (!obj) return new Response("Not Found", { status: 404 });
  headers["Content-Length"] = String(f.s);
  return new Response(request.method === "HEAD" ? null : obj.body, { status: 200, headers });
}

// Existence probe (no body) — the canvas shadow-check's cheap path.
async function assetPathExists(env, url) {
  if (!bundleMode(env)) {
    const asset = await env.ASSETS.fetch(new Request(url.toString()));
    return asset.status !== 404;
  }
  const r = resolveBundlePath(await loadManifests(env), url.pathname);
  return !r.miss;
}

// The /_build.json contract, synthesized from the manifests in bundle mode so
// collaborators' "is my commit live?" check keeps its exact shape.
function synthBuildStamp(manifests) {
  const spaces = {}, engine = { sha: null };
  if (INSTANCE_ENGINE_VERSION) engine.version = INSTANCE_ENGINE_VERSION;
  let builtAt = null;
  for (const id in manifests) {
    const m = manifests[id];
    if (m.publishedAt && (!builtAt || m.publishedAt > builtAt)) builtAt = m.publishedAt;
    const src = m.source || {};
    if (id === "_engine") { engine.sha = src.sha || null; if (src.dirty) engine.dirty = true; continue; }
    spaces[id] = { sha: src.sha || null, ...(src.dirty ? { dirty: true } : {}) };
  }
  return { builtAt: builtAt || new Date().toISOString(), engine, spaces };
}

// ---- Publish API (/__publish/<space>/{check,blob/<h>,commit,rollback}) ------
// Bearer-token authed (per-space tokens minted in the admin panel, hashed in
// KV; "*" = every space). PUBLISH_BOOTSTRAP_TOKEN is a local-dev binding for
// wrangler dev only — never configure it on a deployed instance.
async function publishAuth(request, env, spaceId, anySpace) {
  const m = /^Bearer\s+(.+)$/.exec(request.headers.get("Authorization") || "");
  if (!m) return null;
  const token = m[1].trim();
  if (env.PUBLISH_BOOTSTRAP_TOKEN && token === env.PUBLISH_BOOTSTRAP_TOKEN) {
    return { space: "*", label: "bootstrap" };
  }
  const kv = kvFor(env);
  if (!kv) return null;
  try {
    const h = await tokenFor("pub:" + token);
    const raw = await kv.get(PUBLISH_TOKENS_KEY);
    const map = raw ? JSON.parse(raw) : {};
    const e = map[h];
    if (!e) return null;
    if (!anySpace && e.space !== "*" && e.space !== spaceId) return null;
    return e;
  } catch (err) { return null; }
}

async function publishApi(request, url, env) {
  if (!env.BUNDLES) return jsonResponse({ error: "bundle-store-not-configured" }, 501);
  const [spaceId, op, arg] = url.pathname.slice("/__publish/".length).split("/");
  if (!spaceId || !op || !/^[a-z0-9_][a-z0-9-]*$/.test(spaceId)) return jsonResponse({ error: "bad-path" }, 400);

  // Self-serve token exchange: trade an existing web login for a publish token
  // (no admin distribution step — `augur login` calls this once and saves it).
  // Admins get every space; everyone else gets the default space. Same
  // credential check as /__auth; the response carries the token exactly once.
  if (spaceId === "_login" && op === "token" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    const u = userByEmail(body && body.email);
    const pass = String((body && body.password) || "");
    const real = u ? await effectivePass(env, u) : "";
    if (!u || !real || pass.length !== real.length || pass !== real) {
      return jsonResponse({ error: "bad-credentials" }, 403);
    }
    const kv = kvFor(env);
    if (!kv) return jsonResponse({ error: "no-kv-binding" }, 500);
    const space = u.role === "admin" ? "*" : (SPACES.find((s) => s.default) || { id: null }).id;
    if (!space) return jsonResponse({ error: "no-default-space" }, 500);
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    const raw = await kv.get(PUBLISH_TOKENS_KEY);
    const map = raw ? JSON.parse(raw) : {};
    map[await tokenFor("pub:" + token)] = { space, label: u.email, createdAt: new Date().toISOString() };
    await kv.put(PUBLISH_TOKENS_KEY, JSON.stringify(map));
    return jsonResponse({ token, space });
  }

  // Sanitized contributor profiles for identity-less builds (any valid publish
  // token): name/initials/color/avatar URL + email aliases — exactly what the
  // build needs to keep editor chips on cards, and nothing secret. The avatar
  // URLs resolve at runtime against the instance's real identity, so a build
  // from a bare space clone renders the same faces the god-mode build does.
  if (spaceId === "_instance" && op === "profiles" && request.method === "GET") {
    if (!(await publishAuth(request, env, spaceId, true))) return jsonResponse({ error: "forbidden" }, 403);
    const profiles = USERS.map((u) => ({
      email: u.email, emails: u.emails || [],
      name: u.name, initials: u.initials || "", color: u.color || "#4f46e5",
      avatar: avatarUrl(u), role: u.role === "admin" ? "admin" : "user",
    }));
    return jsonResponse({ profiles });
  }

  const who = await publishAuth(request, env, spaceId);
  if (!who) return jsonResponse({ error: "forbidden" }, 403);

  // Instance config push (star-scope tokens only): the deploy shell's identity +
  // knobs become config/instance.json — the bundle-mode source loadConfig reads.
  if (spaceId === "_instance" && op === "config" && request.method === "POST") {
    if (who.space !== "*") return jsonResponse({ error: "forbidden" }, 403);
    const body = await request.text();
    try { JSON.parse(body); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    await env.BUNDLES.put("config/instance.json", body);
    cfgAt = 0;
    return jsonResponse({ ok: true });
  }

  if (op === "check" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    const files = (body && body.files) || {};
    // A blob already referenced by ANY live manifest exists in the store —
    // content addressing means cross-space and engine duplicates never re-upload.
    const have = new Set();
    const all = await loadManifests(env, true);
    for (const id in all) for (const k in all[id].files) have.add(all[id].files[k].h);
    const missing = [...new Set(Object.values(files).map((f) => f && f.h).filter(Boolean))]
      .filter((h) => !have.has(h));
    const cur = all[spaceId];
    // filesUnchanged + liveSource let the client skip a commit that would change
    // nothing (same content, same provenance) — a version bump with no meaning.
    const curFiles = (cur && cur.files) || null;
    const keys = curFiles ? Object.keys(files) : [];
    const filesUnchanged = !!curFiles && keys.length === Object.keys(curFiles).length
      && keys.every((p) => files[p] && curFiles[p] && files[p].h === curFiles[p].h);
    return jsonResponse({
      missing,
      liveVersion: (cur && cur.version) || 0,
      filesUnchanged,
      liveSource: cur && cur.source
        ? { sha: cur.source.sha || null, dirty: !!cur.source.dirty } : null,
      protocol: PUBLISH_PROTOCOL,
      engine: INSTANCE_ENGINE_VERSION || null,
    });
  }

  if (op === "blob" && request.method === "PUT") {
    if (!/^[0-9a-f]{64}$/.test(arg || "")) return jsonResponse({ error: "bad-hash" }, 400);
    const buf = await request.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > BLOB_MAX_BYTES) return jsonResponse({ error: "bad-size" }, 413);
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))]
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    if (digest !== arg) return jsonResponse({ error: "hash-mismatch" }, 400);
    await env.BUNDLES.put("blobs/" + arg, buf);
    return new Response(null, { status: 204 });
  }

  if (op === "commit" && request.method === "POST") {
    let m;
    try { m = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    if (!m || m.id !== spaceId || !m.files || typeof m.files !== "object") {
      return jsonResponse({ error: "bad-manifest" }, 400);
    }
    // Inline blobs — the one-round-trip fast path: a small commit may carry its
    // fresh blobs base64-inline instead of PUTting each first. Every inline blob
    // is sha256-verified in-request, so it is proven by construction and needs
    // no spot-check subrequest afterwards.
    const inline = m.blobs && typeof m.blobs === "object" && !Array.isArray(m.blobs) ? m.blobs : null;
    delete m.blobs; // transport-only — never persisted in the manifest
    const inlineStored = new Set();
    if (inline) {
      const entries = Object.entries(inline);
      if (entries.length > INLINE_MAX_BLOBS) return jsonResponse({ error: "too-many-inline-blobs" }, 413);
      let total = 0;
      const bufs = [];
      for (const [h, b64] of entries) {
        if (!/^[0-9a-f]{64}$/.test(h) || typeof b64 !== "string") {
          return jsonResponse({ error: "bad-inline-blob" }, 400);
        }
        let buf;
        try {
          const bin = atob(b64);
          buf = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        } catch (e) { return jsonResponse({ error: "bad-inline-blob" }, 400); }
        total += buf.byteLength;
        if (!buf.byteLength || buf.byteLength > BLOB_MAX_BYTES || total > INLINE_MAX_BYTES) {
          return jsonResponse({ error: "bad-size" }, 413);
        }
        const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))]
          .map((b) => b.toString(16).padStart(2, "0")).join("");
        if (digest !== h) return jsonResponse({ error: "hash-mismatch", hash: h }, 400);
        bufs.push([h, buf]);
      }
      await Promise.all(bufs.map(([h, buf]) => env.BUNDLES.put("blobs/" + h, buf)));
      for (const [h] of bufs) inlineStored.add(h);
    }
    const curObj = await env.BUNDLES.get(`spaces/${spaceId}/manifest.json`);
    const cur = curObj ? JSON.parse(await curObj.text()) : null;
    // Sentinels (instance-configured paths, e.g. the DS core stylesheet): once
    // live in a space, a publish may not silently drop them — that's a broken
    // checkout, not an intent.
    for (const s of INSTANCE_SENTINELS) {
      if (cur && cur.files && cur.files[s] && !m.files[s]) {
        return jsonResponse({ error: "sentinel-missing", path: s }, 422);
      }
    }
    // Spot-validate fresh blobs (free-plan subrequest budget caps a full sweep;
    // hashed PUTs + content addressing make a missing blob unlikely, and a serve
    // 404 is the loud failure if one ever slips).
    const prev = new Set(cur ? Object.values(cur.files).map((f) => f.h) : []);
    const fresh = [...new Set(Object.values(m.files).map((f) => f && f.h).filter(Boolean))]
      .filter((h) => !prev.has(h) && !inlineStored.has(h));
    // Smaller sample when inline blobs rode along — their PUTs already spent
    // part of this request's subrequest budget.
    const sample = fresh.slice(0, inline ? 16 : 40);
    const heads = await Promise.all(sample.map((h) => env.BUNDLES.head("blobs/" + h)));
    const miss = sample.filter((h, i) => !heads[i]);
    if (miss.length) return jsonResponse({ error: "blobs-missing", missing: miss.slice(0, 5) }, 409);
    const version = ((cur && cur.version) || 0) + 1;
    const out = { ...m, version, publishedAt: new Date().toISOString(), publishedBy: who.label || "" };
    await env.BUNDLES.put(`spaces/${spaceId}/versions/${version}.json`, JSON.stringify(out));
    await env.BUNDLES.put(`spaces/${spaceId}/manifest.json`, JSON.stringify(out));
    MANIFESTS.at = 0; cfgAt = 0; // this isolate flips immediately; others within ~1.5s
    return jsonResponse({ ok: true, version });
  }

  if (op === "rollback" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    const v = parseInt(body && body.version, 10);
    if (!v || v < 1) return jsonResponse({ error: "bad-version" }, 400);
    const prev = await env.BUNDLES.get(`spaces/${spaceId}/versions/${v}.json`);
    if (!prev) return jsonResponse({ error: "unknown-version" }, 404);
    await env.BUNDLES.put(`spaces/${spaceId}/manifest.json`, await prev.text());
    MANIFESTS.at = 0; cfgAt = 0;
    return jsonResponse({ ok: true, version: v });
  }

  return jsonResponse({ error: "unknown-op" }, 400);
}

// ---- Admin: engine version + update nudge -----------------------------------
// Reports the running engine version and whether the release feed (GitHub
// releases API by default, `updateFeed` in deploy.config.json to override) holds
// a newer one. The feed check is KV-cached for 6h — one origin fetch per
// instance per window, whatever the page-view rate. Admin-cookie gated; updates
// themselves stay manual (the shell's engine-bump is the release valve).
function semverBehind(cur, latest) {
  const a = String(cur).split(".").map((n) => parseInt(n, 10) || 0);
  const b = String(latest).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { const x = a[i] || 0, y = b[i] || 0; if (x !== y) return x < y; }
  return false;
}
async function adminVersionApi(env, me) {
  if (!me || me.role !== "admin") return jsonResponse({ error: "forbidden" }, 403);
  const current = INSTANCE_ENGINE_VERSION || null;
  const kv = kvFor(env);
  let latest = null, url = "";
  try {
    const cached = kv ? JSON.parse((await kv.get("engine:update-check")) || "null") : null;
    if (cached && Date.now() - cached.at < 6 * 3600 * 1000) {
      latest = cached.latest; url = cached.url || "";
    } else {
      const r = await fetch(UPDATE_FEED || DEFAULT_UPDATE_FEED, {
        headers: { "user-agent": "augur-update-check", accept: "application/vnd.github+json" },
      });
      if (r.ok) {
        const d = await r.json();
        latest = String(d.tag_name || d.version || "").replace(/^v/, "") || null;
        url = d.html_url || "";
      }
      // Cache misses too — a feed with no releases yet must not be re-polled
      // on every admin page view.
      if (kv) await kv.put("engine:update-check", JSON.stringify({ at: Date.now(), latest, url }));
    }
  } catch (e) {}
  const behind = !!(current && latest && semverBehind(current, latest));
  return jsonResponse({ current, latest, url, behind });
}

// ---- Admin: publish tokens (KV-backed) --------------------------------------
// GET lists token metadata (hashes only — the token itself is shown once at
// mint); POST {space,label} mints; DELETE {hash} revokes. Admin-cookie gated.
async function adminTokensApi(request, env, me) {
  if (!me || me.role !== "admin") return jsonResponse({ error: "forbidden" }, 403);
  const kv = kvFor(env);
  if (!kv) return jsonResponse({ error: "no-kv-binding" }, 500);
  const raw = await kv.get(PUBLISH_TOKENS_KEY);
  const map = raw ? JSON.parse(raw) : {};
  if (request.method === "GET") return jsonResponse({ tokens: map });
  if (request.method === "POST") {
    let op;
    try { op = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    const space = clamp(op && op.space, 60).trim() || "*";
    const label = clamp(op && op.label, 80).trim() || "unnamed";
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    map[await tokenFor("pub:" + token)] = { space, label, createdAt: new Date().toISOString() };
    await kv.put(PUBLISH_TOKENS_KEY, JSON.stringify(map));
    return jsonResponse({ token, space, label });
  }
  if (request.method === "DELETE") {
    let op;
    try { op = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    const h = clamp(op && op.hash, 80);
    if (!map[h]) return jsonResponse({ error: "unknown-token" }, 404);
    delete map[h];
    await kv.put(PUBLISH_TOKENS_KEY, JSON.stringify(map));
    return jsonResponse({ ok: true });
  }
  return jsonResponse({ error: "method-not-allowed" }, 405);
}

// ---- Admin: bundle-store usage ----------------------------------------------
// Sums the store (5-min isolate cache — a full list is a few subrequests at
// ~2.5k objects) against the R2 free-tier ceiling so the admin panel can show
// a fill gauge long before a publish would ever hit the wall.
const STORE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024; // R2 free tier: 10 GB
let STORAGE_CACHE = { at: 0, data: null };
async function adminStorageApi(env, me) {
  if (!me || me.role !== "admin") return jsonResponse({ error: "forbidden" }, 403);
  if (!env.BUNDLES) return jsonResponse({ enabled: false });
  if (STORAGE_CACHE.data && Date.now() - STORAGE_CACHE.at < 5 * 60 * 1000) {
    return jsonResponse(STORAGE_CACHE.data);
  }
  let bytes = 0, objects = 0, cursor;
  try {
    do {
      const page = await env.BUNDLES.list({ cursor, limit: 1000 });
      for (const o of page.objects) { bytes += o.size; objects++; }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  } catch (e) { return jsonResponse({ error: "list-failed" }, 502); }
  const data = {
    enabled: true, bytes, objects,
    limitBytes: STORE_LIMIT_BYTES,
    pct: Math.round((bytes / STORE_LIMIT_BYTES) * 1000) / 10,
    at: new Date().toISOString(),
  };
  STORAGE_CACHE = { at: Date.now(), data };
  return jsonResponse(data);
}

function loginPage(redirect, error) {
  const safeRedirect = String(redirect).replace(/"/g, "&quot;");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>Augur</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" />
  <style>
    /* Same visual language as the site shell — near-white canvas, indigo accent,
       Inter — but deliberately quiet: no aurora, no gradient mark, no big drop
       shadow. A flat gate that reads as effortless rather than shiny. */
    :root {
      --bg: #fbfbfd; --card: #ffffff; --fg: #16171a; --muted: #5b626e; --faint: #9aa0ab;
      --line: rgba(16,17,26,0.09); --line-2: rgba(16,17,26,0.15);
      /* accent = the logo's almost-black (#2C2150), so button + focus match the mark */
      --accent: #2c2150; --accent-solid: #2c2150; --err: #b42318;
      color-scheme: light;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; min-height: 100dvh; display: grid; place-items: center; padding: 24px;
      font: 15px/1.55 "Inter", "Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      letter-spacing: -0.011em; background: var(--bg); color: var(--fg);
      -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
    }
    .card {
      background: var(--card); border: 1px solid var(--line); border-radius: 14px;
      padding: 30px 30px 28px; max-width: 360px; width: 100%;
      box-shadow: 0 1px 2px rgba(16,24,40,0.05), 0 10px 28px -22px rgba(16,24,40,0.22);
    }
    .logo { display: flex; justify-content: center; margin: 4px 0 24px; }
    .logo svg { width: 40px; height: 40px; display: block; }
    label { display: block; font-size: 13px; font-weight: 500; margin: 0 0 7px; }
    input[type=password], input[type=email] {
      width: 100%; font: inherit; font-size: 15px; padding: 8px 13px; border-radius: 9px;
      border: 1px solid var(--line-2); background: #fff; color: var(--fg);
      transition: border-color .12s ease;
    }
    input[type=password]:hover, input[type=email]:hover { border-color: rgba(16,17,26,0.28); }
    input[type=password]:focus, input[type=email]:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: transparent; }
    label + label, input + label { margin-top: 14px; }
    button {
      width: 100%; margin-top: 16px; font: inherit; font-weight: 600; font-size: 15px; color: #fff;
      background: var(--accent-solid); border: 1px solid transparent; border-radius: 9px; padding: 8px;
      cursor: pointer; transition: background .12s ease;
    }
    button:hover { background: #38295e; }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    /* Error carries an icon + text, never colour alone (WCAG 1.4.1). */
    .error {
      display: ${error ? "flex" : "none"}; align-items: flex-start; gap: 7px;
      color: var(--err); font-size: 13.5px; font-weight: 500; margin: 14px 0 0;
    }
    .error svg { width: 16px; height: 16px; flex: none; margin-top: 1px; }
    /* Present in the DOM for password managers (Bitwarden pairs username+password),
       but visually hidden so the UI stays password-only. NOT display:none — managers
       skip removed/hidden fields. */
    .visually-hidden {
      position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
      overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
    }
    @media (max-width: 420px) { .card { padding: 26px 22px; } }
    @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
  </style>
</head>
<body>
  <main class="card">
    <div class="logo">
      <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Augur">
        <g transform="translate(153.5 153.5) scale(1.115)" fill="#2C2150" fill-rule="evenodd"><path d="M303.668 0.501099C480.9 -9.31876 632.543 126.378 642.396 303.609C652.249 480.839 516.579 632.508 339.35 642.392C162.076 652.279 10.36 516.567 0.504883 339.291C-9.34912 162.015 126.39 10.3241 303.668 0.501099ZM321.31 58.589C313.993 78.2949 309.682 91.0001 300.003 110.42C256.894 196.544 185.761 265.436 98.3008 305.765C84.5568 312.054 73.3451 316.365 59.0391 321.205C166.492 358.562 254.54 437.345 303.567 540.001C306.201 545.441 320.11 580.712 320.888 581.447C329.254 559.649 338.869 536.27 350.55 515.916C397.544 434.024 469.471 370.244 555.57 331.86C563.577 328.29 574.85 323.736 583.145 321.47C472.786 278.754 383.1 203.746 334.938 93.8761C332.878 89.1732 321.885 59.2127 321.31 58.589Z"/></g>
      </svg>
    </div>
    <form method="POST" action="/__auth">
      <input type="hidden" name="redirect" value="${safeRedirect}" />
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false" autofocus required ${error ? 'aria-invalid="true" aria-describedby="pw-err"' : ""} />
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required ${error ? 'aria-invalid="true" aria-describedby="pw-err"' : ""} />
      <button type="submit">Enter</button>
      <p class="error" id="pw-err" role="alert">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 8v5M12 16.5v.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M10.3 3.9 2.5 18a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
        <span>Incorrect email or password. Try again.</span>
      </p>
    </form>
  </main>
</body>
</html>`;
}

// Branded 404 — same shell language as loginPage (near-white canvas, indigo accent,
// Inter, the Augur mark). Shown when env.ASSETS.fetch returns a 404 for a request
// that is PAST the gate (authed user, admin page, or a public-prototype path). The
// signed-out fallthrough keeps returning the login page instead, so an unknown URL
// never reveals whether it exists to someone who hasn't logged in.
function notFoundPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>Not found · Augur</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" />
  <style>
    :root {
      --bg: #fbfbfd; --card: #ffffff; --fg: #16171a; --muted: #5b626e; --faint: #9aa0ab;
      --line: rgba(16,17,26,0.09); --line-2: rgba(16,17,26,0.15);
      --accent: #2c2150; --accent-solid: #2c2150;
      color-scheme: light;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; min-height: 100dvh; display: grid; place-items: center; padding: 24px;
      font: 15px/1.55 "Inter", "Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      letter-spacing: -0.011em; background: var(--bg); color: var(--fg);
      -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
    }
    .card {
      background: var(--card); border: 1px solid var(--line); border-radius: 14px;
      padding: 34px 32px 30px; max-width: 380px; width: 100%; text-align: center;
      box-shadow: 0 1px 2px rgba(16,24,40,0.05), 0 10px 28px -22px rgba(16,24,40,0.22);
    }
    .logo { display: flex; justify-content: center; margin: 2px 0 20px; }
    .logo svg { width: 40px; height: 40px; display: block; }
    .code { font-size: 13px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--faint); margin: 0 0 6px; }
    h1 { font-size: 19px; font-weight: 600; margin: 0 0 8px; }
    p { font-size: 14px; color: var(--muted); margin: 0 0 22px; }
    a.home {
      display: inline-block; font-weight: 600; font-size: 14px; color: #fff;
      background: var(--accent-solid); border-radius: 9px; padding: 9px 18px;
      text-decoration: none; transition: background .12s ease;
    }
    a.home:hover { background: #38295e; }
    a.home:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    @media (max-width: 420px) { .card { padding: 28px 22px; } }
    @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
  </style>
</head>
<body>
  <main class="card">
    <div class="logo">
      <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Augur">
        <g transform="translate(153.5 153.5) scale(1.115)" fill="#2C2150" fill-rule="evenodd"><path d="M303.668 0.501099C480.9 -9.31876 632.543 126.378 642.396 303.609C652.249 480.839 516.579 632.508 339.35 642.392C162.076 652.279 10.36 516.567 0.504883 339.291C-9.34912 162.015 126.39 10.3241 303.668 0.501099ZM321.31 58.589C313.993 78.2949 309.682 91.0001 300.003 110.42C256.894 196.544 185.761 265.436 98.3008 305.765C84.5568 312.054 73.3451 316.365 59.0391 321.205C166.492 358.562 254.54 437.345 303.567 540.001C306.201 545.441 320.11 580.712 320.888 581.447C329.254 559.649 338.869 536.27 350.55 515.916C397.544 434.024 469.471 370.244 555.57 331.86C563.577 328.29 574.85 323.736 583.145 321.47C472.786 278.754 383.1 203.746 334.938 93.8761C332.878 89.1732 321.885 59.2127 321.31 58.589Z"/></g>
      </svg>
    </div>
    <p class="code">404</p>
    <h1>Page not found</h1>
    <p>This URL doesn't match any page, prototype, or asset.</p>
    <a class="home" href="/">Back to Augur</a>
  </main>
</body>
</html>`;
}

function htmlResponse(body, status) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// Branded 404 for requests that are past the gate. no-store + noindex so it's never
// cached or crawled. Used wherever env.ASSETS.fetch returns a 404 for an authed/public path.
function notFoundResponse() {
  return new Response(notFoundPage(), {
    status: 404,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    },
  });
}

// ---- Live-reload injection (global) -----------------------------------------
// Every HTML page served gets a tiny poller appended before </body>. It freezes
// THIS page's version (versionFor(path)) at load time, then polls
// /__version?path=<its own path>; when that page's version changes (i.e. ITS
// prototype was redeployed), it reloads — so an unrelated deploy never reloads it.
// Idle-gated: if the version changed while you're mid-interaction, it waits until
// you've paused (≈4s of no input) so it never yanks you out of a flow; the next
// tick reloads once idle. A reload is a full refresh (resets in-page JS state).
// Done in the edge (not baked per file) so it's one definition covering every
// current and future page. Skips:
//   • non-HTML responses, • preview iframes (parent reloads them),
//   • ?raw=1 fetches (the Download HTML button uses it to get a clean file).
// Marker-wrapped so the Download button's strip also removes it as a fallback.
// `fast` is set only for localhost requests (offline mode): poll every 1s and use a
// short idle gate so a local rebuild reloads the tab near-instantly. Live (deployed)
// requests keep the gentle 10s poll / 4s idle gate so they never hammer the worker.
function liveReloadSnippet(token, fast) {
  const interval = fast ? 1000 : 10000;
  const idle = fast ? 300 : 4000;
  return '<!--gv-reload-start--><script>(function(){if(window.top!==window.self)return;' +
    'var B=' + JSON.stringify(token) + ',last=0;' +
    '["pointerdown","keydown","input","scroll","touchstart"].forEach(function(e){' +
    'document.addEventListener(e,function(){last=Date.now()},{passive:true,capture:true})});' +
    'function c(){fetch("/__version?path="+encodeURIComponent(location.pathname),{cache:"no-store"})' +
    '.then(function(r){return r.ok?r.text():null})' +
    '.then(function(t){if(t&&t.trim()&&t.trim()!==B&&Date.now()-last>' + idle + ')location.reload()})' +
    '.catch(function(){})}' +
    'setInterval(function(){if(!document.hidden)c()},' + interval + ');' +
    'document.addEventListener("visibilitychange",function(){if(!document.hidden)c()});' +
    // bfcache restore (back/forward): re-check version immediately so a page restored
    // after a deploy refreshes, while normal restores stay instant.
    'addEventListener("pageshow",function(e){if(e.persisted)c()});})();</script><!--gv-reload-end-->';
}

// Long-cache versioned/static assets so repeat navigations cost zero revalidation.
// Cloudflare's default for assets is `max-age=0, must-revalidate` (a 304 round-trip
// every visit); we override to a year + immutable, but ONLY for assets whose URL
// changes when their content does — anything carrying a ?v= cache-buster, or fonts
// (served from versioned /fonts/ paths). HTML and un-versioned assets (posters,
// per-prototype CSS) are left on the default so they still revalidate via ETag/304.
function withAssetCache(res, url) {
  // The infinite-canvas engine (canvas.js/.css/catalog.json) is loaded by absolute path
  // with no ?v= cache-buster and is actively iterated. `no-cache` forces a REVALIDATION
  // on every use (so the stale-JS ghosts no-store used to fight stay dead — every load
  // still checks) but lets the browser answer with its cached copy on the 304, so a
  // repeat open costs ~1KB of conditional requests instead of ~110KB of engine
  // re-download (was `no-store` until 2026-08-07, which disabled caching entirely).
  if (url.pathname.startsWith("/__canvas/") && /\.(js|css|json)$/i.test(url.pathname)) {
    const out = new Response(res.body, res);
    out.headers.set("Cache-Control", "no-cache");
    return out;
  }
  const versioned = url.searchParams.has("v") || /\.(woff2?|ttf|otf)$/.test(url.pathname);
  if (!versioned) return res;
  const out = new Response(res.body, res);
  out.headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return out;
}

function withLiveReload(res, url) {
  const ct = res.headers.get("Content-Type") || "";
  if (!ct.includes("text/html") || url.searchParams.has("raw")) return res;
  // Offline mode (`npm run offline` → wrangler pages dev) is served from localhost;
  // there we poll fast so a rebuild reloads the tab in ~1s. Live stays on 10s.
  const fast = url.hostname === "localhost" || url.hostname === "127.0.0.1" ||
    url.hostname === "::1" || url.hostname.endsWith(".localhost");
  return new HTMLRewriter()
    .on("body", { element(el) { el.append(liveReloadSnippet(versionFor(url.pathname), fast), { html: true }); } })
    .transform(res);
}

// ---- Platform MCP proxy (same-origin bridge) ---------------------------------
// Upstream platforms often send no CORS headers on /mcp or /oauth/token, so a
// browser prototype on this origin cannot call them directly. This route lets a
// page call /__mcp/<host>/<path> on ITS OWN origin and have the worker forward to
// https://<host>/<path>. Public (before the gate) — the platform's own OAuth
// Bearer token is the real auth; the proxy adds nothing, stores nothing, and
// never logs a token. Allowlist is tight: subdomains of the injected
// MCP_HOST_SUFFIXES, the exact hosts the spaces declared at build time
// (MCP_HOST_ALLOWLIST), plus the exact hosts published at MCP_HOST_ALLOWLIST_URL,
// and exactly the paths the builder + OAuth flows need.

const MCP_PROXY_PATHS = new Set([
  "/mcp",
  "/oauth/registrations",
  "/oauth/token",
  "/web_api/v1/app_configuration",
]);

// Exact-host allowlist, fetched once per isolate from MCP_HOST_ALLOWLIST_URL — a
// JSON document shaped {"hosts": ["…"]}. A suffix rule cannot express a platform
// living on its own vanity domain without opening that domain's whole public
// suffix, and an "answers like a platform?" probe would turn this route into an
// open proxy for anything reachable from the deploy network — so the instance
// publishes an explicit list instead. Unset, or unreachable, means no host beyond
// MCP_HOST_SUFFIXES is allowed: the route behaves exactly as it does without the
// knob rather than failing closed on traffic that works today.
let mcpHostAllowlist = null;

function mcpAllowlist() {
  if (!MCP_HOST_ALLOWLIST_URL) return Promise.resolve(null);
  if (!mcpHostAllowlist) {
    mcpHostAllowlist = fetch(MCP_HOST_ALLOWLIST_URL, { cf: { cacheTtl: 3600, cacheEverything: true } })
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then((doc) => new Set(Array.isArray(doc && doc.hosts) ? doc.hosts : []))
      .catch(() => { mcpHostAllowlist = null; return null; }); // retry on the next request
  }
  return mcpHostAllowlist;
}

// Space-declared exact hosts, from routing.json (see build.js): no extra fetch, no
// failure mode, and a space publish refreshes the list with the same deploy that
// ships the prototype using it. Rebuilt by loadConfig on every config refresh.
let mcpStaticHosts = new Set();

async function mcpHostAllowed(host) {
  if (MCP_HOST_SUFFIXES.some((sfx) => host.endsWith("." + sfx))) return true;
  // Exact match only — endsWith on a bare host would let <allowed>.attacker.example
  // through. Both lists are stored without a leading "www.".
  const bare = host.replace(/^www\./, "");
  if (mcpStaticHosts.has(host) || mcpStaticHosts.has(bare)) return true;
  const allow = await mcpAllowlist();
  return !!allow && (allow.has(host) || allow.has(bare));
}

async function mcpProxy(request, url) {
  const rest = url.pathname.slice("/__mcp/".length); // "<host>/<path…>"
  const slash = rest.indexOf("/");
  const host = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? "/" : rest.slice(slash);
  // The pattern is lowercase-only, so it also rejects any case-variant spelling of
  // an allowed host before the comparisons below.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)
      || !(await mcpHostAllowed(host)))
    return jsonResponse({ error: "host not allowed" }, 403);
  if (!MCP_PROXY_PATHS.has(path)) return jsonResponse({ error: "path not allowed" }, 403);
  if (request.method !== "POST" && request.method !== "GET")
    return jsonResponse({ error: "method not allowed" }, 405);
  const headers = new Headers();
  for (const h of ["content-type", "accept", "authorization", "mcp-protocol-version"]) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }
  const upstream = await fetch(`https://${host}${path}`, {
    method: request.method,
    headers,
    body: request.method === "POST" ? await request.arrayBuffer() : undefined,
  });
  // The response is rebuilt, and the upstream content type is NOT trusted. An
  // allowed host is still a third party, and /__mcp/<host>/<path> is reachable by
  // plain navigation — echoing its `text/html` would hand it script execution on
  // the origin that serves every gated page and the admin API. These paths speak
  // JSON, plus event-stream for a streaming MCP transport; anything else is
  // relabelled and never rendered. Upstream response headers are dropped wholesale
  // (no Set-Cookie on this origin, no CORS grant, and no `WWW-Authenticate: Basic`
  // summoning a credential prompt here).
  const upType = upstream.headers.get("Content-Type") || "";
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": /^\s*(application\/json|text\/event-stream)\s*(;|$)/i.test(upType)
        ? upType : "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
    },
  });
}

// ---- AI document summarizer ------------------------------------------------
// The Project Builder prototype drops a doc → this route reads its extracted
// text and returns a plain-language summary + structured drafting signals
// (archetype / method flags / tags), so the builder suggests a genuinely
// better-shaped project instead of keyword-guessing. Gated behind the login.
// Two backends, in order of preference (see aiSummarize):
//   1. AI_CLI_URL  — a local `claude -p` bridge (offline mode; the maintainer's
//      Claude login, NO API tokens). This is the normal path.
//   2. ANTHROPIC_API_KEY — the Anthropic Messages API (pay-as-you-go); a
//      dormant fallback for a deployed site that opts in by setting the key.
// Neither configured → 503, and the prototype falls back to its heuristic.
// The API-path model is a single constant. Opus 4.8 for the customer demo:
// richest read of a complex doc (sharpest summary, most reliable archetype/flags,
// least over-flagging) — its few extra seconds are covered by the client's narrated
// "thinking" stepper, which makes the analysis read as considered. ~a few cents per
// doc; trivial at demo volume. Drop to claude-sonnet-4-6 / claude-haiku-4-5 for
// faster/cheaper output if a call warrants it.

const AI_MODEL = "claude-opus-4-8";

// The AI project-builder prompts + output schema are deploy-specific content —
// injected via BUILDER_CONFIG (see the placeholder near USERS). A raw engine build
// has none, and /__ai/summarize answers 501 until a deploy config provides them.

async function aiSummarize(request, env) {
  if (request.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);
  // The builder's prompts + output schema are deploy content, not engine code —
  // without an injected BUILDER_CONFIG this endpoint is simply not configured.
  if (!BUILDER_CONFIG) return jsonResponse({ error: "builder not configured" }, 501);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "bad json" }, 400); }
  const text = String((body && body.text) || "").slice(0, 60000); // ~15k tokens cap
  if (text.trim().length < 40) return jsonResponse({ error: "text too short" }, 400);

  // Preferred path: a local CLI bridge (offline mode wires AI_CLI_URL to a
  // 127.0.0.1 server that shells out to `claude -p` — the maintainer's Claude
  // login, NO API tokens). The API-key path below is a dormant fallback for a
  // deployed site that has ANTHROPIC_API_KEY set; absent both → 503 → heuristic.
  if (env.AI_CLI_URL) {
    try {
      const r = await fetch(env.AI_CLI_URL.replace(/\/+$/, "") + "/summarize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const j = await r.json().catch(() => null);
      if (r.ok && j && j.summary) return jsonResponse(j);
      return jsonResponse({ error: "cli", status: r.status }, 502);
    } catch (e) {
      return jsonResponse({ error: "cli_unreachable", detail: String((e && e.message) || e) }, 502);
    }
  }

  const key = env.ANTHROPIC_API_KEY;
  if (!key) return jsonResponse({ error: "ai_not_configured" }, 503);

  let upstream;
  try {
    upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        // This caps OUTPUT, not input (the doc is sliced to 60k chars above). The output
        // is the project structure — bounded by the SCHEMA (≤6 phases, a few questions
        // per survey, ≤3-4 events, summary+rationale), NOT by document length: a 5-page
        // brief and a 200-page plan both collapse to that shape (~2k tokens even for a
        // rich comprehensive plan). 2048 truncated the JSON on rich docs (→ parse → 502
        // → silent heuristic fallback), so this is set far above the realistic max as
        // free insurance — only tokens actually generated are billed.
        model: AI_MODEL,
        max_tokens: 16384,
        system: BUILDER_CONFIG.system,
        output_config: { format: { type: "json_schema", schema: BUILDER_CONFIG.schema } },
        messages: [{ role: "user", content: "Document:\n\n" + text }],
      }),
    });
  } catch (e) {
    return jsonResponse({ error: "network", detail: String(e && e.message || e) }, 502);
  }
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    return jsonResponse({ error: "upstream", status: upstream.status, detail: detail.slice(0, 400) }, 502);
  }
  const data = await upstream.json().catch(() => null);
  const block = data && Array.isArray(data.content) ? data.content.find((b) => b.type === "text") : null;
  if (!block) return jsonResponse({ error: "empty" }, 502);
  let out;
  try { out = JSON.parse(block.text); } catch { return jsonResponse({ error: "parse" }, 502); }
  return jsonResponse(out);
}

// ---- Review comments API (KV-backed) ----------------------------------------
// Threads are stored one KV value per prototype page path, key "c:<path>".

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

const clamp = (s, n) => String(s == null ? "" : s).slice(0, n);

function sanitizeMsg(m) {
  return {
    author: clamp(m && m.author, 80) || "Anonymous",
    body: clamp(m && m.body, 4000),
    at: clamp(m && m.at, 40) || new Date().toISOString(),
  };
}

// Apply a single review op to a thread array; returns the new array.
function applyOp(threads, op) {
  if (!op || typeof op !== "object") return threads;
  if (op.op === "add" && op.thread) {
    const t = op.thread;
    const id = clamp(t.id, 64) || String(Date.now());
    // Idempotent by id: re-adding the same thread is a no-op, never a duplicate. This
    // lets a second writer (e.g. the piti roast agent) safely re-assert its annotation
    // to heal it after a racing read-modify-write delete clobbered the shared key.
    if (!threads.some((x) => x.id === id)) {
      threads.push({
        id,
        sel: clamp(t.sel, 600),
        fx: +t.fx || 0, fy: +t.fy || 0, px: +t.px || 0, py: +t.py || 0,
        view: clamp(t.view, 600) || null,
        screen: clamp(t.screen, 200) || null,
        resolved: false,
        annotation: !!t.annotation,
        messages: (Array.isArray(t.messages) ? t.messages : []).slice(0, 1).map(sanitizeMsg),
      });
      if (threads.length > 500) threads = threads.slice(-500);
    }
  } else if (op.op === "move") {
    const t = threads.find((x) => x.id === op.id);
    if (t) {
      t.sel = clamp(op.sel, 600);
      t.fx = +op.fx || 0; t.fy = +op.fy || 0; t.px = +op.px || 0; t.py = +op.py || 0;
      if (op.view != null) t.view = clamp(op.view, 600) || null;
    }
  } else if (op.op === "reply" && op.message) {
    const t = threads.find((x) => x.id === op.id);
    if (t) t.messages = (t.messages || []).concat([sanitizeMsg(op.message)]).slice(0, 200);
  } else if (op.op === "resolve") {
    const t = threads.find((x) => x.id === op.id);
    if (t) t.resolved = !!op.resolved;
  } else if (op.op === "annotate") {
    const t = threads.find((x) => x.id === op.id);
    if (t) t.annotation = !!op.annotation;
  } else if (op.op === "delmsg") {
    // Delete one message by index. Deleting the root message (0) deletes the thread.
    const idx = +op.index;
    if (idx === 0) {
      threads = threads.filter((x) => x.id !== op.id);
    } else {
      const t = threads.find((x) => x.id === op.id);
      if (t && Array.isArray(t.messages)) t.messages = t.messages.filter((_, i) => i !== idx);
    }
  } else if (op.op === "delete") {
    threads = threads.filter((x) => x.id !== op.id);
  }
  return threads;
}

// GET/POST /__review/api?path=<page> — read or mutate one page's threads.
// Reads are open (public prototypes embed the overlay: annotations show always-on,
// comments show once a viewer presses Shift+C). Writes stay gated — see router.
async function reviewApi(request, url, env) {
  const kv = kvFor(env);
  const path = clamp(url.searchParams.get("path") || "/", 600);
  if (!kv) return jsonResponse({ threads: [], warning: "no-kv-binding" });
  const key = "c:" + path;

  if (request.method === "GET") {
    const raw = await kv.get(key);
    return jsonResponse({ threads: raw ? JSON.parse(raw) : [] });
  }
  if (request.method === "POST") {
    let op;
    try { op = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    const raw = await kv.get(key);
    let threads = raw ? JSON.parse(raw) : [];
    threads = applyOp(threads, op);
    await kv.put(key, JSON.stringify(threads));
    return jsonResponse({ threads });
  }
  return jsonResponse({ error: "method-not-allowed" }, 405);
}

// ---- Dev-status API (KV-backed, single key) ---------------------------------
// The ENTIRE status map lives under one key ("statuses"), so a page load is one
// kv.get and a click is one kv.put — NO kv.list (the small-bucket call that burned
// quota in the old badge system). Default status is "ignore"; the build-time chip
// baseline comes from the committed prototype-status.json, and this overlays live
// edits on top. Values: in-progress | dev-ready | ignore | reviewed (components).
const STATUS_KEY = "statuses";
const VALID_STATUS = { "in-progress": 1, "dev-ready": 1, ignore: 1, reviewed: 1 };

async function statusApi(request, url, env) {
  const kv = kvFor(env);
  if (!kv) return jsonResponse({ map: {}, warning: "no-kv-binding" });

  if (request.method === "GET") {
    const raw = await kv.get(STATUS_KEY);
    return jsonResponse({ map: raw ? JSON.parse(raw) : {} });
  }
  if (request.method === "POST") {
    let op;
    try { op = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    const key = clamp(op && op.key, 300);
    const status = clamp(op && op.status, 40);
    if (!key || !VALID_STATUS[status]) return jsonResponse({ error: "bad-input" }, 400);
    const raw = await kv.get(STATUS_KEY);
    const map = raw ? JSON.parse(raw) : {};
    map[key] = status;
    await kv.put(STATUS_KEY, JSON.stringify(map));
    return jsonResponse({ map });
  }
  return jsonResponse({ error: "method-not-allowed" }, 405);
}

// ---- Pins API (KV-backed, single key) ---------------------------------------
// User-pinned prototypes/projects for the sidebar. Whole map under one key ("pins")
// — one kv.get per session, one kv.put per toggle (same frugal pattern as statuses).
// Value: { "<path>": { label, href } }. POST { key, label, href, pinned } toggles.
const PINS_KEY = "pins";

async function pinsApi(request, url, env, user) {
  const kv = kvFor(env);
  if (!kv) return jsonResponse({ map: {}, warning: "no-kv-binding" });
  // Pins are per-user (key "pins:<email>"), independent across users; the global
  // "pins" key is only the fallback when nobody is signed in. Note: NO migration
  // from the global map — that seeded EVERY new user from one shared (effectively
  // the first user's) map, leaking pins across accounts. A new user starts empty.
  const key = user ? `${PINS_KEY}:${user.email}` : PINS_KEY;

  if (request.method === "GET") {
    const raw = await kv.get(key);
    return jsonResponse({ map: raw ? JSON.parse(raw) : {} });
  }
  if (request.method === "POST") {
    let op;
    try { op = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    // Authoritative full-state write. The client owns the complete pins map (add,
    // remove and reorder all just produce a new full map), so we store exactly what it
    // sends — NO server-side read-modify-write, which races under KV eventual
    // consistency: a stale/empty read could be written back and clobber everything
    // (that wiped a user's pins during rapid reorder). `set` is the {key:{label,href}} map.
    if (!op || typeof op.set !== "object" || op.set === null) {
      return jsonResponse({ error: "bad-input" }, 400);
    }
    const next = {};
    for (const k of Object.keys(op.set).slice(0, 200)) {
      const ck = clamp(k, 300);
      const v = op.set[k] || {};
      if (ck) next[ck] = { label: clamp(v.label, 120) || ck, href: clamp(v.href, 300) || ck };
    }
    // Safety net: never silently wipe to empty. An empty result is almost always a bug
    // (stale/poisoned client); only honour it when the client explicitly clears the
    // last pin (allowEmpty). Otherwise leave KV untouched and echo the stored map back.
    if (Object.keys(next).length === 0 && !(op && op.allowEmpty)) {
      const raw = await kv.get(key);
      return jsonResponse({ map: raw ? JSON.parse(raw) : {}, skipped: "empty-guard" });
    }
    await kv.put(key, JSON.stringify(next));
    return jsonResponse({ map: next });
  }
  return jsonResponse({ error: "method-not-allowed" }, 405);
}

// ---- Card display-name overrides (KV-backed, single key) --------------------
// Same shape & cost profile as the dev-status map: the whole {key: name} map
// lives under one KV key, so a card-list load is one kv.get and a rename is one
// kv.put — NO kv.list. These override ONLY the label shown on the index card;
// the prototype's folder, URL and content are unaffected (a true rename is a repo
// edit). An empty name clears the override (the card reverts to its build default).
const NAMES_KEY = "names";

async function nameApi(request, url, env) {
  const kv = kvFor(env);
  if (!kv) return jsonResponse({ map: {}, warning: "no-kv-binding" });

  if (request.method === "GET") {
    const raw = await kv.get(NAMES_KEY);
    return jsonResponse({ map: raw ? JSON.parse(raw) : {} });
  }
  if (request.method === "POST") {
    let op;
    try { op = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    const key = clamp(op && op.key, 300);
    // Component descriptions (keys ending "#desc") are full sentences; names stay short.
    const name = clamp(op && op.name, key && key.endsWith("#desc") ? 280 : 80);
    if (!key) return jsonResponse({ error: "bad-input" }, 400);
    const raw = await kv.get(NAMES_KEY);
    const map = raw ? JSON.parse(raw) : {};
    if (name) map[key] = name;
    else delete map[key]; // empty → revert to the build-time default
    await kv.put(NAMES_KEY, JSON.stringify(map));
    return jsonResponse({ map });
  }
  return jsonResponse({ error: "method-not-allowed" }, 405);
}

// ---- Prototype deletion (repo-write via dispatch webhook) -------------------
// "Delete forever" on a prototype card. The worker holds NO repo credentials —
// it forwards the request to a per-instance webhook (a GitHub repository_dispatch
// on the deploy shell, which runs the actual `git rm` + push; the redeploy that
// follows removes the prototype from the live site). Both values come from runtime
// env (Cloudflare project settings), so the engine stays generic and a raw/local
// build answers 501: DELETE_DISPATCH_URL (the dispatches endpoint) and
// DELETE_DISPATCH_TOKEN (a token with write access to fire it).
// Path shapes are the two prototype homes only — never galleries, never skills.
const DELETE_PATH_RE = /^(?:[a-z0-9][a-z0-9._-]*\/prototypes\/[a-z0-9][a-z0-9._-]*|playground\/[a-z0-9][a-z0-9._-]*)$/;

async function deleteApi(request, env, me) {
  if (request.method !== "POST") return jsonResponse({ error: "method-not-allowed" }, 405);
  if (!env.DELETE_DISPATCH_URL || !env.DELETE_DISPATCH_TOKEN) {
    return jsonResponse({ error: "not-configured" }, 501);
  }
  let op;
  try { op = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
  const space = clamp(op && op.space, 60);
  const path = clamp(op && op.path, 200);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(space) || !DELETE_PATH_RE.test(path) || path.includes("..")) {
    return jsonResponse({ error: "bad-input" }, 400);
  }
  const r = await fetch(env.DELETE_DISPATCH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.DELETE_DISPATCH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "augur-worker",
    },
    body: JSON.stringify({
      event_type: "prototype-delete",
      client_payload: { space, path, by: me ? me.email : "" },
    }),
  });
  if (!r.ok && r.status !== 204) return jsonResponse({ error: "dispatch-failed", status: r.status }, 502);
  return jsonResponse({ ok: true }, 202);
}

// ---- Created canvases (KV-backed, single key) -------------------------------
// "New canvas" from a folder index: registers a board at <dir><slug>/ in one shared
// { "<path>": {name, by, t} } map (same frugal one-key pattern as statuses/names).
// The worker then SERVES the standard canvas loader at that path (virtualCanvas
// below) — no repo file exists until someone materializes the folder. Created
// boards are PUBLIC like any published prototype (obscure share link, no login) —
// the loader is served past the gate in the fetch fallthrough. Board CONTENTS live
// where every canvas keeps them: the /__board doc for that URL — so materializing
// later is just committing the 12-line loader.
const CANVASES_KEY = "canvases";
// A creatable dir is one or more lowercase slug segments ("/playground/",
// "/<folder>/", "/<space>/<folder>/") — never the site root.
const CANVAS_DIR_RE = /^\/(?:[a-z0-9-]+\/)+$/;

async function canvasesApi(request, url, env, me) {
  const kv = kvFor(env);
  if (!kv) return jsonResponse({ map: {}, warning: "no-kv-binding" });

  if (request.method === "GET") {
    const raw = await kv.get(CANVASES_KEY);
    return jsonResponse({ map: raw ? JSON.parse(raw) : {} });
  }
  if (request.method === "POST") {
    let op;
    try { op = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    const raw = await kv.get(CANVASES_KEY);
    const map = raw ? JSON.parse(raw) : {};

    if (op && op.remove) {
      const path = clamp(op.path, 300);
      if (!map[path]) return jsonResponse({ error: "not-found" }, 404);
      // The board doc (board:<path>) is left in KV on purpose — recreating the same
      // name restores the board, so a mis-click never destroys anyone's work.
      delete map[path];
      await kv.put(CANVASES_KEY, JSON.stringify(map));
      return jsonResponse({ map });
    }
    // Rename in place: the display name changes, the path (and so the board doc)
    // stays — same model as card renames, but the registry IS the name store here.
    if (op && op.rename) {
      const path = clamp(op.path, 300);
      const name = clamp(op.name, 80).trim();
      if (!map[path] || !name) return jsonResponse({ error: "bad-input" }, 400);
      map[path].name = name;
      await kv.put(CANVASES_KEY, JSON.stringify(map));
      return jsonResponse({ map });
    }

    const dir = clamp(op && op.dir, 200);
    const name = clamp(op && op.name, 80).trim();
    if (!name || !CANVAS_DIR_RE.test(dir)) return jsonResponse({ error: "bad-input" }, 400);
    const slug = name.toLowerCase().replace(/['’]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
    if (!slug) return jsonResponse({ error: "bad-input" }, 400);
    const path = dir + slug + "/";
    if (map[path]) return jsonResponse({ error: "exists", path }, 409);
    // Never shadow a real shipped file at the same URL (any non-404, incl. redirects).
    if (await assetPathExists(env, new URL(path, url))) return jsonResponse({ error: "exists", path }, 409);
    map[path] = { name, by: me ? me.email : "", t: Date.now() };
    await kv.put(CANVASES_KEY, JSON.stringify(map));
    return jsonResponse({ map, path });
  }
  return jsonResponse({ error: "method-not-allowed" }, 405);
}

// From routing.json: the extra tags every BUILT prototype page carries — the
// review/comment overlay (graph.js + comments.js, which power C-to-comment and
// Shift+C provenance) plus any build addon's tags. Without this a worker-served
// canvas page mounts the engine but loses the overlay stack that real prototype
// files get injected at build.
let CANVAS_LOADER_EXTRAS = "";

// The same loader a repo canvas folder carries — the page just names the board and
// mounts the shared /__canvas/ engine; contents persist to /__board keyed by URL.
function canvasLoaderPage(name) {
  const title = String(name).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const boot = JSON.stringify({ name: String(name) }).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<meta name="description" content="Live canvas board (${title}): created from the folder page; its content lives in the board doc at /__board" />
<title>${title}</title>
<link rel="stylesheet" href="/__canvas/canvas.css" />
<script>window.GV_CANVAS = ${boot};</script>
</head>
<body>
<script src="/__canvas/canvas.js" defer></script>${CANVAS_LOADER_EXTRAS}
</body>
</html>`;
}

// Serve a registered created-canvas path (null when the path isn't one). Called only
// on asset 404s, so the extra kv.get never taxes a real page load. Bare
// "/dir/slug" redirects to the trailing-slash form — the board doc and the room are
// keyed by the page's URL path, and two spellings must not split one board in two.
async function virtualCanvas(request, env, url) {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const kv = kvFor(env);
  if (!kv) return null;
  let p = url.pathname;
  if (p.endsWith("/index.html")) p = p.slice(0, -"index.html".length);
  const normalized = p.endsWith("/") ? p : p + "/";
  if (!CANVAS_DIR_RE.test(normalized)) return null;
  const raw = await kv.get(CANVASES_KEY);
  if (!raw) return null;
  const entry = JSON.parse(raw)[normalized];
  if (!entry) return null;
  if (url.pathname !== normalized && !url.pathname.endsWith("/index.html")) {
    return Response.redirect(new URL(normalized, url).toString(), 301);
  }
  return new Response(canvasLoaderPage(entry.name), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    },
  });
}

// ---- Canvas board documents (KV-backed, one key per canvas URL) -------------
// Each canvas (a prototype that mounts the shared /__canvas/ engine) owns ONE board
// document — nodes + view + name — keyed by its URL path, the same per-URL rail comments
// use, so it isolates per-space for free. The client owns the whole document, so we store
// exactly what it POSTs (authoritative full-state write, like pins) — no server-side merge
// that could race under KV eventual consistency. GET returns { doc } (null if never saved).
const BOARD_PREFIX = "board:";
const BOARD_MAX_BYTES = 20 * 1024 * 1024; // under KV's 25MB per-value ceiling (inline images)

async function boardApi(request, url, env) {
  const kv = kvFor(env);
  if (!kv) return jsonResponse({ doc: null, warning: "no-kv-binding" });
  const path = clamp(url.searchParams.get("path"), 600);
  if (!path) return jsonResponse({ error: "bad-input" }, 400);
  const key = BOARD_PREFIX + path;

  if (request.method === "GET") {
    const raw = await kv.get(key);
    return jsonResponse({ doc: raw ? JSON.parse(raw) : null });
  }
  if (request.method === "POST" || request.method === "PUT") {
    const body = await request.text();
    if (body.length > BOARD_MAX_BYTES) return jsonResponse({ error: "too-large" }, 413);
    let op;
    try { op = JSON.parse(body); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    const doc = op && op.doc;
    if (typeof doc !== "object" || doc === null || !Array.isArray(doc.nodes)) return jsonResponse({ error: "bad-input" }, 400);
    await kv.put(key, JSON.stringify(doc));
    return jsonResponse({ ok: true });
  }
  return jsonResponse({ error: "method-not-allowed" }, 405);
}

// ---- Canvas board images (/__asset) -----------------------------------------
// Pasted/dropped canvas images used to be inlined into the board doc as data URLs, which
// made every doc write (and every room seed) carry every image ever pasted. Now the client
// uploads the compressed JPEG once; we store it under its content hash (immutable, so the
// browser caches it forever) and the doc carries only the tiny /__asset/<hash> URL.
// Old boards with inline data URLs still render — <img src> takes either form.
const ASSET_PREFIX = "basset:";
const ASSET_MAX_BYTES = 4 * 1024 * 1024; // client compresses to ~<1MB; hard stop well below that x4
async function assetApi(request, url, env) {
  const kv = kvFor(env);
  if (!kv) return jsonResponse({ error: "no-kv-binding" }, 503);
  if (request.method === "POST" && url.pathname === "/__asset") {
    const ct = (request.headers.get("content-type") || "").toLowerCase().split(";")[0].trim();
    if (!/^image\/(jpeg|png|webp|gif)$/.test(ct)) return jsonResponse({ error: "bad-type" }, 415);
    const buf = await request.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > ASSET_MAX_BYTES) return jsonResponse({ error: "too-large" }, 413);
    const digest = await crypto.subtle.digest("SHA-256", buf);
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
    const key = ASSET_PREFIX + hash;
    // content-addressed → a re-paste of the same image is free (skip the duplicate write)
    if ((await kv.get(key, { type: "arrayBuffer" })) === null) {
      await kv.put(key, buf, { metadata: { ct } });
    }
    return jsonResponse({ url: "/__asset/" + hash });
  }
  if (request.method === "GET") {
    const hash = url.pathname.slice("/__asset/".length);
    if (!/^[0-9a-f]{40}$/.test(hash)) return jsonResponse({ error: "bad-input" }, 400);
    const got = await kv.getWithMetadata(ASSET_PREFIX + hash, { type: "arrayBuffer" });
    if (!got || !got.value) return jsonResponse({ error: "not-found" }, 404);
    return new Response(got.value, {
      headers: {
        "content-type": (got.metadata && got.metadata.ct) || "image/jpeg",
        // content-hashed = immutable: one KV read per browser, ever
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  }
  return jsonResponse({ error: "method-not-allowed" }, 405);
}

// ---- Canvas multiplayer proxy (/__rt → the instance's realtime worker) ------
// The BoardRoom Durable Objects live in a SEPARATE worker (Pages can't define DO
// classes), deployed from realtime/ — one PER INSTANCE, each with its own name and
// its own board KV binding, or rooms (keyed by board path) and board docs would be
// shared across instances. Proxying keeps the client same-origin (no hardcoded
// workers.dev URL in canvas.js, works offline too); fetch() with the Upgrade header
// intact returns the 101 + socket, passed through. Injected at build from the deploy
// config's `realtimeOrigin`; without one, boards run solo (the client's socket-down
// fallback: it persists via /__board to this instance's own KV).
let RT_ORIGIN = "";
function rtProxy(request, url) {
  if (!RT_ORIGIN) return jsonResponse({ error: "realtime-not-configured" }, 501);
  if (request.headers.get("Upgrade") !== "websocket") return jsonResponse({ error: "expected-websocket" }, 426);
  return fetch(RT_ORIGIN + "/room" + url.search, request);
}

// ---- Admin: users + passwords (KV-backed overrides) -------------------------
// Admin-only. GET returns every user with their EFFECTIVE password (override ?? seed)
// so the admin can read them; POST { email, pass } sets an override in KV. Identity
// (name/email/role) stays in the committed identity.json — only passwords are mutable
// here. me is the already-resolved caller; the router guards the route, we re-check.
async function adminUsersApi(request, url, env, me) {
  if (!me || me.role !== "admin") return jsonResponse({ error: "forbidden" }, 403);
  const kv = kvFor(env);

  if (request.method === "GET") {
    const users = [];
    for (const u of USERS) {
      let lastSeen = null;
      try { lastSeen = kv ? await kv.get(LASTSEEN_PREFIX + u.email) : null; } catch (e) {}
      users.push({
        email: u.email, name: u.name, role: u.role || "user",
        initials: u.initials || "", color: u.color || "#4f46e5",
        avatar: avatarUrl(u),
        pass: await effectivePass(env, u),
        lastSeen,
      });
    }
    return jsonResponse({ users });
  }
  if (request.method === "POST") {
    let op;
    try { op = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    const u = userByEmail(op && op.email);
    if (!u) return jsonResponse({ error: "unknown-user" }, 400);
    const pass = clamp(op && op.pass, 200);
    if (!pass) return jsonResponse({ error: "empty-pass" }, 400);
    if (!kv) return jsonResponse({ error: "no-kv-binding" }, 500);
    const raw = await kv.get(USER_SECRETS_KEY);
    const ov = raw ? JSON.parse(raw) : {};
    ov[u.email] = pass;
    await kv.put(USER_SECRETS_KEY, JSON.stringify(ov));
    return jsonResponse({ ok: true, email: u.email });
  }
  return jsonResponse({ error: "method-not-allowed" }, 405);
}

// /__review/api/export?key=<REVIEW_EXPORT_KEY> — all comment threads.
// Secret-guarded so tooling can read review data WITHOUT the site password.
//   GET  → { pages, generatedAt }
//   POST → apply a moderation op ({ path, op:"resolve"|"delete", id, resolved })
//          to one page's threads and return that page's updated threads. This lets
//          CLI tooling resolve/close threads without the site password.
async function reviewExport(request, url, env) {
  const secret = env.REVIEW_EXPORT_KEY;
  if (!secret) return jsonResponse({ error: "export-disabled" }, 404);
  const given = url.searchParams.get("key") || request.headers.get("X-Review-Key") || "";
  if (given.length !== secret.length || given !== secret) {
    return jsonResponse({ error: "forbidden" }, 403);
  }
  const kv = kvFor(env);
  if (!kv) return jsonResponse({ pages: {}, warning: "no-kv-binding" });

  if (request.method === "POST") {
    let op;
    try { op = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    const path = clamp(op && op.path, 600);
    if (!path) return jsonResponse({ error: "missing-path" }, 400);
    const key = "c:" + path;
    const raw = await kv.get(key);
    let threads = raw ? JSON.parse(raw) : [];
    threads = applyOp(threads, op);
    await kv.put(key, JSON.stringify(threads));
    return jsonResponse({ path, threads });
  }

  const pages = {};
  let cursor;
  do {
    const list = await kv.list({ prefix: "c:", cursor });
    for (const k of list.keys) {
      const raw = await kv.get(k.name);
      pages[k.name.slice(2)] = raw ? JSON.parse(raw) : [];
    }
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);
  return jsonResponse({ pages, generatedAt: new Date().toISOString() });
}

// ---- Piti live channel (KV) — the cursor companion's agent bridge ----------
// Self-contained easter egg (see pitis/). A terminal "piti" agent watches which
// prototype you're on and posts short UX/a11y remarks the on-screen cat delivers.
// Two single keys, same frugal one-get/one-put pattern as pins/status:
//   pt:view    -> { path, screen, w, h, ts }        (browser publishes what it's on)
//   pt:remarks -> [ { id, path, text, kind, sel, x, y, w, h, ts }, … ]  (agent → cat)
// Browser-facing ops are OPEN (public prototypes carry no cookie); the two agent
// ops — READ the view, WRITE a remark — reuse the REVIEW_EXPORT_KEY secret (so there
// is no new secret to provision). id = Date.now() so ids never repeat across agent
// sessions (a cleared queue can't collide with the client's last-seen id). Single
// writer (one agent) => the read-modify-write on pt:remarks can't race in practice;
// remarks older than 3 min are pruned on every write and the list is capped.
const PITI_VIEW_KEY = "pt:view";
const PITI_REMARKS_KEY = "pt:remarks";

async function pitiApi(request, url, env) {
  const kv = kvFor(env);
  if (!kv) return jsonResponse({ warning: "no-kv-binding" });
  const secret = env.REVIEW_EXPORT_KEY;
  const given = url.searchParams.get("key") || request.headers.get("X-Review-Key") || "";
  const authed = !!secret && given.length === secret.length && given === secret;

  if (request.method === "GET") {
    // Agent reads what the user is looking at (secret-guarded — it's a peek at activity).
    if (url.searchParams.get("type") === "view") {
      if (!authed) return jsonResponse({ error: "forbidden" }, 403);
      const raw = await kv.get(PITI_VIEW_KEY);
      return jsonResponse({ view: raw ? JSON.parse(raw) : null });
    }
    // Browser polls the quips queued for its page (open). since=<last id seen>.
    const path = clamp(url.searchParams.get("path") || "/", 600);
    const since = Number(url.searchParams.get("since")) || 0;
    const raw = await kv.get(PITI_REMARKS_KEY);
    const all = raw ? JSON.parse(raw) : [];
    return jsonResponse({ remarks: all.filter((r) => r.path === path && r.id > since) });
  }

  if (request.method === "POST") {
    let body;
    try { body = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }

    // Browser publishes its current screen (open — a spoof just makes the cat comment
    // on a different path, harmless on a private easter egg).
    if (body && body.type === "view") {
      const view = {
        path: clamp(body.path, 600),
        screen: clamp(body.screen, 200),
        w: Math.max(0, Math.min(8000, Number(body.w) || 0)),
        h: Math.max(0, Math.min(8000, Number(body.h) || 0)),
        ts: Date.now(),
      };
      if (!view.path) return jsonResponse({ error: "bad-input" }, 400);
      await kv.put(PITI_VIEW_KEY, JSON.stringify(view));
      return jsonResponse({ ok: true });
    }

    // Agent posts a quip for the cat to deliver (secret-guarded so only the wingman,
    // never a random visitor, can put words in the cat's mouth).
    if (body && body.type === "remark") {
      if (!authed) return jsonResponse({ error: "forbidden" }, 403);
      const path = clamp(body.path, 600);
      const text = clamp(body.text, 220);
      if (!path || !text) return jsonResponse({ error: "bad-input" }, 400);
      const raw = await kv.get(PITI_REMARKS_KEY);
      let all = raw ? JSON.parse(raw) : [];
      const cutoff = Date.now() - 3 * 60 * 1000;
      all = all.filter((r) => r.ts > cutoff); // prune stale before appending
      const num = (v, lo, hi) => (v == null || v === "" ? null : Math.max(lo, Math.min(hi, Number(v))));
      all.push({
        id: Date.now(),
        path,
        text,
        kind: clamp(body.kind, 24) || "ux",
        sel: clamp(body.sel, 400),
        x: num(body.x, 0, 20000),
        y: num(body.y, 0, 20000),
        w: num(body.w, 0, 8000),
        h: num(body.h, 0, 8000),
        ts: Date.now(),
      });
      if (all.length > 24) all = all.slice(-24);
      await kv.put(PITI_REMARKS_KEY, JSON.stringify(all));
      return jsonResponse({ ok: true, id: all[all.length - 1].id });
    }

    // Agent wipes the queue at the start of a fresh wingman session (secret-guarded).
    if (body && body.type === "clear") {
      if (!authed) return jsonResponse({ error: "forbidden" }, 403);
      await kv.put(PITI_REMARKS_KEY, JSON.stringify([]));
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ error: "bad-input" }, 400);
  }
  return jsonResponse({ error: "method-not-allowed" }, 405);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Runtime config is data served alongside the assets, for the worker's own
    // reads only — instance.json carries the user list. Reject external requests
    // BEFORE any asset serving, unconditionally (even in open/legacy mode).
    if (url.pathname === "/__config" || url.pathname.startsWith("/__config/")) {
      return notFoundResponse();
    }
    await loadConfig(env);

    // Direct-publish API — self-authed (bearer tokens), before the gate like
    // the other tooling routes.
    if (url.pathname.startsWith("/__publish/")) return publishApi(request, url, env);

    // In bundle mode the public build stamp is synthesized from the live
    // manifests — same shape and contract as the static file Pages serves.
    if (url.pathname === "/_build.json" && bundleMode(env)) {
      return jsonResponse(synthBuildStamp(await loadManifests(env)));
    }

    // Vanity domains (from the deploy config): a host CNAME'd to this
    // Pages project + added as a custom domain runs this worker. DNS can't target
    // a path, so land each such host's root on its configured page. Scoped to the
    // exact hosts in the map — never affects pages.dev or any other domain.
    const vanityPath = VANITY_REDIRECTS[url.hostname];
    if (vanityPath && (url.pathname === "/" || url.pathname === "")) {
      return Response.redirect(`https://${url.hostname}${vanityPath}`, 302);
    }

    // Blanket "don't crawl anything" — the public prototypes are for link-sharing,
    // not search discovery, and the rest is password-gated. Served openly so robots
    // can actually read it (a gated robots.txt would just return the login page).
    if (url.pathname === "/robots.txt") {
      return new Response("User-agent: *\nDisallow: /\n", {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    // Live-reload version probe — every page polls this with its own ?path=, and
    // gets back that path's version (versionFor); no ?path → BUILD_ID. Public (before
    // the gate) so public prototypes can poll it too; no-store so the id is never stale.
    if (url.pathname === "/__version") {
      const p = url.searchParams.get("path");
      return new Response(p ? versionFor(p) : BUILD_ID, {
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    // Review export bypasses the password gate (its own secret guards it).
    if (url.pathname === "/__review/api/export") return reviewExport(request, url, env);

    // Piti live channel bypasses the gate too: the cat lives on PUBLIC prototypes
    // (no cookie), so browser reads/view-writes are open; agent ops self-guard with
    // the export secret. Same early-exit shape as /__version and the review export.
    if (url.pathname === "/__piti") return pitiApi(request, url, env);

    // Platform MCP proxy — public prototypes call the platform through their own
    // origin (the platform's Bearer token is the real auth; see mcpProxy).
    if (url.pathname.startsWith("/__mcp/")) return mcpProxy(request, url);

    const expected = env.SITE_PASSWORD;
    const usersActive = USERS.length > 0;
    // Resolve identity once (identity mode); null in legacy/open mode.
    const me = usersActive ? await identify(request, env) : null;
    // Is this request past the gate? identity mode → a known user; legacy → the
    // shared-password cookie; neither configured → open (raw/local build, no gate).
    let authed;
    if (usersActive) authed = !!me;
    else if (expected) {
      const token = await tokenFor(expected);
      const cookies = request.headers.get("Cookie") || "";
      authed = cookies.split(/;\s*/).some((c) => c === `${COOKIE}=${token}`);
    } else authed = true;

    // AI document summarizer — PUBLIC (not gated). The Project Builder prototype
    // that calls this ships to /playground/ and is publicly reachable (customer
    // demos, shared links — the viewer is never logged in), so gating this behind
    // the login left the doc-upload flow 401ing for everyone but a signed-in admin.
    // It spends Anthropic tokens, but the handler is self-limiting: POST-only, input
    // capped at 60k chars, output bounded by the schema. 503 when unconfigured →
    // the prototype falls back to its local heuristic.
    if (url.pathname === "/__ai/summarize") {
      return aiSummarize(request, env);
    }

    // Who am I — the sidebar profile chip and the comment overlay read this. Open
    // (returns {user:null} when signed out) so the chip can decide what to render.
    // Doubles as the "last seen" heartbeat: it fires once per page view.
    // `accounts` tells a client whether this deployment HAS user accounts at all, so
    // {user:null} can be read correctly: signed out (accounts:true) vs an instance
    // with no user list, where everyone is the operator (accounts:false).
    if (url.pathname === "/__me") {
      if (me && ctx && ctx.waitUntil) ctx.waitUntil(touchLastSeen(env, me));
      return jsonResponse({ user: publicUser(me), accounts: usersActive });
    }

    // A user's avatar image, decoded from the identity list's data URI. Deliberately
    // ungated: presence chips on PUBLIC boards render it for everyone in the room.
    if (url.pathname.startsWith("/__avatar/")) {
      const key = url.pathname.slice("/__avatar/".length);
      const u = USERS.find((x) => x.avatar && x.avatar.startsWith("data:") && avatarKey(x) === key);
      const m = u && /^data:([^;,]+);base64,(.*)$/.exec(u.avatar);
      if (!m) return new Response("Not found", { status: 404 });
      const bin = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
      return new Response(bin, {
        headers: {
          "Content-Type": m[1],
          "Cache-Control": "public, max-age=31536000, immutable",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    // Sign out — clear the identity cookie and bounce home.
    if (url.pathname === "/__logout") {
      return new Response(null, {
        status: 303,
        headers: {
          Location: "/",
          "Set-Cookie": `${USER_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
          "Cache-Control": "no-store",
        },
      });
    }

    // Admin users/passwords API — admin-only (adminUsersApi re-checks me.role).
    if (url.pathname === "/__admin/users") return adminUsersApi(request, url, env, me);

    // Admin publish-token API — mint/list/revoke per-space publish tokens.
    if (url.pathname === "/__admin/tokens") return adminTokensApi(request, env, me);

    // Admin bundle-store gauge — bytes/objects vs the free-tier ceiling.
    if (url.pathname === "/__admin/storage") return adminStorageApi(env, me);

    // Engine version + update-available nudge (the profile chip's fetch).
    if (url.pathname === "/__admin/version") return adminVersionApi(env, me);

    // Login form submission.
    if (request.method === "POST" && url.pathname === "/__auth") {
      const form = await request.formData();
      const requested = (form.get("redirect") || "/").toString();
      const redirect = requested.startsWith("/") ? requested : "/"; // avoid open redirect
      if (usersActive) {
        const u = userByEmail(form.get("email"));
        const pass = (form.get("password") || "").toString();
        const real = u ? await effectivePass(env, u) : "";
        if (u && real && pass.length === real.length && pass === real) {
          const token = await userToken(env, u);
          if (ctx && ctx.waitUntil) ctx.waitUntil(touchLastSeen(env, u));
          return new Response(null, {
            status: 303,
            headers: {
              Location: redirect,
              "Set-Cookie": `${USER_COOKIE}=${u.email}.${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`,
              "Cache-Control": "no-store",
            },
          });
        }
        return htmlResponse(loginPage(redirect, true), 401);
      }
      // Legacy shared-password mode (no identity injected).
      const pass = (form.get("password") || "").toString();
      if (expected && pass.length === expected.length && pass === expected) {
        const token = await tokenFor(expected);
        return new Response(null, {
          status: 303,
          headers: {
            Location: redirect,
            "Set-Cookie": `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`,
            "Cache-Control": "no-store",
          },
        });
      }
      return htmlResponse(loginPage(redirect, true), 401);
    }

    // Comments: fully OPEN (reads and writes) so devs who only have the public
    // prototype link — no login — can leave feedback that syncs to KV. Obscure
    // share links, not public discovery; applyOp already clamps/caps every field.
    if (url.pathname === "/__review/api") return reviewApi(request, url, env);

    // Overlay APIs — gated by the same rule as the site (open in legacy no-gate mode
    // so raw/local builds keep working). Pins are scoped to the signed-in user.
    if (url.pathname === "/__status") {
      if (!authed) return jsonResponse({ error: "unauthorized" }, 401);
      return statusApi(request, url, env);
    }
    if (url.pathname === "/__pins") {
      if (!authed) return jsonResponse({ error: "unauthorized" }, 401);
      return pinsApi(request, url, env, me);
    }
    if (url.pathname === "/__name") {
      if (!authed) return jsonResponse({ error: "unauthorized" }, 401);
      return nameApi(request, url, env);
    }
    // The shipped space list (id/name/badge/base/adminOnly) for shell UI — gated
    // like the rail pages that render it (space names are internal until shipped
    // somewhere public on purpose).
    if (url.pathname === "/__spaces") {
      if (!authed) return jsonResponse({ error: "unauthorized" }, 401);
      return jsonResponse({ spaces: SPACES });
    }
    // Created-canvases registry — gated like /__status: any signed-in user (or anyone,
    // in legacy/open mode) can create/rename/remove a board. The board PAGES it
    // registers are public (served past the gate in the fetch fallthrough below).
    if (url.pathname === "/__canvases") {
      if (!authed) return jsonResponse({ error: "unauthorized" }, 401);
      return canvasesApi(request, url, env, me);
    }
    // Prototype deletion — DESTRUCTIVE (repo write). Admin-only in identity mode; in
    // legacy/open mode any authed operator (a single-operator instance has no roles).
    if (url.pathname === "/__delete") {
      if (!authed) return jsonResponse({ error: "unauthorized" }, 401);
      if (usersActive && (!me || me.role !== "admin")) return jsonResponse({ error: "forbidden" }, 403);
      return deleteApi(request, env, me);
    }
    // Canvas board docs follow the COMMENTS model, not the status/pins model: a canvas is a
    // PUBLISHED prototype (public, obscure share link), so its board must load & save without a
    // login, exactly like /__review/api. Writes are full-state but size-capped in boardApi.
    if (url.pathname === "/__board") return boardApi(request, url, env);
    // Board images live OUTSIDE the doc (content-hashed, immutable) — same public model as
    // /__board: the hash is the credential. See assetApi.
    if (url.pathname.startsWith("/__asset")) return assetApi(request, url, env);
    // Canvas multiplayer: same-origin WebSocket proxied to the augur-realtime worker (one
    // BoardRoom Durable Object per board path — cursors/presence/live ops). Public like
    // /__board: the board is the credential. The engine degrades to solo if this fails.
    if (url.pathname === "/__rt") return rtProxy(request, url);

    // Admin-only spaces: seal the whole base path BEFORE the public-prototype
    // door, so nothing under it — not even an og.jpg — leaks. Only an admin
    // gets through; a signed-in non-admin is bounced home; a signed-out
    // visitor gets the login page. Skipped in legacy/open mode
    // (no users injected), same as the /admin gate.
    if (usersActive && isRestrictedPath(url.pathname)) {
      if (!authed) return htmlResponse(loginPage(url.pathname + url.search, false), 200);
      if (!me || me.role !== "admin") return Response.redirect(new URL("/", url).toString(), 303);
    }

    // Published prototypes are public — never gated, regardless of the cookie.
    // The open door is for easy link-sharing, NOT public discovery, so tag every
    // public response as non-indexable (covers HTML and assets alike).
    if (isPublicPath(url.pathname)) {
      const asset = await assetFetch(env, request);
      if (asset.status === 404) return notFoundResponse();
      const res = withAssetCache(withLiveReload(asset, url), url);
      const out = new Response(res.body, res);
      out.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
      return out;
    }

    // Admin pages (/admin/…): require an admin user. A signed-out visitor gets the
    // login page; a signed-in non-admin is bounced home.
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      if (!authed) return htmlResponse(loginPage(url.pathname + url.search, false), 200);
      if (usersActive && (!me || me.role !== "admin")) return Response.redirect(new URL("/", url).toString(), 303);
      const asset = await assetFetch(env, request);
      if (asset.status === 404) return notFoundResponse();
      return withAssetCache(withLiveReload(asset, url), url);
    }

    // Past the gate (or nothing gates the site) → serve. A 404 gets one more chance
    // as a created canvas (a KV-registered board with no repo file — see canvasesApi).
    if (authed) {
      const asset = await assetFetch(env, request);
      if (asset.status === 404) {
        const virt = await virtualCanvas(request, env, url);
        if (virt) return virt;
        return notFoundResponse();
      }
      return withAssetCache(withLiveReload(asset, url), url);
    }

    // Created canvas boards are public like published prototypes — same obscure
    // share-link model (the /__board doc and /__rt room were already open; only the
    // loader page was gated). Checked only after every other door failed, so the KV
    // read never taxes normal traffic. Boards under an admin-only space never reach
    // here — isRestrictedPath sealed them above.
    const virt = await virtualCanvas(request, env, url);
    if (virt) return virt;

    // Otherwise show the login page, remembering where they were headed.
    // 200 (not 401) so password managers treat it as a normal login page.
    return htmlResponse(loginPage(url.pathname + url.search, false), 200);
  },
};
