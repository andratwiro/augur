// Is anybody still cutting tags?
//
// `D-12-release-train-tags`. Every instance on `TRACK: release` follows the newest GitHub
// release faithfully and forever. When tagging stops those instances do not break, do not
// warn and do not fall behind visibly — they keep auto-updating to the same old tag and
// reporting themselves healthy. Silent on the follower, invisible on the publisher.
//
// It has already happened twice here, so the guard is tested against synthetic repositories
// rather than against this one: a test that only asserts today's drift stops meaning
// anything the moment somebody cuts a tag.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const SCRIPT = fileURLToPath(new URL("../scripts/release-drift.mjs", import.meta.url));

/** A throwaway git repo with the given tags and a number of commits after the last one. */
function repo({ tags = [], commitsAfter = 0, tagDaysAgo = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-drift-"));
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.test",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.test",
    },
  });
  git("init", "-q", "-b", "main");
  const when = new Date(Date.now() - tagDaysAgo * 86_400_000).toISOString();
  fs.writeFileSync(path.join(dir, "f"), "0");
  git("add", "."); git("-c", "user.email=t@t.test", "-c", "user.name=t", "commit", "-q", "-m", "base", "--date", when);
  for (const t of tags) {
    fs.writeFileSync(path.join(dir, "f"), t);
    git("add", ".");
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", t, "--date", when], {
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.test", GIT_COMMITTER_DATE: when },
    });
    git("tag", t);
  }
  for (let i = 0; i < commitsAfter; i++) {
    fs.writeFileSync(path.join(dir, "f"), `after-${i}`);
    git("add", "."); git("-c", "user.email=t@t.test", "-c", "user.name=t", "commit", "-q", "-m", `after ${i}`);
  }
  return dir;
}

function run(dir, args = []) {
  // The script resolves ROOT from its own location, so copy it in beside a scripts/ dir.
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(dir, "scripts", "release-drift.mjs"));
  try {
    return { ok: true, out: execFileSync(process.execPath, [path.join(dir, "scripts", "release-drift.mjs"), ...args], { encoding: "utf8" }) };
  } catch (e) {
    return { ok: false, code: e.status, out: (e.stdout || "") + (e.stderr || "") };
  }
}

test("a fresh tag with a few commits after it is clean", () => {
  const d = repo({ tags: ["v1.0.0"], commitsAfter: 3, tagDaysAgo: 1 });
  try {
    const r = run(d);
    assert.equal(r.ok, true, r.out);
    assert.match(r.out, /OK/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("too many commits since the newest tag is flagged, with both numbers", () => {
  const d = repo({ tags: ["v1.0.0"], commitsAfter: 70, tagDaysAgo: 1 });
  try {
    const r = run(d, ["--max-commits", "60"]);
    assert.equal(r.ok, false);
    assert.match(r.out, /70 commits ahead of v1\.0\.0/);
    assert.match(r.out, /TRACK: release/, "the message does not say who is affected");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("an OLD tag is flagged even with almost nothing after it", () => {
  // The other half, and the one a commit-count check alone would miss: a quiet quarter
  // with six commits is still a quarter in which nobody cut a release.
  const d = repo({ tags: ["v1.0.0"], commitsAfter: 2, tagDaysAgo: 90 });
  try {
    const r = run(d, ["--max-age-days", "21"]);
    assert.equal(r.ok, false);
    assert.match(r.out, /no release cut in 9\d days/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("a repository with NO release tag is the loudest case, not a pass", () => {
  const d = repo({ tags: [], commitsAfter: 1 });
  try {
    const r = run(d);
    assert.equal(r.ok, false);
    assert.match(r.out, /NO RELEASE TAG/i);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("a non-release tag does NOT count as a release", () => {
  // This repository carries working tags — a backup point taken before a rebase, for
  // instance. Treating one as a release would report the drift closed on a tag no
  // self-hoster will ever be offered.
  const d = repo({ tags: ["v1.0.0", "phase-a-prerebase-backup"], commitsAfter: 70, tagDaysAgo: 1 });
  try {
    const r = run(d, ["--max-commits", "60"]);
    assert.equal(r.ok, false);
    assert.match(r.out, /v1\.0\.0/, "a working tag was mistaken for the newest release");
    assert.ok(!/prerebase/.test(r.out));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("it EXITS 2 when it cannot see, rather than reporting clean", () => {
  // A shallow clone has no tags and no history to count. A guard that reports success
  // precisely when it cannot look is worse than no guard.
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "release-drift-nogit-"));
  try {
    const r = run(d);
    assert.equal(r.ok, false);
    assert.equal(r.code, 2, `expected exit 2 for "cannot tell", got ${r.code}: ${r.out}`);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("--json carries the numbers a workflow would report", () => {
  const d = repo({ tags: ["v2.3.4"], commitsAfter: 5, tagDaysAgo: 2 });
  try {
    const r = run(d, ["--json"]);
    const j = JSON.parse(r.out);
    assert.equal(j.newest, "v2.3.4");
    assert.equal(j.ahead, 5);
    assert.equal(typeof j.ageDays, "number");
    assert.equal(j.ok, true);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("the workflow runs it with full history and tags", () => {
  // fetch-depth: 0 and fetch-tags. Without them the script exits 2 every week, and a
  // guard that always errors is a guard somebody switches off.
  const wf = fs.readFileSync(fileURLToPath(new URL("../.github/workflows/release-drift.yml", import.meta.url)), "utf8");
  assert.match(wf, /fetch-depth:\s*0/);
  assert.match(wf, /fetch-tags:\s*true/);
  assert.match(wf, /node scripts\/release-drift\.mjs/);
});
