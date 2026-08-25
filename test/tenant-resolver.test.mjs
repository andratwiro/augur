// The tenant resolver seam — `resolveTenant(request, env)`.
//
// One function answers "which workspace is this request for", and fetch() calls it once,
// at the top, before any config is read. Today the body is static; serving several
// workspaces from one deployment replaces the body with a Host lookup and nothing else.
//
// Two things are worth testing about a seam that currently returns a constant per
// deployment, and neither is the constant:
//
//   1. IT ACTUALLY RESOLVES. Two deployments must produce two different ids. A resolver
//      that hard-codes one answer would pass every other test in this repo — there is
//      only ever one workspace to be wrong about — and would then be discovered as a
//      wrong answer by the first tenant who shares an isolate with another.
//
//   2. THE ABSENT CASE KEEPS WORKING. Every live instance today serves an instance.json
//      with no `tenantId` in it, because no build has emitted the field until now. Those
//      instances take this engine by pin bump, before any rebuild, so "no tenantId"
//      cannot be an error state — it has to answer the default and change nothing.
//
// Plus the shape of the memo, which is where a plausible-looking simplification would
// cost real money: pin the fallback and a deployment stays anonymous for the isolate's
// life; drop the stamp and a broken config read gets one extra store read per request
// instead of one per tick.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";
import { checkTenantResolver } from "../scripts/one-tenant-resolver.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const WORKER = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "_worker.js");
const req = () => new Request("https://example.test/");

