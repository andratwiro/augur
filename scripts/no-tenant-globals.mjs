#!/usr/bin/env node
// no-tenant-globals — a CHEAP FIRST FILTER against per-tenant state in module scope.
//
// ⚠️ READ THIS BEFORE READING ITS GREEN AS COVER. This lint is not the guarantee that two
// workspaces do not share anything, and it never was. It checks one thing: that every
// module-scope BINDING in the worker's graph is either a keyed cache, a frozen table, or a
// counted slot. State that has no binding — a memo hung off a function object, a field on
// the default export, a write into an object nested inside a frozen table — is invisible
// to it, and one of those was the shape that most recently mattered. The measured list is
// under "WHAT IT DOES NOT CATCH" below; every claim there was produced by injecting the
// shape into a copy of src/ and running this file, not by reasoning about it.
//
// THE GUARANTEE IS A TEST, NOT A SCAN: `test/tenant-route-sweep.test.mjs` drives the real
// worker in BUNDLE mode with two workspaces over every route, sequentially inside each
// TTL and concurrently, and requires each workspace's own answer AND evidence that its own
// store was read. That is what found the leaks this lint was green on, and that is what to
// extend when a new route or a new cache appears. This file's job is to make the CHEAP
// mistake — a new shared slot with a name — impossible to make quietly. Nothing more.
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
// ---- WHY IT IS BUILT THIS WAY, AND NOT THE OTHER WAY --------------------------------
//
// THE HISTORY THIS FILE IS THE THIRD ANSWER TO. Cross-tenant leaks kept being found in
// code this lint was green on. Each rebuild caught the shape in front of it and was
// answered by the next shape: a bare `let`; then a Map whose accesses did not carry a
// key; then a factory call (`const SLOT = makeSlot()`) the binding scanner did not even
// count as a binding, a literal key inside an allowlisted keyed cache, and a `??=` write
// into a table the list called invariant. Three rounds of "enumerate the unsafe shapes"
// lost three times, because there is always another shape and the person adding it is the
// one choosing it.
//
// SO THE UNSAFE SHAPES ARE NO LONGER WHAT IS ENUMERATED. Two inversions:
//
//   1. A CONSTRUCTOR, NOT A PATTERN. There is exactly one way to keep a cache across
//      requests: `tenantCache()` in src/tenant-cache.mjs. It hands back a frozen handle
//      over a Map held in a closure. The Map cannot be reached, so there is no
//      `entries()`, no `values()`, no `forEach()`, no iterator and no way to pass the
//      container anywhere — "read every workspace's entry at once" is not expressible,
//      whether or not this lint is looking. Every method that reaches a value takes the
//      workspace id FIRST and refuses a call without one. An unkeyed cache is therefore
//      not a shape to be detected; it is a thing that cannot be built.
//
//      The same move for fixed tables: an `frozen` entry is `Object.freeze(…)` at the
//      declaration, so the JS engine refuses every write at every site — including the
//      ones a regex scanner cannot parse. `VALID_STATUS[p] ??= x` used to slip past a
//      write scan that only knew about `=`; against a frozen object it throws.
//
//   2. WHAT COUNTS AS STATE IS AN ALLOWLIST, NOT A DENYLIST. The old scanner asked "is
//      this initializer one of the mutable shapes I know?" — array literal, object
//      literal, `new Map/Set`. `const SLOT = makeSlot()` is none of them, so it was
//      invisible, and a factory is the one thing every state-hiding trick has in common.
//      This one asks the opposite question: "is this initializer PROVABLY not state?" A
//      number, a string or template, a regex, a symbol, a function, or a call to a
//      same-module arrow that returns a string — those, and nothing else. Everything
//      else is state and must be on the list, including every call. The failure mode is
//      now a false ALARM (a genuinely-constant call the list has to name) rather than a
//      silent pass, which is the direction a guard is allowed to be wrong in.
//
// THE THREE KINDS, and there is no fourth:
//
//   cache      `const X = tenantCache(…)`. Checked: the declaration is that call, the
//              module really imports it from src/tenant-cache.mjs, every touch is one of
//              the handle's own methods (read off the module, not copied here), and every
//              method that reaches a value is given a `tenantId` expression.
//
//   frozen     `const X = Object.freeze(…)`. Checked: `const`, and that call at the
//              declaration. Not a Map or a Set — freezing one leaves `.add()` and
//              `.set()` working, so a frozen Set is a table with a lock painted on it.
//
//   unkeyed    a bare per-isolate slot. THE SHAPE EVERY LEAK HAD, kept as a quarantine
//              because the engine still has four. An entry names a `proof` — a test file
//              that exists and speaks the binding's name — and the TOTAL across every
//              module must equal `UNKEYED_BUDGET` exactly. Exact, not a ceiling: closing
//              one forces the number down in the same commit, and opening one forces a
//              diff line that reads "I increased the number of per-isolate slots two
//              workspaces share". That line is the review.
//
// AND THE REASONS ARE GONE. The failure that outlived every rebuild is that an entry's
// stated reason is PROSE, and no checker can tell whether prose is true — every closed
// leak was on the list under a sentence asserting the safety it did not have ("a hash is
// content-addressed, so it means the same thing everywhere"). The answer is not a better
// sentence or a scan for weasel words. It is that `cache` and `frozen` are ARRAYS OF
// NAMES: there is no field to write a claim into, so no reader can be persuaded by one.
// What a human needs to know sits in a `//` comment beside the name, which is visibly
// commentary rather than data. Prose survives in exactly one place — `unkeyed`, where a
// slot's danger genuinely cannot be checked — and that place is capped by a number.
//
// FOUR OLDER DIRECTIONS, ALL STILL FATAL.
//
//   UNLISTED   a binding the module's allowlist has never heard of. Fail. A module with
//              no section at all allows nothing, so a NEW module carrying state fails on
//              its first binding rather than on nobody remembering to name it somewhere.
//   STALE      an allowlist entry with no binding left in its module — the sweep removed
//              it. Its line goes with it, so the list SHRINKS as threading lands instead
//              of rotting into standing permission for whatever gets added later.
//   UNREACHABLE an allowlisted module the worker no longer imports. Same rule one level
//              up: a section outlives its module otherwise.
//   READMITTED an allowlist entry that names a field of the tenant context. The sweep is
//              done, so the route back to a shared config global is not a new name but an
//              old one re-declared with a plausible reason attached. A per-workspace field
//              cannot be fixed, so the entry is refused unread.
//
// ---- WHAT IT DOES NOT CATCH ----------------------------------------------------------
//
// MEASURED, not assumed: each shape below was injected into a copy of `src/` and this file
// was run against it. A guard that overstates itself is how three leaks shipped, so the
// verdicts are written down rather than described.
//
// MISSED — real per-isolate state, and this lint passes green on all four:
//
//   · MEMOISATION HUNG OFF A FUNCTION OBJECT. `statusApi.__memo = {at, map}` in a GET
//     path, read back on the next request. No new declaration, no allowlist edit, nothing
//     for a binding scanner to see — and it is a cache every workspace in the isolate
//     shares. This is the shape that beat the last two rebuilds of this file.
//   · THE SAME TRICK ON AN ARROW THE MODULE ALREADY DECLARES.
//     `readCanvasRegistry.__shared ||= {…}`, handed to a keyed cache as its per-workspace
//     factory value, so the container is keyed and every entry points at one object.
//   · A FIELD ON THE DEFAULT EXPORT. `this.x = …` inside `fetch()`. Every worker has one
//     `export default {…}` and the runtime calls its methods, so flagging the shape would
//     flag the one legitimate case and say nothing.
//   · A PER-REQUEST WRITE INTO A TABLE THIS FILE CALLS INVARIANT. `Object.freeze` IS
//     SHALLOW: it refuses every write to the table and none to an object inside it, so
//     `AVATAR_MIMES["image/png"].lastSeenAt = Date.now()` runs, on a name the `frozen`
//     list vouches for. Today every frozen table here is one level deep at the point of
//     use; nothing checks that it stays so.
//
// CAUGHT TODAY — and worth naming anyway, because each was MISSED by an earlier generation
// of this same file, which is the reason not to read today's green as a guarantee:
//
//   · `const SLOT = makeSlot()` — a const initialised by a call. The binding scanner did
//     not count it as a binding at all; the allowlist inversion is what closed it.
//   · A CONSTANT KEY INSIDE A KEYED CONTAINER — `MANIFESTS.get("one")`,
//     `PITI_REMARKS.entry("all", …)`. The container looked keyed on the allowlist while
//     every access named the same slot.
//   · A NEW MODULE-SCOPE BINDING used as the shared default inside a keyed cache's
//     factory. Caught as an unlisted binding, not as the leak it is.
//
// ---- THE OTHER LIMITS, stated for the same reason -------------------------------------
//   · THE KEY MUST SAY `tenantId`, and that is a name, not a proof. `M.get(x.tenantId)`
//     passes whatever `x` is, so an object built with a `tenantId` field of the wrong
//     value would pass. Aliases are refused precisely to keep this narrow (see
//     TENANT_KEY below), but the residue is real: WHICH workspace a request is for is
//     `resolveTenant`'s answer, guarded by scripts/one-tenant-resolver.mjs, not this
//     one's.
//   · A `cache` HANDLE IS KEYED, NOT CORRECT. It guarantees the caller named a workspace,
//     never that the value stored under that name belongs to it. A handler that writes
//     workspace A's document under B's id is beyond anything structural here.
//   · THE BUDGET IS A LINE IN THIS FILE, and the same commit that adds a slot can raise
//     it. On purpose: the point is not that it is impossible, it is that it is LOUD.
//     What IS impossible now is doing it the way every leak was done — by adding a
//     sentence to a list of sentences.
//
// Usage: node scripts/no-tenant-globals.mjs [--entry <path>] [--quiet]
// No config, no dependencies. Exit 1 on any failure.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { TENANT_FIELD_NAMES } from "../src/tenant-context.mjs";
import {
  tenantCache,
  TENANT_CACHE_KEYED_METHODS,
  TENANT_CACHE_WHOLE_METHODS,
} from "../src/tenant-cache.mjs";

