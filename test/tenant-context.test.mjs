// The tenant context's shape, and the guard that keeps it honest.
//
// The threading sweep converted ~110 implicit reads of module-scope config globals into
// reads of one per-request value. The failure mode that would survive every other test is
// INCOMPLETENESS: thread 27 of 28 globals and the 28th stays module-scope, still shared
// between tenants, still wrong — with the whole suite green, because nothing in a
// single-tenant era can observe it. The guard for that is scripts/no-tenant-globals.mjs,
// which walks the module graph the worker pulls into the isolate and refuses to pass on a
// global it has never been told about — in ANY of those modules, since module scope is
// per isolate and a `let` one import away is shared exactly as widely. It is a script
// rather than only a test because a live deploy is gated on the `check` workflow, not on
// the test suite; the tests below exercise the same checker so a local `npm test` reports
// the same answer CI will.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  TENANT_FIELD_NAMES,
  TENANT_FIELD_SOURCES,
  emptyTenantContext,
  buildTenantContext,
  instanceFields,
  routingFields,
  withTenantFields,
  createTenantContextCache,
} from "../src/tenant-context.mjs";
import {
  ALLOWED,
  ENTRY,
  KINDS,
  UNKEYED_BUDGET,
  checkCacheApi,
  checkGraph,
  checkModuleGlobals,
  discoverModules,
} from "../scripts/no-tenant-globals.mjs";
import {
  tenantCache,
  TENANT_CACHE_KEYED_METHODS,
  TENANT_CACHE_WHOLE_METHODS,
} from "../src/tenant-cache.mjs";
import { __testables as W } from "../src/_worker.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
// The DEPLOY entry and the module that holds the worker's globals are two different files
// since the plain-Worker split: `ENTRY` is src/entry.js, a four-line export manifest with
// no module scope of its own, and every binding this file exercises lives in the module it
// imports. Looking the allowlist up by ENTRY silently returned nothing and reported every
// real global as unlisted, which is a loud failure — but the same conflation in the other
// direction (pointing the lint at _worker.js while the deploy bundles entry.js) would have
// been a silent one, so keep the two names apart.
const WORKER_MODULE = "src/_worker.js";
const WORKER = readFileSync(join(ROOT, "src", "_worker.js"), "utf8");
const WORKER_ALLOWED = ALLOWED[WORKER_MODULE];

const report = (problems) => problems.map((p) => `${p.kind}:${p.name}`);
const inWorker = (source, allowed = WORKER_ALLOWED) =>
  report(checkModuleGlobals(source, { allowed }).problems);

test("every module-scope binding the worker pulls in is accounted for", () => {
  const { modules, bindings, problems } = checkGraph(ROOT);
  assert.deepEqual(
    problems.map((p) => `${p.module}:${p.kind}:${p.name}`),
    [],
    problems.map((p) => `${p.module}: ${p.name}: ${p.message}`).join("\n"),
  );
  // Floors, not counts — both lists SHRINK as state moves onto the context, so a target
  // number would have to be edited by every commit that improves things. What they guard
  // is the scan silently reading nothing: an empty graph, or a module read as empty,
  // passes every other assertion here, because a file with no globals has no unlisted ones.
  assert.ok(modules.includes(ENTRY), `the entry itself must be scanned, got ${modules}`);
  assert.ok(modules.length > 1, `expected the worker's imports to be scanned too, got ${modules}`);
  assert.ok(bindings.length > 10, `expected to find the worker's globals, found ${bindings.length}`);
  for (const [mod, entries] of Object.entries(ALLOWED)) {
    for (const [name, entry] of Object.entries(entries)) {
      assert.ok(KINDS.includes(entry.kind), `${mod}: ${name} has kind "${entry.kind}", not one of ${KINDS}`);
    }
  }
});

test("there is nowhere on the list to write a reason, except the quarantine", () => {
  // THE FAILURE THAT OUTLIVED TWO REBUILDS. Every closed leak was ON the list, under a
  // sentence asserting the safety it did not have, and no checker can tell whether a
  // sentence is true. The answer is structural rather than editorial: `cache` and
  // `frozen` are ARRAYS OF NAMES, so the field a false claim would live in does not
  // exist. Prose survives only where a slot's danger genuinely cannot be checked — and
  // that place is capped by a number.
  for (const [mod, entries] of Object.entries(ALLOWED)) {
    for (const [name, entry] of Object.entries(entries)) {
      if (entry.kind === "unkeyed") {
        assert.ok(entry.why && entry.why.length > 10, `${mod}: ${name} is quarantined without saying what it holds`);
        assert.ok(entry.proof, `${mod}: ${name} is quarantined without a proof`);
        continue;
      }
      assert.equal(entry.why, undefined, `${mod}: ${name} carries a reason — a ${entry.kind} entry is decided by the code`);
      assert.equal(entry.proof, undefined, `${mod}: ${name} carries a proof — only the quarantine is charged one`);
    }
  }
});

