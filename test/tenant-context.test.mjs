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
  checkGraph,
  checkModuleGlobals,
  discoverModules,
} from "../scripts/no-tenant-globals.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const WORKER = readFileSync(join(ROOT, "src", "_worker.js"), "utf8");
const WORKER_ALLOWED = ALLOWED[ENTRY];

const report = (problems) => problems.map((p) => `${p.kind}:${p.name}`);
const inWorker = (source, allowed = WORKER_ALLOWED) =>
  report(checkModuleGlobals(source, { allowed }).problems);

test("every module-scope binding the worker pulls in is allowlisted, with a reason", () => {
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
      assert.ok(entry.why && entry.why.length > 10, `${mod}: ${name} is allowlisted without a reason`);
    }
  }
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

test("a const that holds no state is not flagged — the lint stays usable", () => {
  const noise = 'const A_NUMBER = 42;\nconst A_STRING = "x";\nconst A_FN = (x) => ({ x });\n';
  assert.deepEqual(inWorker(noise + WORKER), []);
});

test("the allowlist shrinks with the sweep — a threaded-away global cannot linger on it", () => {
  // Each thread-* commit deletes a `let` from the worker AND its line here. Without this
  // direction the list would rot into standing permission for whatever gets added later.
  assert.deepEqual(
    inWorker(WORKER.replace("let pitiRemarksRaw = null;", "")),
    ["stale:pitiRemarksRaw"],
  );
});

test("no allowlist entry names a field of the tenant context", () => {
  // The sweep is done, so this is the way back in: not a new name, but a threaded field
  // re-declared at module scope with a plausible cache reason attached. A per-workspace
  // field cannot be tenant-invariant, so the entry is refused whatever it claims.
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
    inWorker(WORKER, { ...WORKER_ALLOWED, USERS: { kind: "cache", why: "a plausible-sounding memo" } }),
    ["stale:USERS", "readmitted:USERS"],
  );
});

// ---- the graph: state one import away is state all the same -------------------------

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
  const { modules, problems } = checkGraph("/root", { read, allowed: { "src/_worker.js": {} } });
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
    "src/_worker.js": 'import { s } from "./new.mjs";\nlet cfgAt = 0;\n',
    "src/new.mjs": "let anything = null;\n",
  });
  const { problems } = checkGraph("/root", {
    read,
    allowed: { "src/_worker.js": { cfgAt: { kind: "cache", why: "the config clock" } } },
  });
  assert.deepEqual(
    problems.map((p) => `${p.module}:${p.kind}:${p.name}`),
    ["src/new.mjs:unlisted:anything"],
  );
});

test("a section outliving its module is reported, like a stale entry one level up", () => {
  const { read } = fakeRepo({ "src/_worker.js": "let cfgAt = 0;\n" });
  const { problems } = checkGraph("/root", {
    read,
    allowed: {
      "src/_worker.js": { cfgAt: { kind: "cache", why: "the config clock" } },
      "src/gone.mjs": { OLD: { kind: "constant", why: "a module the worker no longer imports" } },
    },
  });
  assert.deepEqual(
    problems.map((p) => `${p.module}:${p.kind}:${p.name}`),
    ["src/gone.mjs:unreachable:(module)"],
  );
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
  assert.equal(due.forced, true, "and reports forced, so dependent reads skip their own clocks");
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
