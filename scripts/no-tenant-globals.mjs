#!/usr/bin/env node
// no-tenant-globals — the ratchet that keeps per-tenant state out of module scope.
//
// WHY. `src/_worker.js` was written for one workspace per deployment, so it kept its
// config in module-scope `let`s filled once per isolate. An isolate that serves two
// workspaces answers the second one with the first one's users, prefixes and gate. The
// fix is a per-request context (`src/tenant-context.mjs`), threaded through the read
// sites. That sweep is DONE — no field of the tenant context is declared at module scope
// any longer — and its dangerous failure was never a red test. It is one convenient new
// global, which nothing in a single-tenant era can observe: the deployment has one
// workspace, so a value shared between workspaces and a value belonging to the only
// workspace there is are the same bytes. This lint is what observes it, and it goes on
// mattering after the sweep because the next global costs nothing to add and gives back
// the bug in full.
//
// WHAT IT READS. Not one file — the whole module graph the worker pulls into the isolate,
// discovered by following relative imports from `src/_worker.js`. Module scope is per
// ISOLATE, so a `let` in a module the worker imports is shared exactly as widely as a
// `let` in the worker itself; a lint that read only the entry would be answered by moving
// the state one import away. Bare specifiers are not followed: a dependency's internals
// are not ours to allowlist, and this repo's worker has none.
//
// WHAT COUNTS AS A BINDING. Anything at column 0 of a scanned module that can hold state:
// a `let` or `var`, and a `const` whose initializer is a mutable container (array literal,
// object literal, `new Set/Map/WeakSet/WeakMap`) — with or without an `export` in front,
// since exporting state shares it no less. A `const` holding a number, a string, a regex
// or a function is not state and is not checked.
//
// FOUR DIRECTIONS, ALL FATAL.
//
//   UNLISTED   a binding the module's allowlist has never heard of — someone added a
//              global. Fail. A module with no section at all allows nothing, so a NEW
//              module carrying state fails on its first binding rather than on nobody
//              remembering to name it somewhere.
//   STALE      an allowlist entry with no binding left in its module — the sweep removed
//              it. Its line goes with it, so the list SHRINKS as threading lands instead
//              of rotting into standing permission for whatever gets added later.
//   UNREACHABLE an allowlisted module the worker no longer imports. Same rule one level
//              up: a section outlives its module otherwise.
//   READMITTED an allowlist entry that names a field of the tenant context. The sweep is
//              done, so the route back to a shared config global is not a new name but an
//              old one re-declared with a plausible reason attached. A per-workspace field
//              cannot be invariant, so the reason is refused unread.
//
// Being on the list is a claim, in writing, about why that binding is safe to share
// between workspaces. Adding one is meant to be a deliberate, reviewed act.
//
// Usage: node scripts/no-tenant-globals.mjs [--entry <path>] [--quiet]
// No config, no dependencies. Exit 1 on any failure.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { TENANT_FIELD_NAMES } from "../src/tenant-context.mjs";

export const ENTRY = "src/_worker.js";

