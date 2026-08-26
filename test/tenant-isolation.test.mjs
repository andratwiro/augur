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
// WHAT IT MOSTLY DOES NOT GO THROUGH. Not the router: `resolveTenant()` is static in
// Phase A and only ever answers one workspace, so driving `fetch()` could never produce a
// second tenant on its own. The harness calls the loader directly, which is the only place
// two tenants can meet while there is still one of them.
//
// The EXCEPTIONS are the last two sections, and they earn it. Several of the caches this
// file guards are read from EARLY EXITS in `fetch()` — before the gate, before the login
// page — so "which workspace was answered" and "was anybody even signed in" are the same
// question there, and a function-level case cannot ask it. Those sections clear the
// resolver's own per-isolate memo (`__setTenantTestState`) between requests, which is the
// only thing standing between a static resolver and two workspaces, and drive the real
// default export end to end. Nothing else about the request path is stubbed.
//
// ⚠️ AND THAT IS THE ONE THING TO GET RIGHT WHEN ADDING TO THEM. The `request()` helper
// resets the resolver memo and NOTHING ELSE. It used to reset the roster overlay's clock
// on every call, which meant no case in this file could observe that cache through
// `fetch()` — and the leak in it was pinned as a "known gap", through the loader, for as
// long as that was true. A helper that resets a memo is a helper that hides it. If a case
// needs a cold isolate it calls `resetSharedCaches()` in its own body, where the reset is
// visible beside the assertion.
//
// ---- ADDING A CASE ------------------------------------------------------------------
// Each item that closes a module-scope cache two workspaces used to share (the MCP
// derived allowlist, the manifest cache, the R2 storage gauge — all keyed by workspace
// now) needs the same shape of case, and it belongs in this file:
//
//   test("<the cache> is not shared across workspaces", async () => {
//     resetSharedCaches();
//     await load("alpha", envFor("alpha"));               // prime it with alpha
//     const beta = await load("beta", envFor("beta"));    // …then ask as beta
//     assert.deepStrictEqual(beta.<FIELD>, BETA_EXPECTED, "beta observed alpha's <cache>");
//   });
//
// `fixture()` takes overrides, so a case can vary one document without restating both;
// `resetSharedCaches()` puts the per-isolate memos back to cold. If a cache's value is
// read by an UNGATED route, the case belongs in one of the two `fetch()`-driven sections
// at the bottom instead: a function-level case cannot tell "answered the wrong workspace"
// from "answered a stranger".
//
// ---- AND THE ROUTE-LEVEL BACKSTOP IS A DIFFERENT FILE --------------------------------
// This file is the LOADER's harness: it holds `loadTenantContext` and the caches around it
// to the contract, mostly in ASSETS mode. `test/tenant-route-sweep.test.mjs` is the other
// half — the real default export, in BUNDLE mode (what every live instance serves), driven
// over a table of ROUTES with two workspaces, sequentially inside every TTL and
// concurrently. A new cache wants a case here AND a route there: this file says the value
// is keyed, that file says the answer a stranger gets is this workspace's. Adding a route
// there is one line, and it is the cheaper of the two to extend.

import { test } from "node:test";
import assert from "node:assert/strict";

import worker, { __testables as W } from "../src/_worker.js";
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
    // A boolean, so it varies the same way runtimeChrome does below: neighbouring names
    // land on opposite values. This one matters per workspace because it is the switch a
    // shared-password demo turns off while a private instance leaves on.
    userImages: n.charCodeAt(0) % 2 === 0,
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

