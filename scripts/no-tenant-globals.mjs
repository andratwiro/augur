#!/usr/bin/env node
// no-tenant-globals — the ratchet that keeps per-tenant state out of module scope.
//
// WHY. `src/_worker.js` was written for one workspace per deployment, so it keeps its
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
// WHAT COUNTS AS A BINDING. Anything at column 0 of the worker that can hold state: a
// `let` or `var`, and a `const` whose initializer is a mutable container (array literal,
// object literal, `new Set/Map/WeakSet/WeakMap`). A `const` holding a number, a string,
// a regex or a function is not state and is not checked.
//
// THREE DIRECTIONS, ALL FATAL.
//
//   UNLISTED  a binding ALLOWED has never heard of — someone added a global. Fail.
//   STALE     an ALLOWED entry with no binding left in the worker — the sweep removed
//             it. Its line goes with it, so the list SHRINKS as threading lands instead
//             of rotting into standing permission for whatever gets added later.
//   READMITTED an ALLOWED entry that names a field of the tenant context. The sweep is
//             done, so the route back to a shared config global is not a new name but an
//             old one re-declared with a plausible reason attached. A per-workspace field
//             cannot be invariant, so the reason is refused unread.
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
// TWO KINDS, and there is no third. There used to be an IN-FLIGHT kind holding the config
// globals the sweep had not reached yet; it is empty and gone. Not one field of the tenant
// context is declared at module scope any more, so a config global is now simply an
// UNLISTED binding and fails the build — which is the point of the whole phase, expressed
// as a lint rather than as a promise.

// CACHES — per-isolate memos and clocks. Sharing one between workspaces costs at worst a
// wasted read, never a wrong answer — EXCEPT where the reason below says otherwise, and
// those two are named as the work that fixes them.
const CACHES = {
  cfgAt:            "config TTL stamp; superseded per tenant by createTenantContextCache",
  cfgGoodAt:        "when the config in the TENANT_CTX slot last loaded without a read failing — the staleness ceiling's clock; it is read only when the slot holds the workspace being asked about, so a second workspace finds no last-good and fails closed rather than inheriting this one's; goes into createTenantContextCache with TENANT_CTX",
  TENANT_CTX:       "the last good context this isolate loaded, in ONE slot; like the globals it mirrors it would answer a second workspace with the first one's config, and the per-tenant createTenantContextCache is what replaces it when fetch() threads the context down",
  rosterReadAt:     "roster read clock; a stale stamp costs a re-read, and identify() still resolves per request",
  rosterCache:      "the last roster document read from KV; overlay only, never the auth boundary",
  MANIFESTS:        "the live content manifests each workspace's store lists, KEYED BY WORKSPACE and bounded; the value IS one workspace's published content and its gate-deciding routing, so the key is what stops a neighbour's bytes answering at this workspace's URLs",
  STORAGE_CACHE:    "the R2 fill gauge the admin panel shows, KEYED BY WORKSPACE and bounded; the number measures one workspace's own store",
  AVATAR_KEYS:      "hashes the avatar index vouches for; a hash is content-addressed, so it means the same thing everywhere",
  mcpHostAllowlist: "the proxy host lists resolved from each workspace's published document, KEYED BY WORKSPACE and bounded; the value is derived from one workspace's config, so the key is what stops a neighbour answering from it",
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
export function checkWorkerGlobals(source, options = {}) {
  // `allowed` is injectable so a test can ask the checker about a list other than the one
  // shipped — the only way to prove the readmission direction fires without shipping the
  // very entry it is there to refuse.
  const allowed = options.allowed || ALLOWED;
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
          "rather than declaring it here. If it genuinely cannot vary between workspaces, add it to CONSTANTS (or " +
          "CACHES) in scripts/no-tenant-globals.mjs with the reason — that entry is the claim you are making",
      });
    }
  }

  for (const name of Object.keys(allowed)) {
    if (seen.has(name)) continue;
    problems.push({
      kind: "stale", name, line: 0,
      message: "allowlisted but no longer declared in the worker — delete the entry so the list keeps shrinking",
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
    const counts = { cache: 0, constant: 0 };
    for (const b of bindings) counts[ALLOWED[b.name].kind]++;
    console.log(
      `${rel}: ${bindings.length} module-scope bindings, all accounted for — ` +
        `${counts.cache} per-isolate caches, ${counts.constant} tenant-invariant constants, ` +
        `no tenant config`,
    );
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
