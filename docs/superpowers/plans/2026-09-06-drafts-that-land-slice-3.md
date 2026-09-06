# Drafts That Land — Slice 3 (Tool Adapters) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent's edits inside a draft folder are saved and live before its next tool call, its writes to a shared checkout's prototypes or to a read-only copy are refused with the reason, and the two remaining verbs of the agent's day — `read` and `watch` — plus `status` listing this machine's drafts exist.

**Architecture:** One pure module (`scripts/lib/adapters.mjs`) holds the two decisions every adapter makes — *may this path be written* and *which draft should save now* — and a table of agent tools, each a row naming its settings file, its tool-name matcher and how its hook payload spells a file path. `augur hook pre|post` is the one command every adapter's hook runs, reading the tool's JSON on stdin and answering with an exit code (2 = refuse, reason on stderr). `augur open` installs the adapters for the tools present on this machine, idempotently, after its first successful open. `augur read` materialises a unit read-only under `_read/`; `augur watch` is a debounced save loop; `augur status` gains a drafts section. The first adapter row is the tool the engine's own sessions run in.

**Tech Stack:** Plain Node (no dependencies), `node:test`, `fs.watch` with `recursive: true` (Node ≥ 20 on every platform this repo supports).

## Global Constraints

- Spec: `docs/drafts-that-land.md` §4 (rules of the day), §7 (the local tool), §9 (edge cases). Slices 1 and 2 plans establish every file touched here.
- **Zero product words** — `npm run check` must stay green. The adapter table names a third-party tool the way `README.md` already does (its own name, no more), in one row, and nowhere else.
- **Plain Node, no dependencies. Never `git add -A`.**
- **The hook must never break an editor by accident.** Any error inside `augur hook` that is not a deliberate refusal exits 0 with nothing on stderr. Only a refusal (deny, a refused save, no token, offline) exits 2, and its stderr is one sentence the agent can act on. `AUGUR_HOOKS_OFF=1` makes both hooks inert.
- **The deny rule is narrow on purpose.** A write is refused only when it lands (a) inside a registered read-only copy, or (b) inside a space checkout — a folder with `space.json` above it — under a unit home (`<opportunity>/prototypes/<name>/…` or `playground/<name>/…`) that is not a registered draft folder. Everything else on the machine is untouched: other projects, a space's design-system tiers, its docs, `space.json` itself.
- **The registry is the one machine-wide file** (`~/.config/augur/drafts.json`, atomic rename; `AUGUR_DRAFTS_REGISTRY` in tests). Read-only copies are registered too, with `readOnly: true`.
- **Adapter install is idempotent and additive**: it rewrites only its own entries (identified by the `augur hook` tag in the command), preserves every other hook the person has, and is skipped under `AUGUR_NO_ADAPTERS=1` (the suite sets it).
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. `npm test` before every commit; `npm run check` before the last commit of each task.

## What this slice deliberately leaves out

- **The session label from the tool.** The hook payload carries a session *id*, not a name, and nothing in it is a label a person would recognise on a chip. The label stays what slice 1 set: `--session`, `AUGUR_SESSION`, else a generated one. If the tool ever exposes a name, it is one line in the adapter row.
- **Contracts** (space `CLAUDE.md`s, `/llms.txt`, `ship` as an alias) — slice 4, as listed in slice 1.

## File Structure

| File | Responsibility |
| --- | --- |
| `scripts/lib/adapters.mjs` (new) | Pure: `spaceRootOf`, `isInside`, `denyDecision`, `saveDecision`, the `ADAPTERS` table, `mergeHooks`/`stripHooks`, `installAdapters`/`removeAdapters`. |
| `scripts/hook.mjs` (new) | `augur hook pre|post` (stdin JSON → exit code), `augur hook install|remove|status`. |
| `scripts/lib/draft.mjs` (modify) | `main` on the client; `doRead`, `doCloseRead`, `watchFolder`, `draftsReport`; `doClose` closes a read copy. |
| `scripts/read.mjs`, `scripts/watch.mjs` (new) | Thin entry points. |
| `scripts/open.mjs`, `scripts/close.mjs`, `scripts/status.mjs`, `scripts/cli.mjs` (modify) | Install adapters after open; close a read copy; the drafts section; route `read`, `watch`, `hook`. |
| `test/adapters.test.mjs`, `test/draft-tools.test.mjs`, `test/hooks-drill.test.mjs` (new) | Decisions and install; read/watch/close/report over a fake instance; the hook end to end over the real worker. |

---

### Task 1: The decisions and the adapter table

**Files:**
- Create: `scripts/lib/adapters.mjs`
- Test: `test/adapters.test.mjs`

**Interfaces:**
- `spaceRootOf(absPath) → string|null` — nearest ancestor folder holding `space.json`, or null.
- `isInside(dir, p) → boolean`.
- `UNIT_HOME_RE` — matches `<opp>/prototypes/<name>` and `playground/<name>` at the start of a space-relative path.
- `denyDecision({filePath, cwd, registry, findSpaceRoot}) → {allow: true, draft?} | {deny: true, reason}`.
- `saveDecision({filePath, cwd, registry}) → {dir, entry} | null` — inside a registered draft (not read-only), not under `.augur/`.
- `ADAPTERS` — `[{id, name, settingsPath(home), detect(home), matcher, payload(json) → {filePath, cwd, session}}]`.
- `hookCommand(event) → string` — `node "<abs scripts/hook.mjs>" <event>`.
- `mergeHooks(settings, matcher, commands) → {settings, changed}`; `stripHooks(settings) → {settings, changed}`.
- `installAdapters({home}) → [{id, name, result: "installed"|"updated"|"unchanged"|"absent"}]`; `removeAdapters({home})` likewise with `"removed"|"unchanged"|"absent"`.