test("the unkeyed quarantine is exactly the size the budget says", () => {
  // The one number in the lint that is EXACT rather than a floor. Every entry under
  // `unkeyed` is a slot the whole isolate shares — the shape every reproduced cross-tenant
  // leak had — so closing one has to lower this line and opening one has to raise it. A
  // floor would let the category quietly refill as threading emptied it.
  const { unkeyed } = checkGraph(ROOT);
  assert.equal(
    unkeyed, UNKEYED_BUDGET,
    `${unkeyed} unkeyed slots on the list, UNKEYED_BUDGET says ${UNKEYED_BUDGET} — move the number, in this commit`,
  );
});

test("the guard can actually fire — a new global is reported, not shrugged off", () => {
  // Proving the guard is capable of failing, per the plan's rule that a guard which
  // cannot fire is worse than no guard. A `let`, a mutable-container `const`, a container
  // whose value sits on the next line, an EXPORTED binding, and a second binding smuggled
  // onto an existing line all have to be caught.
  assert.deepEqual(inWorker("let SOMETHING_UNTHREADED = [];\n" + WORKER), ["unlisted:SOMETHING_UNTHREADED"]);
  assert.deepEqual(inWorker("const SNEAKY = new Map();\n" + WORKER), ["unlisted:SNEAKY"]);
  assert.deepEqual(inWorker("const WRAPPED =\n  new Map();\n" + WORKER), ["unlisted:WRAPPED"]);
  // Exporting state shares it exactly as widely as keeping it private, so `export` in
  // front must not be a way past the scan.
  assert.deepEqual(inWorker("export let SHARED_OUT = [];\n" + WORKER), ["unlisted:SHARED_OUT"]);
  assert.deepEqual(
    inWorker(WORKER.replace("let cfgAt = 0;", "let cfgAt = 0, SNEAKY = [];")),
    ["multi:cfgAt"],
  );
});

// ---- what counts as state is an ALLOWLIST of harmless shapes ------------------------
//
// The bypass that made this necessary: `const REGISTRY_SLOT = makeSlot()` — a factory
// returning a get/put pair over a `let` inside the factory. The old scanner asked "is
// this initializer one of the mutable shapes I know?" (array, object, `new Map`), a call
// is none of them, and the binding was not merely allowed — it was never counted. A
// factory is the one thing every state-hiding trick has in common, so the question is now
// the other way round: what is PROVABLY not state?

test("a const whose value comes from a CALL is state — the bypass that was invisible", () => {
  const slot = [
    "function makeSlot() {",
    "  let v = null;",
    "  return { get: () => v, put: (x) => { v = x; return x; } };",
    "}",
    "const REGISTRY_SLOT = makeSlot();",
    "",
  ].join("\n");
  assert.deepEqual(inWorker(slot + WORKER), ["unlisted:REGISTRY_SLOT"]);
  // The same, one import away, and through every plausible dressing-up.
  for (const init of ["makeSlot()", "build().slot", "await load()", "cache || makeSlot()", "new Holder()"]) {
    assert.deepEqual(
      check(`const X = ${init};\n`, {}), ["unlisted:X"],
      `${init} was not counted as state`,
    );
  }
  // And listing it does not help: neither structural kind will have it.
  assert.deepEqual(check("const X = makeSlot();\n", { X: { kind: "cache" } }), ["cache-not-constructed:X"]);
  assert.deepEqual(check("const X = makeSlot();\n", { X: { kind: "frozen" } }), ["frozen-not-frozen:X"]);
});

test("a const that holds no state is not flagged — the lint stays usable", () => {
  const noise = [
    'const A_NUMBER = 42;',
    'const SOME_MATH = 60 * 60 * 24 * 7;',
    'const A_STRING = "x";',
    'const A_TEMPLATE = `a${1 + 1}b`;',
    'const A_REGEX = /^\\/tracks\\/[^?]+$/i;',
    'const A_SYMBOL = Symbol("unresolved");',
    'const A_FN = (x) => ({ x });',
    'const A_FUNCTION = function (x) { return x; };',
    // A call to a same-module arrow whose body is a string returns a string, and a string
    // is not state. The body has to START with a quote, so a block-bodied factory — which
    // is what a slot hides in — is not one of these.
    'const ic = (inner) => `<svg>${inner}</svg>`;',
    'const IC_HOME = ic(`<rect/>`);',
    '',
  ].join("\n");
  assert.deepEqual(inWorker(noise + WORKER), []);
});

test("the allowlist shrinks with the sweep — a threaded-away global cannot linger on it", () => {
  // Each thread-* commit deletes a binding from the worker AND its line here. Without this
  // direction the list would rot into standing permission for whatever gets added later.
  assert.deepEqual(
    inWorker(WORKER.replace('const PITI_REMARKS = tenantCache("piti-remarks", { max: PITI_REMARKS_CACHE_MAX });', "")),
    ["stale:PITI_REMARKS"],
  );
});

