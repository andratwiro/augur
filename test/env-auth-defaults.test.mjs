// ACCOUNT_ORIGIN and SESSION_KEYS are PLATFORM settings on a shared hosted worker, not
// per-workspace preferences. `withEnvAuthDefaults` lets a single Worker env value turn
// passwordless sign-in on for every workspace at once — including ones with no config
// document of their own — so a platform never flips an auth flag one tenant at a time.
//
// The two properties this pins:
//   · a workspace whose config does NOT set the field takes the Worker env value, so a
//     config-less (or freshly-provisioned) workspace is passwordless from one place; and
//   · a workspace whose OWN config sets the field still WINS, so a self-hosted single
//     instance that carries these in instance.json and sets no env var is unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

const T = W.DEFAULT_TENANT_ID;
const cold = () => W.__setConfigTestState({ cfgAt: 0, cfgGoodAt: 0, roster: null, manifests: false, storage: false });

// An ASSETS-mode config source that serves whatever instance doc the test hands it. Assets
// mode and bundle mode run the SAME withEnvAuthDefaults call, one after instanceFields in
// each branch, so pinning it here pins both.
function assetsWith(instanceDoc) {
  return {
    async fetch(u) {
      const p = new URL(typeof u === "string" ? u : u.url).pathname;
      if (p === "/__config/instance.json") return new Response(JSON.stringify(instanceDoc), { status: 200 });
      if (p === "/__config/routing.json") {
        return new Response(JSON.stringify({ buildId: "b", publicPrefixes: [], versionMap: {}, spaces: [] }), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    },
  };
}

const BARE = { users: [{ email: "a@x.test", name: "A", role: "admin", passHash: "seed" }] };

test("env turns passwordless on for a workspace whose config does not set the flags", async () => {
  cold();
  const env = { ASSETS: assetsWith(BARE), ACCOUNT_ORIGIN: "https://augur.works", SESSION_KEYS: "true" };
  const ctx = await W.loadConfig(T, env);
  assert.equal(ctx.ACCOUNT_ORIGIN, "https://augur.works", "the Worker env provides the control-plane origin");
  assert.equal(ctx.SESSION_KEYS, true, "the Worker env turns session keys on");
});

test("a workspace's own config still WINS over the env default", async () => {
  cold();
  const env = {
    ASSETS: assetsWith({ ...BARE, accountOrigin: "https://tenant.example", sessionKeys: false }),
    ACCOUNT_ORIGIN: "https://augur.works", SESSION_KEYS: "true",
  };
  const ctx = await W.loadConfig(T, env);
  assert.equal(ctx.ACCOUNT_ORIGIN, "https://tenant.example", "config accountOrigin overrides the env default");
  // sessionKeys:false in config is not a truthy override, so the env default still applies —
  // the field is a one-way ON, exactly as a platform enabling it for everyone intends.
  assert.equal(ctx.SESSION_KEYS, true, "env still enables session keys the config left off");
});

test("no env vars: byte-for-byte the prior behaviour (a self-hosted instance is untouched)", async () => {
  cold();
  const ctx = await W.loadConfig(T, { ASSETS: assetsWith(BARE) });
  assert.equal(ctx.ACCOUNT_ORIGIN, "", "no env, no config field: empty as before");
  assert.equal(ctx.SESSION_KEYS, false, "no env, no config field: off as before");
});
