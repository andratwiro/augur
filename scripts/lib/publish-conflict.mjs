// Conflict classification for store-aware publishing — the pure half.
//
// A publish ships one built tree as the WHOLE space, so whatever is live that the
// tree does not contain gets reverted, bytes replacing bytes, no guard tripped.
// Before committing, the publish CLI compares its manifest against the live one
// and classifies every difference so nothing is ever reverted silently:
//
//   they changed it, I did not   → adopt theirs (their hashes ride my manifest)
//   they deleted it, I did not   → adopt the deletion
//   I changed it, they did not   → mine ships, as always
//   we both changed it          → contested: the caller verifies and forks mine
//   generated pages             → noise: mine wins, regenerated on any publish
//
// The UNIT of all of this is a prototype/playground folder — the thing a URL
// names, a person edits, and ship's git-side reconcile already forks — never a
// lone file. Units are exactly the routing fragment's publicPrefixes (galleries
// get versionMap entries but no prefix, which is what keeps them out).
//
// Everything impure (git, the store, the working tree) is the caller's problem:
// this module sees two manifests plus "what I changed" and answers what to do.
// `myChangedUnits: null` means the base is unknowable (no git object for the
// live sha, no publish cache) — then differing units are adopted (the safe
// direction: my version still exists in my tree and git; theirs may exist only
// in the store) and deletions are never adopted (a unit only I have may simply
// be my new work).

const dec = (s) => { try { return decodeURIComponent(String(s)); } catch (e) { return String(s); } };
const norm = (p) => String(p == null ? "" : p).replace(/\/?$/, "/");

export function authoredUnits(manifest) {
  const out = new Set();
  for (const p of ((manifest || {}).routing || {}).publicPrefixes || []) out.add(norm(p));
  return out;
}

export function unitOfPath(path, unitSet) {
  const p = dec(path);
  for (const u of unitSet) if (p.startsWith(dec(u))) return u;
  return null;
}

export function unitPaths(manifest, unit) {
  const prefix = dec(unit);
  return Object.keys((manifest || {}).files || {}).filter((p) => dec(p).startsWith(prefix));
}

// A unit URL back to the repo folder(s) it could live in, best guess first:
// prototypes elide the /prototypes/ segment on the URL side, playground does not,
// and a non-default space carries its base as the first segment.
export function repoDirCandidates(unit, { spaceBase = "" } = {}) {
  let u = dec(unit);
  const base = dec(spaceBase || "");
  if (base && (u === base + "/" || u.startsWith(base + "/"))) u = u.slice(base.length);
  const segs = u.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  if (!segs.length) return [];
  if (segs[0] === "playground" || segs.length !== 2) return [segs.join("/")];
  return [`${segs[0]}/prototypes/${segs[1]}`, segs.join("/")];
}

// The build decorates authored HTML on its way to dist: marker-delimited chrome
// (the review overlay, the pet layer, offline reload) plus og/twitter meta.
// stripInjectedChrome removes exactly the marker blocks — used when writing live
// bytes back into a tree, so adopted sources stay close to what their author
// wrote (og meta stays: the injector skips pages that already carry it, so it is
// stable across rebuilds).
export function stripInjectedChrome(html) {
  return String(html).replace(/<!--gv-([a-z0-9-]+)-start-->[\s\S]*?<!--gv-\1-end-->/g, "");
}

