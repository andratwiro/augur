// Reconcile residue is committed alone, marked Augur-Mechanical — never laundered.
//
// resolvePublish writes into the publisher's tree (adopted live folders, conflict
// forks). Left uncommitted, that residue rides into the publisher's NEXT real
// commit, and the build's date/credit pass then stamps their face and "edited just
// now" on every folder the reconcile touched (2026-08-19, twice: one adopt commit
// put one person on every project card site-wide). commitReconcileResidue is the
// fix: commit exactly the written paths, immediately, with the trailer the credit
// pass skips — and leave the publisher's own work-in-progress exactly as it was.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { commitReconcileResidue } from "../scripts/lib/publish-resolve.mjs";

const quiet = () => {};
const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "reconcile-mech-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "dev@example.test");
  git(dir, "config", "user.name", "Test Dev");
  const proto = path.join(dir, "demo", "prototypes", "hello");
  mkdirSync(proto, { recursive: true });
  writeFileSync(path.join(proto, "index.html"), "<title>mine</title>\n");
  writeFileSync(path.join(dir, "notes.md"), "wip\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}

test("residue commits alone, trailered; the publisher's own WIP stays put", () => {
  const dir = makeRepo();
  try {
    // The publisher's own in-flight work: one dirty file, one staged file.
    writeFileSync(path.join(dir, "notes.md"), "wip, edited but NOT part of the reconcile\n");
    writeFileSync(path.join(dir, "staged.md"), "already staged by the publisher\n");
    git(dir, "add", "--", "staged.md");
    // What a reconcile writes: adopted bytes over the canonical folder (with a
    // deletion inside it), plus a brand-new untracked fork folder.
    const canon = "demo/prototypes/hello";
    const fork = "demo/prototypes/hello-conflict-tester";
    writeFileSync(path.join(dir, canon, "index.html"), "<title>theirs, adopted</title>\n");
    writeFileSync(path.join(dir, canon, "extra.html"), "<title>survives</title>\n");
    mkdirSync(path.join(dir, fork), { recursive: true });
    writeFileSync(path.join(dir, fork, "index.html"), "<title>mine, forked</title>\n");
    writeFileSync(path.join(dir, fork, "CONFLICT.md"), "# Live edit conflict\n");

    const did = commitReconcileResidue({
      dir, id: "acme", log: quiet,
      resolution: { treePaths: [canon, fork], forks: [{ fork }] },
    });
    assert.equal(did, true, "a commit was made");

    const trailer = git(dir, "log", "-1", "--format=%(trailers:key=Augur-Mechanical,valueonly)").trim();
    assert.equal(trailer, "true", "the commit carries the Augur-Mechanical trailer");
    const files = git(dir, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean).sort();
    assert.deepEqual(files, [
      `${fork}/CONFLICT.md`, `${fork}/index.html`,
      `${canon}/extra.html`, `${canon}/index.html`,
    ].sort(), "exactly the residue paths — nothing of the publisher's own");
    // The publisher's WIP is exactly as they left it: dirty stays dirty, staged stays staged.
    const status = git(dir, "status", "--porcelain").split("\n").filter(Boolean).sort();
    assert.deepEqual(status, ["A  staged.md", " M notes.md"].sort());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("adoption that deletes a live-removed file commits the deletion too", () => {
  const dir = makeRepo();
  try {
    const canon = "demo/prototypes/hello";
    writeFileSync(path.join(dir, canon, "stale.html"), "<title>stale</title>\n");
    git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "stale page");
    rmSync(path.join(dir, canon, "stale.html")); // materializeUnit removes what live lacks
    const did = commitReconcileResidue({ dir, id: "acme", log: quiet, resolution: { treePaths: [canon], forks: [] } });
    assert.equal(did, true);
    const files = git(dir, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean);
    assert.deepEqual(files, [`${canon}/stale.html`], "the deletion is part of the mechanical commit");
    assert.equal(existsSync(path.join(dir, canon, "stale.html")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("no residue, no repo, or no actual change → no commit, returns false", () => {
  const dir = makeRepo();
  const bare = mkdtempSync(path.join(tmpdir(), "reconcile-norepo-"));
  try {
    const head = git(dir, "rev-parse", "HEAD").trim();
    assert.equal(commitReconcileResidue({ dir, id: "acme", log: quiet, resolution: { treePaths: [], forks: [] } }), false);
    // Paths named but bytes identical to HEAD — nothing staged, nothing committed.
    assert.equal(commitReconcileResidue({ dir, id: "acme", log: quiet,
      resolution: { treePaths: ["demo/prototypes/hello"], forks: [] } }), false);
    assert.equal(git(dir, "rev-parse", "HEAD").trim(), head, "HEAD did not move");
    assert.equal(commitReconcileResidue({ dir: bare, id: "acme", log: quiet,
      resolution: { treePaths: ["x"], forks: [] } }), false, "not a git tree — quietly skipped");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(bare, { recursive: true, force: true }); }
});