// The DEPLOY entry, which since the plain-Worker split is `src/entry.js` rather than the
// worker itself. This constant decides what gets scanned — check.yml runs this lint with
// no arguments on purpose — so it has to name the file wrangler's `main` points at, not
// the file that happens to hold the fetch handler. A module reachable only from a new
// entry would otherwise be silently unscanned, which is the escape by omission this lint
// exists to catch. test/worker-entry.test.mjs pins it to the shell template's `main`.
export const ENTRY = "src/entry.js";

// The module that owns the one cache constructor. A `cache` entry is only believed in a
// module that actually imports it from here — otherwise `tenantCache` is just a name
// somebody could declare locally to mean anything.
export const CACHE_MODULE = "src/tenant-cache.mjs";

// How many bare per-isolate slots this engine still has. EXACT, and it only goes down —
// see `unkeyed` above. Every one of them is a workspace-shared slot that a Host-resolving
// isolate will get wrong, so this number is the phase's remaining debt, counted.
export const UNKEYED_BUDGET = 4;

// ---- the allowlist, per module -------------------------------------------------------
//
// `cache` and `frozen` are LISTS OF NAMES. They carry no reason, because a reason is the
// thing that failed: every verdict below is read off the declaration and its uses, and
// there is deliberately nowhere in this structure to assert a safety the code does not
// have. Notes are comments — commentary, not data.
//
// Keyed by module because a name is only meaningful in the module that declares it: an
// entry vouching for `FIELDS` in the context module must not quietly vouch for a `FIELDS`
// somebody adds to the worker.
const ALLOWLIST = {
  "src/_worker.js": {
    // Per-workspace caches. Each holds one workspace's own documents — its published
    // manifests and the routing that decides its gate; its store fill; its resolved proxy
    // hosts; the boards and the queued remarks its two UNGATED poll routes serve; and the
    // roster overlay, which decides who exists in a workspace and what they may do.
    // Every one of them was a single slot once, and three of them were reproduced serving
    // one workspace another's content.
    cache: [
      "MANIFESTS",
      "STORAGE_CACHE",
      "mcpHostAllowlist",
      "CANVAS_REGISTRY",
      "PITI_REMARKS",
      "ROSTER_OVERLAY",
      "FREEZE_STATE",
      "SUSPENSION_STATE",
    ],

    // Fixed tables, frozen at the declaration so a write throws rather than turning the
    // table into per-isolate state under a constant's name.
    frozen: [
      "LEGACY_USER_COOKIES",  // ⏳ the two names the session cookie used to be issued under
      "ROLES",                // admin, editor, viewer
      "AVATAR_MIMES",         // accepted avatar formats and their magic-byte tests
      "ROSTER_COLORS",        // the presence-chip palette, indexed by a hash of the address
      "ENGINE_CHROME_PATHS",  // the shared chrome paths no space may write
      "MCP_PROXY_PATHS",      // the three paths the MCP/OAuth protocol speaks
      "VALID_STATUS",         // the prototype status vocabulary
      "IMAGES_OFF",           // the refusal body when an instance has user images switched off
      "OVERLAY_KV_KEYS",      // family -> the KV document name it lives under; the same for every workspace
      "STATE_KV_PREFIXED",    // which inventory entries are one document per key when exported
      "NEVER_CLEARED",        // families a reset may never empty; a fact about credentials, not a workspace
      "KV_CUTOVER",           // which identity families read from the workspace object; a deploy-wide fact, and one word per family is the revert
      "BUNDLE_TENANCY",       // which bundle-store families carry a workspace segment; the same shape, the same revert, and the same deploy-wide fact
      "IDENTITY_TENANCY",     // which identity KV documents carry a workspace segment; the same shape, the same revert, and the same deploy-wide fact
      "IDENTITY_KV_FAMILIES", // which KV documents each identity family owns; the worker's own copy of the fact src/kv-identity.mjs also lists
      "FIRST_RUN_COPY",       // the first-run page's placeholder words; one table so iterating on the copy touches nothing that routes
      "REKEY_FAMILIES",       // which of those families a re-key may be asked to move — the vocabulary of one route, identical for every workspace
      "REKEY_DEFAULT_FAMILIES", // and which it moves when asked for none
      "CAP_ROUTES",           // capability -> the routes it grants; deny-by-default, identical for every workspace
      "FROZEN_WRITES",        // the paths a migration freeze closes; the same list for every workspace
      "SUSPENDED_ALLOWED",       // what a paused workspace still answers — the published promise, as a list
      "SUSPENDED_ALLOWED_READS", // and the read verbs of the bundle store an export walks
      "__testables",          // the table of helpers the suite imports; the request path reads none of it
    ],

    // UNKEYED — the quarantine. Every one of these is a single slot the whole isolate
    // shares, which is the shape every reproduced leak had. `why` says what it holds and
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
      tenantMemo: {
        why: "the static tenant id resolveTenant() read from instance.json; a wrong answer the moment an isolate serves two workspaces, and the Host resolver that makes that possible replaces the body it belongs to",
        proof: "test/tenant-isolation.test.mjs",
      },
    },
  },

  "src/tenant-context.mjs": {
    frozen: [
      "FIELDS",                 // the context's SHAPE: a table of default FACTORIES, never of values
      "TENANT_FIELD_NAMES",     // the field names, derived from FIELDS at load
      "TENANT_FIELD_SOURCES",   // where each field's value comes from
      "LEGACY_MCP_PATH_FLOOR",  // ⏳ the path floor a pre-declaration manifest keeps
    ],
  },

  "src/tenant-cache.mjs": {
    frozen: [
      "TENANT_CACHE_KEYED_METHODS", // the handle methods that reach a value
      "TENANT_CACHE_WHOLE_METHODS", // the ones that cannot hand back one workspace's value
    ],
  },

  // The canvas room. Its per-board state lives in the Durable Object instance, never at
  // module scope — one DO per board is the isolation, and it is structural.
  "src/board-room.mjs": {
    frozen: [
      "COLORS",  // the presence-chip palette, read by index
    ],
  },

  // The checks an instance runs on itself from its own cron. Every function here is pure —
  // a build stamp, a clock and at most one outbound fetch in, a report out — so there is
  // nothing per-workspace to hold. The stamp is passed in by the caller, which is what
  // keeps it that way.
  "src/health-cron.mjs": {
    frozen: [
      "HEALTH_GRACE",  // the grace windows, kept equal to templates/shell/health.yml's
    ],
  },

  // The account of what an instance stores and where each family goes. A fact about the
  // ENGINE, identical for every workspace — the per-workspace part is the data it names,
  // which lives in each workspace's own store.
  "src/state-inventory.mjs": {
    frozen: [
      "STATE_INVENTORY",  // the list itself; the export endpoint walks it
      "INVENTORY_IDS",    // the ids, derived from the list at load
    ],
  },

  // Which workspace a hostname names. Pure string work, no env and no clock — nothing here
  // is about a particular workspace, which is why it can be a table at all.
  "src/tenant-host.mjs": {
    frozen: [
      "RESERVED_LABELS",  // hostnames no workspace may be; the same list the name generator reads
    ],
  },

  // What each PLAN allows. Note the direction: this is a table of plans, not of
  // workspaces. A workspace's own ceilings are seeded into its Durable Object and read
  // from there, so nothing here is about a particular one — which is the whole reason the
  // quotas live in the store rather than in a constant a deploy would have to move.
  "src/tenant-quotas.mjs": {
    frozen: [
      "PLANS",         // plan name -> ceilings; seeded into a workspace, never read live per request
      "QUOTA_FIELDS",  // the field names, so a plan missing one fails rather than being unlimited
    ],
  },

  // The workspace store. Same shape as the room above and for the same reason: one DO per
  // workspace is the isolation, so nothing per-workspace is at module scope here either.
  "src/tenant-do.js": {
    frozen: [
      "TENANT_SCHEMA",       // the DDL, identical for every workspace — what differs is where it is applied
      "FORBIDDEN_COLUMNS",   // column names the schema may not have; a fact about credentials
      "CONTROL_VERBS",       // the whole of what the control plane may ask; the same list for every workspace
      "SEEDABLE_FAMILIES",   // which overlay families a seed pack may write; a fact about the schema
      "IDENTITY_FAMILIES",   // which identity families a copy may write; a fact about the schema, and the list that keeps a credential out
      "MEMBER_ROLES",        // the three roles the members CHECK constraint allows; the same three everywhere
      "TENANT_SCHEMA_ADDITIONS", // columns a table built at an earlier version is missing; a fact about the schema's history
      "DORMANCY_SUSPENSION_REASONS", // which suspension reasons a sign-in may lift; a published policy, identical for every workspace
    ],
  },

  "src/kv-identity.mjs": {
    frozen: [
      "UNMAPPED_WORKSPACE_FAMILIES", // which workspace-destined families this translation does NOT carry, and why; a fact about the schema
      "IDENTITY_KV_FAMILIES",        // which KV documents it DOES read; the other half of the same fact, read by the inventory guard
      "MEMBER_ROLE_SET",             // the roles `members.role` accepts; the same three everywhere, and the copy's copy of tenant-do's list
    ],
  },

  "src/mail.mjs": {
    frozen: [
      "DRIVERS",    // the shape of HTTP request each provider takes; every deployment value arrives in env
      "TEMPLATES",  // the three message bodies, as render functions
      "MAIL_RATE",        // the per-recipient send caps; the counters they govern live in KV
      "MAIL_ACTOR_RATE",  // the per-actor cap — one number, same for every workspace
      "MAIL_GLOBAL_RATE", // the per-instance cap; the counter it governs lives in KV
    ],
  },

  "src/chrome/appchrome.mjs": {
    frozen: [
      "ACRONYMS",  // words the title-caser must not sentence-case; a fact about English
      "LIB_KEYS",  // the fixed gallery tiers
    ],
  },

  // What is current in a workspace and what has been left behind. Pure — manifest stamps
  // and a status map in, rows out — and it deliberately stores nothing: staleness is
  // DERIVED from the per-file editedAt the commit handler already records, so there is no
  // per-workspace anything to keep here. The threshold and the age arithmetic are number
  // literals the lint proves harmless on its own.
  "src/currency.mjs": {
    frozen: [
      "STATUS_LABELS",  // the status vocabulary's words; the same four for every workspace
    ],
  },
};

