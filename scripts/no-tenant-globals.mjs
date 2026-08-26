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
// ---- WHY THE LIST HAS THE SHAPE IT HAS ----------------------------------------------
//
// THE FAILURE THIS FILE WAS REBUILT AROUND. Two cross-tenant leaks — the ungated avatar
// index, and the board registry + remark queue the ungated poll routes read — were both
// reproduced end to end serving one workspace another's content. Neither was an unlisted
// binding. Both were ON this list, in a category called CACHES, under written reasons
// that asserted the very safety they did not have ("a hash is content-addressed, so it
// means the same thing everywhere"; "a stale stamp costs a re-read"). Every direction the
// lint had — unlisted, stale, unreachable, readmitted — was green throughout, because all
// four ask whether the list AGREES WITH THE CODE and none asks whether an entry is TRUE.
//
// A LINT CANNOT READ PROSE, so this one no longer tries. It does not grade a reason, score
// its wording, or look for the word "keyed" in a sentence. Instead the category whose
// safety rested on a sentence has been abolished and replaced by kinds whose safety is a
// property of the DECLARATION AND ITS USES, which a scanner can decide:
//
//   KEYED      a per-workspace cache. Structurally required to be `const X = new Map()`,
//              and every access to it must carry a workspace key: `.get/.set/.delete/.has`
//              whose first argument is a `tenantId` expression (or a local assigned from
//              one), plus the whole-map operations that cannot hand back one workspace's
//              value (`.clear() .size .keys()`) and the eviction idiom
//              `X.delete(X.keys().next().value)`. `.values() .entries() .forEach()`, or
//              the bare name used as a value, all FAIL: they read every workspace's entry
//              without a key. The note beside the entry is for humans; the lint's verdict
//              does not depend on one word of it.
//
//   INVARIANT  a table written once at module load and never again. Structurally required
//              to be `const`, and required to have NO write anywhere after its declaration
//              — no reassignment, no `.push/.set/.add/.delete/.clear/…`, no `X[k] =`, no
//              `X.k =`, no `Object.assign(X, …)`. Module load happens before any request,
//              so a binding no one ever writes cannot have been derived from a workspace's
//              config. "Tenant-invariant by construction" used to be a claim; it is now
//              the thing that was checked.
//
//   UNKEYED    a bare per-isolate slot. THIS IS THE SHAPE BOTH LEAKS HAD, and the list
//              treats it as such. There is no "it's only a clock" kind, because both leaks
//              had one: `canvasRegAt` was a number, and it is what made the stale document
//              answer. An entry here must name a `proof` — a test file that exists and
//              speaks the binding's name — and the TOTAL number of unkeyed entries across
//              every module must equal `UNKEYED_BUDGET` exactly. Exact, not a ceiling:
//              closing one forces the budget down in the same commit, and opening one
//              forces a diff line that reads "I increased the number of per-isolate slots
//              two workspaces share". That line is the review.
//
// WHY NOT THE OTHER SHAPES. (a) Requiring an entry to NAME the expression it is keyed on
// was the near miss: a name in a string is prose again, and a maintainer who mis-keys the
// code will describe the key they meant. Reading the key off the ACCESS SITES gets the
// same guarantee from the source of truth. (b) Failing when a function that reads a
// module cache is called from a site holding a tenant context but not passing it does
// describe both leaks exactly — but it needs a call graph this regex scanner does not
// have, and it verifies PLUMBING: it goes green the moment the parameter is threaded and
// ignored. The keyed rule subsumes the useful half locally — a cache that may only be
// touched with a `tenantId` in hand forces the parameter to exist, at the one place where
// getting it wrong is visible. (c) Pointing an entry at a test is kept, but only for the
// UNKEYED residue and with no illusions: an existing file that names the binding proves
// the pointer resolves and the name is spoken there, never that the case asserts
// anything. Its real work is the other direction — a proof that is deleted or renamed
// turns this lint red, which no sentence can do.
//
// FOUR OLDER DIRECTIONS, ALL STILL FATAL.
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
// THE GAPS IT DOES NOT COVER, stated so nobody mistakes green for proof.
//   · Module-scope state with no BINDING NAME is invisible to a scan that works by names —
//     `export default {…}`, which every worker has exactly one of, is a live object the
//     runtime calls methods on, so a handler writing `this.something = …` would hold
//     per-isolate state this lint never sees. Flagging every default export would flag the
//     one legitimate handler and say nothing useful about it, so this stays a review
//     question, in the same way `scripts/no-foreign-vocabulary.mjs` names the two shapes
//     it cannot catch.
//   · A KEYED cache is keyed; whether the KEY is the right workspace is `resolveTenant`'s
//     job, guarded by `scripts/one-tenant-resolver.mjs`, not this one's.
//   · The budget is a line in this file, and the same commit that adds a slot can raise
//     it. That is on purpose: the point is not that it is impossible, it is that it is
//     LOUD. What is impossible is doing it the way both leaks were done — by adding a
//     sentence to a list of sentences.
//
// Usage: node scripts/no-tenant-globals.mjs [--entry <path>] [--quiet]
// No config, no dependencies. Exit 1 on any failure.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { TENANT_FIELD_NAMES } from "../src/tenant-context.mjs";