- [ ] **Step 1: Write the failing tests**

```js
// test/adapters.test.mjs — the two decisions every agent-tool adapter makes, and the install.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  spaceRootOf, isInside, denyDecision, saveDecision, ADAPTERS, hookCommand,
  mergeHooks, stripHooks, installAdapters, removeAdapters, HOOK_TAG,
} from "../scripts/lib/adapters.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "augur-adapters-"));
const space = () => { const d = tmp(); fs.writeFileSync(path.join(d, "space.json"), JSON.stringify({ id: "alpha" })); return d; };

test("spaceRootOf finds the nearest space.json above a path, and nothing outside one", () => {
  const root = space();
  fs.mkdirSync(path.join(root, "checkout", "prototypes", "flow"), { recursive: true });
  assert.equal(spaceRootOf(path.join(root, "checkout", "prototypes", "flow", "index.html")), root);
  assert.equal(spaceRootOf(path.join(tmp(), "x.html")), null);
  assert.equal(isInside("/a/b", "/a/b/c"), true);
  assert.equal(isInside("/a/b", "/a/bc/d"), false);
  assert.equal(isInside("/a/b", "/a"), false);
});

test("a write inside a registered draft folder is allowed; inside a read-only copy it is refused", () => {
  const draft = tmp(), read = tmp();
  const registry = [{ dir: draft, unit: "/checkout/flow/", draftId: "k7f3q1" }, { dir: read, unit: "/checkout/other/", readOnly: true }];
  const ok = denyDecision({ filePath: path.join(draft, "index.html"), cwd: draft, registry });
  assert.equal(ok.allow, true);
  assert.equal(ok.draft.draftId, "k7f3q1");
  const no = denyDecision({ filePath: "css/a.css", cwd: read, registry });
  assert.equal(no.deny, true);
  assert.match(no.reason, /read-only copy of \/checkout\/other\//);
  assert.match(no.reason, /augur open checkout\/other/);
});

test("a write to a prototype in a shared checkout is refused and told how; the rest of the space is not", () => {
  const root = space();
  const registry = [];
  const at = (rel) => denyDecision({ filePath: path.join(root, rel), cwd: root, registry });
  const proto = at("checkout/prototypes/flow/index.html");
  assert.equal(proto.deny, true);
  assert.match(proto.reason, /augur open checkout\/flow/);
  const play = at("playground/scratch/app.js");
  assert.equal(play.deny, true);
  assert.match(play.reason, /augur open playground\/scratch/);
  for (const rel of ["components/button/button.css", "tokens/tokens.css", "space.json", "checkout/research.md", "CLAUDE.md", "checkout/prototypes"]) {
    assert.equal(at(rel).allow, true, rel);
  }
  // A draft folder that happens to live INSIDE the checkout is a draft folder first.
  const inside = path.join(root, "flow");
  assert.equal(denyDecision({ filePath: path.join(inside, "index.html"), cwd: root, registry: [{ dir: inside, unit: "/checkout/flow/" }] }).allow, true);
  // Off every space, nothing is refused.
  assert.equal(denyDecision({ filePath: path.join(tmp(), "notes.md"), cwd: "/", registry }).allow, true);
  assert.equal(denyDecision({ filePath: null, cwd: root, registry }).allow, true, "no path, nothing to decide");
});

test("saveDecision names the draft folder an edit landed in, and ignores .augur and read-only copies", () => {
  const draft = tmp(), read = tmp();
  const registry = [{ dir: draft, unit: "/checkout/flow/", draftId: "k7f3q1" }, { dir: read, unit: "/x/y/", readOnly: true }];
  assert.equal(saveDecision({ filePath: "index.html", cwd: draft, registry }).dir, draft);
  assert.equal(saveDecision({ filePath: path.join(draft, ".augur", "draft.json"), cwd: "/", registry }), null);
  assert.equal(saveDecision({ filePath: path.join(read, "index.html"), cwd: "/", registry }), null);
  assert.equal(saveDecision({ filePath: path.join(tmp(), "a"), cwd: "/", registry }), null);
});

test("the first adapter reads its tool's payload: file path, notebook path, cwd, session", () => {
  const a = ADAPTERS[0];
  assert.deepEqual(a.payload({ tool_input: { file_path: "/w/a.html" }, cwd: "/w", session_id: "s1" }), { filePath: "/w/a.html", cwd: "/w", session: "s1" });
  assert.equal(a.payload({ tool_input: { notebook_path: "/w/n.ipynb" }, cwd: "/w" }).filePath, "/w/n.ipynb");
  assert.equal(a.payload({}).filePath, null);
  assert.match(a.matcher, /Write/);
  assert.match(a.matcher, /Edit/);
  assert.match(hookCommand("pre"), /hook\.mjs" pre$/);
  assert.ok(hookCommand("post").includes(HOOK_TAG));
});

test("mergeHooks adds our two hooks beside whatever is there, once, and stripHooks takes only ours away", () => {
  const theirs = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }], Notification: [{ hooks: [{ type: "command", command: "say ok" }] }] }, other: 1 };
  const m1 = mergeHooks(theirs, "Write|Edit", { pre: "node hook pre", post: "node hook post" });
  assert.equal(m1.changed, true);
  assert.equal(m1.settings.other, 1);
  assert.equal(m1.settings.hooks.PreToolUse.length, 2, "theirs kept, ours added");
  assert.equal(m1.settings.hooks.PostToolUse.length, 1);
  assert.equal(m1.settings.hooks.Notification.length, 1);
  assert.deepEqual(m1.settings.hooks.PreToolUse[1], { matcher: "Write|Edit", hooks: [{ type: "command", command: "node hook pre" }] });
  const m2 = mergeHooks(m1.settings, "Write|Edit", { pre: "node hook pre", post: "node hook post" });
  assert.equal(m2.changed, false, "a second install changes nothing");
  assert.equal(m2.settings.hooks.PreToolUse.length, 2);
  const m3 = mergeHooks(m1.settings, "Write|Edit", { pre: "node /elsewhere/hook.mjs pre", post: "node /elsewhere/hook.mjs post" });
  assert.equal(m3.changed, true, "a moved engine updates the command in place");
  assert.equal(m3.settings.hooks.PreToolUse.length, 2);
  const s = stripHooks(m1.settings);
  assert.equal(s.changed, true);
  assert.deepEqual(s.settings.hooks, { PreToolUse: theirs.hooks.PreToolUse, Notification: theirs.hooks.Notification });
  assert.equal(stripHooks(theirs).changed, false);
  assert.equal(mergeHooks(undefined, "W", { pre: "p", post: "q" }).settings.hooks.PreToolUse.length, 1, "no settings at all is fine");
});

test("installAdapters writes only for tools present, idempotently, and removeAdapters undoes only ours", () => {
  const home = tmp();
  assert.deepEqual(installAdapters({ home }).map((r) => r.result), ["absent"], "no tool folder, nothing written");
  fs.mkdirSync(path.join(home, ".claude"));
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { Notification: [{ hooks: [{ type: "command", command: "say ok" }] }] }, theme: "dark" }));
  assert.deepEqual(installAdapters({ home }).map((r) => r.result), ["installed"]);
  const written = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  assert.equal(written.theme, "dark");
  assert.equal(written.hooks.Notification.length, 1);
  assert.ok(written.hooks.PreToolUse[0].hooks[0].command.includes("hook.mjs\" pre"));
  assert.ok(written.hooks.PostToolUse[0].hooks[0].command.includes("hook.mjs\" post"));
  assert.deepEqual(installAdapters({ home }).map((r) => r.result), ["unchanged"]);
  assert.deepEqual(removeAdapters({ home }).map((r) => r.result), ["removed"]);
  const after = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(Object.keys(after.hooks), ["Notification"]);
  assert.deepEqual(removeAdapters({ home }).map((r) => r.result), ["unchanged"]);
  // A tool folder with no settings file yet gets one holding only our hooks.
  const home2 = tmp(); fs.mkdirSync(path.join(home2, ".claude"));
  assert.deepEqual(installAdapters({ home: home2 }).map((r) => r.result), ["installed"]);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(home2, ".claude", "settings.json"), "utf8"))), ["hooks"]);
});
```