test("no allowlist entry names a field of the tenant context", () => {
  // The sweep is done, so this is the way back in: not a new name, but a threaded field
  // re-declared at module scope with a plausible cache reason attached. A per-workspace
  // field cannot be a fixed table, so the entry is refused whatever it claims.
  for (const [mod, entries] of Object.entries(ALLOWED)) {
    for (const name of Object.keys(entries)) {
      assert.ok(
        !TENANT_FIELD_NAMES.includes(name),
        `${mod}: ${name} is a tenant-context field and cannot be allowlisted as shared state`,
      );
    }
  }
});

test("re-admitting a threaded field is reported, however good the reason reads", () => {
  // The guard above checks today's list; this one proves the checker fires, by asking it
  // about a list that has let one back in.
  assert.deepEqual(
    inWorker(WORKER, { ...WORKER_ALLOWED, USERS: { kind: "unkeyed", why: "a plausible-sounding memo", proof: "x" } }),
    ["stale:USERS", "readmitted:USERS"],
  );
});

// ---- the safe thing is the only expressible thing -----------------------------------
//
// `cache` is not "a Map I have inspected the accesses of". It is "built by tenantCache",
// whose handle holds its Map in a closure: there is no iterator, no `values()`, no way to
// pass the container anywhere, and every method that reaches a value takes the workspace
// first and refuses a call without one. The lint's job shrinks to checking that the
// declaration IS that call and that the keys are workspace ids.

const CACHED = { kind: "cache" };
const FROZEN = { kind: "frozen" };
const check = (source, allowed) => report(checkModuleGlobals(source, { allowed }).problems);
const IMPORT = 'import { tenantCache } from "./tenant-cache.mjs";\n';

test("a listed cache that is not built by the constructor is refused", () => {
  // THE AVATAR LEAK, in miniature: one slot holding the hash set the UNGATED /__avatar/
  // route would serve, rebuilt by whichever workspace loaded config last — on the list
  // under the sentence quoted here. `readmitted` fires alongside because the fix made
  // AVATAR_KEYS a context field, but the FIRST verdict is the one that would have been
  // available before anyone knew it was a leak.
  const source = IMPORT + "let AVATAR_KEYS = new Set();\nfunction load(u, i) { AVATAR_KEYS = keysFrom(u, i); }\n";
  assert.deepEqual(check(source, { AVATAR_KEYS: CACHED }), ["cache-not-constructed:AVATAR_KEYS", "readmitted:AVATAR_KEYS"]);
  // A raw Map is refused too: it was the previous generation's "safe" shape, and it is
  // safe only for as long as someone reads every access.
  assert.deepEqual(check(IMPORT + "const M = new Map();\n", { M: CACHED }), ["cache-not-constructed:M"]);
  // A clock and the document behind it, the board/remark leak's shape. There is
  // deliberately no "it's only a clock" kind — canvasRegAt was only a clock, and it is
  // what made the stale document answer.
  assert.deepEqual(
    check(IMPORT + "let canvasRegAt = 0;\nlet canvasRegRaw = null;\n", { canvasRegAt: CACHED, canvasRegRaw: CACHED }),
    ["cache-not-constructed:canvasRegAt", "cache-not-constructed:canvasRegRaw"],
  );
});

test("a local function called tenantCache does not make a cache", () => {
  // The name is only a claim in a module that imports the real one.
  assert.deepEqual(
    check('const M = tenantCache("m");\nfunction tenantCache() { return {}; }\n', { M: CACHED }),
    ["cache-not-imported:M"],
  );
  assert.deepEqual(check(IMPORT + 'const M = tenantCache("m");\n', { M: CACHED }), []);
});

test("a cache touched without a workspace key is refused, and an alias is not a key", () => {
  const decl = IMPORT + 'const M = tenantCache("m");\n';
  // A literal key: a cache with one hard-coded key is a slot with extra syntax.
  assert.deepEqual(check(decl + 'function a() { return M.get("alpha"); }\n', { M: CACHED }), ["cache-bad-key:M"]);
  // THE BYPASS. A local assigned from a tenant id SOMEWHERE in the module used to make
  // that NAME trusted EVERYWHERE in it — so a second `const key = "everyone"` in another
  // function passed. Aliases are gone: the key has to say `tenantId` at the access.
  const aliased = decl +
    "function fill(tctx, v) { const key = tctx.tenantId; M.put(key, v); }\n" +
    'function leak() { const key = "everyone"; return M.get(key); }\n';
  assert.deepEqual(check(aliased, { M: CACHED }), ["cache-bad-key:M", "cache-bad-key:M"]);
  // A key the scanner cannot trace to a workspace. Refusing it is the point: an
  // identifier that merely LOOKS like a workspace is the same kind of evidence as a
  // sentence.
  assert.deepEqual(check(decl + "function a(o) { return M.get(o.spaceId); }\n", { M: CACHED }), ["cache-bad-key:M"]);
  // A method the handle does not have. It would throw at runtime (the handle is frozen),
  // and this lint has no opinion about what it does — so it says so rather than passing.
  assert.deepEqual(check(decl + "function a() { return [...M.values()]; }\n", { M: CACHED }), ["cache-unknown-method:M"]);
  assert.deepEqual(check(decl + "function a(f) { M.forEach(f); }\n", { M: CACHED }), ["cache-unknown-method:M"]);
  // Handing the handle somewhere hands over every workspace's entry to whatever that
  // place does with it.
  assert.deepEqual(check(decl + "function a() { return dump(M); }\n", { M: CACHED }), ["cache-escapes:M"]);
  assert.deepEqual(check(decl + "function a() { return [...M]; }\n", { M: CACHED }), ["cache-escapes:M"]);
});

