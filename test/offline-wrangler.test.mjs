// The config `npm run offline` writes for itself, and the one line in it that is the gate.
//
// `A-offline-worker`. Local development moved from `wrangler pages dev dist` to
// `wrangler dev`, which is the front door a deployed instance uses — and the two invert
// request precedence. Pages runs the worker first; a Worker serves a matching static asset
// first unless `run_worker_first = true`. The asset directory is `dist`, which holds
// `__config/instance.json` and its seed passwords.
//
// So a regression here does not look like a broken local server. It looks like a working
// one that also serves the roster, and the only thing standing between those two is a line
// in a generated file nobody reads. Hence a test on the generator rather than on the file.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { offlineWranglerConfig, RUN_WORKER_FIRST } from "../scripts/lib/offline-wrangler.mjs";

const ROOT = "/tmp/engine";
const cfg = offlineWranglerConfig({ root: ROOT });

test("THE GATE LINE IS IN IT", () => {
  assert.match(cfg, /^run_worker_first = true$/m);
  assert.equal(RUN_WORKER_FIRST, "run_worker_first = true");
  // Under `[assets]` and nowhere else — a key in the wrong table is silently ignored.
  const assets = cfg.slice(cfg.indexOf("[assets]"));
  assert.ok(assets.includes(RUN_WORKER_FIRST), "run_worker_first is not inside [assets]");
  assert.ok(cfg.indexOf("[assets]") < cfg.indexOf(RUN_WORKER_FIRST));
});

test("it points at the deploy entry, not at the copy in dist", () => {
  // Two reasons. The deployed module graph is what a local run should exercise, and
  // src/entry.js is the file scripts/no-tenant-globals.mjs scans — running something else
  // locally would mean the scanned graph and the run graph are different graphs.
  assert.match(cfg, /^main = "\/tmp\/engine\/src\/entry\.js"$/m);
});

test("the paths are absolute, because wrangler resolves them against the CONFIG", () => {
  // The config lives in .wrangler/, not beside the things it names. A relative path here
  // resolves one directory down and fails in a way that reads as a missing build.
  for (const m of cfg.matchAll(/^(main|directory) = "([^"]+)"$/gm)) {
    assert.ok(m[2].startsWith("/"), `${m[1]} is relative: ${m[2]}`);
  }
});

test("a miss is a miss, and folder URLs still resolve", () => {
  // not_found_handling = "single-page-application" would answer every unknown path with
  // the index page at status 200, which is what dist/404.html exists to prevent.
  assert.match(cfg, /^not_found_handling = "none"$/m);
  assert.match(cfg, /^html_handling = "auto-trailing-slash"$/m);
});

test("it binds ASSETS and COMMENTS by the names the worker reads", () => {
  assert.match(cfg, /^binding = "ASSETS"$/m);
  assert.match(cfg, /^binding = "COMMENTS"$/m);
});

test("NO CREDENTIAL IS IN IT, at any posture", () => {
  // The posture secrets are a live Cloudflare API token and the shared realtime secret.
  // They ride on argv (postureVars) precisely so this file is never a second copy of one.
  for (const forbidden of ["GV_KV_TOKEN", "GV_KV_ACCOUNT", "RT_SHARED_SECRET", "SESSION_SECRET", "[vars]"]) {
    assert.ok(!cfg.includes(forbidden), `the generated config carries ${forbidden}`);
  }
});

test("it is not mistakable for a deploy config", () => {
  // No account, no route, no real namespace id. A generated file that looked deployable is
  // a file somebody eventually deploys.
  assert.ok(!cfg.includes("account_id"));
  assert.ok(!cfg.includes("[[routes]]"));
  assert.match(cfg, /^# GENERATED/m);
});

test("it refuses to be built without a root rather than emitting a broken one", () => {
  assert.throws(() => offlineWranglerConfig({}), /root/);
});

test("offline.mjs actually spawns `wrangler dev` against this config", () => {
  // The generator being right is worth nothing if the spawn still says `pages dev`. Read
  // out of the source, because there is no way to assert it from a running process without
  // starting one.
  const src = fs.readFileSync(fileURLToPath(new URL("../scripts/offline.mjs", import.meta.url)), "utf8");
  const code = src.replace(/^\s*\/\/.*$/gm, "");
  assert.ok(code.includes('"wrangler", "dev"'), "offline.mjs does not spawn `wrangler dev`");
  assert.ok(!code.includes('"pages", "dev"'), "offline.mjs still spawns `wrangler pages dev`");
  assert.ok(code.includes("offlineWranglerConfig"), "offline.mjs does not generate the config");
  assert.ok(code.includes('"--local"'), "offline.mjs does not pin the run to local resources");
});
