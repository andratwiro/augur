// Two workspaces, one isolate, adversarially interleaved — the harness that has to exist
// BEFORE the threading sweep it guards.
//
// WHY IT IS BUILT FIRST. The sweep's dangerous failure is not a red test. It is threading
// 27 of 28 config globals, leaving the 28th shared, and shipping: every test green,
// because a single-tenant era has no second workspace to observe the difference. A
// harness written AFTER the sweep would be written to fit whatever the sweep produced.
// This one is written against `loadTenantContext` as it exists today, with two fixture
// environments that differ in every value they can differ in, so a field that starts
// coming back shared has somewhere to be caught.
//
// WHY IT CANNOT SILENTLY SKIP. A harness that quietly stops running reads as coverage
// while providing none — the exact way a neighbouring store shipped 42 green tests over a
// fixture that imported nothing. So the first block below asserts the harness's own
// premises before it asserts anything about the worker: that the function is exported,
// that its arguments are in the order used here, that its answer covers every declared
// context field, and — the one that matters most — that the two fixtures really do differ
// on every field this file claims to compare. A fixture that forgot to vary a field would
// otherwise turn that field's isolation test into a tautology.
//
// WHAT IT DELIBERATELY DOES NOT GO THROUGH. Not the router: `resolveTenant()` is static in
// Phase A and only ever answers one workspace, so driving `fetch()` could never produce a
// second tenant. The harness calls the loader directly, which is the only place two
// tenants can meet while there is still one of them.
//
// ---- ADDING A CASE ------------------------------------------------------------------
// The items after this one each close a module-scope cache that two workspaces currently
// share (the MCP derived allowlist, the R2 storage gauge, the manifest cache). Each needs
// the same shape of case, and it belongs in this file:
//
//   test("<the cache> is not shared across workspaces", async () => {
//     resetSharedCaches();
//     await load("alpha", envFor("alpha"));               // prime it with alpha
//     const beta = await load("beta", envFor("beta"));    // …then ask as beta
//     assert.deepStrictEqual(beta.<FIELD>, BETA_EXPECTED, "beta observed alpha's <cache>");
//   });
//
// `fixture()` takes overrides, so a case can vary one document without restating both;
// `resetSharedCaches()` puts the per-isolate memos back to cold. The KNOWN GAP section at
// the bottom shows the same shape used the other way round — pinning a channel that is
// still open, so closing it turns a test red instead of passing unremarked.

import { test } from "node:test";
import assert from "node:assert/strict";

import { __testables as W } from "../src/_worker.js";
import {
  TENANT_FIELD_NAMES,
  emptyTenantContext,
  buildTenantContext,
  createTenantContextCache,
} from "../src/tenant-context.mjs";

const { loadTenantContext, __setConfigTestState } = W;

// ---- fixtures -----------------------------------------------------------------------

// Two complete instances, differing in every value a config document can carry. `n` is
// the workspace's name and is woven into every string so a leaked value names its owner
// in the failure message rather than merely being "not what was expected".
function instanceDoc(n) {
  return {
    tenantId: n,
    users: [{ email: `one@${n}.invalid`, name: `One of ${n}`, role: "admin" }],
    engineVersion: `0.14.0-${n}`,
    updateFeed: `https://feed.${n}.invalid/releases`,
    mcpHostSuffixes: [`.${n}.invalid`],
    mcpHostAllowlistUrl: `https://${n}.invalid/hosts.json`,
    vanityRedirects: { [`/${n}`]: `/prototypes/${n}-one/` },
    rtOrigin: `https://rt.${n}.invalid`,
    sentinels: [`/prototypes/${n}-one/`],
    minClientProtocol: n.length, // an integer that differs per workspace
    loginHint: `the ${n} hint`,
    loginPrefill: { email: `demo@${n}.invalid`, password: `${n}-pw` },
  };
}

// `runtimeChrome` is a boolean, so "differs per workspace" has to be derived rather than
// woven in: neighbouring names land on opposite values, which is what the two workspaces
// this file compares need.
function routingDoc(n, { runtimeChrome = n.charCodeAt(0) % 2 === 0 } = {}) {
  return {
    buildId: `build-${n}`,
    versionMap: { [`/prototypes/${n}-one/`]: `v-${n}` },
    publicPrefixes: [`/prototypes/${n}-one/`],
    publicSkillPrefixes: [`/skills/${n}-ui/`],
    restrictedBases: [`/${n}-sealed`],
    canvasLoaderExtras: `<script src="/${n}-loader.js"></script>`,
    canvasCatalog: [{ id: `${n}-card` }],
    canvasTracks: [{ id: `${n}-track` }],
    mcpAllowlist: [`mcp.${n}.invalid`],
    mcpPaths: [`/${n}/api`],
    spaces: [{ id: n, name: `Workspace ${n}`, default: true }],
    chrome: { sha: `${n}-chrome` },
    runtimeChrome,
  };
}

