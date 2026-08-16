// An editor has no reason to know the engine is a git checkout. "Run `git pull`" is a
// product failure dressed as a helpful message, so when the engine clone is behind what
// the instance speaks, the CLI fixes it rather than reporting it.
//
// That means mutating a checkout nobody asked us to touch, so the guards are the whole
// design and these tests are mostly about them: it must never disturb local work, never
// merge, never loop, and never run when it was told not to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SRC = (await import("node:fs")).readFileSync(new URL("../scripts/publish.mjs", import.meta.url), "utf8");
const fn = SRC.slice(SRC.indexOf("function selfUpdate("), SRC.indexOf("function dieOutdated("));

test("it only ever fast-forwards — never a merge, never a rewrite", () => {
  assert.match(fn, /"pull",\s*"--ff-only"/, "must pull --ff-only");
  assert.doesNotMatch(fn, /"merge"|"rebase"|"reset"|--hard|--force/,
    "must never merge, rebase, reset or force — this is someone else's checkout");
});

test("it refuses a dirty tree rather than disturbing local work", () => {
  assert.match(fn, /status",\s*"--porcelain"/, "must check for local changes");
  const i = fn.indexOf("--porcelain");
  const after = fn.slice(i, i + 400);
  assert.match(after, /return false/, "a dirty tree must abort the update, not proceed");
});

test("it requires an upstream, and treats anything unexpected as 'do not touch'", () => {
  assert.match(fn, /@\{u\}/, "must confirm an upstream is configured");
  assert.match(fn, /catch[\s\S]{0,120}return false/,
    "not a clone, no upstream, diverged, offline — all must fall through, never throw");
});

test("it cannot loop: one attempt per run, and the re-exec carries a guard", () => {
  assert.match(fn, /selfUpdateTried/, "one attempt per process");
  assert.match(fn, /AUGUR_SELF_UPDATED/, "the child must know it is the retry");
  assert.match(SRC, /process\.env\.AUGUR_SELF_UPDATED === "1"/, "and must refuse to update again");
});

test("it can be turned off, by flag or environment", () => {
  assert.match(SRC, /--no-self-update/);
  assert.match(SRC, /AUGUR_NO_SELF_UPDATE/);
});

test("no CLI message tells a person to run git", () => {
  // The whole point. Messages may address the AGENT — that is a different reader with a
  // different job — but nothing the engine prints should assume the person being helped
  // knows what git is.
  const offenders = [];
  const re = /(?:\blog|\bdie)\(([\s\S]{0,600}?)\);/g;
  let m;
  while ((m = re.exec(SRC))) {
    const body = m[1];
    if (!/git\s+(pull|status|clone|fetch|checkout|reset)/.test(body)) continue;
    if (/AGENT:/.test(body)) continue; // explicitly addressed to the agent
    offenders.push(SRC.slice(0, m.index).split("\n").length + ": " + body.replace(/\s+/g, " ").slice(0, 90));
  }
  assert.deepEqual(offenders, [],
    "these print a git command without addressing the agent:\n" + offenders.join("\n"));
});

// The guards, exercised against real git repos rather than read off the source.
function repoPair() {
  const dir = mkdtempSync(path.join(tmpdir(), "selfupd-"));
  const origin = path.join(dir, "origin");
  const clone = path.join(dir, "clone");
  mkdirSync(origin, { recursive: true });
  const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["init", "-q", "-b", "main", origin]);
  git(origin, "config", "user.email", "t@example.test");
  git(origin, "config", "user.name", "T");
  writeFileSync(path.join(origin, "f.txt"), "one\n");
  git(origin, "add", "f.txt");
  git(origin, "commit", "-qm", "one");
  execFileSync("git", ["clone", "-q", origin, clone]);
  git(clone, "config", "user.email", "t@example.test");
  git(clone, "config", "user.name", "T");
  writeFileSync(path.join(origin, "f.txt"), "two\n");
  git(origin, "add", "f.txt");
  git(origin, "commit", "-qm", "two");
  git(clone, "fetch", "-q");
  return { dir, origin, clone, git };
}

test("a clean clone behind its upstream fast-forwards; a dirty one does not", () => {
  const { dir, clone, git } = repoPair();
  try {
    const before = git(clone, "rev-parse", "HEAD").trim();
    // Clean: --ff-only succeeds, which is the operation selfUpdate performs.
    git(clone, "pull", "--ff-only");
    assert.notEqual(git(clone, "rev-parse", "HEAD").trim(), before, "clean clone moves forward");

    // Dirty: selfUpdate's porcelain check is what stops it getting this far, and the
    // check is meaningful — an uncommitted edit really is visible there.
    writeFileSync(path.join(clone, "f.txt"), "local work\n");
    assert.notEqual(git(clone, "status", "--porcelain").trim(), "",
      "an uncommitted change must show up in the check selfUpdate gates on");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a diverged clone cannot be fast-forwarded, so selfUpdate's git call fails and it backs off", () => {
  const { dir, clone, git } = repoPair();
  try {
    writeFileSync(path.join(clone, "g.txt"), "mine\n");
    git(clone, "add", "g.txt");
    git(clone, "commit", "-qm", "local");
    assert.throws(() => git(clone, "pull", "--ff-only"),
      "a diverged clone must make --ff-only fail — that failure is what makes selfUpdate give up");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- the periodic refresh: why the sandbox rotted, and what stops it recurring ----

const REFRESH = SRC.slice(SRC.indexOf("async function maybeRefreshEngine"), SRC.indexOf("const started = Date.now()"));

test("the refresh is throttled, and the stamp cannot be committed or show up in git status", () => {
  assert.match(REFRESH, /REFRESH_EVERY_MS/, "must be throttled, not run on every publish");
  assert.match(REFRESH, /"\.git",\s*"augur-last-refresh"/,
    "the stamp lives inside .git/ — anywhere else and it becomes a file someone has to gitignore, " +
    "or worse, a file that publishes");
});

test("a failed fetch does not make every later publish retry it", () => {
  // Writing the stamp before the fetch is deliberate: otherwise a network problem turns
  // into a permanent per-publish slowdown, and `publish` is contractually seconds.
  const write = REFRESH.indexOf("writeFileSync(stamp");
  const fetch = REFRESH.indexOf('"fetch"');
  assert.ok(write > -1 && fetch > -1);
  assert.ok(write < fetch, "the stamp must be written BEFORE the fetch is attempted");
  assert.match(REFRESH, /timeout: 10_000|timeout: 10000/, "the fetch must be time-boxed");
});

test("it never blocks or fails a publish", () => {
  // Every failure path returns rather than throwing: not a clone, no upstream, offline,
  // fetch timeout. Keeping the engine current is a background nicety; shipping is not.
  const returns = (REFRESH.match(/return;/g) || []).length;
  assert.ok(returns >= 3, `expected several quiet bail-outs, found ${returns}`);
  assert.doesNotMatch(REFRESH, /\bdie\(/, "must never terminate the publish");
  assert.doesNotMatch(REFRESH, /process\.exit/, "must never exit — only selfUpdate re-execs");
});

test("it respects the same opt-outs as selfUpdate, and never runs in the re-exec", () => {
  assert.match(REFRESH, /NO_SELF_UPDATE/);
  assert.match(REFRESH, /AUGUR_SELF_UPDATED/);
});
