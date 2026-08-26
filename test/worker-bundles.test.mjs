// The deploy entry actually bundles, and a Durable Object binding cannot land half-done.
//
// Everything else about the plain-Worker migration is checked by reading files. This is
// the one test that asks WRANGLER, because the question — does esbuild resolve the whole
// import graph from src/entry.js into a single script — has no answer that can be read
// off the source.
//
// It runs `deploy --dry-run`, which resolves bindings and writes a bundle to disk and
// contacts no account. The scratch config is written to os.tmpdir(), never into the repo:
// a `wrangler.toml` sitting in an engine clone is a config a stray `npx wrangler` would
// pick up, and this is a public repo.
//
// SKIPS rather than fails when wrangler cannot be run — `npm test` is a zero-network
// contract everywhere else in this suite, and a machine with no npx cache would otherwise
// turn an offline afternoon into a red suite.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ENGINE = fileURLToPath(new URL("..", import.meta.url));

function wrangler(args, cwd) {
  return execFileSync("npx", ["--yes", "wrangler", ...args], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000,
    env: { ...process.env, CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "", WRANGLER_SEND_METRICS: "false" },
  });
}

/** A scratch shell: an empty asset dir plus a config whose `main` climbs to the engine. */
function scratch(extra = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-bundles-"));
  fs.mkdirSync(path.join(dir, "assets"));
  fs.writeFileSync(path.join(dir, "assets", ".assetsignore"), "_worker.js\n");
  fs.writeFileSync(path.join(dir, "wrangler.toml"), `
name = "augur-bundle-probe"
main = ${JSON.stringify(path.join(ENGINE, "src", "entry.js"))}
compatibility_date = "2026-07-01"

[assets]
directory = "assets"
binding = "ASSETS"
run_worker_first = true
not_found_handling = "none"

[[kv_namespaces]]
binding = "COMMENTS"
id = "0000000000000000000000000000beef"

[[r2_buckets]]
binding = "BUNDLES"
bucket_name = "augur-bundle-probe"
${extra}`);
  return dir;
}

let available = true;
try { wrangler(["--version"], ENGINE); } catch { available = false; }

test("the deploy entry bundles into one script with every binding resolved", { skip: available ? false : "wrangler unavailable (offline?)" }, () => {
  const dir = scratch();
  try {
    const out = wrangler(["deploy", "--dry-run", "--outdir", path.join(dir, "out")], dir);
    // The bindings the worker cannot start without. If wrangler stops printing these, the
    // assertion is what tells us, rather than a deploy that resolves nothing.
    for (const b of ["ASSETS", "COMMENTS", "BUNDLES"]) {
      assert.match(out, new RegExp(`env\\.${b}`), `wrangler did not report the ${b} binding:\n${out}`);
    }
    // The whole point of the entry: esbuild inlines the five modules src/_worker.js
    // imports. A surviving relative import would mean the bundle expects files next to it
    // at the edge, which is the Pages model, not this one.
    const bundle = fs.readFileSync(path.join(dir, "out", "entry.js"), "utf8");
    assert.ok(!/\bfrom\s*["']\.[./]/.test(bundle), "the emitted bundle still carries a relative import");
    assert.ok(bundle.includes("loadTenantContext") || bundle.includes("resolveTenant"),
      "the emitted bundle does not contain the worker's own symbols — did it bundle the right entry?");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a Durable Object binding with no matching export in the entry HARD-FAILS", () => {
  // The negative ratchet, and the reason it is worth a test: A-boardroom-port moves the
  // canvas room class into this worker, and the half-landed version of that change is a
  // wrangler.toml naming a class the entry does not export. This asserts wrangler refuses
  // it and names the file, so the failure is loud rather than a runtime 1101 in
  // production. When entry.js really does export the class, this test flips to asserting
  // success — and its presence is what makes anyone notice that it should.
  if (!available) return;
  const dir = scratch(`
[[durable_objects.bindings]]
name = "ROOMS"
class_name = "BoardRoom"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["BoardRoom"]
`);
  try {
    let failed = false, out = "";
    try { out = wrangler(["deploy", "--dry-run"], dir); }
    catch (e) { failed = true; out = (e.stdout || "") + (e.stderr || ""); }
    assert.equal(failed, true, `wrangler accepted a DO binding with no export:\n${out}`);
    assert.match(out, /BoardRoom/, `the error does not name the missing class:\n${out}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
