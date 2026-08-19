// offline.mjs — local "offline mode" for Augur.
//
//   npm run offline   →  start   ·   Ctrl-C  →  stop
//
// What it does:
//   1. Builds dist once (node build.js).
//   2. Starts `wrangler pages dev dist` — the REAL src/_worker.js runs locally, so the
//      per-user login gate is ON (same as live; sign in with an admin account — seed creds
//      in src/identity.json), and every overlay API (comments / pins / status / names /
//      piti) works. No deploy — a faithful local mirror of the live site.
//      ⚠️ KV is LIVE/prod when .env.deploy holds Cloudflare creds: the worker reads/writes
//      the REAL production KV via a REST shim (LIVE_KV below), so overlay edits made offline
//      are live for everyone — intentional (offline editing, shared live overlay). Rename
//      .env.deploy for a safe local-only KV sandbox (it then logs `KV: local`).
//      Canvas realtime follows the same split: live KV + RT_SHARED_SECRET in .env.deploy
//      → boards join the instance's real rooms; sandbox → realtime disabled outright
//      (GV_RT_DISABLE), so a sandbox board can't broadcast into shared prod rooms.
//      wrangler is supervised: a workerd crash respawns it (crash-loop cutoff in
//      lib/offline-respawn.mjs) instead of killing the whole offline server.
//   3. Watches the build inputs (the design system, the workspace, build.js, the
//      worker) and rebuilds on any change. Each build stamps a fresh BUILD_ID into
//      dist/_worker.js; wrangler reloads the worker, and the page's live-reload poller
//      (which polls /__version every ~1s on localhost) refreshes open tabs in ~1s.
//
// Zero new dependencies: Node's recursive fs.watch + npx wrangler (same as deploy).

import { spawn } from "node:child_process";
import { watch, existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findShellDir } from "./lib/instance.mjs";
import { respawnDelay } from "./lib/offline-respawn.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.OFFLINE_PORT || "8788";

const log = (msg) => console.log(`\x1b[35m[offline]\x1b[0m ${msg}`);

// Optional "offline-live" mode: if augur/.env.deploy holds Cloudflare creds, the local
// worker talks to the REAL prod KV via the REST shim in _worker.js (kvFor) — so
// comments/pins/status/renames are the shared live layer while prototypes stay local.
// No creds → today's local KV, unchanged. Passed to the worker as
// --binding GV_KV_* (read by kvFor). Prototypes/assets are always local regardless.
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
const LIVE_KV = !!(DEPLOY_ENV.CLOUDFLARE_API_TOKEN && DEPLOY_ENV.CLOUDFLARE_ACCOUNT_ID && DEPLOY_ENV.GV_KV_NS);
const LIVE_KV_BINDINGS = LIVE_KV ? [
  "--binding", `GV_KV_TOKEN=${DEPLOY_ENV.CLOUDFLARE_API_TOKEN}`,
  "--binding", `GV_KV_ACCOUNT=${DEPLOY_ENV.CLOUDFLARE_ACCOUNT_ID}`,
  "--binding", `GV_KV_NS=${DEPLOY_ENV.GV_KV_NS}`,
] : [];
// Realtime posture must MATCH the KV posture, or the two halves of a board's
// persistence diverge silently. Live KV + the instance's shared secret → the canvas
// joins the real rooms through /__rt (the secret gates the realtime worker; without
// it every join is a 403 and the canvas quietly degrades to solo). Local-sandbox KV →
// realtime is DISABLED outright (GV_RT_DISABLE, honoured by rtProxy), because a
// "sandbox" whose boards still broadcast into the shared prod rooms is not a sandbox.
const RT_SECRET = LIVE_KV && DEPLOY_ENV.RT_SHARED_SECRET;
const RT_BINDINGS = RT_SECRET
  ? ["--binding", `RT_SHARED_SECRET=${DEPLOY_ENV.RT_SHARED_SECRET}`]
  : LIVE_KV ? [] : ["--binding", "GV_RT_DISABLE=1"];