test("the cache rule passes the idioms the worker actually uses", () => {
  // The other direction, so the rule is a check and not a ban.
  const source = [
    IMPORT.trim(),
    'const M = tenantCache("m", { max: 256 });',
    "function read(tenantId) { return M.get(tenantId); }",
    "function fill(tctx, v) { M.put(tctx.tenantId, v); }",
    "function start(ctx) { return M.entry(ctx.tenantId, () => ({ at: 0, docs: null })); }",
    "function forget(tctx, e) { M.drop(tctx.tenantId, e); }",
    "function bust(tenantId) { M.bust(tenantId); }",
    "function reset() { M.clear(); }",
    "function hook({ M: m }) { if (!m) M.clear(); }",
  ].join("\n");
  assert.deepEqual(check(source + "\n", { M: CACHED }), []);
});

test("the handle's methods are the ones the lint checks against, or the lint says so", () => {
  // Every `cache` verdict is read off the two lists src/tenant-cache.mjs exports. A
  // method that is on neither would be a way to touch a cache this lint has no opinion
  // about, so the handle is BUILT and asked rather than described here.
  assert.deepEqual(checkCacheApi(), []);
  const handle = tenantCache("probe");
  assert.deepEqual(
    Object.keys(handle).sort(),
    [...TENANT_CACHE_KEYED_METHODS, ...TENANT_CACHE_WHOLE_METHODS].sort(),
  );
});

test("a fixed table has to be frozen, and a frozen Set is not one", () => {
  // THE THIRD BYPASS: `VALID_STATUS[url.pathname] ??= await …`, a per-request write into
  // a table the list called invariant. The old check scanned for write SHAPES and knew
  // about `=` but not `??=`. Freezing moves the check to the declaration — one site — and
  // hands enforcement to the engine, which knows about every write form there is.
  assert.deepEqual(check("const T = {};\n", { T: FROZEN }), ["frozen-not-frozen:T"]);
  assert.deepEqual(check("const T = [];\n", { T: FROZEN }), ["frozen-not-frozen:T"]);
  assert.deepEqual(check("const T = Object.freeze({ a: 1 });\n", { T: FROZEN }), []);
  assert.deepEqual(check("const T = Object.freeze([1, 2]);\n", { T: FROZEN }), []);
  // A rebindable name is not a table, whatever its current value is frozen.
  assert.deepEqual(check("let T = Object.freeze({});\n", { T: FROZEN }), ["frozen-not-const:T"]);
  // And a frozen collection is a table with a lock painted on it — Object.freeze does not
  // reach a Map's or a Set's contents.
  for (const c of ["Map", "Set", "WeakMap", "WeakSet"]) {
    assert.deepEqual(
      check(`const T = Object.freeze(new ${c}());\n`, { T: FROZEN }), ["frozen-collection:T"],
      `a frozen ${c} was accepted as a fixed table`,
    );
  }
});

test("the freeze is what stops the write, not the lint", () => {
  // The point of moving to a constructor: the guarantee survives a lint that is not
  // looking. Every write form at once, against a real frozen table.
  const T = Object.freeze({ "in-progress": 1 });
  const writes = [
    () => { T["/x"] ??= 1; },
    () => { T["/x"] = 1; },
    () => { T.ready = true; },
    () => { T["in-progress"] += 1; },
    () => { Object.assign(T, { x: 1 }); },
  ];
  for (const w of writes) assert.throws(w, TypeError);
  assert.deepEqual(Object.keys(T), ["in-progress"]);
  // And the shipped tables really are frozen, not merely listed as such.
  for (const name of ["ROLES", "MCP_PROXY_PATHS", "AVATAR_MIMES"]) {
    assert.ok(Object.isFrozen(W[name]), `${name} is on the frozen list but is not frozen`);
  }
});

