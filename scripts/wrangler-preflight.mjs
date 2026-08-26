#!/usr/bin/env node
/**
 * wrangler-preflight — refuse a worker config that would open the site.
 *
 * WHY THIS IS NOT A STYLE CHECK. Pages and Workers invert request precedence. Pages runs
 * the worker first and lets it decide what is public. Workers serves a matching static
 * asset first and only invokes the worker on a miss, unless `run_worker_first = true`.
 *
 * The asset directory is `dist`, and `dist/__config/instance.json` holds the instance's
 * user roster INCLUDING SEED PASSWORDS — build.js writes `users: IDENTITY` unstripped and
 * says so in its own comment beside the write. `dist/admin/` is the admin page. In assets
 * mode `dist` is every built page.
 *
 * So a config missing one line serves the roster and the admin panel to strangers, while
 * all 815 tests stay green, both existing deploy gates stay green, and the shell's health
 * check still answers "healthy" — because /_build.json is a static file that a bare host
 * serves correctly with no worker running at all. Nothing else in this repo can tell
 * those two deploys apart. That is what this script is for, and it is why it runs in
 * `check`, the workflow that gates the deploy, rather than in `test`, which reports.
 *
 * WHAT IT DOES NOT DO: it does not parse TOML. Node has no TOML parser and this repo
 * carries no dependencies for tooling (scripts/shell-lint.mjs works the same way). It is
 * line-oriented, which means it can be fooled by a config written to fool it — an inline
 * table, a multi-line array, a key inside a string. It is a floor under an honest config,
 * not a proof against a hostile one. `scripts/frontdoor-parity.mjs` is what actually
 * asks a running deployment whether a gated path is gated.
 *
 * Run: node scripts/wrangler-preflight.mjs -c <path/to/wrangler.toml>   (exit 1 on any finding)
 */
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const cfgArg = argv[(argv.indexOf("-c") + 1) || (argv.indexOf("--config") + 1)] || argv[0];
if (!cfgArg) {
  console.error("usage: node scripts/wrangler-preflight.mjs -c <wrangler.toml>");
  process.exit(2);
}
const CFG = path.resolve(cfgArg);
if (!fs.existsSync(CFG)) {
  console.error(`wrangler-preflight: no such config: ${CFG}`);
  process.exit(2);
}
const SHELL = path.dirname(CFG);
const raw = fs.readFileSync(CFG, "utf8");