// Build from the canonical EDIT-HERE clones, not the pinned nested submodules.
// One repo per space: a maintainer workspace puts each space repo — a self-contained
// bundle with that space's design system AND prototypes at its root — as a sibling of
// augur/ (../<space>, …), and that's where every agent edits. Building from them means
// a local preview reflects live edits with no pin bump, no matter which agent made the
// change. A sibling counts as a space iff it carries a space.json at its root — the same
// filter build.js's discoverSpaces() applies — so augur itself and scratch dirs are
// ignored. Fall back to the pinned submodules under augur/spaces/ if no sibling space
// exists (e.g. augur cloned on its own, outside a multi-space workspace).
const PARENT = path.join(ROOT, "..");
let siblingSpaces = [];
try {
  siblingSpaces = readdirSync(PARENT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".")
      && existsSync(path.join(PARENT, e.name, "space.json")))
    .map((e) => path.join(PARENT, e.name));
} catch {}
const usingSiblings = siblingSpaces.length > 0;
const SPACES_ROOT = usingSiblings ? PARENT : path.join(ROOT, "spaces");
// Passed to build.js so it composes every space from here (see GV_SPACES_ROOT there).
// GV_LOCAL says this build is only ever served from this machine, which is what lets a
// space's tracks/ music play here while staying out of everything that ships.
const BUILD_ENV = { ...process.env, GV_SPACES_ROOT: SPACES_ROOT, GV_LOCAL: "1" };
// Identity + deploy config: explicit env wins; else auto-detect a sibling DEPLOY SHELL
// by shape — any sibling dir with an identity.json at its root that is not a space
// (shell repo names vary per instance). The shell also contributes deploy.config.json
// when it has one. A raw engine clone with no shell falls back to the in-repo
// src/identity.json (an empty [] placeholder → gate stays open).
const SHELL_DIR = findShellDir(ROOT);
const IDENTITY_PATH = process.env.GV_IDENTITY_PATH
  || [SHELL_DIR && path.join(SHELL_DIR, "identity.json"), path.join(ROOT, "src", "identity.json")]
    .filter(Boolean).find((p) => existsSync(p));
if (IDENTITY_PATH) BUILD_ENV.GV_IDENTITY_PATH = IDENTITY_PATH;
const DEPLOY_CONFIG_PATH = process.env.GV_DEPLOY_CONFIG_PATH
  || (SHELL_DIR && existsSync(path.join(SHELL_DIR, "deploy.config.json"))
      ? path.join(SHELL_DIR, "deploy.config.json") : null);
if (DEPLOY_CONFIG_PATH) BUILD_ENV.GV_DEPLOY_CONFIG_PATH = DEPLOY_CONFIG_PATH;

// Build inputs to watch — each space repo (its DS assets + prototypes) plus the
// augur-owned build inputs. Specific subtrees only — never node_modules, .git, dist,
// .wrangler, or space-specific bulk dirs (IGNORE below filters their events even
// inside a watched space root; extend via GV_SCAN_IGNORE, comma-separated).
const WATCH = [
  path.join(ROOT, "build.js"),
  path.join(ROOT, "src", "_worker.js"),
  ...(IDENTITY_PATH ? [IDENTITY_PATH] : []),  // users + seed passwords → rebuild on change
  ...(DEPLOY_CONFIG_PATH ? [DEPLOY_CONFIG_PATH] : []),  // instance config → rebuild on change
  path.join(ROOT, "src", "canvas"),  // the infinite-canvas engine (emitted to /__canvas)
  path.join(ROOT, "src", "review"),  // comment/annotation overlay (emitted to /__review)
  path.join(ROOT, "pitis"),          // augur-owned cursor-companion layer
  ...(usingSiblings ? siblingSpaces : [path.join(ROOT, "spaces")]),
];

// Paths whose changes are noise — ignore even if they live under a watched root.
const IGNORE = [
  "node_modules", "/.git/", "/dist/", "/.wrangler/", ".DS_Store",
  ...(process.env.GV_SCAN_IGNORE || "").split(",").filter(Boolean),
];
// endsWith catches an event for the .git dir itself (no trailing slash) — the watch
// roots are now whole sibling repos, which contain a real .git.
const ignored = (abs) => IGNORE.some((frag) => abs.includes(frag)) || abs.endsWith("/.git");

// ── build (run-to-completion, with a queued-rebuild guard) ───────────────────
let building = false;
let pending = false;