// Flattened for the checker and for anything that wants to read the list: module -> name
// -> { kind, why?, proof? }. `why` exists only on the quarantine.
export const ALLOWED = Object.freeze(
  Object.fromEntries(
    Object.entries(ALLOWLIST).map(([mod, groups]) => [
      mod,
      Object.freeze({
        ...Object.fromEntries((groups.cache || []).map((k) => [k, { kind: "cache" }])),
        ...Object.fromEntries((groups.frozen || []).map((k) => [k, { kind: "frozen" }])),
        ...Object.fromEntries(
          Object.entries(groups.unkeyed || {}).map(([k, e]) => [k, { kind: "unkeyed", why: e.why, proof: e.proof }]),
        ),
      }),
    ]),
  ),
);

export const KINDS = ["cache", "frozen", "unkeyed"];

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
    // Comments are stripped BEFORE specifiers are matched: a commented-out import is not
    // an import, and following one drags a module that nothing loads into the scan. The
    // deploy entry documents its future Durable Object export as a commented line, which
    // is exactly this case — the class is not in the graph until the line is real.
    // `stripComments` is the conservative one (whole-line and block only), so it cannot
    // swallow a live import that shares a line with something else.
    const source = stripComments(read(abs));
    for (const m of source.matchAll(SPECIFIER)) {
      const next = resolveLocal(abs, m[1], read);
      if (next && !seen.has(next)) queue.push(next);
    }
  }
  return [...seen.values()];
}