test("each direction fires against the REAL worker, not only against a fixture", () => {
  // The cases above are small fixtures, and a fixture cannot tell a scanner that reaches
  // src/_worker.js from one that matches nothing in it. So: sabotage the real file, one
  // edit at a time, and require the matching verdict. A regex that stops finding the
  // worker's own idioms would otherwise report an empty problem list — which is what green
  // looks like.
  const sabotage = {
    "cache-bad-key:MANIFESTS": [
      "const cur = MANIFESTS.get(tenantId) || { at: 0, spaces: {}, etags: {}, filled: false };",
      'const cur = MANIFESTS.get("one") || { at: 0, spaces: {}, etags: {}, filled: false };',
    ],
    "cache-unknown-method:STORAGE_CACHE": [
      "const hit = STORAGE_CACHE.get(tenantId);", "const hit = [...STORAGE_CACHE.values()][0];",
    ],
    "cache-escapes:MANIFESTS": [
      "const cur = MANIFESTS.get(tenantId) || { at: 0, spaces: {}, etags: {}, filled: false };",
      "const cur = pick(MANIFESTS, tenantId) || { at: 0, spaces: {}, etags: {}, filled: false };",
    ],
    "cache-not-constructed:CANVAS_REGISTRY": [
      'const CANVAS_REGISTRY = tenantCache("canvas-registry", { max: CANVAS_REG_CACHE_MAX });',
      "let CANVAS_REGISTRY = null;",
    ],
    "frozen-not-frozen:ROLES": [
      'const ROLES = Object.freeze(["admin", "editor", "viewer"]);',
      'const ROLES = ["admin", "editor", "viewer"];',
    ],
    // The factory bypass, against the real file: invisible to the previous scanner.
    "unlisted:REGISTRY_SLOT": [
      'const CANVAS_REGISTRY = tenantCache("canvas-registry", { max: CANVAS_REG_CACHE_MAX });',
      'const REGISTRY_SLOT = makeSlot();\nconst CANVAS_REGISTRY = tenantCache("canvas-registry", { max: CANVAS_REG_CACHE_MAX });',
    ],
  };
  assert.deepEqual(inWorker(WORKER), [], "the real worker must be clean before anything is sabotaged");
  for (const [expected, [from, to]] of Object.entries(sabotage)) {
    assert.ok(WORKER.includes(from), `the sabotage anchor "${from}" is no longer in the worker — update this case`);
    assert.deepEqual(
      inWorker(WORKER.replace(from, to)), [expected],
      `sabotaging "${from}" did not produce ${expected}`,
    );
  }
});

// ---- the graph: state one import away is state all the same -------------------------

// These graph tests describe a SHAPE rooted at the worker itself, not today's deploy
// entry — the walker's behaviour is what is under test, and src/entry.js is a four-line
// re-export that would add a hop and nothing else. Named explicitly so the fixtures do
// not silently follow a future entry rename. That the REAL graph starts at the real entry
// is asserted separately, against the real repo, at the top of this file.
const FAKE_ENTRY = "src/_worker.js";

// A fake repo, so the graph tests describe a shape rather than today's file list.
const fakeRepo = (files) => ({
  read: (p) => {
    const rel = p.slice(String(p).indexOf("/root/") + "/root/".length);
    if (!(rel in files)) throw new Error(`no such module: ${rel}`);
    return files[rel];
  },
});

test("the scan follows the worker's relative imports, and stops at bare specifiers", () => {
  const { read } = fakeRepo({
    "src/_worker.js": 'import { a } from "./lib/a.mjs";\nimport fs from "node:fs";\nimport x from "some-dep";\n',
    "src/lib/a.mjs": 'export { b } from "../deep/b.js";\n',
    "src/deep/b.js": "export const b = 1;\n",
  });
  assert.deepEqual(
    discoverModules("/root/src/_worker.js", "/root", read),
    ["src/_worker.js", "src/lib/a.mjs", "src/deep/b.js"],
  );
});

test("state moved one import away is caught — the hole this lint used to have", () => {
  // The lint read the worker and nothing else, so a `let` in a module the worker imports
  // was shared between every request in the isolate and reported by nobody. Moving state
  // out of the scanned file must not be a way to keep it.
  const { read } = fakeRepo({
    "src/_worker.js": 'import { s } from "./state.mjs";\n',
    "src/state.mjs": "export let PER_ISOLATE = new Map();\n",
  });
  const { modules, problems } = checkGraph("/root", { read, entry: FAKE_ENTRY, allowed: { "src/_worker.js": {} } });
  assert.deepEqual(modules, ["src/_worker.js", "src/state.mjs"]);
  assert.deepEqual(
    problems.map((p) => `${p.module}:${p.kind}:${p.name}`),
    ["src/state.mjs:unlisted:PER_ISOLATE"],
  );
});

test("a brand-new module allows nothing until somebody writes the claim down", () => {
  // No section means an EMPTY allowlist, never a skipped file. A lint that had to be told
  // about a module before it would check it would be answered by not telling it.
  const { read } = fakeRepo({
    "src/_worker.js": 'import { s } from "./new.mjs";\nconst TABLE = Object.freeze([]);\n',
    "src/new.mjs": "let anything = null;\n",
  });
  const { problems } = checkGraph("/root", {
    read,
    entry: FAKE_ENTRY,
    allowed: { "src/_worker.js": { TABLE: { kind: "frozen" } } },
  });
  assert.deepEqual(
    problems.map((p) => `${p.module}:${p.kind}:${p.name}`),
    ["src/new.mjs:unlisted:anything"],
  );
});

