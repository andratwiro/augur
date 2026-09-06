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
  const m1 = mergeHooks(theirs, "Write|Edit", { pre: 'node "/x/hook.mjs" pre', post: 'node "/x/hook.mjs" post' });
  assert.equal(m1.changed, true);
  assert.equal(m1.settings.other, 1);
  assert.equal(m1.settings.hooks.PreToolUse.length, 2, "theirs kept, ours added");
  assert.equal(m1.settings.hooks.PostToolUse.length, 1);
  assert.equal(m1.settings.hooks.Notification.length, 1);
  assert.deepEqual(m1.settings.hooks.PreToolUse[1], { matcher: "Write|Edit", hooks: [{ type: "command", command: 'node "/x/hook.mjs" pre' }] });
  const m2 = mergeHooks(m1.settings, "Write|Edit", { pre: 'node "/x/hook.mjs" pre', post: 'node "/x/hook.mjs" post' });
  assert.equal(m2.changed, false, "a second install changes nothing");
  assert.equal(m2.settings.hooks.PreToolUse.length, 2);
  const m3 = mergeHooks(m1.settings, "Write|Edit", { pre: 'node "/elsewhere/hook.mjs" pre', post: 'node "/elsewhere/hook.mjs" post' });
  assert.equal(m3.changed, true, "a moved engine updates the command in place");
  assert.equal(m3.settings.hooks.PreToolUse.length, 2);
  const s = stripHooks(m1.settings);
  assert.equal(s.changed, true);
  assert.deepEqual(s.settings.hooks, { PreToolUse: theirs.hooks.PreToolUse, Notification: theirs.hooks.Notification });
  assert.equal(stripHooks(theirs).changed, false);
  assert.equal(mergeHooks(undefined, "W", { pre: 'node "/x/hook.mjs" pre', post: 'node "/x/hook.mjs" post' }).settings.hooks.PreToolUse.length, 1, "no settings at all is fine");
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
  assert.deepEqual(installAdapters({ home, dryRun: true }).map((r) => r.result), ["unchanged"]);
  assert.deepEqual(removeAdapters({ home }).map((r) => r.result), ["removed"]);
  const after = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(Object.keys(after.hooks), ["Notification"]);
  assert.deepEqual(removeAdapters({ home }).map((r) => r.result), ["unchanged"]);
  // A tool folder with no settings file yet gets one holding only our hooks; a dry run does not.
  const home2 = tmp(); fs.mkdirSync(path.join(home2, ".claude"));
  assert.deepEqual(installAdapters({ home: home2, dryRun: true }).map((r) => r.result), ["installed"]);
  assert.equal(fs.existsSync(path.join(home2, ".claude", "settings.json")), false, "a dry run writes nothing");
  assert.deepEqual(installAdapters({ home: home2 }).map((r) => r.result), ["installed"]);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(home2, ".claude", "settings.json"), "utf8"))), ["hooks"]);
});