- [ ] **Step 2: Run to verify it fails** — `node --test test/adapters.test.mjs` → cannot find module.

- [ ] **Step 3: Write the module**

```js
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

export const HOOK_TAG = "augur hook";
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

const bare = (unit) => unit.replace(/^\/|\/$/g, "");
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

export const hookCommand = (event) => `node "${HOOK_SCRIPT}" ${event}`;
const ours = (h) => h && h.hooks && h.hooks.some((x) => x && typeof x.command === "string" && x.command.includes(HOOK_TAG) && x.command.includes("hook.mjs"));

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

function applyToAdapters({ home = os.homedir() } = {}, decide) {
  const out = [];
  for (const a of ADAPTERS) {
    if (!a.detect(home)) { out.push({ id: a.id, name: a.name, result: "absent" }); continue; }
    const p = a.settingsPath(home);
    const cur = readJson(p);
    const r = decide(a, cur);
    if (r.changed) writeJson(p, r.settings);
    out.push({ id: a.id, name: a.name, result: r.changed ? r.did : "unchanged", path: p });
  }
  return out;
}

/** Install the two hooks for every tool present on this machine. Idempotent; keeps every other hook. */
export function installAdapters(opts = {}) {
  return applyToAdapters(opts, (a, cur) => {
    const r = mergeHooks(cur, a.matcher, { pre: hookCommand("pre"), post: hookCommand("post") });
    const had = cur && cur.hooks && Object.values(cur.hooks).some((l) => Array.isArray(l) && l.some(ours));
    return { ...r, did: had ? "updated" : "installed" };
  });
}
export function removeAdapters(opts = {}) {
  return applyToAdapters(opts, (a, cur) => ({ ...stripHooks(cur), did: "removed" }));
}
```

- [ ] **Step 4: Run** `node --test test/adapters.test.mjs` → PASS.
- [ ] **Step 5: Commit** — `cli: the adapter table and the two decisions every hook makes`.

---

### Task 2: `augur hook` — the command every adapter runs

**Files:**
- Create: `scripts/hook.mjs`
- Modify: `scripts/cli.mjs` (route `hook`)
- Test: `test/hooks-drill.test.mjs`

