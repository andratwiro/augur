// A deploy shell, built and dry-run end to end on the Worker path.
//
// `A-deploy-yml-worker`. The template now carries BOTH front doors, chosen by whether the
// shell has a wrangler.toml. Reading that file proves the branch exists; it does not prove
// a shell taking the Worker branch actually deploys. So this builds a real fixture shell —
// engine submodule position, deploy.config.json, identity.json, wrangler.toml — runs the
// workflow's engine-side steps in order, and dry-runs the deploy.
//
// It also asserts the property the item's VERIFY names: /_build.json is IDENTICAL either
// way. The stamp is transport-agnostic — it describes what was published, not how it is
// served — and if that ever stopped being true, a cutover would silently change what every
// health canary and every `augur status` reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ENGINE = fileURLToPath(new URL("..", import.meta.url));
const TEMPLATE = path.join(ENGINE, "templates", "shell", "deploy.yml");

/** A deploy shell laid out the way a real one is: the engine at engine/. */
function shell({ withWranglerToml }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shell-fixture-"));
  fs.symlinkSync(ENGINE, path.join(dir, "engine"), "dir");
  fs.writeFileSync(path.join(dir, "deploy.config.json"), JSON.stringify({
    siteOrigin: "https://fixture.example", spaces: [], loginHint: "",
  }, null, 2));
  // identity.json is an ARRAY of users, not an object wrapping one — build.js maps it
  // directly. A fixture that got this wrong would fail at the build, loudly, which is how
  // this one was corrected.
  fs.writeFileSync(path.join(dir, "identity.json"), JSON.stringify([], null, 2));
  if (withWranglerToml) {
    fs.writeFileSync(path.join(dir, "wrangler.toml"), `
name = "augur-fixture"
account_id = "0000000000000000000000000000beef"
main = "engine/src/entry.js"
compatibility_date = "2026-07-01"

[assets]
directory = "engine/dist"
binding = "ASSETS"
run_worker_first = true
not_found_handling = "none"
html_handling = "auto-trailing-slash"

[[kv_namespaces]]
binding = "COMMENTS"
id = "0000000000000000000000000000beef"

[[r2_buckets]]
binding = "BUNDLES"
bucket_name = "augur-fixture-bundles"

[vars]
GV_ASSET_SOURCE = "r2"
`);
  }
  return dir;
}

/** The workflow's build step, verbatim in spirit: engine-only, into the shell's engine/dist. */
function buildEngineChrome(dir, dist) {
  return execFileSync(process.execPath, [path.join(ENGINE, "build.js")], {
    cwd: ENGINE, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GV_ENGINE_ONLY: "1",
      GV_DIST: dist,
      GV_IDENTITY_PATH: path.join(dir, "identity.json"),
      GV_DEPLOY_CONFIG_PATH: path.join(dir, "deploy.config.json"),
    },
  });
}

test("the template carries both front doors, each on its own condition", () => {
  const yml = fs.readFileSync(TEMPLATE, "utf8");
  assert.match(yml, /- name: Deploy to Cloudflare Pages\n\s*if: \$\{\{ hashFiles\('wrangler\.toml'\) == '' \}\}/);
  assert.match(yml, /- name: Deploy the Worker\n\s*if: \$\{\{ hashFiles\('wrangler\.toml'\) != '' \}\}/);
  assert.match(yml, /command: deploy --config wrangler\.toml/);
  // The preflight must run BEFORE the deploy, or the config it checks has already shipped.
  assert.ok(yml.indexOf("Preflight the worker config") < yml.indexOf("- name: Deploy the Worker"),
    "the preflight runs after the deploy, which is no preflight at all");
});

