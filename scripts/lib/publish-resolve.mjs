// Store-aware publish resolution — the impure half of publish-conflict.mjs.
//
// Called when a publish cannot prove it contains what is live (the live version
// is not an ancestor of this tree, or live was published from a working tree git
// never saw). It fetches the live manifest, classifies every difference, and
// resolves without asking:
//
//   adopt    their unit is newer / new → their files are written INTO this tree
//            (a git pull, but from the store), so this build and every later one
//            reproduces them. Nothing of mine is lost: my version is in my git.
//   fork     we both changed a unit → THEIRS keeps the real URL (shared links
//            stay true), MINE is copied to <folder>-conflict-<who> with a
//            CONFLICT.md, and the tree's original folder becomes theirs — the
//            same shape ship's git-side reconcile produces.
//   skills   a shared DS file has no folder to fork into: theirs ships, mine
//            stays in my tree, and the path is remembered as `unresolved` in the
//            publish cache so every later publish re-classifies instead of
//            quietly shipping my bytes back over theirs.
//   drops    their store-only deletion is NOT adopted — deleting files out of
//            someone's working tree is not this script's call. Mine re-ships it,
//            with a note saying whose deletion it just undid.
//
// Tree materialization is the load-bearing decision. Adopting only into the
// MANIFEST would leave tree ≠ live, and the very next publish from this machine
// would ship the tree and revert everyone again. When the tree cannot be
// touched (--all builds several spaces off one dist; no git and no cache to
// prove what is mine), adoption falls back to manifest patches + `unresolved`.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  classifyPublish, repoDirCandidates, stripBuildDecorations, stripVolatileHead, unitPaths, isInternalPath,
} from "./publish-conflict.mjs";

const dec = (s) => { try { return decodeURIComponent(String(s)); } catch (e) { return String(s); } };
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const isHtml = (p) => /\.html?$/i.test(p);

const gitq = (dir, ...a) => {
  try {
    return execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) { return null; }
};
const gitBytesAt = (dir, sha, rel) => {
  try {
    return execFileSync("git", ["-C", dir, "show", `${sha}:${rel}`], { stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) { return null; }
};

export const isAncestor = (dir, sha) =>
  !!sha && gitq(dir, "merge-base", "--is-ancestor", sha, "HEAD") !== null;

// Repo path → the unit URL it belongs to (the inverse of the build's URL scheme:
// prototypes elide /prototypes/, playground does not, names are URL-encoded).
export function unitOfRepoPath(repoPath, spaceBase = "") {
  const m = /^([^/]+)\/prototypes\/([^/]+)\//.exec(repoPath)
    || /^(playground)\/([^/]+)\//.exec(repoPath);
  if (!m) return null;
  const enc = encodeURIComponent;
  return m[1] === "playground"
    ? `${spaceBase}/playground/${enc(m[2])}/`
    : `${spaceBase}/${enc(m[1])}/${enc(m[2])}/`;
}

// What did THIS tree change since the live publish? Three answers, best first:
//   git   — live sha is in my history: diff + working-tree status, exact.
//   cache — no usable git base, but my last publish from this machine is cached:
//           units whose built output differs from what I last shipped.
//   none  — neither: the base is unknowable, classification goes conservative.
export function computeMyChanged({ sourceDir, spaceBase, liveSource, cached, manifest }) {
  const sha = liveSource && liveSource.sha;
  if (sha && gitq(sourceDir, "cat-file", "-e", `${sha}^{commit}`) !== null && isAncestor(sourceDir, sha)) {
    const units = new Set(), paths = new Set();
    const committed = (gitq(sourceDir, "diff", "--name-only", sha, "HEAD") || "").split("\n");
    const porcelain = (gitq(sourceDir, "status", "--porcelain") || "").split("\n")
      .map((l) => l.slice(3).replace(/^"|"$/g, ""));
    for (const rel of [...committed, ...porcelain]) {
      if (!rel) continue;
      const u = unitOfRepoPath(rel, spaceBase);
      if (u) units.add(u);
      if (!spaceBase && rel.startsWith("skills/")) paths.add("/" + rel);
    }
    return { mode: "git", units, paths };
  }
  if (cached && cached.files) {
    const units = new Set(), paths = new Set();
    const pseudo = { files: cached.files, routing: (manifest || {}).routing };
    for (const u of ((manifest.routing || {}).publicPrefixes || [])) {
      const uu = String(u).replace(/\/?$/, "/");
      const a = unitPaths(manifest, uu), b = unitPaths(pseudo, uu);
      const bh = new Map(b.map((p) => [p, cached.files[p] && cached.files[p].h]));
      const differs = a.length !== b.length
        || a.some((p) => !bh.has(p) || bh.get(p) !== (manifest.files[p] || {}).h);
      if (differs) units.add(uu);
    }
    for (const p of Object.keys(manifest.files || {})) {
      if (!dec(p).startsWith("/skills/")) continue;
      const c = cached.files[p];
      if (!c || c.h !== manifest.files[p].h) paths.add(p);
    }
    return { mode: "cache", units, paths };
  }
  return { mode: "none", units: null, paths: null };
}

// A contested verdict from a cache base can be stale news; with a git base we can
// ask precisely: did the live unit really change relative to the commit it claims
// to come from? Byte-compare live blobs against the git objects, tolerating the
// injected social meta that legitimately differs per publisher. "No" downgrades
// the conflict — mine ships, nothing forks.
async function liveUnitReallyChanged({ unit, live, liveSha, sourceDir, spaceBase, fetchBlob }) {
  const unitDir = firstDirCandidate(unit, spaceBase, sourceDir);
  const livePathsList = unitPaths(live, unit);
  const atSha = gitq(sourceDir, "ls-tree", "-r", "--name-only", liveSha, "--", unitDir);
  if (atSha === null) return true;
  const shaFiles = atSha.split("\n").filter(Boolean);
  if (shaFiles.length !== livePathsList.length) return true;
  for (const livePath of livePathsList) {
    const rel = path.posix.join(unitDir, dec(livePath).slice(dec(unit).length));
    const obj = gitBytesAt(sourceDir, liveSha, rel);
    if (!obj) return true;
    const h = (live.files[livePath] || {}).h;
    if (sha256(obj) === h) continue;
    if (!isHtml(livePath)) return true;
    const blob = await fetchBlob(h);
    if (!blob || stripVolatileHead(blob.toString("utf8")) !== stripVolatileHead(obj.toString("utf8"))) return true;
  }
  return false;
}

function firstDirCandidate(unit, spaceBase, sourceDir) {
  const candidates = repoDirCandidates(unit, { spaceBase });
  for (const c of candidates) if (existsSync(path.join(sourceDir, c))) return c;
  return candidates[0];
}

const walkFiles = (dir) => {
  const out = [];
  const rec = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) rec(p); else out.push(p);
    }
  };
  if (existsSync(dir)) rec(dir);
  return out;
};