export const ENTRY = "src/_worker.js";

// How many bare per-isolate slots this engine still has. EXACT, and it only goes down —
// see UNKEYED above. Every one of them is a workspace-shared slot that a Host-resolving
// isolate will get wrong, so this number is the phase's remaining debt, counted.
export const UNKEYED_BUDGET = 6;

// ---- the allowlist, per module -------------------------------------------------------
//
// THREE KINDS, and there is no fourth. `caches` is gone: it was one bucket holding both
// "keyed by workspace, provably" and "one slot the whole isolate shares", told apart only
// by the sentence beside them, and the sentence is what failed. Two of the kinds below are
// now decided from the code; the third is the quarantine, budgeted.
//
// Keyed by module because a name is only invariant in the module that declares it: an
// entry vouching for `FIELDS` in the context module must not quietly vouch for a `FIELDS`
// somebody adds to the worker.
const ALLOWLIST = {
  "src/_worker.js": {
    // KEYED — one entry per workspace, and the lint checks that every touch carries the
    // key. The notes say what the value IS and what the key is therefore holding back.
    keyed: {
      MANIFESTS:        "the live content manifests each workspace's store lists, bounded; the value IS one workspace's published content and its gate-deciding routing, so the key is what stops a neighbour's bytes answering at this workspace's URLs",
      STORAGE_CACHE:    "the R2 fill gauge the admin panel shows, bounded; the number measures one workspace's own store",
      mcpHostAllowlist: "the proxy host lists resolved from each workspace's published document, bounded; the value is derived from one workspace's config, so the key is what stops a neighbour answering from it",
      CANVAS_REGISTRY:  "the created-board registry each workspace keeps in KV, bounded; the value names one workspace's boards and the route that reads it serves them to a signed-out stranger before the login page, so the key is what stops a neighbour's boards answering at this workspace's URLs",
      PITI_REMARKS:     "the queued remarks each workspace's companion polls for, bounded; the poll is an ungated route and the value is text written for one workspace's pages",
    },

    // INVARIANT — never written after module load, which is what the lint checks. The note
    // says why nobody should ever want to write it.
    invariant: {
      ROLES:               "the fixed role vocabulary — admin, editor, viewer",
      AVATAR_MIMES:        "accepted avatar formats and their magic-byte tests; a file format is not a tenant property",
      ROSTER_COLORS:       "the presence-chip palette, indexed by a hash of the address",
      ENGINE_CHROME_PATHS: "the shared chrome paths no space may write; mirrors ENGINE_CHROME in build.js",
      MCP_PROXY_PATHS:     "the fixed paths the MCP and OAuth flows use",
      VALID_STATUS:        "the fixed prototype status vocabulary",
      __testables:         "the table of pure helpers the suite imports; function references and fixed numbers, written once, and the request path reads none of it",
    },

    // UNKEYED — the quarantine. Every one of these is a single slot the whole isolate
    // shares, which is the shape both reproduced leaks had. `why` says what it holds and
    // what a second workspace would therefore be answered with; `proof` names where two
    // workspaces are driven against it. Count them: UNKEYED_BUDGET.
    unkeyed: {
      cfgAt: {
        why: "the config TTL tick for the TENANT_CTX slot below; one clock for the isolate, so it decides when the SINGLE context slot is refilled rather than when this workspace's is — superseded per workspace by createTenantContextCache",
        proof: "test/tenant-isolation.test.mjs",
      },
      cfgGoodAt: {
        why: "when the config in the TENANT_CTX slot last loaded without a read failing — the staleness ceiling's clock; it is read only when the slot holds the workspace being asked about, so a second workspace finds no last-good and fails closed rather than inheriting this one's",
        proof: "test/tenant-isolation.test.mjs",
      },
      TENANT_CTX: {
        why: "the last good context this isolate loaded, in ONE slot; it would answer a second workspace with the first one's config, and the per-workspace createTenantContextCache is what replaces it when the resolver stops answering with one static id",
        proof: "test/tenant-isolation.test.mjs",
      },
      rosterReadAt: {
        why: "the roster read clock, one for the isolate; paired with rosterCache below, and a clock over an unkeyed document is exactly what made both closed leaks serve a neighbour's bytes",
        proof: "test/tenant-isolation.test.mjs",
      },
      rosterCache: {
        why: "the six roster KV documents this isolate last read, in one slot — so the second workspace to load inside the tick builds its USERS, SPACE_ICONS and AVATAR_KEYS from the first one's read. Those fields are per-workspace on the context now; the READ under them is not, and keying it is what closes this",
        proof: "test/tenant-isolation.test.mjs",
      },
      tenantMemo: {
        why: "the static tenant id resolveTenant() read from instance.json; a wrong answer the moment an isolate serves two workspaces, and the Host resolver that makes that possible replaces the body it belongs to",
        proof: "test/tenant-isolation.test.mjs",
      },
    },
  },

  "src/tenant-context.mjs": {
    invariant: {
      FIELDS: "the context's SHAPE — every field, its source and its default FACTORY. It is a table of factories, never of values, so nothing a workspace owns is stored in it; two contexts built from it share no reference, which is the leak this whole module exists to close",
    },
  },

  "src/mail.mjs": {
    invariant: {
      DRIVERS:   "the shapes of HTTP request each provider takes; a provider's API is not a workspace property, and every value a deployment supplies (endpoint, key, sender, region) arrives in env at call time",
      TEMPLATES: "the three message bodies, as render functions; the workspace's words arrive as vars per call",
      MAIL_RATE: "the per-recipient send caps; a fixed policy, and the counters it governs live in KV",
    },
  },

  "src/chrome/appchrome.mjs": {
    invariant: {
      ACRONYMS: "words the title-caser must not sentence-case; a fact about English, not about a workspace",
      LIB_KEYS: "the fixed gallery tiers — tokens, base, components, patterns, pages, primitives",
    },
  },
};