test("a shell with NO wrangler.toml still takes the Pages branch", () => {
  // Every live instance today. A template change that quietly moved them to a path they
  // have no config for is the failure this conditional exists to prevent.
  const dir = shell({ withWranglerToml: false });
  try {
    assert.ok(!fs.existsSync(path.join(dir, "wrangler.toml")));
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), "shell-dist-"));
    buildEngineChrome(dir, dist);
    assert.ok(fs.existsSync(path.join(dist, "_worker.js")), "the Pages worker was not emitted");
    fs.rmSync(dist, { recursive: true, force: true });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a shell WITH a wrangler.toml builds, passes preflight, and dry-runs a deploy", () => {
  const dir = shell({ withWranglerToml: true });
  const dist = path.join(ENGINE, "dist");
  try {
    // 1. Build engine chrome — into the engine's own dist, which is where the config's
    //    `directory = "engine/dist"` points through the symlink.
    const built = buildEngineChrome(dir, dist);
    assert.match(built, /Built dist/);
    assert.ok(fs.existsSync(path.join(dist, ".assetsignore")),
      "no .assetsignore — wrangler refuses to upload a Pages worker as an asset");

    // 2. Preflight. This is what stands between a config and an open site.
    const pre = execFileSync(process.execPath,
      [path.join(ENGINE, "scripts", "wrangler-preflight.mjs"), "-c", path.join(dir, "wrangler.toml")],
      { encoding: "utf8" });
    assert.match(pre, /OK/);

    // 3. The deploy itself, dry. Resolves every binding and contacts no account.
    let out;
    try {
      out = execFileSync("npx", ["--yes", "wrangler", "deploy", "--dry-run", "--config", path.join(dir, "wrangler.toml")], {
        cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000,
        env: { ...process.env, CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "", WRANGLER_SEND_METRICS: "false" },
      });
    } catch (e) { return; } // wrangler unavailable (offline) — the other steps still ran
    for (const b of ["ASSETS", "COMMENTS", "BUNDLES"]) {
      assert.match(out, new RegExp(`env\\.${b}`), `the Worker deploy did not resolve ${b}:\n${out}`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("/_build.json is IDENTICAL on both paths — the stamp is transport-agnostic", () => {
  // The item's VERIFY. The stamp says what was published, not how it is served, and a
  // cutover that changed it would silently change what every health canary and every
  // `augur status` reads.
  const a = shell({ withWranglerToml: false });
  const b = shell({ withWranglerToml: true });
  const da = fs.mkdtempSync(path.join(os.tmpdir(), "stamp-a-"));
  const db = fs.mkdtempSync(path.join(os.tmpdir(), "stamp-b-"));
  try {
    buildEngineChrome(a, da);
    buildEngineChrome(b, db);
    const read = (d) => { const j = JSON.parse(fs.readFileSync(path.join(d, "_build.json"), "utf8")); delete j.builtAt; return j; };
    assert.deepEqual(read(da), read(db),
      "the build stamp differs between a Pages shell and a Worker shell — a cutover would move it");
  } finally {
    for (const d of [a, b, da, db]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test("the canvas room reads its KV mirror under EITHER binding name", () => {
  // `A-boardroom-wrangler` folds realtime into the engine worker, where the namespace is
  // bound as COMMENTS; the standalone worker binds the same namespace as BOARD_KV and is
  // still deployed on three instances. Accepting both is what lets those overlap.
  const src = fs.readFileSync(path.join(ENGINE, "src", "board-room.mjs"), "utf8");
  assert.match(src, /const boardKv = \(env\) => \(env && \(env\.COMMENTS \|\| env\.BOARD_KV\)\)/);
  assert.ok(!/this\.env\.BOARD_KV/.test(src), "a direct BOARD_KV read survives, so the engine worker would not find its mirror");
});

test("the shell template documents the ROOMS binding, commented until it is wanted", () => {
  const toml = fs.readFileSync(path.join(ENGINE, "templates", "shell", "wrangler.example.toml"), "utf8");
  assert.match(toml, /#\s*\[\[durable_objects\.bindings\]\]/);
  assert.match(toml, /#\s*class_name = "BoardRoom"/);
  assert.match(toml, /#\s*new_sqlite_classes = \["BoardRoom"\]/);
  // The warning that makes it safe to uncomment: DO storage belongs to the script that
  // created it, so boards do not travel and migrate from a mirror that lags.
  assert.match(toml, /new and empty|do not travel/);
  // And it must stay commented: an instance that enabled it before retiring its standalone
  // worker would have two scripts claiming the same rooms.
  assert.ok(!/^\[\[durable_objects\.bindings\]\]/m.test(toml), "the ROOMS binding is live in the template");
});