// ---- the allowlist, per module -------------------------------------------------------
//
// TWO KINDS, and there is no third. There used to be an IN-FLIGHT kind holding the config
// globals the sweep had not reached yet; it is empty and gone. Not one field of the tenant
// context is declared at module scope any more, so a config global is now simply an
// UNLISTED binding and fails the build — which is the point of the whole phase, expressed
// as a lint rather than as a promise.
//
// CACHES — per-isolate memos and clocks. Sharing one between workspaces costs at worst a
// wasted read, never a wrong answer — EXCEPT where the reason says otherwise, and those
// are named as the work that fixes them.
//
// CONSTANTS — mutable containers written once at module load and never derived from any
// tenant's config. Tenant-invariant by construction.
//
// Keyed by module because a name is only invariant in the module that declares it: an
// entry vouching for `FIELDS` in the context module must not quietly vouch for a `FIELDS`
// somebody adds to the worker.
const ALLOWLIST = {
  "src/_worker.js": {
    caches: {
      cfgAt:            "config TTL stamp; superseded per tenant by createTenantContextCache",
      cfgGoodAt:        "when the config in the TENANT_CTX slot last loaded without a read failing — the staleness ceiling's clock; it is read only when the slot holds the workspace being asked about, so a second workspace finds no last-good and fails closed rather than inheriting this one's; goes into createTenantContextCache with TENANT_CTX",
      TENANT_CTX:       "the last good context this isolate loaded, in ONE slot; it would answer a second workspace with the first one's config, and the per-tenant createTenantContextCache is what replaces it when the resolver stops answering with one static id",
      rosterReadAt:     "roster read clock; a stale stamp costs a re-read, and identify() still resolves per request",
      rosterCache:      "the last roster document read from KV; overlay only, never the auth boundary",
      MANIFESTS:        "the live content manifests each workspace's store lists, KEYED BY WORKSPACE and bounded; the value IS one workspace's published content and its gate-deciding routing, so the key is what stops a neighbour's bytes answering at this workspace's URLs",
      STORAGE_CACHE:    "the R2 fill gauge the admin panel shows, KEYED BY WORKSPACE and bounded; the number measures one workspace's own store",
      mcpHostAllowlist: "the proxy host lists resolved from each workspace's published document, KEYED BY WORKSPACE and bounded; the value is derived from one workspace's config, so the key is what stops a neighbour answering from it",
      canvasRegAt:      "canvas registry clock; a stale stamp costs a re-read",
      canvasRegRaw:     "the last canvas registry document read from KV",
      pitiRemarksAt:    "remark poll clock; a stale stamp costs a re-read",
      pitiRemarksRaw:   "the last remark document read from KV",
      tenantMemo:       "the static tenant id resolveTenant() read from instance.json; the ONE entry here that would be a wrong answer if an isolate served two workspaces, and the Host resolver that makes that possible replaces the body it belongs to",
    },
    constants: {
      ROLES:               "the fixed role vocabulary — admin, editor, viewer",
      AVATAR_MIMES:        "accepted avatar formats and their magic-byte tests; a file format is not a tenant property",
      ROSTER_COLORS:       "the presence-chip palette, indexed by a hash of the address",
      ENGINE_CHROME_PATHS: "the shared chrome paths no space may write; mirrors ENGINE_CHROME in build.js",
      MCP_PROXY_PATHS:     "the fixed paths the MCP and OAuth flows use",
      VALID_STATUS:        "the fixed prototype status vocabulary",
      __testables:         "the table of pure helpers the suite imports; function references and fixed numbers, written once, and the request path reads none of it",
    },
  },

  "src/tenant-context.mjs": {
    constants: {
      FIELDS: "the context's SHAPE — every field, its source and its default FACTORY. It is a table of factories, never of values, so nothing a workspace owns is stored in it; two contexts built from it share no reference, which is the leak this whole module exists to close",
    },
  },

  "src/mail.mjs": {
    constants: {
      DRIVERS:   "the shapes of HTTP request each provider takes; a provider's API is not a workspace property, and every value a deployment supplies (endpoint, key, sender, region) arrives in env at call time",
      TEMPLATES: "the three message bodies, as render functions; the workspace's words arrive as vars per call",
      MAIL_RATE: "the per-recipient send caps; a fixed policy, and the counters it governs live in KV",
    },
  },

  "src/chrome/appchrome.mjs": {
    constants: {
      ACRONYMS: "words the title-caser must not sentence-case; a fact about English, not about a workspace",
      LIB_KEYS: "the fixed gallery tiers — tokens, base, components, patterns, pages, primitives",
    },
  },
};

// Flattened for the checker and for anything that wants to read the claims: module -> name
// -> { kind, why }.
export const ALLOWED = Object.freeze(
  Object.fromEntries(
    Object.entries(ALLOWLIST).map(([mod, groups]) => [
      mod,
      Object.freeze({
        ...Object.fromEntries(Object.entries(groups.caches || {}).map(([k, why]) => [k, { kind: "cache", why }])),
        ...Object.fromEntries(Object.entries(groups.constants || {}).map(([k, why]) => [k, { kind: "constant", why }])),
      }),
    ]),
  ),
);

// ---- the module graph ----------------------------------------------------------------

// A static import/export specifier, and a dynamic import of a literal. Only the relative
// ones matter: a bare specifier is a dependency, whose module scope is not ours to vouch
// for, and the worker has none.
const SPECIFIER = /(?:\b(?:import|export)\s[^;]*?\bfrom\s*|\bimport\s*\(\s*|^\s*import\s*)["']([^"']+)["']/gm;

const CANDIDATES = ["", ".mjs", ".js", "/index.mjs", "/index.js"];

// Resolution goes through the same `read` the scan uses — "does this file exist" is
// "can I read it" — so a test can describe a module graph without putting one on disk,
// and the walker has no second source of truth about what is there.
function resolveLocal(fromFile, spec, read) {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const ext of CANDIDATES) {
    try {
      const p = base + ext;
      read(p);
      return p;
    } catch (e) { /* not this one */ }
  }
  return null;
}

// Every module the isolate loads because the entry imports it, transitively, as
// repo-relative paths in visit order. This is the answer to "which files can hold state
// that outlives a request" — not a list somebody maintains.
export function discoverModules(entryAbs, root, read = (p) => fs.readFileSync(p, "utf8")) {
  const seen = new Map(); // abs -> rel
  const queue = [entryAbs];
  while (queue.length) {
    const abs = queue.shift();
    if (seen.has(abs)) continue;
    const rel = path.relative(root, abs).split(path.sep).join("/");
    seen.set(abs, rel);
    const source = read(abs);
    for (const m of source.matchAll(SPECIFIER)) {
      const next = resolveLocal(abs, m[1], read);
      if (next && !seen.has(next)) queue.push(next);
    }
  }
  return [...seen.values()];
}

// ---- the scan -----------------------------------------------------------------------

