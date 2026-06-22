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
import { watch } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.OFFLINE_PORT || "8788";

// Build inputs to watch. Specific subtrees only — never the 1.5GB gitignored
// gv-design-system/govocal-exports, node_modules, .git, dist, or .wrangler.
const WATCH = [
  "build.js",
  "src/_worker.js",
  "gv-design-system/skills",
  "gv-design-system/components",
  "gv-design-system/pages",
  "gv-design-system/base",
  "gv-design-system/patterns",
  "gv-design-system/tokens.json",
  "gv-design-system/registry",
  "gv-workspace",
].map((p) => path.join(ROOT, p));

// Paths whose changes are noise — ignore even if they live under a watched root
// (notably gv-workspace's nested DS submodule, which is a read-only duplicate).
const IGNORE = [
  "node_modules", "/.git/", "govocal-exports", "/dist/", "/.wrangler/",
  "gv-workspace/gv-design-system", ".DS_Store",
];
const ignored = (rel) => IGNORE.some((frag) => rel.includes(frag));

const log = (msg) => console.log(`\x1b[35m[offline]\x1b[0m ${msg}`);

// ── build (run-to-completion, with a queued-rebuild guard) ───────────────────
let building = false;
let pending = false;

function build(reason) {
  if (building) { pending = true; return; }
  building = true;
  const started = Date.now();
  log(`↻ building${reason ? ` (${reason})` : ""}…`);
  const proc = spawn("node", ["build.js"], { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"] });
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
log("starting offline mode — first build…");
await new Promise((resolve) => {
  const proc = spawn("node", ["build.js"], { cwd: ROOT, stdio: "inherit" });
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
  const rel = path.relative(ROOT, abs);
  if (ignored(rel)) return;
  clearTimeout(timer);
  timer = setTimeout(() => build(rel), 200); // debounce bursts of fs events
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
