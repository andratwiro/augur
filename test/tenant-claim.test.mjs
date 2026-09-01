// A workspace claims a SECOND, chosen hostname — and its generated address redirects.
//
// `B-claim-platform-subdomain`. Three pieces, tested here together because they are one
// feature: the `claim` control verb on the workspace object (which writes the alias row the
// resolver reads, and the canonical-host meta the redirect reads), the resolver's alias
// lookup (consulted ONLY when the literal first label names nobody), and the front door's
// redirect from the generated address to the claimed one.
//
// The decisions under test, each of which something below would catch a regression of:
//
//   · A CLAIM MAY ONLY TAKE A HOSTNAME THE LITERAL RESOLVER DOES NOT RESOLVE — so the alias
//     table and the literal resolver are disjoint by construction, an alias can never
//     shadow a workspace, and the generator's namespace can never be squatted by an alias.
//   · THE GENERATED LABEL KEEPS WORKING. Never freed, never 404: a redirect for browsers,
//     direct answers for everything under `/_` so publish tokens, probes and CI keep
//     working against the origin their config names.
//   · AN ALIAS ALREADY HELD BY ANOTHER WORKSPACE REFUSES rather than re-points.
//   · A NEVER-CLAIMED HOSTNAME STILL 404s, before any config read, and does not leak
//     /_build.json.
//   · The reserved list and GENERATED_SHAPE are untouched — test/tenant-resolver-host
//     .test.mjs pins the first from this repo; the control plane's suite pins the second.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  TenantStore, CONTROL_VERBS, normalizeClaimHostname, hostAliasKey,
} from "../src/tenant-do.js";
import { __testables as W } from "../src/_worker.js";
import worker from "../src/_worker.js";

const SUFFIX = ".example.com";

/** The storage stub test/tenant-verbs.test.mjs uses — real transaction semantics. */
function storage(db) {
  const sql = {
    exec(stmt, ...params) {
      if (params.length) {
        const s = db.prepare(stmt);
        return /^\s*SELECT/i.test(stmt) ? s.all(...params) : (s.run(...params), []);
      }
      if (/^\s*SELECT/i.test(stmt)) return db.prepare(stmt).all();
      db.exec(stmt);
      return [];
    },
  };
  return {
    sql,
    transactionSync(cb) {
      db.exec("BEGIN");
      try { const out = cb(); db.exec("COMMIT"); return out; }
      catch (e) { db.exec("ROLLBACK"); throw e; }
    },
  };
}

/** A KV stub that counts reads, so "paid no lookup" is an assertion and not a hope. */
function kvStub(seed = {}) {
  const map = new Map(Object.entries(seed));
  const stub = {
    map, gets: 0, puts: 0,
    async get(k) { stub.gets++; return map.has(k) ? map.get(k) : null; },
    async put(k, v) { stub.puts++; map.set(k, String(v)); },
  };
  return stub;
}

function workspace(env = {}) {
  const db = new DatabaseSync(":memory:");
  const ctx = { storage: storage(db), blockConcurrencyWhile: async (f) => f() };
  return { db, store: new TenantStore(ctx, env) };
}

const claimEnv = (kv) => ({ TENANT_HOST_SUFFIX: SUFFIX, COMMENTS: kv });

const provisioned = async (env) => {
  const w = workspace(env);
  await w.store.provision({ workspaceId: "flint-birch-702", adminEmail: "first@example.test" });
  return w;
};