test("a section outliving its module is reported, like a stale entry one level up", () => {
  const { read } = fakeRepo({ "src/_worker.js": "const TABLE = Object.freeze([]);\n" });
  const { problems } = checkGraph("/root", {
    read,
    entry: FAKE_ENTRY,
    allowed: {
      "src/_worker.js": { TABLE: { kind: "frozen" } },
      "src/gone.mjs": { OLD: { kind: "frozen" } },
    },
  });
  assert.deepEqual(
    problems.map((p) => `${p.module}:${p.kind}:${p.name}`),
    ["src/gone.mjs:unreachable:(module)"],
  );
});

// ---- the quarantine, charged --------------------------------------------------------
//
// `unkeyed` is the one kind with nothing structural to check — being a bare slot IS what
// it declares. So it is charged instead: a proof that resolves, and a budget that is
// exact. The proof proves the POINTER, never that the case asserts anything; what it
// really buys is that deleting or renaming the harness turns this red, which no sentence
// can do. The budget is what makes the category shrink.

const quarantine = (entry, extraFiles = {}) => {
  const { read } = fakeRepo({
    "src/_worker.js": "let slot = null;\n",
    ...extraFiles,
  });
  return checkGraph("/root", { read, entry: FAKE_ENTRY, allowed: { "src/_worker.js": { slot: entry } }, budget: 1 })
    .problems.map((p) => `${p.kind}:${p.name}`);
};

const HARNESS = { "test/two-workspaces.test.mjs": "// alpha, then beta, both asked at slot\n" };

test("an unkeyed slot must point at a proof that exists and speaks its name", () => {
  const why = "one slot for the isolate";
  assert.deepEqual(quarantine({ kind: "unkeyed", why, proof: "test/two-workspaces.test.mjs" }, HARNESS), []);
  assert.deepEqual(quarantine({ kind: "unkeyed", why }, HARNESS), ["no-proof:slot"]);
  // A harness that was deleted or renamed out from under the entry.
  assert.deepEqual(quarantine({ kind: "unkeyed", why, proof: "test/gone.test.mjs" }, HARNESS), ["proof-missing:slot"]);
  // A file that exists but never mentions the binding — a pointer at nothing in particular.
  assert.deepEqual(
    quarantine({ kind: "unkeyed", why, proof: "test/quiet.test.mjs" }, { "test/quiet.test.mjs": "// about something else\n" }),
    ["proof-silent:slot"],
  );
});

test("the budget is exact — a slot added and a slot closed both have to move the number", () => {
  const entry = { kind: "unkeyed", why: "one slot for the isolate", proof: "test/two-workspaces.test.mjs" };
  const { read } = fakeRepo({ "src/_worker.js": "let slot = null;\n", ...HARNESS });
  const at = (budget) =>
    checkGraph("/root", { read, entry: FAKE_ENTRY, allowed: { "src/_worker.js": { slot: entry } }, budget })
      .problems.map((p) => `${p.kind}:${p.name}`);
  assert.deepEqual(at(1), []);
  assert.deepEqual(at(0), ["budget:UNKEYED_BUDGET"], "adding a shared slot must not be free");
  assert.deepEqual(at(2), ["budget:UNKEYED_BUDGET"], "closing a shared slot must lower the number, not bank it");
});

test("two contexts share no mutable value — the leak this phase exists to close", () => {
  const a = emptyTenantContext("alpha");
  const b = emptyTenantContext("beta");

  for (const name of TENANT_FIELD_NAMES) {
    const va = a[name];
    const vb = b[name];
    if (va !== null && typeof va === "object") {
      assert.notEqual(va, vb, `${name} is SHARED between two contexts — defaults must be factories`);
    }
  }

  // And concretely: one workspace's Set must not grow another's.
  a.SPACE_ICON_KEYS.add("deadbeef");
  assert.equal(b.SPACE_ICON_KEYS.has("deadbeef"), false);
  a.SPACES.push({ id: "alpha" });
  assert.deepEqual(b.SPACES, []);
});

test("CONFIG_LOADED defaults false, and only an applied instance document sets it true", () => {
  assert.equal(emptyTenantContext().CONFIG_LOADED, false);
  assert.equal(buildTenantContext("t").CONFIG_LOADED, false);
  // routing alone must NOT claim config is loaded — a cold isolate that read routing.json
  // but failed on instance.json still has no identity and must fail closed.
  assert.equal(buildTenantContext("t", { routing: { buildId: "x" } }).CONFIG_LOADED, false);
  assert.equal(buildTenantContext("t", { instance: { users: [] } }).CONFIG_LOADED, true);
});

test("the context is frozen — a cross-request write throws instead of corrupting", () => {
  const ctx = emptyTenantContext("alpha");
  assert.throws(() => { ctx.USERS = [{ email: "someone@example.com" }]; }, TypeError);
  assert.throws(() => { ctx.CONFIG_LOADED = true; }, TypeError);
  assert.deepEqual(ctx.USERS, []);
  assert.equal(ctx.CONFIG_LOADED, false);
});

