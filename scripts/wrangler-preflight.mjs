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
 * every test in this repo stays green, both existing deploy gates stay green, and the
 * shell's health check still answers "healthy" — because /_build.json is a static file
 * that a bare host serves correctly with no worker running at all. Nothing else in this
 * repo can tell those two deploys apart. That is what this script is for.
 *
 * ⚠️ WHERE IT ACTUALLY RUNS, because this header used to claim otherwise: NOT in `check`.
 * The config it judges lives in a SHELL repo, and this repo has none, so there is nothing
 * here for a repo-wide gate to read. It runs at `templates/shell/deploy.yml`, gating each
 * shell's plain-Worker deploy with the wrangler.toml that shell actually holds, and in
 * `test/wrangler-preflight.test.mjs` against fixtures. The consequence worth knowing: a
 * green `check` in the engine says nothing about whether any instance's config is honest.
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

/**
 * A value, with a TRAILING comment removed and a quoted `#` left alone.
 *
 * Both halves are load-bearing and they pull in opposite directions. The shipped
 * template annotates almost every line (`binding = "ASSETS"   # the worker reads its own
 * config through this`), so a reader that keeps the comment sees the binding as
 * `"ASSETS" # the worker…` and refuses a correct config — and a guard that fires on the
 * template it tells you to copy is a guard somebody deletes. But a `#` INSIDE a quoted
 * value is a legitimate character, and treating it as a comment is how a 24-character
 * secret became a 6-character one somewhere else in this project.
 *
 * So: a quoted value ends at its closing quote and whatever follows is a comment; an
 * unquoted one ends at the first `#`.
 */
function stripTrailingComment(v) {
  const q = /^\s*(["'])((?:\\.|(?!\1).)*)\1/.exec(v);
  if (q) return q[2];
  const hash = v.indexOf("#");
  return (hash === -1 ? v : v.slice(0, hash)).trim();
}

/** A bare `key = value` at top level or inside the named table. */
function valueOf(key, table = null) {
  let cur = null;
  for (const line of lines) {
    const t = line.match(/^\s*\[\[?([^\]]+)\]\]?\s*$/);
    if (t) { cur = t[1].trim(); continue; }
    if (cur !== table) continue;
    const m = line.match(new RegExp(String.raw`^\s*${key}\s*=\s*(.+?)\s*$`));
    if (m) return stripTrailingComment(m[1]);
  }
  return null;
}
// `key` because the tables do not agree: KV, R2 and queues name theirs `binding`, and
// Durable Objects name theirs `name`.
const bindings = (table, key = "binding") => lines
  .join("\n")
  .split(/^\s*\[\[/m)
  .filter((chunk) => chunk.startsWith(`${table}]]`))
  .map((chunk) => (chunk.match(new RegExp(String.raw`^\s*${key}\s*=\s*["']([^"']+)["']`, "m")) || [])[1])
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

// ── one workspace or many, and the pieces that have to agree ─────────────────
// TENANT_HOST_SUFFIX is the switch: unset, the deployment serves the one workspace its
// build named; set, the workspace comes from the Host header. The two halves are declared
// in different tables, so it is easy to add one and not the other — and each half alone
// fails in a way nobody would connect to this file.
const suffix = valueOf("TENANT_HOST_SUFFIX", "vars");
const dos = bindings("durable_objects.bindings", "name");
if (suffix !== null && suffix.trim() !== "" && !dos.includes("TENANTS")) {
  fail("tenants-binding",
    `TENANT_HOST_SUFFIX = "${suffix}" makes the workspace come from the Host header, but there is no TENANTS Durable Object binding for those workspaces to live in. Every hostname would resolve to a workspace with nowhere to keep anything.`);
}
if (suffix !== null && suffix.trim() === "") {
  fail("tenants-suffix-empty",
    'TENANT_HOST_SUFFIX is set to an empty string. That reads as "multi-workspace" to a person and as "single workspace" to the resolver. Delete the line, or give it the real suffix.');
}

// ── the jurisdiction a workspace object is addressed in ──────────────────────
// A Durable Object's jurisdiction is chosen when the object is ADDRESSED, not when the
// namespace is declared, so there is nothing in this file for the platform to check and
// nothing in the platform for this file to read: `ns.idFromName(x)` and
// `ns.jurisdiction("eu").idFromName(x)` are two different objects and a deployment picks
// which by setting this variable or not. Storage belongs to an id, so the wrong choice is
// not a bug that gets fixed later — it is a migration, and one nobody can do for a
// workspace they cannot find.
//
// THIS LIST IS THE ENGINE'S COPY OF SOMEBODY ELSE'S, and it exists HERE and not in the
// request path on purpose. In the worker the value is handed straight to the platform,
// which is the only authority on what it accepts — a copy running on every request would
// eventually refuse a jurisdiction that was added after it was written. A copy in a deploy
// gate has the opposite failure: whoever hits a stale entry is a person, holding the repo,
// one line from adding it, and in exchange a typo is caught before a single request rather
// than by an outage. Measured against the platform: it accepts these four and refuses
// everything else, case-sensitively, including the empty string.
const JURISDICTIONS = ["eu", "fedramp", "fedramp-high", "us"];
const jurisdiction = valueOf("TENANT_JURISDICTION", "vars");
if (jurisdiction !== null && jurisdiction.trim() === "") {
  fail("tenants-jurisdiction-empty",
    'TENANT_JURISDICTION is set to an empty string, which the engine reads as "no jurisdiction" and a person reads as "restricted". Delete the line if this deployment places no restriction, or name the jurisdiction.');
}
if (jurisdiction !== null && jurisdiction.trim() !== "") {
  const j = jurisdiction.trim();
  if (!JURISDICTIONS.includes(j)) {
    fail("tenants-jurisdiction-unknown",
      `TENANT_JURISDICTION = "${j}" is not a jurisdiction the platform accepts (${JURISDICTIONS.join(", ")}) — and it is case-sensitive, so "EU" is not "eu". A value it refuses fails every request; a value it accepts but nothing else uses creates every workspace where nothing else is looking. If the platform has added one since this list was written, add it here.`);
  }
  if (!dos.includes("TENANTS")) {
    fail("tenants-jurisdiction-binding",
      `TENANT_JURISDICTION = "${j}" says where this deployment's workspace objects live, but there is no TENANTS Durable Object binding for them to live in. The variable does nothing here, which is the dangerous kind of nothing: adding the binding later would look like the jurisdiction had been in force all along.`);
  }
}

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