// Write a live unit's files into the tree at its repo folder, removing local
// files the live unit does not have. Only ever called for units classification
// proved this tree did NOT change — uncommitted work under it would have made
// the unit "mine" and routed it to fork instead.
async function materializeUnit({ unit, live, sourceDir, spaceBase, fetchBlob }) {
  const unitDir = firstDirCandidate(unit, spaceBase, sourceDir);
  const abs = path.join(sourceDir, unitDir);
  const wanted = new Map();
  for (const livePath of unitPaths(live, unit)) {
    wanted.set(path.join(abs, dec(livePath).slice(dec(unit).length)), (live.files[livePath] || {}).h);
  }
  for (const [file, h] of wanted) {
    const blob = await fetchBlob(h);
    if (!blob) throw new Error(`blob ${String(h).slice(0, 12)} unavailable for ${unit}`);
    mkdirSync(path.dirname(file), { recursive: true });
    // Live blobs are BUILT bytes; peel EVERYTHING the build decorates them with —
    // marker chrome, og meta, the linked-assets stamp, the title emoji, the skills
    // depth rewrite — so the adopted source is byte-shaped like what its author
    // wrote (the rebuild re-injects identically, so live hashes still match). A
    // partial peel here wrote 169 dist-flavored pages into a space repo 2026-08-19.
    const relDir = path.relative(sourceDir, path.dirname(file)).split(path.sep).join("/");
    writeFileSync(file, isHtml(file) ? Buffer.from(stripBuildDecorations(blob.toString("utf8"), relDir)) : blob);
  }
  // Live testifies only about what SHIPS: internal material (research/, context.md,
  // secrets screens) never reaches a manifest, so its absence from live proves
  // nothing — deleting it here destroyed 54 research files once. Leave it be.
  for (const f of walkFiles(abs)) {
    if (wanted.has(f)) continue;
    if (isInternalPath(path.relative(sourceDir, f).split(path.sep).join("/"))) continue;
    rmSync(f);
  }
  return unitDir;
}

