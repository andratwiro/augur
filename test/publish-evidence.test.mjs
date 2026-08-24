// Git evidence for composed publish: porcelain and provable-ancestor diffs make
// editedUnits; a clean live base in my history makes ffUnits; deletions need the
// folder to have existed at a provable base. Runs against a throwaway repo.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectEvidence, unitOfRepoPath } from "../scripts/lib/publish-evidence.mjs";

let dir, baseSha, headSha;
const git = (...a) => execFileSync("git", ["-C", dir, ...a], {
  encoding: "utf8",
  env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" },
}).trim();
const put = (rel, content) => {
  const p = path.join(dir, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
};

before(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "augur-evidence-"));
  git("init", "-q");
  put("toolkit/prototypes/map/index.html", "v1");
  put("toolkit/prototypes/gone/index.html", "old");
  put("playground/board/index.html", "v1");
  put("skills/ui/a.css", "v1");
  git("add", "-A"); git("commit", "-qm", "base");
  baseSha = git("rev-parse", "HEAD");
  // committed edit to map + delete gone, on top of the base
  put("toolkit/prototypes/map/index.html", "v2");
  git("rm", "-rq", "toolkit/prototypes/gone");
  git("add", "-A"); git("commit", "-qm", "edit map, delete gone");
  headSha = git("rev-parse", "HEAD");
  // uncommitted (porcelain) edit to board
  put("playground/board/index.html", "v2-dirty");
});
after(() => rmSync(dir, { recursive: true, force: true }));

const entry = { h: "0".repeat(64), ct: "text/html", s: 1 };
const maniFor = (prefixes, source, unitSources) => ({
  files: Object.fromEntries(prefixes.map((u) => [`${u}index.html`, entry])),
  routing: { publicPrefixes: prefixes, ...(unitSources ? { unitSources } : {}) },
  ...(source ? { source } : {}),
});

test("unitOfRepoPath inverts repo paths to unit URLs", () => {
  assert.equal(unitOfRepoPath("toolkit/prototypes/map/index.html", ""), "/toolkit/map/");
  assert.equal(unitOfRepoPath("playground/board/app.js", ""), "/playground/board/");
  assert.equal(unitOfRepoPath("skills/ui/a.css", ""), null);
  assert.equal(unitOfRepoPath("playground/board/x.js", "/beta"), "/beta/playground/board/");
});

test("porcelain makes edited+dirty; ancestor diff makes edited; clean ancestor makes ff", () => {
  const prefixes = ["/toolkit/map/", "/playground/board/", "/toolkit/gone/"];
  const live = maniFor(prefixes, { sha: baseSha, dirty: true }, {
    // map's live base: the clean base commit, in my history → committed diff counts
    "/toolkit/map/": { sha: baseSha, dirty: true },   // dirty → not FF, but diffable
    "/playground/board/": { sha: headSha, dirty: false }, // clean + ancestor → FF
  });
  const mine = maniFor(["/toolkit/map/", "/playground/board/"], null);
  const ev = collectEvidence({ sourceDir: dir, spaceBase: "", mine, live });
  assert.ok(ev.editedUnits.has("/playground/board/"), "porcelain edit is evidence");
  assert.ok(ev.dirtyUnits.has("/playground/board/"));
  assert.ok(ev.editedUnits.has("/toolkit/map/"), "committed edit vs provable ancestor is evidence");
  assert.equal(ev.dirtyUnits.has("/toolkit/map/"), false);
  assert.ok(ev.ffUnits.has("/playground/board/"), "clean ancestor base → fast-forward");
  assert.equal(ev.ffUnits.has("/toolkit/map/"), false, "dirty live base is never a fast-forward");
});

test("a deletion is evidence only when the folder existed at a provable ancestor base", () => {
  const live = maniFor(["/toolkit/gone/", "/toolkit/never-here/"], { sha: baseSha, dirty: false });
  const mine = maniFor([], null);
  const ev = collectEvidence({ sourceDir: dir, spaceBase: "", mine, live });
  assert.ok(ev.deletedUnits.has("/toolkit/gone/"), "existed at base, gone from tree → provable deletion");
  assert.equal(ev.deletedUnits.has("/toolkit/never-here/"), false,
    "a unit this repo never held is NOT my deletion");
});

test("an unknowable base yields porcelain-only evidence — fail closed, not sprawl", () => {
  const live = maniFor(["/toolkit/map/", "/playground/board/"], { sha: "f".repeat(40), dirty: false });
  const mine = maniFor(["/toolkit/map/", "/playground/board/"], null);
  const ev = collectEvidence({ sourceDir: dir, spaceBase: "", mine, live });
  assert.equal(ev.ffUnits.size, 0);
  assert.equal(ev.editedUnits.has("/toolkit/map/"), false,
    "committed work does NOT count against an unprovable base");
  assert.ok(ev.editedUnits.has("/playground/board/"), "porcelain still counts");
});

test("skill file evidence: clean provable space base → committed skill diffs count", () => {
  put("skills/ui/a.css", "v2"); git("add", "-A"); git("commit", "-qm", "skill edit");
  const live = maniFor([], { sha: baseSha, dirty: false });
  live.routing.publicSkillPrefixes = ["/skills/ui/"];
  const mine = maniFor([], null);
  const ev = collectEvidence({ sourceDir: dir, spaceBase: "", mine, live });
  assert.ok(ev.editedPaths.has("/skills/ui/a.css"));
});