// Flattened for the checker and for anything that wants to read the claims: module -> name
// -> { kind, why, proof? }.
export const ALLOWED = Object.freeze(
  Object.fromEntries(
    Object.entries(ALLOWLIST).map(([mod, groups]) => [
      mod,
      Object.freeze({
        ...Object.fromEntries(Object.entries(groups.keyed || {}).map(([k, why]) => [k, { kind: "keyed", why }])),
        ...Object.fromEntries(Object.entries(groups.invariant || {}).map(([k, why]) => [k, { kind: "invariant", why }])),
        ...Object.fromEntries(
          Object.entries(groups.unkeyed || {}).map(([k, e]) => [k, { kind: "unkeyed", why: e.why, proof: e.proof }]),
        ),
      }),
    ]),
  ),
);

export const KINDS = ["keyed", "invariant", "unkeyed"];

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
    out.push({ name, keyword, line: i + 1, init: init.trim(), multi: hasTopLevelComma(line) });
  }
  return out;
}

// ---- reading the USES, which is where the claim now lives ----------------------------

// Comment LINES only, plus block comments. Deliberately not a general comment stripper: a
// trailing `//` after code is indistinguishable from the inside of a regex literal without
// a parser, and getting that wrong would DELETE an access instead of merely reporting a
// sentence. Full-line comments are this codebase's style and are safe to drop.
export function stripComments(source) {
  const out = [];
  let inBlock = false;
  for (const line of source.split("\n")) {
    let l = line;
    if (inBlock) {
      const end = l.indexOf("*/");
      if (end === -1) { out.push(""); continue; }
      l = l.slice(end + 2);
      inBlock = false;
    }
    if (l.trim().startsWith("//")) { out.push(""); continue; }
    const open = l.indexOf("/*");
    if (open > -1 && !/["'`]/.test(l.slice(0, open))) {
      const end = l.indexOf("*/", open + 2);
      if (end === -1) { inBlock = true; l = l.slice(0, open); }
      else l = l.slice(0, open) + l.slice(end + 2);
    }
    out.push(l);
  }
  return out.join("\n");
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The text between the parens starting at `i`, balanced and quote-aware. Null if unclosed.
function callArgs(source, i) {
  let depth = 0;
  let quote = null;
  for (let j = i; j < source.length; j++) {
    const c = source[j];
    if (quote) {
      if (c === "\\") j++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return source.slice(i + 1, j);
    }
  }
  return null;
}

function firstArg(args) {
  if (args == null) return null;
  let depth = 0;
  let quote = null;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) return args.slice(0, i).trim();
  }
  return args.trim();
}

