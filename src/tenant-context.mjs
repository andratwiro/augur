// The tenant context — the value that replaces the worker's module-scope config
// globals.
//
// WHAT THIS IS FOR. `src/_worker.js` fills ~28 `let` globals once per isolate from
// instance.json / routing.json and reads them implicitly at ~110 sites. That shape is
// single-tenant by construction: a second workspace resolved in the same isolate would
// overwrite the first one's config, and whichever request read it next would answer with
// the wrong workspace's users, prefixes and gate. Phase A replaces those globals with one
// value built per request and passed down. This module owns that value's SHAPE; the
// worker keeps owning what goes in it.
//
// THREE PROPERTIES, EACH LOAD-BEARING.
//
// 1. Field names are EXACTLY the current global names. The threading sweep is then a
//    mechanical rename at each read site (`USERS` -> `ctx.USERS`) rather than a rewrite,
//    which is what lets the byte-level response snapshots prove it an observable no-op.
//    Renaming to something tidier would hide real changes inside cosmetic ones.
//
// 2. Every default is a FACTORY, never a value. This is the whole point of the file. A
//    shared `new Set()` sitting in a defaults object would be handed to every tenant, and
//    one workspace adding an icon hash would add it for all of them — the precise leak
//    this phase exists to close, reintroduced in the fix for it. `defaults()` therefore
//    calls each factory per context. The test suite asserts two contexts share no
//    reference.
//
// 3. `CONFIG_LOADED` defaults to FALSE, and only a genuinely applied instance document
//    sets it true. The gate uses it to tell "raw build with no identity, open by design"
//    from "deployment whose config has not loaded in this cold isolate, must fail
//    closed". A context that defaulted to loaded-but-empty would open the gate on a cold
//    isolate whose first config read failed. Of everything in this file, this is the one
//    that must never regress.
//
// The context carries no methods. `isPublicPath` and friends stay free functions taking a
// context, so each call site is a parameter change and nothing else — behaviour must not
// ride along on a mechanical refactor.