// Assets mode: the worker reads instance.json through the ASSETS binding, with a string
// url — the same call loadConfig's grab() makes. `reads` counts them, because the point
// of the memo is that there are not many.
function assetsEnv(instance, { fail = false } = {}) {
  const env = {
    reads: 0,
    ASSETS: {
      async fetch(r) {
        const p = new URL(typeof r === "string" ? r : r.url).pathname;
        if (p !== "/__config/instance.json") return new Response("Not Found", { status: 404 });
        env.reads += 1;
        if (fail) throw new Error("config read forced to fail");
        return new Response(JSON.stringify(instance), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      },
    },
  };
  return env;
}

// Bundle mode: the live serving mode. Same document, read out of the R2 store.
function bundleEnv(instance) {
  const env = {
    reads: 0,
    GV_ASSET_SOURCE: "r2",
    BUNDLES: {
      async get(k) {
        if (k !== "config/instance.json") return null;
        env.reads += 1;
        return { text: async () => JSON.stringify(instance) };
      },
    },
  };
  return env;
}

test("two deployments resolve to two different tenant ids", async () => {
  // A deploy config naming one workspace, and another naming a different one — the two
  // instance.json documents their builds emit.
  W.__setTenantTestState();
  const alpha = await W.resolveTenant(req(), assetsEnv({ tenantId: "alpha-studio", users: [] }));

  W.__setTenantTestState(); // a second isolate: the memo is per-deployment, per-isolate
  const beta = await W.resolveTenant(req(), assetsEnv({ tenantId: "beta-works", users: [] }));

  assert.deepEqual(alpha, { tenantId: "alpha-studio" });
  assert.deepEqual(beta, { tenantId: "beta-works" });
  assert.notEqual(alpha.tenantId, beta.tenantId, "the resolver must not answer a constant");
});

test("bundle mode reads the same document out of the store", async () => {
  W.__setTenantTestState();
  const env = bundleEnv({ tenantId: "gamma-lab", users: [] });
  assert.deepEqual(await W.resolveTenant(req(), env), { tenantId: "gamma-lab" });
  assert.equal(env.reads, 1);
});

test("an instance.json with no tenantId answers the default — every live instance today", async () => {
  W.__setTenantTestState();
  const env = assetsEnv({ users: [], engineVersion: "0.14.0" }); // a build from before the field
  assert.deepEqual(await W.resolveTenant(req(), env), { tenantId: W.DEFAULT_TENANT_ID });
  assert.equal(W.DEFAULT_TENANT_ID, "default");
});

test("a blank or non-string tenantId is the same as absent", async () => {
  for (const tenantId of ["", "   ", 7, null, {}]) {
    W.__setTenantTestState();
    const answer = await W.resolveTenant(req(), assetsEnv({ tenantId, users: [] }));
    assert.deepEqual(answer, { tenantId: W.DEFAULT_TENANT_ID }, `tenantId: ${JSON.stringify(tenantId)}`);
  }
});

test("a tenantId is trimmed, not taken raw", async () => {
  W.__setTenantTestState();
  assert.deepEqual(await W.resolveTenant(req(), assetsEnv({ tenantId: " padded \n" })), { tenantId: "padded" });
});

test("a raw build with no config source at all answers the default, and reads nothing", async () => {
  W.__setTenantTestState();
  assert.deepEqual(await W.resolveTenant(req(), {}), { tenantId: W.DEFAULT_TENANT_ID });
  W.__setTenantTestState();
  assert.deepEqual(await W.resolveTenant(req(), undefined), { tenantId: W.DEFAULT_TENANT_ID });
});

test("a failed config read answers the default rather than throwing", async () => {
  W.__setTenantTestState();
  const env = assetsEnv({ tenantId: "delta-x" }, { fail: true });
  assert.deepEqual(await W.resolveTenant(req(), env), { tenantId: W.DEFAULT_TENANT_ID });
});

test("a resolved id is read once per isolate, not once per request", async () => {
  W.__setTenantTestState();
  const env = assetsEnv({ tenantId: "epsilon" });
  for (let i = 0; i < 5; i++) assert.deepEqual(await W.resolveTenant(req(), env), { tenantId: "epsilon" });
  assert.equal(env.reads, 1, "the deployment's identity does not change without a redeploy");
});

test("a FAILED read is stamped, not pinned: it retries on the next tick, not every request", async () => {
  // Stamp-first, the same shape loadConfig uses. Within the tick a broken read costs
  // nothing extra; after it, the resolver tries again — so an instance whose config was
  // briefly unreadable does not stay anonymous for the life of the isolate.
  W.__setTenantTestState();
  const env = assetsEnv({ tenantId: "zeta" }, { fail: true });
  await W.resolveTenant(req(), env);
  await W.resolveTenant(req(), env);
  await W.resolveTenant(req(), env);
  assert.equal(env.reads, 1, "concurrent requests must not each retry a broken config read");

  // Age the stamp past the TTL, then let the read succeed.
  W.__setTenantTestState({ memo: { at: Date.now() - (W.TENANT_MEMO_TTL_MS + 1), tenantId: null } });
  const healthy = assetsEnv({ tenantId: "zeta" });
  assert.deepEqual(await W.resolveTenant(req(), healthy), { tenantId: "zeta" });
});

test("the resolver is declared once and called once, before the config load", () => {
  // The same checker `check` runs, so a local `npm test` gives the answer CI will.
  const { declared, calls, problems } = checkTenantResolver(readFileSync(WORKER, "utf8"));
  assert.deepEqual(problems, [], problems.map((p) => `${p.kind}: ${p.message}`).join("\n"));
  assert.equal(declared.length, 1);
  assert.equal(calls.length, 1);
});

test("the checker can actually fire — a second call site fails it", () => {
  const source = readFileSync(WORKER, "utf8").replace(
    "    await loadConfig(env);",
    "    await resolveTenant(request, env);\n    await loadConfig(env);",
  );
  const { problems } = checkTenantResolver(source);
  assert.ok(problems.some((p) => p.kind === "call-sites"), "a second call site must be a failure");
});

test("the checker can actually fire — the call site after the config load fails it", () => {
  const src = readFileSync(WORKER, "utf8");
  const call = "    const { tenantId } = await resolveTenant(request, env);";
  assert.ok(src.includes(call), "the call site's text moved — update this test with it");
  const source = src.replace(call, "").replace("    await loadConfig(env);", "    await loadConfig(env);\n" + call);
  const { problems } = checkTenantResolver(source);
  assert.ok(problems.some((p) => p.kind === "placement"), "resolving after the config load must be a failure");
});