// The KV overlay a workspace keeps beside its config documents. EVERY fixture in this file
// binds one: the six documents behind it decide who exists in a workspace and what they
// may do, so an overlay-less fixture would compare two workspaces on config alone and call
// that isolation. (It used to be the other way round — most fixtures bound no KV, and the
// reason was that the READ under the overlay was shared, which made the fields it owns
// untestable. That is the leak, not a property of the fixtures.)
function kvDoc(n) {
  return {
    // The roster key is a literal because the worker does not export it; the case below
    // asserts the overlay actually landed, so a rename cannot hollow this fixture out.
    "users:roster": JSON.stringify({ add: { [`two@${n}.invalid`]: { email: `two@${n}.invalid`, name: `Two of ${n}` } }, remove: [] }),
    [W.SPACE_ICONS_KEY]: JSON.stringify({ [n]: { k: `${n}icon`, mime: "image/png", at: 1 } }),
    // The photo index, whose hashes the ungated /__avatar/ route will serve. Keyed on the
    // address the ROSTER OVERLAY above adds, deliberately: that person survives into the
    // next workspace's merged roster, so a shared read hands the neighbour a hash its own
    // index never vouched for — the gap at its sharpest rather than at its mildest.
    [W.USER_AVATARS_KEY]: JSON.stringify({ [`two@${n}.invalid`]: { k: `${n}face`, mime: "image/png", at: 1 } }),
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
const envFor = (n) => fixture(n, { kv: kvDoc(n) });

// Every per-isolate memo `loadTenantContext` can reach, back to cold. Called at the top
// of every case: these caches are module scope, so without it a case inherits whatever
// the previous one left behind and the file's results depend on their order.
//
// `cfgAt: 0` is what makes every load below COLD, and the thing it makes cold is the
// worker's single `TENANT_CTX` slot — one context for the whole isolate, refilled by
// whichever workspace asked last. Every interleaving case in this file is therefore also
// the case for that slot: leave the tick alone and the second workspace is answered out
// of the first one's context without loading anything of its own. It is the last shared
// slot on the config path, and `createTenantContextCache` is what replaces it.
function resetSharedCaches() {
  __setConfigTestState({
    cfgAt: 0, cfgGoodAt: 0, mcpHostAllowlist: null,
    // The two bundle-store caches. Both are keyed by workspace and both outlive a case,
    // so a case that inherited them would be asserting about the previous store.
    manifests: null, storage: null,
    // The two KV documents the ungated routes poll, same rule. The leak cases below PRIME
    // one workspace's entry on purpose and must not inherit a third one's.
    canvasRegistry: null, pitiRemarks: null,
    // The roster overlay's six KV documents, same rule again — and this one matters most
    // between cases, because a case that inherited a warm entry would be asserting about
    // the KV of whichever workspace the PREVIOUS case bound, which is exactly the leak
    // this file is here to catch.
    roster: null,
  });
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
// The pure builder covers the CONFIG half exactly. The overlay half — the three fields
// `rosterFields` derives from `kvDoc(n)`'s six KV documents — is written out as LITERALS
// on top of it, for the same reason: an oracle that computed them by calling the worker's
// own `mergeRoster`/`applyAvatars`/`applySpaceIcons` would agree with those functions
// however wrong they were, and it is precisely those three fields whose KV read used to be
// shared between workspaces. Every value here names its owner, so a leak reads as
// "alpha" in beta's expected-vs-actual rather than merely as "not equal".
//
//   USERS            the config user, then the roster overlay's invitee, with the photo
//                    URL the avatar index vouches for stamped onto them
//   AVATAR_KEYS      the hash `/__avatar/u/<hash>` will serve, UNGATED, for this workspace
//   SPACE_ICONS      the raw icon index, and SPACE_ICON_KEYS/SPACES what it stamps
const expected = (n) => {
  const base = buildTenantContext(n, { instance: instanceDoc(n), routing: routingDoc(n) });
  return Object.freeze({
    ...base,
    USERS: [
      { email: `one@${n}.invalid`, name: `One of ${n}`, role: "admin" },
      { email: `two@${n}.invalid`, name: `Two of ${n}`, avatar: `/__avatar/u/${n}face` },
    ],
    AVATAR_KEYS: new Set([`${n}face`]),
    SPACE_ICONS: { [n]: { k: `${n}icon`, mime: "image/png", at: 1 } },
    SPACE_ICON_KEYS: new Set([`${n}icon`]),
    SPACES: base.SPACES.map((s) => (s.id === n ? { ...s, icon: `/__space-icon/${n}icon` } : s)),
  });
};

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
  const a = await load("alpha", envFor("alpha"));
  resetSharedCaches();
  const b = await load("beta", envFor("beta"));

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

test("a workspace loading SECOND, inside the caches' own TTLs, still gets its own everything", async () => {
  // The case above resets between iterations and loads concurrently, and concurrency is
  // the WEAKER shape: a slot filled by six simultaneous loads is read back by each of them
  // with no await in between, so every one of them sees the value it wrote itself. The
  // shape that actually leaks is sequential — prime one workspace, then ask as the next
  // inside a cache's TTL, which is one isolate answering two requests in a row. That is
  // the recipe in ADDING A CASE at the top, and it is the shape the roster overlay's six
  // KV reads failed for as long as they rode one clock with no workspace key.
  //
  // No `resetSharedCaches()` between the two loads: that is the whole case.
  for (const plan of [["alpha", "beta"], ["beta", "alpha"]]) {
    resetSharedCaches();
    const first = await load(plan[0], envFor(plan[0]));
    assert.deepStrictEqual(first, expected(plan[0]), `${plan[0]} is wrong before any interleaving`);
    const second = await load(plan[1], envFor(plan[1]));
    assert.deepStrictEqual(
      second, expected(plan[1]),
      `${plan[1]} loaded second, inside the previous workspace's tick, and was answered out of ITS caches`,
    );
    // Named field by field for the three the roster overlay owns, because a deep compare
    // reports the first difference and these are the ones whose leak is a security
    // question rather than a rendering one.
    assert.deepStrictEqual(
      second.USERS.map((u) => u.email),
      [`one@${plan[1]}.invalid`, `two@${plan[1]}.invalid`],
      `${plan[1]}'s roster names somebody from ${plan[0]}`,
    );
    assert.deepStrictEqual([...second.AVATAR_KEYS], [`${plan[1]}face`], `${plan[1]} vouches for a neighbour's photo hash`);
    assert.deepStrictEqual(Object.keys(second.SPACE_ICONS), [plan[1]], `${plan[1]} holds a neighbour's icon index`);
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
// The manifests here are given no `head`, so `loadManifests` cannot take its etag
// shortcut and each load parses its own store — this section is about the DERIVATION, and
// the cache the derivation reads through is pinned on its own further down ("the
// bundle-store caches"), including the same-space-id case the shortcut turns on.

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

// ---- the bundle-store caches, whose values ARE one workspace's content ---------------
//
// Two per-isolate caches sit between a request and the store: the parsed manifests
// (`loadManifests`, a 1.5s tick) and the R2 fill gauge (`adminStorageApi`, five minutes).
// Neither is config, so nothing above this line looks at them — and they are the sharpest
// version of this phase's failure, because what a single slot hands the second workspace
// is not a setting that renders differently. It is the file table every served byte is
// resolved through, the routing fragment the gate is derived from, and a measurement of
// how full someone else's store is.
//
// Three shapes are pinned, because closing the leak by deleting the cache would satisfy
// only the first: a neighbour is never answered from this workspace's entry, the entry is
// still a cache, and the etag shortcut INSIDE the value is keyed by workspace too — that
// last one is keyed by SPACE id, and two workspaces may each publish a space under the
// same id.

// A store holding one published space, plus one blob to weigh. `space` is the id the
// space is published under, so two workspaces can be given the SAME one; `etag` is what
// `head` reports, so two stores can be made to agree on it. Every call is counted,
// because WHOSE store was read is half of what these cases assert.
function storeFixture(n, { space = n, etag = `"etag-${n}"` } = {}) {
  const manifest = {
    space: { id: space, name: `Workspace ${n}`, default: true },
    version: n.length,
    files: { "/prototypes/one/index.html": { h: `hash-${n}`, ct: "text/html", s: 10 } },
    routing: { publicPrefixes: ["/prototypes/one/"], versionMap: {}, shellSig: `sig-${n}` },
  };
  const blobs = { [`spaces/${space}/manifest.json`]: JSON.stringify(manifest) };
  const calls = { list: 0, head: 0, get: 0 };
  // Distinct per workspace, so a gauge answered from the wrong store names its owner.
  const bytes = n.length * 1000;
  return {
    calls, bytes, space,
    env: {
      GV_ASSET_SOURCE: "r2",
      BUNDLES: {
        async list({ delimiter } = {}) {
          calls.list++;
          if (delimiter) return { delimitedPrefixes: [`spaces/${space}/`], objects: [], truncated: false };
          return { objects: [{ key: `blobs/${n}`, size: bytes }], truncated: false };
        },
        async head(key) { calls.head++; return blobs[key] === undefined ? null : { etag }; },
        async get(key) {
          calls.get++;
          const body = blobs[key];
          return body === undefined ? null : { etag, async text() { return body; } };
        },
      },
    },
  };
}

const ADMIN = { email: "admin@example.invalid", name: "Admin", role: "admin" };

test("one workspace's published manifests are never served to another", async () => {
  resetSharedCaches();
  // The same space id in both stores: the id is not what distinguishes them, the
  // workspace asking is. Different published bytes, so a leak names its owner.
  const a = storeFixture("alpha", { space: "shared" });
  const b = storeFixture("beta", { space: "shared" });

  const ma = await W.loadManifests("alpha", a.env);
  assert.equal(ma.shared.files["/prototypes/one/index.html"].h, "hash-alpha", "alpha did not read its own store");

  // …and now beta asks, INSIDE the 1.5s tick alpha just stamped — the exact window a
  // single `at` stamp turned into "whatever the isolate last parsed".
  const mb = await W.loadManifests("beta", b.env);
  assert.equal(
    mb.shared.files["/prototypes/one/index.html"].h, "hash-beta",
    "beta was served ALPHA's published manifest: the manifest cache is shared, and with it every byte and every public prefix it decides",
  );
  assert.ok(b.calls.list > 0, "beta never listed its own store — it was answered out of a neighbour's tick");
  assert.equal(ma.shared.files["/prototypes/one/index.html"].h, "hash-alpha", "beta's load rewrote alpha's view");
});

test("the etag shortcut is keyed by workspace too — a matching neighbour etag hands over nothing", async () => {
  resetSharedCaches();
  // Same space id AND the same etag in both stores. Nothing but the workspace key can
  // tell these two manifests apart, which is precisely the case the shortcut skips a
  // parse on.
  const a = storeFixture("alpha", { space: "shared", etag: '"same"' });
  const b = storeFixture("beta", { space: "shared", etag: '"same"' });

  await W.loadManifests("alpha", a.env, true);
  const gets = b.calls.get;
  const mb = await W.loadManifests("beta", b.env, true);

  assert.equal(
    mb.shared.files["/prototypes/one/index.html"].h, "hash-beta",
    "beta took alpha's PARSE through the etag shortcut — the shortcut is keyed by space id, and both workspaces publish that id",
  );
  assert.ok(b.calls.get > gets, "beta never fetched its own manifest body");
});

test("the manifest cache is still a cache — a repeat read inside the tick does not re-list", async () => {
  // The isolation above would also be satisfied by not caching at all, which would put a
  // list + a parse of every manifest on every request — the CPU budget this cache exists
  // to protect. Both properties, or neither is pinned.
  resetSharedCaches();
  const a = storeFixture("alpha");
  await W.loadManifests("alpha", a.env);
  const { list, get } = a.calls;
  assert.ok(list > 0 && get > 0, "the first read did not reach the store at all");

  await W.loadManifests("alpha", a.env);
  await W.loadManifests("alpha", a.env);
  assert.equal(a.calls.list, list, "the tick stopped working — every request re-lists the store");
  assert.equal(a.calls.get, get, "the tick stopped working — every request re-parses the manifests");
});

test("the storage gauge is never answered out of another workspace's store", async () => {
  resetSharedCaches();
  const a = storeFixture("alpha");
  const b = storeFixture("beta");
  assert.notEqual(a.bytes, b.bytes, "both fixtures weigh the same — nothing below distinguishes them");

  // Prime alpha's entry, then ask as beta well inside the five-minute window.
  const first = await (await W.adminStorageApi("alpha", a.env, ADMIN)).json();
  assert.equal(first.bytes, a.bytes, "alpha was not measured against its own store");

  const lists = b.calls.list;
  const second = await (await W.adminStorageApi("beta", b.env, ADMIN)).json();
  assert.equal(
    second.bytes, b.bytes,
    "beta was shown ALPHA's fill gauge — a workspace approaching the ceiling would be told it has room",
  );
  assert.ok(b.calls.list > lists, "beta never listed its own store: it was answered from a neighbour's cached bytes");
});

test("the storage gauge is still cached, per workspace", async () => {
  resetSharedCaches();
  const a = storeFixture("alpha");
  await W.adminStorageApi("alpha", a.env, ADMIN);
  const lists = a.calls.list;
  assert.ok(lists > 0, "the first call did not list the store at all");

  const again = await (await W.adminStorageApi("alpha", a.env, ADMIN)).json();
  assert.equal(a.calls.list, lists, "the five-minute window stopped working — every admin page load re-walks the store");
  assert.equal(again.bytes, a.bytes);
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

// ---- the canvas surfaces, per workspace ----------------------------------------------
//
// WHY THIS IS HERE AND NOT LEFT TO THE SNAPSHOT. The byte-level response snapshot pins no
// canvas board — its corpus has no registered canvas path, no insert picker and no
// realtime upgrade — so the ratchet is green whatever these three routes answer. The
// canvas cluster is therefore proved at the RESPONSE level here instead: the bytes a
// board's loader page carries, the bodies the two aggregates return, and the origin the
// multiplayer proxy dials.
//
// Every case drives the surface with two contexts and ONE shared environment, which is
// what an isolate serving both workspaces has: the same KV, the same canvas registry, the
// same per-isolate memos. The only thing that differs between the two calls is the
// workspace handed in — so an answer that names the wrong workspace can only have come
// from state the two shared.

function sharedCanvasEnv(registry) {
  const store = new Map(Object.entries(registry));
  return {
    COMMENTS: {
      async get(k) { return store.has(k) ? store.get(k) : null; },
      async put(k, v) { store.set(k, v); },
      async delete(k) { store.delete(k); },
    },
    ASSETS: { async fetch() { return new Response("", { status: 404 }); } },
  };
}

const boardPath = "/boards/shared-board/";

test("a board's loader page carries the CALLING workspace's tags, not its neighbour's", async () => {
  const ctx = {};
  for (const n of NAMES) {
    resetSharedCaches();
    ctx[n] = await load(n, envFor(n));
    assert.equal(
      ctx[n].CANVAS_LOADER_EXTRAS, `<script src="/${n}-loader.js"></script>`,
      `${n}'s context does not carry its own loader tags — the case would assert nothing`,
    );
  }

  // One registry, one KV: the board exists once and both workspaces can reach it, exactly
  // as they would inside one isolate. What must differ is the page rendered for it.
  const env = sharedCanvasEnv({
    canvases: JSON.stringify({ [boardPath]: { name: "Shared Board", by: "", t: 1 } }),
  });
  const req = () => new Request("https://x.test" + boardPath);
  const url = () => new URL("https://x.test" + boardPath);

  for (const plan of [["alpha", "beta"], ["beta", "alpha"]]) {
    for (const n of plan) {
      const res = await W.virtualCanvas(ctx[n], req(), env, url());
      assert.ok(res, `${n} was not served the board at all`);
      const html = await res.text();
      assert.ok(
        html.includes(`<script src="/${n}-loader.js"></script>`),
        `order ${plan.join(",")}: ${n}'s board page lost its own overlay stack`,
      );
      const other = NAMES.find((x) => x !== n);
      assert.equal(
        html.includes(`/${other}-loader.js`), false,
        `order ${plan.join(",")}: ${n}'s board page injected ${other}'s scripts — a script tag from the neighbouring workspace running on this workspace's board`,
      );
    }
  }
});

test("the insert picker and the track list answer the CALLING workspace", async () => {
  const ctx = {};
  for (const n of NAMES) {
    resetSharedCaches();
    ctx[n] = await load(n, envFor(n));
  }

  for (const plan of [["alpha", "beta"], ["beta", "alpha"]]) {
    for (const n of plan) {
      const where = `order ${plan.join(",")}: ${n}`;
      assert.deepStrictEqual(
        await (await W.canvasAggregate(ctx[n], "catalog", true)).json(), [{ id: `${n}-card` }],
        `${where} was handed another workspace's catalogue — every prototype URL that workspace ships`,
      );
      assert.deepStrictEqual(
        await (await W.canvasAggregate(ctx[n], "tracks", true)).json(), [{ id: `${n}-track` }],
        `${where} was handed another workspace's tracks`,
      );
    }
  }

  // The unauthenticated answers stay empty per workspace: a signed-out viewer gets the
  // board, never the directory of everything else that exists.
  assert.deepStrictEqual(await (await W.canvasAggregate(ctx.alpha, "catalog", false)).json(), []);
  assert.deepStrictEqual(await (await W.canvasAggregate(ctx.alpha, "tracks", false)).json(), []);
});

test("the multiplayer proxy dials the CALLING workspace's realtime worker", async () => {
  const ctx = {};
  for (const n of NAMES) {
    resetSharedCaches();
    ctx[n] = await load(n, envFor(n));
  }

  // The proxy calls global fetch. Stubbed so the case records the URL it would have dialled
  // and reaches no network — a realtime origin must never be contacted from the suite. The
  // stub answers 200 rather than the real 101: the workers runtime returns the upgrade
  // response, and node's Response constructor refuses a status below 200.
  const dialled = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (req) => { dialled.push(req.url); return new Response(null, { status: 200 }); };
  try {
    const env = { RT_SHARED_SECRET: "s3cret" };
    for (const n of ["alpha", "beta", "beta", "alpha"]) {
      const url = new URL(`https://x.test/__rt?path=${boardPath}`);
      const req = new Request(url, { headers: { Upgrade: "websocket" } });
      await W.rtProxy(ctx[n], req, url, env);
      assert.equal(
        dialled.at(-1).startsWith(`https://rt.${n}.invalid/room`), true,
        `${n}'s board joined ${dialled.at(-1)} — a room in another workspace's realtime worker, carrying this worker's shared secret`,
      );
    }
  } finally {
    globalThis.fetch = realFetch;
  }

  // And a workspace that configures no realtime origin is told so, rather than falling
  // through to whichever neighbour configured one.
  resetSharedCaches();
  const silent = await load("beta", fixture("beta", {
    instance: { ...instanceDoc("beta"), rtOrigin: "" },
  }));
  const url = new URL("https://x.test/__rt");
  const res = W.rtProxy(silent, new Request(url, { headers: { Upgrade: "websocket" } }), url, {});
  assert.equal(res.status, 501);
  assert.equal((await res.json()).error, "realtime-not-configured");
});

// ---- the two KV documents the UNGATED routes poll, end to end through fetch() ---------
//
// Two per-isolate caches hold a KV DOCUMENT rather than a config field: the created-board
// registry (`readCanvasRegistry`, a 15s tick, read on every asset 404) and the companion's
// remark queue (`pitiApi`'s GET branch, same tick, read on every poll). Both existed to
// keep a steady KV reader off the free-tier daily get() budget, and both were keyed on
// nothing, so within one tick the SECOND workspace to ask was handed the FIRST one's
// document — its boards, or the text an agent queued for its pages — having read none of
// its own keys.
//
// WHY THIS SECTION DRIVES THE REAL fetch() AND THE REST OF THE FILE DOES NOT. Both routes
// are reached from EARLY EXITS, ahead of the login page: a board is a share link, so
// `virtualCanvas` runs as the last door before the gate answers, and `/__piti` exits before
// identity is resolved at all. The leak is therefore not "a signed-in user of one workspace
// sees a neighbour's board" but "a stranger does", and only the router can show that. The
// resolver is static in Phase A, so these cases clear its memo between requests — which is
// exactly what an isolate serving two workspaces will do for itself once the body reads
// Host. Nothing else is stubbed: the gate, the config load and the routing are the real
// ones.
//
// WHY THE SNAPSHOT IS NOT THE EVIDENCE. `test/response-snapshot.test.mjs` pins no canvas
// board and no `/__piti` poll — its corpus has neither — so the byte ratchet is green
// whatever these two routes answer. It also runs in ASSETS mode, which is what these cases
// use, so it could not have covered them in bundle mode either.

// A workspace serving on its own: its two config documents, its own KV, and a record of
// every key that KV was actually asked for. Each workspace gets its own store, because
// these two documents ARE per-workspace content — unlike the token store in the exchange
// section above, which two workspaces share on purpose.
function servingFixture(n, kvSeed = {}) {
  const docs = { "instance.json": instanceDoc(n), "routing.json": routingDoc(n) };
  const store = new Map(Object.entries(kvSeed));
  const reads = [];
  return {
    reads, store,
    env: {
      ASSETS: {
        async fetch(url) {
          const name = String(url).split("/").pop();
          const doc = docs[name];
          if (!doc) return { ok: false, status: 404, async json() { throw new Error("not found"); } };
          return { ok: true, status: 200, async json() { return structuredClone(doc); } };
        },
      },
      COMMENTS: {
        async get(k) { reads.push(k); return store.has(k) ? store.get(k) : null; },
        async put(k, v) { store.set(k, v); },
        async delete(k) { store.delete(k); },
      },
    },
  };
}

// One request, arriving at an isolate that has already served the neighbour.
//
// ⚠️ IT CLEARS EXACTLY ONE THING, and the list is the whole value of this helper. The
// tenant memo — `tenantMemo`, the one slot `resolveTenant()` reads the static id into — is
// cleared because the Phase A resolver would otherwise pin the first workspace to reach it
// for the isolate's life, and every case below would be two requests for alpha. Clearing
// it is what a Host-reading resolver will do for itself; leaving it is what makes the
// slot's own wrongness visible, since with it warm this whole section answers "alpha"
// twice. It is also the only memo a REAL two-workspace isolate would not have.
//
// EVERY OTHER PER-ISOLATE MEMO IS LEFT EXACTLY AS THE PREVIOUS REQUEST LEFT IT. That is
// not a convenience, it is the coverage: a memo this helper resets is a memo no case in
// this file can observe through `fetch()`, and this helper used to reset the roster
// overlay's clock on every request. The roster leak was pinned as a KNOWN GAP for exactly
// that long — asserted through the loader, invisible to the router — while the file's own
// header said nothing but the resolver was stubbed. So: no blanket resets here. A case
// that genuinely needs a cold memo calls `resetSharedCaches()` itself, in its own body,
// where the reset is visible next to the assertion it is standing behind.
function request(fx, path, init) {
  W.__setTenantTestState({ memo: null });
  return worker.fetch(new Request("https://x.test" + path, init), fx.env, { waitUntil() {} });
}

// How many times this workspace's KV was asked for one key. Counted per key rather than in
// total, because a request reads several documents and a total would drown the one read
// under test.
const reads = (fx, key) => fx.reads.filter((k) => k === key).length;

const boardOf = (n) => `/boards/${n}-board/`;
const registryOf = (n) => JSON.stringify({ [boardOf(n)]: { name: `Board of ${n}`, by: "", t: 1 } });

test("a signed-out stranger is never served a NEIGHBOUR's board, and the workspace's own still serves", async () => {
  resetSharedCaches();
  const alpha = servingFixture("alpha", { [W.CANVASES_KEY]: registryOf("alpha") });
  const beta = servingFixture("beta", { [W.CANVASES_KEY]: registryOf("beta") });

  // Premise: nobody is signed in, and each workspace's config really did load. Without
  // this a 200 below could be an open gate rather than a served board.
  const primed = await request(alpha, boardOf("alpha"));
  const primedHtml = await primed.text();
  assert.equal(primed.status, 200, "alpha's own board did not serve at all");
  assert.match(primedHtml, /<title>Board of alpha<\/title>/, "alpha was not served its own board");

  // …and now beta asks for the SAME URL, inside the tick alpha just stamped. Beta's
  // registry never named that path, so the answer must be beta's login page.
  beta.reads.length = 0;
  const leaked = await request(beta, boardOf("alpha"));
  const leakedHtml = await leaked.text();
  assert.equal(
    /Board of alpha/.test(leakedHtml), false,
    "beta was served ALPHA's board — ungated, signed out, at the early exit before the login page: the board registry cache is shared",
  );
  assert.ok(
    beta.reads.includes(W.CANVASES_KEY),
    "beta never read its own registry — it was answered out of a neighbour's tick",
  );

  // The standard the rest of this file holds to: not "the two differ" but "each got ITS
  // OWN answer". A cache that answered every workspace with an empty registry would also
  // stop the leak, and would take every board offline doing it.
  beta.reads.length = 0;
  const own = await request(beta, boardOf("beta"));
  assert.equal(own.status, 200);
  assert.match(
    await own.text(), /<title>Board of beta<\/title>/,
    "beta cannot reach the board its OWN registry names",
  );

  // And alpha's view was not rewritten by beta's read.
  const again = await request(alpha, boardOf("alpha"));
  assert.match(await again.text(), /<title>Board of alpha<\/title>/, "beta's request rewrote alpha's registry view");
});

test("the board registry is still a cache, and a create busts only its OWN workspace", async () => {
  // Isolation alone would be satisfied by deleting the cache, which puts a KV read back on
  // every asset 404 — every gated page a stranger opens. Both properties, or neither is
  // pinned.
  resetSharedCaches();
  const alpha = servingFixture("alpha", { [W.CANVASES_KEY]: registryOf("alpha") });
  const beta = servingFixture("beta", { [W.CANVASES_KEY]: registryOf("beta") });

  await request(alpha, boardOf("alpha"));
  await request(beta, boardOf("beta"));
  const [a0, b0] = [reads(alpha, W.CANVASES_KEY), reads(beta, W.CANVASES_KEY)];
  assert.ok(a0 > 0 && b0 > 0, "neither workspace read its registry at all — nothing here is a cache");
  await request(alpha, boardOf("alpha"));
  await request(beta, boardOf("beta"));
  assert.equal(reads(alpha, W.CANVASES_KEY), a0, "the tick stopped working — every 404 re-reads the registry");
  assert.equal(reads(beta, W.CANVASES_KEY), b0, "beta's second lookup did not ride its own cache");

  // A create in alpha is live on alpha at once — the bust reached alpha's entry.
  const me = { email: "one@alpha.invalid", name: "One of alpha", role: "admin" };
  const canvasesUrl = new URL("https://x.test/__canvases");
  const created = await W.canvasesApi("alpha", new Request(canvasesUrl, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dir: "/boards/", name: "Fresh" }),
  }), canvasesUrl, alpha.env, me);
  assert.equal(created.status, 200, "the create was refused");
  const fresh = await request(alpha, "/boards/fresh/");
  assert.match(await fresh.text(), /<title>Fresh<\/title>/, "a just-created board is not live on its own workspace");

  // …and beta, whose registry that write never touched, still answers from its own entry.
  const before = reads(beta, W.CANVASES_KEY);
  const unaffected = await request(beta, boardOf("beta"));
  assert.match(await unaffected.text(), /<title>Board of beta<\/title>/);
  assert.equal(
    reads(beta, W.CANVASES_KEY), before,
    "a create in ALPHA sent beta back to KV — the bust is not keyed by workspace",
  );
});

test("a workspace's queued remarks are never read aloud to the next workspace to poll", async () => {
  resetSharedCaches();
  const now = Date.now();
  const queue = (n, id) => JSON.stringify([{ id, path: "/p/", text: `${n}'s queued remark`, kind: "ux", ts: now }]);
  const alpha = servingFixture("alpha", { "pt:remarks": queue("alpha", 1) });
  const beta = servingFixture("beta", { "pt:remarks": queue("beta", 2) });

  const primed = await (await request(alpha, "/__piti?path=/p/&since=0")).json();
  assert.deepStrictEqual(
    primed.remarks.map((r) => r.text), ["alpha's queued remark"],
    "alpha was not handed its own queue — the case would assert nothing",
  );

  beta.reads.length = 0;
  const leaked = await (await request(beta, "/__piti?path=/p/&since=0")).json();
  assert.deepStrictEqual(
    leaked.remarks.map((r) => r.text), ["beta's queued remark"],
    "beta was handed ALPHA's queued remark — the poll is an ungated route and the cache is shared",
  );
  assert.ok(
    beta.reads.includes("pt:remarks"),
    "beta never read its own queue — it was answered out of a neighbour's tick",
  );
});

test("the remark queue is still a cache, and a write busts only its OWN workspace", async () => {
  resetSharedCaches();
  const env = (n) => servingFixture(n, { "pt:remarks": JSON.stringify([]) });
  const alpha = env("alpha");
  const beta = env("beta");
  const poll = (fx) => request(fx, "/__piti?path=/p/&since=0");

  await poll(alpha);
  await poll(beta);
  const [a0, b0] = [reads(alpha, "pt:remarks"), reads(beta, "pt:remarks")];
  assert.ok(a0 > 0 && b0 > 0, "neither workspace read its queue at all — nothing here is a cache");
  await poll(alpha);
  assert.equal(reads(alpha, "pt:remarks"), a0, "the tick stopped working — every poll re-reads KV");

  // A remark posted to alpha shows up on alpha's very next poll…
  const url = new URL("https://x.test/__piti");
  const posted = await W.pitiApi("alpha", new Request(url, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Review-Key": "k" },
    body: JSON.stringify({ type: "remark", path: "/p/", text: "for alpha only" }),
  }), url, { ...alpha.env, REVIEW_EXPORT_KEY: "k" });
  assert.equal(posted.status, 200);
  const after = await (await poll(alpha)).json();
  assert.deepStrictEqual(after.remarks.map((r) => r.text), ["for alpha only"], "the bust did not reach alpha");

  // …and beta's cached entry is untouched by it: beta polls AFTER the write and must still
  // be answered from its own entry rather than sent back to KV by a neighbour's bust.
  const betaPoll = await (await poll(beta)).json();
  assert.equal(reads(beta, "pt:remarks"), b0, "a write to ALPHA's queue busted beta's entry too");
  assert.deepStrictEqual(betaPoll.remarks, [], "beta saw a remark written for alpha");
});

// ---- the roster overlay, end to end through fetch() -----------------------------------
//
// The sixth cache, and the only one whose value decides AUTHORIZATION. `rosterFields()`
// reads six KV documents — the roster overlay (invites and removals), the display-name
// index, the ROLE overlay, the per-workspace MEMBERSHIP index, the photo index and the
// workspace-icon index — and used to hold them in one module-scope slot behind one clock.
// Within ROSTER_TTL_MS the second workspace to load reused the first's six reads, and the
// three context fields built from them (USERS, AVATAR_KEYS, SPACE_ICONS/SPACE_ICON_KEYS)
// came back as the neighbour's.
//
// WHY IT IS DRIVEN THROUGH THE ROUTER. Two of the three routes that read those fields are
// UNGATED — `/__people` and `/__avatar/`, both taken at early exits ahead of the login page
// because the comment overlay and the presence chips load them from public prototypes. So
// the leak is not "a signed-in member of one workspace sees a neighbour's colleague", it is
// "a signed-out stranger does", and only `fetch()` can say that. The third is the sharpest
// and needs a session: a person's ROLE rides the same cache, so a workspace's role overlay
// was answering for a workspace that has no role overlay at all.
//
// WHY IT WAS NOT CAUGHT. It was pinned — as a KNOWN GAP, asserted through
// `loadTenantContext`. `request()` reset the roster clock on every call, so no case in this
// file could reach the cache through the router, and the interleaved comparison excluded
// the three fields for the same reason. The pin recorded the gap and hid its blast radius:
// nothing in it said "ungated" and nothing in it said "admin".
//
// WHY THE SNAPSHOT IS NOT THE EVIDENCE, again. `test/response-snapshot.test.mjs` pins no
// `/__people` request and no `/__avatar/` request — its corpus has neither — so the byte
// ratchet is green whatever these routes answer.

// The overlay documents a workspace keeps, as a KV seed for `servingFixture`. Written out
// rather than reusing `kvDoc` because these cases care about the KEYS the worker reads and
// about bytes that are reachable, not only about the parsed fields.
const PNG = (tag) => "data:image/png;base64," + Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]),
  Buffer.from((tag + "................................").slice(0, 32)),
]).toString("base64");

