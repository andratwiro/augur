// publish.mjs — incremental direct publish: build a space, upload only the blobs
// the store doesn't hold, commit its manifest (an atomic pointer flip).
//
//   node scripts/publish.mjs --space <id>     publish one space
//   node scripts/publish.mjs --all            publish every space + engine chrome
//                                             + push the instance config
//   … --dry-run                               diff against the store, ship nothing
//
// Run from a space repo (a cwd with space.json) the --space flag is inferred.
// Contract (agents rely on this): synchronous, zero prompts, exit code = truth,
// "<live url>  v<version>" is the LAST line on stdout; progress goes to stderr.
//
// Auth: AUGUR_TOKEN env (a publish token minted in the Admin panel, or the
// instance's .env.deploy). Target: AUGUR_ORIGIN env, else the instance's
// deploy.config.json siteOrigin. Provenance: the space repo's git sha + a dirty
// flag ride in the manifest (a working-tree publish is visible, never hidden).

import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findShellDir, deployConfig } from "./lib/instance.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const log = (msg) => console.error(`\x1b[32m[publish]\x1b[0m ${msg}`);
const die = (msg) => { log(msg); process.exit(1); };

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const DRY = flag("--dry-run");
const ALL = flag("--all");

function readEnvFile(p) {
  const out = {};
  try {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch (e) {}
  return out;
}
const DEPLOY_ENV = readEnvFile(path.join(ROOT, ".env.deploy"));

const TOKEN = process.env.AUGUR_TOKEN || DEPLOY_ENV.AUGUR_TOKEN || "";
if (!TOKEN) die("no publish token — set AUGUR_TOKEN (mint one in the Admin panel).");
const ORIGIN = (process.env.AUGUR_ORIGIN || DEPLOY_ENV.AUGUR_ORIGIN || deployConfig(ROOT).siteOrigin || "")
  .replace(/\/+$/, "");
if (!ORIGIN) die("no target origin — set AUGUR_ORIGIN or deploy.config.json siteOrigin.");

// Space discovery: sibling clones (the god-mode layout) or ./spaces mounts —
// same filter build.js applies. cwd inference: running inside a space repo
// publishes THAT space.
const PARENT = path.join(ROOT, "..");
let spaceDirs = [];
try {
  spaceDirs = readdirSync(PARENT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".")
      && existsSync(path.join(PARENT, e.name, "space.json")))
    .map((e) => path.join(PARENT, e.name));
} catch (e) {}
const usingSiblings = spaceDirs.length > 0;
const SPACES_ROOT = process.env.GV_SPACES_ROOT || (usingSiblings ? PARENT : path.join(ROOT, "spaces"));
if (!usingSiblings) {
  try {
    spaceDirs = readdirSync(SPACES_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(path.join(SPACES_ROOT, e.name, "space.json")))
      .map((e) => path.join(SPACES_ROOT, e.name));
  } catch (e) {}
}
const idOf = (dir) => {
  try { return JSON.parse(readFileSync(path.join(dir, "space.json"), "utf8")).id || path.basename(dir); }
  catch (e) { return path.basename(dir); }
};
const byId = Object.fromEntries(spaceDirs.map((d) => [idOf(d), d]));

let targetSpace = opt("--space");
if (!targetSpace && !ALL && existsSync(path.join(process.cwd(), "space.json"))) {
  targetSpace = idOf(process.cwd());
}
if (!targetSpace && !ALL) die("name a target: --space <id>, --all, or run from a space repo.");
if (targetSpace && !byId[targetSpace]) die(`unknown space "${targetSpace}" (have: ${Object.keys(byId).join(", ")})`);

// ── build (single space unless --all; engine chrome always emitted) ──────────
const SHELL_DIR = findShellDir(ROOT);
const IDENTITY_PATH = process.env.GV_IDENTITY_PATH
  || (SHELL_DIR && existsSync(path.join(SHELL_DIR, "identity.json")) ? path.join(SHELL_DIR, "identity.json") : null);
const DEPLOY_CONFIG_PATH = process.env.GV_DEPLOY_CONFIG_PATH
  || (SHELL_DIR && existsSync(path.join(SHELL_DIR, "deploy.config.json")) ? path.join(SHELL_DIR, "deploy.config.json") : null);