// Every field, its default factory, and where its value comes from. This table is the
// single description of the shape: add a config global to the worker and it belongs here,
// or the sweep will thread ~110 sites and silently miss one.
//
// `instance`  filled from instance.json (bundle: config/instance.json in the store)
// `routing`   filled from routing.json, or derived from live manifests in bundle mode
// `derived`   computed from another field rather than read from a document
// `runtime`   set by the worker as it serves, not by a config document
const FIELDS = Object.freeze({
  // ---- identity ----------------------------------------------------------------
  CONFIG_USERS:            { source: "instance", make: () => [] },
  USERS:                   { source: "derived",  make: () => [] }, // CONFIG_USERS + KV roster overlay
  // The photo hashes this workspace's avatar index vouches for. `/__avatar/` is ungated,
  // so this Set is what it checks BEFORE reading KV — an authorization list, not a memo,
  // and derived from one workspace's roster. Same shape and same reason as
  // SPACE_ICON_KEYS below.
  AVATAR_KEYS:             { source: "derived",  make: () => new Set() },
  CONFIG_LOADED:           { source: "runtime",  make: () => false },

  // ---- gate / routing ----------------------------------------------------------
  PUBLIC_PREFIXES:         { source: "routing",  make: () => [] },
  PUBLIC_SKILL_PREFIXES:   { source: "routing",  make: () => [] },
  RESTRICTED_BASES:        { source: "routing",  make: () => [] }, // permanently empty since the space tier retired
  SPACES:                  { source: "routing",  make: () => [] },
  VERSION_MAP:             { source: "routing",  make: () => ({}) },
  BUILD_ID:                { source: "routing",  make: () => "dev" },

  // ---- chrome ------------------------------------------------------------------
  CHROME_POINTER:          { source: "routing",  make: () => null },
  RUNTIME_CHROME:          { source: "routing",  make: () => false },

  // ---- workspace icons ---------------------------------------------------------
  SPACE_ICON_KEYS:         { source: "derived",  make: () => new Set() },
  SPACE_ICONS:             { source: "routing",  make: () => ({}) },

  // ---- MCP proxy ---------------------------------------------------------------
  MCP_HOST_SUFFIXES:       { source: "instance", make: () => [] },
  MCP_HOST_ALLOWLIST:      { source: "routing",  make: () => [] },
  MCP_HOST_ALLOWLIST_URL:  { source: "instance", make: () => "" },
  mcpStaticHosts:          { source: "derived",  make: () => new Set() }, // Set(MCP_HOST_ALLOWLIST)
  MCP_PATH_ALLOWLIST:      { source: "routing",  make: () => [] }, // paths the spaces declared, on top of the protocol's own

  // ---- canvas ------------------------------------------------------------------
  CANVAS_LOADER_EXTRAS:    { source: "routing",  make: () => "" },
  CANVAS_CATALOG:          { source: "routing",  make: () => [] },
  CANVAS_TRACKS:           { source: "routing",  make: () => [] },

  // ---- instance knobs ----------------------------------------------------------
  VANITY_REDIRECTS:        { source: "instance", make: () => ({}) },
  RT_ORIGIN:               { source: "instance", make: () => "" },
  INSTANCE_SENTINELS:      { source: "instance", make: () => [] },
  MIN_CLIENT_PROTOCOL:     { source: "instance", make: () => 0 },
  LOGIN_HINT:              { source: "instance", make: () => "" },
  LOGIN_PREFILL_EMAIL:     { source: "instance", make: () => "" },
  LOGIN_PREFILL_PASSWORD:  { source: "instance", make: () => "" },
  INSTANCE_ENGINE_VERSION: { source: "instance", make: () => "" },
  UPDATE_FEED:             { source: "instance", make: () => "" },
  // Whether this instance accepts user-supplied IMAGE BYTES at all (profile photos and
  // canvas images). Defaults to true: every existing instance keeps working, and the one
  // that turns it off is the one whose password is printed on its own login page.
  USER_IMAGES:             { source: "instance", make: () => true },
  // Device pairing (`augur connect`). Defaults OFF, which is the opposite default from
  // USER_IMAGES above and deliberately so: this one ADDS an unauthenticated endpoint that
  // ends in a publish token, so an instance opts in rather than discovers it.
  DEVICE_PAIRING:          { source: "instance", make: () => false },
  // How long a publish token minted for a PERSON lives, in days. Both human doors —
  // `augur login` and `augur connect` — read this one number, because two doors that hand
  // out the same credential with different lifetimes is a difference nobody chose.
  // Tokens an admin mints by hand for a machine are not covered: nothing re-runs a login
  // for a nightly backup, and an expiry there fails silently at 4am. 0 disables expiry.
  PUBLISH_TOKEN_TTL_DAYS:  { source: "instance", make: () => 30 },
});

export const TENANT_FIELD_NAMES = Object.freeze(Object.keys(FIELDS));
export const TENANT_FIELD_SOURCES = Object.freeze(
  Object.fromEntries(Object.entries(FIELDS).map(([k, v]) => [k, v.source])),
);

// ⏳ DEPRECATION WINDOW — the path floor an engine that predates path declarations had.
//
// Until the engine learned that a workspace declares its own proxy paths, the floor was
// four fixed paths: the three the MCP/OAuth protocol speaks, plus one platform API
// endpoint that sat in the shared engine because a single prototype called it. Removing
// the fourth is right, and it is what `MCP_PROXY_PATHS` now says. But the declaration
// that replaces it is written INTO A MANIFEST AT PUBLISH TIME, by the clone that
// publishes — so an instance whose live manifests were published by an older clone
// carries no declaration at all, and taking this engine would turn that endpoint's call
// into a 403 with no action available on the serving side to put it back.
//
// So the floor is kept for a manifest of that VINTAGE, and vintage is all it is keyed on:
// a routing fragment with NO `mcpPaths` key predates declarations and gets the old floor;
// a fragment carrying an EMPTY ARRAY is a real declaration meaning "no extra paths" and
// gets nothing. Absent and empty are different, and that difference is the whole shim.
// Nothing here names a company or reads a hostname — a vintage manifest of ANY workspace
// gets the same floor, which is exactly what those manifests were serving yesterday.
//
// This is the same shape as LEGACY_USER_COOKIES in src/_worker.js: read, never written.
// Every current build emits the key unconditionally (build.js writes `mcpPaths` into
// routing.json and into every per-space manifest fragment, `[]` when a workspace declares
// none), so a single publish from a current clone retires the shim for that workspace on
// its own, with nothing to migrate.
//
// TO DELETE IT: when every live instance's every space manifest carries an `mcpPaths` key
// — check the served fragment, `routing.mcpPaths`, per space, not a local build — remove
// this constant and the two ⏳ read sites that name it: `routingFields` below (assets
// mode) and `derivedRoutingFields` in src/_worker.js (bundle mode), plus the ⏳ note
// beside MCP_PROXY_PATHS that points here. The ⏳ cases in test/mcp-proxy-paths.test.mjs
// go in the same change. Nothing else refers to it.
export const LEGACY_MCP_PATH_FLOOR = Object.freeze(["/web_api/v1/app_configuration"]);