export async function resolvePublish({
  id, manifest, live, sourceDir, spaceBase, liveSource, cached,
  fetchBlob, log, warn, dry = false, canTouchTree = true, who = "someone",
}) {
  const theirName = (live && live.publishedBy) || (liveSource && liveSource.actor) || "a collaborator";
  const my = computeMyChanged({ sourceDir, spaceBase, liveSource, cached, manifest });
  const cls = classifyPublish({
    mine: manifest, live, myChangedUnits: my.units, myChangedPaths: my.paths,
  });

  // With a git base, contested units get the precise question; a cache base keeps
  // the conservative verdict (forking is loud but loses nothing).
  let contested = cls.contestedUnits;
  if (my.mode === "git" && contested.length) {
    const real = [];
    for (const u of contested) {
      if (await liveUnitReallyChanged({ unit: u, live, liveSha: liveSource.sha, sourceDir, spaceBase, fetchBlob })) {
        real.push(u);
      } else {
        log(`${id}: ${u} differs only because of my edits — ships normally`);
      }
    }
    contested = real;
  }

  const nothing = !cls.adoptUnits.length && !contested.length
    && !cls.skillAdoptPaths.length && !cls.skillContestedPaths.length && !cls.dropUnits.length;
  if (nothing) {
    if (cls.noisePaths.length) {
      log(`${id}: live v-differences are generated pages only (${cls.noisePaths.length}) — replaced by this build`);
    }
    return { acted: false, changedTree: false, patches: null, unresolved: [], forks: [] };
  }

  if (dry) {
    for (const u of cls.adoptUnits) log(`${id}: would adopt ${u} (${theirName}'s newer version is live)`);
    for (const u of contested) log(`${id}: would fork — both you and ${theirName} changed ${u}`);
    for (const p of cls.skillAdoptPaths) log(`${id}: would adopt ${p}`);
    for (const p of cls.skillContestedPaths) log(`${id}: would keep ${theirName}'s ${p} live (yours NOT shipped)`);
    for (const u of cls.dropUnits) log(`${id}: would re-ship ${u} (${theirName} removed it from live)`);
    return { acted: true, changedTree: false, patches: null, unresolved: [], forks: [], dry: true };
  }

  const patches = { files: {}, prefixes: [], versionMap: {}, dirty: false };
  const unresolved = [];
  const forks = [];
  const treePaths = []; // sourceDir-relative paths this resolve wrote — the caller commits them mechanically
  let changedTree = false;

  const adoptViaPatch = (unit) => {
    for (const p of unitPaths(manifest, unit)) if (!live.files[p]) patches.files[p] = null;
    for (const p of unitPaths(live, unit)) patches.files[p] = live.files[p];
    const lp = ((live.routing || {}).publicPrefixes || []).find((x) => String(x).replace(/\/?$/, "/") === unit);
    if (lp) patches.prefixes.push(lp);
    const vm = ((live.routing || {}).versionMap || {})[unit];
    if (vm) patches.versionMap[unit] = vm;
    patches.dirty = true;
  };

  for (const u of cls.adoptUnits) {
    if (canTouchTree && my.mode !== "none") {
      const dir = await materializeUnit({ unit: u, live, sourceDir, spaceBase, fetchBlob });
      changedTree = true;
      treePaths.push(dir);
      log(`${id}: adopted ${u} from live (${theirName}'s work; now in your tree at ${dir}/)`);
    } else {
      adoptViaPatch(u);
      unresolved.push(...unitPaths(live, u));
      warn(`${id}: adopted ${u} into the manifest only (${my.mode === "none" ? "no base to prove your tree is clean there" : "multi-space build"}) — your tree still has the old version`);
    }
  }

  for (const u of contested) {
    if (!canTouchTree || my.mode === "none") {
      // Can't fork without touching the tree; keep theirs live, mine stays local.
      adoptViaPatch(u);
      unresolved.push(...unitPaths(live, u));
      warn(`${id}: CONFLICT on ${u} — ${theirName}'s version stays live; yours was NOT shipped (tree untouched in this mode)`);
      continue;
    }
    const mineDir = firstDirCandidate(u, spaceBase, sourceDir);
    const mineAbs = path.join(sourceDir, mineDir);
    if (!existsSync(mineAbs)) {
      const dir = await materializeUnit({ unit: u, live, sourceDir, spaceBase, fetchBlob });
      changedTree = true;
      treePaths.push(dir);
      log(`${id}: adopted ${u} (contested but nothing local to fork; now at ${dir}/)`);
      continue;
    }
    const forkDir = `${mineDir.replace(/\/+$/, "")}-conflict-${who}`;
    const forkAbs = path.join(sourceDir, forkDir);
    rmSync(forkAbs, { recursive: true, force: true });
    cpSync(mineAbs, forkAbs, { recursive: true });
    writeFileSync(path.join(forkAbs, "CONFLICT.md"),
      `# Live edit conflict\n\n` +
      `You and **${theirName}** changed \`${mineDir}\` at the same time. Their version was\n` +
      `live from work your git history has never seen, so \`augur publish\` kept **theirs**\n` +
      `at the original URL — any shared link still resolves — and moved **your** version\n` +
      `here.\n\n` +
      `Both are live. Compare them, fold in whatever should survive, then delete this\n` +
      `folder. Nothing has been lost.\n`);
    await materializeUnit({ unit: u, live, sourceDir, spaceBase, fetchBlob });
    changedTree = true;
    treePaths.push(mineDir, forkDir);
    forks.push({ unit: u, folder: mineDir, fork: forkDir, theirs: theirName });
    warn(`${id}: conflict on ${u} — kept ${theirName}'s version there; yours is now ${forkDir}/ (both will be live)`);
  }

  for (const p of cls.skillAdoptPaths) {
    const rel = dec(p).replace(/^\//, "");
    if (canTouchTree && my.mode !== "none" && !spaceBase) {
      const blob = await fetchBlob(live.files[p].h);
      if (!blob) throw new Error(`blob unavailable for ${p}`);
      const abs = path.join(sourceDir, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, blob);
      changedTree = true;
      treePaths.push(rel);
      log(`${id}: adopted ${p} from live (${theirName}'s newer version)`);
    } else {
      patches.files[p] = live.files[p];
      patches.dirty = true;
      unresolved.push(p);
    }
  }

  for (const p of cls.skillContestedPaths) {
    // No folder to fork a lone shared file into: theirs stays live, mine stays in
    // my tree, and the path stays "unresolved" so the next publish re-classifies
    // instead of shipping my bytes back over theirs.
    patches.files[p] = live.files[p];
    patches.dirty = true;
    unresolved.push(p);
    warn(`${id}: ${p} — ${theirName}'s version kept live; YOURS WAS NOT SHIPPED. ` +
      `Merge their change into your file (augur export can fetch it) and re-publish.`);
  }

  for (const u of cls.dropUnits) {
    warn(`${id}: ${theirName} removed ${u} from live outside git — your tree still has it, so this publish puts it back. ` +
      `Delete the folder locally if the removal was right.`);
  }

  const hasPatches = patches.dirty || Object.keys(patches.files).length > 0;
  return { acted: true, changedTree, patches: hasPatches ? patches : null, unresolved, forks, treePaths };
}

// Reconcile writes (adopted live folders, conflict forks) are repo surgery, not
// authorship. Left uncommitted they ride into whoever's NEXT commit, and the
// build's date/credit pass then stamps that person's face and "edited just now"
// on every folder the reconcile touched (it happened twice on 2026-08-19). So
// the caller commits the residue HERE, alone — exactly the paths the resolve
// wrote — with the `Augur-Mechanical: true` trailer the credit pass skips. The
// publisher's own uncommitted work stays uncommitted: a pathspec commit reads
// the working tree for the named paths and nothing else, and leaves whatever
// else is staged still staged.
export function commitReconcileResidue({ dir, resolution, id, log }) {
  const paths = [...new Set((resolution && resolution.treePaths) || [])];
  if (!paths.length) return false;
  const g = (...a) => execFileSync("git", ["-C", dir, ...a],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try { g("rev-parse", "--git-dir"); } catch { return false; } // no repo — nothing to mis-credit
  try {
    g("add", "--", ...paths); // pathspec commits skip untracked files; adding first includes the forks
    try { g("diff", "--cached", "--quiet", "--", ...paths); return false; } // nothing actually changed
    catch { /* staged differences exist — commit them */ }
    const forks = (resolution.forks || []).map((f) => f.fork);
    g("commit",
      "-m", `Publish reconcile: adopt live work${forks.length ? ` + fork ${forks.join(", ")}` : ""}`,
      "-m", "Written by `augur publish` while reconciling this tree against the live space: " +
            "adopted live folders and conflict forks, not this committer's authorship.",
      "-m", "Augur-Mechanical: true",
      "--", ...paths);
    log(`${id}: reconcile residue committed on its own (Augur-Mechanical) — your uncommitted work is untouched`);
    return true;
  } catch (e) {
    log(`${id}: ⚠ could not commit the reconcile residue (${String((e && e.message) || e).split("\n")[0]}).`);
    log(`  AGENT: commit these paths in a commit of their OWN with an "Augur-Mechanical: true" trailer`);
    log(`  (folded into a normal commit, the build credits the committer with every folder listed):`);
    for (const p of paths) log(`    ${p}`);
    return false;
  }
}

export function applyManifestPatches(manifest, patches) {
  if (!patches) return;
  for (const [p, entry] of Object.entries(patches.files)) {
    if (entry === null) delete manifest.files[p];
    else manifest.files[p] = entry;
  }
  const routing = (manifest.routing = manifest.routing || {});
  const have = new Set((routing.publicPrefixes || []).map((x) => String(x).replace(/\/?$/, "/")));
  for (const p of patches.prefixes) {
    if (!have.has(String(p).replace(/\/?$/, "/"))) (routing.publicPrefixes = routing.publicPrefixes || []).push(p);
  }
  Object.assign(routing.versionMap = routing.versionMap || {}, patches.versionMap);
  if (patches.dirty) manifest.source.dirty = true;
}
