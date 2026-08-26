// Build-decoration tolerance + the repo-dir mapping — pure, shared by the publish stack.
//
// ⚠️ THE UNIT VOCABULARY MOVED TO src/publish-units.mjs and is re-exported below, so no CLI
// import had to change. It moved because the SERVER needs it: `C-fork-on-conflict` resolves
// a stale base inside the commit handler, and two definitions of "which folder does this
// path belong to" would disagree on exactly the paths a conflict is about.
//
// A unit is a prototype/playground folder — the thing a URL names and a person edits, never
// a lone file — and units are exactly the routing fragment's publicPrefixes (galleries get
// versionMap entries but no prefix, which is what keeps them out). Since protocol 5 the
// per-unit decisions live in publish-compose.mjs; what remains here is the repo-dir mapping
// and the two views of what the build decorates authored HTML with:
// stripVolatileHead (a COMPARATOR: does this content really differ?) and
// stripBuildDecorations (a TRANSFORMER: undo the decoration exactly — kept for
// repo-debake tooling, e.g. peeling dist-flavored bytes out of a space repo).

export { authoredUnits, unitOfPath, unitPaths } from "../../src/publish-units.mjs";
const dec = (s) => { try { return decodeURIComponent(String(s)); } catch (e) { return String(s); } };

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
