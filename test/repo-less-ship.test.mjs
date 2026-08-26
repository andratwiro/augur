// `augur ship` in a folder that is not a repository.
//
// `C-repo-less-ship`. "Repo-less multi-editor at v1, not phase two" is settled: a hosted
// workspace may never have a git repo, and `augur clone` already produces a folder with no
// `.git` in it ON PURPOSE. Until now the first thing ship.mjs did after resolving the
// workspace was `git rev-parse`, so shipping such a folder died with an uncaught
// `execFileSync` throw — a stack trace, out of the one command a person is told always works.
//
// ⚠️ WHAT MATTERS IS NOT THE CRASH, IT IS THE SECOND CODE PATH. The easy repair is a
// try/catch that skips the git bits, and it would quietly drop the guarantee git was
// providing: that a concurrent edit gets RESOLVED rather than overwritten. Without a repo
// there is no evidence to resolve from, so the equivalent guarantee has to come from the
// store — `--fork-on-conflict`, which is `C-fork-on-conflict` — and the folder then pulls
// live back so it does not diverge. Same event, same vocabulary, same outcome, one path.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SHIP = path.join(ROOT, "scripts", "ship.mjs");
const SRC = fs.readFileSync(SHIP, "utf8");

const run = (argv, cwd, env = {}) => new Promise((resolve) => {
  execFile(process.execPath, [SHIP, ...argv], { cwd, env: { ...process.env, ...env } },
    (err, stdout, stderr) => resolve({ code: err ? err.code || 1 : 0, out: `${stdout}${stderr}` }));
});

/** A workspace folder with a space.json, one prototype, and NO .git. */
function repoLessSpace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "augur-repoless-"));
  fs.writeFileSync(path.join(dir, "space.json"),
    JSON.stringify({ id: "alpha", name: "Alpha", default: true, siteOrigin: "http://127.0.0.1:1" }));
  fs.mkdirSync(path.join(dir, "toolkit", "prototypes", "map"), { recursive: true });
  fs.writeFileSync(path.join(dir, "toolkit", "prototypes", "map", "index.html"), "<h1>map</h1>");
  return dir;
}

test("⚠️ SHIPPING A FOLDER WITH NO .git DOES NOT CRASH — it publishes", async () => {
  // The failure being closed: `git rev-parse` threw out of execFileSync before anything
  // else ran, so the whole command died with a stack trace and no explanation.
  const dir = repoLessSpace();
  try {
    const r = await run(["--dry-run"], dir);
    assert.ok(!/rev-parse|ENOENT|execFileSync|not a git repository/i.test(r.out),
      `git leaked out of the repo-less path:\n${r.out}`);
    assert.match(r.out, /no git here/i, "it did not say why it is not committing");
    assert.equal(r.code, 0, r.out);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("it does not offer git advice about a repo that does not exist", async () => {
  const dir = repoLessSpace();
  try {
    const r = await run(["--dry-run"], dir);
    for (const phrase of ["would push", "git push", "GitHub does not know", "reconcil"]) {
      assert.ok(!r.out.toLowerCase().includes(phrase.toLowerCase()),
        `the repo-less path said "${phrase}":\n${r.out}`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("A REAL REPO STILL TAKES THE GIT PATH, unchanged", async () => {
  const dir = repoLessSpace();
  try {
    execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
    execFileSync("git", ["-C", dir, "config", "user.email", "someone@example.test"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "Someone"]);
    execFileSync("git", ["-C", dir, "add", "-A"]);
    execFileSync("git", ["-C", dir, "commit", "-qm", "first"]);
    const r = await run(["--dry-run"], dir);
    assert.ok(!/no git here/i.test(r.out), "a real repo took the repo-less path");
    assert.match(r.out, /would push|would fetch/i, "the git path stopped doing git things");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── the guarantee that has to survive the missing repo ──────────────────────────────

test("⚠️ WITHOUT GIT IT ASKS THE STORE TO RESOLVE A CONFLICT — the same event, one vocabulary", () => {
  // A concurrent edit must not become "last publish wins" just because this folder has no
  // history. With a repo the decision stays local, where the evidence is; without one it
  // goes to the store, which has the base manifest to diff against.
  const block = SRC.slice(SRC.indexOf("async function publish()"), SRC.indexOf("// ── 2.5"));
  assert.match(block, /--fork-on-conflict/);
  assert.match(block, /HAS_GIT \? \[\] : \["--fork-on-conflict"\]/,
    "the flag is not conditional on the absence of git");
});

test("and it folds live back into the folder afterwards, three-way rather than overwriting", () => {
  // Live now has somebody else's version at the canonical path and mine at a fork; this
  // folder still has mine at the canonical path. Left alone it diverges silently and the
  // next ship re-publishes the same contested bytes and forks again, forever.
  const block = SRC.slice(SRC.indexOf("// ── 2.5"), SRC.indexOf("// ── 3. push"));
  assert.match(block, /clone\.mjs/);
  assert.match(block, /AUGUR_CLONE_MODE: "pull"/);
  assert.match(block, /!HAS_GIT/);
  // A partial catch-up is a warning, never a failed ship: the publish already happened.
  assert.match(block, /code === 2/);
});

test("the pull is skipped on a dry run and on the git path", () => {
  const block = SRC.slice(SRC.indexOf("// ── 2.5"), SRC.indexOf("// ── 3. push"));
  assert.match(block, /if \(!HAS_GIT && !DRY\)/);
});

test("⚠️ `.git` IS CHECKED WITH existsSync, because a worktree and a submodule make it a FILE", () => {
  // Both are real repositories, and an isDirectory() check would send them down the
  // repo-less path — publishing without committing, in a folder whose whole point is that
  // it commits.
  assert.match(SRC, /const HAS_GIT = existsSync\(path\.join\(dir, "\.git"\)\)/);
  assert.match(SRC, /worktree and a\s*\/\/ submodule both make it a FILE/);
});

test("every git call on the ship path is guarded by HAS_GIT", () => {
  // The crash was one unguarded call. This is the check that a second one cannot appear
  // above the guard: nothing may call git() before HAS_GIT is defined.
  const guardAt = SRC.indexOf("const HAS_GIT =");
  assert.ok(guardAt > 0);
  const before = SRC.slice(0, guardAt);
  const calls = [...before.matchAll(/(?<![\w.])git\(/g)]
    // `const git = (...a) =>` and gitQuiet's `return { ok: true, out: git(...a) }` are the
    // declarations themselves, not calls on the ship path.
    .filter((m) => !before.slice(m.index).startsWith("git(...a)"));
  assert.deepEqual(calls.map((m) => before.slice(m.index, m.index + 30)), [],
    "something calls git() before the repo-less guard is decided");
});