function overlaySeed(n) {
  return {
    "users:roster": JSON.stringify({
      add: { [`two@${n}.invalid`]: { email: `two@${n}.invalid`, name: `Two of ${n}` } }, remove: [],
    }),
    [W.USER_AVATARS_KEY]: JSON.stringify({ [`two@${n}.invalid`]: { k: `${n}face`, mime: "image/png", at: 1 } }),
  };
}

test("a signed-out stranger asking a workspace's /__people is never shown a NEIGHBOUR's person", async () => {
  resetSharedCaches();
  const alpha = servingFixture("alpha", overlaySeed("alpha"));
  const beta = servingFixture("beta", overlaySeed("beta"));

  // Premise: alpha's own overlay person resolves, with no cookie on the request. If this
  // did not answer, a `[]` below would mean "the route is broken", not "the leak is shut".
  const primed = await (await request(alpha, "/__people?names=Two%20of%20alpha")).json();
  assert.deepStrictEqual(
    primed.people.map((p) => p.name), ["Two of alpha"],
    "alpha's own invitee did not resolve — the case would assert nothing",
  );

  // …and now beta asks for that person, inside the tick alpha just stamped. Beta's roster
  // overlay never named them, and beta's config does not either.
  beta.reads.length = 0;
  const leaked = await (await request(beta, "/__people?names=Two%20of%20alpha")).json();
  assert.deepStrictEqual(
    leaked.people, [],
    "beta's UNGATED /__people named a person out of ALPHA's roster overlay, to a stranger with no cookie: the roster cache is shared",
  );
  assert.ok(
    beta.reads.includes("users:roster"),
    "beta never read its own roster overlay — it was answered out of a neighbour's tick",
  );

  // The standard the rest of this file holds to: not "the two differ" but "each got ITS
  // OWN answer". A cache that answered every workspace with an empty overlay would also
  // stop the leak, and would un-invite everybody doing it.
  const own = await (await request(beta, "/__people?names=Two%20of%20beta")).json();
  assert.deepStrictEqual(
    own.people.map((p) => p.name), ["Two of beta"],
    "beta cannot resolve the person its OWN overlay invited",
  );

  // And alpha's view was not rewritten by beta's read.
  const again = await (await request(alpha, "/__people?names=Two%20of%20alpha")).json();
  assert.deepStrictEqual(again.people.map((p) => p.name), ["Two of alpha"], "beta's request rewrote alpha's roster");
});