// Which identifiers in this module hold a workspace id. `tenantId` and anything ending
// `.tenantId` name themselves; a local assigned from one is the same value under another
// name (`const key = tctx.tenantId`), so it counts too. Nothing else does — an identifier
// the scanner cannot trace back to a tenant id is not accepted as a key, which is the
// difference between checking the code and believing a comment about it.
const TENANT_EXPR = /(?:^|\.)tenantId$/;
const ALIAS = /(?:^|[\s(;{])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$.]*\.tenantId)\s*[;,)]/g;

export function tenantKeyNames(source) {
  const names = new Set(["tenantId"]);
  for (const m of source.matchAll(ALIAS)) names.add(m[1]);
  return names;
}

const isTenantKey = (expr, aliases) =>
  !!expr && (TENANT_EXPR.test(expr.trim()) || aliases.has(expr.trim()));

// `.get/.set/.delete/.has` must carry a key. `.clear/.size/.keys` operate on the whole map
// and cannot hand back one workspace's value. Everything else — `.values() .entries()
// .forEach()` — reads every workspace's entry at once and has no place on a keyed cache.
const NEEDS_KEY = new Set(["get", "set", "delete", "has"]);
const WHOLE_MAP = new Set(["clear", "size", "keys"]);

const lineOf = (source, index) => source.slice(0, index).split("\n").length;

// Every problem with how a KEYED cache is declared and touched, in ONE module. This is the
// whole of the claim "keyed by workspace": nothing here reads the note beside the entry.
export function checkKeyedUses(source, name, declLine) {
  const code = stripComments(source);
  const aliases = tenantKeyNames(code);
  const problems = [];

  // The eviction idiom, which is keyed by the map's own least-recent key rather than by a
  // caller's workspace: `X.delete(X.keys().next().value)`. Recognised exactly, not by
  // shape, so `X.delete(Y.keys().next().value)` is not it.
  const evict = `${name}.keys().next().value`;

  const re = new RegExp(`(?<![\\w$])${esc(name)}(?![\\w$])(\\s*[.:]?)`, "g");
  for (const m of code.matchAll(re)) {
    const at = m.index;
    const line = lineOf(code, at);
    if (line === declLine) continue;
    const tail = m[1];
    // `{ mcpHostAllowlist: m }` — a property NAME in a pattern or literal, not a read of
    // the binding. The read in `{ a: NAME }` is the occurrence with no colon after it.
    if (tail.trim() === ":") continue;
    if (tail.trim() !== ".") {
      problems.push({
        kind: "keyed-escapes", name, line,
        message:
          "a keyed cache used as a value rather than through a keyed access — spreading, iterating or passing the whole Map " +
          "hands over every workspace's entry at once. Touch it only as " + name + ".get/.set/.delete/.has(<tenantId>)",
      });
      continue;
    }
    const rest = code.slice(at + m[0].length);
    const mem = /^\s*([A-Za-z_$][\w$]*)/.exec(rest);
    if (!mem) continue;
    const member = mem[1];
    if (WHOLE_MAP.has(member)) continue;
    if (!NEEDS_KEY.has(member)) {
      problems.push({
        kind: "keyed-unkeyed-read", name, line,
        message:
          `.${member}() on a keyed cache reads every workspace's entry without a key — the value belongs to one ` +
          "workspace, so there is no correct answer to a question asked without naming which",
      });
      continue;
    }
    const paren = rest.indexOf("(", mem.index + member.length);
    const key = paren === -1 ? null : firstArg(callArgs(rest, paren));
    if (key !== null && key.replace(/\s+/g, "") === evict) continue;
    if (isTenantKey(key, aliases)) continue;
    problems.push({
      kind: "keyed-bad-key", name, line,
      message:
        `.${member}(${key === null ? "" : key}) is not keyed by workspace — the first argument must be a tenantId ` +
        "expression (or a local assigned from one). This is the check that replaces the sentence beside the entry: " +
        "both closed leaks were a cache whose written reason claimed a safety its accesses did not have",
    });
  }
  return problems;
}

