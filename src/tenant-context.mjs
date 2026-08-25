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
const FIELDS = {
  // ---- identity ----------------------------------------------------------------
  CONFIG_USERS:            { source: "instance", make: () => [] },
  USERS:                   { source: "derived",  make: () => [] }, // CONFIG_USERS + KV roster overlay
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
};

export const TENANT_FIELD_NAMES = Object.freeze(Object.keys(FIELDS));
export const TENANT_FIELD_SOURCES = Object.freeze(
  Object.fromEntries(Object.entries(FIELDS).map(([k, v]) => [k, v.source])),
);

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
    LOGIN_PREFILL_EMAIL: typeof prefill.email === "string" ? prefill.email : "",
    LOGIN_PREFILL_PASSWORD: typeof prefill.password === "string" ? prefill.password : "",
    // An instance document was actually applied — the gate may now trust "no users" to
    // mean no users, rather than "not loaded yet".
    CONFIG_LOADED: true,
  };
}

// routing.json -> the fields it owns. Mirrors the worker's assets-mode routing block.
// `mcpStaticHosts` is derived here rather than at the read site so the two can never
// disagree about which hosts are allowed.
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