test("a workspace's ungated /__avatar/ never serves a hash only a NEIGHBOUR's photo index vouches for", async () => {
  resetSharedCaches();
  // ⚠️ BOTH stores hold the blob at `avatar:alphaface`. Avatar blobs are content-addressed,
  // so anything sharing a namespace shares them, and the fixture says so deliberately: the
  // ONLY thing standing between beta and those bytes is whether beta's own photo INDEX
  // vouches for the hash, which is the property under test. A fixture where the blob were
  // simply missing from beta's store would 404 for a reason that has nothing to do with the
  // index — and would pass against the leaking worker.
  const blob = PNG("alpha-face");
  const alpha = servingFixture("alpha", { ...overlaySeed("alpha"), [W.AVATAR_BLOB_PREFIX + "alphaface"]: blob });
  const beta = servingFixture("beta", {
    ...overlaySeed("beta"),
    [W.AVATAR_BLOB_PREFIX + "alphaface"]: blob,
    [W.AVATAR_BLOB_PREFIX + "betaface"]: PNG("beta-face"),
  });

  const primed = await request(alpha, "/__avatar/u/alphaface");
  assert.equal(primed.status, 200, "alpha cannot serve the photo its own index vouches for");
  assert.equal(primed.headers.get("Content-Type"), "image/png");

  beta.reads.length = 0;
  const leaked = await request(beta, "/__avatar/u/alphaface");
  assert.equal(
    leaked.status, 404,
    "beta served a photo at a hash only ALPHA's index names — ungated, signed out, and the bytes are a person's face",
  );
  assert.equal(
    beta.reads.includes(W.AVATAR_BLOB_PREFIX + "alphaface"), false,
    "beta read the blob before deciding it was allowed to — the allowlist check must come FIRST, or an ungated route is a KV read amplifier",
  );

  // Its own still serves: the fix is a key, not a closed door. A cache that answered every
  // workspace with an empty photo index would also stop the leak, and would blank every
  // face on every board doing it.
  const own = await request(beta, "/__avatar/u/betaface");
  assert.equal(own.status, 200, "beta cannot serve the photo its OWN index vouches for");
  assert.equal(own.headers.get("Content-Type"), "image/png");

  // And alpha's view was not rewritten by beta's request.
  assert.equal((await request(alpha, "/__avatar/u/alphaface")).status, 200, "beta's request closed alpha's own photo");
});

