// The tenant context's shape, and the guard that keeps it honest.
//
// The threading sweep converts ~110 implicit reads of module-scope config globals into
// reads of one per-request value. The failure mode that would survive every other test is
// INCOMPLETENESS: thread 27 of 28 globals and the 28th stays module-scope, still shared
// between tenants, still wrong — with the whole suite green, because nothing in a
// single-tenant era can observe it. The first test below is the guard for that. It reads
// the worker's own source and refuses to pass on a global it has never been told about.

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
} from "../src/tenant-context.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = readFileSync(join(HERE, "..", "src", "_worker.js"), "utf8");

// Module-scope `let`s that are per-isolate RUNTIME CACHES, not tenant config. They are
// not part of the context and are excluded deliberately — each one is a timestamp or a
// memo whose worst behaviour under multi-tenancy is a wasted re-read, not a wrong answer.
// Phase B tenant-keys the ones that cache per-tenant DATA (the manifest and storage
// caches); this list is what `A-ci-lint-no-globals-tighten` later shrinks toward the true
// tenant-invariant set. Adding a name here is a claim that it is safe to share across
// tenants — make it deliberately.
const RUNTIME_CACHES = new Set([
  "cfgAt",            // config TTL stamp
  "rosterReadAt",     // roster read clock
  "rosterCache",      // roster memo
  "MANIFESTS",        // manifest cache — Phase B tenant-keys this
  "STORAGE_CACHE",    // bundle store cache — Phase B tenant-keys this
  "AVATAR_KEYS",      // avatar hash allowlist
  "mcpHostAllowlist", // fetched remote allowlist, time-based cache
  "canvasRegAt",      // canvas registry clock
  "canvasRegRaw",     // canvas registry memo
  "pitiRemarksAt",    // remark poll clock
  "pitiRemarksRaw",   // remark poll memo
]);

test("every module-scope global in the worker is either a context field or a declared runtime cache", () => {
  const declared = [...WORKER.matchAll(/^let\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  assert.ok(declared.length > 20, `expected to find the worker's globals, found ${declared.length}`);

  const unclassified = declared.filter(
    (name) => !TENANT_FIELD_NAMES.includes(name) && !RUNTIME_CACHES.has(name),
  );
  assert.deepEqual(
    unclassified,
    [],
    `unclassified module-scope global(s): ${unclassified.join(", ")}. ` +
      "A new one is either tenant config (add it to FIELDS in src/tenant-context.mjs, " +
      "and thread it) or a per-isolate runtime cache (add it to RUNTIME_CACHES here, " +
      "which asserts it is safe to share across tenants).",
  );
});

test("the guard can actually fire — an unknown global is reported, not shrugged off", () => {
  // Proving the guard is capable of failing, per the plan's rule that a guard which
  // cannot fire is worse than no guard.
  const withNewGlobal = "let SOMETHING_UNTHREADED = [];\n" + WORKER;
  const declared = [...withNewGlobal.matchAll(/^let\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  const unclassified = declared.filter(
    (name) => !TENANT_FIELD_NAMES.includes(name) && !RUNTIME_CACHES.has(name),
  );
  assert.deepEqual(unclassified, ["SOMETHING_UNTHREADED"]);
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