test("instanceFields reproduces applyInstance's coercions exactly", () => {
  const full = instanceFields({
    users: [{ email: "a@example.com" }],
    engineVersion: "0.14.0",
    updateFeed: "https://example.invalid/feed",
    mcpHostSuffixes: [".example.invalid"],
    mcpHostAllowlistUrl: "https://example.invalid/hosts.json",
    vanityRedirects: { "/x": "/y" },
    rtOrigin: "https://rt.example.invalid",
    sentinels: ["/keep/"],
    minClientProtocol: 5,
    loginHint: "hint",
    loginPrefill: { email: "demo@example.invalid", password: "pw" },
  });
  assert.deepEqual(full.CONFIG_USERS, [{ email: "a@example.com" }]);
  assert.deepEqual(full.USERS, full.CONFIG_USERS);
  assert.equal(full.MIN_CLIENT_PROTOCOL, 5);
  assert.equal(full.LOGIN_PREFILL_EMAIL, "demo@example.invalid");
  assert.equal(full.CONFIG_LOADED, true);

  // The coercions are the load-bearing half: a non-array users, a zero/negative/
  // non-integer protocol floor, a non-string hint, a non-object prefill.
  const junk = instanceFields({
    users: "nope",
    sentinels: "nope",
    minClientProtocol: 0,
    loginHint: 42,
    loginPrefill: "nope",
  });
  assert.deepEqual(junk.CONFIG_USERS, []);
  assert.deepEqual(junk.INSTANCE_SENTINELS, []);
  assert.equal(junk.MIN_CLIENT_PROTOCOL, 0);
  assert.equal(junk.LOGIN_HINT, "");
  assert.equal(junk.LOGIN_PREFILL_EMAIL, "");

  assert.equal(instanceFields({ minClientProtocol: -3 }).MIN_CLIENT_PROTOCOL, 0);
  assert.equal(instanceFields({ minClientProtocol: 2.5 }).MIN_CLIENT_PROTOCOL, 0);
  assert.equal(instanceFields(null).CONFIG_LOADED, true); // an empty doc still counts as applied
});

test("routingFields derives mcpStaticHosts from the allowlist it shipped with", () => {
  const f = routingFields({ mcpAllowlist: ["a.example.invalid", "b.example.invalid"] });
  assert.deepEqual(f.MCP_HOST_ALLOWLIST, ["a.example.invalid", "b.example.invalid"]);
  assert.equal(f.mcpStaticHosts.has("a.example.invalid"), true);
  assert.equal(f.mcpStaticHosts.has("c.example.invalid"), false);

  const empty = routingFields({});
  assert.equal(empty.BUILD_ID, "dev");
  assert.deepEqual(empty.SPACES, []);
  assert.equal(empty.CHROME_POINTER, null);
  assert.equal(empty.RUNTIME_CHROME, false);
  assert.equal(routingFields({ spaces: "nope" }).SPACES.length, 0);
});

test("a document that did not parse contributes nothing rather than clearing what loaded", () => {
  // The keep-last-good half of the worker's fail-open-stale cache: passing only the
  // document that actually parsed must not blank the other one's fields.
  const ctx = buildTenantContext("t", { instance: { users: [{ email: "a@example.com" }] } });
  assert.equal(ctx.USERS.length, 1);
  assert.equal(ctx.BUILD_ID, "dev"); // routing absent — default, not undefined
  assert.deepEqual(ctx.PUBLIC_PREFIXES, []);
});

test("withTenantFields returns a new frozen context and leaves the original alone", () => {
  const base = buildTenantContext("t", { instance: { users: [{ email: "a@example.com" }] } });
  const next = withTenantFields(base, { USERS: [{ email: "b@example.com" }] });

  assert.equal(next.USERS[0].email, "b@example.com");
  assert.equal(base.USERS[0].email, "a@example.com", "the original context was mutated");
  assert.equal(Object.isFrozen(next), true);
  assert.equal(next.tenantId, "t");
  assert.equal(next.CONFIG_LOADED, true, "unrelated fields carry over");
});

test("withTenantFields refuses an unknown field instead of writing one nothing reads", () => {
  const base = emptyTenantContext("t");
  assert.throws(() => withTenantFields(base, { USERZ: [] }), /unknown field "USERZ"/);
});

test("every field declares where its value comes from", () => {
  for (const name of TENANT_FIELD_NAMES) {
    assert.ok(
      ["instance", "routing", "derived", "runtime"].includes(TENANT_FIELD_SOURCES[name]),
      `${name} has no declared source`,
    );
  }
});

// ---- the per-tenant cache -----------------------------------------------------------