// A write to `name` anywhere after its declaration. An INVARIANT binding has none: module
// load runs before any request, so a table nobody writes cannot hold a workspace's data.
const MUTATORS = "push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin|set|add|delete|clear";

export function checkInvariantWrites(source, name, declLine) {
  const code = stripComments(source);
  const n = esc(name);
  const patterns = [
    [new RegExp(`(?<![\\w$])${n}(?![\\w$])\\s*(?:\\|\\||\\?\\?|&&)?=(?!=)`), "reassigned"],
    [new RegExp(`(?<![\\w$])${n}(?![\\w$])\\s*\\.\\s*(?:${MUTATORS})\\s*\\(`), "mutated"],
    [new RegExp(`(?<![\\w$])${n}(?![\\w$])\\s*\\[[^\\]]*\\]\\s*=(?!=)`), "index-assigned"],
    [new RegExp(`(?<![\\w$])${n}(?![\\w$])\\s*\\.\\s*[A-Za-z_$][\\w$]*\\s*=(?!=)`), "property-assigned"],
    [new RegExp(`Object\\s*\\.\\s*assign\\s*\\(\\s*${n}(?![\\w$])`), "Object.assign target"],
  ];
  const problems = [];
  const lines = code.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (i + 1 === declLine) continue;
    for (const [re, how] of patterns) {
      if (!re.test(lines[i])) continue;
      problems.push({
        kind: "invariant-written", name, line: i + 1,
        message:
          `${how} after module load — an INVARIANT entry claims the value is fixed before any request arrives, and a ` +
          "written one can be a workspace's data under a table's name. Make it a keyed cache, or thread it onto the " +
          "tenant context",
      });
      break;
    }
  }
  return problems;
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
    const entry = allowed[b.name];
    if (!entry) {
      problems.push({
        kind: "unlisted", name: b.name, line: b.line,
        message:
          "new module-scope state. If it is tenant config, add it to FIELDS in src/tenant-context.mjs and thread it " +
          "rather than declaring it here. Otherwise it belongs under one of the three kinds in ALLOWLIST in " +
          "scripts/no-tenant-globals.mjs — `keyed` (a Map this lint checks is keyed by workspace at every access), " +
          "`invariant` (a const this lint checks is never written after load), or `unkeyed` (a slot the whole isolate " +
          "shares — the shape both cross-tenant leaks had, so it costs a proof and a line off UNKEYED_BUDGET)",
      });
      continue;
    }
    if (!KINDS.includes(entry.kind)) {
      problems.push({
        kind: "bad-kind", name: b.name, line: b.line,
        message: `allowlisted under an unknown kind "${entry.kind}" — the kinds are ${KINDS.join(", ")}`,
      });
      continue;
    }

    // The structural half. `keyed` and `invariant` are decided here, from the declaration
    // and every use of the name; `unkeyed` has nothing to check because being a bare slot
    // IS what it declares — it is charged for at the graph level instead.
    if (entry.kind === "keyed") {
      if (!/^new\s+Map\s*\(\s*\)/.test(b.init || "")) {
        problems.push({
          kind: "keyed-not-a-map", name: b.name, line: b.line,
          message:
            "listed as keyed by workspace, but declared as a bare value rather than `const " + b.name + " = new Map()`. " +
            "A slot that holds one answer cannot hold one answer PER WORKSPACE, whatever the entry says — this is " +
            "exactly what the avatar index and the board registry were when they leaked. Key it by tenantId, or move " +
            "the entry to `unkeyed` and pay its budget",
        });
      } else {
        problems.push(...checkKeyedUses(source, b.name, b.line));
      }
    } else if (entry.kind === "invariant") {
      if (b.keyword !== "const") {
        problems.push({
          kind: "invariant-not-const", name: b.name, line: b.line,
          message:
            `listed as tenant-invariant but declared \`${b.keyword}\` — a rebindable name is not a table written once ` +
            "at module load",
        });
      }
      problems.push(...checkInvariantWrites(source, b.name, b.line));
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
// every section still has a module, then charge the unkeyed quarantine.
//
// `budget` is the exact number of unkeyed entries the whole graph may carry. It defaults
// to UNKEYED_BUDGET when the shipped list is the one being checked, and to null (skip)
// when a test injects its own list, because a fixture's list is not this engine's debt.
export function checkGraph(root, options = {}) {
  const allowed = options.allowed || ALLOWED;
  const entryRel = options.entry || ENTRY;
  const read = options.read || ((p) => fs.readFileSync(p, "utf8"));
  const budget = options.budget !== undefined
    ? options.budget
    : (allowed === ALLOWED ? UNKEYED_BUDGET : null);
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

  // The quarantine, charged. Each unkeyed slot must point at a test file that EXISTS and
  // speaks its name — which proves the pointer resolves and nothing more, and whose real
  // work is that deleting or renaming that file turns this red. Then the count.
  let unkeyed = 0;
  for (const [rel, entries] of Object.entries(allowed)) {
    for (const [name, entry] of Object.entries(entries)) {
      if (!entry || entry.kind !== "unkeyed") continue;
      unkeyed++;
      if (!entry.proof) {
        problems.push({
          kind: "no-proof", module: rel, name, line: 0,
          message:
            "an unkeyed per-isolate slot with no `proof` — name the test file that drives two workspaces at it. A slot " +
            "nobody has pointed a second workspace at is a slot nobody has looked at",
        });
        continue;
      }
      let proofSource = null;
      try { proofSource = read(path.join(root, entry.proof)); } catch (e) { /* reported below */ }
      if (proofSource == null) {
        problems.push({
          kind: "proof-missing", module: rel, name, line: 0,
          message: `\`proof\` names ${entry.proof}, which does not exist — a proof that has been deleted or renamed is not one`,
        });
      } else if (!new RegExp(`(?<![\\w$])${esc(name)}(?![\\w$])`).test(proofSource)) {
        problems.push({
          kind: "proof-silent", module: rel, name, line: 0,
          message: `\`proof\` names ${entry.proof}, which never mentions ${name} — point at the file that actually drives two workspaces at this slot`,
        });
      }
    }
  }
  if (budget !== null && unkeyed !== budget) {
    problems.push({
      kind: "budget", module: "scripts/no-tenant-globals.mjs", name: "UNKEYED_BUDGET", line: 0,
      message:
        `${unkeyed} unkeyed per-isolate slot(s) allowlisted, UNKEYED_BUDGET says ${budget}. ` +
        (unkeyed > budget
          ? "Adding one is adding a slot two workspaces share — the shape both closed cross-tenant leaks had. If it is " +
            "genuinely unavoidable, raise the budget in the same commit and say in the message which workspace's data " +
            "the isolate now shares"
          : "One has been closed — lower the budget in the same commit, so the number keeps being this phase's remaining debt " +
            "rather than standing permission for the next one"),
    });
  }

  return { modules, bindings, problems, unkeyed };
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

  const { modules, bindings, problems, unkeyed } = checkGraph(root, { entry });

  if (problems.length) {
    for (const p of problems) {
      console.error(`${p.line ? `${p.module}:${p.line}` : p.module}: ${p.name}: ${p.message}`);
    }
    console.error(`\n${problems.length} problem(s) — see the header of scripts/no-tenant-globals.mjs`);
    return 1;
  }

  if (!quiet) {
    const counts = { keyed: 0, invariant: 0, unkeyed: 0 };
    for (const b of bindings) counts[ALLOWED[b.module][b.name].kind]++;
    console.log(
      `${modules.length} modules reachable from ${entry}: ${bindings.length} module-scope bindings, all accounted ` +
        `for — ${counts.keyed} caches keyed by workspace at every access, ${counts.invariant} tables never written ` +
        `after load, ${counts.unkeyed} shared slots (budget ${UNKEYED_BUDGET}), no tenant config`,
    );
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