// Fresh defaults. Called per context so no two tenants share a mutable value — see
// property 2 at the top of this file.
function defaults() {
  const out = {};
  for (const name of TENANT_FIELD_NAMES) out[name] = FIELDS[name].make();
  return out;
}

// The context object itself is frozen: assigning `ctx.USERS = …` throws in the module's
// strict mode instead of silently rewriting one tenant's identity from another's request.
// The VALUES are not deep-frozen — code still sorts and rebuilds these arrays in place —
// so freezing here buys the reassignment guarantee, which is the one that was actually
// being violated by module-scope `let`.
function freeze(ctx) {
  return Object.freeze(ctx);
}

// The cold-isolate value: nothing loaded, gate must fail closed. `tenantId` is the
// workspace this context speaks for — statically resolved in Phase A, Host-resolved in
// Phase B.
export function emptyTenantContext(tenantId = null) {
  return freeze({ tenantId, ...defaults() });
}

// instance.json -> the fields it owns. Pure: it reads a document and returns a patch, so
// a malformed document can be rejected before anything is swapped in. Mirrors the
// worker's applyInstance() exactly, including its type coercions — a difference here is a
// behaviour change wearing a refactor's clothes.
export function instanceFields(inst) {
  const doc = inst && typeof inst === "object" ? inst : {};
  const prefill = doc.loginPrefill && typeof doc.loginPrefill === "object" ? doc.loginPrefill : {};
  return {
    CONFIG_USERS: Array.isArray(doc.users) ? doc.users : [],
    USERS: Array.isArray(doc.users) ? doc.users : [], // applyRoster overlays this next
    INSTANCE_ENGINE_VERSION: doc.engineVersion || "",
    UPDATE_FEED: doc.updateFeed || "",
    MCP_HOST_SUFFIXES: doc.mcpHostSuffixes || [],
    MCP_HOST_ALLOWLIST_URL: doc.mcpHostAllowlistUrl || "",
    VANITY_REDIRECTS: doc.vanityRedirects || {},
    RT_ORIGIN: doc.rtOrigin || "",
    INSTANCE_SENTINELS: Array.isArray(doc.sentinels) ? doc.sentinels : [],
    MIN_CLIENT_PROTOCOL:
      Number.isInteger(doc.minClientProtocol) && doc.minClientProtocol > 0 ? doc.minClientProtocol : 0,
    LOGIN_HINT: typeof doc.loginHint === "string" ? doc.loginHint : "",
    // Explicit `false` turns it off. Anything else — absent, null, a typo — leaves it ON,
    // because a config typo must not silently disable a feature every other instance
    // depends on. Turning it off is the deliberate act, so it is the one that must be
    // spelled correctly.
    USER_IMAGES: doc.userImages !== false,
    // Explicit `true` only — the inverse of USER_IMAGES, because the safe state here is
    // off and a typo must not switch a token-minting path on.
    DEVICE_PAIRING: doc.devicePairing === true,
    // A number, and only a number. A typo — a string, null, a negative — falls back to the
    // default rather than to "no expiry": a config mistake must not be the thing that
    // quietly returns publish tokens to living forever. An explicit 0 IS honoured, because
    // turning expiry off is a decision someone can legitimately make and has to spell.
    PUBLISH_TOKEN_TTL_DAYS:
      Number.isFinite(doc.publishTokenTtlDays) && doc.publishTokenTtlDays >= 0
        ? doc.publishTokenTtlDays : 30,
    LOGIN_PREFILL_EMAIL: typeof prefill.email === "string" ? prefill.email : "",
    LOGIN_PREFILL_PASSWORD: typeof prefill.password === "string" ? prefill.password : "",
    // An instance document was actually applied — the gate may now trust "no users" to
    // mean no users, rather than "not loaded yet".
    CONFIG_LOADED: true,
  };
}

