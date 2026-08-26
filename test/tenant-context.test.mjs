// The tenant context's shape, and the guard that keeps it honest.
//
// The threading sweep converts ~110 implicit reads of module-scope config globals into
// reads of one per-request value. The failure mode that would survive every other test is
// INCOMPLETENESS: thread 27 of 28 globals and the 28th stays module-scope, still shared
// between tenants, still wrong — with the whole suite green, because nothing in a
// single-tenant era can observe it. The guard for that is scripts/no-tenant-globals.mjs,
// which reads the worker's own source and refuses to pass on a global it has never been
// told about. It is a script rather than only a test because a live deploy is gated on
// the `check` workflow, not on the test suite; the tests below exercise the same checker
// so a local `npm test` reports the same answer CI will.

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
import { ALLOWED, checkWorkerGlobals } from "../scripts/no-tenant-globals.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = readFileSync(join(HERE, "..", "src", "_worker.js"), "utf8");

const report = (problems) => problems.map((p) => `${p.kind}:${p.name}`);

test("every module-scope binding in the worker is on the allowlist, with a reason", () => {
  const { bindings, problems } = checkWorkerGlobals(WORKER);
  // A floor, not a count — the list SHRINKS as state moves onto the context, so a target
  // number here would have to be edited by every commit that improves things. What it
  // guards is the scan silently reading nothing: an empty or wrong file passes every other
  // assertion in this test, because a file with no globals has no unlisted ones.
  assert.ok(bindings.length > 10, `expected to find the worker's globals, found ${bindings.length}`);
  assert.deepEqual(
    report(problems),
    [],
    problems.map((p) => `${p.name}: ${p.message}`).join("\n"),
  );
  for (const [name, entry] of Object.entries(ALLOWED)) {
    assert.ok(entry.why && entry.why.length > 10, `${name} is allowlisted without a reason`);
  }
});

test("the guard can actually fire — a new global is reported, not shrugged off", () => {
  // Proving the guard is capable of failing, per the plan's rule that a guard which
  // cannot fire is worse than no guard. A `let`, a mutable-container `const` and a second
  // binding smuggled onto an existing line all have to be caught.
  assert.deepEqual(
    report(checkWorkerGlobals("let SOMETHING_UNTHREADED = [];\n" + WORKER).problems),
    ["unlisted:SOMETHING_UNTHREADED"],
  );
  assert.deepEqual(
    report(checkWorkerGlobals("const SNEAKY = new Map();\n" + WORKER).problems),
    ["unlisted:SNEAKY"],
  );
  assert.deepEqual(
    report(checkWorkerGlobals(WORKER.replace("let cfgAt = 0;", "let cfgAt = 0, SNEAKY = [];")).problems),
    ["multi:cfgAt"],
  );
});

test("a const that holds no state is not flagged — the lint stays usable", () => {
  const noise = 'const A_NUMBER = 42;\nconst A_STRING = "x";\nconst A_FN = (x) => ({ x });\n';
  assert.deepEqual(report(checkWorkerGlobals(noise + WORKER).problems), []);
});

test("the allowlist shrinks with the sweep — a threaded-away global cannot linger on it", () => {
  // Each thread-* commit deletes a `let` from the worker AND its line here. Without this
  // direction the list would rot into standing permission for whatever gets added later.
  const threaded = WORKER.replace("let pitiRemarksRaw = null;", "");
  assert.deepEqual(report(checkWorkerGlobals(threaded).problems), ["stale:pitiRemarksRaw"]);
});

test("no allowlist entry names a field of the tenant context", () => {
  // The sweep is done, so this is the way back in: not a new name, but a threaded field
  // re-declared at module scope with a plausible cache reason attached. A per-workspace
  // field cannot be tenant-invariant, so the entry is refused whatever it claims.
  for (const name of Object.keys(ALLOWED)) {
    assert.ok(
      !TENANT_FIELD_NAMES.includes(name),
      `${name} is a tenant-context field and cannot be allowlisted as shared state`,
    );
  }
});

test("re-admitting a threaded field is reported, however good the reason reads", () => {
  // The guard above checks today's list; this one proves the checker fires, by asking it
  // about a list that has let one back in.
  const readmitted = checkWorkerGlobals(WORKER, {
    allowed: { ...ALLOWED, USERS: { kind: "cache", why: "a plausible-sounding memo" } },
  }).problems;
  assert.deepEqual(report(readmitted), ["stale:USERS", "readmitted:USERS"]);
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
