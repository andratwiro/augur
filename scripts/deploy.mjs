// deploy.mjs — first-class local deploy: build → direct-upload → URL on stdout.
//
//   npm run deploy              build all spaces and ship them to the instance's
//                               Pages project (direct upload, hash-incremental)
//   npm run deploy -- --check   build only; print what would ship and exit
//
// Contract (agents rely on this): synchronous, zero prompts, exit code = truth,
// the deployment URL is the LAST line on stdout; progress goes to stderr. Auth
// and instance identity come from .env.deploy (see .env.deploy.example) — explicit
// env always wins, then the sibling deploy shell resolved by shape.
//
// Provenance: each repo that contributes to the build (engine + every space) is
// stamped into /_build.json with its sha; a repo with uncommitted changes gains
// `"dirty": true` so a working-tree ship is visible, never hidden (build.js merges
// GV_BUILD_DIRTY_JSON — computed here, since only a local deploy can be dirty).

import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findShellDir } from "./lib/instance.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = process.argv.includes("--check");
const PREVIEW = process.argv.includes("--preview");
const log = (msg) => console.error(`\x1b[36m[deploy]\x1b[0m ${msg}`);

function readEnvFile(p) {
  const out = {};
  try {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch {}
  return out;
}
const DEPLOY_ENV = readEnvFile(path.join(ROOT, ".env.deploy"));
for (const [k, v] of Object.entries(DEPLOY_ENV)) if (!(k in process.env)) process.env[k] = v;

// Same space discovery as offline.mjs: canonical sibling clones (edit-here) win;
// a lone engine clone falls back to the pinned ./spaces mounts.
const PARENT = path.join(ROOT, "..");
let siblingSpaces = [];
try {
  siblingSpaces = readdirSync(PARENT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".")
      && existsSync(path.join(PARENT, e.name, "space.json")))
    .map((e) => path.join(PARENT, e.name));
} catch {}
const usingSiblings = siblingSpaces.length > 0;
const SPACES_ROOT = process.env.GV_SPACES_ROOT || (usingSiblings ? PARENT : path.join(ROOT, "spaces"));

const SHELL_DIR = findShellDir(ROOT);
const IDENTITY_PATH = process.env.GV_IDENTITY_PATH
  || [SHELL_DIR && path.join(SHELL_DIR, "identity.json")].filter(Boolean).find((p) => existsSync(p));
const DEPLOY_CONFIG_PATH = process.env.GV_DEPLOY_CONFIG_PATH
  || (SHELL_DIR && existsSync(path.join(SHELL_DIR, "deploy.config.json"))
      ? path.join(SHELL_DIR, "deploy.config.json") : null);
if (!IDENTITY_PATH) {
  log("no identity.json found (GV_IDENTITY_PATH unset, no sibling deploy shell) — refusing to ship an open-gated site.");
  process.exit(1);
}
if (!CHECK && !process.env.PAGES_PROJECT) {
  log("PAGES_PROJECT unset — set it in .env.deploy (the instance's Pages project name).");
  process.exit(1);
}

// Dirty provenance: engine + each space root; `git status --porcelain` non-empty → dirty.
function repoState(dir) {
  const out = { sha: null, dirty: false };
  try {
    out.sha = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    out.dirty = execFileSync("git", ["-C", dir, "status", "--porcelain"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().length > 0;
  } catch {}
  return out;
}
const spaceDirs = usingSiblings ? siblingSpaces : (() => {
  try {
    return readdirSync(SPACES_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(path.join(SPACES_ROOT, e.name, "space.json")))
      .map((e) => path.join(SPACES_ROOT, e.name));
  } catch { return []; }
})();
const dirty = { engine: repoState(ROOT).dirty };
const states = { engine: repoState(ROOT) };
for (const dir of spaceDirs) {
  let id = path.basename(dir);
  try { id = JSON.parse(readFileSync(path.join(dir, "space.json"), "utf8")).id || id; } catch {}
  states[id] = repoState(dir);
  dirty[id] = states[id].dirty;
}

// ── build ────────────────────────────────────────────────────────────────────
const BUILD_ENV = {
  ...process.env,
  GV_SPACES_ROOT: SPACES_ROOT,
  GV_IDENTITY_PATH: IDENTITY_PATH,
  ...(DEPLOY_CONFIG_PATH ? { GV_DEPLOY_CONFIG_PATH: DEPLOY_CONFIG_PATH } : {}),
  GV_BUILD_DIRTY_JSON: JSON.stringify(dirty),
};
log(`building from ${usingSiblings ? "sibling space clones" : SPACES_ROOT}`);
const started = Date.now();
const buildCode = await new Promise((resolve) => {
  const proc = spawn("node", ["build.js"], { cwd: ROOT, env: BUILD_ENV, stdio: ["ignore", 2, 2] });
  proc.on("close", resolve);
});
if (buildCode !== 0) { log(`build failed (exit ${buildCode})`); process.exit(buildCode || 1); }
log(`built in ${((Date.now() - started) / 1000).toFixed(1)}s`);

for (const [id, s] of Object.entries(states))
  log(`  ${id}: ${s.sha ? s.sha.slice(0, 9) : "no-git"}${s.dirty ? " \x1b[33m(dirty — working tree ships)\x1b[0m" : ""}`);

if (CHECK) {
  // Summary only: per-space file counts from dist, then stop before any upload.
  const dist = path.join(ROOT, "dist");
  const count = (dir) => {
    let n = 0;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) n += count(path.join(dir, e.name));
      else n += 1;
    }
    return n;
  };
  log(`--check: dist holds ${count(dist)} files; nothing shipped.`);
  console.log("(check-only, no deployment)");
  process.exit(0);
}

// ── direct upload (hash-incremental; wrangler prompts suppressed) ────────────
// --preview ships to a non-production branch: full end-to-end upload, own URL,
// production untouched — the safe default for verification runs.
const args = ["--yes", "wrangler", "pages", "deploy", "dist",
  "--project-name", process.env.PAGES_PROJECT,
  "--branch", PREVIEW ? "preview" : "main", "--commit-dirty=true"];
const chunks = [];
const wranglerCode = await new Promise((resolve) => {
  const proc = spawn("npx", args, { cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", 2] });
  proc.stdout.on("data", (d) => { chunks.push(d); process.stderr.write(d); });
  proc.on("close", resolve);
});
if (wranglerCode !== 0) { log(`upload failed (exit ${wranglerCode})`); process.exit(wranglerCode || 1); }

// The deployment URL is the contract: last line on stdout. Prefer the instance's
// canonical origin (deploy.config.json siteOrigin) — that's where people look —
// falling back to the per-deploy URL wrangler prints.
let deployUrl = null;
const m = Buffer.concat(chunks).toString("utf8").match(/https:\/\/[^\s]+\.pages\.dev[^\s]*/g);
if (m) deployUrl = m[m.length - 1];
let siteOrigin = null;
try { siteOrigin = JSON.parse(readFileSync(DEPLOY_CONFIG_PATH, "utf8")).siteOrigin || null; } catch {}
log(`deployed in ${((Date.now() - started) / 1000).toFixed(1)}s total`);
// Preview deploys report their own URL; production reports the canonical origin.
console.log((PREVIEW ? deployUrl : siteOrigin || deployUrl) || "(deployed — no URL reported by wrangler)");