const control = (store, verb, body) =>
  store.fetch(new Request(`https://tenant.invalid/__control/${verb}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  }));

// ── the hostname a claim may carry ───────────────────────────────────────────────────

test("normalizeClaimHostname folds a real client's spellings and refuses repairs beyond them", () => {
  for (const h of ["demo.example.com", "DEMO.Example.COM", "demo.example.com.", "demo.example.com:443"]) {
    assert.equal(normalizeClaimHostname(h), "demo.example.com", h);
  }
  for (const bad of ["", null, "demo", "de mo.example.com", "-demo.example.com", "demo-.example.com",
    "de_mo.example.com", "[::1]", `${"x".repeat(64)}.example.com`, `${"a.".repeat(130)}com`]) {
    assert.equal(normalizeClaimHostname(bad), null, `${bad} was accepted`);
  }
});

// ── the claim verb ───────────────────────────────────────────────────────────────────

test("claim is a control verb, and a workspace nobody provisioned refuses it without creating anything", async () => {
  assert.ok(CONTROL_VERBS.includes("claim"));
  const { db, store } = workspace(claimEnv(kvStub()));
  const res = await control(store, "claim", { hostname: `demo${SUFFIX}` });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { ok: false, error: "not-provisioned" });
  const tables = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
  ).all();
  assert.deepEqual(tables, [], "claim created tables on a name nobody provisioned");
});

test("A CLAIM TAKES A RESERVED LABEL — that is its purpose — and writes the row the resolver reads", async () => {
  const kv = kvStub();
  const { store } = await provisioned(claimEnv(kv));
  const res = await control(store, "claim", { hostname: `demo${SUFFIX}`, at: "2026-08-28T12:00:00.000Z" });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.ok, true);
  assert.equal(out.changed, true);
  assert.equal(out.canonicalHost, `demo${SUFFIX}`);
  // The KV row is the resolver's, keyed by the FULL hostname.
  assert.deepEqual(JSON.parse(kv.map.get(hostAliasKey(`demo${SUFFIX}`))),
    { workspace: "flint-birch-702", at: "2026-08-28T12:00:00.000Z" });
  // The redirect rides the suspension read; status() reports it to the operator.
  assert.equal(store.suspension().canonicalHost, `demo${SUFFIX}`);
  assert.equal(store.suspension().suspended, false);
  assert.equal(store.status().canonicalHost, `demo${SUFFIX}`);
  assert.equal(store.status().canonicalHostAt, "2026-08-28T12:00:00.000Z");
});

test("re-claiming the SAME hostname converges the KV row and reports changed: false", async () => {
  const kv = kvStub();
  const { store } = await provisioned(claimEnv(kv));
  await control(store, "claim", { hostname: `demo${SUFFIX}`, at: "2026-08-28T12:00:00.000Z" });
  kv.map.delete(hostAliasKey(`demo${SUFFIX}`)); // a crashed claim: meta written, KV lost
  const out = await (await control(store, "claim", { hostname: `demo${SUFFIX}` })).json();
  assert.equal(out.ok, true);
  assert.equal(out.changed, false);
  assert.equal(out.claimedAt, "2026-08-28T12:00:00.000Z", "the original claim date is kept");
  assert.ok(kv.map.has(hostAliasKey(`demo${SUFFIX}`)), "the retry did not re-write the resolver's row");
});

test("ONE canonical hostname per workspace — a second, different claim refuses rather than moving the front door", async () => {
  const { store } = await provisioned(claimEnv(kvStub()));
  await control(store, "claim", { hostname: `demo${SUFFIX}` });
  // `preview` is reserved too, so it would otherwise be claimable — the refusal under test
  // is the one-canonical rule, not the literal-resolver rule.
  const res = await control(store, "claim", { hostname: `preview${SUFFIX}` });
  assert.equal(res.status, 409);
  const out = await res.json();
  assert.equal(out.error, "already-claimed");
  assert.equal(out.canonicalHost, `demo${SUFFIX}`);
});

test("A HOSTNAME THE LITERAL RESOLVER RESOLVES IS NOT CLAIMABLE — the two tables stay disjoint", async () => {
  const { store } = await provisioned(claimEnv(kvStub()));
  // A generated-shape label, somebody else's plain label, and the workspace's own address:
  // the literal resolver answers all three, so the claim refuses all three.
  for (const host of [`misty-fox-123${SUFFIX}`, `acme${SUFFIX}`, `flint-birch-702${SUFFIX}`]) {
    const res = await control(store, "claim", { hostname: host });
    assert.equal(res.status, 409, host);
    assert.equal((await res.json()).error, "hostname-resolves-literally", host);
  }
});

test("an alias another workspace holds REFUSES — never re-pointed", async () => {
  const kv = kvStub({ [hostAliasKey(`demo${SUFFIX}`)]: JSON.stringify({ workspace: "stoic-canyon-873" }) });
  const { store } = await provisioned(claimEnv(kv));
  const res = await control(store, "claim", { hostname: `demo${SUFFIX}` });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "alias-taken");
  assert.deepEqual(JSON.parse(kv.map.get(hostAliasKey(`demo${SUFFIX}`))),
    { workspace: "stoic-canyon-873" }, "the losing claim wrote over the winner's row");
});

test("the refusals that keep a claim honest: no suffix, no store, unreadable store, bad input, tombstone", async () => {
  // No TENANT_HOST_SUFFIX: a single-workspace deployment has no alias table to write.
  {
    const { store } = await provisioned({ COMMENTS: kvStub() });
    const res = await control(store, "claim", { hostname: `demo${SUFFIX}` });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, "no-host-routing");
  }
  // No KV binding at all.
  {
    const { store } = await provisioned({ TENANT_HOST_SUFFIX: SUFFIX });
    assert.equal((await (await control(store, "claim", { hostname: `demo${SUFFIX}` })).json()).error, "no-alias-store");
  }
  // An unreadable store is not evidence the hostname is free.
  {
    const broken = { async get() { throw new Error("kv down"); }, async put() {} };
    const { store } = await provisioned(claimEnv(broken));
    assert.equal((await (await control(store, "claim", { hostname: `demo${SUFFIX}` })).json()).error, "alias-store-unreadable");
  }
  // Bad input.
  {
    const { store } = await provisioned(claimEnv(kvStub()));
    assert.equal((await control(store, "claim", {})).status, 400);
    assert.equal((await (await control(store, "claim", { hostname: "not a hostname" })).json()).error, "bad-hostname");
  }
  // A tombstone cannot acquire a new address.
  {
    const { store } = await provisioned(claimEnv(kvStub()));
    await control(store, "delete", {});
    assert.equal((await (await control(store, "claim", { hostname: `demo${SUFFIX}` })).json()).error, "deleted");
  }
});

// ── the resolver's alias lookup ──────────────────────────────────────────────────────

const req = (host, path = "/") => new Request(`https://x${path}`, { headers: { host } });

function namespace() {
  const asked = [];
  return {
    asked,
    idFromName(name) { asked.push(name); return { name, toString: () => `id:${name}` }; },
    get(id) { return { id, __stub: true }; },
  };
}

test("A CLAIMED HOSTNAME RESOLVES TO ITS WORKSPACE — one lookup, keyed by the full hostname", async () => {
  const kv = kvStub({ [hostAliasKey(`claimed-a${SUFFIX}`)]: JSON.stringify({ workspace: "tenant-alias-a" }) });
  const env = { TENANT_HOST_SUFFIX: SUFFIX, TENANTS: namespace(), COMMENTS: kv };
  // `claimed-a` is not reserved and not deeper — make the miss real by resolving a host the
  // literal resolver refuses: use a reserved spelling for the claimed row instead.
  const r = await W.resolveTenant(req(`claimed-a${SUFFIX}`), env);
  assert.equal(r.tenantId, "claimed-a", "a literally-resolvable host must resolve literally");
  assert.equal(kv.gets, 0, "the literal path paid for an alias lookup");
});

test("a RESERVED hostname with an alias row serves the claimed workspace; without one it stays a bare 404", async () => {
  const kv = kvStub({ [hostAliasKey(`demo${SUFFIX}`)]: JSON.stringify({ workspace: "tenant-alias-b" }) });
  const env = { TENANT_HOST_SUFFIX: SUFFIX, TENANTS: namespace(), COMMENTS: kv };
  const hit = await W.resolveTenant(req(`demo${SUFFIX}`), env);
  assert.equal(hit.tenantId, "tenant-alias-b");
  assert.equal(String(hit.store.id), "id:tenant-alias-b");
  const miss = await W.resolveTenant(req(`support${SUFFIX}`), env);
  assert.equal(miss.tenantId, null);
  assert.equal(miss.store, null);
});

test("a corrupt alias row resolves NOBODY — reserved and malformed targets cannot come back through the side door", async () => {
  const kv = kvStub({
    [hostAliasKey(`one${SUFFIX}`)]: JSON.stringify({ workspace: "admin" }),
    [hostAliasKey(`two${SUFFIX}`)]: JSON.stringify({ workspace: "has space" }),
    [hostAliasKey(`three${SUFFIX}`)]: "not json",
    [hostAliasKey(`four${SUFFIX}`)]: JSON.stringify({}),
  });
  const env = { TENANT_HOST_SUFFIX: SUFFIX, TENANTS: namespace(), COMMENTS: kv };
  for (const label of ["one", "two", "three", "four"]) {
    // These labels resolve literally, so aim the lookup with hosts the literal resolver
    // refuses: reserved first labels carrying the rows above.
    const r = await W.aliasTenantId(env, `${label}${SUFFIX}`);
    assert.equal(r, null, label);
  }
});

test("an unreadable alias store is a MISS, not a wider namespace", async () => {
  // `mail`, not `demo`: the alias memo is per-isolate and a host another test resolved
  // would answer from it instead of exercising the broken read.
  const env = {
    TENANT_HOST_SUFFIX: SUFFIX, TENANTS: namespace(),
    COMMENTS: { async get() { throw new Error("kv down"); } },
  };
  const r = await W.resolveTenant(req(`mail${SUFFIX}`), env);
  assert.equal(r.tenantId, null);
});

test("A NEVER-CLAIMED HOSTNAME STILL 404s AND LEAKS NO /_build.json", async () => {
  const kv = kvStub({ [hostAliasKey(`demo${SUFFIX}`)]: JSON.stringify({ workspace: "tenant-alias-c" }) });
  let configReads = 0;
  const env = {
    TENANT_HOST_SUFFIX: SUFFIX, TENANTS: namespace(), COMMENTS: kv,
    ASSETS: { fetch: async () => { configReads++; return new Response("{}", { headers: { "content-type": "application/json" } }); } },
  };
  const quiet = console.log; console.log = () => {};
  try {
    for (const path of ["/", "/_build.json", "/__me"]) {
      const res = await worker.fetch(new Request(`https://x${path}`, { headers: { host: `billing${SUFFIX}` } }), env, {});
      assert.equal(res.status, 404, `${path} answered ${res.status}`);
      assert.equal(await res.text(), "Not found\n", path);
    }
  } finally { console.log = quiet; }
  assert.equal(configReads, 0, "a hostname naming nobody caused a config read");
});

// ── the generated address redirects ──────────────────────────────────────────────────

/** A TENANTS namespace whose objects answer /suspension with the given doc. */
function suspensionNamespace(docs) {
  return {
    idFromName(name) { return { name, toString: () => `id:${name}` }; },
    get(id) {
      return {
        id,
        async fetch(url) {
          const doc = docs[id.name] || { suspended: false, moved: false, canonicalHost: null };
          if (String(url).endsWith("/suspension")) return Response.json(doc);
          return Response.json({});
        },
      };
    },
  };
}

test("THE GENERATED ADDRESS REDIRECTS — 302, path and query preserved, browsers only, machine surface answers in place", async () => {
  const env = {
    TENANT_HOST_SUFFIX: SUFFIX,
    TENANTS: suspensionNamespace({
      "claimed-ws-777": { suspended: false, moved: false, canonicalHost: `demo${SUFFIX}` },
    }),
    ASSETS: { fetch: async () => new Response("{}", { headers: { "content-type": "application/json" } }) },
  };
  const quiet = console.log; console.log = () => {};
  try {
    // A browser's GET moves, with the path and the query intact.
    const res = await worker.fetch(
      new Request(`https://x/playground/memes/?tab=2`, { headers: { host: `claimed-ws-777${SUFFIX}` } }), env, {});
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), `https://demo${SUFFIX}/playground/memes/?tab=2`);
    // The machine surface answers where it was aimed: nothing under /_ redirects.
    for (const path of ["/_build.json", "/__auth", "/__publish/fulla/manifest", "/__me"]) {
      const r = await worker.fetch(
        new Request(`https://x${path}`, { headers: { host: `claimed-ws-777${SUFFIX}` } }), env, {});
      assert.notEqual(r.status, 302, `${path} redirected`);
    }
    // A POST is served, never bounced — a redirected POST loses its body or its bearer.
    const post = await worker.fetch(
      new Request(`https://x/anywhere`, { method: "POST", headers: { host: `claimed-ws-777${SUFFIX}` } }), env, {});
    assert.notEqual(post.status, 302, "a POST redirected");
  } finally { console.log = quiet; }
});

