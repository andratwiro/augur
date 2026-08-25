#!/usr/bin/env node
// no-tenant-globals — the ratchet that keeps per-tenant state out of module scope.
//
// WHY. `src/_worker.js` was written for one workspace per deployment, so it keeps its
// config in module-scope `let`s filled once per isolate. An isolate that serves two
// workspaces answers the second one with the first one's users, prefixes and gate. The
// fix is a per-request context (`src/tenant-context.mjs`), threaded through the read
// sites. That sweep takes many commits, and its dangerous failure is not a red test —
// it is one convenient new global added while the sweep is half done, which nothing in
// a single-tenant era can observe. This lint is what observes it.
//
// WHAT COUNTS AS A BINDING. Anything at column 0 of the worker that can hold state: a
// `let` or `var`, and a `const` whose initializer is a mutable container (array literal,
// object literal, `new Set/Map/WeakSet/WeakMap`). A `const` holding a number, a string,
// a regex or a function is not state and is not checked.
//
// TWO DIRECTIONS, BOTH FATAL.
//
//   UNLISTED  a binding ALLOWED has never heard of — someone added a global. Fail.
//   STALE     an ALLOWED entry with no binding left in the worker — the sweep removed
//             it. Its line goes with it, so the list SHRINKS as threading lands instead
//             of rotting into standing permission for whatever gets added later.
//
// Being on the list is a claim, in writing, about why that binding is safe to share
// between workspaces. Adding one is meant to be a deliberate, reviewed act.
//
// Usage: node scripts/no-tenant-globals.mjs [--worker <path>] [--quiet]
// No config, no dependencies. Exit 1 on any failure.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { TENANT_FIELD_NAMES } from "../src/tenant-context.mjs";

// ---- the allowlist ------------------------------------------------------------------
//
// Three kinds, and only two of them are meant to last.

// IN FLIGHT — tenant config that has NOT been threaded yet. These are not tenant-
// invariant; they are the bug this phase exists to remove, listed so the lint is green
// the day it lands and blocks only what is new. Every name here must also be a declared
// field of the tenant context (the lint checks that), and every name here must
// eventually leave: a thread-* commit deletes the `let` in the worker and the line here
// in the same change.
const IN_FLIGHT = {
  CONFIG_USERS:            "identity as written in instance.json — A-thread-identity",
  USERS:                   "identity with the KV roster overlaid — A-thread-identity",
  CONFIG_LOADED:           "the fail-closed cold-isolate flag; per-tenant by definition once an isolate serves two",
  PUBLIC_PREFIXES:         "gate exemptions from routing.json — A-thread-gate",
  PUBLIC_SKILL_PREFIXES:   "gate exemptions for skill assets — A-thread-gate",
  RESTRICTED_BASES:        "permanently empty since the path-mount tier retired; deleted outright, not threaded",
  SPACES:                  "the workspaces this deployment serves — A-thread-spaces-admin",
  VERSION_MAP:             "per-asset version stamps behind versionFor() — A-thread-gate",
  BUILD_ID:                "live-reload version fallback — A-thread-gate",
  CHROME_POINTER:          "which shared chrome bundle this deployment serves",
  RUNTIME_CHROME:          "whether chrome is composed at serve time for this deployment",
  SPACE_ICON_KEYS:         "the icon hashes the index vouches for — A-thread-spaces-admin",
  SPACE_ICONS:             "the last-read icon index — A-thread-spaces-admin",
  MCP_HOST_SUFFIXES:       "proxy host suffixes from instance.json — A-thread-mcp",
  MCP_HOST_ALLOWLIST:      "exact proxy hosts the spaces declared at build time — A-thread-mcp",
  MCP_HOST_ALLOWLIST_URL:  "where to fetch the remote proxy allowlist — A-thread-mcp",
  mcpStaticHosts:          "Set(MCP_HOST_ALLOWLIST), derived at config load — A-thread-mcp",
  CANVAS_LOADER_EXTRAS:    "extra scripts the virtual canvas loader injects — A-thread-canvas",
  CANVAS_CATALOG:          "the insert picker's aggregate — A-thread-canvas",
  CANVAS_TRACKS:           "the music aggregate — A-thread-canvas",
  VANITY_REDIRECTS:        "instance.json redirect table — A-thread-gate",
  RT_ORIGIN:               "the realtime worker this deployment proxies to — A-thread-canvas",
  INSTANCE_SENTINELS:      "publish unpublish-guard paths — A-thread-spaces-admin",
  MIN_CLIENT_PROTOCOL:     "the publish protocol floor this deployment demands",
  LOGIN_HINT:              "the line under the login form",
  LOGIN_PREFILL_EMAIL:     "demo credentials prefilled on the login form",
  LOGIN_PREFILL_PASSWORD:  "demo credentials prefilled on the login form",
  INSTANCE_ENGINE_VERSION: "the engine version the update nudge compares against — A-thread-spaces-admin",
  UPDATE_FEED:             "where the update nudge looks — A-thread-spaces-admin",
};

