// The engine's own manifest rides in the asset upload, and nobody outside can fetch it.
//
// `D-chrome-auto-on-deploy` serves chrome from the worker's own assets when they are newer
// than the store's — decided by reading `__manifests/_engine.json` through the ASSETS
// binding. The build's `.assetsignore` kept the whole `__manifests/` directory out of the
// upload, so that read answered 404 on every live deployment and chrome stayed pinned to
// the last store publish, silently, through every worker deploy. Two halves, both pinned:
// the file is uploaded, and the worker refuses it to strangers like it refuses /__config.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const BUILD = fs.readFileSync(fileURLToPath(new URL("../build.js", import.meta.url)), "utf8");
const WORKER = fs.readFileSync(fileURLToPath(new URL("../src/_worker.js", import.meta.url)), "utf8");

test("the build un-ignores exactly the engine manifest", () => {
  const i = BUILD.indexOf('".assetsignore"');
  const block = BUILD.slice(i, i + 1200);
  assert.match(block, /"__manifests\/\*"/, "other manifests must stay out of the upload");
  assert.match(block, /"!__manifests\/_engine\.json"/, "the engine manifest must ride in the upload");
  assert.ok(!/"__manifests\/"[,\s]/.test(block), "the old blanket ignore is still there and would win");
});

test("the worker refuses external /__manifests/ requests in the same breath as /__config/", () => {
  const guard = /url\.pathname === "\/__config" \|\| url\.pathname\.startsWith\("\/__config\/"\)[\s\S]{0,200}startsWith\("\/__manifests\/"\)/;
  assert.match(WORKER, guard, "the __manifests path is not sealed beside __config");
});

test("the worker's own read of the manifest goes through ASSETS, never the network", () => {
  assert.match(WORKER, /env\.ASSETS\.fetch\("https:\/\/config\/__manifests\/_engine\.json"\)/);
});
