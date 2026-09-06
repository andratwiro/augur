// adapters.mjs — the agent-tool side of drafts that land (docs/drafts-that-land.md §7).
//
// Two decisions, made here and nowhere else: MAY THIS PATH BE WRITTEN (before an edit) and
// WHICH DRAFT SHOULD SAVE NOW (after one). Every agent tool is a row in ADAPTERS naming its
// settings file, which tool names to hook, and how its payload spells a file path; the
// command each hook runs is the same `augur hook <pre|post>` for all of them. Adding a
// tool is adding a row.
//
// THE DENY RULE IS NARROW ON PURPOSE. A write is refused only inside a registered read-only
// copy, or inside a space checkout (a folder with space.json above it) under a unit home —
// `<opportunity>/prototypes/<name>/…` or `playground/<name>/…` — that is not a registered
// draft folder. Other projects, a space's design-system tiers, its research and its
// space.json are never touched: the rule exists so two sessions sharing one checkout stop
// carrying each other's half-done prototypes live, not to police a machine.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// What identifies OUR entries in a settings file: the quoted script name and the event,
// exactly as `hookCommand` spells them — so an entry survives the engine moving on disk
// (the path changes, the tail does not) and nobody else's hook is ever mistaken for ours.
export const HOOK_TAG = 'hook.mjs"';
// Two spellings are ours: the clone-era `node "<path>/hook.mjs" pre` and the package-era
// `augur hook pre`. Both are matched so an entry written by an older engine is replaced
// on the next `augur open`, never duplicated.
const OURS_RE = /(?:hook\.mjs" |(?:^|\s)augur hook )(?:pre|post)$/;
export const HOOK_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "hook.mjs");
export const UNIT_HOME_RE = /^(?:([^/]+)\/prototypes\/([^/]+)|(playground)\/([^/]+))(?:\/|$)/;