// CACHES — per-isolate memos and clocks. Sharing one between workspaces costs at worst a
// wasted read, never a wrong answer — EXCEPT where the reason below says otherwise, and
// those two are named as the work that fixes them.
const CACHES = {
  cfgAt:            "config TTL stamp; superseded per tenant by createTenantContextCache",
  TENANT_CTX:       "the last good context this isolate loaded, in ONE slot; like the globals it mirrors it would answer a second workspace with the first one's config, and the per-tenant createTenantContextCache is what replaces it when fetch() threads the context down",
  rosterReadAt:     "roster read clock; a stale stamp costs a re-read, and identify() still resolves per request",
  rosterCache:      "the last roster document read from KV; overlay only, never the auth boundary",
  MANIFESTS:        "content manifests keyed by space id INSIDE the value — A-thread-bundle-cache keys it by tenant",
  STORAGE_CACHE:    "the R2 fill gauge for the admin panel — A-thread-bundle-cache keys it by tenant",
  AVATAR_KEYS:      "hashes the avatar index vouches for; a hash is content-addressed, so it means the same thing everywhere",
  mcpHostAllowlist: "in-flight fetch of the remote proxy allowlist — A-thread-mcp makes it a Map keyed by tenant",
  canvasRegAt:      "canvas registry clock; a stale stamp costs a re-read",
  canvasRegRaw:     "the last canvas registry document read from KV",
  pitiRemarksAt:    "remark poll clock; a stale stamp costs a re-read",
  pitiRemarksRaw:   "the last remark document read from KV",
  tenantMemo:       "the static tenant id resolveTenant() read from instance.json; the ONE entry here that would be a wrong answer if an isolate served two workspaces, and the Host resolver that makes that possible replaces the body it belongs to",
};

// CONSTANTS — mutable containers written once at module load and never derived from any
// tenant's config. Tenant-invariant by construction. This is the only group that should
// still exist when the sweep is done.
const CONSTANTS = {
  ROLES:               "the fixed role vocabulary — admin, editor, viewer",
  AVATAR_MIMES:        "accepted avatar formats and their magic-byte tests; a file format is not a tenant property",
  ROSTER_COLORS:       "the presence-chip palette, indexed by a hash of the address",
  ENGINE_CHROME_PATHS: "the shared chrome paths no space may write; mirrors ENGINE_CHROME in build.js",
  MCP_PROXY_PATHS:     "the fixed paths the MCP and OAuth flows use",
  VALID_STATUS:        "the fixed prototype status vocabulary",
};

export const ALLOWED = Object.freeze({
  ...Object.fromEntries(Object.entries(IN_FLIGHT).map(([k, why]) => [k, { kind: "in-flight", why }])),
  ...Object.fromEntries(Object.entries(CACHES).map(([k, why]) => [k, { kind: "cache", why }])),
  ...Object.fromEntries(Object.entries(CONSTANTS).map(([k, why]) => [k, { kind: "constant", why }])),
});

// ---- the scan -----------------------------------------------------------------------

// A `const` initializer that can be written to after module load.
const CONTAINER = /^(\[|\{|new\s+(?:Set|Map|WeakSet|WeakMap)\b)/;
const DECL = /^(let|var|const)\s+([A-Za-z_$][\w$]*)\s*(?:=\s*(.*))?$/;
const DESTRUCTURE = /^(let|var|const)\s*[[{]/;

// Is there a comma outside every bracket and string on this line? `let A = [], B = [];`
// would otherwise hide B from the lint behind A's allowlist entry.
function hasTopLevelComma(line) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "/" && line[i + 1] === "/") break;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) return true;
  }
  return false;
}