// Strip whole-line comments only. A `#` inside a quoted value is a legitimate character
// (a password in a var, a fragment in a URL) and treating it as a comment is how a
// 24-character secret became a 6-character one somewhere else in this project.
const lines = raw.split(/\r?\n/).map((l) => (/^\s*#/.test(l) ? "" : l));
const body = lines.join("\n");

/** A bare `key = value` at top level or inside the named table. */
function valueOf(key, table = null) {
  let cur = null;
  for (const line of lines) {
    const t = line.match(/^\s*\[\[?([^\]]+)\]\]?\s*$/);
    if (t) { cur = t[1].trim(); continue; }
    if (cur !== table) continue;
    const m = line.match(new RegExp(String.raw`^\s*${key}\s*=\s*(.+?)\s*$`));
    if (m) return m[1].replace(/^["']|["']$/g, "");
  }
  return null;
}
const bindings = (table) => lines
  .join("\n")
  .split(/^\s*\[\[/m)
  .filter((chunk) => chunk.startsWith(`${table}]]`))
  .map((chunk) => (chunk.match(/^\s*binding\s*=\s*["']([^"']+)["']/m) || [])[1])
  .filter(Boolean);

const findings = [];
const fail = (rule, detail) => findings.push({ rule, detail });

// ── the headline rule ────────────────────────────────────────────────────────
const assetsDir = valueOf("directory", "assets");
const runWorkerFirst = valueOf("run_worker_first", "assets");
if (assetsDir) {
  const abs = path.resolve(SHELL, assetsDir);
  const sensitive = ["__config/instance.json", "__config/routing.json", "admin/index.html"]
    .filter((p) => fs.existsSync(path.join(abs, p)));
  if (runWorkerFirst !== "true") {
    fail("run-worker-first",
      `[assets] run_worker_first is ${runWorkerFirst === null ? "not set" : runWorkerFirst}. Workers serves a matching asset BEFORE the worker runs, so the gate never executes.`
      + (sensitive.length
        ? `\n    The asset directory (${assetsDir}) currently contains: ${sensitive.join(", ")}.`
        + "\n    __config/instance.json carries the user roster WITH SEED PASSWORDS. This config would publish it."
        : `\n    The asset directory (${assetsDir}) is not built yet, so what it will contain could not be read — build first, or fix this anyway.`));
  }
  if (!fs.existsSync(path.join(abs, ".assetsignore")) && fs.existsSync(path.join(abs, "_worker.js"))) {
    fail("assetsignore",
      `${assetsDir}/_worker.js exists with no .assetsignore beside it. wrangler refuses to upload a Pages worker as an asset, and without the ignore file the deploy fails. build.js emits it; a stale dist does not have it.`);
  }
}
if (!assetsDir) fail("assets", "no [assets] directory. The worker reads its own instance config through env.ASSETS and cannot start without it.");

const nfh = valueOf("not_found_handling", "assets");
if (nfh === "single-page-application") {
  fail("not-found-handling",
    'not_found_handling = "single-page-application" answers every unknown path with the index page at status 200. dist/404.html exists precisely so a miss is a miss; this turns every typo and every unpublished URL into a page that looks real.');
}

// ── bindings the worker cannot run without ───────────────────────────────────
const kv = bindings("kv_namespaces");
const r2 = bindings("r2_buckets");
if (valueOf("binding", "assets") !== "ASSETS") fail("binding-assets", "[assets] binding must be \"ASSETS\" — src/_worker.js reads env.ASSETS by that name.");
if (!kv.includes("COMMENTS")) fail("binding-comments", "no COMMENTS KV binding. Sessions, rosters, comments, pins and publish tokens all live there, and effectiveSecret fails CLOSED on a KV error, so nobody can sign in.");
if (!r2.includes("BUNDLES")) fail("binding-bundles", "no BUNDLES R2 binding. Published content is served from the bundle store; without it the site has nothing in it.");

// ── the entry ────────────────────────────────────────────────────────────────
const main = valueOf("main");
if (!main) fail("main", "no `main`. wrangler has no entry to bundle.");
else if (!/src\/entry\.js$/.test(main)) {
  fail("main", `main = "${main}". The deploy entry is src/entry.js — the file scripts/no-tenant-globals.mjs scans and the only one that may export a Durable Object class. Pointing main elsewhere silently un-scans the module graph.`);
} else if (!fs.existsSync(path.resolve(SHELL, main))) {
  fail("main", `main = "${main}" does not resolve from ${SHELL}. It is relative to this config, not to the engine.`);
}

// ── credentials that must never be a plaintext var ───────────────────────────
let table = null;
lines.forEach((line, i) => {
  const t = line.match(/^\s*\[\[?([^\]]+)\]\]?\s*$/);
  if (t) { table = t[1].trim(); return; }
  const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/);
  if (!m) return;
  const key = m[1];
  if (key === "PUBLISH_BOOTSTRAP_TOKEN") {
    fail("bootstrap-token", `line ${i + 1}: PUBLISH_BOOTSTRAP_TOKEN. It is compared as a bare string and answers with star scope — a plaintext credential that can overwrite every space's published content. It has no place on a live instance at all.`);
  }
  if (table === "vars" && /SECRET|TOKEN|PASSWORD|API_KEY/.test(key)) {
    fail("secret-in-vars", `line ${i + 1}: ${key} under [vars]. [vars] is plaintext in a git repo. Use \`wrangler secret put ${key}\`.`);
  }
  if (key === "GV_KV_TOKEN") {
    fail("kv-token", `line ${i + 1}: GV_KV_TOKEN short-circuits the env.COMMENTS binding and talks to the KV REST API with an account credential. It is a local-development escape hatch, not a deploy setting.`);
  }
});

// `remote = true` sends a local dev binding to the PRODUCTION resource.
lines.forEach((line, i) => {
  if (/^\s*remote\s*=\s*true\s*$/.test(line)) {
    fail("remote-binding", `line ${i + 1}: remote = true points this binding at the live resource. A local run then writes production comments, rosters and boards.`);
  }
});

if (!findings.length) {
  console.log(`wrangler-preflight: OK — ${path.basename(CFG)} runs the worker first, binds ASSETS + COMMENTS + BUNDLES, and carries no plaintext credential`);
  process.exit(0);
}
for (const f of findings) {
  console.log(`${path.relative(process.cwd(), CFG)}  [${f.rule}]`);
  console.log(`    ${f.detail}`);
}
console.log(`\n${findings.length} finding(s). This is a floor under an honest config, not a proof: it is line-oriented and does not parse TOML. Ask a RUNNING deployment with scripts/frontdoor-parity.mjs.`);
process.exit(1);