// routing.json -> the fields it owns. Mirrors the worker's assets-mode routing block.
// `mcpStaticHosts` is derived here rather than at the read site so the two can never
// disagree about which hosts are allowed. `MCP_PATH_ALLOWLIST` needs no such twin: a
// workspace declares a handful of paths, not hundreds of hosts, so the read site scans
// the array itself and there is no second copy to fall out of step.
//
// ⏳ `mcpPaths` ABSENT is a routing.json older than path declarations, and keeps the old
// floor (LEGACY_MCP_PATH_FLOOR). `mcpPaths: []` is a declaration meaning none, and keeps
// nothing. Delete the conditional with the constant.
export function routingFields(routing) {
  const doc = routing && typeof routing === "object" ? routing : {};
  const allowlist = doc.mcpAllowlist || [];
  return {
    BUILD_ID: doc.buildId || "dev",
    VERSION_MAP: doc.versionMap || {},
    PUBLIC_PREFIXES: doc.publicPrefixes || [],
    PUBLIC_SKILL_PREFIXES: doc.publicSkillPrefixes || [],
    RESTRICTED_BASES: doc.restrictedBases || [],
    CANVAS_LOADER_EXTRAS: doc.canvasLoaderExtras || "",
    CANVAS_CATALOG: doc.canvasCatalog || [],
    CANVAS_TRACKS: doc.canvasTracks || [],
    MCP_HOST_ALLOWLIST: allowlist,
    mcpStaticHosts: new Set(allowlist),
    MCP_PATH_ALLOWLIST: Array.isArray(doc.mcpPaths) ? doc.mcpPaths : [...LEGACY_MCP_PATH_FLOOR],
    SPACES: Array.isArray(doc.spaces) ? doc.spaces : [],
    CHROME_POINTER: doc.chrome || null,
    RUNTIME_CHROME: !!doc.runtimeChrome,
  };
}

// Build a context from whatever documents actually parsed. A document that is absent or
// unparseable contributes NOTHING rather than clearing the fields it owns — the
// keep-last-good half of the worker's fail-open-stale cache, preserved. Pass only what
// loaded; the caller decides whether a failed read is worth swapping the cache for.
export function buildTenantContext(tenantId, { instance, routing } = {}) {
  const ctx = { tenantId, ...defaults() };
  if (instance) Object.assign(ctx, instanceFields(instance));
  if (routing) Object.assign(ctx, routingFields(routing));
  return freeze(ctx);
}

// Derive a new context from an existing one. The context is immutable, so every update —
// the KV roster overlay, a derived-routing rebuild — produces a fresh value rather than
// mutating a shared one. That is what makes "keep the last good config" a matter of not
// swapping a reference, instead of a half-applied object that a concurrent request can
// observe mid-write.
//
// Unknown field names throw. A typo would otherwise write a field nothing reads, and the
// symptom would be a config value that silently never takes effect.
export function withTenantFields(ctx, patch) {
  const next = { ...ctx };
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in FIELDS)) throw new Error(`withTenantFields: unknown field "${k}"`);
    next[k] = v;
  }
  return freeze(next);
}

