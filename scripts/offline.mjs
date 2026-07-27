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
//   3. Watches the build inputs (the design system, the workspace, build.js, the
//      worker) and rebuilds on any change. Each build stamps a fresh BUILD_ID into
//      dist/_worker.js; wrangler reloads the worker, and the page's live-reload poller
//      (which polls /__version every ~1s on localhost) refreshes open tabs in ~1s.
//
// Zero new dependencies: Node's recursive fs.watch + npx wrangler (same as deploy).

import { spawn } from "node:child_process";
import { watch, existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import http from "node:http";
import os from "node:os";
import { fileURLToPath } from "node:url";

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
// AI backend for the /__ai/summarize route (Project Builder doc summariser).
// Preferred: a local `claude -p` bridge — uses the maintainer's Claude login,
// NO API tokens (see startAiBridge below). If the CLI isn't on PATH, fall back
// to an ANTHROPIC_API_KEY from .env.deploy (pay-as-you-go). Neither → the route
// 503s and the prototype uses its local heuristic.
function hasCli(bin) {
  const exts = process.platform === "win32" ? [".cmd", ".exe", ""] : [""];
  return (process.env.PATH || "").split(path.delimiter).some((dir) =>
    dir && exts.some((ext) => { try { return existsSync(path.join(dir, bin + ext)); } catch { return false; } }));
}
const CLI_OK = hasCli("claude");
const AI_PORT = process.env.OFFLINE_AI_PORT || "8790";
const AI_CLI_MODEL = process.env.OFFLINE_AI_MODEL || "claude-haiku-4-5";
const AI_BINDINGS = CLI_OK
  ? ["--binding", `AI_CLI_URL=http://127.0.0.1:${AI_PORT}`]
  : (DEPLOY_ENV.ANTHROPIC_API_KEY ? ["--binding", `ANTHROPIC_API_KEY=${DEPLOY_ENV.ANTHROPIC_API_KEY}`] : []);

// ── AI bridge: POST /summarize {text} → `claude -p` → structured JSON ─────────
// Runs headless Claude Code in a scratch cwd (so the repo's own MCP/skills don't
// load), instructs it to emit only the drafting-signals JSON, and returns it.
function aiPrompt(text) {
  return [
    "Read the document at the end and reply with ONLY a single minified JSON object — no prose, no markdown code fences.",
    'Schema: {"title":"≤64 chars, in the document language","summary":"exactly two plain sentences in the document language: what the consultation is about and what decision it feeds; no \\"This document\\" preamble","archetype":"inform|agenda|cocreate|devolved|community","flags":{"budget":bool,"surveyLed":bool,"spatial":bool,"commonground":bool,"proposals":bool,"volunteering":bool},"tags":["1 to 4 of: Consultatie, Stedelijke ontwikkeling, Mobiliteit, Milieu, Jongeren, Ouderen, Burgerbegroting, Financiën, Veiligheid, Cultuur"]}',
    "archetype: inform=communicate a decision; agenda=what should we prioritise; cocreate=shape a plan or site; devolved=residents vote or allocate a budget; community=identity/celebration.",
    "Ground every field ONLY in the document; never invent a budget, audience, or scope it doesn't state. Use conservative defaults when unsure (budget=false unless residents clearly allocate money).",
    "=== DOCUMENT ===",
    text,
  ].join("\n");
}
function extractJson(s) {
  let t = String(s || "").replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  const i = t.indexOf("{"), j = t.lastIndexOf("}");
  if (i < 0 || j < 0 || j < i) return null;
  try { return JSON.parse(t.slice(i, j + 1)); } catch { return null; }
}
function runClaude(text) {
  return new Promise((resolve) => {
    const proc = spawn("claude", ["-p", "--output-format", "json", "--model", AI_CLI_MODEL, "--strict-mcp-config"], { cwd: os.tmpdir() });
    let out = "", err = "";
    const killer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 90000);
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    proc.on("error", (e) => { clearTimeout(killer); resolve({ error: "spawn: " + e.message }); });
    proc.on("close", (code) => {
      clearTimeout(killer);
      let env; try { env = JSON.parse(out); } catch { resolve({ error: "envelope (" + code + "): " + err.slice(0, 160) }); return; }
      const obj = extractJson(env && env.result);
      resolve(obj ? { obj } : { error: "result not JSON" });
    });
    proc.stdin.write(aiPrompt(text)); proc.stdin.end();
  });
}
function startAiBridge() {
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url.startsWith("/summarize")) { res.writeHead(404); res.end(); return; }
    let buf = "";
    req.on("data", (c) => { buf += c; if (buf.length > 200000) req.destroy(); });
    req.on("end", async () => {
      let text = ""; try { text = (JSON.parse(buf).text) || ""; } catch {}
      text = text.slice(0, 24000); // ~4k words — docs front-load their purpose; keeps the call ~7s not ~34s
      if (text.trim().length < 40) { res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":"short"}'); return; }
      const r = await runClaude(text);
      res.writeHead(r.obj ? 200 : 502, { "content-type": "application/json" });
      res.end(JSON.stringify(r.obj || { error: r.error || "cli" }));
    });
  });
  server.on("error", (e) => log(`AI bridge failed: ${e.message}`));
  server.listen(Number(AI_PORT), "127.0.0.1", () =>
    log(`AI: \x1b[32mclaude -p\x1b[0m bridge on http://127.0.0.1:${AI_PORT} (model ${AI_CLI_MODEL}, no API tokens)`));
}

// Build from the canonical EDIT-HERE clones, not the pinned nested submodules.
// One repo per space: the god-mode checkout puts each space repo — a self-contained
// bundle with that space's design system AND prototypes at its root — as a sibling of
// augur/ (../<space>, …), and that's where every agent edits. Building from them means
// a local preview reflects live edits with no pin bump, no matter which agent made the
// change. A sibling counts as a space iff it carries a space.json at its root — the same
// filter build.js's discoverSpaces() applies — so augur itself and scratch dirs are
// ignored. Fall back to the pinned submodules under augur/spaces/ if no sibling space
// exists (e.g. augur cloned on its own, outside the god-mode container).
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
const BUILD_ENV = { ...process.env, GV_SPACES_ROOT: SPACES_ROOT };
// Identity + deploy config: explicit env wins; else auto-detect a sibling DEPLOY SHELL
// by shape — any sibling dir with an identity.json at its root that is not a space
// (shell repo names vary per instance). The shell also contributes deploy.config.json
// when it has one. A raw engine clone with no shell falls back to the in-repo
// src/identity.json (an empty [] placeholder → gate stays open).
let SHELL_DIR = null;
try {
  SHELL_DIR = readdirSync(PARENT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".")
      && path.resolve(PARENT, e.name) !== path.resolve(ROOT)
      && !existsSync(path.join(PARENT, e.name, "space.json"))
      && existsSync(path.join(PARENT, e.name, "identity.json")))
    .map((e) => path.join(PARENT, e.name)).sort()[0] || null;
} catch {}
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
if (CLI_OK) startAiBridge();
else if (DEPLOY_ENV.ANTHROPIC_API_KEY) log("AI: Anthropic API key (pay-as-you-go) — `claude` CLI not found on PATH");
else log("AI: off (no `claude` CLI, no ANTHROPIC_API_KEY) → Project Builder uses its local heuristic");
const wrangler = spawn(
  "npx",
  ["--yes", "wrangler", "pages", "dev", "dist",
    "--kv", "COMMENTS",
    ...LIVE_KV_BINDINGS,
    ...AI_BINDINGS,
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