**Interfaces:**
- `augur hook pre` — stdin: the tool's JSON. Exit 0 = allowed; exit 2 + one line on stderr = refused.
- `augur hook post` — stdin: the tool's JSON. Saves the draft the edited file belongs to. Exit 0 silent; exit 2 + reason when the save was refused, there is no token, or the instance is unreachable.
- `augur hook install|remove|status` — the adapters on this machine.
- Env: `AUGUR_HOOKS_OFF=1` → both hooks exit 0 at once; `AUGUR_ADAPTER=<id>` picks the payload reader (default: the first row).

- [ ] **Step 1: Write the failing drill**

```js
// test/hooks-drill.test.mjs — the hook end to end: a refused write in a shared checkout, a
// refused write into a read-only copy, and an edit inside a draft folder that is live at
// the draft address before the hook returns.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startUnitServer } from "./fixtures/unit-server.mjs";
import { manifestOf, remember } from "./fixtures/unit-env.mjs";
import { unitClient, doOpen, readState } from "../scripts/lib/draft.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOOK = path.join(ROOT, "scripts", "hook.mjs");
const U = "/checkout/flow/";
const INDEX = remember("<h1>flow</h1>\n");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "augur-hooks-"));
const REGISTRY = path.join(tmp(), "drafts.json");
process.env.AUGUR_DRAFTS_REGISTRY = REGISTRY;

function hook(event, payload, env = {}) {
  const r = spawnSync(process.execPath, [HOOK, event], {
    input: JSON.stringify(payload), encoding: "utf8",
    env: { ...process.env, AUGUR_DRAFTS_REGISTRY: REGISTRY, AUGUR_NO_ADAPTERS: "1", ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test("pre: a prototype in a shared checkout is refused with the open command; the rest of the space is not", () => {
  const space = tmp();
  fs.writeFileSync(path.join(space, "space.json"), JSON.stringify({ id: "alpha" }));
  const proto = hook("pre", { tool_name: "Edit", tool_input: { file_path: path.join(space, "checkout", "prototypes", "flow", "index.html") }, cwd: space });
  assert.equal(proto.code, 2);
  assert.match(proto.err, /augur open checkout\/flow/);
  const tokens = hook("pre", { tool_name: "Edit", tool_input: { file_path: path.join(space, "tokens", "tokens.css") }, cwd: space });
  assert.equal(tokens.code, 0);
  assert.equal(tokens.err, "");
  const off = hook("pre", { tool_name: "Edit", tool_input: { file_path: path.join(space, "checkout", "prototypes", "flow", "index.html") }, cwd: space }, { AUGUR_HOOKS_OFF: "1" });
  assert.equal(off.code, 0, "AUGUR_HOOKS_OFF makes the hook inert");
  const garbage = spawnSync(process.execPath, [HOOK, "pre"], { input: "not json", encoding: "utf8", env: { ...process.env, AUGUR_DRAFTS_REGISTRY: REGISTRY } });
  assert.equal(garbage.status, 0, "an unreadable payload never blocks an editor");
});

test("post: an edit inside a draft folder is live at the draft address when the hook returns", async () => {
  const srv = await startUnitServer({ live: manifestOf(5, { [U]: { "index.html": INDEX } }), tenantId: "hooks-1" });
  try {
    const c = unitClient({ origin: srv.origin, token: "tok", space: "alpha", session: "s" });
    const dir = path.join(tmp(), "flow");
    const o = await doOpen({ client: c, unit: U, dir, origin: srv.origin, space: "alpha", session: "s", now: new Date().toISOString() });
    assert.equal(o.ok, true, JSON.stringify(o));
    const file = path.join(dir, "index.html");
    fs.writeFileSync(file, "<h1>Flow, from the hook</h1>\n");
    const r = hook("post", { tool_name: "Write", tool_input: { file_path: file }, cwd: dir }, { AUGUR_TOKEN: "tok" });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.err, "", "a successful save is silent");
    const live = await (await fetch(`${srv.origin}${readState(dir).address}`)).text();
    assert.equal(live, "<h1>Flow, from the hook</h1>\n");
    // A write INSIDE the draft folder passes the pre hook too.
    assert.equal(hook("pre", { tool_input: { file_path: file }, cwd: dir }).code, 0);
    // Without a token the hook says so, and says how, rather than pretending it saved.
    fs.writeFileSync(file, "<h1>again</h1>\n");
    const noToken = hook("post", { tool_input: { file_path: file }, cwd: dir }, { AUGUR_TOKEN: "" , AUGUR_ORIGIN: "" });
    assert.equal(noToken.code, 2);
    assert.match(noToken.err, /augur connect/);
    // Off the instance: refused with the reason, and the draft is not lost — the next save carries it.
    await srv.close();
    const offline = hook("post", { tool_input: { file_path: file }, cwd: dir }, { AUGUR_TOKEN: "tok" });
    assert.equal(offline.code, 2);
    assert.match(offline.err, /not saved/);
  } finally { try { await srv.close(); } catch (e) { /* closed above */ } }
});

test("post: an edit outside every draft is nobody's business", () => {
  const r = hook("post", { tool_input: { file_path: path.join(tmp(), "notes.md") }, cwd: "/" });
  assert.equal(r.code, 0);
  assert.equal(r.err, "");
});
```

The no-token case needs `resolveToken` to find nothing: the test's env clears `AUGUR_TOKEN`; the engine's `.env.deploy` on a developer machine may hold one, and `~/.config/augur/tokens.json` may too. So the hook script reads the token through a small seam: `AUGUR_TOKEN` when set (even to the empty string, meaning none), else `resolveToken`. Assert accordingly (see Step 3).