// Tolerant equality for "did the content really change": a live blob and a git
// source must compare equal when they differ only by injected chrome, social
// meta (og:url legitimately varies with the configured origin), the linked-assets
// stamp, the skills-path depth rewrite (dist mounts prototypes one level shallower
// than the repo), and the whitespace those injections leave behind. Every one of
// these leaked through this comparator on 2026-08-19 and a reconcile then adopted
// 169 chrome-baked pages into a space repo as one collaborator's authorship.
// A comparator, not a transformer.
export function stripVolatileHead(html) {
  return stripInjectedChrome(html)
    .replace(/[ \t]*<meta\s+(?:property|name)="(?:og|twitter):[^"]*"\s+content="[^"]*"\s*\/?>[ \t]*/g, "")
    .replace(/<script>window\.__GV_LINKED=\[[^\n]*?\];<\/script>/g, "")
    // The build stamps the card emoji onto <title> (idempotently) — not an edit.
    .replace(/(<title>)\s*(?:[\p{Extended_Pictographic}‍️]+\s*)+/gu, "$1")
    // Depth is layout, not content: collapse any ../-run before skills/ so the
    // repo form (../../../skills/…) and the dist form (../../skills/…) compare equal.
    .replace(/(?:\.\.\/)+skills\//g, "skills/")
    .replace(/\s+/g, " ").replace(/>\s+</g, "><").trim();
}

// The WRITER'S peel — everything the build decorates authored HTML with on its way
// to dist, undone, so an adopted source is byte-shaped like what its author wrote:
// marker chrome out, og/twitter meta out (the build re-derives it), the linked-assets
// stamp out, the title emoji off, and the skills-path depth rewrite reversed for the
// file's REPO location (`relDir`, the file's directory relative to the space root).
// Without the full peel, an adopt writes dist bytes into git — pages whose relative
// asset paths no longer resolve in the repo layout, plus baked meta that reads as an
// edit forever after. A transformer, not a comparator: depth must come out exact.
export function stripBuildDecorations(html, relDir) {
  const up = "../".repeat(String(relDir || "").split("/").filter(Boolean).length);
  return stripInjectedChrome(String(html))
    .replace(/[ \t]*<meta\s+(?:property|name)="(?:og|twitter):[^"]*"\s+content="[^"]*"\s*\/?>\s*\n?/g, "")
    .replace(/[ \t]*<script>window\.__GV_LINKED=\[[^\n]*?\];<\/script>\s*\n?/g, "")
    .replace(/(<title>)\s*(?:[\p{Extended_Pictographic}‍️]+\s*)+/gu, "$1")
    .replace(/(?:\.\.\/)+skills\//g, up + "skills/");
}

// Mirror of build.js's internal-material predicates (isInternalOnly + the secret/VCS
// screens). These files NEVER ship, so live's manifest cannot testify about them —
// an adopt that syncs a repo folder to "exactly what live has" must leave them be.
// (The 2026-08-19 adopt deleted 54 research/context files this way.)
const INTERNAL_SECRET_RE = /(^\.env(\.|$)|\.env$|\.(pem|key|p12|pfx|ppk|keystore|jks)$|(^|[._-])(secret|secrets|credentials?)([._-]|$)|^id_(rsa|dsa|ecdsa|ed25519)$|^\.(npmrc|netrc|pgpass|htpasswd|ssh|aws|gnupg)$)/i;
const INTERNAL_VCS_RE = /^\.(git|hg|svn|bzr)$/i;
export function isInternalPath(rel) {
  return String(rel).split("/").some((name) =>
    name === "research" || name === "context" || name === "research.md" || name === "context.md" ||
    name === ".DS_Store" || name.endsWith(".zip") || INTERNAL_VCS_RE.test(name) || INTERNAL_SECRET_RE.test(name));
}

const hashesOf = (manifest, unit) => {
  const out = new Map();
  for (const p of unitPaths(manifest, unit)) out.set(p, (manifest.files[p] || {}).h);
  return out;
};

const unitDiffers = (mine, live, unit) => {
  const a = hashesOf(mine, unit), b = hashesOf(live, unit);
  if (a.size !== b.size) return true;
  for (const [p, h] of a) if (b.get(p) !== h) return true;
  return false;
};

export function classifyPublish({ mine, live, myChangedUnits = null, myChangedPaths = null }) {
  const mineUnits = authoredUnits(mine);
  const liveUnits = authoredUnits(live);
  const knownUnits = myChangedUnits instanceof Set;
  const changedU = (u) => knownUnits && myChangedUnits.has(u);

  const adoptUnits = [], dropUnits = [], contestedUnits = [];
  for (const u of new Set([...mineUnits, ...liveUnits])) {
    const inMine = mineUnits.has(u), inLive = liveUnits.has(u);
    if (inLive && !inMine) {
      // Their addition — or my deletion, which only my base can prove.
      if (!changedU(u)) adoptUnits.push(u);
    } else if (inMine && !inLive) {
      // My new work — or their deletion, adopted only with a base to prove it.
      if (knownUnits && !changedU(u)) dropUnits.push(u);
    } else if (unitDiffers(mine, live, u)) {
      if (changedU(u)) contestedUnits.push(u);
      else adoptUnits.push(u);
    }
  }

  // Shared skill assets (the DS files prototypes load) are authored too, but have
  // no folder unit to fork — classification is per file; the caller decides what
  // a contested one means (today: theirs wins, loudly).
  const skillPrefixes = new Set();
  for (const m of [mine, live]) {
    for (const p of ((m || {}).routing || {}).publicSkillPrefixes || []) skillPrefixes.add(norm(p));
  }
  const underSkill = (p) => { const d = dec(p); return [...skillPrefixes].some((s) => d.startsWith(dec(s))); };
  const knownPaths = myChangedPaths instanceof Set;
  const skillAdoptPaths = [], skillContestedPaths = [];
  const mineFiles = (mine || {}).files || {}, liveFiles = (live || {}).files || {};
  for (const p of new Set([...Object.keys(mineFiles), ...Object.keys(liveFiles)])) {
    if (!underSkill(p)) continue;
    const a = mineFiles[p], b = liveFiles[p];
    if (!b) continue; // only mine: new DS file, ships
    const differs = !a || a.h !== b.h;
    if (!differs) continue;
    if (knownPaths && myChangedPaths.has(p)) skillContestedPaths.push(p);
    else skillAdoptPaths.push(p);
  }

  // Everything else that differs is generated output — galleries, indexes, cards.
  // Mine wins by construction (the next publish regenerates them all); recorded so
  // the caller can say so instead of nothing.
  const inUnits = (p) => unitOfPath(p, mineUnits) || unitOfPath(p, liveUnits);
  const noisePaths = [];
  for (const p of new Set([...Object.keys(mineFiles), ...Object.keys(liveFiles)])) {
    if (inUnits(p) || underSkill(p)) continue;
    const a = mineFiles[p], b = liveFiles[p];
    if (a && b && a.h === b.h) continue;
    noisePaths.push(p);
  }

  return {
    adoptUnits: adoptUnits.sort(),
    dropUnits: dropUnits.sort(),
    contestedUnits: contestedUnits.sort(),
    skillAdoptPaths: skillAdoptPaths.sort(),
    skillContestedPaths: skillContestedPaths.sort(),
    noisePaths: noisePaths.sort(),
  };
}