// Roles ride the same six reads, and this is the case that makes the cache an authorization
// boundary rather than a disclosure one. One PERSON, two workspaces — which is the hosted
// model: an address is an identity across workspaces, and what it may do is decided per
// workspace. Pat is an admin in alpha (alpha's KV carries the role overlay that says so)
// and a viewer in beta, whose KV carries no role overlay at all.
const PAT = "pat@example.invalid";

function roleFixture(n, { role, roles = null } = {}) {
  const seed = { "users:secrets": JSON.stringify({ [PAT]: null }) };
  if (roles) seed[W.USER_ROLES_KEY] = JSON.stringify(roles);
  const fx = servingFixture(n, seed);
  // The instance document is this workspace's own: same person, its own verdict on them.
  fx.env.ASSETS = fixture(n, {
    instance: { ...instanceDoc(n), users: [{ email: PAT, name: "Pat", role }] },
  }).ASSETS;
  return fx;
}

async function patCookie(fx, role) {
  const user = { email: PAT, name: "Pat", role };
  const hash = await W.hashPassword("correct horse battery staple");
  fx.store.set("users:secrets", JSON.stringify({ [PAT]: hash }));
  const secret = await W.effectiveSecret(fx.env, user);
  assert.ok(secret, "the fixture did not give Pat a resolvable secret");
  // `__Host-augur_user` is spelled out because the worker does not export the name; the
  // assertions below would fail loudly if a rename made this cookie unreadable.
  return { headers: { Cookie: `__Host-augur_user=${PAT}.${await W.userToken(fx.env, user, secret)}` } };
}