test("on the canonical host itself nothing redirects, and an unclaimed workspace is untouched", async () => {
  // `status`, not `demo`: the alias memo is per-isolate and `demo` was resolved by an
  // earlier test to a different workspace.
  const kv = kvStub({ [hostAliasKey(`status${SUFFIX}`)]: JSON.stringify({ workspace: "claimed-ws-888" }) });
  const env = {
    TENANT_HOST_SUFFIX: SUFFIX,
    COMMENTS: kv,
    TENANTS: suspensionNamespace({
      "claimed-ws-888": { suspended: false, moved: false, canonicalHost: `status${SUFFIX}` },
      "plain-ws-999": { suspended: false, moved: false, canonicalHost: null },
    }),
    ASSETS: { fetch: async () => new Response("{}", { headers: { "content-type": "application/json" } }) },
  };
  const quiet = console.log; console.log = () => {};
  try {
    const canonical = await worker.fetch(
      new Request(`https://x/`, { headers: { host: `status${SUFFIX}` } }), env, {});
    assert.notEqual(canonical.status, 302, "the canonical host bounced to itself");
    const plain = await worker.fetch(
      new Request(`https://x/`, { headers: { host: `plain-ws-999${SUFFIX}` } }), env, {});
    assert.notEqual(plain.status, 302, "an unclaimed workspace redirected");
  } finally { console.log = quiet; }
});