// ---- comments ------------------------------------------------------------------------

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

// ---- "is this initializer provably NOT state?" ---------------------------------------
//
// The inversion. Everything this function cannot PROVE harmless is state and has to be on
// the list. Being wrong here costs a false alarm and a line on the allowlist; being wrong
// the other way is how `const SLOT = makeSlot()` was invisible.

// Consume one primitive literal at `i`. Returns the index after it, or -1.
function eatLiteral(s, i) {
  const c = s[i];
  if (c === '"' || c === "'") {
    for (let j = i + 1; j < s.length; j++) {
      if (s[j] === "\\") { j++; continue; }
      if (s[j] === c) return j + 1;
    }
    return -1;
  }
  if (c === "`") {
    // A template literal always EVALUATES to a string, whatever is interpolated into it,
    // so the substitutions only have to be skipped, never understood.
    for (let j = i + 1; j < s.length; j++) {
      if (s[j] === "\\") { j++; continue; }
      if (s[j] === "`") return j + 1;
      if (s[j] === "$" && s[j + 1] === "{") {
        let depth = 1;
        j += 2;
        while (j < s.length && depth) {
          if (s[j] === "{") depth++;
          else if (s[j] === "}") depth--;
          j++;
        }
        j--;
      }
    }
    return -1;
  }
  const num = /^-?(?:0[xX][0-9a-fA-F_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][-+]?\d+)?|\.\d[\d_]*)/.exec(s.slice(i));
  if (num) return i + num[0].length;
  const word = /^(?:true|false|null|undefined)\b/.exec(s.slice(i));
  if (word) return i + word[0].length;
  return -1;
}

