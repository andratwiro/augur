// offline.mjs — local "offline mode" for Augur.
//
//   npm run offline   →  start   ·   Ctrl-C  →  stop
//
// What it does:
//   1. Builds dist once (node build.js).
//   2. Starts `wrangler pages dev dist` — the REAL src/_worker.js runs locally with a
//      local KV store, so the password gate is off (open), and every overlay API
//      (comments / pins / status / names / piti) works against on-disk KV. No network,
//      no Cloudflare, no deploy — a faithful local mirror of the live site.
//   3. Watches the build inputs (the design system, the workspace, build.js, the
//      worker) and rebuilds on any change. Each build stamps a fresh BUILD_ID into
//      dist/_worker.js; wrangler reloads the worker, and the page's live-reload poller
//      (which polls /__version every ~1s on localhost) refreshes open tabs in ~1s.
//
// Zero new dependencies: Node's recursive fs.watch + npx wrangler (same as deploy).

import { spawn } from "node:child_process";
import { watch, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.OFFLINE_PORT || "8788";

const log = (msg) => console.log(`\x1b[35m[offline]\x1b[0m ${msg}`);

// Build from the canonical EDIT-HERE clones, not the pinned nested submodules.
// The god-mode checkout puts the canonical DS + workspace as siblings of augur/
// (../gv-design-system, ../gv-workspace) — that's where every agent edits. Building
// from them means a local preview reflects live edits with no pin bump, no matter
// which agent made the change. Fall back to the nested submodules if the siblings
// aren't present (e.g. augur cloned on its own, outside the god-mode container).
const SIBLING_DS = path.join(ROOT, "..", "gv-design-system");
const SIBLING_WS = path.join(ROOT, "..", "gv-workspace");
const usingSiblings = existsSync(SIBLING_DS) && existsSync(SIBLING_WS);
const DS_ROOT = usingSiblings ? SIBLING_DS : path.join(ROOT, "gv-design-system");
const WS_ROOT = usingSiblings ? SIBLING_WS : path.join(ROOT, "gv-workspace");
// Passed to build.js so it composes from these roots (see GV_DS_ROOT / GV_WS_ROOT there).
const BUILD_ENV = { ...process.env, GV_DS_ROOT: DS_ROOT, GV_WS_ROOT: WS_ROOT };

// Build inputs to watch. Specific subtrees only — never the 1.5GB gitignored
// gv-design-system/govocal-exports, node_modules, .git, dist, or .wrangler.
const WATCH = [
  path.join(ROOT, "build.js"),
  path.join(ROOT, "src", "_worker.js"),
  path.join(ROOT, "pitis"),          // augur-owned cursor-companion layer
  ...["skills", "components", "pages", "base", "patterns", "tokens.json", "registry"]
    .map((p) => path.join(DS_ROOT, p)),
  WS_ROOT,
];

// Paths whose changes are noise — ignore even if they live under a watched root
// (notably the workspace's own nested DS submodule, a read-only duplicate).
const IGNORE = [
  "node_modules", "/.git/", "govocal-exports", "/dist/", "/.wrangler/",
  `${path.basename(WS_ROOT)}/gv-design-system`, ".DS_Store",
];
const ignored = (abs) => IGNORE.some((frag) => abs.includes(frag));

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
log(`starting offline mode — building from ${usingSiblings ? "canonical sibling clones (edit-here)" : "nested submodules (pinned)"}`);
log(`  DS: ${DS_ROOT}`);
log(`  WS: ${WS_ROOT}`);
await new Promise((resolve) => {
  const proc = spawn("node", ["build.js"], { cwd: ROOT, env: BUILD_ENV, stdio: "inherit" });
  proc.on("close", resolve);
});

log(`serving on http://localhost:${PORT}  (Ctrl-C to stop)`);
const wrangler = spawn(
  "npx",
  ["--yes", "wrangler", "pages", "dev", "dist",
    "--kv", "COMMENTS",
    "--port", PORT,
    "--compatibility-date", "2024-09-01",
    "--persist-to", ".wrangler/state"],
  { cwd: ROOT, stdio: "inherit" },
);

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
  wrangler.kill("SIGINT");
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
wrangler.on("close", (code) => { log(`wrangler exited (${code})`); process.exit(code ?? 0); });