export function isInside(dir, p) {
  const rel = path.relative(dir, p);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** The nearest folder above `p` holding a space.json, or null. */
export function spaceRootOf(p) {
  let dir = path.dirname(path.resolve(p));
  for (;;) {
    if (fs.existsSync(path.join(dir, "space.json"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

const bare = (unit) => String(unit || "").replace(/^\/|\/$/g, "");
const homeToUnit = (m) => (m[3] ? `/${m[3]}/${m[4]}/` : `/${m[1]}/${m[2]}/`);

export function denyDecision({ filePath, cwd, registry, findSpaceRoot = spaceRootOf }) {
  if (!filePath) return { allow: true };
  const abs = path.resolve(cwd || process.cwd(), String(filePath));
  for (const e of registry || []) {
    if (!e || !e.dir || !isInside(e.dir, abs)) continue;
    if (e.readOnly) {
      return { deny: true, reason: `${abs} is a read-only copy of ${e.unit}. To edit it, open a draft: augur open ${bare(e.unit)} — then edit the folder that creates.` };
    }
    return { allow: true, draft: e };
  }
  const root = findSpaceRoot(abs);
  if (!root) return { allow: true };
  const rel = path.relative(root, abs).split(path.sep).join("/");
  const m = UNIT_HOME_RE.exec(rel);
  // The home folder itself (`checkout/prototypes/flow`) is a folder, not a file in one.
  if (!m || rel === m[0].replace(/\/$/, "")) return { allow: true };
  const unit = homeToUnit(m);
  return { deny: true, reason: `${rel} is a prototype in a shared checkout, so edits go through a draft: run augur open ${bare(unit)}, edit the folder it creates (live at once at its own address), and augur land when it is ready.` };
}

export function saveDecision({ filePath, cwd, registry }) {
  if (!filePath) return null;
  const abs = path.resolve(cwd || process.cwd(), String(filePath));
  for (const e of registry || []) {
    if (!e || !e.dir || e.readOnly || !isInside(e.dir, abs)) continue;
    if (isInside(path.join(e.dir, ".augur"), abs)) return null;
    return { dir: e.dir, entry: e };
  }
  return null;
}

// ── the tools ────────────────────────────────────────────────────────────────
export const ADAPTERS = Object.freeze([
  Object.freeze({
    id: "claude-code",
    name: "Claude Code",
    settingsPath: (home) => path.join(home, ".claude", "settings.json"),
    detect: (home) => fs.existsSync(path.join(home, ".claude")),
    matcher: "Write|Edit|MultiEdit|NotebookEdit",
    payload: (j) => {
      const t = (j && j.tool_input) || {};
      return { filePath: t.file_path || t.notebook_path || null, cwd: (j && j.cwd) || null, session: (j && j.session_id) || null };
    },
  }),
]);

/**
 * The command a tool runs for one of our hooks. With the package installed globally
 * (`npm i -g @augurworks/augur`) `augur` resolves on PATH and the hook says so, because
 * the absolute path of a global install moves on every upgrade. Otherwise — a clone, or
 * a one-off `npx` run — the absolute path to this engine's hook.mjs is the one thing
 * guaranteed to exist.
 */
export const hookCommand = (event, { onPath = false } = {}) =>
  onPath ? `augur hook ${event}` : `node "${HOOK_SCRIPT}" ${event}`;
/** Whether `augur` resolves on this machine's PATH. Asked once, at install time. */
export function augurOnPath() {
  try {
    const out = execFileSync(process.platform === "win32" ? "where" : "which", ["augur"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const found = out.trim().split(/\r?\n/)[0] || "";
    // Inside an `npx` run the package's own bin dir is on PATH and `augur` resolves to a shim
    // in the npx cache — gone the moment npx exits. A hook written as `augur hook pre` from
    // there fails on every later edit (one cold agent's drafts never auto-saved, and its tool
    // showed a "not found" on each write). That resolution counts as NOT on PATH.
    return found.length > 0 && !/[\\/]_npx[\\/]/.test(found);
  } catch (e) { return false; }
}
const ours = (h) => !!(h && Array.isArray(h.hooks) && h.hooks.some((x) => x && typeof x.command === "string" && OURS_RE.test(x.command.trim())));

export function mergeHooks(settings, matcher, commands) {
  const s = settings && typeof settings === "object" ? JSON.parse(JSON.stringify(settings)) : {};
  s.hooks = s.hooks && typeof s.hooks === "object" ? s.hooks : {};
  let changed = false;
  for (const [event, command] of [["PreToolUse", commands.pre], ["PostToolUse", commands.post]]) {
    const want = { matcher, hooks: [{ type: "command", command }] };
    const list = Array.isArray(s.hooks[event]) ? s.hooks[event] : [];
    const mine = list.filter(ours), theirs = list.filter((h) => !ours(h));
    if (mine.length === 1 && JSON.stringify(mine[0]) === JSON.stringify(want)) continue;
    s.hooks[event] = [...theirs, want];
    changed = true;
  }
  return { settings: s, changed };
}

export function stripHooks(settings) {
  const s = settings && typeof settings === "object" ? JSON.parse(JSON.stringify(settings)) : {};
  let changed = false;
  for (const event of Object.keys(s.hooks || {})) {
    const list = Array.isArray(s.hooks[event]) ? s.hooks[event] : [];
    const theirs = list.filter((h) => !ours(h));
    if (theirs.length === list.length) continue;
    changed = true;
    if (theirs.length) s.hooks[event] = theirs; else delete s.hooks[event];
  }
  return { settings: s, changed };
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return null; }
}
function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p + ".tmp", JSON.stringify(v, null, 2) + "\n");
  fs.renameSync(p + ".tmp", p);
}

function applyToAdapters({ home = os.homedir(), dryRun = false } = {}, decide) {
  const out = [];
  for (const a of ADAPTERS) {
    if (!a.detect(home)) { out.push({ id: a.id, name: a.name, result: "absent" }); continue; }
    const p = a.settingsPath(home);
    const cur = readJson(p);
    const r = decide(a, cur);
    if (r.changed && !dryRun) writeJson(p, r.settings);
    out.push({ id: a.id, name: a.name, result: r.changed ? r.did : "unchanged", path: p });
  }
  return out;
}

/** Install the two hooks for every tool present on this machine. Idempotent; keeps every other hook. */
export function installAdapters(opts = {}) {
  return applyToAdapters(opts, (a, cur) => {
    const onPath = typeof opts.onPath === "boolean" ? opts.onPath : augurOnPath();
    const r = mergeHooks(cur, a.matcher, { pre: hookCommand("pre", { onPath }), post: hookCommand("post", { onPath }) });
    const had = !!(cur && cur.hooks && Object.values(cur.hooks).some((l) => Array.isArray(l) && l.some(ours)));
    return { ...r, did: had ? "updated" : "installed" };
  });
}
export function removeAdapters(opts = {}) {
  return applyToAdapters(opts, (a, cur) => ({ ...stripHooks(cur), did: "removed" }));
}