const BUILD_ENV = {
  ...process.env,
  GV_SPACES_ROOT: SPACES_ROOT,
  ...(IDENTITY_PATH ? { GV_IDENTITY_PATH: IDENTITY_PATH } : {}),
  ...(DEPLOY_CONFIG_PATH ? { GV_DEPLOY_CONFIG_PATH: DEPLOY_CONFIG_PATH } : {}),
  ...(targetSpace ? { GV_ONLY_SPACE: targetSpace } : {}),
};
const started = Date.now();
log(`building ${targetSpace || "all spaces"}…`);
const code = await new Promise((resolve) => {
  spawn("node", ["build.js"], { cwd: ROOT, env: BUILD_ENV, stdio: ["ignore", 2, 2] }).on("close", resolve);
});
if (code !== 0) die(`build failed (exit ${code})`);

function repoState(dir) {
  const out = { sha: null, dirty: false };
  try {
    out.sha = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    out.dirty = execFileSync("git", ["-C", dir, "status", "--porcelain"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().length > 0;
  } catch (e) {}
  return out;
}

// ── the digest protocol, per target ──────────────────────────────────────────
const api = (p) => `${ORIGIN}/__publish/${p}`;
const auth = { Authorization: `Bearer ${TOKEN}` };
async function req(url, init = {}) {
  const r = await fetch(url, { ...init, headers: { ...auth, ...(init.headers || {}) } });
  if (!r.ok && r.status !== 204) {
    const body = await r.text().catch(() => "");
    throw new Error(`${init.method || "GET"} ${url} → ${r.status} ${body.slice(0, 300)}`);
  }
  return r;
}

async function publishOne(id, sourceDir) {
  const manifest = JSON.parse(await readFile(path.join(ROOT, "dist", "__manifests", id + ".json"), "utf8"));
  manifest.source = { ...repoState(sourceDir), actor: process.env.USER || "" };
  const files = manifest.files;
  const total = Object.keys(files).length;

  const check = await (await req(api(`${id}/check`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ files }),
  })).json();
  const missing = new Set(check.missing || []);
  const toUpload = Object.entries(files).filter(([, f]) => missing.has(f.h));
  // Blobs are content-addressed: many paths can share one hash; upload each once.
  const uniq = new Map();
  for (const [p, f] of toUpload) if (!uniq.has(f.h)) uniq.set(f.h, p);
  const bytes = [...uniq.values()].reduce((n, p) => n + files[p].s, 0);
  log(`${id}: ${total} files, ${uniq.size} blobs to upload (${(bytes / 1e6).toFixed(1)} MB), live v${check.liveVersion}${manifest.source.dirty ? " \x1b[33m[dirty]\x1b[0m" : ""}`);
  if (DRY) return null;

  const entries = [...uniq.entries()];
  let done = 0, failed = 0;
  const workers = Array.from({ length: 8 }, async () => {
    while (entries.length) {
      const [h, p] = entries.pop();
      const body = await readFile(path.join(ROOT, "dist", p.slice(1)));
      for (let attempt = 0; ; attempt++) {
        try {
          await req(api(`${id}/blob/${h}`), { method: "PUT", body });
          done++;
          if (done % 200 === 0) log(`${id}: ${done}/${uniq.size} blobs…`);
          break;
        } catch (e) {
          if (attempt >= 2) { failed++; log(`${id}: blob ${h.slice(0, 12)} failed: ${e.message}`); break; }
        }
      }
    }
  });
  await Promise.all(workers);
  if (failed) die(`${id}: ${failed} blob uploads failed — nothing committed, live site untouched.`);

  const res = await (await req(api(`${id}/commit`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(manifest),
  })).json();
  return res.version;
}

const results = [];
if (ALL) {
  // Instance config first (identity/knobs), then engine chrome, then spaces.
  if (!DRY) {
    const inst = await readFile(path.join(ROOT, "dist", "__config", "instance.json"), "utf8");
    await req(api("_instance/config"), { method: "POST", headers: { "content-type": "application/json" }, body: inst });
    log("instance config pushed");
  }
  results.push(["_engine", await publishOne("_engine", ROOT)]);
  for (const id of Object.keys(byId)) results.push([id, await publishOne(id, byId[id])]);
} else {
  results.push([targetSpace, await publishOne(targetSpace, byId[targetSpace])]);
}

log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
if (DRY) { console.log("(dry-run, nothing shipped)"); process.exit(0); }
const spaceMeta = (id) => {
  try { return JSON.parse(readFileSync(path.join(byId[id], "space.json"), "utf8")); } catch (e) { return {}; }
};
const last = results[results.length - 1];
const base = last[0] === "_engine" || (spaceMeta(last[0]) || {}).default ? "" : `/${last[0]}/`;
console.log(`${ORIGIN}${base}  v${last[1]}`);