// The KV overlay a workspace keeps beside its config documents. Only the fixtures that
// exercise the overlay bind one — see the KNOWN GAP section for why most do not.
function kvDoc(n) {
  return {
    // The roster key is a literal because the worker does not export it; the case below
    // asserts the overlay actually landed, so a rename cannot hollow this fixture out.
    "users:roster": JSON.stringify({ add: { [`two@${n}.invalid`]: { email: `two@${n}.invalid`, name: `Two of ${n}` } }, remove: [] }),
    [W.SPACE_ICONS_KEY]: JSON.stringify({ [n]: { k: `${n}icon`, mime: "image/png", at: 1 } }),
  };
}

// A workspace's serving environment in ASSETS mode — the two documents build.js emits,
// answered from a per-workspace table. Every read returns a FRESH parse (structuredClone
// stands in for JSON.parse), because a fixture that handed the same object back twice
// would make two contexts share values for reasons that have nothing to do with the
// worker.
function fixture(n, { instance = instanceDoc(n), routing = routingDoc(n), kv = null } = {}) {
  const docs = { "instance.json": instance, "routing.json": routing };
  const env = {
    ASSETS: {
      async fetch(url) {
        const name = String(url).split("/").pop();
        const doc = docs[name];
        if (!doc) return { ok: false, status: 404, async json() { throw new Error("not found"); } };
        return { ok: true, status: 200, async json() { return structuredClone(doc); } };
      },
    },
  };
  if (kv) env.COMMENTS = { async get(key) { return kv[key] ?? null; } };
  return env;
}

const NAMES = ["alpha", "beta"];
const envFor = (n) => fixture(n);

// Every per-isolate memo `loadTenantContext` can reach, back to cold. Called at the top
// of every case: these caches are module scope, so without it a case inherits whatever
// the previous one left behind and the file's results depend on their order.
function resetSharedCaches() {
  __setConfigTestState({ cfgAt: 0, rosterReadAt: 0, mcpHostAllowlist: null });
}

// One cold load. `prev: null` on purpose — keep-last-good is tested elsewhere; here every
// call must be answerable from the environment alone, or a passing result could be the
// previous tenant's context surviving rather than this tenant's being read.
const load = (tenantId, env, opts = {}) => loadTenantContext(tenantId, env, { prev: null, ...opts });

// The INDEPENDENT ORACLE: what a workspace's context must contain, computed from its
// documents by the pure builder in src/tenant-context.mjs, which holds no module state.
//
// This exists because comparing loads against each other is not enough. A memo shared by
// every workspace poisons the first load AND the reference load taken from it, and two
// identical wrong answers compare equal — a leak that makes every context the same is
// invisible to a same-vs-same comparison. Measured: a shared routing memo injected into
// the loader passed the interleaving test until the reference stopped being another load.
//
// It is exact only for a fixture that binds no KV: with no overlay to read, rosterFields
// contributes USERS = CONFIG_USERS, SPACES unchanged and an empty icon index — which is
// what the pure builder leaves in place.
const expected = (n) => buildTenantContext(n, { instance: instanceDoc(n), routing: routingDoc(n) });

// Deep equality as a predicate rather than an assertion — used to compare fixtures field
// by field. Handles the Sets and Maps the context carries, as deepStrictEqual does.
function sameValue(a, b) {
  try { assert.deepStrictEqual(a, b); return true; } catch (e) { return false; }
}

// ---- the harness's own premises -----------------------------------------------------
//
// Fields two loaded contexts CANNOT be expected to differ on, each with the reason. Every
// other declared field must differ, and the partition is asserted to cover the context
// exactly — so a field added to FIELDS lands in one list or fails the build. Moving a
// field into this list is the claim that two workspaces sharing its value is correct;
// make it in review, not in passing.
const SHARED_BY_NATURE = {
  CONFIG_LOADED:
    "true for any workspace whose instance document parsed — a difference here would mean one of the two failed to load, not that they are isolated",
};

test("the harness is wired to the real loader — signature, order, coverage", async () => {
  assert.equal(
    typeof loadTenantContext, "function",
    "loadTenantContext is not exported from src/_worker.js — this whole file is asserting nothing",
  );
  assert.equal(
    loadTenantContext.length, 2,
    "loadTenantContext takes a different number of required arguments than (tenantId, env) — re-derive this harness before trusting it",
  );

  resetSharedCaches();
  const ctx = await load("alpha", envFor("alpha"));

  // Argument ORDER, not just arity: passing (env, tenantId) would keep length 2.
  assert.equal(ctx.tenantId, "alpha", "the first argument is no longer the tenant id");
  assert.equal(ctx.BUILD_ID, "build-alpha", "the second argument is no longer the environment");

  // The options bag still means what the harness assumes: `prev` is the keep-last-good
  // reference and is returned untouched when there is nothing to read.
  const prev = emptyTenantContext("alpha");
  assert.equal(
    await loadTenantContext("alpha", {}, { prev }), prev,
    "the third argument's `prev` contract changed — keep-last-good is what makes `prev: null` above meaningful",
  );

  // Coverage: the answer carries every declared field, so the comparisons below cannot
  // miss one by never looking at it.
  assert.deepStrictEqual(
    Object.keys(ctx).sort(), ["tenantId", ...TENANT_FIELD_NAMES].sort(),
    "the loaded context does not carry exactly the declared fields",
  );
});