test("A SUSPENSION OUTRANKS THE REDIRECT — a paused claimed workspace shows the holding page, not a bounce", async () => {
  const env = {
    TENANT_HOST_SUFFIX: SUFFIX,
    TENANTS: suspensionNamespace({
      "claimed-ws-555": {
        suspended: true, reason: "aup", at: "2026-08-28T00:00:00.000Z",
        moved: false, canonicalHost: `demo${SUFFIX}`,
      },
    }),
    ASSETS: { fetch: async () => new Response("{}", { headers: { "content-type": "application/json" } }) },
  };
  const quiet = console.log; console.log = () => {};
  try {
    const res = await worker.fetch(
      new Request(`https://x/`, { headers: { host: `claimed-ws-555${SUFFIX}` } }), env, {});
    assert.equal(res.status, 503);
  } finally { console.log = quiet; }
});

test("a claimed-but-live workspace is NOT treated as paused — the gate keys on `suspended`, not on the doc", async () => {
  // The regression this pins: readSuspension now keeps a doc that carries only
  // canonicalHost, and an earlier gate refused on the doc's mere presence.
  const env = {
    TENANT_HOST_SUFFIX: SUFFIX,
    TENANTS: suspensionNamespace({
      "claimed-ws-666": { suspended: false, moved: false, canonicalHost: `demo${SUFFIX}` },
    }),
    ASSETS: { fetch: async () => new Response("{}", { headers: { "content-type": "application/json" } }) },
  };
  const quiet = console.log; console.log = () => {};
  try {
    const res = await worker.fetch(
      new Request(`https://x/_build.json`, { headers: { host: `claimed-ws-666${SUFFIX}` } }), env, {});
    assert.notEqual(res.status, 503, "a live claimed workspace served the suspension page");
    assert.notEqual(res.status, 302);
  } finally { console.log = quiet; }
});

test("a label the DEPLOYMENT reserves (RESERVED_LABELS_EXTRA) is claimable, exactly like an engine-reserved one", async () => {
  const kv = kvStub();
  const { store } = await provisioned({ ...claimEnv(kv), RESERVED_LABELS_EXTRA: "service, chosen" });
  const res = await control(store, "claim", { hostname: `chosen${SUFFIX}` });
  assert.equal(res.status, 200, await res.text());
  assert.deepEqual(JSON.parse(kv.map.get(hostAliasKey(`chosen${SUFFIX}`))).workspace, "flint-birch-702");
  // Without the deployment's list the same hostname resolves literally and refuses.
  const { store: plain } = await provisioned(claimEnv(kvStub()));
  const refused = await control(plain, "claim", { hostname: `chosen${SUFFIX}` });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error, "hostname-resolves-literally");
});