// A regex literal at position 0, and nothing after it.
const REGEX_LITERAL = /^\/(?:\\.|\[(?:\\.|[^\]])*\]|[^/\\\n])+\/[gimsuyd]*$/;

// `Symbol("x")` / `Symbol.for("x")` — a primitive, like a number. The only call form on
// this side of the line, and it is here because a symbol cannot hold anything.
const SYMBOL_CALL = /^Symbol(?:\.for)?\s*\(\s*(?:(["'])(?:\\.|(?!\1).)*\1\s*)?\)$/;

// A chain of primitive literals joined by arithmetic/concatenation — `60 * 60 * 24 * 7`,
// `"pbkdf2$"`, `` `a${b}c` ``, `1024 * 64`. Whatever the operands, the result of `+ - * /
// %` over literals is a primitive.
function isLiteralExpression(init) {
  let i = 0;
  const s = init.trim();
  if (!s) return false;
  for (;;) {
    while (i < s.length && /\s/.test(s[i])) i++;
    const next = eatLiteral(s, i);
    if (next === -1) return false;
    i = next;
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) return true;
    if (!/[+\-*/%]/.test(s[i])) return false;
    i++;
  }
}

// A function expression: `function (…)`, `async function`, or an arrow — recognised by a
// `=>` at depth 0, which `foo(() => 1)` does not have and `(a, b) => …` does.
function isFunctionExpression(init) {
  if (/^(?:async\s+)?function\b/.test(init)) return true;
  let depth = 0;
  let quote = null;
  for (let i = 0; i < init.length; i++) {
    const c = init[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "=" && init[i + 1] === ">" && depth === 0) return true;
  }
  return false;
}

// Module-scope arrows whose BODY is a string — `const ic = (inner) => \`<svg …\`;`. A call
// to one of those binds a string, and a string is not state. This is the only call form
// admitted beyond `Symbol`, and it is admitted structurally: the body has to start with a
// quote or a backtick, so a factory with a block body (`() => { let v; … }` — exactly the
// bypass) is not one of these.
export function stringBuilderNames(source) {
  const names = new Set();
  const re = /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>\s*[`"']/gm;
  for (const m of source.matchAll(re)) names.add(m[1]);
  const re1 = /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\s*=>\s*[`"']/gm;
  for (const m of source.matchAll(re1)) names.add(m[1]);
  return names;
}

// The whole question, in one place.
export function isProvablyNotState(init, builders = new Set()) {
  const s = String(init || "").trim().replace(/;+$/, "").trim();
  if (!s) return false;
  if (isLiteralExpression(s)) return true;
  if (REGEX_LITERAL.test(s)) return true;
  if (SYMBOL_CALL.test(s)) return true;
  if (isFunctionExpression(s)) return true;
  const call = /^([A-Za-z_$][\w$]*)\s*\(/.exec(s);
  if (call && builders.has(call[1]) && s.endsWith(")")) return true;
  return false;
}

// ---- module-scope bindings -----------------------------------------------------------

// `export` in front changes nothing about where the state lives, so it is optional here.
const DECL = /^(?:export\s+)?(let|var|const)\s+([A-Za-z_$][\w$]*)\s*(?:=|;|$)/;
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

// The initializer text, from just after the `=` to the `;` that ends the statement —
// across as many lines as it takes, so a wrapped declaration is classified by its whole
// value rather than by whichever fragment landed on the first line.
function initializerAt(source, eqIndex) {
  let depth = 0;
  let quote = null;
  for (let i = eqIndex + 1; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "/" && source[i + 1] === "/" && depth === 0) {
      const nl = source.indexOf("\n", i);
      if (nl === -1) return source.slice(eqIndex + 1, i);
      i = nl;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === ";" && depth === 0) return source.slice(eqIndex + 1, i);
  }
  return source.slice(eqIndex + 1);
}

// Every module-scope binding that can hold state. Column 0 is the whole test for "module
// scope": the worker's embedded client scripts live inside template literals and are all
// indented, so nothing nested is reachable from here.
export function moduleScopeBindings(source) {
  const builders = stringBuilderNames(source);
  const out = [];
  const lines = source.split("\n");
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineStart = offset;
    offset += line.length + 1;
    if (DESTRUCTURE.test(line)) {
      out.push({ name: null, keyword: line.trim().split(/\s+/)[0], line: i + 1, destructured: true });
      continue;
    }
    const m = DECL.exec(line);
    if (!m) continue;
    const [, keyword, name] = m;
    // DECL's match ends ON the `=` when there is one. A declaration with no initializer,
    // or one whose `=` wrapped onto the next line, gets an empty initializer — which is
    // not provably harmless, so it counts as state. That is the safe direction.
    const eq = m[0].endsWith("=") ? m[0].length - 1 : -1;
    const init = eq === -1 ? "" : initializerAt(source, lineStart + eq).trim();
    // A `let`/`var` is state whatever it holds — it can be reassigned from a request.
    if (keyword === "const" && isProvablyNotState(init, builders)) continue;
    out.push({ name, keyword, line: i + 1, init, multi: hasTopLevelComma(line) });
  }
  return out;
}

// ---- reading the USES of a cache handle ----------------------------------------------

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

// A workspace key SAYS SO: `tenantId`, or a member chain ending in `.tenantId`.
//
// There are deliberately NO aliases. The previous version accepted any local ever
// assigned from a tenant id anywhere in the module — a module-wide set of trusted names —
// so `const key = "everyone"` in one function passed because `const key = tctx.tenantId`
// existed in another. An alias is a local name CLAIMING to be the workspace, which is a
// sentence in identifier form, and sentences are what this file no longer reads. Code
// that wants a key in a local writes `tctx.tenantId` at the access instead.
const TENANT_KEY = /^(?:[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\.\s*)?tenantId$/;

const isTenantKey = (expr) => !!expr && TENANT_KEY.test(expr.trim());

const KEYED_METHODS = new Set(TENANT_CACHE_KEYED_METHODS);
const WHOLE_METHODS = new Set(TENANT_CACHE_WHOLE_METHODS);

const lineOf = (source, index) => source.slice(0, index).split("\n").length;

// Does this module import the cache constructor from the module that owns it? A `cache`
// entry is a claim about `tenantCache`, and a locally-declared `tenantCache` would be a
// different function with the same name.
const IMPORTS_CACHE =
  /import\s*\{[^}]*\btenantCache\b[^}]*\}\s*from\s*["'][^"']*tenant-cache\.mjs["']/;

// Every problem with how a cache handle is declared and touched, in ONE module. Nothing
// here reads a note, because there is no note to read.
export function checkCacheUses(source, name, declLine) {
  const code = stripComments(source);
  const problems = [];

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
        kind: "cache-escapes", name, line,
        message:
          "a per-workspace cache used as a value rather than through one of its own methods — passing the handle " +
          "somewhere hands over every workspace's entry to whatever that place does with it. Touch it only as " +
          `${name}.${TENANT_CACHE_KEYED_METHODS.join("/")}(<tenantId>, …)`,
      });
      continue;
    }
    const rest = code.slice(at + m[0].length);
    const mem = /^\s*([A-Za-z_$][\w$]*)/.exec(rest);
    if (!mem) continue;
    const member = mem[1];
    if (WHOLE_METHODS.has(member)) continue;
    if (!KEYED_METHODS.has(member)) {
      problems.push({
        kind: "cache-unknown-method", name, line,
        message:
          `.${member} is not one of the handle's methods (${[...TENANT_CACHE_KEYED_METHODS, ...TENANT_CACHE_WHOLE_METHODS].join(", ")}) ` +
          "— a tenantCache handle is frozen, so this either throws at runtime or is not the cache at all",
      });
      continue;
    }
    const paren = rest.indexOf("(", mem.index + member.length);
    const key = paren === -1 ? null : firstArg(callArgs(rest, paren));
    if (isTenantKey(key)) continue;
    problems.push({
      kind: "cache-bad-key", name, line,
      message:
        `.${member}(${key === null ? "" : key}) does not name a workspace — the first argument must be a \`tenantId\` ` +
        "expression (`tenantId`, or something ending `.tenantId`). A literal, or a local that merely looks like a " +
        "workspace, is one slot with extra syntax: `const key = \"everyone\"; M.get(key)` is how a keyed cache became " +
        "a shared one while this lint was green",
    });
  }
  return problems;
}