// A controllable clock, so these assert real time semantics instead of sleeping.
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test("one tenant's load does not make another tenant's config look fresh", () => {
  // This is the bug the whole item exists to fix: a single `cfgAt` stamped by workspace
  // A tells workspace B its config is current when B has never been read at all.
  const clock = fakeClock();
  const cache = createTenantContextCache({ now: clock.now });

  cache.stamp("alpha");
  cache.put("alpha", buildTenantContext("alpha", { instance: { users: [] } }));

  assert.equal(cache.due("alpha").due, false, "alpha just loaded — not due");
  assert.equal(cache.due("beta").due, true, "beta has never loaded — MUST be due");
  assert.equal(cache.due("beta").forced, true, "a tenant that never loaded is forced");
  assert.equal(cache.get("beta"), null, "beta must not see alpha's context");
});

test("the TTL is per tenant and expires on its own clock", () => {
  const clock = fakeClock();
  const cache = createTenantContextCache({ ttlMs: 1500, now: clock.now });

  cache.stamp("alpha");
  assert.equal(cache.due("alpha").due, false);
  clock.advance(1499);
  assert.equal(cache.due("alpha").due, false, "still inside the window");
  clock.advance(1);
  assert.equal(cache.due("alpha").due, true, "1500ms elapsed — due again");
});

test("stamp-first: a failing load does not stampede on the next request", () => {
  const clock = fakeClock();
  const cache = createTenantContextCache({ now: clock.now });

  // The worker stamps, then the read throws, so put() is never reached.
  cache.stamp("alpha");
  assert.equal(cache.due("alpha").due, false, "a failed load must not retry immediately");
  assert.equal(cache.get("alpha"), null, "and it stored no context");
});

test("keep-last-good: a failed reload leaves the previous context serving", () => {
  const clock = fakeClock();
  const cache = createTenantContextCache({ now: clock.now });
  const good = buildTenantContext("alpha", { instance: { users: [{ email: "a@example.com" }] } });

  cache.stamp("alpha");
  cache.put("alpha", good);

  clock.advance(2000);
  cache.stamp("alpha"); // the reload is attempted...
  // ...and throws, so put() is never called.
  assert.equal(cache.get("alpha"), good, "a transient failure must not wipe a working gate");
  assert.equal(cache.get("alpha").CONFIG_LOADED, true);
});

test("bust forces a re-read on the next request but keeps the gate serving", () => {
  const clock = fakeClock();
  const cache = createTenantContextCache({ now: clock.now });
  const ctx = buildTenantContext("alpha", { instance: { users: [{ email: "a@example.com" }] } });
  cache.stamp("alpha");
  cache.put("alpha", ctx);

  cache.bust("alpha");
  const due = cache.due("alpha");
  assert.equal(due.due, true, "a busted tenant re-reads at once");
  assert.equal(due.forced, true, "and reports forced — this tenant was busted, not the isolate");
  assert.equal(cache.get("alpha"), ctx, "busting asks for a re-read; it must not blank the gate");
});

test("bustAll busts every tenant and no tenant's context is lost", () => {
  const clock = fakeClock();
  const cache = createTenantContextCache({ now: clock.now });
  for (const id of ["alpha", "beta"]) {
    cache.stamp(id);
    cache.put(id, buildTenantContext(id, { instance: { users: [] } }));
  }
  cache.bustAll();
  for (const id of ["alpha", "beta"]) {
    assert.equal(cache.due(id).forced, true);
    assert.notEqual(cache.get(id), null, `${id} lost its context to a bust`);
  }
});

test("the cache is bounded, and eviction fails CLOSED rather than open", () => {
  const clock = fakeClock();
  const cache = createTenantContextCache({ now: clock.now, max: 3 });

  for (const id of ["a", "b", "c", "d"]) {
    cache.stamp(id);
    cache.put(id, buildTenantContext(id, { instance: { users: [{ email: `${id}@example.com` }] } }));
  }

  assert.equal(cache.size, 3, "the cache must not grow without bound");
  assert.equal(cache.has("a"), false, "the oldest entry was evicted");

  // The safety property: an evicted tenant does not inherit anything. Its next request
  // rebuilds from empty, whose CONFIG_LOADED is false, so the gate fails closed while it
  // reloads. Eviction can cost a read; it must never open a door.
  assert.equal(cache.get("a"), null);
  assert.equal(emptyTenantContext("a").CONFIG_LOADED, false);
  assert.equal(cache.get("d").USERS[0].email, "d@example.com", "the newest is intact");
});

test("a re-put moves a tenant to the back of the eviction queue", () => {
  const clock = fakeClock();
  const cache = createTenantContextCache({ now: clock.now, max: 2 });
  for (const id of ["a", "b"]) {
    cache.stamp(id);
    cache.put(id, buildTenantContext(id, { instance: { users: [] } }));
  }
  cache.put("a", buildTenantContext("a", { instance: { users: [] } })); // a is touched
  cache.stamp("c");
  cache.put("c", buildTenantContext("c", { instance: { users: [] } }));

  assert.equal(cache.has("a"), true, "recently used must survive");
  assert.equal(cache.has("b"), false, "least recently used is the victim");
});