test("a viewer in THIS workspace is not made an admin by a neighbour's role overlay", async () => {
  resetSharedCaches();
  const alpha = roleFixture("alpha", { role: "viewer", roles: { [PAT]: "admin" } });
  const beta = roleFixture("beta", { role: "viewer" });
  const alphaAuth = await patCookie(alpha, "viewer");
  const betaAuth = await patCookie(beta, "viewer");

  // Premise: in alpha the overlay really does promote Pat, so the leak has something to
  // leak. Without this a "viewer" below could mean the overlay never applied anywhere.
  const inAlpha = await (await request(alpha, "/__me", alphaAuth)).json();
  assert.equal(inAlpha.user.role, "admin", "alpha's role overlay did not apply — the case would assert nothing");
  assert.equal((await request(alpha, "/__admin/users", alphaAuth)).status, 200, "alpha's admin was refused");

  // …and now beta, inside the tick alpha just stamped. Beta's config says viewer and beta's
  // KV holds no role overlay at all, so there is no document anywhere in beta that could
  // make this answer "admin".
  beta.reads.length = 0;
  const inBeta = await (await request(beta, "/__me", betaAuth)).json();
  assert.equal(
    inBeta.user.role, "viewer",
    "beta reported ADMIN for a person its own config calls a viewer — out of ALPHA's role overlay, through a shared roster cache",
  );
  assert.equal(inBeta.user.admin, false, "…and the admin flag the chrome renders the panel from agreed with it");

  // The boundary itself, not the label on it.
  const refused = await request(beta, "/__admin/users", betaAuth);
  assert.equal(
    refused.status, 403,
    "beta's admin API let in a person who is only an admin NEXT DOOR: the roster cache decides authorization, so keying it is not cosmetic",
  );
  assert.equal((await refused.json()).error, "forbidden");
  assert.ok(
    beta.reads.includes(W.USER_ROLES_KEY),
    "beta never read its own role overlay — it was answered out of a neighbour's tick",
  );

  // And alpha still administers alpha: the fix is a key, not a demotion.
  assert.equal((await request(alpha, "/__admin/users", alphaAuth)).status, 200, "alpha's admin lost their own workspace");
});