// A `const` initializer that can be written to after module load.
const CONTAINER = /^(\[|\{|new\s+(?:Set|Map|WeakSet|WeakMap)\b)/;
// `export` in front changes nothing about where the state lives, so it is optional here.
const DECL = /^(?:export\s+)?(let|var|const)\s+([A-Za-z_$][\w$]*)\s*(?:=\s*(.*))?$/;
const DESTRUCTURE = /^(?:export\s+)?(let|var|const)\s*[[{]/;

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
      out.push({ name: null, keyword: line.trim().split(/\s+/)[0], line: i + 1, destructured: true });
      continue;
    }
    const m = DECL.exec(line);
    if (!m) continue;
    const [, keyword, name] = m;
    let init = m[3] || "";
    // `const X =` with the value on the next line is the same declaration wrapped, and
    // reading only this line would classify a container as a scalar and skip it.
    if (!init) {
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j].trim();
        if (!t || t.startsWith("//")) continue;
        init = t;
        break;
      }
    }
    if (keyword === "const" && !CONTAINER.test(init)) continue;
    out.push({ name, keyword, line: i + 1, multi: hasTopLevelComma(line) });
  }
  return out;
}

// Returns every problem found in ONE module, each as `{ kind, name, line, message }`. An
// empty list is the pass condition; the caller decides how to report.
export function checkModuleGlobals(source, options = {}) {
  // `allowed` is injectable so a test can ask the checker about a list other than the one
  // shipped — the only way to prove the readmission direction fires without shipping the
  // very entry it is there to refuse.
  const allowed = options.allowed || {};
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
    if (!allowed[b.name]) {
      problems.push({
        kind: "unlisted", name: b.name, line: b.line,
        message:
          "new module-scope state. If it is tenant config, add it to FIELDS in src/tenant-context.mjs and thread it " +
          "rather than declaring it here. If it genuinely cannot vary between workspaces, add it under this module in " +
          "ALLOWLIST in scripts/no-tenant-globals.mjs with the reason — that entry is the claim you are making",
      });
    }
  }

  for (const name of Object.keys(allowed)) {
    if (seen.has(name)) continue;
    problems.push({
      kind: "stale", name, line: 0,
      message: "allowlisted but no longer declared in this module — delete the entry so the list keeps shrinking",
    });
  }

  // The allowlist may not re-admit a threaded field. With the in-flight kind gone, the
  // way back to a shared config global is not a new name — it is an OLD one, put back at
  // module scope with a plausible cache or constant reason attached. A field of the
  // tenant context is per workspace BY DEFINITION, so no reason can make it invariant,
  // and this refuses the claim rather than reading it.
  for (const name of Object.keys(allowed)) {
    if (!TENANT_FIELD_NAMES.includes(name)) continue;
    problems.push({
      kind: "readmitted", name, line: 0,
      message: "allowlisted but it is a field of the tenant context — per-workspace config cannot be shared between workspaces whatever the entry claims; read it off the context instead",
    });
  }

  return { bindings, problems };
}

// The whole graph: discover, then check each module against ITS section, then check that
// every section still has a module. Problems carry the module they came from.
export function checkGraph(root, options = {}) {
  const allowed = options.allowed || ALLOWED;
  const entryRel = options.entry || ENTRY;
  const read = options.read || ((p) => fs.readFileSync(p, "utf8"));
  const modules = discoverModules(path.join(root, entryRel), root, read);

  const problems = [];
  const bindings = [];
  for (const rel of modules) {
    const r = checkModuleGlobals(read(path.join(root, rel)), { allowed: allowed[rel] || {} });
    for (const b of r.bindings) bindings.push({ ...b, module: rel });
    for (const p of r.problems) problems.push({ ...p, module: rel });
  }

  for (const rel of Object.keys(allowed)) {
    if (modules.includes(rel)) continue;
    problems.push({
      kind: "unreachable", module: rel, name: "(module)", line: 0,
      message: "allowlisted but the worker no longer imports it — delete its section so the list keeps shrinking",
    });
  }

  return { modules, bindings, problems };
}

// ---- CLI ----------------------------------------------------------------------------

function main(argv) {
  const opt = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i > -1 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const quiet = argv.includes("--quiet");
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const entry = opt("--entry", ENTRY);

  const { modules, bindings, problems } = checkGraph(root, { entry });

  if (problems.length) {
    for (const p of problems) {
      console.error(`${p.line ? `${p.module}:${p.line}` : p.module}: ${p.name}: ${p.message}`);
    }
    console.error(`\n${problems.length} problem(s) — see the header of scripts/no-tenant-globals.mjs`);
    return 1;
  }

  if (!quiet) {
    const counts = { cache: 0, constant: 0 };
    for (const b of bindings) counts[ALLOWED[b.module][b.name].kind]++;
    console.log(
      `${modules.length} modules reachable from ${entry}: ${bindings.length} module-scope ` +
        `bindings, all accounted for — ${counts.cache} per-isolate caches, ` +
        `${counts.constant} tenant-invariant constants, no tenant config`,
    );
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