- [ ] **Step 2: Run** → FAIL (no `scripts/hook.mjs`).

- [ ] **Step 3: Write the command**

```js
#!/usr/bin/env node
// augur hook <pre|post|install|remove|status>
//
// `pre` and `post` are what an agent tool runs around every file edit, with the tool's own
// JSON on stdin (docs/drafts-that-land.md §7). Both answer with an exit code: 0 lets the
// edit through, 2 refuses it and puts one sentence on stderr for the agent to read in its
// next tool result. NOTHING ELSE EXITS NON-ZERO: an unreadable payload, a missing
// registry, an exception — every accident exits 0 and says nothing, because the hook is
// installed machine-wide and a bug here would take every editor down with it.
//
//   pre    refuse a write into a read-only copy, or into a shared checkout's prototype
//   post   save the draft the edited file belongs to; refused saves fail with the reason
//
// `install|remove|status` manage the adapters — `augur open` installs them once.
import fs from "node:fs";
import path from "node:path";
import { ADAPTERS, denyDecision, saveDecision, installAdapters, removeAdapters } from "./lib/adapters.mjs";
import { registryList, readState, unitClient, doSave } from "./lib/draft.mjs";
import { resolveToken } from "./lib/store.mjs";

const event = process.argv[2];
const refuse = (m) => { process.stderr.write(m + "\n"); process.exit(2); };

if (event === "install" || event === "remove" || event === "status") {
  const rows = event === "install" ? installAdapters() : event === "remove" ? removeAdapters() : installAdapters({ dryRun: true });
  for (const r of rows) console.log(`${r.name}: ${r.result}${r.path ? ` (${r.path})` : ""}`);
  process.exit(0);
}
if (event !== "pre" && event !== "post") {
  console.error("usage: augur hook <pre|post|install|remove|status>");
  process.exit(1);
}
if (process.env.AUGUR_HOOKS_OFF) process.exit(0);

let payload = null;
try { payload = JSON.parse(fs.readFileSync(0, "utf8")); } catch (e) { process.exit(0); }
const adapter = ADAPTERS.find((a) => a.id === (process.env.AUGUR_ADAPTER || ADAPTERS[0].id)) || ADAPTERS[0];
let p;
try { p = adapter.payload(payload); } catch (e) { process.exit(0); }
let registry = [];
try { registry = registryList(); } catch (e) { registry = []; }

if (event === "pre") {
  let d;
  try { d = denyDecision({ filePath: p.filePath, cwd: p.cwd, registry }); } catch (e) { process.exit(0); }
  if (d && d.deny) refuse(d.reason);
  process.exit(0);
}

// post
let target;
try { target = saveDecision({ filePath: p.filePath, cwd: p.cwd, registry }); } catch (e) { process.exit(0); }
if (!target) process.exit(0);
const st = readState(target.dir);
if (!st) process.exit(0);
const origin = st.origin;
// `AUGUR_TOKEN` set — even to nothing — is the answer; otherwise the saved tokens.
const token = process.env.AUGUR_TOKEN !== undefined ? process.env.AUGUR_TOKEN : resolveToken(origin);
if (!token) refuse(`draft ${st.draftId} not saved: no publish token for ${origin} — run augur connect once, then save with augur save.`);
const client = unitClient({ origin, token, space: st.space, session: st.session });
const r = await doSave({ client, dir: target.dir });
if (r.ok) process.exit(0);
if (r.error === "stale-draft" || r.error === "stale-draft-revision") refuse(`draft ${st.draftId} not saved: it moved under you (another process saved to it) — run augur sync, then augur save.`);
if (r.error === "network") refuse(`draft ${st.draftId} not saved: ${origin} is unreachable (${r.message}). Nothing is lost — the next save carries every change since.`);
refuse(`draft ${st.draftId} not saved: ${r.error || r.status}${r.reason ? ` (${r.reason})` : ""}. Fix it and run augur save.`);
```

`installAdapters({dryRun: true})` for `status`: add `dryRun` to `applyToAdapters` in Task 1's module — when set, never write, and report what WOULD happen (`"installed"`/`"updated"`/`"unchanged"`/`"absent"`). Add to the Task 1 module:

```js
function applyToAdapters({ home = os.homedir(), dryRun = false } = {}, decide) {
  …
    if (r.changed && !dryRun) writeJson(p, r.settings);
  …
}
export function installAdapters(opts = {}) { … }  // unchanged: passes opts through
```

In `scripts/cli.mjs` add `hook: "hook.mjs",` under the drafts block and `hook` to the usage line.

- [ ] **Step 4: Run** `node --test test/hooks-drill.test.mjs test/adapters.test.mjs` → PASS.
- [ ] **Step 5: Commit** — `cli: augur hook — refuse a write outside a draft, save the draft after one`.

---

### Task 3: `read`, `watch`, closing a read copy, the drafts report

**Files:**
- Modify: `scripts/lib/draft.mjs`
- Create: `scripts/read.mjs`, `scripts/watch.mjs`
- Modify: `scripts/close.mjs`, `scripts/status.mjs`, `scripts/cli.mjs`
- Test: `test/draft-tools.test.mjs`