test("the roster overlay is still a cache, and a write busts only its OWN workspace", async () => {
  // Isolation alone would be satisfied by deleting the cache, which puts SIX KV reads back
  // on every config tick — the reads that exhausted the daily get() budget (2026-08-20).
  // Both properties, or neither is pinned.
  resetSharedCaches();
  const alpha = servingFixture("alpha", overlaySeed("alpha"));
  const beta = servingFixture("beta", overlaySeed("beta"));
  const people = (fx, who) => request(fx, `/__people?names=${encodeURIComponent(who)}`);

  await people(alpha, "Two of alpha");
  await people(beta, "Two of beta");
  const [a0, b0] = [reads(alpha, "users:roster"), reads(beta, "users:roster")];
  assert.ok(a0 > 0 && b0 > 0, "neither workspace read its overlay at all — nothing here is a cache");
  await people(alpha, "Two of alpha");
  await people(beta, "Two of beta");
  assert.equal(reads(alpha, "users:roster"), a0, "the TTL stopped working — every request re-reads six KV documents");
  assert.equal(reads(beta, "users:roster"), b0, "beta's second lookup did not ride its own entry");

  // A name set in alpha is live on alpha at once — the bust reached alpha's entry.
  const me = { email: "one@alpha.invalid", name: "One of alpha", role: "admin" };
  const named = await W.meNameApi("alpha", new Request("https://x.test/__me/name", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Renamed in alpha" }),
  }), alpha.env, me);
  assert.equal(named.status, 200, "the rename was refused");
  const after = await (await people(alpha, "Renamed in alpha")).json();
  assert.deepStrictEqual(
    after.people.map((p) => p.name), ["Renamed in alpha"],
    "a just-set display name is not live on its own workspace",
  );

  // …and beta, whose six documents that write never touched, still answers from its own
  // entry rather than being sent back to KV by a neighbour's bust.
  const before = reads(beta, "users:roster");
  const unaffected = await (await people(beta, "Two of beta")).json();
  assert.deepStrictEqual(unaffected.people.map((p) => p.name), ["Two of beta"]);
  assert.equal(
    reads(beta, "users:roster"), before,
    "a rename in ALPHA sent beta back to KV — the bust is not keyed by workspace",
  );
});