test("every context field is either distinguished by the fixtures or declared shared", () => {
  const declared = new Set(Object.keys(SHARED_BY_NATURE));
  for (const name of declared) {
    assert.ok(TENANT_FIELD_NAMES.includes(name), `${name} is declared shared but is not a context field`);
    assert.ok(SHARED_BY_NATURE[name].length > 20, `${name} is declared shared without a reason`);
  }
  // The partition covers the context exactly: a new field cannot appear without someone
  // deciding, in writing, which side of the line it is on.
  const distinguished = TENANT_FIELD_NAMES.filter((n) => !declared.has(n));
  assert.equal(
    distinguished.length + declared.size, TENANT_FIELD_NAMES.length,
    "a context field is in neither list",
  );
  assert.ok(distinguished.length > 20, `only ${distinguished.length} fields are being distinguished`);
});

test("the two fixtures actually differ — no comparison below is a tautology", async () => {
  // The failure this guards is a fixture, not the worker: a field both environments leave
  // at its default compares equal for reasons that have nothing to do with isolation, and
  // its "no leak" assertion would pass forever.
  resetSharedCaches();
  const a = await load("alpha", fixture("alpha", { kv: kvDoc("alpha") }));
  resetSharedCaches();
  const b = await load("beta", fixture("beta", { kv: kvDoc("beta") }));

  for (const name of TENANT_FIELD_NAMES) {
    if (SHARED_BY_NATURE[name]) {
      assert.ok(sameValue(a[name], b[name]), `${name} is declared shared but the fixtures differ on it — move it out of SHARED_BY_NATURE`);
      continue;
    }
    assert.ok(
      !sameValue(a[name], b[name]),
      `${name} is identical in both fixtures — every isolation assertion about it is vacuous. Vary it in instanceDoc/routingDoc, or declare it in SHARED_BY_NATURE with a reason.`,
    );
  }
});

// ---- interleaved loads --------------------------------------------------------------

test("interleaved loads answer each workspace with its own config, every iteration", async () => {
  // A cold, alone load must already match the oracle. If it does not, the loader is
  // wrong before any interleaving is involved and the rest of this case is noise.
  for (const n of NAMES) {
    resetSharedCaches();
    assert.deepStrictEqual(
      await load(n, envFor(n)), expected(n),
      `${n}'s cold load does not match what its own documents describe`,
    );
  }

  const ITERATIONS = 40;
  for (let i = 0; i < ITERATIONS; i++) {
    resetSharedCaches();
    // A randomized order, several loads per workspace, all in flight at once. The point
    // is the awaits inside the loader: a value read before one and used after it can be
    // another workspace's by the time it is used.
    const plan = [];
    for (const n of NAMES) for (let k = 0; k < 3; k++) plan.push(n);
    for (let j = plan.length - 1; j > 0; j--) {
      const r = Math.floor(Math.random() * (j + 1));
      [plan[j], plan[r]] = [plan[r], plan[j]];
    }

    const got = await Promise.all(plan.map((n) => load(n, envFor(n))));

    got.forEach((ctx, idx) => {
      const n = plan[idx];
      assert.equal(ctx.tenantId, n, `iteration ${i}: a context came back labelled for another workspace`);
      // Stronger than "the two differ": each answer must be ITS OWN workspace's answer,
      // measured against the oracle. Two contexts could differ from each other and still
      // both be wrong, and a leak that makes them identical would satisfy neither.
      assert.deepStrictEqual(
        ctx, expected(n),
        `iteration ${i} (order ${plan.join(",")}): ${n} did not get its own config`,
      );
    });

    // …and no two answers for different workspaces are the same object.
    for (let x = 0; x < got.length; x++) {
      for (let y = x + 1; y < got.length; y++) {
        if (plan[x] === plan[y]) continue;
        assert.notEqual(got[x], got[y], `iteration ${i}: two workspaces were handed the same context object`);
        assert.ok(!sameValue(got[x], got[y]), `iteration ${i}: two workspaces' contexts are deep-equal`);
      }
    }
  }
});

test("a loaded context shares no mutable value with another workspace's", async () => {
  resetSharedCaches();
  const a = await load("alpha", envFor("alpha"));
  resetSharedCaches();
  const b = await load("beta", envFor("beta"));

  for (const name of TENANT_FIELD_NAMES) {
    const va = a[name];
    if (va === null || typeof va !== "object") continue;
    assert.notEqual(va, b[name], `${name} is the SAME object in both workspaces' contexts`);
  }

  // Concretely, in the two directions that matter: the context itself refuses a write,
  // and writing through to a value it holds does not reach the other workspace.
  assert.throws(() => { a.USERS = []; }, TypeError, "the context is not frozen");
  a.PUBLIC_PREFIXES.push("/prototypes/smuggled/");
  a.mcpStaticHosts.add("mcp.smuggled.invalid");
  a.VERSION_MAP["/prototypes/smuggled/"] = "v-smuggled";
  a.SPACES.push({ id: "smuggled" });

  assert.deepStrictEqual(b.PUBLIC_PREFIXES, ["/prototypes/beta-one/"]);
  assert.equal(b.mcpStaticHosts.has("mcp.smuggled.invalid"), false);
  assert.deepStrictEqual(b.VERSION_MAP, { "/prototypes/beta-one/": "v-beta" });
  assert.deepStrictEqual(b.SPACES.map((s) => s.id), ["beta"]);
});