// Every module-scope binding that can hold state. Column 0 is the whole test for "module
// scope": the worker's embedded client scripts live inside template literals and are all
// indented, so nothing nested is reachable from here.
export function moduleScopeBindings(source) {
  const out = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (DESTRUCTURE.test(line)) {
      out.push({ name: null, keyword: line.slice(0, 5).trim(), line: i + 1, destructured: true });
      continue;
    }
    const m = DECL.exec(line);
    if (!m) continue;
    const [, keyword, name, init = ""] = m;
    if (keyword === "const" && !CONTAINER.test(init)) continue;
    out.push({ name, keyword, line: i + 1, multi: hasTopLevelComma(line) });
  }
  return out;
}

// Returns every problem found, each as `{ kind, name, line, message }`. An empty list is
// the pass condition; the caller decides how to report.
export function checkWorkerGlobals(source) {
  const bindings = moduleScopeBindings(source);
  const problems = [];
  const seen = new Set();

  for (const b of bindings) {
    if (b.destructured) {
      problems.push({
        kind: "destructured", name: "(destructuring)", line: b.line,
        message: "module-scope destructuring hides the binding names from this lint — declare one named binding instead",
      });
      continue;
    }
    seen.add(b.name);
    if (b.keyword === "var") {
      problems.push({
        kind: "var", name: b.name, line: b.line,
        message: "`var` at module scope — use `let` (or thread it onto the tenant context)",
      });
    }
    if (b.multi) {
      problems.push({
        kind: "multi", name: b.name, line: b.line,
        message: "declares more than one binding on one line — split it so every global is named and accounted for",
      });
    }
    if (!ALLOWED[b.name]) {
      problems.push({
        kind: "unlisted", name: b.name, line: b.line,
        message:
          "new module-scope state. If it is tenant config, add it to FIELDS in src/tenant-context.mjs and thread it " +
          "rather than declaring it here. If it genuinely cannot vary between workspaces, add it to CONSTANTS (or " +
          "CACHES) in scripts/no-tenant-globals.mjs with the reason — that entry is the claim you are making",
      });
    }
  }

  for (const name of Object.keys(ALLOWED)) {
    if (seen.has(name)) continue;
    problems.push({
      kind: "stale", name, line: 0,
      message: "allowlisted but no longer declared in the worker — delete the entry so the list keeps shrinking",
    });
  }

  for (const [name, entry] of Object.entries(ALLOWED)) {
    if (entry.kind !== "in-flight" || TENANT_FIELD_NAMES.includes(name)) continue;
    problems.push({
      kind: "unfielded", name, line: 0,
      message: "listed as in-flight tenant config but is not a field of the tenant context — add it to FIELDS in src/tenant-context.mjs",
    });
  }

  return { bindings, problems };
}

// ---- CLI ----------------------------------------------------------------------------

function main(argv) {
  const opt = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i > -1 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const quiet = argv.includes("--quiet");
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const worker = path.resolve(opt("--worker", path.join(root, "src", "_worker.js")));

  const from = path.relative(process.cwd(), worker);
  const rel = !from || from.startsWith("..") ? worker : from;
  const { bindings, problems } = checkWorkerGlobals(fs.readFileSync(worker, "utf8"));

  if (problems.length) {
    for (const p of problems) {
      const where = p.line ? `${rel}:${p.line}` : rel;
      console.error(`${where}: ${p.name}: ${p.message}`);
    }
    console.error(`\n${problems.length} problem(s) — see the header of scripts/no-tenant-globals.mjs`);
    return 1;
  }

  if (!quiet) {
    const counts = { "in-flight": 0, cache: 0, constant: 0 };
    for (const b of bindings) counts[ALLOWED[b.name].kind]++;
    console.log(
      `${rel}: ${bindings.length} module-scope bindings, all accounted for — ` +
        `${counts["in-flight"]} tenant config still in flight, ${counts.cache} per-isolate caches, ` +
        `${counts.constant} tenant-invariant constants`,
    );
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