// ---- the per-tenant context cache ---------------------------------------------------
//
// Replaces the worker's single `cfgAt` timestamp. One stamp for the whole isolate is
// fine while an isolate only ever serves one workspace; with two, the first workspace's
// load stamps the clock and the second is told its config is fresh when it has never
// been read at all. The cache is therefore keyed by tenant, and every semantic of the
// old single stamp is reproduced deliberately rather than reinvented:
//
//   STAMP-FIRST. `stamp()` is called BEFORE the async read, so a failing config read
//   retries on the next tick instead of every concurrent request stampeding the store.
//
//   KEEP-LAST-GOOD. `put()` is only called with a context that actually parsed. A failed
//   read simply never calls it, so the previous good context stays in place — the
//   fail-open-stale half of the old cache, preserved by leaving a reference alone rather
//   than by half-applying an object a concurrent request could observe mid-write.
//
//   FORCED. A write handler busts the cache (`cfgAt = 0` in ten places today) so its own
//   write is visible on the very next request. `bust()` is that, per tenant, and `due()`
//   reports `forced` for it. A cold tenant reports forced too, exactly as `!cfgAt` does
//   today. Note what forced is NOT for: a cache with its own longer clock does not ride
//   this flag, because a bust that reaches every workspace's cache is the coarse shape
//   the roster overlay was moved off (`ROSTER_OVERLAY` in src/_worker.js is keyed by
//   workspace and busted per workspace by the handler that wrote it).
//
// What is NEW, because one global stamp could not have the problem: the cache is BOUNDED.
// A worker serving many workspaces would otherwise hold every context it ever built for
// the isolate's lifetime. Eviction is safe in the direction that matters — an evicted
// tenant rebuilds from `emptyTenantContext`, whose CONFIG_LOADED is false, so the gate
// fails CLOSED while it reloads. Eviction can cost a config read; it can never open a door.

export const TENANT_CONTEXT_TTL_MS = 1500;
export const TENANT_CONTEXT_CACHE_MAX = 256;

export function createTenantContextCache(options = {}) {
  const ttlMs = options.ttlMs ?? TENANT_CONTEXT_TTL_MS;
  const max = options.max ?? TENANT_CONTEXT_CACHE_MAX;
  const now = options.now ?? (() => Date.now());
  // Insertion-ordered, so the oldest touched entry is the first key — the eviction victim.
  const entries = new Map(); // tenantId -> { at, ctx }

  const touch = (key, entry) => {
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > max) entries.delete(entries.keys().next().value);
  };

  return {
    // Should this tenant load its config now? `forced` means the cache was busted by a
    // write, or this tenant has never loaded — this tenant, never the isolate.
    due(tenantId) {
      const e = entries.get(tenantId);
      if (!e || !e.at) return { due: true, forced: true };
      return { due: now() - e.at >= ttlMs, forced: false };
    },

    // Mark the attempt BEFORE doing it. Never call this after a load — that is the
    // stampede the ordering exists to prevent.
    stamp(tenantId) {
      const e = entries.get(tenantId) || { at: 0, ctx: null };
      touch(tenantId, { at: now(), ctx: e.ctx });
    },

    // Only ever called with a context built from documents that actually parsed.
    put(tenantId, ctx) {
      const e = entries.get(tenantId);
      touch(tenantId, { at: e ? e.at : now(), ctx });
      return ctx;
    },

    // The last good context for this tenant, or null if it has none yet. A null answer
    // must become emptyTenantContext at the call site — never a shared fallback, and
    // never another tenant's.
    get(tenantId) {
      const e = entries.get(tenantId);
      return e && e.ctx ? e.ctx : null;
    },

    // A write handler making its own change visible on the next request. The context is
    // KEPT: busting asks for a re-read, it does not blank the gate in the meantime.
    bust(tenantId) {
      const e = entries.get(tenantId);
      if (e) entries.set(tenantId, { at: 0, ctx: e.ctx });
    },

    // Config that is not tenant-scoped changed (an engine or instance-wide push).
    bustAll() {
      for (const [k, e] of entries) entries.set(k, { at: 0, ctx: e.ctx });
    },

    get size() { return entries.size; },
    has(tenantId) { return entries.has(tenantId); },
  };
}
