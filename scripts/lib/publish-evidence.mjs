// Git evidence for composed publish (protocol 5) — the impure half.
//
// composePublish (publish-compose.mjs) is pure; this module answers its three
// questions from the one source of truth we trust: git.
//
//   ffUnits       which units are a FAST-FORWARD of live — live's recorded unit
//                 source is a clean commit in this tree's history, so shipping my
//                 build cannot revert anyone (their content is already mine).
//   editedUnits   which units I have local evidence of editing: uncommitted paths
//                 (porcelain, untracked included) plus — when live's base is a
//                 provable ancestor — commits since that base. When the base is
//                 unknowable the answer degrades to porcelain only: fail CLOSED
//                 (my committed edit stays local with a note) rather than sprawl.
//   deletedUnits  live units provably deleted here: the folder existed at live's
//                 base, the base is my ancestor, and the folder is gone from the
//                 tree. Anything less keeps live's URLs up.
//
// Per-unit live provenance comes from routing.unitSources (written by every
// protocol-5 publish), falling back to the space-level manifest source for
// manifests that predate the field.
//
//   seed units    a live unit the PLATFORM wrote (provenance `isSeedSource`: the
//                 seed pack a fresh workspace arrives with) is nobody's work. Its
//                 recorded sha is an ENGINE commit no space repo has in its history,
//                 so to git it looks exactly like an unpushed stranger's commit — and
//                 a person's first edit to a start-here page was filed "unprovable"
//                 and quietly stayed local. It is NOT unprovable: the platform's
//                 provenance is a provenance. This module only declines to call it
//                 one; WHETHER IT YIELDS IS THE COMPOSER'S RULE (publish-compose.mjs),
//                 so the store, which runs the same composer with its own evidence,
//                 reaches the same verdict for a repo-less publisher.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { authoredUnits, unitPaths } from "./publish-compose.mjs";
import { repoDirCandidates } from "./publish-conflict.mjs";
import { isSeedSource } from "../../src/provenance.mjs";

const dec = (s) => { try { return decodeURIComponent(String(s)); } catch (e) { return String(s); } };

const gitq = (dir, ...a) => {
  try {
    return execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) { return null; }
};

export const isAncestor = (dir, sha) =>
  !!sha && gitq(dir, "merge-base", "--is-ancestor", sha, "HEAD") !== null;
const haveCommit = (dir, sha) => !!sha && gitq(dir, "cat-file", "-e", `${sha}^{commit}`) !== null;

// Repo path → the unit URL it belongs to (the inverse of the build's URL scheme:
// prototypes elide /prototypes/ on the URL side, playground does not).
export function unitOfRepoPath(repoPath, spaceBase = "") {
  const m = /^([^/]+)\/prototypes\/([^/]+)\//.exec(repoPath)
    || /^(playground)\/([^/]+)\//.exec(repoPath);
  if (!m) return null;
  const enc = encodeURIComponent;
  return m[1] === "playground"
    ? `${spaceBase}/playground/${enc(m[2])}/`
    : `${spaceBase}/${enc(m[1])}/${enc(m[2])}/`;
}

export function unitRepoDir(unit, spaceBase, sourceDir) {
  const candidates = repoDirCandidates(unit, { spaceBase });
  for (const c of candidates) if (existsSync(path.join(sourceDir, c))) return c;
  return candidates[0];
}

const porcelainPaths = (dir) => (gitq(dir, "status", "--porcelain") || "").split("\n")
  .filter(Boolean)
  .map((l) => l.slice(3).replace(/^"|"$/g, ""))
  .flatMap((p) => p.split(" -> ")); // renames evidence both sides

export function collectEvidence({ sourceDir, spaceBase, mine, live }) {
  const liveUnits = authoredUnits(live);
  const mineUnits = authoredUnits(mine);
  const unitSources = ((live || {}).routing || {}).unitSources || {};
  const spaceSrc = (live || {}).source || {};
  const srcOf = (u) => unitSources[u]
    || { sha: spaceSrc.sha || null, dirty: !!spaceSrc.dirty, actor: spaceSrc.actor, seed: spaceSrc.seed };

  const editedUnits = new Set();
  const dirtyUnits = new Set();
  const editedPaths = new Set();
  const unprovable = []; // committed-looking divergence we refused to ship — for one honest log line

  for (const rel of porcelainPaths(sourceDir)) {
    const u = unitOfRepoPath(rel, spaceBase);
    if (u) { editedUnits.add(u); dirtyUnits.add(u); }
    if (!spaceBase && rel.startsWith("skills/")) editedPaths.add("/" + rel);
  }

  const ffUnits = new Set();
  const ancestorCache = new Map();
  const provenAncestor = (sha) => {
    if (!sha) return false;
    if (!ancestorCache.has(sha)) ancestorCache.set(sha, haveCommit(sourceDir, sha) && isAncestor(sourceDir, sha));
    return ancestorCache.get(sha);
  };

  for (const u of new Set([...liveUnits, ...mineUnits])) {
    const src = srcOf(u);
    if (!src.dirty && provenAncestor(src.sha)) {
      ffUnits.add(u);
      continue; // FF ships regardless; no need to weigh evidence
    }
    if (editedUnits.has(u)) continue; // porcelain already says edited
    // Dirty-or-unknown live base: committed evidence only counts against a
    // provable ancestor (diffing against an unrelated commit would count THEIR
    // work as mine). Without one, a committed local edit stays local — noted.
    if (src.sha && provenAncestor(src.sha)) {
      const dirRel = unitRepoDir(u, spaceBase, sourceDir);
      const names = (gitq(sourceDir, "diff", "--name-only", src.sha, "HEAD", "--", dirRel) || "").trim();
      if (names) editedUnits.add(u);
    } else if (mineUnits.has(u) && liveUnits.has(u) && !isSeedSource(src)) {
      // The seed is excluded because its provenance is KNOWN — it is the platform's —
      // and the composer decides what that means. Everything else here is a stranger's.
      unprovable.push(u);
    }
  }

  // Skill files: committed evidence against the space-level base when provable.
  if (!spaceBase && spaceSrc.sha && !spaceSrc.dirty && provenAncestor(spaceSrc.sha)) {
    for (const rel of (gitq(sourceDir, "diff", "--name-only", spaceSrc.sha, "HEAD", "--", "skills") || "").split("\n")) {
      if (rel.trim()) editedPaths.add("/" + rel.trim());
    }
  }

  // Deletions: only what git can prove — existed at a provable ancestor base,
  // gone from the tree now.
  const deletedUnits = new Set();
  for (const u of liveUnits) {
    if (mineUnits.has(u)) continue;
    const src = srcOf(u);
    if (!provenAncestor(src.sha)) continue;
    const dirRel = unitRepoDir(u, spaceBase, sourceDir);
    if (existsSync(path.join(sourceDir, dirRel))) continue;
    const then = (gitq(sourceDir, "ls-tree", "-r", "--name-only", src.sha, "--", dirRel) || "").trim();
    if (then) deletedUnits.add(u);
  }

  return { editedUnits, dirtyUnits, deletedUnits, editedPaths, ffUnits, unprovable };
}