**Interfaces:**
- Client gains `main: (unit) => get("main", unit)` → `{revision, table}`.
- `doRead({client, unit, dir, origin, now}) → {ok, files, dir}` — materialises main read-only (files mode 0o444) into `dir`, registers `{dir, unit, origin, readOnly: true, openedAt}`. Refuses a non-empty folder (`folder-not-empty`).
- `doClose` — a registered read-only copy (no `.augur/draft.json`) is removed and unregistered, `{ok: true, readOnly: true}`.
- `watchFolder(dir, onSettle, {debounceMs = 300}) → {close}` — one `onSettle()` per burst of changes, `.augur/` ignored.
- `draftsReport(entries, presenceByUnit) → string[]` — one line per open draft on this machine, with who else is on that unit.
- `readDirFor(unit) → "_read/<segments>"`.

- [ ] **Step 1: Write the failing tests**

```js
// test/draft-tools.test.mjs — read-only copies, the watch loop, closing a copy, the report.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { doRead, doClose, watchFolder, draftsReport, readDirFor, registryList, mimeOf } from "../scripts/lib/draft.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "augur-tools-"));
process.env.AUGUR_DRAFTS_REGISTRY = path.join(tmp(), "drafts.json");
const U = "/checkout/flow/";

function fakeMain(files) {
  const blobs = new Map(), table = {};
  for (const [rel, body] of Object.entries(files)) { blobs.set(sha(body), body); table[U + rel] = { h: sha(body), ct: mimeOf(rel), s: body.length }; }
  return { async main() { return { revision: 3, table }; }, async blobGet(h) { return Buffer.from(blobs.get(h)); } };
}

test("read materialises the unit read-only and registers the copy; close removes both", async () => {
  const root = tmp();
  const dir = path.join(root, readDirFor(U));
  assert.equal(readDirFor(U), path.join("_read", "checkout", "flow"));
  const r = await doRead({ client: fakeMain({ "index.html": "<h1>flow</h1>", "css/a.css": "h1{}" }), unit: U, dir, origin: "https://x.test", now: "2026-09-06T10:00:00.000Z" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.files, 2);
  assert.equal(fs.readFileSync(path.join(dir, "css", "a.css"), "utf8"), "h1{}");
  assert.equal(fs.statSync(path.join(dir, "index.html")).mode & 0o222, 0, "no write bit for anybody");
  assert.equal(fs.existsSync(path.join(dir, ".augur")), false, "a copy is not a draft");
  const reg = registryList().find((e) => e.dir === dir);
  assert.equal(reg.readOnly, true);
  assert.equal(reg.unit, U);
  const again = await doRead({ client: fakeMain({ "index.html": "x" }), unit: U, dir, origin: "https://x.test", now: "" });
  assert.equal(again.error, "folder-not-empty");
  const c = await doClose({ client: {}, dir, discard: false });
  assert.deepEqual(c, { ok: true, readOnly: true });
  assert.equal(fs.existsSync(dir), false);
  assert.equal(registryList().some((e) => e.dir === dir), false);
});

test("watchFolder settles a burst of edits into one call, and ignores .augur", async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, ".augur"));
  let calls = 0;
  const w = watchFolder(dir, () => { calls++; }, { debounceMs: 120 });
  try {
    await new Promise((r) => setTimeout(r, 100));
    fs.writeFileSync(path.join(dir, "a.html"), "a");
    fs.writeFileSync(path.join(dir, "b.html"), "b");
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(calls, 1, "two writes inside the window are one save");
    fs.writeFileSync(path.join(dir, ".augur", "draft.json"), "{}");
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(calls, 1, "the state file is not an edit");
  } finally { w.close(); }
});

test("draftsReport says what is open here and who else is on it", () => {
  const lines = draftsReport(
    [{ dir: "/w/flow", unit: U, draftId: "k7f3q1", origin: "https://x.test", openedAt: "2026-09-06T10:00:00.000Z" }],
    { [U]: [{ id: "k7f3q1", session: "mine", active: true }, { id: "zzzzzz", session: "pass two", name: "Ada", active: false }] },
  );
  assert.equal(lines.length, 2);
  assert.match(lines[0], /checkout\/flow/);
  assert.match(lines[0], /k7f3q1/);
  assert.match(lines[0], /\/w\/flow/);
  assert.match(lines[1], /Ada · pass two \(idle\)/);
  assert.deepEqual(draftsReport([], {}), []);
});
```

- [ ] **Step 2: Run** → FAIL (`doRead` not exported).

- [ ] **Step 3: Write the library additions**

In `scripts/lib/draft.mjs`, the client gains `main`:

```js
    sync: (b) => post("sync", b), discard: (b) => post("discard", b), presence: (unit) => get("presence", unit),
    main: (unit) => get("main", unit),
```

Add after `doCloseImpl`:

```js
// ── read-only copies (§7 `read`) ─────────────────────────────────────────────
// A unit materialised for CONTEXT, not for editing: beside the draft folders under `_read/`,
// files with no write bit, and a registry row the deny hook reads so an editor that ignores
// the mode is refused with the reason. No `.augur/draft.json` — a copy is not a draft.
export const READ_DIR = "_read";
export const readDirFor = (unit) => path.join(READ_DIR, ...unit.split("/").filter(Boolean));

async function doReadImpl({ client, unit, dir, origin, now }) {
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) return { ok: false, error: "folder-not-empty", dir };
  const m = await client.main(unit);
  if (m.status) return { ok: false, ...m };
  fs.mkdirSync(dir, { recursive: true });
  await materialise(client, unit, m.table || {}, dir);
  for (const p of Object.keys(m.table || {})) fs.chmodSync(path.join(dir, relOf(unit, p)), 0o444);
  registryAdd({ dir, unit, origin, readOnly: true, openedAt: now, revision: m.revision });
  return { ok: true, dir, files: Object.keys(m.table || {}).length, revision: m.revision };
}
export const doRead = guarded(doReadImpl);

// ── the watch loop (§7 `watch`) ──────────────────────────────────────────────
// For people editing by hand in an editor that runs no hooks: every burst of changes is one
// save. `fs.watch` with `recursive` is what every platform this repo supports offers; the
// state file's own writes are ignored or a save would trigger the next.
export function watchFolder(dir, onSettle, { debounceMs = 300 } = {}) {
  let timer = null;
  const watcher = fs.watch(dir, { recursive: true }, (_ev, name) => {
    const rel = String(name || "");
    if (rel === ".augur" || rel.startsWith(".augur" + path.sep) || rel.startsWith(".augur/")) return;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; onSettle(); }, debounceMs);
  });
  return { close() { clearTimeout(timer); watcher.close(); } };
}

// ── what is open on this machine (§4 `status`) ───────────────────────────────
export function draftsReport(entries, presenceByUnit = {}) {
  const out = [];
  for (const e of entries || []) {
    if (!e || e.readOnly) continue;
    out.push(`${e.unit.replace(/^\/|\/$/g, "")}  draft ${e.draftId}  ${e.dir}`);
    for (const d of presenceByUnit[e.unit] || []) {
      if (d.id === e.draftId) continue;
      out.push(`    also here: ${d.name ? d.name + " · " : ""}${d.session || "someone"} (${d.active ? "active" : "idle"})`);
    }
  }
  return out;
}
```

And `doCloseImpl` closes a read copy — replace its first two lines:

```js
async function doCloseImpl({ client, dir, discard }) {
  const st = readState(dir);
  if (!st) {
    const copy = registryList().find((e) => e.readOnly && path.resolve(e.dir) === path.resolve(dir));
    if (!copy) return { ok: false, error: "not-a-draft", dir };
    registryRemove(copy.dir);
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true, readOnly: true };
  }
```

- [ ] **Step 4: Write the entry points**

`scripts/read.mjs`:

```js
#!/usr/bin/env node
// augur read <prototype> [--dir <folder>] — a read-only copy of a unit, for context. Lands
// under _read/<unit>/ beside the draft folders; files carry no write bit and the deny hook
// refuses edits there. `augur close` inside it removes it. See docs/drafts-that-land.md §7.
import path from "node:path";
import { target } from "./lib/store.mjs";
import { markPathFor } from "./lib/marks.mjs";
import { unitClient, doRead, readDirFor } from "./lib/draft.mjs";
import { normUnit } from "../src/unit-core.mjs";

const log = (m) => console.error(`\x1b[35m[read]\x1b[0m ${m}`);
const die = (m) => { console.error(`\x1b[31m[read]\x1b[0m ${m}`); process.exit(1); };
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : null; };
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
const raw = positional[0];
if (!raw) die("name a prototype: `augur read <opportunity>/<prototype>`.");
const unit = normUnit(markPathFor(raw) || raw);
if (!unit) die(`"${raw}" is not a prototype path.`);
let origin, token;
try { ({ origin, token } = target({ needToken: true })); } catch (e) { die(e.message); }
const dir = path.resolve(opt("--dir") || readDirFor(unit));
const client = unitClient({ origin, token, space: "", session: "" });
const r = await doRead({ client, unit, dir, origin, now: new Date().toISOString() });
if (!r.ok) {
  if (r.error === "folder-not-empty") die(`${r.dir} is not empty — pick another folder with --dir.`);
  if (r.error === "units-not-configured") die("this instance does not serve drafts yet (no unit store bound).");
  die(`could not read: ${r.error || r.status}${r.reason ? ` (${r.reason})` : ""}`);
}
log(`${r.files} file(s) of ${unit} at revision ${r.revision}, read-only`);
console.log(dir);
```

`scripts/watch.mjs`:

```js
#!/usr/bin/env node
// augur watch — save this draft folder on every burst of changes, until Ctrl-C. For people
// editing by hand in an editor that runs no hooks. See docs/drafts-that-land.md §7.
import { resolveOrigin, resolveToken } from "./lib/store.mjs";
import { readState, unitClient, doSave, watchFolder } from "./lib/draft.mjs";

const log = (m) => console.error(`\x1b[35m[watch]\x1b[0m ${m}`);
const die = (m) => { console.error(`\x1b[31m[watch]\x1b[0m ${m}`); process.exit(1); };
const dir = process.cwd();
const st = readState(dir);
if (!st) die("not a draft folder — run `augur open <prototype>` first.");
const origin = st.origin || resolveOrigin();
const token = resolveToken(origin);
if (!token) die("no publish token — run `augur connect` once.");
const client = unitClient({ origin, token, space: st.space, session: st.session });
let running = false, again = false;
async function save() {
  if (running) { again = true; return; }
  running = true;
  try {
    const r = await doSave({ client, dir });
    if (!r.ok) log(`save refused: ${r.error || r.status}${r.error === "stale-draft" ? " — run `augur sync`" : ""}`);
    else if (r.changed.length) log(`${r.changed.length} file(s) live at ${origin}${st.address}`);
  } finally {
    running = false;
    if (again) { again = false; save(); }
  }
}
log(`watching ${dir} — live at ${origin}${st.address} (Ctrl-C to stop)`);
const w = watchFolder(dir, save);
process.on("SIGINT", () => { w.close(); process.exit(0); });
await save();
```

`scripts/close.mjs` — the two lines that read state and die become:

```js
const st = readState(dir);
if (!st) {
  // A read-only copy has no state file; doClose recognises it from the registry.
  process.chdir("..");
  const r = await doClose({ client: {}, dir, discard: false });
  if (!r.ok) die("not a draft folder — nothing to close here.");
  log("read-only copy removed");
  process.exit(0);
}
```

`scripts/status.mjs` — append at the end of the file (after the drift loop, before the exit code):

```js
// ── drafts open on this machine (docs/drafts-that-land.md §4) ────────────────
{
  const mine = registryList().filter((e) => !e.readOnly);
  if (mine.length) {
    console.log("");
    console.log("Drafts open on this machine");
    const presence = {};
    for (const unit of new Set(mine.map((e) => e.unit))) {
      const e = mine.find((x) => x.unit === unit);
      const tok = resolveToken(e.origin);
      if (!tok) continue;
      try {
        const p = await unitClient({ origin: e.origin, token: tok, space: "", session: "" }).presence(unit);
        if (p && p.drafts) presence[unit] = p.drafts;
      } catch (e2) { /* the report stands without presence */ }
    }
    for (const line of draftsReport(mine, presence)) console.log("  " + line);
  }
}
```

with the import `import { registryList, unitClient, draftsReport } from "./lib/draft.mjs";` at the top. Place it before whatever `process.exit(problems ? 1 : 0)` the script ends with (read the tail first).

`scripts/cli.mjs` — add `read: "read.mjs", watch: "watch.mjs",` beside `close`, and `read`, `watch`, `hook` to the usage line and the header comment.

- [ ] **Step 5: Run** `node --test test/draft-tools.test.mjs test/draft-lib.test.mjs test/draft-cli.test.mjs` → PASS.
- [ ] **Step 6: Commit** — `cli: read, watch, closing a read-only copy, and status lists this machine's drafts`.

---

### Task 4: `augur open` installs the adapters, once

**Files:**
- Modify: `scripts/open.mjs`
- Test: `test/draft-cli.test.mjs` (extend — read it first; it drives the entry points as child processes)

- [ ] **Step 1: The change**

After a successful open in `scripts/open.mjs`, before the presence lines:

```js
// The agent tool's hooks, installed for this machine the first time a draft is opened
// here (idempotent; `AUGUR_NO_ADAPTERS=1` skips it — the suite and CI set it).
if (!process.env.AUGUR_NO_ADAPTERS) {
  for (const a of installAdapters()) {
    if (a.result === "installed") log(`${a.name}: editor hooks installed (${a.path}) — edits in a draft folder save on their own; edits to a shared checkout's prototypes are refused.`);
    else if (a.result === "updated") log(`${a.name}: editor hooks updated (${a.path}).`);
  }
}
```

with `import { installAdapters } from "./lib/adapters.mjs";`.

- [ ] **Step 2: The test**

Add to `test/draft-cli.test.mjs` a case that runs `scripts/open.mjs` against the unit-server fixture with `HOME` pointed at a temp folder holding `.claude/` and WITHOUT `AUGUR_NO_ADAPTERS`, and asserts `HOME/.claude/settings.json` gained the two hooks; then runs it again with `AUGUR_NO_ADAPTERS=1` into a temp HOME and asserts nothing was written. Follow the file's existing pattern for spawning the entry point (env: `AUGUR_ORIGIN`, `AUGUR_TOKEN`, `AUGUR_DRAFTS_REGISTRY`).

- [ ] **Step 3: Run** `npm test && npm run check` → green. **Commit** — `cli: open installs the editor hooks for this machine, once`.

---

### Task 5: The spec's §7 says what was built

- [ ] In `docs/drafts-that-land.md` §7, the **Adapters** bullet gains one sentence after "Adding a tool is adding a row.": *"The deny is narrow: a write is refused only inside a read-only copy, or inside a shared checkout under a prototype's home that is not an open draft folder — a space's design system, its research and everything off the space are untouched. `AUGUR_HOOKS_OFF=1` makes both hooks inert; `augur hook install|remove|status` manages them by hand."*
- [ ] `npm run check`; commit — `Design: drafts that land — the adapter's deny rule as built`.

## Manual verify (on a real instance with `UNITS` bound)

1. In a fresh terminal in a space checkout: `augur open <opp>/<proto>`. Expect the "editor hooks installed" line once; `cat ~/.claude/settings.json` shows two `augur hook` entries beside your existing hooks.
2. Start an agent session in that checkout. Ask it to edit a file inside the draft folder: the draft address shows the change before the agent's next tool call. Ask it to edit the same prototype's file in the checkout itself: the tool result carries the refusal naming `augur open`.
3. `augur read <other-opp>/<other-proto>`; ask the agent to edit a file under `_read/`: refused. `cd _read/<…> && augur close` removes it.
4. In the draft folder, `augur watch`; edit two files by hand within a second: one "2 file(s) live" line.
5. `augur status` from anywhere: the drafts section lists the draft, and a second terminal's draft on the same unit appears under it as "also here".
6. `augur hook remove`: the entries are gone, everything else in settings.json intact.