function build(reason) {
  if (building) { pending = true; return; }
  building = true;
  const started = Date.now();
  log(`↻ building${reason ? ` (${reason})` : ""}…`);
  const proc = spawn("node", ["build.js"], { cwd: ROOT, env: BUILD_ENV, stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  proc.stderr.on("data", (d) => { err += d; });
  proc.on("close", (code) => {
    building = false;
    if (code === 0) log(`✓ built in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    else log(`✗ build failed (exit ${code})\n${err.trim()}`);
    if (pending) { pending = false; build("queued change"); }
  });
}

// ── initial build, then launch wrangler ──────────────────────────────────────
log(`starting offline mode — building from ${usingSiblings ? "canonical sibling space clones (edit-here)" : "nested submodules (pinned)"}`);
log(`  spaces: ${usingSiblings ? siblingSpaces.join(", ") : path.join(ROOT, "spaces")}`);
await new Promise((resolve) => {
  const proc = spawn("node", ["build.js"], { cwd: ROOT, env: BUILD_ENV, stdio: "inherit" });
  proc.on("close", resolve);
});

log(`serving on http://localhost:${PORT}  (Ctrl-C to stop)`);
log(LIVE_KV
  ? "KV: \x1b[1mLIVE\x1b[0m\x1b[35m — comments/pins/status/renames read & write PRODUCTION KV (prototypes stay local)"
  : "KV: local (.env.deploy with Cloudflare creds absent → safe local sandbox)");
log(RT_SECRET
  ? "realtime: LIVE — canvas boards join the instance's real rooms through /__rt"
  : LIVE_KV
    ? "realtime: \x1b[1mUNAVAILABLE\x1b[0m\x1b[35m — no RT_SHARED_SECRET in .env.deploy; canvas boards run SOLO (saves still land in prod KV)"
    : "realtime: disabled (sandbox) — canvas boards run solo against local KV");
let wrangler = null;
let stopping = false;
const crashTimes = [];
function spawnWrangler() {
  wrangler = spawn(
    "npx",
    ["--yes", "wrangler", "pages", "dev", "dist",
      "--kv", "COMMENTS",
      ...LIVE_KV_BINDINGS,
      ...RT_BINDINGS,
      "--port", PORT,
      "--compatibility-date", "2024-09-01",
      "--persist-to", ".wrangler/state"],
    { cwd: ROOT, stdio: "inherit" },
  );
  // A workerd crash must not take the whole offline server with it — every open tab
  // would lose its save rail AND its room at once, and unsaved board edits would sit
  // in browser memory until someone noticed the port was dead. Respawn instead, with
  // a crash-loop cutoff (policy in lib/offline-respawn.mjs) so an unstartable worker
  // (port taken, broken build) fails loudly rather than restart-storming.
  wrangler.on("close", (code) => {
    if (stopping) process.exit(code ?? 0);
    const now = Date.now();
    const delay = respawnDelay(crashTimes, now);
    crashTimes.push(now);
    if (delay === null) {
      log(`wrangler exited (${code}) — crash loop, giving up. Fix the cause and restart.`);
      process.exit(code ?? 1);
    }
    log(`wrangler exited (${code}) — respawning in ${delay / 1000}s`);
    setTimeout(spawnWrangler, delay);
  });
}
spawnWrangler();

// ── watch inputs, debounce, rebuild ──────────────────────────────────────────
let timer = null;
const onChange = (root) => (_evt, file) => {
  // For a directory target, `file` is the path within it; for a file target, `file`
  // is just that file's basename (so don't re-join it onto the already-full root).
  const abs = file && !root.endsWith(file) ? path.join(root, file) : root;
  if (ignored(abs)) return;
  clearTimeout(timer);
  timer = setTimeout(() => build(path.relative(ROOT, abs)), 200); // debounce bursts of fs events
};

for (const target of WATCH) {
  try {
    watch(target, { recursive: true }, onChange(target));
  } catch {
    // A watched path may not exist in every checkout (e.g. an optional dir) — skip it.
  }
}
log(`watching ${WATCH.length} input paths for changes`);

// ── teardown ─────────────────────────────────────────────────────────────────
function shutdown() {
  log("stopping.");
  stopping = true;
  if (wrangler) wrangler.kill("SIGINT");
  else process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