// ---- the per-module check ------------------------------------------------------------

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
  const importsCache = IMPORTS_CACHE.test(source);

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
          "rather than declaring it here. If it is a cache, build it with `tenantCache()` from src/tenant-cache.mjs " +
          "and list it under `cache`. If it is a fixed table, wrap it in `Object.freeze(…)` and list it under " +
          "`frozen`. Anything else is a slot the whole isolate shares: `unkeyed`, which costs a proof and a line off " +
          "UNKEYED_BUDGET. NOTE that a call initializer counts as state — `const X = makeSomething()` can return a " +
          "closure over a module-scope slot, and that is exactly how one got past this lint",
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

    // The structural half. `cache` and `frozen` are decided from the declaration — and
    // for a cache, from every use of the name too. `unkeyed` has nothing to check because
    // being a bare slot IS what it declares; it is charged for at the graph level instead.
    if (entry.kind === "cache") {
      if (!/^tenantCache\s*\(/.test(b.init || "")) {
        problems.push({
          kind: "cache-not-constructed", name: b.name, line: b.line,
          message:
            "listed as a per-workspace cache but not built by `tenantCache(…)`. That constructor is the whole claim: " +
            "its handle has no way to reach a value without naming a workspace and no way to enumerate what it holds, " +
            "so a cache made any other way is a shape somebody has to be trusted about. Build it with tenantCache, or " +
            "move the entry to `unkeyed` and pay its budget",
        });
      } else if (!importsCache) {
        problems.push({
          kind: "cache-not-imported", name: b.name, line: b.line,
          message:
            `built by a local \`tenantCache\` — this module does not import it from ${CACHE_MODULE}, so the name ` +
            "vouches for nothing",
        });
      } else {
        problems.push(...checkCacheUses(source, b.name, b.line));
      }
    } else if (entry.kind === "frozen") {
      if (b.keyword !== "const") {
        problems.push({
          kind: "frozen-not-const", name: b.name, line: b.line,
          message:
            `listed as a fixed table but declared \`${b.keyword}\` — a rebindable name is not a table, whatever its ` +
            "current value is frozen",
        });
      }
      if (!/^Object\s*\.\s*freeze\s*\(/.test(b.init || "")) {
        problems.push({
          kind: "frozen-not-frozen", name: b.name, line: b.line,
          message:
            "listed as a fixed table but not wrapped in `Object.freeze(…)`. The freeze is what makes this checkable: " +
            "the engine then refuses every write at every site, including the ones a scanner cannot parse — a `??=` " +
            "into an unfrozen table is how a per-request write into an \"invariant\" table went unseen",
        });
      } else if (/^Object\s*\.\s*freeze\s*\(\s*new\s+(?:Map|Set|WeakMap|WeakSet)\b/.test(b.init || "")) {
        problems.push({
          kind: "frozen-collection", name: b.name, line: b.line,
          message:
            "a frozen Map or Set is not a fixed table — `Object.freeze` does not touch their contents, so `.set()`, " +
            "`.add()`, `.delete()` and `.clear()` all still work. Use a frozen array or object literal, or make it a " +
            "`tenantCache` if it is really a cache",
        });
      }
    }
  }

  for (const name of Object.keys(allowed)) {
    if (seen.has(name)) continue;
    problems.push({
      kind: "stale", name, line: 0,
      message: "allowlisted but no longer declared in this module — delete the entry so the list keeps shrinking",
    });
  }

  // The allowlist may not re-admit a threaded field. The way back to a shared config
  // global is not a new name — it is an OLD one, put back at module scope with a
  // plausible cache or constant reason attached. A field of the tenant context is per
  // workspace BY DEFINITION, so no reason can make it fixed, and this refuses the claim
  // rather than reading it.
  for (const name of Object.keys(allowed)) {
    if (!TENANT_FIELD_NAMES.includes(name)) continue;
    problems.push({
      kind: "readmitted", name, line: 0,
      message: "allowlisted but it is a field of the tenant context — per-workspace config cannot be shared between workspaces whatever the entry claims; read it off the context instead",
    });
  }

  return { bindings, problems };
}

// ---- the graph -----------------------------------------------------------------------

// Does the constructor still answer to exactly the methods this file checks against? If
// somebody adds a `values()` to the handle, every `cache` verdict silently widens — so
// the handle is built and asked, rather than described here.
export function checkCacheApi() {
  const handle = tenantCache("lint-probe");
  const actual = Object.keys(handle).sort();
  const declared = [...TENANT_CACHE_KEYED_METHODS, ...TENANT_CACHE_WHOLE_METHODS].sort();
  if (actual.join(",") === declared.join(",")) return [];
  return [{
    kind: "cache-api-drift", module: CACHE_MODULE, name: "tenantCache", line: 0,
    message:
      `the handle answers to [${actual.join(", ")}] but ${CACHE_MODULE} declares [${declared.join(", ")}]. ` +
      "Every `cache` verdict is read off those two lists, so a method that is on neither is a way to touch a cache " +
      "this lint has no opinion about — put it on the keyed list or the whole-cache list",
  }];
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

  const problems = [...checkCacheApi()];
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
          ? "Adding one is adding a slot two workspaces share — the shape every closed cross-tenant leak had. If it is " +
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
  const root = opt("--root", path.dirname(path.dirname(fileURLToPath(import.meta.url))));
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
    const counts = { cache: 0, frozen: 0, unkeyed: 0 };
    for (const b of bindings) counts[ALLOWED[b.module][b.name].kind]++;
    console.log(
      `${modules.length} modules reachable from ${entry}: ${bindings.length} module-scope bindings, all accounted ` +
        `for — ${counts.cache} caches built by tenantCache and keyed at every access, ${counts.frozen} frozen ` +
        `tables, ${counts.unkeyed} shared slots (budget ${UNKEYED_BUDGET}), no tenant config`,
    );
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