// ---- the DERIVED proxy allowlist, which is not a config field at all -----------------
//
// Everything above compares CONFIG. This section is about the one value the /__mcp/ proxy
// works out for itself: the exact-host list a workspace publishes at its own
// MCP_HOST_ALLOWLIST_URL, fetched at runtime and memoised so the proxy is not one HTTP
// round trip slower on every call.
//
// That memo is the sharpest shape of this phase's failure, and it is a different shape
// from a shared config field. It caches a value DERIVED from one workspace's config, so a
// promise cache keyed on nothing hands the first workspace to warm it a proxy allowlist
// that every workspace behind it then answers from — and what that widens is a security
// control (which third-party hosts this origin will forward a browser's Authorization
// header to), not a rendering. With one workspace the resolved list is simply correct, so
// no amount of single-tenant testing can see it; threading the config fields and leaving
// the memo alone would look, from every other test in the repo, exactly like done.

const REMOTE = (n) => `remote.${n}.invalid`;

// The network, stubbed: a workspace's published host document answers from its own URL,
// and any other call is the proxy forwarding upstream. Every URL is recorded, because
// WHICH document was fetched is half of what these cases assert.
function withAllowlistFetch(fn, { fail = () => false } = {}) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    const doc = /^https:\/\/([a-z]+)\.invalid\/hosts\.json$/.exec(u);
    if (doc) {
      if (fail(u, calls)) return new Response("nope", { status: 500 });
      return new Response(JSON.stringify({ hosts: [REMOTE(doc[1])] }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    return new Response('{"ok":true}', { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return Promise.resolve(fn(calls)).finally(() => { globalThis.fetch = real; });
}

// One proxied call, for a named workspace. `/mcp` is the protocol floor, so the PATH
// allowlist never decides these cases — the host allowlist does.
const mcp = (ctx, host) => {
  const url = new URL(`https://site.example.invalid/__mcp/${host}/mcp`);
  return W.mcpProxy(ctx, new Request(url, { method: "POST" }), url);
};

// Both workspaces' contexts, loaded cold and alone.
async function proxyContexts() {
  const out = {};
  for (const n of NAMES) {
    resetSharedCaches();
    out[n] = await load(n, envFor(n));
  }
  // Premises. Each of these, if it were false, would make a 200 or a 403 below mean
  // something other than "the fetched list decided it".
  assert.notEqual(
    out.alpha.MCP_HOST_ALLOWLIST_URL, out.beta.MCP_HOST_ALLOWLIST_URL,
    "both workspaces publish their host list at the same URL — nothing below distinguishes them",
  );
  for (const n of NAMES) {
    assert.ok(out[n].MCP_HOST_ALLOWLIST_URL, `${n} publishes no host list, so nothing here is memoised`);
    assert.equal(
      out[n].mcpStaticHosts.has(REMOTE(n)), false,
      `${n} already allows ${REMOTE(n)} from its build-time list — the fetched list is not what would be allowing it`,
    );
    assert.equal(
      out[n].MCP_HOST_SUFFIXES.some((sfx) => REMOTE(n).endsWith("." + sfx)), false,
      `${n}'s suffix rule already allows ${REMOTE(n)} — same tautology, other half of the allowlist`,
    );
  }
  return out;
}

test("a workspace's FETCHED proxy allowlist is never answered to another workspace", async () => {
  const ctx = await proxyContexts();

  await withAllowlistFetch(async (calls) => {
    // Warm alpha's: it reaches the host its own document publishes, and reaching it took
    // exactly one fetch of alpha's own URL plus the forward.
    assert.equal(
      (await mcp(ctx.alpha, REMOTE("alpha"))).status, 200,
      "alpha cannot reach the host its own allowlist publishes",
    );
    assert.deepStrictEqual(
      calls, [ctx.alpha.MCP_HOST_ALLOWLIST_URL, `https://${REMOTE("alpha")}/mcp`],
      "alpha's call did not resolve alpha's own document",
    );

    // …then beta asks for the same host. Beta's document never named it, so this must be
    // a refusal — not a hit on the list alpha warmed.
    const res = await mcp(ctx.beta, REMOTE("alpha"));
    assert.equal(
      res.status, 403,
      "beta reached a host only ALPHA's published allowlist names: the derived-allowlist cache is shared",
    );
    assert.equal((await res.json()).error, "host not allowed");
    assert.equal(
      calls.includes(`https://${REMOTE("alpha")}/mcp`) && calls.filter((u) => u === `https://${REMOTE("alpha")}/mcp`).length, 1,
      "beta's refused call still forwarded upstream",
    );

    // And beta resolves its OWN document rather than being answered from alpha's.
    assert.ok(
      calls.includes(ctx.beta.MCP_HOST_ALLOWLIST_URL),
      "beta never fetched its own allowlist — it was answered out of a neighbour's memo",
    );
    assert.equal(
      (await mcp(ctx.beta, REMOTE("beta"))).status, 200,
      "beta cannot reach the host its own allowlist publishes",
    );
  });
});

test("the fetched allowlist is still a CACHE — one fetch per workspace, not one per request", async () => {
  // The isolation above would also be satisfied by never caching at all, which would put
  // an HTTP round trip in front of every proxied call. Both properties, or neither is
  // pinned.
  const ctx = await proxyContexts();

  await withAllowlistFetch(async (calls) => {
    for (let i = 0; i < 3; i++) {
      assert.equal((await mcp(ctx.alpha, REMOTE("alpha"))).status, 200);
      assert.equal((await mcp(ctx.beta, REMOTE("beta"))).status, 200);
    }
    const docs = calls.filter((u) => u.endsWith("/hosts.json"));
    assert.deepStrictEqual(
      docs.sort(), [ctx.alpha.MCP_HOST_ALLOWLIST_URL, ctx.beta.MCP_HOST_ALLOWLIST_URL].sort(),
      "the published host documents were re-fetched per request, or one workspace's was never fetched",
    );
  });
});

test("a workspace whose allowlist document fails retries, and takes no neighbour down with it", async () => {
  // Unreachable means "no host beyond the build-time list", never "fail closed" and never
  // "borrow whatever resolved". And the failure is not sticky: the next request tries
  // again, which is only true if the rejected attempt was dropped from the cache.
  const ctx = await proxyContexts();

  let broken = true;
  await withAllowlistFetch(async (calls) => {
    const refused = await mcp(ctx.alpha, REMOTE("alpha"));
    assert.equal(refused.status, 403, "a failed allowlist read still allowed a host it never named");

    // beta is unaffected by alpha's broken document.
    assert.equal((await mcp(ctx.beta, REMOTE("beta"))).status, 200, "alpha's failure reached beta");

    broken = false;
    assert.equal(
      (await mcp(ctx.alpha, REMOTE("alpha"))).status, 200,
      "alpha never retried its allowlist — one failed read poisoned the workspace for the isolate's life",
    );
    assert.equal(
      calls.filter((u) => u === ctx.alpha.MCP_HOST_ALLOWLIST_URL).length, 2,
      "the retry did not re-fetch alpha's document",
    );
  }, { fail: (u) => broken && u.includes("alpha") });
});

// ---- bundle mode ---------------------------------------------------------------------
//
// Everything above runs in ASSETS mode, and so does the byte-level response snapshot —
// while every deployed instance serves in BUNDLE mode, where routing is DERIVED from the
// live manifests rather than read from a document. That is a different branch of
// `loadTenantContext` with a different set of per-isolate caches behind it, so a green
// assets-mode harness is not evidence about it. This case is the evidence.
//
// The manifests are given no `head`, so `loadManifests` cannot take its etag shortcut and
// each load parses its own store. The shortcut is keyed by SPACE id inside one
// isolate-wide value, so two workspaces that each publish a space under the same id would
// share a parse — a case for A-thread-bundle-cache, and the reason these two fixtures use
// distinct space ids rather than pretending the question does not exist.

function bundleFixture(n) {
  const manifests = {
    _engine: { routing: { canvasLoaderExtras: `<script src="/${n}-loader.js"></script>`, chrome: { sha: `${n}-chrome` }, runtimeChrome: n.charCodeAt(0) % 2 === 0 } },
    [n]: {
      space: { id: n, name: `Workspace ${n}`, default: true },
      version: n.length,
      routing: {
        publicPrefixes: [`/prototypes/${n}-one/`],
        publicSkillPrefixes: [`/skills/${n}-ui/`],
        versionMap: { [`/prototypes/${n}-one/`]: `v-${n}` },
        canvasCatalog: [{ id: `${n}-card` }],
        canvasTracks: [{ id: `${n}-track` }],
        mcpAllowlist: [`mcp.${n}.invalid`],
        mcpPaths: [`/${n}/api`],
        shellSig: `sig-${n}`,
      },
    },
  };
  const blobs = { "config/instance.json": JSON.stringify(instanceDoc(n)) };
  for (const [id, m] of Object.entries(manifests)) blobs[`spaces/${id}/manifest.json`] = JSON.stringify(m);
  return {
    GV_ASSET_SOURCE: "r2",
    BUNDLES: {
      async list() { return { delimitedPrefixes: Object.keys(manifests).map((id) => `spaces/${id}/`) }; },
      async get(key) {
        const body = blobs[key];
        return body === undefined ? null : { async text() { return body; } };
      },
    },
  };
}

test("bundle mode derives each workspace's routing from its own store, interleaved", async () => {
  const ITERATIONS = 20;
  for (let i = 0; i < ITERATIONS; i++) {
    resetSharedCaches();
    const plan = ["alpha", "beta", "beta", "alpha", "alpha", "beta"];
    for (let j = plan.length - 1; j > 0; j--) {
      const r = Math.floor(Math.random() * (j + 1));
      [plan[j], plan[r]] = [plan[r], plan[j]];
    }
    const got = await Promise.all(plan.map((n) => load(n, bundleFixture(n))));

    got.forEach((ctx, idx) => {
      const n = plan[idx];
      const where = `iteration ${i} (order ${plan.join(",")}): ${n}`;
      assert.equal(ctx.tenantId, n, `${where} came back labelled for another workspace`);
      assert.equal(ctx.CONFIG_LOADED, true, `${where} did not load its instance document`);

      // Asserted against the FIXTURE, not against another load: a memo shared by every
      // workspace poisons a reference load as readily as the load under test.
      assert.deepStrictEqual(ctx.CONFIG_USERS.map((u) => u.email), [`one@${n}.invalid`], `${where} identity`);
      assert.equal(ctx.LOGIN_HINT, `the ${n} hint`, `${where} login hint`);
      assert.equal(ctx.RT_ORIGIN, `https://rt.${n}.invalid`, `${where} realtime origin`);
      assert.deepStrictEqual(ctx.PUBLIC_PREFIXES, [`/prototypes/${n}-one/`], `${where} gate exemptions`);
      assert.deepStrictEqual(ctx.PUBLIC_SKILL_PREFIXES, [`/skills/${n}-ui/`], `${where} skill exemptions`);
      assert.deepStrictEqual(ctx.VERSION_MAP, { [`/prototypes/${n}-one/`]: `v-${n}` }, `${where} version map`);
      assert.deepStrictEqual(ctx.SPACES.map((s) => s.id), [n], `${where} workspace list`);
      assert.deepStrictEqual(ctx.MCP_HOST_ALLOWLIST, [`mcp.${n}.invalid`], `${where} proxy hosts`);
      assert.equal(ctx.mcpStaticHosts.has(`mcp.${n}.invalid`), true, `${where} proxy host set`);
      assert.deepStrictEqual(ctx.MCP_PATH_ALLOWLIST, [`/${n}/api`], `${where} proxy paths`);
      assert.deepStrictEqual(ctx.CANVAS_CATALOG, [{ id: `${n}-card` }], `${where} canvas catalog`);
      assert.deepStrictEqual(ctx.CANVAS_TRACKS, [{ id: `${n}-track` }], `${where} canvas tracks`);
      assert.deepStrictEqual(ctx.CHROME_POINTER, { sha: `${n}-chrome` }, `${where} chrome pointer`);
      assert.equal(ctx.RUNTIME_CHROME, n.charCodeAt(0) % 2 === 0, `${where} runtime chrome`);
      assert.equal(ctx.CANVAS_LOADER_EXTRAS, `<script src="/${n}-loader.js"></script>`, `${where} loader extras`);
      // The path-mount tier is retired, so the bundle derivation seals nothing. Pinned
      // here because "always empty" is the only reason it is safe to share.
      assert.deepStrictEqual(ctx.RESTRICTED_BASES, [], `${where} restricted bases must stay permanently empty`);
    });

    // BUILD_ID is a hash of the manifest signatures, so it is checked by difference
    // rather than by value: two workspaces must not be handed the same build stamp.
    const byName = {};
    got.forEach((ctx, idx) => { byName[plan[idx]] = ctx.BUILD_ID; });
    assert.notEqual(byName.alpha, byName.beta, `iteration ${i}: both workspaces got one build stamp`);
  }
});

// ---- the per-tenant cache under interleaving ----------------------------------------

test("the cache holds exactly one entry per distinct workspace asked for", async () => {
  const ids = ["alpha", "beta", "gamma", "kappa", "omega"];
  const cache = createTenantContextCache();

  // Three requests per workspace, shuffled and concurrent — fifteen loads, five entries.
  const plan = [];
  for (const n of ids) for (let k = 0; k < 3; k++) plan.push(n);
  for (let j = plan.length - 1; j > 0; j--) {
    const r = Math.floor(Math.random() * (j + 1));
    [plan[j], plan[r]] = [plan[r], plan[j]];
  }

  resetSharedCaches();
  const got = await Promise.all(plan.map(async (n) => {
    cache.stamp(n);
    return cache.put(n, await load(n, envFor(n)));
  }));

  assert.equal(cache.size, ids.length, `expected ${ids.length} cache entries, found ${cache.size}`);
  for (const n of ids) {
    assert.equal(cache.get(n).tenantId, n, `${n}'s cache slot holds another workspace's context`);
    assert.deepStrictEqual(cache.get(n), expected(n), `${n}'s cache slot holds the wrong config`);
  }
  got.forEach((ctx, idx) => assert.equal(ctx.tenantId, plan[idx]));

  // A workspace nobody asked for has no entry and inherits nothing.
  assert.equal(cache.has("zeta"), false);
  assert.equal(cache.get("zeta"), null, "an unknown workspace was handed someone else's context");
});

test("eviction fails CLOSED — an evicted workspace rebuilds with no identity", async () => {
  const cache = createTenantContextCache({ max: 2 });
  resetSharedCaches();
  for (const n of ["alpha", "beta", "gamma"]) {
    cache.stamp(n);
    cache.put(n, await load(n, envFor(n)));
  }
  assert.equal(cache.size, 2, "the cache grew past its bound");
  assert.equal(cache.get("alpha"), null, "the evicted workspace still has a context");
  // What the call site does with that null is the whole safety property: a fresh empty
  // context, whose CONFIG_LOADED is false, so the gate stays shut while it reloads.
  assert.equal(emptyTenantContext("alpha").CONFIG_LOADED, false);
});

// ---- CONFIG_LOADED, through the real loader ------------------------------------------

test("CONFIG_LOADED is false unless THIS workspace's instance document parsed", async () => {
  // The single most dangerous regression in the phase: the flag is what lets the gate tell
  // "raw build, genuinely no identity, open by design" from "deployment whose config has
  // not loaded in this cold isolate, fail closed". Flip the factory default in
  // src/tenant-context.mjs to `true` and this case goes red — that is how it is checked,
  // never by trusting the pass.
  assert.equal(emptyTenantContext("alpha").CONFIG_LOADED, false);

  resetSharedCaches();
  const noConfig = await load("alpha", fixture("alpha", { instance: null, routing: null }));
  assert.equal(noConfig.CONFIG_LOADED, false, "a workspace with no config document claims its config loaded");

  // Routing alone is the sharp case: plenty of fields fill in, and none of them is
  // identity. A context that called itself loaded here would open the gate on a
  // deployment whose instance read failed.
  resetSharedCaches();
  const routingOnly = await load("alpha", fixture("alpha", { instance: null }));
  assert.equal(routingOnly.BUILD_ID, "build-alpha", "routing did load");
  assert.equal(routingOnly.CONFIG_LOADED, false, "routing alone must not claim config is loaded");
  assert.deepStrictEqual(routingOnly.USERS, [], "and it has no identity");

  // And it does not travel: one workspace loading successfully must not make another
  // workspace's cold context look loaded.
  resetSharedCaches();
  const [loaded, unloaded] = await Promise.all([
    load("alpha", envFor("alpha")),
    load("beta", fixture("beta", { instance: null })),
  ]);
  assert.equal(loaded.CONFIG_LOADED, true);
  assert.equal(unloaded.CONFIG_LOADED, false, "a neighbour's successful load opened this workspace's gate");
});

// ---- the publish-token exchange, per workspace ---------------------------------------
//
// `/__publish/_login/token` trades a web login for a publish token, and for anyone who is
// not an admin the token is scoped to THE DEFAULT WORKSPACE — a read of the workspace
// list. While that list was a module global, the isolate's LAST CONFIG LOAD decided which
// workspace every exchange scoped to, whoever was asking: an editor signing in to one
// workspace could walk away with a token that publishes to its neighbour, and the grant
// written to KV would say so too. A single-tenant era has no second workspace to observe
// that, so it is pinned here rather than left to a route test.
//
// This still does not go through the router — `publishApi` takes the workspace as its
// first argument, which is the seam this file exists to hold. The two workspaces share
// ONE KV, as an isolate serving both would: the same token store, the same secrets, the
// same rate-limit counters, so a leak has somewhere to come from.

const EXCHANGE_PASSWORD = "correct horse battery staple";

// The exchange's interesting branch is the NON-admin one: an admin gets "*" and never
// consults the list at all.
const editorInstanceDoc = (n) => ({
  ...instanceDoc(n),
  users: [{ email: `editor@${n}.invalid`, name: `Editor of ${n}`, role: "editor" }],
});

async function exchangeEnv(names) {
  const store = new Map();
  const secrets = {};
  for (const n of names) secrets[`editor@${n}.invalid`] = await W.hashPassword(EXCHANGE_PASSWORD);
  store.set("users:secrets", JSON.stringify(secrets));
  const kv = {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
  };
  // BUNDLES bound: the publish routes answer 501 without it, and every deployed instance
  // serves in bundle mode.
  return { store, env: { COMMENTS: kv, BUNDLES: {} } };
}

const exchange = (ctx, env, n) => W.publishApi(
  ctx,
  new Request("https://x.test/__publish/_login/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `editor@${n}.invalid`, password: EXCHANGE_PASSWORD }),
  }),
  new URL("https://x.test/__publish/_login/token"),
  env,
);

function shuffled(items) {
  const out = [...items];
  for (let j = out.length - 1; j > 0; j--) {
    const r = Math.floor(Math.random() * (j + 1));
    [out[j], out[r]] = [out[r], out[j]];
  }
  return out;
}

test("the publish-token exchange scopes to the CALLING workspace, under interleaving", async () => {
  const { store, env } = await exchangeEnv(NAMES);

  const ctx = {};
  for (const n of NAMES) {
    resetSharedCaches();
    ctx[n] = await load(n, fixture(n, { instance: editorInstanceDoc(n) }));
    assert.deepStrictEqual(
      ctx[n].SPACES.map((s) => s.id), [n],
      `${n}'s context does not carry its own workspace list — the case would assert nothing`,
    );
  }

  const ITERATIONS = 10;
  for (let i = 0; i < ITERATIONS; i++) {
    const plan = shuffled([...NAMES, ...NAMES, ...NAMES]);
    const got = await Promise.all(plan.map((n) => exchange(ctx[n], env, n)));
    for (const [idx, res] of got.entries()) {
      const n = plan[idx];
      const where = `iteration ${i} (order ${plan.join(",")}): ${n}`;
      assert.equal(res.status, 200, `${where} was refused a token it is entitled to`);
      const body = await res.json();
      assert.equal(body.space, n, `${where} was handed a token scoped to another workspace`);
    }
  }

  // …and the grant that was WRITTEN says the same thing. A token that answered "alpha" to
  // its holder while storing "beta" would publish next door on its first use, and the
  // holder would have been told otherwise.
  const { token, space } = await (await exchange(ctx.alpha, env, "alpha")).json();
  const map = JSON.parse(store.get("publish:tokens"));
  const record = map[await W.tokenFor("pub:" + token)];
  assert.equal(space, "alpha");
  assert.equal(record.space, "alpha", "the stored grant names a workspace the response did not");
  assert.equal(record.label, "editor@alpha.invalid");
});

test("a workspace with no default cannot borrow its neighbour's", async () => {
  // The null-when-no-workspace contract, at the one place it decides who may publish
  // what: with no default there is nothing to scope a token to, and the refusal has to be
  // a refusal rather than a fall-through to whichever workspace loaded last.
  const { env } = await exchangeEnv(NAMES);

  resetSharedCaches();
  const alpha = await load("alpha", fixture("alpha", { instance: editorInstanceDoc("alpha") }));
  resetSharedCaches();
  const beta = await load("beta", fixture("beta", {
    instance: editorInstanceDoc("beta"),
    routing: { ...routingDoc("beta"), spaces: [] },
  }));

  assert.equal((await exchange(alpha, env, "alpha")).status, 200, "alpha's own exchange broke");
  const res = await exchange(beta, env, "beta");
  assert.equal(res.status, 500);
  assert.equal(
    (await res.json()).error, "no-default-space",
    "a workspace with no default was handed a scope, which could only have come from its neighbour",
  );
});

// ---- KNOWN GAP: the roster overlay cache is shared -----------------------------------
//
// `rosterFields()` reads its six KV documents through the module-scope `rosterCache` /
// `rosterReadAt` pair, which no tenant keys. Within ROSTER_TTL_MS the SECOND workspace to
// load reuses the FIRST workspace's KV read, and the fields the overlay owns — USERS, and
// the workspace icon index — come back as the neighbour's.
//
// This is pinned rather than merely noted so that closing it cannot happen unremarked:
// the case below goes RED the day the roster cache is keyed by tenant. When it does,
// delete this section and move USERS and SPACE_ICONS into the interleaved comparison
// above (they are excluded from it today only because their KV read is shared, which is
// why that test's fixtures bind no KV at all).
//
// The allowlist entry in scripts/no-tenant-globals.mjs calls this cache "overlay only,
// never the auth boundary", which is true of the SECURITY question — identify() resolves
// users:secrets per request and the tombstone fails closed — and not true of the
// isolation one: a workspace's roster additions and icons are its own.

test("KNOWN GAP: a workspace's roster overlay is served to the next workspace to load", async () => {
  resetSharedCaches();
  const a = await load("alpha", fixture("alpha", { kv: kvDoc("alpha") }));
  assert.deepStrictEqual(
    a.USERS.map((u) => u.email), ["one@alpha.invalid", "two@alpha.invalid"],
    "alpha did not get its own overlay — the fixture is not exercising the roster path",
  );
  assert.deepStrictEqual(
    Object.keys(a.SPACE_ICONS), ["alpha"],
    "alpha did not get its own icon index — the fixture is not exercising the icon path",
  );

  // No reset: beta loads inside ROSTER_TTL_MS, exactly as a second workspace served by the
  // same isolate would.
  const b = await load("beta", fixture("beta", { kv: kvDoc("beta") }));
  assert.deepStrictEqual(
    b.USERS.map((u) => u.email), ["one@beta.invalid", "two@alpha.invalid"],
    "the roster overlay cache is no longer shared — this gap is CLOSED. Delete this section and fold USERS/SPACE_ICONS into the interleaved comparison above.",
  );
  assert.deepStrictEqual(
    Object.keys(b.SPACE_ICONS), ["alpha"],
    "the workspace icon index is no longer shared — see above, this gap is CLOSED",
  );

  // What is NOT leaked, and must stay that way: everything the config documents own.
  assert.equal(b.BUILD_ID, "build-beta");
  assert.equal(b.LOGIN_HINT, "the beta hint");
  assert.deepStrictEqual(b.CONFIG_USERS.map((u) => u.email), ["one@beta.invalid"]);
});
