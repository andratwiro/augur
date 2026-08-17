#!/usr/bin/env node
/**
 * build.js — builds EVERY mounted space into a single static site in /dist.
 *
 * Spaces (see CLAUDE.md): one repo per space, mounted as submodules at spaces/<id>.
 * Each space root holds its own DS assets (skills/, galleries, registry.json,
 * space.json) plus opportunity folders:
 *   <space>/<opportunity>/
 *     research.md   <- context for agents, NEVER published
 *     context.md    <- context for agents, NEVER published
 *     prototypes/
 *       <prototype>/  <- self-contained static HTML/JS, THIS is what ships
 *
 * Rules:
 *   - Publishing is whitelist-driven: prototypes/ contents, the gallery builders,
 *     and the named DS asset list. research.md/context.md/anything else never ships.
 *
 * Output: the DEFAULT space (space.json default:true) at the dist root URLs, every
 * other space under /<id>/:
 *   /dist/index.html                     -> the default space's opportunity list
 *   /dist/<opportunity>/<prototype>/...  -> a default-space prototype
 *   /dist/<id>/...                       -> a non-default space, same shape
 *   /dist/_worker.js                     -> edge auth gate (injected from src/)
 *   /dist/_build.json                    -> public build stamp {builtAt, engine:{sha}, spaces:{id:{sha}}}
 *
 * Plain Node, no dependencies.
 */

import { promises as fs, readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// Augur composes ONE read-only submodule PER SPACE, mounted at spaces/<id>/. Each space
// is its own repo — a self-contained bundle (its own skills/, galleries, registry.json,
// space.json, and opportunities) with the design system + prototypes together at its
// root. build.js builds every space into /dist: the DEFAULT space at the root URLs (so
// existing public links + overlay KV keys are untouched), and each additional space
// under a /<id>/ path prefix.
// Default to the pinned submodules nested here — what deploy builds. Offline mode
// (`npm run offline`) overrides the location via GV_SPACES_ROOT to point at the parent
// of the canonical sibling clones (../), so a local preview reflects live edits with no
// pin bump — discoverSpaces() only treats dirs carrying a space.json as spaces, so other
// siblings (augur itself, scratch dirs) are ignored. Relative overrides resolve against
// this file's dir.
const SPACES_ROOT = process.env.GV_SPACES_ROOT
  ? path.resolve(ROOT, process.env.GV_SPACES_ROOT)
  : path.join(ROOT, "spaces");
// GV_ENGINE_ONLY=1 builds the shared chrome and nothing else: space discovery is
// skipped entirely, so no space needs to be on disk. This is what a deploy shell's
// CI runs. It is the structural half of "the store is the only source of space
// content" — a build that never sees a space cannot emit one, so the CI path is
// incapable of overwriting a direct publish, however stale its checkout. The
// manifest writer asserts the result really is chrome-only (see ENGINE_CHROME).
const ENGINE_ONLY = process.env.GV_ENGINE_ONLY === "1";
// GV_LOCAL=1 marks a build that is only ever served from this machine (offline preview,
// `augur dev`). It gates the one folder whose contents are NOT ours to put on the web:
// a space's session music (see the tracks/ block in buildSpace).
const LOCAL_BUILD = process.env.GV_LOCAL === "1";
// GV_DIST redirects the output tree. Only tests set it: a test that needs a real build
// must not write into the shared dist/ that other tests and the publish scripts read —
// node --test runs files in parallel, so that is a race, and it is one that shows up in
// CI rather than locally.
const DIST = process.env.GV_DIST ? path.resolve(process.env.GV_DIST) : path.join(ROOT, "dist");
const SRC_WORKER = path.join(ROOT, "src", "_worker.js");

// ── Per-space build context. (Re)assigned by setSpaceContext() at the top of each
// space's build pass; every scan/render function reads these as ambient globals, so the
// whole single-space pipeline runs unchanged once per space.
//   DS_ROOT / WS_ROOT : the active space root (DS assets + opportunities now co-locate)
//   BASE              : URL prefix for the active space ("" for the default, else "/<id>")
//   DIST_SPACE        : where this space's content is written (DIST, or DIST/<id>)
let DS_ROOT, WS_ROOT, BASE = "", DIST_SPACE = DIST;
// Canvas insert-picker catalog — every embeddable thing across spaces (prototypes, pages,
// components), accumulated per buildSpace and written to dist/__canvas/catalog.json.
let CANVAS_CATALOG = [];
// Canvas session music — every track any space installs, accumulated the same way the
// insert-picker catalog is and written to dist/__canvas/tracks.json. The engine ships NO
// audio: a space declares its own in tracks/tracks.json and the canvas fills its picker from
// whatever is there. An instance with no tracks/ folder gets an empty manifest and a canvas
// whose music section says so — the timer is unaffected. Tracks are LOCAL-ONLY unless the
// space sets "publishTracks": true (see the tracks/ block in buildSpace).
let CANVAS_TRACKS = [];
// SPACE_KEY: prefix for overlay KV keys that are keyed by "<opp>/<proto>" rather than by
// URL path — i.e. dev-status chips and rename overrides. "" for the default space (so its
// existing KV entries are untouched), "<id>/" otherwise, so a /<id>/ space's statuses /
// names can't collide with another's. (Comments + pins are keyed by URL path, which
// already carries the space prefix, so they isolate without this.)
let SPACE_KEY = "";
// The active space's detected design-system descriptor ({dirName, prefix}), display
// name, and extra ignored top-level dirs (space.json "ignore") — set by setSpaceContext.
let DS = { dirName: null, prefix: null };
let SPACE_NAME = "";
// What this space calls its top-level prototype folders in the UI (rail section,
// landing title). Generic default; a space overrides via space.json `projectsLabel`
// (e.g. a team whose vocabulary for them is "Opportunities").
let PROJECTS_LABEL = "Projects";
let SPACE_IGNORE = new Set();
// S(p): prefix a SPACE-SCOPED root-relative URL with the active space's BASE. Shared
// chrome (worker APIs /__*, /fonts, /augur-mark.png, /admin, /changelog) is NOT
// space-scoped and stays root-absolute — don't wrap those.
const S = (p) => BASE + p;

// Internal users (identity + seed passwords). One committed source of truth, read
// here and injected into the worker (the gate) and used for sidebar profiles + git
// edit-attribution. Passwords never reach the client — IDENTITY_PUBLIC strips them.
// GV_IDENTITY_PATH points a deploy shell at its own identity file (same shape), so
// the engine repo can ship without a real user list; default = the committed file.
const IDENTITY_PATH = process.env.GV_IDENTITY_PATH || path.join(ROOT, "src", "identity.json");
const IDENTITY = JSON.parse(readFileSync(IDENTITY_PATH, "utf8"));
const IDENTITY_PUBLIC = IDENTITY.map(({ pass, emails, ...u }) => u);
// Lower-cased email → public profile, for mapping git commit authors to a face. A
// user may list extra addresses they commit from (identity `emails`: other machines,
// a personal address, an agent that commits on their behalf) — all fold to one
// profile, so attribution doesn't fragment per laptop. Those addresses are internal:
// IDENTITY_PUBLIC strips them, only the account email is ever served.
const USER_BY_EMAIL = new Map();
IDENTITY.forEach((u, i) => {
  const pub = IDENTITY_PUBLIC[i];
  for (const e of [u.email, ...(u.emails || [])]) if (e) USER_BY_EMAIL.set(e.toLowerCase(), pub);
});

// Optional, self-contained build addon. If present it can post-process copied HTML,
// add footer/style/script snippets to shell pages, and emit its own dist files via
// generic hooks (see its source). The site builds identically without it.
let addon = null;
try { addon = await import("./pitis/piti.build.js"); } catch (e) { addon = null; }
const addonHtml = (html) => (addon ? addon.transformHtml(html, UI_VERSION) : html);
const SRC_REVIEW = path.join(ROOT, "src", "review", "comments.js");
const SRC_REVIEW_CAT = path.join(ROOT, "src", "review", "cat.png");
const SRC_REVIEW_CURSOR = path.join(ROOT, "src", "review", "comment-cursor.svg");
const SRC_CANVAS_JS = path.join(ROOT, "src", "canvas", "canvas.js");
const SRC_CANVAS_CSS = path.join(ROOT, "src", "canvas", "canvas.css");
const SRC_CANVAS_CAPTURE = path.join(ROOT, "src", "canvas", "capture.js");
const SRC_CANVAS_7SEG = path.join(ROOT, "src", "canvas", "DSEG7Classic-Bold.woff2");
const SRC_CANVAS_7SEG_LICENSE = path.join(ROOT, "src", "canvas", "DSEG-LICENSE.txt");

// Dev-facing prototype status baseline. Lives PER SPACE in the space repo at
// prototype-status.json (repo root) (keyed "<opportunity>/<prototype>"), rendered as a
// static chip at build time — no KV, no runtime cost. Internal file: it lives outside any
// prototypes/ folder, so it is never copied to dist. Set per space by setSpaceContext().
// See STATUS_META for the allowed values.
let STATUS_FILE = null;
const STATUS_META = {
  "in-progress": { label: "In progress", cls: "is-wip" },
  "dev-ready": { label: "Dev ready", cls: "is-ready" },
  ignore: { label: "Ignore", cls: "is-ignore" },
};

// Status is shown as a small circular glyph (GitHub-Projects idiom), not a text
// pill — colour AND shape both carry the meaning (WCAG 1.4.1; the accessible label
// rides on aria-label/title). Dev ready = filled green check, In progress =
// half-filled amber ring, Ignore = hollow grey ring with a dash. Same SVG strings
// are reused client-side by STATUS_JS so a click repaints to match.
const STATUS_ICONS = {
  "dev-ready":
    '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="#17935a"/><path d="M5.8 10.4l2.7 2.7 5.7-6" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  "in-progress":
    '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" fill="none" stroke="#1c1c22" stroke-width="2.2"/><path d="M10 2.8a7.2 7.2 0 0 1 0 14.4z" fill="#1c1c22"/></svg>',
  ignore:
    '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" fill="none" stroke="#aeb3bd" stroke-width="2.2"/><line x1="6.4" y1="10" x2="13.6" y2="10" stroke="#aeb3bd" stroke-width="2.2" stroke-linecap="round"/></svg>',
  // Component-only "validated" state — a filled green check (same idiom as dev-ready).
  reviewed:
    '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="#17935a"/><path d="M5.8 10.4l2.7 2.7 5.7-6" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

// Sort priority for prototype cards within an opportunity: Dev ready → In progress
// → Ignore, recency breaking ties inside each group (see byStatusThenRecency).
// Unset sorts with Ignore because statusChip() renders a missing status as an
// "Ignore" chip — so the no-JS / first-paint order matches what the chip shows.
// NOTE: the live source of truth is KV, not this JSON baseline; STATUS_JS re-sorts
// the cards client-side once the KV statuses are applied (resort()).
const STATUS_RANK = { "dev-ready": 0, "in-progress": 1, ignore: 2 };
const STATUS_RANK_UNSET = 2;

async function loadStatusMap() {
  try {
    const raw = await fs.readFile(STATUS_FILE, "utf8");
    const obj = JSON.parse(raw);
    const map = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith("_")) continue; // skip _comment etc.
      if (STATUS_META[v]) map[k] = v;
      else if (v) console.warn(`build: unknown status "${v}" for ${k} — ignored`);
    }
    return map;
  } catch (err) {
    if (err.code !== "ENOENT") console.warn(`build: could not read ${STATUS_FILE}: ${err.message}`);
    return {};
  }
}

// Marker-wrapped tag injected into every prototype's HTML. Dormant until the
// reviewer hits Shift+C; the markers let the Download HTML button strip it so
// devs get a clean file. Absolute path => served from /dist root by the worker.
// The ?v=UI_VERSION query cache-busts the overlay: bump UI_VERSION and every
// browser refetches comments.js instead of running a stale copy. Lazy (function,
// not const) so it reads UI_VERSION, which is declared further down.
function reviewTag() {
  // graph.js (the CSS-derived composition graph) loads first so comments.js can read
  // window.__GV_GRAPH for the recursive import-chain overlay. Both deferred → ordered.
  //
  // The graph lives beside the design system it is derived FROM — <space>/skills/
  // <ds>/graph.js — not under /__review/. Two reasons, and they agree:
  //   · /__ paths are engine chrome, and the publish API refuses to let any space
  //     write one (pathOwnedBySpace). It is right to refuse: /__review/comments.js
  //     is injected into every prototype in every space, so a space able to write
  //     there could run code in another space's pages.
  //   · the graph is not shared. It is one space's design system, parsed. Serving
  //     the default space's graph to a space with its own DS was always wrong;
  //     S() makes each space load its own.
  // No DS means no graph — comments.js already falls back to an empty one.
  const graph = DS.dirName
    ? '<script src="' + S("/skills/" + DS.dirName + "/graph.js") + "?v=" + UI_VERSION + '" defer></script>'
    : "";
  return '<!--gv-review-start-->' + graph + '<script src="/__review/comments.js?v=' + UI_VERSION +
    '" defer></script><!--gv-review-end-->';
}

/** Inject the review overlay tag before </body> (or append if none). */
function injectReview(html) {
  if (html.includes("gv-review-start")) return html; // already injected
  const tag = reviewTag();
  const i = html.toLowerCase().lastIndexOf("</body>");
  return i === -1 ? html + tag : html.slice(0, i) + tag + html.slice(i);
}

/**
 * Which canonical assets a prototype is "linked" to — i.e. currently in sync with
 * the library, so the review overlay can mark the components they power as Linked.
 * An asset counts as linked when the prototype EITHER live-references it
 * (../../../skills/<ui-skill>/X — always canonical) OR carries a byte-identical
 * local copy. A drifted (forked) copy is silently excluded, so this is honest per
 * build: re-drift a copy and it drops out of the set on the next build.
 * Reads the SOURCE index.html (refs are still original there, pre-rewrite).
 */
async function computeLinkedAssets(protoDir) {
  const idx = path.join(protoDir, "index.html");
  if (!(await exists(idx))) return [];
  const html = await fs.readFile(idx, "utf8");
  if (!DS.prefix) return []; // space carries no detected UI skill → nothing canonical
  const re = new RegExp(String.raw`(?:href|src)\s*=\s*["']([^"']*\b${DS.prefix}-[^"'/]+\.(?:css|js))["']`, "gi");
  const refs = [];
  let m;
  while ((m = re.exec(html))) refs.push(m[1]);
  const linked = new Set();
  for (const ref of refs) {
    const base = ref.split("/").pop();
    const canon = path.join(UI_SKILL, base);
    if (!(await exists(canon))) continue; // not a canonical asset
    if (ref.includes(`skills/${DS.dirName}/`)) { linked.add(base); continue; } // live-linked
    try {
      const [a, b] = await Promise.all([fs.readFile(path.resolve(protoDir, ref)), fs.readFile(canon)]);
      if (a.equals(b)) linked.add(base); // byte-identical local copy = in sync
    } catch { /* missing/unreadable local copy → not linked */ }
  }
  // Follow canonical @import chains: a linked CSS that @imports another canonical
  // CSS (e.g. the ui.css @imports the primitives.css) pulls it in transitively
  // and in-sync — even though the page never <link>s it directly. Without this a
  // component whose deps include primitives.css would never badge on an FO page.
  const queue = [...linked];
  while (queue.length) {
    const base = queue.shift();
    if (!base.endsWith(".css")) continue;
    const canon = path.join(UI_SKILL, base);
    let css;
    try { css = await fs.readFile(canon, "utf8"); } catch { continue; }
    for (const m of css.matchAll(new RegExp(String.raw`@import\s+(?:url\()?["']?(${DS.prefix}-[\w.\-]+\.css)["']?`, "g"))) {
      const dep = m[1];
      if (!linked.has(dep) && (await exists(path.join(UI_SKILL, dep)))) { linked.add(dep); queue.push(dep); }
    }
  }
  return [...linked];
}

/** Stamp window.__GV_LINKED (in-sync canonical assets) into <head> for the overlay. */
function injectLinked(html, assets) {
  if (!assets || !assets.length || html.includes("__GV_LINKED")) return html;
  const tag = "<script>window.__GV_LINKED=" + JSON.stringify(assets) + ";</script>";
  const i = html.toLowerCase().indexOf("</head>");
  return i === -1 ? tag + html : html.slice(0, i) + tag + html.slice(i);
}

/**
 * Stamp __GV_LINKED into a copied demo's dist index.html, computed from the SOURCE
 * folder's canonical refs. Used by every tier (prototypes AND the library tiers:
 * pages/components/base/patterns) so the overlay marks linked components everywhere
 * — not just prototypes. Library tiers live-reference ../../skills/<ui-skill>/* so
 * every canonical asset they touch is in sync, and they get the full linked set.
 */
async function stampLinkedInto(srcDir, destDir) {
  const idxDest = path.join(destDir, "index.html");
  if (!(await exists(idxDest))) return;
  const linked = await computeLinkedAssets(srcDir);
  if (!linked.length) return;
  const h = await fs.readFile(idxDest, "utf8");
  await fs.writeFile(idxDest, injectLinked(h, linked), "utf8");
}

// Deploy-specific configuration: the site origin, the worker's MCP-proxy allowlist,
// and vanity-host redirects. Provided by the deploy shell via GV_DEPLOY_CONFIG_PATH;
// a raw engine build runs with empty defaults.
const DEPLOY_CONFIG_PATH = process.env.GV_DEPLOY_CONFIG_PATH || path.join(ROOT, "deploy.config.json");
const DEPLOY = existsSync(DEPLOY_CONFIG_PATH) ? JSON.parse(readFileSync(DEPLOY_CONFIG_PATH, "utf8")) : {};

// Absolute origin used to build absolute og:image / og:url (unfurl bots need
// absolute URLs). From the deploy config; empty → root-relative page URLs.
const SITE_ORIGIN = DEPLOY.siteOrigin || "";

// The engine's release version — package.json is the single source (git tags
// mirror it, 1.0.0 is reserved for the public launch). It rides the runtime
// config and build stamps; the worker ships verbatim and reads it from config.
const ENGINE_VERSION = (() => {
  try { return JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version || ""; }
  catch { return ""; }
})();

// Shell contract: the interface a deploy shell provides this build (config keys,
// CI duties). A shell declaring a NEWER contract than this engine knows means the
// engine pin lags a shell update that expects new behavior — warn loudly, build
// anyway (the shell's release notes say what changed).
const SHELL_CONTRACT = 1;
if ((DEPLOY.shellContract || 0) > SHELL_CONTRACT) {
  console.error(`⚠ deploy.config.json declares shellContract ${DEPLOY.shellContract}; this engine implements ${SHELL_CONTRACT} — bump the engine pin.`);
}

function escAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Inject Open Graph + Twitter card meta into a shareable page's <head> so links
 * unfurl with a title and the composed og.png card (see scripts/og.mjs).
 *   pageUrl  — absolute folder URL (the canonical share link)
 *   hasOg    — whether an og.png sits next to this file (image tags only then)
 * Skips if the page already declares its own og: tags, or has no <head>/<title>.
 */
function injectHead(html, pageUrl, hasOg) {
  if (/property=["']og:/i.test(html)) return html; // page defines its own OG
  const headClose = html.toLowerCase().indexOf("</head>");
  if (headClose === -1) return html;
  const tm = html.match(/<title>([^<]*)<\/title>/i);
  const raw = (tm ? tm[1] : "Product Prototype").trim();
  // og:title = just the prototype name (the part before the title's em-dash); the
  // rest becomes the description. Keeps the unfurl headline short, not the full
  // "Name — context (note)" page title.
  const parts = raw.split(/\s+[—–-]\s+/);
  const title = parts[0].trim();
  const subtitle = parts.slice(1).join(" — ").trim();
  const dm = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i);
  const desc = (dm ? dm[1] : subtitle) || ("Clickable design prototype" + (SPACE_NAME ? " · " + SPACE_NAME : ""));
  const img = hasOg
    ? `\n  <meta property="og:image" content="${escAttr(pageUrl + "og.jpg")}" />` +
      `\n  <meta property="og:image:width" content="1200" />` +
      `\n  <meta property="og:image:height" content="630" />` +
      `\n  <meta name="twitter:image" content="${escAttr(pageUrl + "og.jpg")}" />`
    : "";
  const tags =
    `\n  <meta property="og:type" content="website" />` +
    `\n  <meta property="og:site_name" content="Augur" />` +
    `\n  <meta property="og:title" content="${escAttr(title)}" />` +
    `\n  <meta property="og:description" content="${escAttr(desc)}" />` +
    `\n  <meta property="og:url" content="${escAttr(pageUrl)}" />` +
    `\n  <meta name="twitter:card" content="${hasOg ? "summary_large_image" : "summary"}" />` +
    `\n  <meta name="twitter:title" content="${escAttr(title)}" />` +
    `\n  <meta name="twitter:description" content="${escAttr(desc)}" />` +
    img +
    `\n  `;
  return html.slice(0, headClose) + tags + html.slice(headClose);
}

// Prepend `emoji ` to a page's <title> (idempotent). Used to stamp a prototype's
// scannable card emoji onto its browser tab so it's easy to pick out among tabs.
function prependTitleEmoji(html, emoji) {
  return html.replace(/<title>([\s\S]*?)<\/title>/i, (m, inner) => {
    const t = inner.trim();
    if (t.startsWith(emoji)) return m; // already stamped
    return `<title>${emoji} ${t}</title>`;
  });
}

// Version of the PROTOTYPES SITE UI (the landing/shell pages this file generates),
// shown in the footer. Bump this ONLY when the site UI changes — i.e. edits to
// build.js shell/CSS, the index pages, or features like carousel/comments/download.
// Do NOT bump it for changes inside individual prototypes; their content is
// versioned by their own modified date, not this number.
const UI_VERSION = "1.13";

// One id per build (ms timestamp). Baked into every page's live-reload poller AND
// into the worker's /__version endpoint, so a fresh deploy = a new id = open tabs
// notice and reload. Same value across this whole build run.
const BUILD_ID = String(Date.now());

// Top-level folders of a SPACE ROOT that are never treated as opportunity folders.
// (Belt and braces — the opportunity scan also requires a prototypes/ subdir.)
const IGNORED_TOPLEVEL = new Set([
  "node_modules",
  "skills", // the space's DS assets — shipped via the named-asset copier, not as an opportunity
  "scripts", // the space's DS pipeline tooling — never ships
  "registry", // generated per-component docs — never ships
  "pages", // composed reference pages — shipped via their own builder, not as an opportunity
  "components", // composed component library — shipped via its own builder, not as an opportunity
  "base", // base-atom demos — shipped via their own builder (Base tab), not as an opportunity
  "patterns", // curated composition demos — shipped via their own builder (Patterns tab)
  "playground", // standalone scratch prototype — shipped to /playground/, not as an opportunity
  "references", // page-source intake (raw HTML exports + screenshots) — internal, NEVER ships
  "tracks", // canvas session music — shipped verbatim + indexed into the canvas manifest
  // (a space can declare additional ignores in space.json "ignore" — see SPACE_IGNORE)
  ".git",
  ".github",
  ".claude",
]);

// Planned reference pages (Pages tab) that aren't built yet — rendered as a "Pending"
// roadmap so the team sees what's coming. NOT hardcoded here: authored PER SPACE in
// the space repo as space.json `pendingPages` (the roadmap is space content, not platform
// knowledge). Set per space by setSpaceContext(); a slug drops off once pages/<slug>/ lands.
let PENDING_PAGES = [];

// Pages index has three top-level groups: Front office, Methods, Back office.
// "Methods" are the front-office screens where a resident actually runs a
// participation method (survey, proposals, …). Any page whose slug starts with
// fo-method- or bo-method- is auto-classified "method"; a page can also opt in/out via
// <meta name="gv-surface" content="method">. Non-prefix exceptions are authored PER SPACE
// in the space repo as space.json `methodPages` (space content). Set by setSpaceContext().
let METHOD_PAGES = new Set();

// Source for the reference tabs (Primitives · Components · Pages) — assigned per space
// by setSpaceContext() from the active space root.
let UI_SKILL, PAGES_SRC, COMPONENTS_SRC, BASE_SRC, PATTERNS_SRC;
const CHANGELOG_SRC = path.join(ROOT, "changelog.md"); // hand-edited changelog source (internal; rendered to /changelog/)

// ── Overlay + gallery catalog — DERIVED from the design system's published contract
//    (each space root's registry.json), NOT hand-kept here. The platform carries no
//    product-specific names/families: swap the DS and the overlay relabels itself.
//    The DS owns the curated family→component knowledge (its build-registry); we read
//    it. Same four shapes the rest of build.js consumes:
//      COMPONENT_INDEX  family → slug                   (components/blocks)
//      BASE_INDEX       family → { label, slug }         (base atoms)
//      PATTERN_INDEX    family → { label, slug }         (curated compositions)
//      COMPONENT_BLURBS slug   → { name, classes, desc }  (gallery cards)
// (Re)loaded per space by setSpaceContext() — each space relabels the overlay from its
// own registry.json. The four shapes are exposed as ambient `let` globals below.
let COMPONENT_INDEX = {}, BASE_INDEX = {}, PATTERN_INDEX = {}, COMPONENT_BLURBS = {}, COMPONENT_META = {};
function loadCatalog(dsRoot) {
  const COMPONENT_INDEX = {}, BASE_INDEX = {}, PATTERN_INDEX = {}, COMPONENT_BLURBS = {}, COMPONENT_META = {};
  const regPath = path.join(dsRoot, "registry.json");
  // A space with no UI skill has no DS contract to publish — an empty catalog is the
  // truthful state there, not a degradation (the overlay simply has no labels to
  // offer). The REQUIRED guards below bind DS-carrying spaces only.
  if (!DS.prefix && !existsSync(regPath)) {
    return { COMPONENT_INDEX, BASE_INDEX, PATTERN_INDEX, COMPONENT_BLURBS, COMPONENT_META };
  }
  try {
    const reg = JSON.parse(readFileSync(regPath, "utf8"));
    for (const it of reg.items || []) {
      if (it.type === "page") continue;
      const fams = it.classes || (it.class ? [it.class] : []);
      const name = it.label || titleCase(it.name);
      COMPONENT_BLURBS[it.name] = {
        name,
        classes: (it.cssClasses || fams).map((f) => "." + f).join(" / "),
        desc: it.description || "",
      };
      // Curated badges/tags come straight from the DS contract (the generator emits
      // component-meta.json onto each item's `meta`) — never hardcoded in the platform.
      if (it.meta) COMPONENT_META[it.name] = it.meta;
      for (const f of fams) {
        if (it.type === "pattern") PATTERN_INDEX[f] = { label: name, slug: it.name };
        else if (it.type === "primitive") BASE_INDEX[f] = { label: name, slug: it.name };
        else COMPONENT_INDEX[f] = it.name;
      }
    }
  } catch (e) {
    // Fail-fast, no silent fallback: the overlay catalog is REQUIRED to come from the
    // DS contract. A missing/unreadable registry.json must break the build, not ship
    // an unlabeled overlay (and never tempt anyone to re-hardcode a map here).
    throw new Error("[catalog] could not read " + regPath + " — the overlay catalog is REQUIRED and has no fallback. " + e.message);
  }
  // Same guard for a present-but-empty contract (e.g. a DS that didn't publish the
  // class/label fields): refuse to build an unlabeled overlay rather than degrade.
  if (!Object.keys(COMPONENT_INDEX).length && !Object.keys(BASE_INDEX).length && !Object.keys(PATTERN_INDEX).length) {
    throw new Error("[catalog] " + regPath + " yielded an EMPTY catalog — did the DS publish class/label fields? Run `npm run registry` in the DS. Refusing to build an unlabeled overlay.");
  }
  return { COMPONENT_INDEX, BASE_INDEX, PATTERN_INDEX, COMPONENT_BLURBS, COMPONENT_META };
}

// Display name + key classes + one-line "what is it" per component, shown on the
// Components page. Keyed by folder name; `name` is the SHARED, functional display name
// (never a city — folders may be city-grounded, the name describes what it IS). This is
// the CANONICAL source of truth: the live right-click Rename / Edit-description writes a
// KV override (/__name), which is folded back here so code and live stay in one language.

// Structured per-component metadata (surface / category / status / tags / layer), shown as
// badges on the Components page. NO LONGER hardcoded here — it's authored per space in
// the space repo at the UI skill's component-meta.json and emitted onto each registry item's
// `meta`, so the platform carries no product-specific component knowledge. loadCatalog() reads
// it.meta into COMPONENT_META (per space); see the ambient `let COMPONENT_META` above.
//   surface : "fo" | "bo" | "cross"   · category: navigation|cards|banners|… · tags: source tenant + keywords
//   status  : canonical | variant | page-demo | review   · layer: "pattern" | (absent → component)

// ════════════════════════════════════════════════════════════════════════════
// Composition graph — the honesty backbone (Phase 0).
// DERIVED from the live canonical CSS (it proves the import chain rather than
// asserting it): every --gv-* token with its alias chain to a raw value + which
// tokens/classes consume it, and every .gv-*/.sv-* family with the file/LAYER that
// defines it plus the tokens its rule blocks drink. Emitted to dist/__review/graph.js
// as window.__GV_GRAPH so the review overlay can recurse tokens → base → components
// → patterns on any page. Single source of truth: edit the CSS, rebuild, graph moves.
// ════════════════════════════════════════════════════════════════════════════

// Family root of a .gv-x / .sv-x class (mirrors lint's familyRoot): strip the dot,
// the BEM element (__x), the modifier (--x), and any chained class (.y).
function familyRoot(cls) {
  return cls.replace(/^\./, "").replace(/__.*/, "").replace(/--.*/, "").replace(/\..*/, "");
}

// Canonical stylesheets → their LAYER. Order matters: a family's layer is "base"
// if primitives defines it (the atom is the source of truth), else "components".
// Names derive from the space's detected DS prefix (see setSpaceContext).
let CANON_CSS_LAYERS = [];
const canonCssLayers = (p) => [
  [`${p}-primitives.css`, "base"],
  [`${p}-ui.css`, "components"],
  [`${p}-bo.css`, "components"],
  [`${p}-survey.css`, "components"],
  [`${p}-widgets.css`, "components"],
];

// Family root → base/ demo {label, slug}. Atoms surfaced in base/<slug>/.

// Family root → components/ demo slug (label comes from COMPONENT_BLURBS). Ported
// from the old hardcoded overlay list, MINUS the atoms (now base/) and MINUS deps
// (now derived from the CSS file that defines the family).

// Curated PATTERN layer — recurring compositions promoted above components. Keyed by
// the outermost family root; overrides the file-derived component layer. Slugs map
// to patterns/<slug>/.

const readCanon = (f) => fs.readFile(path.join(UI_SKILL, f), "utf8").catch(() => "");

/**
 * Parse the canonical CSS into the composition graph. Async (reads the files).
 * Returns { tokens, classes, generatedFrom } — see the block comment above.
 */
async function buildGraph() {
  // The CSS vocabulary is the SKILL's: skill.json {"cssPrefixes": ["acme"]} names
  // the class/token prefixes its stylesheets use (classes .acme-*, tokens --acme-*).
  // Skills with no manifest get the fixed default pair below.
  let cssPrefixes = ["gv", "sv"];
  try {
    const man = JSON.parse(await readCanon("skill.json"));
    if (Array.isArray(man.cssPrefixes) && man.cssPrefixes.length) cssPrefixes = man.cssPrefixes;
  } catch { /* no manifest */ }
  const PFX = cssPrefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const tokenDeclRe = new RegExp(String.raw`(--(?:${PFX})-[\w-]+)\s*:\s*([^;]+);`, "g");
  const tokenVarRe = new RegExp(String.raw`var\(\s*(--(?:${PFX})-[\w-]+)`, "g");
  const soloVarRe = new RegExp(String.raw`^var\(\s*(--(?:${PFX})-[\w-]+)\s*\)$`);
  const famSelRe = new RegExp(String.raw`\.((?:${PFX})-[\w-]+)`);

  // ── tokens: name → declared value (first definition wins) ──────────────────
  const tokensCss = (await readCanon(`${DS.prefix}-tokens.css`)).replace(/\/\*[\s\S]*?\*\//g, "");
  const tokenVals = {};
  for (const m of tokensCss.matchAll(tokenDeclRe)) {
    if (!(m[1] in tokenVals)) tokenVals[m[1]] = m[2].trim();
  }
  const refsOf = (v) => [...new Set([...v.matchAll(tokenVarRe)].map((x) => x[1]))];
  // Resolve a token's alias chain down to the first non-(solo-var) value = its raw.
  function resolve(name, seen) {
    seen = seen || new Set();
    if (seen.has(name) || !(name in tokenVals)) return { chain: [name], raw: tokenVals[name] || null };
    seen.add(name);
    const v = tokenVals[name];
    const solo = v.match(soloVarRe);
    if (solo && solo[1] in tokenVals) {
      const nx = resolve(solo[1], seen);
      return { chain: [name, ...nx.chain], raw: nx.raw };
    }
    return { chain: [name], raw: v };
  }
  const tokens = {};
  for (const name of Object.keys(tokenVals)) {
    const r = resolve(name);
    tokens[name] = {
      value: tokenVals[name], raw: r.raw, chain: r.chain,
      refs: refsOf(tokenVals[name]), consumedBy: { tokens: [], classes: [] },
    };
  }
  for (const name of Object.keys(tokens))
    for (const ref of tokens[name].refs)
      if (tokens[ref]) tokens[ref].consumedBy.tokens.push(name);

  // ── classes: family → { layer, files, tokens } ─────────────────────────────
  const raw = {};
  for (const [file, layer] of CANON_CSS_LAYERS) {
    const css = (await readCanon(file)).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = rule[1], body = rule[2];
      const vars = [...new Set([...body.matchAll(tokenVarRe)].map((x) => x[1]))];
      // Subject family = the first prefixed class of each comma-separated part.
      const fams = new Set();
      for (const part of sel.split(",")) {
        const m = part.trim().match(famSelRe);
        if (m) fams.add(familyRoot("." + m[1]));
      }
      for (const fam of fams) {
        if (!raw[fam]) raw[fam] = { layer, files: new Set(), tokens: new Set() };
        raw[fam].files.add(file);
        if (layer === "base") raw[fam].layer = "base"; // atom source wins
        for (const v of vars) raw[fam].tokens.add(v);
      }
    }
  }

  const tierDir = (layer) => (layer === "base" ? "base" : layer === "pattern" ? "patterns" : "components");
  const classes = {};
  for (const fam of Object.keys(raw)) {
    const c = raw[fam];
    let layer = c.layer, label = null, slug = null;
    if (PATTERN_INDEX[fam]) { layer = "pattern"; label = PATTERN_INDEX[fam].label; slug = PATTERN_INDEX[fam].slug; }
    else if (BASE_INDEX[fam] && c.layer === "base") { label = BASE_INDEX[fam].label; slug = BASE_INDEX[fam].slug; }
    else if (COMPONENT_INDEX[fam]) { slug = COMPONENT_INDEX[fam]; label = (COMPONENT_BLURBS[slug] || {}).name || titleCase(slug); }
    const files = [...c.files];
    // Honesty deps: a family is "linked" only when its PRIMARY defining stylesheet +
    // tokens are in window.__GV_LINKED. We use the primary file (the one matching the
    // family's resolved layer), NOT the union of every file that touches it — a base
    // atom like .gv-btn is *extended* in ui/bo/widgets, but its source of truth is
    // primitives.css, so requiring bo+widgets would wrongly un-badge it on an FO page.
    const primaryFile = layer === "base"
      ? `${DS.prefix}-primitives.css`
      : ([`${DS.prefix}-ui.css`, `${DS.prefix}-bo.css`, `${DS.prefix}-survey.css`, `${DS.prefix}-widgets.css`].find((f) => files.includes(f)) || files[0]);
    const deps = new Set([primaryFile, `${DS.prefix}-tokens.css`]);
    const tk = [...c.tokens];
    for (const v of tk) if (tokens[v]) tokens[v].consumedBy.classes.push(fam);
    classes[fam] = {
      layer, files, deps: [...deps], tokens: tk, label, slug,
      url: slug ? `/${tierDir(layer)}/${slug}/` : null,
    };
  }
  for (const name of Object.keys(tokens)) {
    tokens[name].consumedBy.tokens = [...new Set(tokens[name].consumedBy.tokens)];
    tokens[name].consumedBy.classes = [...new Set(tokens[name].consumedBy.classes)];
  }
  return { tokens, classes, generatedFrom: CANON_CSS_LAYERS.map((x) => x[0]) };
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function isDir(p) {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Rename-aware "last worked on" dates for a whole space repo, from ONE git pass.
 *
 * Why git instead of filesystem mtime: a checkout (the CI deploy) stamps EVERY
 * file with the same checkout time, collapsing any mtime-based "most recent first"
 * ordering. Git's last-commit time is stable across checkouts, so local
 * (`npm run deploy`) and CI builds produce the same, correct order. Needs full
 * history at build time — the deploy workflow sets `fetch-depth: 0` for this.
 *
 * Two subtleties this solves:
 * 1. WHERE git runs: space content lives in its own repo (a submodule at
 *    spaces/<id>, or a sibling clone offline). Querying from Augur's repo sees
 *    nothing inside a submodule and silently falls back to checkout mtimes —
 *    every card reads "Edited just now" on CI deploys. So we run `git -C <space>`.
 * 2. Pure renames are not edits: repo restructures (spaces/<id>/* → root) rename
 *    every path, which would reset every date to the restructure day. Walking
 *    `--name-status -M` newest→oldest, an R100 entry only records the path alias
 *    (old name → current name); the date/author a path reports is its most recent
 *    NON-rename change, attributed through however many renames followed it.
 *
 * The same pass also tallies WHO works where — commits per author per path — which
 * is what the card face reports (see mainContributor): the person whose work a
 * folder mostly is, not whoever touched it last.
 *
 * Returns { file: Map<relPath, {t,email}>, dir: Map<relDirPath, {t,email}>,
 * by: Map<relPath, Map<email, {n,t}>> } or null when git/history is unavailable
 * (untracked content falls back to fs mtime).
 */
const SPACE_DATES = new Map(); // space root → parsed maps (one git pass per space per build)
function spaceDates(repoRoot) {
  if (SPACE_DATES.has(repoRoot)) return SPACE_DATES.get(repoRoot);
  let parsed = null;
  try {
    // -z: NUL-delimited (paths with spaces/quotes stay intact). Each commit emits a
    // header record "\x01<epoch> <email>" followed by status records; a rename is
    // "R<score>" NUL <old> NUL <new>.
    const raw = execFileSync("git", ["-C", repoRoot, "log", "-M", "--name-status", "-z", "--format=%x01%ct %ae"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    const alias = new Map();   // historical path → today's path
    const file = new Map();    // today's path → {t, email} of last real change
    const by = new Map();      // today's path (file OR dir) → Map<email, {n, t}> commit tally
    const cur = (p) => alias.get(p) || p;
    // Credit one commit to a path and every ancestor dir — once each, however many
    // files under it the commit touched, so "who works on this folder" counts
    // sessions of work, not file counts (a 40-file sweep isn't 40 votes).
    const credit = (paths, email, t) => {
      if (!email) return;
      const seen = new Set();
      for (const p of paths) {
        for (let d = p; d && d !== "."; d = path.dirname(d)) {
          if (seen.has(d)) break; // ancestors already credited via an earlier sibling
          seen.add(d);
          let m = by.get(d);
          if (!m) by.set(d, (m = new Map()));
          const e = m.get(email);
          // Walking newest→oldest, the first time we see an author on a path is
          // their most recent commit there — the tiebreaker for equal tallies.
          if (e) e.n++;
          else m.set(email, { n: 1, t });
        }
      }
    };
    // One chunk per commit: "<epoch> <email>" NUL then that commit's status records
    // (each record's first token carries a stray leading newline from the format).
    for (const chunk of raw.split("\x01")) {
      const cut = chunk.indexOf("\0");
      if (cut === -1) continue;
      const head = chunk.slice(0, cut).trim().split(" ");
      const t = Number(head[0]) * 1000;
      const email = (head[1] || "").toLowerCase();
      const tokens = chunk.slice(cut + 1).split("\0");
      const touched = [];
      for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i].trim();
        if (!tok) continue;
        const st = tok[0];
        if (st === "R" || st === "C") {
          const from = tokens[++i], to = tokens[++i];
          if (to === undefined) break;
          const today = cur(to);
          if (st === "R") alias.set(from, today);
          // A pure rename (R100) isn't an edit; a rename-with-change (R0xx) and any
          // copy are. Stamp only the newest occurrence (we walk newest→oldest).
          if (tok !== "R100") {
            if (!file.has(today)) file.set(today, { t, email });
            touched.push(today);
          }
        } else { // A / M / T / D — single path
          const p = tokens[++i];
          if (p === undefined) break;
          if (st === "D") continue; // deleted names don't exist today
          const today = cur(p);
          if (!file.has(today)) file.set(today, { t, email });
          touched.push(today);
        }
      }
      credit(touched, email, t);
    }
    // Bubble file stamps up to every ancestor dir (max wins) so folder lookups are O(1).
    const dir = new Map();
    for (const [p, v] of file) {
      let d = path.dirname(p);
      while (d && d !== ".") {
        const prev = dir.get(d);
        if (!prev || v.t > prev.t) dir.set(d, v);
        d = path.dirname(d);
      }
    }
    parsed = { file, dir, by };
  } catch { parsed = null; }
  SPACE_DATES.set(repoRoot, parsed);
  return parsed;
}

// Look up a path's last real change within the ACTIVE space (WS_ROOT is the space
// repo root, ambient per build pass). Paths outside the space or untracked → null.
function dateFor(absPath) {
  const dates = WS_ROOT ? spaceDates(WS_ROOT) : null;
  if (!dates) return null;
  const rel = path.relative(WS_ROOT, absPath);
  if (!rel || rel.startsWith("..")) return null;
  return dates.file.get(rel) || dates.dir.get(rel) || null;
}

/**
 * The "last worked on" time (ms) for a copied folder: git last-real-change time
 * when available (rename-transparent, see spaceDates), else the latest filesystem
 * mtime within it (covers new/untracked folders that have no commit yet). This is
 * the sort key for every listing.
 */
function modifiedTime(srcDir, fsLatest) {
  const d = dateFor(srcDir);
  return (d && d.t) || fsLatest;
}

/**
 * The "face" on a card: the folder's MAIN contributor — the known user with the most
 * commits touching it — not whoever happened to push last. A folder is someone's
 * work; a passing tweak by a colleague shouldn't hand them the card. Ties (equal
 * commit counts) go to whoever worked on it most recently.
 *
 * Counts are per USER, not per email: people commit from several machines/addresses,
 * so every address a user lists (identity `emails`) folds into one tally. Unknown
 * addresses are ignored rather than shown as a blank — a folder whose top committer
 * has no account still shows the next person who does. Returns a public profile, or
 * null (uncommitted folder, or nobody we know has touched it).
 */
function mainContributor(absDir) {
  return contributors(absDir)[0] || null;
}

/**
 * EVERY known contributor to a folder, most commits first (ties → most recent).
 * Same per-user folding as mainContributor; the root-index face pile renders the
 * whole list, capped for weight.
 */
function contributors(absDir) {
  const dates = WS_ROOT ? spaceDates(WS_ROOT) : null;
  if (!dates) return [];
  const rel = path.relative(WS_ROOT, absDir);
  if (!rel || rel.startsWith("..")) return [];
  const tally = dates.by.get(rel);
  if (!tally) return [];
  const byUser = new Map(); // public profile → {n, t}
  for (const [email, v] of tally) {
    const u = USER_BY_EMAIL.get(email);
    if (!u) continue;
    const acc = byUser.get(u);
    if (acc) { acc.n += v.n; acc.t = Math.max(acc.t, v.t); }
    else byUser.set(u, { n: v.n, t: v.t });
  }
  return [...byUser.entries()]
    .sort((a, b) => b[1].n - a[1].n || b[1].t - a[1].t)
    .map(([u]) => u);
}

/** Latest filesystem mtime (ms) of any file within a directory tree. */
async function latestMtime(dir) {
  let latest = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) latest = Math.max(latest, await latestMtime(p));
    else if (e.isFile()) latest = Math.max(latest, (await fs.stat(p)).mtimeMs);
  }
  return latest;
}

/**
 * Sort a list of {name, mtimeMs} most-recently-worked-on first, with a stable,
 * deterministic name tiebreaker so items sharing a commit (e.g. scaffolded
 * together) keep a predictable A→Z order instead of relying on readdir order.
 */
function byRecency(a, b) {
  return b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name);
}

// Order prototype cards by dev status (Dev ready → In progress → unset → Ignore),
// falling back to recency within a status group.
function byStatusThenRecency(a, b) {
  const ra = a.status in STATUS_RANK ? STATUS_RANK[a.status] : STATUS_RANK_UNSET;
  const rb = b.status in STATUS_RANK ? STATUS_RANK[b.status] : STATUS_RANK_UNSET;
  return ra - rb || byRecency(a, b);
}

// Secret-shaped filenames that must NEVER reach dist — env files, private keys, and
// credential dumps. A shipped folder (prototypes/, playground/) serves verbatim and
// its paths are public and un-gated, so a stray `.env` or `*.pem` dropped inside one
// would be world-readable. This is the single authoritative boundary: publish and
// deploy both ship dist, so filtering here closes the leak for every ship path.
// `\.env$` catches the other naming half (prod.env, local.env) — same file, dot on the
// other side. The dotfile list is credential stores by definition; none of them has any
// business in a published folder, and publish ships the WORKING TREE, so a file that was
// never committed has never met .gitignore either.
const SECRET_FILE_RE = /(^\.env(\.|$)|\.env$|\.(pem|key|p12|pfx|ppk|keystore|jks)$|(^|[._-])(secret|secrets|credentials?)([._-]|$)|^id_(rsa|dsa|ecdsa|ed25519)$|^\.(npmrc|netrc|pgpass|htpasswd|ssh|aws|gnupg)$)/i;

// Version-control directories. copyDir RECURSES, so a repo checked out inside a shipped
// folder would publish its whole history — every past commit, every file ever deleted —
// at a public URL. Never content, under any layout.
const VCS_DIR_RE = /^\.(git|hg|svn|bzr)$/i;

// Internal-only entries that must NEVER be copied into dist, even from a folder
// (like playground/) that otherwise ships verbatim. Mirrors the repo guardrail:
// research/context material stays on the machine, never deployed.
function isInternalOnly(name) {
  return (
    name === "research" ||
    name === "context" ||
    name === "research.md" ||
    name === "context.md" ||
    name === ".DS_Store" ||
    name.endsWith(".zip") ||
    VCS_DIR_RE.test(name) ||
    SECRET_FILE_RE.test(name)
  );
}

/**
 * Recursively copy a directory. Returns the latest mtime (ms) seen within it.
 * `exclude(name)` → true skips an entry (used to keep internal material out of
 * dist when copying a ship-verbatim folder like playground/).
 */
async function copyDir(src, dest, exclude, titleEmoji) {
  await fs.mkdir(dest, { recursive: true });
  let latest = 0;
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (exclude && exclude(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      latest = Math.max(latest, await copyDir(srcPath, destPath, exclude, titleEmoji));
    } else if (entry.isFile()) {
      if (entry.name.endsWith(".html")) {
        let html = await fs.readFile(srcPath, "utf8");
        // Live-link rewrite: a prototype that IMPORTS canonical assets references
        // them as ../../../skills/<ui-skill>/X (resolves on disk when opened
        // directly). In dist the shared export lives at <space>/skills/<ui-skill>/, so
        // repoint any such ref to the correct dist-relative path. Targets the ACTIVE
        // space's skills (DIST_SPACE) — each space ships its own copy, so a /<id>/-
        // prefixed space links its own DS, not the default's. Depth-aware (computed from
        // this file's dist dir) and idempotent for the library tiers.
        if (DS.dirName) {
          const relCanon = path.relative(dest, path.join(DIST_SPACE, "skills", DS.dirName)).split(path.sep).join("/");
          html = html.replace(new RegExp(String.raw`(?:\.\.\/)+skills\/${DS.dirName}\/`, "g"), relCanon + "/");
        }
        // OG/Twitter unfurl tags for the shareable entry page (index.html). The
        // composed card (og.png, see scripts/og.mjs) sits beside it when shot.
        if (entry.name === "index.html") {
          const rel = path.relative(DIST, dest).split(path.sep).map(encodeURIComponent).join("/");
          const pageUrl = `${SITE_ORIGIN}/${rel}${rel ? "/" : ""}`;
          const hasOg = await exists(path.join(src, "og.jpg"));
          html = injectHead(html, pageUrl, hasOg);
        }
        // Prefix the prototype's scannable card emoji to the browser-tab <title>,
        // so an open tab is easy to spot among many. Only set for prototypes.
        if (titleEmoji) html = prependTitleEmoji(html, titleEmoji);
        await fs.writeFile(destPath, addonHtml(injectReview(html)), "utf8");
      } else {
        await fs.copyFile(srcPath, destPath);
      }
      const st = await fs.stat(srcPath);
      latest = Math.max(latest, st.mtimeMs);
    }
  }
  return latest;
}

/**
 * Resolve a prototype's entry point, RELATIVE to its opportunity page.
 *   href -> for opening / iframe preview (folder when an index.html exists)
 *   file -> the concrete HTML file, for the Download HTML button
 * Prefers index.html, else the first .html found.
 */
async function entryPoint(prototype, protoDir) {
  const base = `${encodeURIComponent(prototype)}/`;
  if (await exists(path.join(protoDir, "index.html"))) {
    return { href: base, file: `${base}index.html` };
  }
  const entries = await fs.readdir(protoDir, { withFileTypes: true });
  const html = entries.find((e) => e.isFile() && e.name.endsWith(".html"));
  if (html) {
    const f = `${base}${encodeURIComponent(html.name)}`;
    return { href: f, file: f };
  }
  return { href: base, file: null };
}

// A prototype's one-line agent-facing description = its own <meta name="description">.
// The ARTIFACT owns its meaning (updated in the same commit that changes it — never cached
// on a canvas tile, where it silently goes stale); the insert-picker catalog carries it so
// a board-reading agent can triage tiles without opening every prototype. Decision record:
// proposals/canvas-node-descriptions.md; write contract: CANVAS.md "Node schemas".
async function metaDesc(htmlPath) {
  if (!htmlPath) return null;
  try {
    const html = await fs.readFile(htmlPath, "utf8");
    // the content char-class must exclude ONLY the active delimiter — [^"'] would truncate
    // a double-quoted description at its first apostrophe ("the editor's wall of tabs")
    const m = html.match(/<meta\s+name=["']description["']\s+content="([^"]*)"/i)
      || html.match(/<meta\s+name=["']description["']\s+content='([^']*)'/i)
      || html.match(/<meta\s+content="([^"]*)"\s+name=["']description["']/i)
      || html.match(/<meta\s+content='([^']*)'\s+name=["']description["']/i);
    return m && m[1].trim() ? m[1].trim() : null;
  } catch (e) { return null; }
}

// Enumerate an opportunity's internal research/context docs — NAMES + mtime only,
// never content. Walks the opportunity folder for .md files outside prototypes/ and
// _archive/. Surfaced (gated, on the index pages) so you can see what context exists
// per opportunity at a glance; the files themselves are never copied to dist.
async function scanResearch(oppDir) {
  const out = [];
  async function walk(dir, rel) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) {
        if (e.name === "prototypes" || e.name === "_archive") continue;
        await walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
      } else if (e.name.endsWith(".md")) {
        const full = path.join(dir, e.name);
        const st = await fs.stat(full).catch(() => null);
        if (st) out.push({ name: rel ? `${rel}/${e.name}` : e.name, mtimeMs: st.mtimeMs });
      }
    }
  }
  await walk(oppDir, "");
  // research.md + context.md float to the top, then the rest A→Z.
  const rank = (n) => (n === "research.md" ? 0 : n === "context.md" ? 1 : 2);
  out.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
  return out;
}

async function scan() {
  const opportunities = [];
  const topEntries = await fs.readdir(WS_ROOT, { withFileTypes: true });
  const statusMap = await loadStatusMap();

  for (const top of topEntries) {
    if (!top.isDirectory()) continue;
    if (IGNORED_TOPLEVEL.has(top.name) || SPACE_IGNORE.has(top.name) || top.name.startsWith(".")) continue;

    const protoParent = path.join(WS_ROOT, top.name, "prototypes");
    if (!(await isDir(protoParent))) continue;

    const protoEntries = await fs.readdir(protoParent, { withFileTypes: true });
    const prototypes = [];

    for (const proto of protoEntries) {
      if (!proto.isDirectory()) continue;
      const protoDir = path.join(protoParent, proto.name);

      // Copy ONLY the prototype folder into dist (under the active space).
      const destDir = path.join(DIST_SPACE, top.name, proto.name);
      // Exclude internal material (research/ + context/ folders, *.zip, .DS_Store)
      // that sometimes sits inside a prototype folder — it must never reach dist.
      const latest = await copyDir(protoDir, destDir, isInternalOnly, protoEmoji(proto.name));

      // Stamp which canonical assets this prototype is in sync with, so the review
      // overlay can mark the components they power as "Linked" (computed fresh each
      // build, so a drifted copy honestly drops out). Entry-point HTML only.
      await stampLinkedInto(protoDir, destDir);

      const { href, file } = await entryPoint(proto.name, protoDir);
      prototypes.push({
        name: proto.name,
        href,
        file,
        desc: await metaDesc(file ? path.join(protoParent, decodeURIComponent(file)) : null),
        poster: await exists(path.join(protoDir, "preview.webp")),
        mtimeMs: modifiedTime(protoDir, latest),
        status: statusMap[`${SPACE_KEY}${top.name}/${proto.name}`] || null,
        editor: mainContributor(protoDir),
      });
    }

    if (prototypes.length === 0) continue;

    prototypes.sort(byStatusThenRecency);
    opportunities.push({
      name: top.name,
      prototypes,
      research: await scanResearch(path.join(WS_ROOT, top.name)),
      people: contributors(path.join(WS_ROOT, top.name)),
      mtimeMs: Math.max(...prototypes.map((p) => p.mtimeMs)),
    });
  }

  // Most-recently-worked-on opportunity first.
  opportunities.sort(byRecency);
  return opportunities;
}

/**
 * Scan the top-level pages/ folder for composed reference pages. Each subfolder
 * is a self-contained page (like a prototype) shipped under /pages/<name>/.
 */
async function scanPages() {
  if (!(await isDir(PAGES_SRC))) return [];
  const entries = await fs.readdir(PAGES_SRC, { withFileTypes: true });
  const pages = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(PAGES_SRC, e.name);
    const destDir = path.join(DIST_SPACE, "pages", e.name);
    const latest = await copyDir(dir, destDir, isInternalOnly);
    await stampLinkedInto(dir, destDir); // overlay badges on Pages (live-linked → full set)
    const { href, file } = await entryPoint(e.name, dir);
    // Surface = back-office (the product's own theme), front-office (city-themed),
    // method (a front-office participation-method runner — its own Pages group), or
    // upsell (a locked-feature promo screen — its own Pages group).
    // fo-method-* and bo-method-* slugs are auto-classified as "method". Add
    // exceptions to METHOD_PAGES. Let <meta name="gv-surface"> override any of these.
    let surface = /^bo-/.test(e.name) ? "back-office" : "front-office";
    if (METHOD_PAGES.has(e.name) || /^(?:fo|bo)-method-/.test(e.name)) surface = "method";
    try {
      // entryPoint's `file` is URL-relative ("<name>/<entry>") — resolve it against
      // the pages source dir (reading it bare silently threw and disabled the
      // gv-surface override for every page).
      const html = await fs.readFile(path.join(PAGES_SRC, decodeURIComponent(file)), "utf8");
      const m = html.match(/<meta\s+name=["']gv-surface["']\s+content=["']([^"']+)["']/i);
      if (m) {
        const v = m[1].toLowerCase();
        surface = /upsell/.test(v) ? "upsell" : /back/.test(v) ? "back-office" : /method/.test(v) ? "method" : "front-office";
      }
    } catch {}
    pages.push({ name: e.name, href, file, surface, poster: await exists(path.join(dir, "preview.webp")), mtimeMs: modifiedTime(dir, latest) });
  }
  pages.sort(byRecency);
  return pages;
}

/**
 * Scan the top-level components/ folder for composed component demos. Each
 * subfolder is a self-contained demo (like a page) shipped under /components/<name>/.
 * The manifest.md (a file, not a dir) is internal and intentionally not shipped.
 */
async function scanComponents() {
  if (!(await isDir(COMPONENTS_SRC))) return [];
  const entries = await fs.readdir(COMPONENTS_SRC, { withFileTypes: true });
  const components = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(COMPONENTS_SRC, e.name);
    const destDir = path.join(DIST_SPACE, "components", e.name);
    const latest = await copyDir(dir, destDir, isInternalOnly);
    await stampLinkedInto(dir, destDir); // overlay badges on the component demo itself
    const { href, file } = await entryPoint(e.name, dir);
    components.push({ name: e.name, href, file, poster: await exists(path.join(dir, "preview.webp")), mtimeMs: modifiedTime(dir, latest) });
  }
  components.sort(byRecency);
  return components;
}

/**
 * Scan a flat library tier (base/ or patterns/) — each subfolder is a self-contained
 * demo like components/<name>/. Copies + stamps __GV_LINKED so the overlay recurses
 * on these pages too. Returns the same {name, href, file, poster, mtimeMs} shape.
 */
async function scanTier(srcRoot, distSub) {
  if (!(await isDir(srcRoot))) return [];
  const entries = await fs.readdir(srcRoot, { withFileTypes: true });
  const items = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(srcRoot, e.name);
    const destDir = path.join(DIST_SPACE, distSub, e.name);
    const latest = await copyDir(dir, destDir, isInternalOnly);
    await stampLinkedInto(dir, destDir);
    const { href, file } = await entryPoint(e.name, dir);
    items.push({ name: e.name, href, file, poster: await exists(path.join(dir, "preview.webp")), mtimeMs: modifiedTime(dir, latest) });
  }
  items.sort(byRecency);
  return items;
}
const scanBase = () => scanTier(BASE_SRC, "base");
const scanPatterns = () => scanTier(PATTERNS_SRC, "patterns");

/**
 * Scan playground/<project>/ subfolders. Playground is workspace material — a
 * scratch opportunity living in the space repo's playground/ (WS_ROOT), not augur.
 * Each subfolder is a self-contained prototype (its own index.html). The whole
 * playground/ tree is copied verbatim elsewhere (copyDir) — this only reads the
 * subfolders to render the Playground landing, so adding a folder = it appears.
 * hrefs are relative to dist/playground/index.html.
 */
async function scanPlayground() {
  const root = path.join(WS_ROOT, "playground");
  if (!(await isDir(root))) return [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  const statusMap = await loadStatusMap();
  const projects = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const dir = path.join(root, e.name);
    const { href, file } = await entryPoint(e.name, dir);
    // Playground projects carry a dev-status chip like opportunity prototypes, but
    // default to "in-progress" (not unset/ignore) — a scratch folder is presumed
    // active work until marked otherwise. The committed JSON still overrides.
    projects.push({
      name: e.name,
      href,
      file,
      desc: await metaDesc(file ? path.join(root, decodeURIComponent(file)) : null),
      poster: await exists(path.join(dir, "preview.webp")),
      mtimeMs: modifiedTime(dir, await latestMtime(dir)),
      status: statusMap[`${SPACE_KEY}playground/${e.name}`] || "in-progress",
      editor: mainContributor(dir),
    });
  }
  projects.sort(byStatusThenRecency);
  return projects;
}

// Slug words that should render fully upper-cased (acronyms) rather than
// Capitalized — so `sms-verification` reads "SMS Verification", not "Sms …".
const ACRONYMS = new Set(["sms", "ui", "ux", "uxui", "api", "url", "faq", "sso", "cta", "pdf", "csv", "riot", "fo", "bo"]);

function titleCase(slug) {
  return slug
    .replace(/[-_]/g, " ")
    .replace(/\S+/g, (w) =>
      ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)
    );
}

function fmtDate(ms) {
  if (!ms) return "";
  return new Date(ms).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// Relative "Edited N <unit> ago" label, computed at build time against now.
// Weeks are intentionally skipped so the day bucket runs all the way to a month
// ("Edited 20 days ago", not "2 weeks ago"). Months/years are calendar-approx
// (30/365 days) — fine for a listing label. Pair with fmtDate() in a title=…
// for the exact date on hover.
function relTime(ms) {
  if (!ms) return "";
  const sec = Math.round(Math.max(0, Date.now() - ms) / 1000);
  const units = [
    ["year", 31536000],
    ["month", 2592000],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [name, s] of units) {
    const v = Math.floor(sec / s);
    if (v >= 1) return `Edited ${v} ${name}${v > 1 ? "s" : ""} ago`;
  }
  return "Edited just now";
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// Self-hosted Inter (one variable woff2, all weights) — replaces the render-blocking
// Google Fonts link. font-display:swap shows the system fallback until it loads (no
// FOIT). Shared by the shell pages and the injected Primitives-gallery skin.
const FONT_CSS = `
    @font-face {
      font-family: "Inter";
      font-style: normal;
      font-weight: 100 900;
      font-display: swap;
      src: url("/fonts/inter-latin-wght-normal.woff2") format("woff2");
    }
    /* LentiaNova — the Augur display/title face (City of Linz tenant font). Bundled
       from the Linz capture, shipped to /fonts/ in main(). Three cuts: Neutral 400,
       Median 600 (section titles), Bulky 800 (the brand wordmark). */
    @font-face {
      font-family: "LentiaNova";
      font-style: normal;
      font-weight: 400;
      font-display: swap;
      src: url("/fonts/lentianova.woff2") format("woff2");
    }
    @font-face {
      font-family: "LentiaNova";
      font-style: normal;
      font-weight: 600;
      font-display: swap;
      src: url("/fonts/lentianova-median.otf") format("opentype");
    }
    @font-face {
      font-family: "LentiaNova";
      font-style: normal;
      font-weight: 800;
      font-display: swap;
      src: url("/fonts/lentianova-bulky.otf") format("opentype");
    }`;

const PAGE_CSS = `
    /* Linear-style shell — light edition: near-white canvas, indigo accent, Inter type.
       This is the TOOLING UI; a light shell sits comfortably next to a light product brand. */
    :root {
      --bg: #fbfbfd;          /* page canvas */
      --bg-2: #f3f4f7;        /* subtle inset / preview backing */
      --card: #ffffff;        /* card surface */
      --card-hover: #fafafc;
      --fg: #16171a;          /* primary text */
      --muted: #5b626e;       /* secondary text (AA on white) */
      --faint: #6b7280;       /* tertiary (AA-safe for small labels) */
      --line: rgba(16,17,26,0.09);
      --line-2: rgba(16,17,26,0.15);
      --accent: #5159c9;      /* indigo, darkened for AA as text/icon on white */
      --accent-solid: #5e6ad2;/* Linear indigo (fills) */
      --radius: 12px;
      --maxw: 1080px;
      --font-display: "LentiaNova", "Inter", -apple-system, BlinkMacSystemFont, sans-serif;
      color-scheme: light;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 15px/1.55 "Inter", "Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg); color: var(--fg);
      -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
      letter-spacing: -0.011em;
      overflow-x: clip; /* guard against any full-bleed element adding a horizontal scrollbar */
    }
    /* Signature: a faint indigo wash behind the hero, fixed so it doesn't scroll. */
    body::before {
      content: ""; position: fixed; inset: 0; z-index: 0; pointer-events: none;
      background:
        radial-gradient(940px 440px at 14% -12%, rgba(94,106,210,0.10), transparent 60%),
        radial-gradient(700px 420px at 98% -6%, rgba(140,99,210,0.07), transparent 55%);
    }
    /* Top padding aligns the folderbar title's optical centre with the sidebar
       "Augur" brand row (~26px) so the two share one clean top band. */
    .wrap { position: relative; z-index: 1; max-width: var(--maxw); margin: 0 auto; padding: 15px 24px 110px; }
    .back {
      display: inline-flex; align-items: center; gap: 6px; margin-bottom: 30px; color: var(--muted);
      text-decoration: none; font-size: 13.5px; font-weight: 500;
      transition: color .12s ease;
    }
    .back:hover { color: var(--fg); }
    /* Hero — large, tight, with a small eyebrow */
    .eyebrow {
      display: inline-flex; align-items: center; gap: 7px; margin-bottom: 16px;
      font-size: 12px; font-weight: 560; letter-spacing: .04em; text-transform: uppercase;
      color: var(--muted);
    }
    .eyebrow::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 10px 1px var(--accent); }
    h1 { font-size: 40px; line-height: 1.05; font-weight: 600; margin: 0 0 10px; letter-spacing: -0.03em; }
    .subtitle { color: var(--muted); margin: 0 0 30px; font-size: 16px; max-width: 56ch; }
    .section-eyebrow {
      font-size: 12px; font-weight: 560; letter-spacing: .05em; text-transform: uppercase;
      color: var(--faint); margin: 0 0 14px;
    }
    /* Folder bar — compact one-line header (Linear list-view idiom): up-link,
       title, count, then a dashed rule running to the edge. Tight + app-like. */
    .folderbar { display: flex; align-items: center; gap: 10px; margin: 0 0 20px; }
    .folderbar__up {
      display: inline-grid; place-items: center; width: 24px; height: 24px;
      margin-left: -3px; border-radius: 7px; color: var(--faint); flex: none;
      transition: background .12s ease, color .12s ease;
    }
    .folderbar__up:hover { background: var(--bg-2); color: var(--fg); }
    .folderbar__up:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .folderbar__up svg { width: 16px; height: 16px; }
    .folderbar__title { font-family: var(--font-display); font-size: 16px; font-weight: 600; letter-spacing: 0; margin: 0; color: var(--fg); white-space: nowrap; }
    .folderbar__count {
      flex: none; font-size: 12px; font-weight: 560; color: var(--faint);
      background: var(--bg-2); border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px;
    }
    .folderbar__rule { flex: 1; height: 0; border-top: 1px dashed var(--line-2); margin-left: 2px; }
    /* "+ New canvas" folderbar action — hidden until NEWCANVAS_JS confirms a
       signed-in user (or an open/no-identity build). */
    .folderbar__new {
      flex: none; font: inherit; font-size: 12.5px; font-weight: 550; cursor: pointer;
      display: inline-flex; align-items: center; gap: 5px; padding: 5px 11px;
      border: 1px solid var(--line-2); border-radius: 999px; background: transparent; color: var(--muted);
      transition: background .12s ease, border-color .12s ease, color .12s ease;
    }
    .folderbar__new:hover { background: var(--card-hover); border-color: var(--accent); color: var(--fg); }
    .folderbar__new:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .folderbar__new svg { width: 13px; height: 13px; }
    /* Created-canvas cards (injected by NEWCANVAS_JS from the /__canvases KV map):
       the preview is a dotted whiteboard that NEWCANVAS_JS fills with a live SVG
       mini-map of the board doc — colored rects per node, marker strokes as
       polylines. An empty/unreachable board keeps the map-emoji ghost. */
    .preview--canvas {
      background-image: radial-gradient(circle, var(--line-2) 1px, transparent 1.4px);
      background-size: 16px 16px;
    }
    .preview--canvas .canvas-map {
      position: absolute; inset: 0;
      display: grid; place-items: center; font-size: 40px;
    }
    .preview--canvas .canvas-map svg { display: block; width: 100%; height: 100%; }
    .empty { color: var(--muted); }

    /* Research/context surface — quiet gated metadata (count + filenames). Colour stays
       on the cover + status; this reads as metadata, not a CTA. */
    .research-wrap { position: relative; flex: none; }
    .research-chip, .research-tag {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: 12px; font-weight: 560; color: var(--faint);
      background: var(--bg-2); border: 1px solid var(--line);
      border-radius: 999px; padding: 1px 8px 1px 6px; line-height: 1.55;
    }
    .research-chip { cursor: pointer; transition: color .12s ease, border-color .12s ease; }
    .research-chip:hover { color: var(--fg); border-color: var(--line-2); }
    .research-chip[aria-expanded="true"] { color: var(--fg); border-color: var(--accent); }
    .research-chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .research-chip .gvic, .research-tag .gvic { width: 13px; height: 13px; opacity: .85; }
    .research-tag { pointer-events: none; }
    .research-pop {
      position: absolute; top: calc(100% + 6px); right: 0; z-index: 40;
      min-width: 224px; max-width: 320px; padding: 7px;
      background: var(--card); border: 1px solid var(--line); border-radius: 11px;
      box-shadow: 0 10px 30px rgba(16,17,26,0.16);
    }
    .research-pop__head { font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); padding: 2px 6px 7px; }
    .research-pop__list { list-style: none; margin: 0; padding: 0; }
    .research-pop__list li { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; padding: 4px 6px; border-radius: 6px; }
    .research-pop__list li + li { margin-top: 1px; }
    .research-pop__name { color: var(--fg); font-size: 12.5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
    .research-pop__date { color: var(--faint); font-size: 11px; flex: none; white-space: nowrap; }
    /* Landing card: title row so the static tag sits at the far right of the title. */
    .opp-name-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .opp-name-row .proto-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* Contributor face pile (root project cards) — overlapping, capped in facePile(). */
    .opp-people { display: inline-flex; align-items: center; flex: none; padding-left: 4px; }
    .opp-face { width: 20px; height: 20px; font-size: 8.5px; margin-left: -6px; }
    .opp-face:first-child { margin-left: 0; }
    .opp-face--more { background: var(--bg-2); color: var(--muted); font-size: 9px; }

    /* ---- Collapsible Pages sections (native <details>) ---- */
    details.fsection { margin: 0; }
    details.fsection + details.fsection { margin-top: 34px; }
    summary.section-eyebrow {
      display: inline-flex; align-items: center; gap: 8px; width: fit-content;
      cursor: pointer; user-select: none; list-style: none;
      transition: color .12s ease;
    }
    summary.section-eyebrow::-webkit-details-marker { display: none; }
    summary.section-eyebrow::marker { content: ""; }
    summary.section-eyebrow:hover { color: var(--muted); }
    summary.section-eyebrow:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 4px; }
    .fsection__caret {
      width: 0; height: 0; flex: none;
      border-style: solid; border-width: 4px 0 4px 6px;
      border-color: transparent transparent transparent currentColor;
      transition: transform .15s ease; opacity: .8;
    }
    details.fsection[open] > summary .fsection__caret { transform: rotate(90deg); }

    /* ---- In-page real-time filter (driven by the rail's omni search) ---- */
    .is-fhidden { display: none !important; }
    .filter-empty { color: var(--muted); font-size: 14.5px; margin: 6px 0 0; }
    .playground {
      display: flex; align-items: center; gap: 18px; margin-top: 18px; padding: 18px 20px;
      background: var(--card); border: 1px solid var(--line); border-radius: var(--radius);
      text-decoration: none; color: inherit;
      transition: border-color .15s ease, background .15s ease, transform .15s ease;
    }
    .playground:hover { border-color: var(--line-2); background: var(--card-hover); transform: translateY(-1px); }
    .playground:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
    .playground__icon {
      display: grid; place-items: center; width: 44px; height: 44px; flex: none; font-size: 22px;
      border-radius: 10px; background: var(--bg-2); border: 1px solid var(--line);
    }
    .playground__text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .playground__name { font-size: 15.5px; font-weight: 600; letter-spacing: -0.01em; }
    .playground__desc { color: var(--muted); font-size: 13.5px; }
    .playground__go { margin-left: auto; font-size: 22px; color: var(--faint); flex: none; transition: color .15s, transform .15s; }
    .playground:hover .playground__go { color: var(--fg); transform: translateX(2px); }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }

    /* ---- Cards & live previews ---- */
    .card-opp, .card-proto {
      display: block; background: var(--card); border: 1px solid var(--line);
      border-radius: var(--radius); overflow: hidden;
      text-decoration: none; color: inherit;
    }
    .card-opp { transition: box-shadow .2s ease, transform .2s ease, border-color .2s ease; }
    .card-opp:hover {
      border-color: var(--line-2);
      box-shadow: 0 14px 34px -16px rgba(16,24,40,0.30), 0 0 0 1px rgba(94,106,210,0.22);
      transform: translateY(-3px);
    }
    .preview {
      position: relative; width: 100%; aspect-ratio: 16 / 10; overflow: hidden;
      background: var(--bg-2); border-bottom: 1px solid var(--line);
    }
    .preview iframe {
      position: absolute; top: 0; left: 0; width: 1280px; height: 800px; border: 0;
      transform-origin: top left; pointer-events: none;
    }
    /* Poster image (the fast path): a pre-rendered WebP that fills the 16:10 tile.
       Same source aspect as the box, so object-fit: cover is an exact, crop-free fit. */
    .preview-img, .comp-thumb img {
      position: absolute; inset: 0; width: 100%; height: 100%; border: 0;
      object-fit: cover; object-position: top center; pointer-events: none;
    }
    /* ---- Preview skeleton ----
       Previews start hidden over a shimmering skeleton and cross-fade in once their
       media fires its load event (JS adds .is-loaded). For live iframes this also
       hides the brief external-CSS FOUC; for posters it's just a tidy fade-in. */
    .preview iframe, .preview-img, .comp-thumb iframe, .comp-thumb img { opacity: 0; transition: opacity .35s ease; }
    .preview.is-loaded iframe, .preview.is-loaded .preview-img, .comp-thumb.is-loaded iframe, .comp-thumb.is-loaded img { opacity: 1; }
    .preview:not(.preview--pending)::after, .comp-thumb::after {
      content: ""; position: absolute; inset: 0; z-index: 1; pointer-events: none;
      background: linear-gradient(90deg, var(--bg-2) 25%, #f8f9fc 50%, var(--bg-2) 75%);
      background-size: 200% 100%;
      animation: gv-skeleton 1.3s ease-in-out infinite;
      transition: opacity .35s ease;
    }
    .preview.is-loaded::after, .comp-thumb.is-loaded::after { opacity: 0; }
    @keyframes gv-skeleton { from { background-position: 200% 0; } to { background-position: -200% 0; } }
    @media (prefers-reduced-motion: reduce) {
      .preview::after, .comp-thumb::after { animation: none; }
      .preview iframe, .preview-img, .comp-thumb iframe, .comp-thumb img { transition: none; }
    }
    .preview-link { position: absolute; inset: 0; z-index: 2; }
    /* Download icon overlays the preview image, top-right, above the cover link.
       A translucent white backdrop keeps it legible over any screenshot. */
    .preview-actions { position: absolute; top: 8px; right: 8px; z-index: 3; display: flex; gap: 6px; }
    .preview-actions .btn-icon {
      background: rgba(255,255,255,0.92); border-color: rgba(16,24,40,0.14); color: #1d2333;
      box-shadow: 0 2px 8px -2px rgba(16,24,40,0.30); backdrop-filter: blur(4px);
    }
    .preview-actions .btn-icon:hover { background: #fff; border-color: var(--accent); }
    /* Star toggle — small white rounded square. Hidden until the card is hovered
       (or focused) when UNpinned; once pinned, it stays visible with a gold star and
       a plain neutral border (no yellow ring). */
    /* Matched footprint with the status glyph (24px white disc, same shadow) so the
       two card-corner controls read as a pair, not two unrelated widgets. */
    .pin-btn {
      width: 24px; height: 24px; min-width: 24px; padding: 0; cursor: pointer;
      display: inline-grid; place-items: center; border-radius: 50%;
      background: #fff; border: 0; color: #9aa0aa;
      box-shadow: 0 2px 8px -1px rgba(16,24,40,0.32);
      opacity: 0; transition: opacity .12s ease, color .12s ease, transform .12s ease;
    }
    .card-proto:hover .pin-btn, .card-opp:hover .pin-btn,
    .pin-btn:focus-visible, .pin-btn.is-pinned { opacity: 1; }
    @media (hover: none) { .pin-btn { opacity: 1; } }
    .pin-btn:hover { color: #6b7280; transform: scale(1.1); }
    .pin-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .pin-btn .pin-star { width: 14px; height: 14px; display: block; }
    .pin-btn.is-pinned .pin-star { fill: #f4b740; color: #f4b740; }
    @media (prefers-reduced-motion: reduce) { .pin-btn { transition: none; } }
    .opp-meta, .proto-meta { padding: 12px 14px; }
    .proto-meta {
      display: flex; align-items: flex-start; justify-content: space-between;
      gap: 12px; flex-wrap: wrap;
    }
    .proto-text { min-width: 0; flex: 1 1 auto; }
    /* Title + date share a size (file-row pattern); weight + colour carry the
       hierarchy, not scale. Kept small for app-like density. */
    .proto-name { font-weight: 600; font-size: 13px; letter-spacing: -0.01em; }
    .proto-date { color: var(--faint); font-weight: 450; font-size: 13px; margin-top: 1px; }
    /* Last-editor face — git's last-commit author for the prototype, mapped to a user. */
    .proto-editor {
      flex: none; width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center;
      color: #fff; font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .02em;
      background-size: cover; background-position: center; box-shadow: 0 0 0 2px var(--card);
    }
    /* Icon-only control (download) — square. */
    .btn-icon {
      font: inherit; line-height: 1; cursor: pointer; font-size: 18px;
      width: 36px; height: 36px; min-width: 36px; border-radius: 8px;
      border: 1px solid var(--line-2); background: transparent; color: var(--fg);
      display: inline-grid; place-items: center;
      transition: background .12s ease, border-color .12s ease;
    }
    .btn-icon:hover { background: var(--card-hover); border-color: var(--accent); }
    .btn-icon:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .btn {
      font: inherit; font-size: 13px; font-weight: 500; border-radius: 8px;
      padding: 8px 13px; text-decoration: none; cursor: pointer;
      border: 1px solid var(--line-2); background: transparent; color: var(--fg);
      display: inline-flex; align-items: center; gap: 6px;
      transition: background .12s ease, border-color .12s ease;
    }
    .btn:hover { background: var(--card-hover); border-color: var(--accent); }
    .btn.primary { background: var(--accent-solid); color: #fff; border-color: transparent; }
    .btn.primary:hover { background: #525dc6; border-color: transparent; }
    .btn.ghost:hover { background: var(--bg-2); }

    /* ---- Pages grid (fast vertical scan, ~4 columns) ---- */
    .page-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 22px 20px; }
    /* Tier intro line (Base / Patterns / Tokens) */
    .tier-hint { margin: -2px 0 18px; max-width: 70ch; color: var(--muted); font-size: 13.5px; line-height: 1.5; }
    .tier-hint a { color: var(--accent); text-decoration: none; }
    .tier-hint a:hover { text-decoration: underline; }
    /* ── Tokens tab grid ── */
    .tok-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 10px; margin-top: 4px; }
    .tok { display: flex; gap: 11px; align-items: flex-start; padding: 11px 12px; background: var(--card);
           border: 1px solid var(--line); border-radius: 11px; }
    .tok-sw { flex: 0 0 auto; width: 38px; height: 38px; border-radius: 8px; box-shadow: inset 0 0 0 1px rgba(16,17,26,0.12);
              display: grid; place-items: center; }
    .tok-sw--mono { background: #f3f4f7; color: #6b7280; font-size: 13px; font-weight: 700; }
    .tok-body { min-width: 0; flex: 1; }
    .tok-name { display: block; font-size: 12.5px; font-weight: 600; color: var(--fg); word-break: break-all; }
    .tok-chain { display: flex; flex-wrap: wrap; align-items: center; gap: 3px 4px; margin: 4px 0 3px; }
    .tok-chain code { font-size: 11px; color: var(--muted); background: rgba(16,17,26,0.05); border-radius: 4px; padding: 1px 4px; }
    .tok-chain code.tok-raw { color: var(--fg); background: rgba(94,106,210,0.10); }
    .tok-arrow { color: #b6bac4; font-size: 11px; }
    .tok-meta { font-size: 11px; color: var(--faint); }
    /* Per-type token previews — type scale / font size / spacing render as rows so
       the preview can BE the value (real glyph size, real bar width). Radius and
       shadow stay in the chip grid but their swatch shows the rendered value. */
    .tok-list { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
    .tok-row { display: flex; gap: 14px; align-items: center; padding: 10px 14px; background: var(--card);
               border: 1px solid var(--line); border-radius: 11px; }
    .tok-row .tok-body { flex: 1; }
    .tok-meta--ann { color: var(--muted); font-weight: 600; margin: 3px 0; font-size: 11.5px; }
    .ts-sample { flex: 0 0 132px; width: 132px; text-align: center; color: var(--fg); line-height: 1;
                 font-family: 'Public Sans','Helvetica Neue',Helvetica,Arial,sans-serif;
                 overflow: hidden; white-space: nowrap; }
    .sp-track { flex: 0 0 248px; width: 248px; display: flex; align-items: center; }
    .sp-bar { height: 14px; border-radius: 3px; background: rgba(94,106,210,0.85); box-shadow: inset 0 0 0 1px rgba(16,17,26,0.10); }
    .tok-sw--radius { background: rgba(94,106,210,0.15); box-shadow: inset 0 0 0 1.5px rgba(94,106,210,0.55); }
    /* Elevation: a white card floating on a neutral wash so the shadow actually reads */
    .tok-sw--shadow { background: #eef0f4; display: grid; place-items: center; box-shadow: inset 0 0 0 1px rgba(16,17,26,0.05); }
    .tok-sw__card { width: 24px; height: 24px; border-radius: 6px; background: #fff; }
    /* Click-to-copy affordance */
    .tok [data-copy], .tok-row [data-copy] { cursor: copy; }
    .tok-name { transition: color .12s ease; }
    .tok-name[data-copy]:hover { color: var(--accent); }
    .tok-chain code[data-copy]:hover { background: rgba(94,106,210,0.18); color: var(--fg); }
    .tok-sw[data-copy]:hover { outline: 2px solid var(--accent); outline-offset: 1px; }
    /* Contrast badge (colour groups) — shows the best-legible text colour + WCAG grade */
    .tok-contrast { display: inline-flex; align-items: center; gap: 6px; font-size: 10.5px; font-weight: 600; color: var(--muted); margin: 4px 0 2px; }
    .tok-contrast b { font-weight: 700; }
    .tok-contrast--pass { color: #08833a; }
    .tok-contrast--fail { color: #b42318; }
    .tok-contrast__chip { display: inline-grid; place-items: center; width: 24px; height: 16px; border-radius: 4px;
      font-size: 10px; font-weight: 700; box-shadow: inset 0 0 0 1px rgba(16,17,26,0.12); }
    /* Where-used disclosure */
    .tok-used { margin-top: 1px; }
    .tok-used > summary { cursor: pointer; list-style: none; display: inline-block; }
    .tok-used > summary::-webkit-details-marker { display: none; }
    .tok-used > summary::before { content: "▸ "; color: var(--faint); }
    .tok-used[open] > summary::before { content: "▾ "; }
    .tok-used > summary:hover { color: var(--accent); }
    .tok-uses { display: flex; flex-wrap: wrap; gap: 4px; margin: 6px 0 2px; }
    .tok-use { font-size: 10.5px; color: var(--muted); background: rgba(16,17,26,0.05); border-radius: 4px; padding: 1px 5px; }
    .tok-use--cls { color: var(--accent); background: rgba(94,106,210,0.10); }
    /* Font-family sample row */
    .ff-sample { flex: 1; min-width: 0; color: var(--fg); font-size: 15px; line-height: 1.45; }
    .ff-sample b { display: block; font-size: 23px; font-weight: 700; margin-bottom: 2px; }
    .tok-row--ff .tok-body { flex: 0 0 260px; }
    /* Opportunity prototype grid: capped at 3 roomier cards per row on desktop,
       stepping down to 2 then 1 as width drops. */
    .page-grid.is-3up { grid-template-columns: repeat(auto-fill, minmax(min(300px, 100%), 1fr)); }
    .page-grid .card-proto { transition: box-shadow .18s ease, transform .18s ease; }
    .page-grid .card-proto:hover { box-shadow: 0 12px 28px -14px rgba(16,24,40,0.28); border-color: var(--line-2); transform: translateY(-3px); }
    .page-grid .proto-meta { padding: 11px 13px; }

    /* ---- Pending page cards (planned, not built) ---- */
    .card-proto.is-pending { border-style: dashed; border-color: var(--line-2); background: transparent; }
    .card-proto.is-pending:hover { transform: none; box-shadow: none; }
    .preview--pending {
      display: grid; place-items: center; background:
        repeating-linear-gradient(45deg, rgba(16,17,26,0.025) 0 10px, transparent 10px 20px), var(--bg-2);
    }
    .pending-glyph { font-size: 26px; color: var(--faint); }
    .card-proto.is-pending .proto-meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .card-proto.is-pending .proto-name { color: var(--muted); }
    .pending-badge {
      flex: none; font-size: 11px; font-weight: 600; letter-spacing: .03em; text-transform: uppercase;
      color: var(--faint); border: 1px solid var(--line-2); border-radius: 999px; padding: 3px 9px;
    }

    /* ---- Dev-status glyph (clickable; baseline from prototype-status.json,
       live edits overlaid from KV by STATUS_JS) ---- */
    /* A circular icon, not a text pill: shape AND colour both carry meaning
       (never colour alone, WCAG 1.4.1); the label rides on aria-label/title. */
    .status-chip {
      flex: none; align-self: center; padding: 0; border: 0; background: none;
      width: 24px; height: 24px; border-radius: 50%; cursor: pointer; line-height: 0;
      display: inline-grid; place-items: center;
      transition: transform .12s ease, box-shadow .12s ease, opacity .12s ease;
    }
    .status-chip svg { width: 20px; height: 20px; display: block; }
    .status-chip:hover { transform: scale(1.1); }
    .status-chip:active { transform: scale(0.94); }
    .status-chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .status-chip[disabled] { cursor: progress; }
    /* Overlaid on the preview, bottom-left — above the cover link so it stays
       clickable. A white disc + soft shadow lets the glyph read on any screenshot.
       Sits in the preview so it never adds to card height. */
    .preview .status-chip {
      position: absolute; left: 8px; bottom: 8px; z-index: 3;
      background: #fff; box-shadow: 0 2px 8px -1px rgba(16,24,40,0.32);
    }
    .preview .status-chip svg { width: 18px; height: 18px; }
    /* "Ignore" dims its card so it recedes without disappearing. The :has reacts
       live to the class STATUS_JS sets, so a click updates the dim instantly. */
    .card-proto:has(.status-chip.is-ignore),
    .card-opp:has(.status-chip.is-ignore) { opacity: .55; }
    .card-proto:has(.status-chip.is-ignore):hover,
    .card-opp:has(.status-chip.is-ignore):hover { opacity: 1; }
    @media (prefers-reduced-motion: reduce) { .status-chip { transition: none; } }
    /* Status picker — opens on hover/click so a state is CHOSEN, not cycled into
       (each cycle step used to save and re-rank the card). Light, unlike the dark
       right-click menu: the state glyphs are the same ones on the cards, and they
       only read on a light surface. */
    .gv-status-menu {
      position: fixed; z-index: 2147483200; min-width: 152px;
      background: var(--card); color: var(--fg);
      border: 1px solid var(--line-2); border-radius: 10px; padding: 5px;
      box-shadow: 0 16px 36px -14px rgba(16,24,40,0.45), 0 2px 6px rgba(16,24,40,0.10);
      font-size: 12.5px; letter-spacing: -0.006em; user-select: none;
      animation: gv-ctx-in .1s ease both;
    }
    .gv-status-menu button {
      display: flex; align-items: center; gap: 8px; width: 100%;
      padding: 6px 8px; border: 0; background: none; border-radius: 7px;
      font: inherit; color: inherit; text-align: left; cursor: pointer; white-space: nowrap;
    }
    .gv-status-menu button:hover, .gv-status-menu button:focus-visible { background: var(--card-hover); outline: none; }
    .gv-status-menu button[aria-checked="true"] { font-weight: 650; }
    .gv-status-menu button[aria-checked="true"]::after { content: "✓"; margin-left: auto; color: var(--faint); font-size: 11px; }
    .gv-status-menu svg { width: 16px; height: 16px; flex: none; display: block; }

    /* ---- Right-click card menu (editor-style dark popover) ---- */
    .gv-ctx {
      position: fixed; z-index: 2147483200; min-width: 192px;
      background: #1c1c1f; color: #f3f3f4;
      border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 6px;
      box-shadow: 0 16px 40px -10px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.3);
      font-size: 13px; letter-spacing: -0.006em; user-select: none;
      animation: gv-ctx-in .12s ease both;
    }
    @keyframes gv-ctx-in { from { opacity: 0; transform: translateY(-4px) scale(.985); } to { opacity: 1; transform: none; } }
    .gv-ctx button {
      display: flex; align-items: center; gap: 9px; width: 100%;
      padding: 7px 10px; border: 0; background: none; border-radius: 7px;
      font: inherit; color: inherit; text-align: left; cursor: pointer; white-space: nowrap;
    }
    .gv-ctx button:hover, .gv-ctx button:focus-visible { background: #3a6df0; color: #fff; outline: none; }
    .gv-ctx button .ic { width: 14px; height: 14px; flex: none; opacity: .85; }
    .gv-ctx hr { border: 0; border-top: 1px solid rgba(255,255,255,0.09); margin: 6px 4px; }
    .gv-ctx .gv-ctx-danger { color: #ff7a7a; }
    .gv-ctx .gv-ctx-danger:hover, .gv-ctx .gv-ctx-danger:focus-visible { background: #c0392b; color: #fff; }
    .gv-ctx .gv-ctx-danger .ic { opacity: 1; }
    /* Inline rename field — rises above any full-card cover link while editing. */
    .proto-name[contenteditable] {
      position: relative; z-index: 4;
      outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px;
      background: var(--card); cursor: text; white-space: nowrap; overflow: hidden;
    }
    /* Transient "Link copied" / delete-hint toast. */
    .gv-toast {
      position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%) translateY(8px);
      z-index: 2147483205; background: #1c1c1f; color: #fff;
      padding: 9px 15px; border-radius: 9px; font-size: 13px; font-weight: 500; max-width: 80vw;
      box-shadow: 0 10px 30px -6px rgba(0,0,0,0.45);
      opacity: 0; transition: opacity .16s ease, transform .16s ease; pointer-events: none;
    }
    .gv-toast.show { opacity: 1; transform: translateX(-50%); }
    /* Danger modal — the "Delete forever" confirm (CARD_MENU_JS builds it). */
    .gv-modal-veil {
      position: fixed; inset: 0; z-index: 2147483204;
      background: rgba(12,13,20,0.55); backdrop-filter: blur(2px);
      display: grid; place-items: center; animation: gv-ctx-in .12s ease;
    }
    .gv-modal {
      width: min(420px, calc(100vw - 48px)); background: var(--card); color: var(--fg);
      border: 1px solid var(--line-2); border-radius: 14px; padding: 22px 22px 18px;
      box-shadow: 0 24px 70px -18px rgba(0,0,0,0.55);
    }
    .gv-modal__title { font-family: var(--font-display); font-size: 16px; font-weight: 650; margin: 0 0 8px; overflow-wrap: anywhere; }
    .gv-modal__body { font-size: 13.5px; line-height: 1.55; color: var(--muted); margin: 0 0 18px; }
    .gv-modal__row { display: flex; justify-content: flex-end; gap: 8px; }
    .gv-modal__btn {
      font: inherit; font-size: 13px; font-weight: 550; cursor: pointer;
      border-radius: 8px; padding: 8px 14px; border: 1px solid var(--line-2);
      background: transparent; color: var(--fg);
    }
    .gv-modal__btn:hover { background: var(--card-hover); }
    .gv-modal__btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .gv-modal__btn--danger { background: #c0392b; border-color: #c0392b; color: #fff; }
    .gv-modal__btn--danger:hover { background: #a93226; }
    .gv-modal__btn[disabled] { opacity: .6; cursor: default; }
    @media (prefers-reduced-motion: reduce) { .gv-ctx, .gv-toast, .gv-modal-veil { animation: none; transition: none; } }

    /* ---- Components table (small preview per row) ---- */
    .comp-table { width: 100%; border-collapse: collapse; }
    .comp-table th { text-align: left; font-size: 12px; text-transform: uppercase; letter-spacing: .05em;
      color: var(--muted); font-weight: 600; padding: 0 14px 10px; border-bottom: 1px solid var(--line); }
    .comp-table td { padding: 11px 14px; border-bottom: 1px solid var(--line); vertical-align: middle; }
    .comp-table td:first-child { width: 100px; padding-right: 18px; }
    .comp-table tr:hover td { background: color-mix(in srgb, var(--accent) 4%, transparent); }
    .comp-thumb {
      position: relative; width: 100px; max-width: 38vw; aspect-ratio: 16 / 9; overflow: hidden;
      border-radius: 10px; border: 1px solid var(--line); background: var(--bg); display: block;
    }
    .comp-thumb iframe {
      position: absolute; top: 0; left: 0; width: 1280px; height: 720px; border: 0;
      transform-origin: top left; pointer-events: none;
    }
    .comp-name { font-weight: 600; font-size: 14px; letter-spacing: -0.01em; }
    .comp-name code { display: block; font-size: 12px; color: var(--muted); font-weight: 400; margin-top: 4px; }
    /* Metadata pills under the name — surface · category · status (status carries the
       cleanup signal; "review" is styled loud amber). */
    .comp-badges { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
    .cbadge { font-size: 11px; font-weight: 600; line-height: 1; padding: 3px 7px; border-radius: 5px; letter-spacing: -0.004em; border: 1px solid transparent; }
    .cbadge--cat, [class*="cbadge--st-"], [class*="cbadge--layer-"] { text-transform: capitalize; }
    /* Layer cue: text label always present (WCAG 1.4.1 — colour is never the sole cue). */
    .cbadge--layer-base { background: rgba(20,121,133,0.13); color: #0f6470; }
    .cbadge--layer-component { background: rgba(94,106,210,0.13); color: #4650b8; }
    .cbadge--layer-pattern { background: rgba(140,99,210,0.14); color: #6b46c1; }
    .cbadge--surf-fo { background: rgba(94,106,210,0.12); color: #4650b8; }
    .cbadge--surf-bo { background: rgba(20,121,133,0.13); color: #0f6470; }
    .cbadge--surf-cross { background: rgba(16,17,26,0.07); color: #5b626e; }
    .cbadge--cat { background: rgba(16,17,26,0.05); color: #5b626e; }
    .cbadge--st-canonical { background: rgba(34,139,84,0.12); color: #1f7a48; }
    .cbadge--st-variant { background: rgba(16,17,26,0.06); color: #6b7280; }
    .cbadge--st-page-demo { background: rgba(140,99,210,0.13); color: #6b46c1; }
    .cbadge--st-review { background: rgba(214,120,12,0.15); color: #b45309; border-color: rgba(214,120,12,0.35); }
    .comp-tags { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 7px; }
    .comp-tags span { font-size: 11px; color: var(--faint); }
    .comp-desc { color: var(--muted); font-size: 14px; max-width: 42ch; }
    .comp-desc[contenteditable] {
      outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px;
      background: var(--card); color: var(--fg); cursor: text;
    }
    /* Validation chip column — pinned to the far right, narrow, centered. */
    .comp-table th.comp-status, .comp-table td.comp-status { width: 56px; text-align: center; padding-right: 8px; }
    td.comp-status .status-chip { margin: 0 auto; }
    .comp-actions { white-space: nowrap; }
    @media (max-width: 620px) {
      .comp-table, .comp-table tbody, .comp-table tr, .comp-table td { display: block; }
      .comp-table thead { display: none; }
      .comp-table td { border: 0; padding: 4px 0; }
      .comp-table tr { border-bottom: 1px solid var(--line); padding: 16px 0; }
      .comp-thumb { max-width: 100%; width: 100%; }
    }

    /* ---- Listing grid ----
       The editor-style global left rail (NAV_CSS) is the nav now; listing pages are a
       single centered column. The wide variant gives the homepage card grid more room. */
    /* Gallery pages run the full width. A fixed cap left a third of a wide screen
       empty while the cards stayed put; with auto-fill grids below, extra width
       becomes extra columns instead of dead space. Padding still keeps them off
       the edge, and the grids' own minmax() floor stops cards stretching. */
    .wrap--wide { max-width: none; }
    /* Auto-fill grid: as many ~248px columns as fit, no carousel. */
    .opp-grid { display: grid; gap: 22px;
                grid-template-columns: repeat(auto-fill, minmax(min(300px, 100%), 1fr)); }

    /* Opportunity card = a stretched cover link: the whole card opens the folder. */
    .card-opp { position: relative; }
    .card-cover-link { position: absolute; inset: 0; z-index: 1; border-radius: var(--radius); }
    .card-cover-link:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

    /* ── Phones ───────────────────────────────────────────────────────────────
       Tighter gutters under the 52px bar, a smaller hero, and full-width actions
       so cards never overflow or cramp. */
    @media (max-width: 600px) {
      .wrap { padding: 30px 16px 80px; }
      h1 { font-size: 30px; }
      .subtitle { font-size: 15px; }
      .proto-meta { padding: 14px 16px; }
      .playground { gap: 14px; padding: 16px; }
      .playground__go { display: none; }
    }
    @media (max-width: 380px) {
      h1 { font-size: 26px; }
      .page-grid { grid-template-columns: 1fr; }
    }

    /* ---- Cross-document View Transitions ----
       Pure-CSS opt-in: same-origin shell→shell navigations animate instead of
       flashing. Progressive (Chrome/Edge 126+, Safari 18.2+; others just navigate).
       Disabled under reduced-motion. */
    @view-transition { navigation: auto; }
    @media (prefers-reduced-motion: reduce) { @view-transition { navigation: none; } }

    /* ---- Off-screen render skipping ----
       Long card grids: let the browser skip layout/style/paint for cards not near
       the viewport. contain-intrinsic-size supplies a placeholder so the scrollbar
       stays stable; the 'auto' keyword remembers each card's real size once rendered. */
    .opp-grid .card-opp { content-visibility: auto; contain-intrinsic-size: auto 230px; }
    .page-grid .card-proto { content-visibility: auto; contain-intrinsic-size: auto 200px; }`;

// Speculation Rules: native, library-free instant forward navigation. `moderate`
// eagerness triggers a document prefetch on hover / viewport entry (quicklink-style)
// for same-origin links, excluding the /__ internal endpoints. Prefetch downloads
// only the destination document (not its subresources) and — unlike <link rel=prefetch>
// — is not blocked by cache headers. Chromium-only; other browsers ignore the block,
// so it's a pure progressive enhancement.
const SPECULATION_RULES = `<script type="speculationrules">${JSON.stringify({
  prefetch: [
    {
      where: { and: [{ href_matches: "/*" }, { not: { href_matches: "/__*" } }] },
      eagerness: "moderate",
    },
  ],
})}</script>`;

const CAROUSEL_JS = `
    (function () {
      // Download HTML: fetch the prototype with ?raw=1 (the worker then skips the
      // live-reload injection), and strip the baked-in review tag, so devs get a
      // clean, self-contained file. The reload strip is a fallback for ?raw.
      document.addEventListener('click', function (e) {
        var b = e.target.closest && e.target.closest('[data-dl]');
        if (!b) return;
        e.preventDefault();
        var dl = b.getAttribute('data-dl');
        dl += (dl.indexOf('?') < 0 ? '?raw=1' : '&raw=1');
        fetch(dl).then(function (r) { return r.text(); }).then(function (t) {
          t = t.replace(/<!--gv-review-start-->[\\s\\S]*?<!--gv-review-end-->/g, '')
               .replace(/<!--gv-reload-start-->[\\s\\S]*?<!--gv-reload-end-->/g, '');
          var blob = new Blob([t], { type: 'text/html' });
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = b.getAttribute('data-dlname') || 'prototype.html';
          a.click();
          URL.revokeObjectURL(a.href);
        }).catch(function () { window.location.href = b.getAttribute('data-dl'); });
      });

      // Scale each live preview iframe so the whole page fits the card.
      function fit(p) {
        var f = p.querySelector('iframe');
        if (f) f.style.transform = 'scale(' + (p.clientWidth / 1280) + ')';
      }
      var previews = [].slice.call(document.querySelectorAll('.preview, .comp-thumb'));
      var reveal = function (p) { p.classList.add('is-loaded'); };

      // Poster images (the fast path): cheap and natively lazy, so no gating needed —
      // just cross-fade each in once it decodes (or immediately if already cached).
      previews.forEach(function (p) {
        var img = p.querySelector('.preview-img');
        if (!img) return;
        if (img.complete && img.naturalWidth) reveal(p);
        else { img.addEventListener('load', function () { reveal(p); }); img.addEventListener('error', function () { reveal(p); }); }
      });

      // Live iframe fallback (only for prototypes without a poster yet): point the
      // iframe at its data-src and cross-fade on load. Called only when the card nears
      // the viewport (IntersectionObserver below). The stuck-load backstop is timed
      // from THIS moment, not page load, so a far-down preview keeps its full grace.
      // A preview runs the REAL prototype, and prototypes focus inputs and call
      // scrollIntoView on load. Both walk out of the frame and move the LISTING —
      // which is why this page used to open itself halfway down. A decorative
      // thumbnail doesn't get to move the reader's viewport: for a moment after each
      // one loads, any scroll the reader didn't ask for is undone. The reader's own
      // scrolling (wheel/touch/keys/pointer) always wins and ends the guard.
      var pinY = null, pinUntil = 0, pinning = false;
      ['wheel', 'touchstart', 'keydown', 'pointerdown'].forEach(function (ev) {
        // The reader moved the page themselves — drop the held position and re-read
        // it from wherever they end up, so the guard never fights a real scroll.
        addEventListener(ev, function () { pinY = null; pinUntil = 0; }, { passive: true, capture: true });
      });
      // Snapping back in the scroll event itself lands in the same frame as the jump,
      // so it never paints; the rAF loop below is the backstop for coalesced events.
      addEventListener('scroll', function () {
        if (pinY !== null && performance.now() <= pinUntil && scrollY !== pinY) scrollTo(scrollX, pinY);
      }, true);
      function pinScroll() {
        if (pinY === null) pinY = scrollY;
        pinUntil = performance.now() + 1200; // covers the frame's own load-time scripts
        if (pinning) return;
        pinning = true;
        (function tick() {
          if (pinY === null || performance.now() > pinUntil) { pinning = false; return; }
          if (scrollY !== pinY) scrollTo(scrollX, pinY);
          requestAnimationFrame(tick);
        })();
      }

      function loadFrame(p) {
        var f = p.querySelector('iframe');
        if (!f || f.dataset.gvLoaded) return;
        f.dataset.gvLoaded = '1';
        f.addEventListener('load', function () { reveal(p); pinScroll(); });
        var src = f.getAttribute('data-src');
        if (src) { pinScroll(); f.src = src; } // navigates the iframe to the real page
        // NB: an iframe sits at about:blank with readyState 'complete' BEFORE it
        // navigates to its real src — so we must NOT reveal on readyState alone, or we
        // unmask the page exactly as its FOUC paints. The load event is the only
        // reliable "real src finished" signal; the timeout is just a stuck-load backstop.
        setTimeout(function () { reveal(p); }, 8000);
      }

      var frames = previews.filter(function (p) { return p.querySelector('iframe'); });
      // Only load iframe previews as they approach the viewport (Safari-safe lazy gate
      // with a real concurrency stagger — iframe loading="lazy" is patchy and uncapped).
      if (window.IntersectionObserver) {
        var io = new IntersectionObserver(function (entries) {
          entries.forEach(function (e) {
            if (e.isIntersecting) { loadFrame(e.target); io.unobserve(e.target); }
          });
        }, { rootMargin: '400px 0px' });
        frames.forEach(function (p) { io.observe(p); });
      } else {
        frames.forEach(loadFrame);
      }

      // Only iframe previews need JS scaling; posters fill via object-fit.
      if (frames.length) {
        if (window.ResizeObserver) {
          var ro = new ResizeObserver(function (es) { es.forEach(function (e) { fit(e.target); }); });
          frames.forEach(function (p) { ro.observe(p); fit(p); });
        } else {
          window.addEventListener('resize', function () { frames.forEach(fit); });
          frames.forEach(fit);
        }
      }
    })();`;

// Editor-style global LEFT RAIL — the site's persistent chrome on every page
// (org switcher on top, then Prototypes/Playground, the Opportunities list, and the
// Library group: Primitives · Components · Pages). NOT injected into prototypes
// themselves. Styles are self-contained literal colours so the same rail can be
// injected into the Primitives gallery, which doesn't load PAGE_CSS. Root-relative
// hrefs => correct from any depth. The 248px rail width is reserved via body
// padding-left (desktop); below 860px it collapses to a slide-in drawer behind a
// slim top bar (body padding-top instead). z-index sits below modals, above content.
const NAV_CSS = `
    :root { --rail: 230px; }
    body { padding-left: var(--rail); }

    /* ── Slim top bar — only when the rail collapses (mobile) ─────────────────── */
    .gvtop {
      display: none; position: fixed; top: 0; left: 0; right: 0; z-index: 2147483100; height: 52px;
      align-items: center; gap: 12px; padding: 0 calc(14px + env(safe-area-inset-right)) 0 calc(14px + env(safe-area-inset-left));
      background: rgba(255,255,255,0.82); -webkit-backdrop-filter: blur(14px) saturate(180%); backdrop-filter: blur(14px) saturate(180%);
      border-bottom: 1px solid rgba(16,17,26,0.09);
      font: 600 14.5px/1 "Inter", "Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    /* ── The rail ─────────────────────────────────────────────────────────────── */
    .gvside {
      position: fixed; top: 0; left: 0; bottom: 0; z-index: 2147483100; width: var(--rail);
      display: flex; flex-direction: column; gap: 1px;
      padding: 11px 10px 12px; overflow: hidden;
      background: #fbfbfd; border-right: 1px solid rgba(16,17,26,0.09);
      font: 500 13px/1.35 "Inter", "Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    /* Brand + search stay put; the nav list scrolls; the Library footer is pinned. */
    .gvside__scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; display: flex; flex-direction: column; gap: 1px; }
    .gvside__foot { flex: none; }

    /* Brand mark (falcon) — still used by the mobile top bar. The signed-in profile
       chip owns the desktop rail's top-left spot; there's no Augur wordmark there. */
    .gvmark { display: block; flex: none; object-fit: contain; }
    .gvtop__center-brand .gvmark { width: 22px; height: 22px; }

    /* Profile chip — the signed-in face + dropdown, in the brand spot. Hidden until
       PROFILE_JS confirms a logged-in user (open/no-identity builds show nothing). */
    .gvprof { position: relative; margin: 0 0 6px; }
    .gvprof__btn {
      display: flex; align-items: center; gap: 10px; width: 100%; padding: 6px 8px;
      border: 0; border-radius: 7px; background: none; cursor: pointer;
      font: inherit; color: #16171a; text-align: left; transition: background .12s ease;
    }
    .gvprof__btn:hover { background: rgba(16,17,26,0.05); }
    .gvprof__btn:focus-visible { outline: 2px solid #5e6ad2; outline-offset: 1px; }
    .gvprof__btn[aria-expanded=true] { background: rgba(16,17,26,0.06); }
    .gvprof__av {
      flex: none; width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center;
      background: var(--gvprof-color, #4f46e5); color: #fff; font-size: 10px; font-weight: 700;
      letter-spacing: .02em; text-transform: uppercase; background-size: cover; background-position: center;
    }
    .gvprof__av.lg { width: 30px; height: 30px; font-size: 12px; }
    .gvprof__name { flex: 1 1 auto; min-width: 0; font-weight: 600; font-size: 13px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .gvprof__cv { width: 15px; height: 15px; flex: none; color: #9aa0ab; }
    .gvprof__menu {
      position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 5;
      background: #fff; border: 1px solid rgba(16,17,26,0.12); border-radius: 10px; padding: 5px;
      box-shadow: 0 1px 2px rgba(16,24,40,0.05), 0 12px 30px -16px rgba(16,24,40,0.30);
    }
    .gvprof__id { display: flex; align-items: center; gap: 9px; padding: 7px 8px 9px;
      border-bottom: 1px solid rgba(16,17,26,0.08); margin-bottom: 4px; }
    .gvprof__idtext { display: flex; flex-direction: column; min-width: 0; }
    .gvprof__idtext .gvprof__name { font-size: 13px; }
    .gvprof__email { font-size: 11.5px; color: #5b626e; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .gvprof__item {
      display: flex; align-items: center; gap: 9px; padding: 7px 8px; border-radius: 7px;
      text-decoration: none; color: #16171a; font-size: 13px; font-weight: 500;
    }
    .gvprof__item:hover { background: rgba(16,17,26,0.05); }
    .gvprof__item .gvic { width: 15px; height: 15px; color: #5b626e; }
    /* Settings opens a dialog rather than navigating, so it's a button — same row,
       none of the UA button chrome. */
    button.gvprof__item { width: 100%; border: 0; background: none; font: inherit;
      font-size: 13px; font-weight: 500; text-align: left; cursor: pointer; }
    /* Reveal-on-demand rail bits carry the hidden attribute, but their own rules set
       display (grid/flex), which out-specifies the UA [hidden] rule — without these
       they show for everyone, always (same gotcha as the brand and the admin item). */
    .gvprof__dot[hidden], .gvprof__ver[hidden], .gvsearch__clear[hidden],
    .gvprof__item[hidden] { display: none; }

    /* Engine version footer (admins only) + the update-available "!" on the chip. */
    .gvprof__dot { flex: none; width: 15px; height: 15px; border-radius: 50%; display: grid; place-items: center;
      background: #b45309; color: #fff; font-size: 10px; font-weight: 800; line-height: 1; }
    /* [hidden] override: the display below would otherwise beat the UA rule. */
    .gvprof__ver[hidden] { display: none; }
    .gvprof__ver { display: flex; align-items: center; justify-content: space-between; gap: 8px;
      margin-top: 4px; padding: 6px 8px 3px; border-top: 1px solid rgba(16,17,26,0.08);
      font-size: 11px; color: #9aa0ab; }
    .gvprof__ver a { color: #b45309; font-weight: 600; text-decoration: none; }
    .gvprof__ver a:hover { text-decoration: underline; }

    /* Workspace-settings rail (adminRail): back link + the three sections. Reuses
       .gvside__act so a tab sits at exactly the rail's own rhythm. */
    .gvadmin__back { display: flex; align-items: center; gap: 10px; margin: 2px 0 10px;
                     padding: 6px 8px; border-radius: 7px; text-decoration: none;
                     color: #16171a; font-weight: 600; font-size: 13.5px; }
    .gvadmin__back svg { width: 20px; height: 20px; padding: 3px; box-sizing: border-box;
                         flex: none; color: #9aa0ab; }
    .gvadmin__back:hover { background: rgba(16,17,26,0.05); }
    .gvadmin__tab { font-weight: 500; }
    .gvadmin__tab.is-on { background: #eef2ff; color: #4f46e5; font-weight: 600; }

    /* Space switcher — active space icon+name+badge with a dropdown of the spaces you
       belong to. Server-rendered from the build-time space list, which is every space;
       SPACE_JS hides the rows /__me does not name.
       The workspace row. Hidden until SPACE_JS confirms you belong to something —
       it is no longer an admin-only maintainer tool (that was html.gv-admin), it is
       everyone's, and it names spaces, so it must stay dark to a signed-out visitor. */
    .gvspace { display: none; position: relative; margin: 2px 0 8px; }
    html.gv-spaces .gvspace { display: block; }
    .gvspace__row { display: flex; align-items: center; gap: 2px; }
    /* Admin is a rail destination, revealed only to an admin of THIS workspace —
       a per-space question, so it cannot ride the instance-wide html.gv-admin. */
    .gvside__admin { display: none !important; }
    html.gv-space-admin .gvside__admin { display: flex !important; }
    .gvspace__row .gvspace__btn { flex: 1 1 auto; min-width: 0; }
    .gvspace__btn { display: flex; align-items: center; gap: 10px; flex: 1 1 auto; min-width: 0;
                    padding: 6px 8px; border-radius: 7px; background: none; border: 0; }
    .gvspace__icon { flex: none; width: 20px; height: 20px; border-radius: 5px; overflow: hidden; display: grid; place-items: center; background: #fff; }
    .gvspace__icon img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .gvspace__name { flex: 1 1 auto; min-width: 0; font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* Omni search — one field, filters whatever cards are on the right. Editor-style
       filled input that brightens to white on focus. */
    .gvsearch { position: relative; margin: 2px 1px 8px; }
    .gvsearch > svg { position: absolute; left: 11px; top: 50%; transform: translateY(-50%); width: 16px; height: 16px; color: #8a9098; pointer-events: none; }
    .gvsearch input {
      width: 100%; height: 32px; padding: 0 32px 0 34px; border-radius: 8px;
      border: 1px solid transparent; background: #ebedf0; color: #16171a;
      font: inherit; font-size: 13px; outline: none;
      transition: background .12s ease, border-color .12s ease, box-shadow .12s ease;
    }
    .gvsearch input::placeholder { color: #8a9098; }
    .gvsearch input:hover { background: #e6e8ec; }
    .gvsearch input:focus { background: #fff; border-color: rgba(94,106,210,0.55); box-shadow: 0 0 0 3px rgba(94,106,210,0.13); }
    /* [hidden] override: the display below would otherwise beat the UA rule. */
    .gvsearch__clear[hidden] { display: none; }
    .gvsearch__clear {
      position: absolute; right: 7px; top: 50%; transform: translateY(-50%);
      width: 22px; height: 22px; padding: 0; display: grid; place-items: center;
      border: 0; border-radius: 6px; background: transparent; color: #6b7280;
      font-size: 17px; line-height: 1; cursor: pointer;
    }
    .gvsearch__clear:hover { background: rgba(16,17,26,0.08); color: #16171a; }
    /* Global-finder results — a card grid over the content pane, right of the rail
       (chromeScript positions .gvfind's left edge at the rail's right edge). Poster
       thumbs where the folder grids have them; glyph tiles otherwise. Self-contained
       styling so it renders identically on shell AND gallery pages. */
    .gvfind {
      position: fixed; top: 0; right: 0; bottom: 0; z-index: 70; overflow-y: auto;
      background: #f7f8fb; padding: 24px 28px 40px;
      font: 500 13px/1.4 "Inter", "Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #16171a;
    }
    .gvfind__head { display: flex; align-items: baseline; gap: 10px; font-size: 16px; font-weight: 600; margin: 0 0 18px; }
    .gvfind__count {
      font-size: 12px; font-weight: 560; color: #6b7280; background: #eef0f4;
      border: 1px solid rgba(16,17,26,0.08); border-radius: 999px; padding: 1px 8px;
    }
    .gvfind__hint { margin-left: auto; font-size: 11.5px; font-weight: 450; color: #9aa0aa; }
    .gvfind__empty { color: #8a9098; }
    .gvfind__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 16px; }
    .gvfind-card {
      display: block; background: #fff; border: 1px solid rgba(16,17,26,0.09); border-radius: 12px;
      overflow: hidden; text-decoration: none; color: inherit;
      transition: box-shadow .16s ease, transform .16s ease, border-color .16s ease;
    }
    .gvfind-card:hover, .gvfind-card.is-act {
      border-color: rgba(94,106,210,0.5); transform: translateY(-2px);
      box-shadow: 0 14px 32px -16px rgba(16,24,40,0.32), 0 0 0 1px rgba(94,106,210,0.18);
    }
    .gvfind-card__prev {
      aspect-ratio: 16 / 10; background-color: #eef0f4; background-size: cover;
      background-position: top center; border-bottom: 1px solid rgba(16,17,26,0.06);
    }
    .gvfind-card__prev--glyph { display: grid; place-items: center; font-size: 36px;
      background-image: radial-gradient(circle, rgba(16,17,26,0.10) 1px, transparent 1.3px); background-size: 16px 16px; }
    .gvfind-card__prev--live { position: relative; overflow: hidden; }
    .gvfind-card__prev--live iframe {
      position: absolute; top: 0; left: 0; width: 1280px; height: 800px; border: 0;
      transform-origin: top left; pointer-events: none;
    }
    .gvfind-card__meta { padding: 10px 12px; display: flex; flex-direction: column; gap: 3px; }
    .gvfind-card__t { font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .gvfind-card__t b { color: #4650c9; font-weight: 700; }
    .gvfind-card__sub { display: flex; align-items: center; gap: 6px; color: #8a9098; font-size: 11.5px; min-width: 0; }
    .gvfind-card__sub > :first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .gvfind-card__dot { flex: none; }
    .gvfind-chip {
      flex: none; font-size: 10px; font-weight: 650; letter-spacing: 0.03em; text-transform: uppercase;
      color: #8a9098; background: #f1f2f5; border-radius: 5px; padding: 2px 6px;
    }
    .gvsearch kbd {
      position: absolute; right: 9px; top: 50%; transform: translateY(-50%);
      min-width: 17px; height: 18px; padding: 0 5px; display: grid; place-items: center;
      border: 1px solid rgba(16,17,26,0.14); border-radius: 5px; background: #fff;
      color: #8a9098; font: 600 11px/1 "Inter", "Inter Variable", sans-serif;
    }

    /* Section divider in the rail. */
    .gvside__rule { height: 1px; background: rgba(16,17,26,0.08); margin: 9px 7px; }

    /* Nav groups + items — higher-contrast, roomier rows to match the reference. */
    .gvside__group { display: flex; flex-direction: column; gap: 1px; }
    .gvside__label { font-size: 10px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: #6b7280; margin: 11px 8px 4px; }
    .gvside a {
      display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 7px;
      text-decoration: none; color: #2c2f36; font-weight: 500; font-size: 13px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      transition: background .12s ease, color .12s ease;
    }
    .gvside a:hover { background: rgba(16,17,26,0.05); color: #0e0f12; }
    .gvside a[aria-current="page"] { background: rgba(16,17,26,0.07); color: #0e0f12; font-weight: 600; }
    .gvside a:focus-visible { outline: 2px solid #5e6ad2; outline-offset: 1px; }
    .gvside a > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .gvside__ver { margin-left: auto; flex: none; font-size: 10px; font-weight: 600; letter-spacing: .02em; color: #9aa0ab; font-variant-numeric: tabular-nums; }
    .gvic { width: 16px; height: 16px; flex: none; color: #565a63; }
    /* Rail marks share ONE slot so every icon edge and every label edge lines up.
       The glyph still draws at 16px; the padding widens its box to 20px without
       scaling the artwork (box-sizing keeps the outer size fixed). */
    .gvside a > .gvic, .gvside__act > .gvic {
      width: 20px; height: 20px; padding: 2px; box-sizing: border-box;
    }
    .gvside a[aria-current="page"] .gvic { color: #16171a; }
    /* Pinned rows: the leading emoji sits in the same slot a nav icon would. */
    .gvpin-ic { width: 20px; flex: none; display: inline-flex; align-items: center; justify-content: center; font-size: 14px; line-height: 1; }
    .gvside__pinhint { color: #6b7280; font-size: 12px; line-height: 1.45; margin: 2px 8px 2px; }
    .gvside [data-pinned-list] a { cursor: grab; }
    .gvside [data-pinned-list] a.gv-dragging { opacity: .45; cursor: grabbing; }
    .gvside [data-pinned-list] a.gv-ctxopen { background: rgba(16,17,26,0.06); }
    /* Right-click menu on a pinned row — unpinning from the rail itself, instead of
       navigating back to the card that owns the star. Editor-dark, like the card menu. */
    .gvpin-menu {
      position: fixed; z-index: 2147483300; min-width: 196px;
      background: #1c1c1f; color: #f3f3f4;
      border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 6px;
      box-shadow: 0 16px 40px -10px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.3);
      font: 500 13px/1.25 "Inter", "Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      letter-spacing: -0.006em; user-select: none;
    }
    .gvpin-menu__hd {
      padding: 4px 10px 6px; font-size: 11.5px; font-weight: 500; color: rgba(243,243,244,0.45);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .gvpin-menu button {
      display: flex; align-items: center; gap: 9px; width: 100%;
      padding: 7px 10px; border: 0; background: none; border-radius: 7px;
      font: inherit; color: inherit; text-align: left; cursor: pointer; white-space: nowrap;
    }
    .gvpin-menu button:hover, .gvpin-menu button:focus-visible { background: #3a6df0; color: #fff; outline: none; }
    .gvpin-menu svg { width: 15px; height: 15px; flex: none; opacity: .85; }

    /* Collapsible section (Library) — a clickable summary row + indented children. */
    .gvside__sect { display: block; }
    .gvside__sum {
      display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 7px;
      list-style: none; cursor: pointer; user-select: none;
      color: #6b7280; font-size: 10px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase;
      transition: background .12s ease, color .12s ease;
    }
    .gvside__sum::-webkit-details-marker { display: none; }
    .gvside__sum::marker { content: ""; }
    .gvside__sum:hover { background: rgba(16,17,26,0.05); color: #0e0f12; }
    .gvside__sum:focus-visible { outline: 2px solid #5e6ad2; outline-offset: 1px; }
    .gvside__caret { margin-left: auto; display: inline-flex; align-items: center; color: #8b909b; transition: transform .15s ease; }
    .gvside__caret .gvic { width: 16px; height: 16px; color: inherit; }
    .gvside__sect[open] > .gvside__sum .gvside__caret { transform: rotate(90deg); }
    .gvside__sub { margin: 2px 0 4px 13px; padding-left: 8px; border-left: 1px solid rgba(16,17,26,0.08); }

    /* Bundle-store fill gauge — admins only, revealed by PROFILE_JS once /__admin/storage
       answers (instances with no store never show it). Sits in the rail foot above Library. */

    /* Mobile drawer scrim. */
    .gvscrim { display: none; position: fixed; inset: 0; z-index: 2147483099; background: rgba(16,17,26,0.34); opacity: 0; transition: opacity .2s ease; }

    @media (max-width: 860px) {
      body { padding-left: 0; padding-top: 52px; padding-bottom: calc(90px + env(safe-area-inset-bottom)); }
      .gvtop { display: flex; }
      /* The desktop rail has no toggle left on mobile (the hamburger and its JS are
         gone — the floating tab bar/sheets replace it) — display:none, not just
         off-canvas, so it drops out of tab order and VoiceOver's swipe order instead
         of sitting there permanently reachable-but-invisible. querySelector-based
         lookups elsewhere (PINS_JS, PROFILE_JS, ADMIN_SECTIONS_JS) still find it fine
         — display:none removes an element from rendering/focus, not from the DOM. */
      .gvside, .gvscrim { display: none !important; }
    }
    /* Rail footer action button (Help) — styled to match the rail's <a> rows. */
    .gvside__act {
      display: flex; align-items: center; gap: 10px; width: 100%; padding: 6px 8px; border-radius: 7px;
      border: 0; background: none; cursor: pointer; text-align: left; font: inherit;
      color: #2c2f36; font-weight: 500; font-size: 13px; transition: background .12s ease, color .12s ease;
    }
    .gvside__act:hover { background: rgba(16,17,26,0.05); color: #0e0f12; }
    .gvside__act:focus-visible { outline: 2px solid #5e6ad2; outline-offset: 1px; }

    /* ── Help drawer ───────────────────────────────────────────────────────────── */
    .gvhelp { position: fixed; inset: 0; z-index: 2147483200; }
    .gvhelp[hidden] { display: none; }
    .gvhelp__scrim { position: absolute; inset: 0; background: rgba(16,17,26,0.34); opacity: 0; transition: opacity .2s ease; }
    .gvhelp.is-open .gvhelp__scrim { opacity: 1; }
    .gvhelp__panel {
      position: absolute; top: 0; right: 0; bottom: 0; width: min(460px, 92vw);
      display: flex; flex-direction: column; background: #fff;
      border-left: 1px solid rgba(16,17,26,0.10); box-shadow: -24px 0 60px -28px rgba(16,24,40,0.45);
      transform: translateX(100%); transition: transform .24s ease;
      font: 500 13px/1.5 "Inter", "Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #2c2f36;
    }
    .gvhelp.is-open .gvhelp__panel { transform: translateX(0); }
    .gvhelp__head { display: flex; align-items: center; justify-content: space-between; padding: 16px 18px 12px; border-bottom: 1px solid rgba(16,17,26,0.08); }
    .gvhelp__title { margin: 0; font: 600 16px/1.2 "Inter", "Inter Variable", sans-serif; color: #16171a; }
    .gvhelp__x { display: grid; place-items: center; width: 30px; height: 30px; border: 0; border-radius: 8px; background: none; color: #5b626e; cursor: pointer; }
    .gvhelp__x:hover { background: rgba(16,17,26,0.06); color: #16171a; }
    .gvhelp__x:focus-visible { outline: 2px solid #5e6ad2; outline-offset: 1px; }
    .gvhelp__x .gvic { width: 18px; height: 18px; }
    .gvhelp__tabs { display: flex; gap: 4px; padding: 10px 14px; border-bottom: 1px solid rgba(16,17,26,0.08); }
    .gvhelp__tab { flex: 1; padding: 7px 10px; border: 0; border-radius: 8px; background: none; cursor: pointer; font: 600 13px/1 "Inter", "Inter Variable", sans-serif; color: #5b626e; transition: background .12s ease, color .12s ease; }
    .gvhelp__tab:hover { background: rgba(16,17,26,0.05); color: #16171a; }
    .gvhelp__tab.is-active { background: rgba(94,106,210,0.10); color: #3d46b8; }
    .gvhelp__tab:focus-visible { outline: 2px solid #5e6ad2; outline-offset: 1px; }
    .gvhelp__body { flex: 1 1 auto; overflow-y: auto; overscroll-behavior: contain; padding: 4px 18px 26px; }
    .gvhelp__lead { color: #5b626e; font-size: 12.5px; margin: 14px 0 4px; }
    .gvhelp__track h4 { margin: 18px 0 6px; font: 700 11px/1.2 "Inter", "Inter Variable", sans-serif; letter-spacing: .06em; text-transform: uppercase; color: #6b7280; display: flex; align-items: center; gap: 8px; }
    .gvhelp__track p { margin: 4px 0 8px; color: #2c2f36; font-size: 13px; }
    .gvhelp__track ul { margin: 4px 0 8px; padding-left: 18px; display: flex; flex-direction: column; gap: 5px; }
    .gvhelp__track li { color: #2c2f36; font-size: 13px; }
    .gvhelp__track b { color: #16171a; font-weight: 600; }
    .gvhelp kbd { display: inline-block; min-width: 16px; padding: 1px 5px; border: 1px solid rgba(16,17,26,0.16); border-bottom-width: 2px; border-radius: 5px; background: #fff; font: 600 11px/1.4 "Inter", "Inter Variable", sans-serif; color: #3a3f48; }
    .gvhelp code { padding: 1px 5px; border-radius: 5px; background: #f1f2f5; font: 500 12px/1.4 ui-monospace, "SF Mono", Menlo, monospace; color: #39414e; }
    .gvhelp__tag { font: 600 10px/1 "Inter", "Inter Variable", sans-serif; letter-spacing: 0; text-transform: none; color: #8a6d3b; background: #fbf1d9; border-radius: 999px; padding: 3px 7px; }
    .gvhelp__themes { width: 100%; border-collapse: collapse; margin-top: 6px; }
    .gvhelp__themes td { padding: 5px 6px; border-bottom: 1px solid rgba(16,17,26,0.06); font-size: 12.5px; vertical-align: middle; }
    .gvhelp__themes td:first-child { width: 104px; }
    .gvhelp__sw { display: inline-block; width: 12px; height: 12px; border-radius: 3px; margin-right: 7px; vertical-align: -1px; box-shadow: inset 0 0 0 1px rgba(0,0,0,0.12); }

    /* ── Account settings modal ────────────────────────────────────────────────
       Same skeleton as the help drawer (fixed inset / scrim / [hidden] + .is-open),
       centred instead of slid in from the edge. Sits one z-index band above the
       drawer so it can never open behind it. */
    .gvset { position: fixed; inset: 0; z-index: 2147483210; display: grid; place-items: center; padding: 20px; }
    .gvset[hidden] { display: none; }
    .gvset__scrim { position: absolute; inset: 0; background: rgba(16,17,26,0.34); opacity: 0; transition: opacity .18s ease; }
    .gvset.is-open .gvset__scrim { opacity: 1; }
    .gvset__panel {
      position: relative; width: min(600px, 100%); max-height: min(80vh, 720px);
      display: flex; flex-direction: column; background: #fff; border-radius: 14px;
      box-shadow: 0 1px 2px rgba(16,24,40,0.06), 0 32px 70px -28px rgba(16,24,40,0.45);
      opacity: 0; transform: translateY(6px) scale(.99); transition: opacity .18s ease, transform .18s ease;
      font: 500 13px/1.5 "Inter", "Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #2c2f36;
    }
    .gvset.is-open .gvset__panel { opacity: 1; transform: none; }
    .gvset__head { display: flex; align-items: center; gap: 8px; padding: 9px 11px; border-bottom: 1px solid rgba(16,17,26,0.08); }
    /* One tab today. The tablist exists so a second is additive — see the Account tab. */
    .gvset__tabs { display: flex; gap: 4px; flex: 1 1 auto; min-width: 0; overflow-x: auto; }
    .gvset__tab { padding: 5px 10px; border: 0; border-radius: 7px; background: none; cursor: pointer; white-space: nowrap;
      font: 600 12.5px/1.2 "Inter", "Inter Variable", sans-serif; color: #5b626e; transition: background .12s ease, color .12s ease; }
    .gvset__tab:hover { background: rgba(16,17,26,0.05); color: #16171a; }
    .gvset__tab.is-active { background: rgba(16,17,26,0.07); color: #16171a; }
    .gvset__tab:focus-visible { outline: 2px solid #5e6ad2; outline-offset: 1px; }
    .gvset__x { flex: none; display: grid; place-items: center; width: 26px; height: 26px; border: 0; border-radius: 7px; background: none; color: #5b626e; cursor: pointer; }
    .gvset__x:hover { background: rgba(16,17,26,0.06); color: #16171a; }
    .gvset__x:focus-visible { outline: 2px solid #5e6ad2; outline-offset: 1px; }
    .gvset__x .gvic { width: 16px; height: 16px; }
    .gvset__body { flex: 1 1 auto; overflow-y: auto; overscroll-behavior: contain; padding: 22px 26px 26px; }
    .gvset__cols { display: flex; align-items: flex-start; gap: 30px; }
    .gvset__avcol { flex: none; display: flex; flex-direction: column; align-items: center; gap: 9px; }
    /* The big circle carries data-prof-av, so PROFILE_JS fills it with the photo or
       initials-on-colour along with every other face on the page. 96px CSS is 192-288
       device px, which is why the crop stores 320 — see SIZE in SETTINGS_JS. */
    .gvset__av { width: 96px; height: 96px; border-radius: 50%; display: grid; place-items: center;
      background: #4f46e5; color: #fff; font: 700 26px/1 "Inter", "Inter Variable", sans-serif;
      letter-spacing: .02em; text-transform: uppercase; background-size: cover; background-position: center; }
    /* Plain text, not a pill — the reference puts nothing but the word under the face. */
    .gvset__edit { padding: 2px 6px; border: 0; border-radius: 6px; background: none;
      font: 500 13px/1.4 "Inter", "Inter Variable", sans-serif; color: #16171a; cursor: pointer; transition: background .12s ease; }
    .gvset__edit:hover { background: rgba(16,17,26,0.06); }
    .gvset__edit:focus-visible { outline: 2px solid #5e6ad2; outline-offset: 1px; }
    .gvset__err { max-width: 110px; text-align: center; font-size: 11.5px; color: #b42318; }
    .gvset__err[hidden] { display: none; }
    .gvset__fields { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 18px; }
    .gvset__label { margin: 0 0 4px; font: 600 15px/1.3 "Inter", "Inter Variable", sans-serif; color: #16171a; }
    .gvset__value { margin: 0; font-size: 13px; color: #2c2f36; overflow-wrap: anywhere; }
    /* "Change …" affordances. A live one is a blue link-button; a locked one keeps its
       place in the layout but reads as unavailable rather than pretending to work. */
    .gvset__link { display: inline-flex; align-items: center; gap: 5px; margin-top: 5px; padding: 0;
      border: 0; background: none; font: 500 13px/1.4 "Inter", "Inter Variable", sans-serif;
      color: #2563eb; cursor: pointer; }
    .gvset__link:hover { text-decoration: underline; }
    .gvset__link:focus-visible { outline: 2px solid #5e6ad2; outline-offset: 2px; border-radius: 4px; }
    .gvset__link[disabled] { color: #9aa0ab; cursor: default; text-decoration: none; }
    .gvset__link .gvic { width: 12px; height: 12px; }
    .gvset__form { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; margin-top: 2px; }
    .gvset__form[hidden] { display: none; }
    .gvset__input { flex: 1 1 180px; min-width: 0; font: inherit; font-size: 13px; padding: 6px 9px;
      border: 1px solid rgba(16,17,26,0.18); border-radius: 7px; color: #16171a; background: #fff; }
    .gvset__input:focus-visible { outline: 2px solid #5e6ad2; outline-offset: 0; border-color: transparent; }
    .gvset__btn { flex: none; padding: 6px 12px; border: 0; border-radius: 7px; background: #2563eb; color: #fff;
      font: 600 12.5px/1.2 "Inter", "Inter Variable", sans-serif; cursor: pointer; }
    .gvset__btn:hover { background: #1d4ed8; }
    .gvset__btn--ghost { background: rgba(16,17,26,0.06); color: #16171a; }
    .gvset__btn--ghost:hover { background: rgba(16,17,26,0.10); }
    .gvset__btn:focus-visible { outline: 2px solid #5e6ad2; outline-offset: 2px; }
    .gvset__msg { flex-basis: 100%; font-size: 11.5px; color: #b42318; }
    .gvset__msg:empty { display: none; }
    @media (max-width: 640px) {
      .gvset__body { padding: 20px 16px 24px; }
      .gvset__cols { flex-direction: column; align-items: center; gap: 22px; }
      .gvset__fields { align-self: stretch; }
    }

    /* ── Photo crop dialog ─────────────────────────────────────────────────────
       Opens on top of the settings panel. The circle is a mask over a canvas, so
       what you frame and what gets saved are one transform at two resolutions. */
    .gvcrop { position: fixed; inset: 0; z-index: 2147483220; display: grid; place-items: center; padding: 20px; }
    .gvcrop[hidden] { display: none; }
    .gvcrop__scrim { position: absolute; inset: 0; background: rgba(16,17,26,0.34); }
    .gvcrop__panel { position: relative; width: min(420px, 100%); background: #fff; border-radius: 14px;
      padding: 14px 18px 22px; box-shadow: 0 1px 2px rgba(16,24,40,0.06), 0 32px 70px -28px rgba(16,24,40,0.45);
      font: 500 13px/1.5 "Inter", "Inter Variable", sans-serif; color: #2c2f36; }
    .gvcrop__x { position: absolute; top: 12px; right: 12px; display: grid; place-items: center; width: 30px; height: 30px;
      border: 0; border-radius: 8px; background: none; color: #5b626e; cursor: pointer; }
    .gvcrop__x:hover { background: rgba(16,17,26,0.06); color: #16171a; }
    .gvcrop__x:focus-visible { outline: 2px solid #5e6ad2; outline-offset: 1px; }
    .gvcrop__x .gvic { width: 18px; height: 18px; }
    .gvcrop__stage { display: grid; place-items: center; margin: 34px 0 20px; }
    .gvcrop__canvas { width: 288px; height: 288px; max-width: 100%; border-radius: 50%;
      background: #f1f2f5; cursor: grab; touch-action: none; }
    .gvcrop__canvas:active { cursor: grabbing; }
    .gvcrop__zoom { display: flex; align-items: center; gap: 12px; }
    .gvcrop__step { flex: none; width: 26px; height: 26px; display: grid; place-items: center; border: 0; border-radius: 7px;
      background: none; color: #16171a; font: 500 20px/1 "Inter", "Inter Variable", sans-serif; cursor: pointer; }
    .gvcrop__step:hover { background: rgba(16,17,26,0.06); }
    .gvcrop__step:focus-visible { outline: 2px solid #5e6ad2; outline-offset: 1px; }
    .gvcrop__range { flex: 1 1 auto; min-width: 0; accent-color: #5e6ad2; }
    .gvcrop__foot { display: flex; flex-direction: column; align-items: center; gap: 8px; margin-top: 20px; }
    .gvcrop__save { padding: 9px 20px; border: 0; border-radius: 8px; background: #2563eb; color: #fff;
      font: 600 14px/1.2 "Inter", "Inter Variable", sans-serif; cursor: pointer; transition: background .12s ease; }
    .gvcrop__save:hover { background: #1d4ed8; }
    .gvcrop__save:focus-visible { outline: 2px solid #5e6ad2; outline-offset: 2px; }
    .gvcrop__msg { font-size: 12px; color: #b42318; }
    .gvcrop__msg[hidden] { display: none; }
    /* The rail's dim-and-inert rule is scoped to .gvprof__item, so the dialog carries
       its own rather than widening a rail selector to reach across the page. */
    .gvset__edit[aria-busy=true], .gvcrop__save[aria-busy=true], .gvset__btn[aria-busy=true] { opacity: .55; pointer-events: none; }

    @media (prefers-reduced-motion: reduce) {
      .gvside, .gvscrim, .gvside__caret, .gvhelp__scrim, .gvhelp__panel,
      .gvset__scrim, .gvset__panel { transition: none; }
    }`;

// Magnifier glyph — used by the rail's omni-search field (railSearch).
const SEARCH_ICON = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/><path d="M21 21l-4.3-4.3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;

// "No matches" line shown under the cards when a query filters everything out.
function filterEmpty() {
  return `<p class="filter-empty" data-filter-empty hidden>No matches.</p>`;
}

// Augur brand mark — an indigo disc with a 4-point sparkle cut out of the middle
// (the "seer's eye"). One mark everywhere: the transparent glyph here in the rail/top
// bar, and the same shape on the bone tile for the favicon/PWA (augur-mark.png).
// Shipped at /augur-eye.svg (copied in main() from brand/). Sized via the .gvmark class.
// The brand mark rotates as a whole on rail-brand hover (see NAV_CSS) — the disc is a
// circle so only the sparkle cut-out appears to spin.
// Mobile (≤860px) bottom tab bar + restructured header. Replaces the off-canvas
// drawer (.gvside/.gvscrim, hidden below via NAV_CSS's 860px query) with a floating
// glass pill bar, mirroring Framework7's current iOS toolbar (.ios-glass(): backdrop-
// filter saturate(180%) blur(16px)) — the same translucency idiom .gvtop already uses.
// Scoped entirely inside the existing 860px query; nothing here reaches desktop.
const TABBAR_CSS = `
    @media (max-width: 860px) {
      /* ── Header: 3-slot row (back/spacer · brand or title · search) ─────────── */
      .gvtop { justify-content: space-between; }
      .gvtop__side {
        display: inline-flex; align-items: center; justify-content: center;
        width: 36px; height: 34px; flex: none;
      }
      .gvtop__back {
        display: inline-flex; align-items: center; justify-content: center;
        width: 36px; height: 34px; padding: 0; cursor: pointer;
        border-radius: 9px; border: 1px solid rgba(16,17,26,0.12); background: rgba(16,17,26,0.03); color: #16171a;
      }
      .gvtop__back:hover { background: rgba(16,17,26,0.06); border-color: rgba(16,17,26,0.20); }
      .gvtop__back:focus-visible { outline: 2px solid #5e6ad2; outline-offset: 1px; }
      .gvtop__back svg { width: 16px; height: 16px; }
      .gvtop__center {
        flex: 1; display: flex; align-items: center; justify-content: center; gap: 8px;
        min-width: 0; overflow: hidden;
      }
      .gvtop__center-brand { display: inline-flex; align-items: center; gap: 8px; color: #16171a; text-decoration: none; }
      .gvtop__center-brand img { width: 22px; height: 22px; border-radius: 5px; flex: none; }
      .gvtop__center-brand span { font-family: var(--font-display); font-weight: 800; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .gvtop__title { font-weight: 700; font-size: 15px; color: #16171a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .gvtop__search-btn {
        display: inline-flex; align-items: center; justify-content: center;
        width: 36px; height: 34px; padding: 0; cursor: pointer; flex: none;
        border-radius: 9px; border: 1px solid rgba(16,17,26,0.12); background: rgba(16,17,26,0.03); color: #16171a;
      }
      .gvtop__search-btn:hover { background: rgba(16,17,26,0.06); border-color: rgba(16,17,26,0.20); }
      .gvtop__search-btn svg { width: 16px; height: 16px; }
      .gvtop__search-btn .gvic { width: 16px; height: 16px; }
      .gvtop__searchwrap { flex: 1; min-width: 0; }
      .gvtop__searchwrap .gvsearch { width: 100%; }
      body:not(.gv-mobile-searching) .gvtop__searchwrap { display: none; }
      .gv-mobile-searching .gvtop__center { display: none; }

      /* ── Floating pill tab bar ────────────────────────────────────────────── */
      .gvtabbar {
        position: fixed; left: calc(12px + env(safe-area-inset-left)); right: calc(12px + env(safe-area-inset-right));
        bottom: calc(10px + env(safe-area-inset-bottom));
        z-index: 2147483100;
        height: 64px; border-radius: 32px;
        display: flex; align-items: stretch; padding: 4px;
        background: rgba(255,255,255,0.82);
        -webkit-backdrop-filter: blur(16px) saturate(180%); backdrop-filter: blur(16px) saturate(180%);
        box-shadow: 0 12px 32px -12px rgba(16,24,40,0.35), 0 0 0 1px rgba(16,17,26,0.06);
      }
      .gvtab {
        flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 2px; border-radius: 26px; text-decoration: none; color: #6b7280;
        font: 500 11px/1 "Inter", "Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        border: 0; background: none; cursor: pointer; position: relative;
      }
      /* [hidden] override: the display above would otherwise beat the UA rule (the
         Profile tab starts hidden until PROFILE_JS confirms identity). */
      .gvtab[hidden] { display: none; }
      .gvtab .gvic, .gvtab .pin-star { width: 24px; height: 24px; display: block; }
      .gvtab span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
      .gvtab[aria-current="page"] { color: #16171a; background: rgba(16,17,26,0.08); }
      /* .gvic hardcodes its own color (build.js ~2225), so currentColor from the
         active <a>'s color alone doesn't reach the icon — mirrors the desktop rail's
         own [aria-current] .gvic override. */
      .gvtab[aria-current="page"] .gvic { color: #16171a; }
      .gvtab.is-blank { visibility: hidden; pointer-events: none; }
      .gvtab.is-disabled { opacity: 0.35; pointer-events: none; }
      .gvtab-label-only { font-size: 12.5px; font-weight: 600; }

      /* ── Sheets (Pinned / Profile) — same scrim/panel shape as the help drawer ── */
      .gvsheet { position: fixed; inset: 0; z-index: 2147483150; }
      .gvsheet[hidden] { display: none; }
      .gvsheet__scrim { position: absolute; inset: 0; background: rgba(16,17,26,0.34); opacity: 0; transition: opacity .2s ease; }
      .gvsheet.is-open .gvsheet__scrim { opacity: 1; }
      .gvsheet__panel {
        position: absolute; left: 0; right: 0; bottom: 0;
        max-height: 70vh; overflow-y: auto;
        background: #fff; border-radius: 20px 20px 0 0;
        padding: 14px 16px calc(16px + env(safe-area-inset-bottom));
        box-shadow: 0 -24px 60px -28px rgba(16,24,40,0.45);
        transform: translateY(100%); transition: transform .24s ease;
        font: 500 13px/1.5 "Inter", "Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        color: #2c2f36;
      }
      .gvsheet.is-open .gvsheet__panel { transform: translateY(0); }
      .gvsheet__head { display: flex; align-items: center; justify-content: space-between; padding-bottom: 10px; margin-bottom: 6px; border-bottom: 1px solid rgba(16,17,26,0.08); }
      .gvsheet__title { margin: 0; font: 700 15px/1.2 "Inter", "Inter Variable", sans-serif; color: #16171a; }
      .gvsheet__x { display: grid; place-items: center; width: 30px; height: 30px; border: 0; border-radius: 8px; background: none; color: #5b626e; cursor: pointer; }
      .gvsheet__x:hover { background: rgba(16,17,26,0.06); color: #16171a; }
      .gvsheet__x .gvic { width: 18px; height: 18px; }
    }
    @media (min-width: 861px) {
      .gvtabbar, .gvsheet { display: none; }
    }
`;

const GV_MARK = `<img class="gvmark" src="/augur-eye.svg" alt="" aria-hidden="true" width="24" height="24" />`;

// Rail item glyphs — real Lucide icons (ISC license), the clean line set Linear-class
// apps use. Verbatim official paths, rendered at a refined 1.75 stroke for that crisp
// Linear weight; 24px viewBox, currentColor, tinted/sized via .gvic.
const ic = (inner) => `<svg class="gvic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
// Role icons, one per role — the People table shows the role as icon + label, so the
// three must read apart at a glance and not just by their word. Lucide, same set and
// stroke as the rail's.
const IC_ROLE_ADMIN = ic(`<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>`); // shield
const IC_ROLE_EDITOR = ic(`<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>`); // pencil
const IC_ROLE_VIEWER = ic(`<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>`); // eye
const IC_HOME = ic(`<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>`); // layout-grid
const IC_PLAY = ic(`<path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2"/><path d="M6.453 15h11.094"/><path d="M8.5 2h7"/>`); // flask-conical
const IC_FOLDER = ic(`<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>`); // folder
const IC_PRIM = ic(`<path d="M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z"/><rect x="3" y="14" width="7" height="7" rx="1"/><circle cx="17.5" cy="17.5" r="3.5"/>`); // shapes
const IC_COMP = ic(`<path d="M15.536 11.293a1 1 0 0 0 0 1.414l2.376 2.377a1 1 0 0 0 1.414 0l2.377-2.377a1 1 0 0 0 0-1.414l-2.377-2.377a1 1 0 0 0-1.414 0z"/><path d="M2.297 11.293a1 1 0 0 0 0 1.414l2.377 2.377a1 1 0 0 0 1.414 0l2.377-2.377a1 1 0 0 0 0-1.414L6.088 8.916a1 1 0 0 0-1.414 0z"/><path d="M8.916 17.912a1 1 0 0 0 0 1.415l2.377 2.376a1 1 0 0 0 1.414 0l2.377-2.376a1 1 0 0 0 0-1.415l-2.377-2.376a1 1 0 0 0-1.414 0z"/><path d="M8.916 4.674a1 1 0 0 0 0 1.414l2.377 2.376a1 1 0 0 0 1.414 0l2.377-2.376a1 1 0 0 0 0-1.414l-2.377-2.377a1 1 0 0 0-1.414 0z"/>`); // component
const IC_PAGE = ic(`<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 4v4"/><path d="M2 8h20"/><path d="M6 4v4"/>`); // app-window (pages are websites, not paper)
const IC_RESEARCH = ic(`<path d="M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M14 3v4h4"/><path d="M8.5 13h7M8.5 16.5h4.5"/>`); // document with text lines (internal research/context docs)

// Research/context surface — gated metadata only. The count, and (interactive variant)
// the filenames on click. Names live only on the already-gated index pages; file
// CONTENT is never read or shipped. Empty research → renders nothing.
function researchLabel(n) { return `${n} research ${n === 1 ? "file" : "files"}`; }
function researchListItems(research) {
  return research
    .map((r) => `<li><span class="research-pop__name">${escAttr(r.name)}</span><span class="research-pop__date" title="${escAttr(fmtDate(r.mtimeMs))}">${relTime(r.mtimeMs)}</span></li>`)
    .join("");
}
// Interactive (opportunity page header): click → disclosure of the filenames.
function researchChip(research) {
  if (!research || !research.length) return "";
  const label = researchLabel(research.length);
  return `<span class="research-wrap"><button type="button" class="research-chip" aria-expanded="false" aria-label="${label}" title="${label}">${IC_RESEARCH}<span class="research-chip__n">${research.length}</span></button><div class="research-pop" role="group" aria-label="Research &amp; context files" hidden><div class="research-pop__head">Research &amp; context</div><ul class="research-pop__list">${researchListItems(research)}</ul></div></span>`;
}
const IC_LIBRARY = ic(`<path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/>`); // library
const IC_CHANGELOG = ic(`<path d="M12 8v4l3 2"/><path d="M3.05 11a9 9 0 1 1 .5 4"/><path d="M3 21v-5h5"/>`); // history (clock + counter-rotate)
const IC_CHEV = ic(`<path d="m9 18 6-6-6-6"/>`); // chevron-right (rotates open via CSS)
const IC_GEAR = ic(`<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>`); // settings
const IC_SIGNOUT = ic(`<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>`); // log-out
const IC_LOCK = ic(`<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>`); // lock — marks a "Change …" that isn't wired yet
const IC_SLIDERS = ic(`<line x1="4" x2="4" y1="21" y2="14"/><line x1="4" x2="4" y1="10" y2="3"/><line x1="12" x2="12" y1="21" y2="12"/><line x1="12" x2="12" y1="8" y2="3"/><line x1="20" x2="20" y1="21" y2="16"/><line x1="20" x2="20" y1="12" y2="3"/><line x1="2" x2="6" y1="14" y2="14"/><line x1="10" x2="14" y1="8" y2="8"/><line x1="18" x2="22" y1="16" y2="16"/>`); // sliders-vertical (account settings)
const IC_HELP = ic(`<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>`); // circle-help
const IC_CLOSE = ic(`<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`); // x
const IC_TOKEN = ic(`<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>`); // palette (tokens)
const IC_PATTERN = ic(`<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M10 6.5h4M6.5 10v4M17.5 10v4M10 17.5h4"/>`); // grid + links (patterns)

// Star toggle on cards — Lucide 'star'. Outline (grey) when unpinned, gold-filled
// when pinned (PINS_JS toggles .is-pinned). Its own class so CSS can flip the fill.
const IC_STAR = `<svg class="pin-star" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/></svg>`;

// A "pin to sidebar" star button for a pinnable card. PINS_JS reads/sets state.
function pinStar(key, href) {
  return `<button type="button" class="pin-btn" data-pin-key="${key}" data-pin-href="${href}" aria-pressed="false" aria-label="Pin to sidebar" title="Pin to sidebar">${IC_STAR}</button>`;
}

// Lays each face chip's photo over its initials — but only once the image has really
// loaded, so a URL the instance no longer serves (see faceChip) leaves the initials
// standing instead of an empty circle. One Image() per chip, all from cache after the
// first card. Exposed as a hook for cards injected after load.
//
// The sizing is stamped inline next to the image rather than left to the chip's class:
// a photo painted at natural size lands as a 22px crop of its top-left corner, and the
// chip's own inline colour is one `background:` shorthand away from resetting the
// stylesheet's cover/center (that is exactly how it broke). Set together, they can't
// come apart.
// `data-person` is the live path: ids are resolved through /__people, which answers with
// each person's CURRENT face. `data-face` is still honoured because pages published by an
// older build have the URL baked in and must keep painting until they are republished.
// PEOPLE_LOOKUP_MAX in the worker caps a lookup at 50 ids, hence the chunking; the
// per-id cache means a re-wire after cards are injected refetches nothing.
const FACE_JS = `
(function(){
  var RESOLVED = {};
  function lay(el, src){
    if(!src) return;
    var img = new Image();
    img.onload = function(){
      el.style.backgroundImage = "url('" + src + "')";
      el.style.backgroundSize = 'cover';
      el.style.backgroundPosition = 'center';
      el.textContent = '';
    };
    img.onerror = function(){ delete el.dataset.faceDone; };
    img.src = src;
  }
  function paintBaked(el){
    var src = el.getAttribute('data-face');
    if(!src || el.dataset.faceDone) return;
    el.dataset.faceDone = '1';
    lay(el, src);
  }
  function chunk(a, n){ var o = []; for(var i=0;i<a.length;i+=n) o.push(a.slice(i,i+n)); return o; }
  function resolve(els){
    var pending = {}, need = [];
    for(var i=0;i<els.length;i++){
      var el = els[i], id = el.getAttribute('data-person');
      if(!id || el.dataset.faceDone) continue;
      el.dataset.faceDone = '1';
      if(RESOLVED[id] !== undefined){ lay(el, RESOLVED[id]); continue; }
      (pending[id] = pending[id] || []).push(el);
      if(need.indexOf(id) < 0) need.push(id);
    }
    chunk(need, 50).forEach(function(ids){
      fetch('/__people?ids=' + encodeURIComponent(ids.join(',')), { credentials: 'same-origin' })
        .then(function(r){ return r.ok ? r.json() : null; })
        .then(function(d){
          if(!d || !d.people) return;
          // Cache the misses too (null): an id nobody answers for must not be re-asked
          // on every wire, and the chip is already showing the right initials.
          ids.forEach(function(id){ if(RESOLVED[id] === undefined) RESOLVED[id] = null; });
          d.people.forEach(function(p){
            RESOLVED[p.id] = p.avatar || null;
            (pending[p.id] || []).forEach(function(el){ lay(el, p.avatar); });
          });
        })
        .catch(function(){
          // Offline/file:// or a gate in the way — leave the initials standing and let a
          // later wire try again rather than caching a network failure as "no face".
          ids.forEach(function(id){ (pending[id] || []).forEach(function(el){ delete el.dataset.faceDone; }); });
        });
    });
  }
  function wire(){
    Array.prototype.forEach.call(document.querySelectorAll('[data-face]'), paintBaked);
    resolve([].slice.call(document.querySelectorAll('[data-person]')));
  }
  window.__gvFacesWire = wire;
  wire();
})();`;

const IC_PLUS = ic(`<path d="M12 5v14"/><path d="M5 12h14"/>`); // plus

// "+ New canvas" — folderbar action on Playground and each project folder. A canvas
// needs no repo scaffold to be born: the button registers <dir><slug>/ in the
// /__canvases KV map and the worker serves the standard canvas loader there (see
// canvasesApi in src/_worker.js). Hidden until NEWCANVAS_JS confirms a signed-in
// user (or an open/no-identity build).
function newCanvasBtn(dir) {
  return `<button type="button" class="folderbar__new" data-new-canvas="${dir}" hidden>${IC_PLUS}New canvas</button>`;
}

// The same one-way person id the worker derives (`personId` in src/_worker.js) and
// answers `/__people?ids=` for. Duplicated rather than imported because the build emits
// static HTML and shares no module with the worker; the two hashes MUST agree, so change
// them together or every chip on every page resolves to nobody.
function personIdOf(email) {
  const s = String(email == null ? "" : email).trim().toLowerCase();
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// Initials on the person's colour, with their photo laid over it by FACE_JS once it
// resolves. What gets baked is the person's ID, never their photo URL: a face is not a
// build-time fact. An avatar URL is content-addressed (it hashes the photo's bytes), so
// it names one specific photo — and every way a face can change happens AFTER the page
// is built. Someone sets their own photo from the profile menu, an admin edits the
// roster, a seed changes in identity.json: each mints a new URL and every page published
// before it keeps pointing at the old one, which 404s. That is not a stale image, it is
// no image — the chip silently drops to initials across the whole site until every space
// is republished, and nothing in the product tells you it happened.
//
// Resolving the id at request time instead makes republishing irrelevant: /__people
// hands back whatever face that person has NOW (60s cache), so a self-upload lands
// everywhere on its own. Initials still render first and still stand if the lookup
// fails, so the degraded state is a name rather than an empty circle.
//
// The colour is `background-color`, never the `background` SHORTHAND: the shorthand is
// inline, so it beats `.proto-editor` and resets `background-size`/`background-position`
// to their initial values — the photo FACE_JS lays over it then paints at its natural
// 96px from the top-left, and every card face becomes a blurry crop of someone's hair.
function faceChip(u, cls, label) {
  const ini = escAttr((u.initials || (u.name || "?").slice(0, 2)).toUpperCase());
  const face = u.email ? ` data-person="${escAttr(personIdOf(u.email))}"` : "";
  return `<span class="${cls}" style="background-color:${u.color || "#4f46e5"}"${face} title="${label}" aria-label="${label}">${ini}</span>`;
}

// A small avatar for whoever the prototype mostly belongs to (build's
// mainContributor). "" when nobody we know has committed to it.
function editorChip(ed) {
  if (!ed) return "";
  return faceChip(ed, "proto-editor", `Main contributor: ${escAttr(ed.name)}`);
}

// Overlapping face pile — EVERY known contributor to a folder (most commits
// first), the at-a-glance "who works here" on root project cards. Capped so a
// busy folder stays light; the overflow count keeps it honest.
function facePile(people, cap = 5) {
  if (!people || !people.length) return "";
  const shown = people.slice(0, cap);
  const extra = people.length - shown.length;
  const chips = shown.map((u) => faceChip(u, "proto-editor opp-face", escAttr(u.name))).join("");
  const more = extra > 0 ? `<span class="proto-editor opp-face opp-face--more" title="+${extra} more">+${extra}</span>` : "";
  return `<span class="opp-people" role="group" aria-label="Contributors">${chips}${more}</span>`;
}

// Test emojis for prototypes/projects (the user will rename to real ones later). A
// stable hash off the slug picks from a varied pool so each card gets a distinct
// leading emoji — the rail promotes that emoji into the Pinned row's icon slot.
const EMOJI_POOL = ["🗳️","🏛️","📊","🧭","🛰️","🧩","🪧","🌳","🚲","📣","🗺️","🧪","💡","🔭","🪟","🧱","🎛️","🛣️","🧰","📐","🧮","🗂️","🔔","🏘️","🌍","💬","📝","🚏","🏙️","🌿","🎚️","🧷"];
function protoEmoji(slug) {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return EMOJI_POOL[h % EMOJI_POOL.length];
}
// Display name for a pinnable card = test emoji + title (until the user renames it).
function protoName(slug) {
  return `${protoEmoji(slug)} ${titleCase(slug)}`;
}

// Nav context (opportunities + whether Playground shipped), set once in main() so the
// same rail renders identically on every page without threading it through each call.
const NAV_STATE = { opportunities: [], hasPlayground: false, spaces: [], activeSpace: "" };
// The default space's nav context, kept aside while the loop builds the other spaces.
// The shared chrome pages (Changelog, Admin) ship at the dist ROOT, so their rail must
// be the default space's rail — not whichever space happened to be built last.
let DEFAULT_NAV = null;

// The omni search field — lives in the rail, filters whatever cards are on the right
// (the shared chrome script wires [data-filter] to the current page's [data-fitem]).
function railSearch() {
  return `<div class="gvsearch" data-search-src="${S("/__search.json")}" data-search-base="${S("/")}">${SEARCH_ICON}` +
    `<input type="text" data-filter placeholder="Search…" aria-label="Search content" autocomplete="off" autocapitalize="off" spellcheck="false" />` +
    `<button type="button" class="gvsearch__clear" data-filter-clear aria-label="Clear search" hidden>&times;</button>` +
    `<kbd data-filter-kbd>/</kbd></div>`;
}

// Profile chip — sits in the brand spot under the wordmark. Static markup; PROFILE_JS
// fills the avatar/name/email from /__me (per-request identity, so it can't be baked
// at build time) and reveals the chip + the admin link only when relevant. Hidden by
// default so signed-out / open (no-identity) builds show nothing.
function profileChip() {
  return `<div class="gvprof" data-prof hidden>
      <button type="button" class="gvprof__btn" data-prof-toggle aria-haspopup="true" aria-expanded="false" aria-label="Account">
        <span class="gvprof__av" data-prof-av aria-hidden="true"></span>
        <span class="gvprof__name" data-prof-name>…</span>
        <span class="gvprof__dot" data-prof-dot hidden title="Update available">!</span>
        <svg class="gvprof__cv" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <div class="gvprof__menu" data-prof-menu role="menu" hidden>
        <div class="gvprof__id">
          <span class="gvprof__av lg" data-prof-av aria-hidden="true"></span>
          <span class="gvprof__idtext"><span class="gvprof__name" data-prof-name></span><span class="gvprof__email" data-prof-email></span></span>
        </div>
        <button type="button" class="gvprof__item" role="menuitem" data-prof-settings>${IC_SLIDERS}<span>Settings</span></button>
        <a class="gvprof__item" href="/__logout" role="menuitem" data-prof-signout>${IC_SIGNOUT}<span>Sign out</span></a>
        <div class="gvprof__ver" data-prof-ver hidden>
          <span data-prof-vercur></span>
          <a data-prof-verlink href="#" target="_blank" rel="noopener" hidden></a>
        </div>
      </div>
    </div>`;
}

// Space switcher — sits above the main nav (the team-switcher in the brief): the active
// space's icon + name + badge, with a dropdown of every space (check on the active one)
// and a Create-new stub. The space list is known at build time (NAV_STATE.spaces) and the
// active space is stamped by setSpaceContext (NAV_STATE.activeSpace), so this is fully
// server-rendered — SPACE_JS only toggles the menu open/closed. Each row links to the
// space's base URL ("/" for the default, "/<id>/" otherwise). Hidden when only one space
// exists (nothing to switch to) — the chip would be noise.
function spaceSwitcher() {
  const spaces = NAV_STATE.spaces || [];
  if (!spaces.length) return "";
  const active = spaces.find((s) => s.id === NAV_STATE.activeSpace) || spaces[0];
  // Nameplate + cog, and nothing else.
  //
  // No dropdown: nobody can belong to more than one workspace yet — that needs
  // per-workspace origins and a central sign-in (plan items B-resolver-dynamic and
  // B-cross-workspace-signin). A chevron opening a list of one is furniture, and a
  // list built at BUILD time could only ever name spaces the viewer may not enter.
  // When membership can genuinely span workspaces, the switcher comes back with rows
  // rendered from /__me rather than baked in.
  //
  // No badge either: it labelled which space was "current" back when the switcher was
  // a maintainer's tool for hopping between them. With one workspace it says nothing.
  const iconSrc = "/space-icon.png";
  const icon = `<span class="gvspace__icon"><img src="${iconSrc}" alt="" width="20" height="20" data-space-icon /></span>`;
  return `<div class="gvspace" data-space data-space-active="${escAttr(active.id)}">
      <div class="gvspace__row">
        <span class="gvspace__btn">
          ${icon}<span class="gvspace__name" data-space-name>${escAttr(active.name)}</span>
        </span>
      </div>
    </div>`;
}

// The persistent left rail: brand → omni search → Playground → Opportunities → Pinned
// (the user's starred prototypes/projects, rendered client-side by PINS_JS) → Design system
// (collapsible, pinned to the bottom). `active` is a single key: 'prototypes' |
// 'playground' | <opportunity name> | 'primitives' | 'components' | 'pages'.
// The library's own sections — used both to build its rail and to know when the rail
// should BE the library's (see appChrome).
const LIB_KEYS = ["tokens", "base", "components", "patterns", "pages", "primitives"];

function sideRail(active) {
  const item = (href, label, key, icon) =>
    `<a href="${S(href)}"${active === key ? ' aria-current="page"' : ""}>${icon}<span>${label}</span></a>`;
  const playground = NAV_STATE.hasPlayground ? item("/playground/", "Playground", "playground", IC_PLAY) : "";
  // Workspace admin sits with the other destinations rather than as a cog beside the
  // name — it IS a place you go, and the rail is where places live. Hidden until
  // SPACE_JS confirms you administer this workspace (html.gv-space-admin); the href
  // carries the space id so the page opens already scoped, filled in by SPACE_JS too.
  const adminItem = `<a class="gvside__admin" href="/admin/" data-space-admin${
    NAV_STATE.activeSpace ? ` data-space-id="${escAttr(NAV_STATE.activeSpace)}"` : ""
  }>${IC_GEAR}<span>Admin</span></a>`;
  // The design system is a destination like the others now, not a disclosure wedged in
  // the foot. `library` stays the internal key — renaming it would churn every
  // aria-current match and the LIB_KEYS list for no user-visible gain.
  // Everyone sees it; opening it swaps the rail for its own sections, the same shape
  // Admin uses — one nav column at a time, never two.
  const libraryItem = item("/tokens/", "Design system", "library", IC_LIBRARY);
  // Pinned is rendered live from the KV pins map (PINS_JS fills [data-pinned-list] and
  // toggles the empty hint); nothing is server-rendered here.
  const pinned = `<p class="gvside__label">Pinned</p>
      <div class="gvside__group" data-pinned-list></div>
      <p class="gvside__pinhint" data-pinned-empty hidden>Star a prototype to pin it here.</p>`;
  // Library is a collapsible section in the pinned foot (Changelog sits below it);
  // collapsed by default, auto-opens when you're on one of its pages. Its own icon
  // leads; the disclosure chevron sits on the right.
  // Layered design system: Tokens → Base → Components → Patterns → Pages.
  return `<aside class="gvside" id="gvside" aria-label="Augur">
    ${profileChip()}
    ${railSearch()}
    <div class="gvside__rule"></div>
    ${spaceSwitcher()}
    <div class="gvside__scroll">
      <div class="gvside__group">
        ${item("/", PROJECTS_LABEL, "prototypes", IC_HOME)}
        ${playground}
        ${libraryItem}
        ${adminItem}
      </div>
      ${pinned}
    </div>
    <div class="gvside__foot">
      <div class="gvside__rule"></div>
      <div class="gvside__group" style="margin-top:6px">
        <a href="/changelog/"${active === "changelog" ? ' aria-current="page"' : ""}>${IC_CHANGELOG}<span>Changelog</span><span class="gvside__ver">v${UI_VERSION}</span></a>
      </div>
    </div>
  </aside>`;
}

// Mobile bottom tab bar. Mirrors the same three-way branch appChrome() already
// computes for the rail (active === "admin" / LIB_KEYS.includes(active) / else) —
// "one nav column at a time" expressed as one bar content at a time, not a second
// source of truth for which nav shows. Reuses the existing IC_STAR (build.js:2631,
// the pin-button glyph) for the Pinned tab rather than a second star icon.
function tabBar(active) {
  const tab = (href, label, key, icon, extraAttrs) =>
    `<a class="gvtab" href="${S(href)}"${active === key ? ' aria-current="page"' : ""}${extraAttrs || ""}>${icon}<span>${label}</span></a>`;
  const blankSlot = `<span class="gvtab is-blank" aria-hidden="true"></span>`;

  if (active === "admin") {
    // Same three destinations as adminRail() (build.js:3084-3086), label-only —
    // adminRail()'s tab() helper has no icon set to reuse. Two blank slots keep the
    // bar's 5-column width stable across every context. Same data-admin-tab
    // attribute/values adminRail() itself uses — ADMIN_SECTIONS_JS's tab query is
    // widened to reach both sets from one place, not a parallel mechanism.
    return `<nav class="gvtabbar" aria-label="Workspace settings">
      <button type="button" class="gvtab gvtab-label-only" data-admin-tab="people"><span>People</span></button>
      <button type="button" class="gvtab gvtab-label-only" data-admin-tab="content"><span>Content</span></button>
      <button type="button" class="gvtab gvtab-label-only" data-admin-tab="settings"><span>Settings</span></button>
      ${blankSlot}${blankSlot}
    </nav>`;
  }

  if (LIB_KEYS.includes(active)) {
    // Same five destinations as libraryRail() (build.js:3060-3064), same order.
    return `<nav class="gvtabbar" aria-label="Design system">
      ${tab("/tokens/", "Tokens", "tokens", IC_TOKEN)}
      ${tab("/base/", "Base", "base", IC_PRIM)}
      ${tab("/components/", "Components", "components", IC_COMP)}
      ${tab("/patterns/", "Patterns", "patterns", IC_PATTERN)}
      ${tab("/pages/", "Pages", "pages", IC_PAGE)}
    </nav>`;
  }

  const playground = NAV_STATE.hasPlayground
    ? tab("/playground/", "Playground", "playground", IC_PLAY)
    : blankSlot;
  // By this point active === "admin" and LIB_KEYS.includes(active) have already
  // returned above, so anything left besides "playground"/"changelog" is either the
  // literal root ("prototypes") or an opportunity's own name — both are still
  // Projects, the same way appChrome()'s isOpportunity treats them as one section.
  const projectsActive = active !== "playground" && active !== "changelog";
  return `<nav class="gvtabbar" aria-label="Primary">
    <a class="gvtab" href="${S("/")}"${projectsActive ? ' aria-current="page"' : ""}>${IC_HOME}<span>${PROJECTS_LABEL}</span></a>
    ${playground}
    ${tab("/tokens/", "Design system", "library", IC_LIBRARY)}
    <button type="button" class="gvtab" data-tab-pinned aria-haspopup="dialog">${IC_STAR}<span>Pinned</span></button>
    <button type="button" class="gvtab" data-prof data-tab-profile aria-haspopup="dialog" hidden><span class="gvprof__av" data-prof-av aria-hidden="true"></span><span>Profile</span></button>
  </nav>`;
}

// Second copy of the pinned list — sideRail()'s copy lives inside .gvside, which is
// off-canvas on mobile (no toggle left to open it), so it can't double as this
// sheet's content. PINS_JS is made multi-instance-aware below so both copies stay in
// sync off the one /__pins fetch.
function mobilePinnedSheet() {
  return `<div class="gvsheet" id="gvpinsheet" data-pin-sheet hidden>
    <div class="gvsheet__scrim" data-pin-sheet-scrim></div>
    <div class="gvsheet__panel" role="dialog" aria-modal="true" aria-label="Pinned">
      <div class="gvsheet__head">
        <h2 class="gvsheet__title">Pinned</h2>
        <button type="button" class="gvsheet__x" data-pin-sheet-close aria-label="Close">${IC_CLOSE}</button>
      </div>
      <div class="gvside__group" data-pinned-list></div>
      <p class="gvside__pinhint" data-pinned-empty hidden>Star a prototype to pin it here.</p>
    </div>
  </div>`;
}

// Second copy of the profile chip's identity block/menu, plus the two items the
// sidebar's foot carried (Admin, Changelog) that have nowhere else to live once the
// drawer is off-canvas. profileChip() itself is called unchanged — see PROFILE_JS,
// SETTINGS_JS and SPACE_JS below for the matching multi-instance fixes this requires.
function mobileProfileSheet() {
  return `<div class="gvsheet" id="gvprofsheet" data-prof-sheet hidden>
    <div class="gvsheet__scrim" data-prof-sheet-scrim></div>
    <div class="gvsheet__panel" role="dialog" aria-modal="true" aria-label="Profile">
      <div class="gvsheet__head">
        <h2 class="gvsheet__title">Profile</h2>
        <button type="button" class="gvsheet__x" data-prof-sheet-close aria-label="Close">${IC_CLOSE}</button>
      </div>
      ${profileChip()}
      <a class="gvside__admin" href="/admin/" data-space-admin${
        NAV_STATE.activeSpace ? ` data-space-id="${escAttr(NAV_STATE.activeSpace)}"` : ""
      }>${IC_GEAR}<span>Admin</span></a>
      <a href="/changelog/">${IC_CHANGELOG}<span>Changelog</span><span class="gvside__ver">v${UI_VERSION}</span></a>
    </div>
  </div>`;
}

// City themes for the Help drawer's ?theme= reference. Mirrors GV_THEMES in
// the space's UI-skill themes file (id, name, primary) — that file is the
// source of truth; this is a static copy for the shell (which doesn't load it).
const HELP_THEMES = [
  [0, "Linz", "#604596"], [1, "Dublin City", "#0077A3"], [2, "Stadt Wien", "#FF5A64"],
  [3, "Københavns Kommune", "#000C2E"], [4, "City of St. Louis", "#033D8B"], [5, "Oslo kommune", "#034B45"],
  [6, "Lambeth", "#246797"], [7, "Stad Lokeren", "#025157"], [8, "Engaged California", "#1C2745"],
];

// The Help drawer — a right-side slide-in panel opened from the rail footer (data-help-open).
// Two tracks: Reviewing (stakeholders giving feedback) + Building (driving an agent). Present
// on every page via appChrome(); chromeScript() wires open/close + track switching.
function helpDrawer() {
  const themeRows = HELP_THEMES.map(
    ([id, name, c]) => `<tr><td><code>?theme=${id}</code></td><td><span class="gvhelp__sw" style="background:${c}"></span>${name}</td></tr>`
  ).join("");
  return `<div class="gvhelp" data-help hidden>
    <div class="gvhelp__scrim" data-help-scrim></div>
    <div class="gvhelp__panel" role="dialog" aria-modal="true" aria-label="Help">
      <header class="gvhelp__head">
        <h3 class="gvhelp__title">Help</h3>
        <button type="button" class="gvhelp__x" data-help-close aria-label="Close help">${IC_CLOSE}</button>
      </header>
      <div class="gvhelp__tabs" role="tablist" aria-label="Help topics">
        <button type="button" class="gvhelp__tab" data-help-tab="review" role="tab">Reviewing</button>
        <button type="button" class="gvhelp__tab" data-help-tab="build" role="tab">Building</button>
      </div>
      <div class="gvhelp__body">
        <section class="gvhelp__track" data-help-track="review" role="tabpanel">
          <h4>Comment</h4>
          <ul>
            <li><kbd>Shift</kbd>+<kbd>C</kbd>: toggle review mode.</li>
            <li>Click any element to drop a pin, type, press <kbd>Enter</kbd>.</li>
            <li>Pins scope to the screen they were made on. Off-screen pins hide.</li>
            <li><kbd>Esc</kbd>: exit review mode.</li>
          </ul>

          <h4>Layers view</h4>
          <ul>
            <li>In review mode, press <kbd>&uarr;</kbd>/<kbd>&darr;</kbd> (or click the Layers pill, bottom-left).</li>
            <li>Boxes every element by layer: Components, +Base, +Tokens.</li>
            <li>+Tokens paints live spacing on each box.</li>
          </ul>

          <h4>Marks</h4>
          <ul>
            <li><b>Comments</b>: your pins and threads (review mode on).</li>
            <li><b>Annotations</b>: notes pinned to stay visible with review off. Skipped by "resolve comments".</li>
            <li><b>Status</b>: the badge on each card. Click to cycle Dev ready, In progress, Ignore.</li>
          </ul>

          <h4>Cards</h4>
          <ul>
            <li>Right-click a card: Open, Copy link, Download HTML, Rename, Edit description.</li>
            <li>Star a card to pin it to the sidebar. Drag pinned items to reorder.</li>
          </ul>

          <h4>Search</h4>
          <ul>
            <li><kbd>/</kbd> focus. <kbd>Cmd</kbd>/<kbd>Ctrl</kbd>+<kbd>K</kbd> focus and select. <kbd>Esc</kbd> clear.</li>
          </ul>

          <h4>Replies appear</h4>
          <ul><li>An agent may answer or resolve your comment in-thread. That is the comment loop (see Building).</li></ul>
        </section>

        <section class="gvhelp__track" data-help-track="build" role="tabpanel" hidden>
          <h4>Skills</h4>
          <ul>
            <li><code>frontend-design</code>: generic design craft. Default (Free mode).</li>
            <li>The space's UI skill (<code>*-ui</code>): real product tokens + <code>.gv-*</code> components.</li>
            <li>The a11y skill: accessibility audit (contrast, zoom, target size).</li>
            <li>Persona critique + <code>webapp-testing</code>: critique in character, run personas + a11y.</li>
          </ul>

          <h4>Modes</h4>
          <ul>
            <li><b>Free</b>: default, light, generic craft.</li>
            <li><b>System-building</b>: faithful library work (design-system repo).</li>
            <li>Everything else is opt-in. Name it to load it.</li>
          </ul>

          <h4>Avoid</h4>
          <ul>
            <li>No hardcoded brand colours. Use <code>var(--gv-tenant-primary | secondary | text)</code>.</li>
            <li>Design system is read-only from a prototype. Edit the source, don't copy <code>.gv-*</code> out.</li>
            <li>Prototypes stay self-contained static HTML, no build step.</li>
            <li>A11y: no colour-only state, low contrast, disabled zoom, tiny targets.</li>
          </ul>

          <h4>Context</h4>
          <ul>
            <li>Standing rules: <code>CLAUDE.md</code>. Product depth: the space's product doc (re-read on a real doubt, not auto-loaded).</li>
            <li>Name a mode to pull capability.</li>
          </ul>

          <h4>Comment loop <span class="gvhelp__tag">maintainer</span></h4>
          <ul>
            <li><code>npm run review --open</code> lists open threads.</li>
            <li>The agent fixes, replies, resolves in-thread. Put it on <code>/loop</code> to keep watching.</li>
            <li>Not automated. You steer it.</li>
          </ul>

          <h4>Themes</h4>
          <ul>
            <li><code>?theme=&lt;id&gt;</code> on any prototype URL. Numeric id only (<code>?theme=2</code>, not a name).</li>
            <li>Picker sits bottom-right. Hide with <code>&lt;body data-gv-theme-picker="off"&gt;</code>.</li>
            <li><code>?cookies=reset</code> re-shows the cookie banner.</li>
          </ul>
          <table class="gvhelp__themes"><tbody>${themeRows}</tbody></table>
        </section>
      </div>
    </div>
  </div>`;
}

// Account settings — a centred modal opened from the profile menu ([data-prof-settings]),
// rendered at body level rather than inside the rail so it escapes the rail's stacking
// and overflow context (same reason the help drawer sits out here).
//
// Only the photo is editable; name, email and role render read-only until each is wired,
// because a "Change" link that opens nothing is worse than no link. The tab bar ships
// with one tab on purpose — Notifications/Security later is one <button role=tab> plus
// one <section role=tabpanel>, with nothing existing having to move.
//
// The avatar carries data-prof-av, so PROFILE_JS's paint() fills it (photo, or
// initials on the person's colour) from the same /__me fetch that fills the chip;
// data-prof-name and data-prof-email fill the same way. Role is the one new hook.
function settingsModal() {
  return `<div class="gvset" data-set hidden>
    <div class="gvset__scrim" data-set-scrim></div>
    <div class="gvset__panel" role="dialog" aria-modal="true" aria-label="Settings">
      <div class="gvset__head">
        <div class="gvset__tabs" role="tablist" aria-label="Settings sections">
          <button type="button" class="gvset__tab is-active" data-set-tab="account" role="tab" aria-selected="true">Account</button>
        </div>
        <button type="button" class="gvset__x" data-set-close aria-label="Close settings">${IC_CLOSE}</button>
      </div>
      <div class="gvset__body">
        <section class="gvset__cols" data-set-panel="account" role="tabpanel" aria-label="Account">
          <div class="gvset__avcol">
            <span class="gvset__av" data-prof-av aria-hidden="true"></span>
            <button type="button" class="gvset__edit" data-set-edit>Edit</button>
            <p class="gvset__err" data-set-err hidden></p>
            <input type="file" accept="image/*" data-set-file hidden />
          </div>
          <div class="gvset__fields">
            <div>
              <h3 class="gvset__label">Name</h3>
              <div data-set-name-view>
                <p class="gvset__value" data-prof-name></p>
                <button type="button" class="gvset__link" data-set-rename>Change name</button>
              </div>
              <form class="gvset__form" data-set-name-form hidden>
                <input type="text" class="gvset__input" data-set-name-input maxlength="60"
                  autocomplete="name" aria-label="Your name" />
                <button type="submit" class="gvset__btn" data-set-name-save>Save</button>
                <button type="button" class="gvset__btn gvset__btn--ghost" data-set-name-cancel>Cancel</button>
                <span class="gvset__msg" data-set-name-msg aria-live="polite"></span>
              </form>
            </div>
            <div>
              <h3 class="gvset__label">Email</h3>
              <p class="gvset__value" data-prof-email></p>
              <button type="button" class="gvset__link" disabled title="Changing your email isn't available yet">${IC_LOCK}Change email</button>
            </div>
            <div>
              <h3 class="gvset__label">Password</h3>
              <p class="gvset__value">&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;</p>
              <button type="button" class="gvset__link" disabled title="Changing your own password isn't built yet — ask an admin of every workspace you belong to, or the instance admin, to reset it">${IC_LOCK}Change password</button>
            </div>
            <div><h3 class="gvset__label">Role</h3><p class="gvset__value" data-set-role></p></div>
          </div>
        </section>
      </div>
    </div>
  </div>
  <div class="gvcrop" data-crop hidden>
    <div class="gvcrop__scrim" data-crop-scrim></div>
    <div class="gvcrop__panel" role="dialog" aria-modal="true" aria-label="Crop photo">
      <button type="button" class="gvcrop__x" data-crop-close aria-label="Cancel">${IC_CLOSE}</button>
      <div class="gvcrop__stage"><canvas class="gvcrop__canvas" data-crop-canvas width="576" height="576"></canvas></div>
      <div class="gvcrop__zoom">
        <button type="button" class="gvcrop__step" data-crop-out aria-label="Zoom out">&minus;</button>
        <input type="range" class="gvcrop__range" data-crop-range min="1" max="3" step="0.01" value="1" aria-label="Zoom" />
        <button type="button" class="gvcrop__step" data-crop-in aria-label="Zoom in">+</button>
      </div>
      <div class="gvcrop__foot">
        <button type="button" class="gvcrop__save" data-crop-save>Save image</button>
        <p class="gvcrop__msg" data-crop-msg hidden></p>
      </div>
    </div>
  </div>`;
}

// Full chrome injected at the top of <body>: slim mobile top bar + the rail + the
// drawer scrim (the last two are off-canvas / hidden on desktop via CSS).
function appChrome(active) {
  // Mobile header center: the active space's own icon+name (same data spaceSwitcher()
  // reads, build.js:2900ish), replacing the hardcoded engine mark — correct on every
  // instance by construction. Falls back to GV_MARK+"augur" only when there's no
  // space to name (the engine-only/shell build case, spaceSwitcher() returns "" then
  // too). A back chevron replaces the brand whenever this page's rail would be
  // library/admin/an opportunity — i.e. whenever sideRail() itself isn't the active
  // view (the same branch computed below for `rail`).
  const spaces = NAV_STATE.spaces || [];
  const activeSpaceObj = spaces.find((s) => s.id === NAV_STATE.activeSpace) || spaces[0];
  const isLibOrAdmin = active === "admin" || LIB_KEYS.includes(active);
  // An opportunity page (active = the opportunity's own name) is a sub-view too —
  // same back-chevron treatment as library/admin, titled with the opportunity's own
  // name rather than left blank.
  const isOpportunity = !isLibOrAdmin && !!active && active !== "prototypes" && active !== "playground" && active !== "changelog";
  const isSubView = isLibOrAdmin || isOpportunity;
  const brandCenter = activeSpaceObj
    ? `<a class="gvtop__center-brand" href="${S("/")}"><img src="/space-icon.png" alt="" width="22" height="22" /><span>${escAttr(activeSpaceObj.name)}</span></a>`
    : `<a class="gvtop__center-brand" href="${S("/")}">${GV_MARK}<span>augur</span></a>`;
  const titleText = active === "admin" ? "Workspace settings"
    : LIB_KEYS.includes(active) ? "Design system"
    : active === "changelog" ? "Changelog"
    : isOpportunity ? titleCase(active) : "";
  const center = isSubView
    ? `<span class="gvtop__title">${titleText || ""}</span>`
    : brandCenter;
  const leftSlot = isSubView
    ? `<a class="gvtop__back" href="${S("/")}" aria-label="Back"><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></a>`
    : `<span class="gvtop__side" aria-hidden="true"></span>`;
  const top = `<header class="gvtop">
    ${leftSlot}
    <div class="gvtop__center">${center}</div>
    <div class="gvtop__searchwrap">${railSearch()}</div>
    <button type="button" class="gvtop__search-btn" data-mobile-search-toggle aria-label="Search">${SEARCH_ICON}</button>
  </header>`;
  // Workspace admin REPLACES the rail rather than adding a second nav column beside
  // it. You are in one workspace's settings, not browsing its content, so the rail's
  // Projects / Pinned / Design system are noise — and two nav columns side by side read as
  // two levels of hierarchy when there is only one.
  const rail = active === "admin" ? adminRail()
    : LIB_KEYS.includes(active) ? libraryRail(active)
    : sideRail(active);
  return `${top}${rail}<div class="gvscrim" data-side-scrim></div>${tabBar(active)}${mobilePinnedSheet()}${mobileProfileSheet()}${helpDrawer()}${settingsModal()}`;
}

// The rail while you are inside the design system. Same shape as workspace settings: profile
// chip, a way back, then this section's own destinations — one nav column, never two.
function libraryRail(active) {
  const item = (href, label, key, icon) =>
    `<a href="${S(href)}"${active === key ? ' aria-current="page"' : ""}>${icon}<span>${label}</span></a>`;
  return `<aside class="gvside" id="gvside" aria-label="Design system">
    ${profileChip()}
    <div class="gvside__rule"></div>
    <a class="gvadmin__back" href="${S("/")}">
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span>Design system</span>
    </a>
    <div class="gvside__scroll">
      <div class="gvside__group">
        ${item("/tokens/", "Tokens", "tokens", IC_TOKEN)}
        ${item("/base/", "Base", "base", IC_PRIM)}
        ${item("/components/", "Components", "components", IC_COMP)}
        ${item("/patterns/", "Patterns", "patterns", IC_PATTERN)}
        ${item("/pages/", "Pages", "pages", IC_PAGE)}
      </div>
    </div>
  </aside>`;
}

// The rail while you are inside workspace settings: the profile chip stays (it is
// yours, everywhere), then a back link naming the workspace, then the sections.
function adminRail() {
  const tab = (key, label) =>
    `<button type="button" class="gvside__act gvadmin__tab" data-admin-tab="${key}">${label}</button>`;
  return `<aside class="gvside" id="gvside" aria-label="Workspace settings">
    ${profileChip()}
    <div class="gvside__rule"></div>
    <a class="gvadmin__back" href="/" data-admin-back>
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span data-admin-space-name>Workspace</span>
    </a>
    <div class="gvside__scroll">
      <div class="gvside__group" data-admin-nav>
        ${tab("people", "People")}
        ${tab("content", "Content")}
        ${tab("settings", "Settings")}
      </div>
    </div>
  </aside>`;
}

/** Shared chrome script: real-time in-page filter + the mobile rail drawer. */
function chromeScript() {
  return `(function(){
  // ── In-page real-time filter ─────────────────────────────────────────────
  // Wrapped per-input: there can now be two [data-filter] boxes on the page (the
  // header's and the sidebar's, one hidden per viewport via CSS) — each gets its own
  // fully independent copy of the filter + fuzzy-finder below, closured over its own
  // input. clear/kbd are scoped to THIS input's own .gvsearch wrapper (each search
  // box has its own clear button and "/" hint); emptyMsg stays page-wide — the
  // "No matches" message is a single page-level element, not part of railSearch()'s
  // own markup.
  var __gvFilterInputs = [].slice.call(document.querySelectorAll('[data-filter]'));
  __gvFilterInputs.forEach(function(input){
  if (input && !input.dataset.wired) {
    input.dataset.wired = '1';
    var searchBox = input.closest('.gvsearch');
    var clear = searchBox && searchBox.querySelector('[data-filter-clear]');
    var kbd = searchBox && searchBox.querySelector('[data-filter-kbd]');
    var emptyMsg = document.querySelector('[data-filter-empty]');
    var items = [].slice.call(document.querySelectorAll('[data-fitem]'));
    var groups = [].slice.call(document.querySelectorAll('[data-fgroup]'));
    // Cache each card's searchable text once (explicit data-fkey wins over visible text).
    items.forEach(function(el){
      el._fk = (el.getAttribute('data-fkey') || el.textContent || '').toLowerCase().replace(/\\s+/g,' ').trim();
    });
    function apply(){
      var raw = input.value.trim().toLowerCase();
      var terms = raw ? raw.split(/\\s+/) : [];
      var shown = 0;
      items.forEach(function(el){
        var hit = true;
        for(var i=0;i<terms.length;i++){ if(el._fk.indexOf(terms[i]) < 0){ hit = false; break; } }
        el.classList.toggle('is-fhidden', !hit);
        if(hit) shown++;
      });
      // Hide a group's heading when none of its cards survive the filter.
      groups.forEach(function(g){
        var vis = g.querySelectorAll('[data-fitem]:not(.is-fhidden)').length;
        g.classList.toggle('is-fhidden', vis === 0);
        // Collapsible <details> groups: while searching, force-open matching
        // sections so their cards are reachable; restore the user's state on clear.
        if(g.tagName === 'DETAILS'){
          if(raw){
            if(g._wasOpen === undefined) g._wasOpen = g.open;
            g.open = vis > 0;
          } else if(g._wasOpen !== undefined){
            g.open = g._wasOpen;
            g._wasOpen = undefined;
          }
        }
      });
      if(emptyMsg) emptyMsg.hidden = shown !== 0;
      if(clear) clear.hidden = !raw;
      if(kbd) kbd.hidden = !!raw;
    }
    input.addEventListener('input', apply);
    input.addEventListener('keydown', function(e){ if(e.key === 'Escape' && input.value){ e.preventDefault(); e.stopPropagation(); input.value=''; apply(); } });
    if(clear) clear.addEventListener('click', function(){ input.value=''; apply(); input.focus(); });
    apply();

    // ── Global fuzzy finder ──────────────────────────────────────────────────
    // The same box also searches the WHOLE space, not just this page's cards:
    // __search.json (built per space) + created canvases (/__canvases) + KV
    // renames (/__name, by rename-key), fuzzy-matched, in a popover under the
    // field. The page-filter above keeps working behind it. Loaded lazily on the
    // first real query, once per page view.
    var box = input.closest('.gvsearch');
    var gidx=null, gloadP=null, gact=0, gres=[];
    function gfetch(url){ return fetch(url,{headers:{'Accept':'application/json'}}).then(function(r){ if(!r.ok) throw 0; return r.json(); }); }
    function gload(){
      if(gloadP) return gloadP;
      var src = box && box.getAttribute('data-search-src');
      var base = (box && box.getAttribute('data-search-base')) || '/';
      if(!src){ gloadP = Promise.resolve([]); return gloadP; }
      gloadP = Promise.all([
        gfetch(src).catch(function(){ return []; }),
        gfetch('/__canvases').then(function(d){
          return Object.keys((d&&d.map)||{}).filter(function(p){ return p.indexOf(base)===0; }).map(function(p){
            var seg = p.slice(base.length).split('/');
            return { t:(d.map[p].name||p), y:'Canvas', u:p, g: seg.length>2 ? seg[0] : '' };
          });
        }).catch(function(){ return []; }),
        (function(){ try{ var m=JSON.parse(sessionStorage.getItem('gv_names_map')||'null'); if(m) return Promise.resolve(m); }catch(e){}
          return gfetch('/__name').then(function(d){ return (d&&d.map)||{}; }).catch(function(){ return {}; }); })()
      ]).then(function(rs){
        var names = rs[2]||{};
        gidx = rs[0].concat(rs[1]).map(function(e){ return (e.k && names[e.k]) ? {t:names[e.k], y:e.y, u:e.u, g:e.g} : e; });
        return gidx;
      });
      return gloadP;
    }
    // Subsequence fuzzy score: exact substring ranks first (earlier = better), then
    // scattered matches favouring word starts + consecutive runs. null = no match.
    function fz(q, s){
      if(!q || !s) return null;
      var lq=q.toLowerCase(), ls=s.toLowerCase(), sub=ls.indexOf(lq), pos=[], i;
      if(sub>=0){ for(i=0;i<lq.length;i++) pos.push(sub+i);
        var wb = sub===0 || !/[a-z0-9]/.test(ls.charAt(sub-1));
        return { s: 200 - sub*2 + (wb?40:0) - Math.floor((ls.length-lq.length)/3), p: pos }; }
      var qi=0, run=0, sc=0;
      for(i=0;i<ls.length && qi<lq.length;i++){
        if(ls.charAt(i)===lq.charAt(qi)){
          var b=2; if(i===0 || !/[a-z0-9]/.test(ls.charAt(i-1))) b+=8; if(run>0) b+=5;
          run++; sc+=b; pos.push(i); qi++;
        } else run=0;
      }
      if(qi<lq.length) return null;
      return { s: sc - Math.floor(ls.length/4), p: pos };
    }
    function ghtml(s, pos){
      var out='', j=0, i;
      for(i=0;i<s.length;i++){
        var ch=s.charAt(i).replace(/&/g,'&amp;').replace(/</g,'&lt;');
        if(j<pos.length && pos[j]===i){ out+='<b>'+ch+'</b>'; j++; } else out+=ch;
      }
      return out;
    }
    // Results render as a CARD GRID over the content pane (right of the rail) —
    // poster thumbnails where the card grids have them, glyph tiles otherwise —
    // so searching feels like browsing a folder, not reading a menu.
    var GLYPH={Canvas:'\\uD83D\\uDDFA\\uFE0F',Playground:'\\uD83D\\uDEDD',Folder:'\\uD83D\\uDCC1',Prototype:'\\uD83E\\uDDEA',Page:'\\uD83D\\uDCC4',Component:'\\uD83E\\uDDE9',Index:'\\uD83D\\uDDC2\\uFE0F'};
    function ghide(){ if(pane) pane.hidden=true; gres=[]; }
    var pane=null;
    function gpane(){
      if(pane) return pane;
      pane=document.createElement('div'); pane.className='gvfind'; pane.hidden=true; document.body.appendChild(pane);
      pane.addEventListener('click', function(e){ var a=e.target.closest('[data-gu]'); if(a){ e.preventDefault(); location.href=a.getAttribute('data-gu'); } });
      return pane;
    }
    function grender(q){
      gpane();
      var side=document.querySelector('.gvside');
      var edge = side ? side.getBoundingClientRect().right : 0;
      pane.style.left = Math.max(0, edge) + 'px';
      gres=[];
      (gidx||[]).forEach(function(e){
        var m = fz(q, e.t);
        var mg = m ? null : (e.g ? fz(q, String(e.g)) : null);
        if(m) gres.push({ e:e, s:m.s+40, p:m.p });
        else if(mg) gres.push({ e:e, s:mg.s, p:[] });
      });
      gres.sort(function(a,b){ return b.s-a.s || a.e.t.localeCompare(b.e.t); });
      gres = gres.slice(0,24); gact=0;
      var head='<div class="gvfind__head">Results<span class="gvfind__count">'+gres.length+'</span><span class="gvfind__hint">\\u2191\\u2193 to pick \\u00b7 Enter to open \\u00b7 Esc to close</span></div>';
      if(!gres.length){ pane.innerHTML=head+'<div class="gvfind__empty">No matches in this space</div>'; pane.hidden=false; return; }
      // Preview priority: poster thumb → live scaled iframe (same fallback the folder
      // grids use) → glyph tile. Canvases stay glyphs: a hidden engine iframe would
      // join the board's multiplayer room as a ghost presence.
      var LIVE={Prototype:1,Playground:1,Page:1,Component:1,Folder:1};
      pane.innerHTML = head+'<div class="gvfind__grid">'+gres.map(function(r,i){
        var u=String(r.e.u).replace(/"/g,'&quot;');
        var prev;
        if(r.e.th) prev='<div class="gvfind-card__prev" style="background-image:url(&quot;'+String(r.e.th).replace(/"/g,'&quot;')+'&quot;)"></div>';
        else if(LIVE[r.e.y]) prev='<div class="gvfind-card__prev gvfind-card__prev--live"><iframe src="'+u+'" loading="lazy" title="" aria-hidden="true" tabindex="-1" scrolling="no" sandbox="allow-scripts allow-same-origin"></iframe></div>';
        else prev='<div class="gvfind-card__prev gvfind-card__prev--glyph">'+(GLYPH[r.e.y]||GLYPH.Prototype)+'</div>';
        return '<a class="gvfind-card'+(i===gact?' is-act':'')+'" href="'+u+'" data-gu="'+u+'">'+prev+
          '<div class="gvfind-card__meta"><span class="gvfind-card__t">'+ghtml(r.e.t, r.p)+'</span>'+
          '<span class="gvfind-card__sub">'+(r.e.g?ghtml(String(r.e.g),[])+'<span class="gvfind-card__dot">\\u00b7</span>':'')+
          '<span class="gvfind-chip">'+ghtml(String(r.e.y),[])+'</span></span></div></a>';
      }).join('')+'</div>';
      pane.hidden=false; pane.scrollTop=0;
      // Scale each live iframe to its card (1280-wide virtual viewport, house rule).
      [].forEach.call(pane.querySelectorAll('.gvfind-card__prev--live'), function(pv){
        var f=pv.querySelector('iframe');
        if(f) f.style.transform='scale('+(pv.clientWidth/1280)+')';
      });
    }
    function gmove(d){
      if(!pane || pane.hidden || !gres.length) return;
      gact=(gact+d+gres.length)%gres.length;
      var cards=pane.querySelectorAll('.gvfind-card');
      [].forEach.call(cards, function(r,i){ r.classList.toggle('is-act', i===gact); });
      if(cards[gact] && cards[gact].scrollIntoView) cards[gact].scrollIntoView({block:'nearest'});
    }
    input.addEventListener('input', function(){
      var q=input.value.trim();
      if(q.length<2){ ghide(); return; }
      gload().then(function(){ if(input.value.trim()===q) grender(q); });
    });
    input.addEventListener('keydown', function(e){
      if(e.key==='ArrowDown'){ e.preventDefault(); gmove(1); }
      else if(e.key==='ArrowUp'){ e.preventDefault(); gmove(-1); }
      else if(e.key==='Enter'){ if(pane && !pane.hidden && gres[gact]){ e.preventDefault(); location.href=gres[gact].e.u; } }
      else if(e.key==='Escape'){ ghide(); }
    });
    input.addEventListener('focus', function(){ var q=input.value.trim(); if(q.length>=2){ gload().then(function(){ grender(q); }); } });
    if(clear) clear.addEventListener('click', ghide);
  }
  });
  // Cmd+K / "/" — registered once, not once per input, so it doesn't fire twice per
  // keystroke now that there can be two [data-filter] boxes on the page. Picks
  // whichever one is actually reachable in the current viewport (the header's inside
  // .gvtop on mobile, the sidebar's inside .gvside on desktop).
  if(__gvFilterInputs.length){
    document.addEventListener('keydown', function(e){
      var k = (e.key || '').toLowerCase();
      var el = document.activeElement, tag = el && el.tagName;
      var typing = tag === 'INPUT' || tag === 'TEXTAREA' || (el && el.isContentEditable);
      var isShortcut = (e.metaKey || e.ctrlKey) && k === 'k';
      var isSlash = k === '/' && !typing;
      if(!isShortcut && !isSlash) return;
      var mobile = window.matchMedia('(max-width: 860px)').matches;
      var target = __gvFilterInputs.filter(function(i){ return !!i.closest('.gvtop') === mobile; })[0] || __gvFilterInputs[0];
      e.preventDefault();
      target.focus();
      if(isShortcut) target.select();
    });
  }

  // ── Help drawer (footer button → right-side panel, two tracks) ────────────
  var helpEl = document.querySelector('[data-help]');
  if(helpEl && !helpEl.dataset.wired){
    helpEl.dataset.wired = '1';
    var helpPanel = helpEl.querySelector('.gvhelp__panel');
    var helpLast = null, helpHideT = null;
    function helpTrack(t){
      [].forEach.call(helpEl.querySelectorAll('[data-help-tab]'), function(b){
        var on = b.getAttribute('data-help-tab') === t;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      [].forEach.call(helpEl.querySelectorAll('[data-help-track]'), function(s){
        s.hidden = s.getAttribute('data-help-track') !== t;
      });
      try { sessionStorage.setItem('gvHelpTrack', t); } catch(e){}
    }
    function helpKey(e){ if((e.key||'').toLowerCase() === 'escape'){ e.preventDefault(); e.stopPropagation(); helpClose(); } }
    function helpOpen(){
      if(helpHideT){ clearTimeout(helpHideT); helpHideT = null; }
      helpLast = document.activeElement;
      helpEl.hidden = false;
      requestAnimationFrame(function(){ helpEl.classList.add('is-open'); });
      var x = helpEl.querySelector('[data-help-close]'); if(x) x.focus();
      document.addEventListener('keydown', helpKey, true);
    }
    function helpClose(){
      helpEl.classList.remove('is-open');
      document.removeEventListener('keydown', helpKey, true);
      // Hide after the slide-out finishes; a timeout backstops reduced-motion (no transitionend).
      helpHideT = setTimeout(function(){ helpEl.hidden = true; helpHideT = null; }, 280);
      if(helpLast && helpLast.focus) helpLast.focus();
    }
    [].forEach.call(document.querySelectorAll('[data-help-open]'), function(o){
      o.addEventListener('click', function(e){ e.preventDefault(); helpOpen(); });
    });
    [].forEach.call(helpEl.querySelectorAll('[data-help-close], [data-help-scrim]'), function(c){
      c.addEventListener('click', helpClose);
    });
    [].forEach.call(helpEl.querySelectorAll('[data-help-tab]'), function(b){
      b.addEventListener('click', function(){ helpTrack(b.getAttribute('data-help-tab')); });
    });
    var savedTrack = 'review';
    try { savedTrack = sessionStorage.getItem('gvHelpTrack') || 'review'; } catch(e){}
    helpTrack(savedTrack);
  }
})();`;
}

// Mobile tab bar behaviour: the two sheets (Pinned, Profile), the header's search
// toggle, and dimming the Pinned tab when there's nothing pinned. Route tabs
// (Projects/Playground/DS/DS-sub/Admin-sub) are plain <a>/<button data-admin-tab>
// links needing no JS of their own — this only wires what isn't a navigation.
function TABBAR_JS() {
  return `(function(){
  function wireSheet(openBtnSel, sheetSel, scrimSel, closeSel){
    var sheet = document.querySelector(sheetSel);
    var openBtn = document.querySelector(openBtnSel);
    if(!sheet || !openBtn) return;
    var hideT = null;
    // Mirrors the help drawer / settings modal's own open()/close() (same 220ms fade
    // + hideT guard) — without clearing a pending close, tapping the tab again while
    // the previous close's timeout is still armed made the sheet flash in and vanish.
    function open(){
      if(openBtn.disabled) return;
      if(hideT){ clearTimeout(hideT); hideT = null; }
      sheet.hidden = false;
      requestAnimationFrame(function(){ sheet.classList.add('is-open'); });
    }
    function close(){
      sheet.classList.remove('is-open');
      hideT = setTimeout(function(){ sheet.hidden = true; hideT = null; }, 220);
    }
    openBtn.addEventListener('click', open);
    var scrim = sheet.querySelector(scrimSel);
    if(scrim) scrim.addEventListener('click', close);
    var x = sheet.querySelector(closeSel);
    if(x) x.addEventListener('click', close);
    document.addEventListener('keydown', function(e){ if(e.key === 'Escape' && !sheet.hidden) close(); });
  }
  wireSheet('[data-tab-pinned]', '[data-pin-sheet]', '[data-pin-sheet-scrim]', '[data-pin-sheet-close]');
  wireSheet('[data-tab-profile]', '[data-prof-sheet]', '[data-prof-sheet-scrim]', '[data-prof-sheet-close]');

  // Dim the Pinned tab when the (now possibly-multiple) empty-state hint is showing.
  // PINS_JS toggles [data-pinned-empty].hidden once its /__pins fetch resolves; watch
  // the first instance (they're always in sync — see PINS_JS's renderList()) rather
  // than duplicating the pins-map logic here.
  var emptyHint = document.querySelector('[data-pinned-empty]');
  var pinnedTab = document.querySelector('[data-tab-pinned]');
  if(emptyHint && pinnedTab){
    var mo = new MutationObserver(function(){
      var empty = emptyHint.hidden === false;
      pinnedTab.classList.toggle('is-disabled', empty);
      pinnedTab.disabled = empty;
    });
    mo.observe(emptyHint, {attributes:true, attributeFilter:['hidden']});
    // Initial state — MutationObserver only fires on future changes.
    pinnedTab.classList.toggle('is-disabled', emptyHint.hidden === false);
    pinnedTab.disabled = emptyHint.hidden === false;
  }

  // Header search toggle: swap the center brand/title for the omni search input.
  var searchBtn = document.querySelector('[data-mobile-search-toggle]');
  if(searchBtn){
    searchBtn.addEventListener('click', function(){
      var on = document.body.classList.toggle('gv-mobile-searching');
      if(on){ var input = document.querySelector('.gvtop__searchwrap [data-filter]'); if(input) input.focus(); }
    });
  }
})();
`;
}

/** Inject the nav (with its own styles) right after the opening <body> tag. */
function injectNav(html, active) {
  const m = html.match(/<body[^>]*>/i);
  if (!m) return html;
  return html.replace(
    m[0],
    `${m[0]}\n  <style>${NAV_CSS}${TABBAR_CSS}</style>\n  ${appChrome(active)}\n  <script>${chromeScript()}</script>\n  <script>${spaceContextScript()}</script>\n  <script>${PINS_JS}</script>\n  <script>${PROFILE_JS}</script>\n  <script>${SETTINGS_JS}</script>\n  <script>${SPACE_JS}</script>\n  <script>${TABBAR_JS()}</script>`
  );
}

// "Shell skin" for the Primitives gallery so it matches the light shell: the page
// canvas takes the shell's near-white bg + faint indigo wash, and the gallery's white
// .gv-card sections get a crisp hairline + soft shadow. The gallery owns its own
// (side-nav) layout; the skin only harmonises colours. The global left rail (NAV_CSS,
// injected separately) handles the body offset via padding-left, so the skin no longer
// reserves a top-bar height. Injected last so it wins over the gallery's own body rule.
const PRIMITIVES_SKIN = `${FONT_CSS}
    body.gv-root {
      background: #fbfbfd !important;
    }
    body.gv-root::before {
      content: ""; position: fixed; inset: 0; z-index: 0; pointer-events: none;
      background:
        radial-gradient(940px 440px at 14% -12%, rgba(94,106,210,0.10), transparent 60%),
        radial-gradient(700px 420px at 98% -6%, rgba(140,99,210,0.07), transparent 55%);
    }
    body.gv-root > .gv-gallery { position: relative; z-index: 1; }
    body.gv-root .gv-sidenav { top: 26px; }
    /* The inner section-nav is chrome, not a themed primitive — keep its active/hover
       state the rail's neutral grey and its type the rail's Inter, never the city's
       tenant colour or font. */
    body.gv-root .gv-sidenav { font-family: "Inter", "Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    body.gv-root .gv-sidenav a:hover { background: rgba(16,17,26,0.05); color: #0e0f12; }
    body.gv-root .gv-sidenav a.is-active {
      background: rgba(16,17,26,0.07); color: #0e0f12; font-weight: 600;
    }
    body.gv-root .gv-card {
      border: 1px solid rgba(16,17,26,0.07);
      box-shadow: 0 12px 30px -18px rgba(16,24,40,0.22);
    }
    /* Folderbar title, matching Opportunities/Components/Pages (PAGE_CSS isn't loaded
       in the gallery, so the shell's --vars are inlined as literals here). */
    body.gv-root .folderbar { display: flex; align-items: center; gap: 10px; margin: 0 0 14px; font-family: "Inter", "Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    body.gv-root .folderbar__title { font-family: var(--font-display); font-size: 16px; font-weight: 600; letter-spacing: 0; margin: 0; color: #16171a; white-space: nowrap; }
    body.gv-root .folderbar__count { flex: none; font-size: 12px; font-weight: 560; color: #6b7280; background: #f3f4f7; border: 1px solid rgba(16,17,26,0.09); border-radius: 999px; padding: 1px 8px; }
    body.gv-root .folderbar__rule { flex: 1; height: 0; border-top: 1px dashed rgba(16,17,26,0.15); margin-left: 2px; }`;

/** Inject the nav + the Primitives skin (light, matches the shell) into the gallery. */
function injectPrimitives(html) {
  const withNav = injectNav(html, "primitives");
  const skinned = withNav.replace(/<\/head>/i, `  <style>${PRIMITIVES_SKIN}</style>\n</head>`);
  // Swap the gallery's hero <h1> for the shell's folderbar title so Primitives reads
  // consistently with Opportunities / Components / Pages. Count = section-nav links.
  const sectionCount = (html.match(/<a href="#[^"]+"/g) || []).length;
  return skinned.replace(
    /<h1 class="gv-title h2">[^<]*<\/h1>/i,
    `<header class="folderbar"><h1 class="folderbar__title">Primitives</h1><span class="folderbar__count">${sectionCount}</span><span class="folderbar__rule"></span></header>`
  );
}

// Right-click menu for prototype cards (editor-style). Acts on any card carrying
// data-rename-key. Items: Open · Copy link · Download HTML (when a [data-dl] button
// exists) · Rename (inline, persisted to the /__name KV map) · Delete (confirm →
// removes the card from view; the real file removal is a repo edit — see CLAUDE.md).
// KV-frugal like STATUS_JS: the name map is read once per session (sessionStorage),
// written only on an actual rename.
const CARD_MENU_JS = `
(function(){
  var cards = Array.prototype.slice.call(document.querySelectorAll('[data-rename-key]'));
  if(!cards.length) return;
  var NCACHE='gv_names_map';
  function linkOf(c){ return c.querySelector('a.preview-link, a.card-cover-link, a[href]'); }
  function nameEl(c){ return c.querySelector('.proto-name'); }
  function descEl(c){ return c.querySelector('[data-desc-key]'); }
  function dlBtn(c){ return c.querySelector('[data-dl]'); }

  // ---- persisted display-name + description overrides ----
  // Both share the /__name KV map; description keys end "#desc". Components are
  // CODE-canonical — these overrides are folded back into build.js so the live label
  // and the source name stay one language.
  function applyNames(map){
    if(!map) return;
    cards.forEach(function(c){
      var k=c.getAttribute('data-rename-key'), el=nameEl(c);
      if(el && k && Object.prototype.hasOwnProperty.call(map,k) && map[k]){ el.textContent=map[k]; c.setAttribute('data-fkey',map[k]); }
      var de=descEl(c); if(de){ var dk=de.getAttribute('data-desc-key');
        if(dk && Object.prototype.hasOwnProperty.call(map,dk) && map[dk]) de.textContent=map[dk]; }
    });
  }
  // Snapshot the build-time default description (already entity-decoded as textContent)
  // BEFORE any KV override overwrites it, so "revert to default" restores clean text.
  cards.forEach(function(c){ var de=descEl(c); if(de && de._defDesc==null) de._defDesc=de.textContent; });
  var cached=null; try{ cached=JSON.parse(sessionStorage.getItem(NCACHE)||'null'); }catch(e){}
  if(cached) applyNames(cached);
  else fetch('/__name',{headers:{'Accept':'application/json'}}).then(function(r){return r.json();})
    .then(function(d){ var m=(d&&d.map)||{}; try{sessionStorage.setItem(NCACHE,JSON.stringify(m));}catch(e){} applyNames(m); }).catch(function(){});
  function persistName(key,name){
    fetch('/__name',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:key,name:name})})
      .then(function(r){return r.json();}).then(function(d){ if(d&&d.map){ try{sessionStorage.setItem(NCACHE,JSON.stringify(d.map));}catch(e){} } }).catch(function(){});
  }
  // Created-canvas cards store their name in the /__canvases registry (their only
  // name store), not the /__name override map; empty (= revert) is a no-op there.
  function persistFor(c,key,name){
    var cp=c.getAttribute('data-canvas-path');
    if(cp){
      if(!name) return;
      var clean=name.replace(/^\\uD83D\\uDDFA\\uFE0F\\s*/,'');
      fetch('/__canvases',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:cp,rename:true,name:clean})}).catch(function(){});
      return;
    }
    persistName(key,name);
  }

  // ---- toast ----
  var toast;
  function showToast(msg){ if(!toast){toast=document.createElement('div');toast.className='gv-toast';document.body.appendChild(toast);} toast.textContent=msg; toast.classList.add('show'); clearTimeout(toast._t); toast._t=setTimeout(function(){toast.classList.remove('show');},1900); }

  // ---- actions ----
  function openCard(c){ var a=linkOf(c); if(a) window.location.href=a.getAttribute('href'); }
  function fallbackCopy(url){ var t=document.createElement('textarea'); t.value=url; t.style.position='fixed'; t.style.opacity='0'; document.body.appendChild(t); t.focus(); t.select(); try{document.execCommand('copy'); showToast('Link copied');}catch(e){showToast('Copy failed');} t.remove(); }
  function copyLink(c){ var a=linkOf(c); if(!a) return; var url=new URL(a.getAttribute('href'),location.href).href;
    if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(function(){showToast('Link copied');},function(){fallbackCopy(url);});
    else fallbackCopy(url); }
  function downloadCard(c){ var b=dlBtn(c); if(b) b.click(); }

  // ---- Delete forever (REAL deletion — repo write via /__delete) ----
  // Admin-only (html.gv-admin, set by PROFILE_JS; gv-operator on no-identity
  // builds). The worker forwards to the instance's delete webhook; the deploy that
  // follows removes the prototype from the live site (~2 min). The card fades out
  // optimistically so the folder reflects the decision immediately.
  function canDelete(c){
    var h=document.documentElement;
    return c.hasAttribute('data-del-path') && (h.classList.contains('gv-admin') || h.classList.contains('gv-operator'));
  }
  // Created-canvas cards: removal = un-register from /__canvases. Recoverable by
  // design (the board doc stays in KV), so the modal says so — unlike repo deletion.
  function removeCanvas(c){
    var p=c.getAttribute('data-canvas-path');
    var nm=((nameEl(c)&&nameEl(c).textContent)||'this canvas').trim();
    var veil=document.createElement('div'); veil.className='gv-modal-veil';
    veil.innerHTML='<div class="gv-modal" role="alertdialog" aria-modal="true" aria-labelledby="gv-cvrm-title">'+
      '<h2 class="gv-modal__title" id="gv-cvrm-title"></h2>'+
      '<p class="gv-modal__body">Removes the canvas from this folder. Its board content stays saved \\u2014 creating a canvas with the same name here brings it back.</p>'+
      '<div class="gv-modal__row"><button type="button" class="gv-modal__btn" data-m="cancel">Cancel</button>'+
      '<button type="button" class="gv-modal__btn gv-modal__btn--danger" data-m="del">Remove</button></div></div>';
    veil.querySelector('.gv-modal__title').textContent='Remove \\u201c'+nm+'\\u201d?';
    document.body.appendChild(veil);
    var cancel=veil.querySelector('[data-m="cancel"]'), del=veil.querySelector('[data-m="del"]');
    function close(){ veil.remove(); document.removeEventListener('keydown',onKey,true); }
    function onKey(e){ if(e.key==='Escape'){ e.preventDefault(); close(); } }
    document.addEventListener('keydown',onKey,true);
    veil.addEventListener('pointerdown',function(e){ if(e.target===veil) close(); });
    cancel.addEventListener('click',close);
    cancel.focus();
    del.addEventListener('click',function(){
      del.disabled=true; cancel.disabled=true;
      fetch('/__canvases',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:p,remove:true})})
        .then(function(){ close(); c.style.transition='opacity .2s ease'; c.style.opacity='0'; setTimeout(function(){ c.remove(); },210); showToast('Canvas removed'); })
        .catch(function(){ close(); showToast('Remove failed'); });
    });
  }
  function deleteCard(c){
    if(c.hasAttribute('data-canvas-path')) return removeCanvas(c);
    var nm=((nameEl(c)&&nameEl(c).textContent)||'this prototype').trim();
    var veil=document.createElement('div'); veil.className='gv-modal-veil';
    veil.innerHTML='<div class="gv-modal" role="alertdialog" aria-modal="true" aria-labelledby="gv-del-title">'+
      '<h2 class="gv-modal__title" id="gv-del-title"></h2>'+
      '<p class="gv-modal__body">This permanently deletes the prototype\\u2019s code from the repository and removes it from the live site for everyone. It cannot be recovered.</p>'+
      '<div class="gv-modal__row"><button type="button" class="gv-modal__btn" data-m="cancel">Cancel</button>'+
      '<button type="button" class="gv-modal__btn gv-modal__btn--danger" data-m="del">Delete forever</button></div></div>';
    veil.querySelector('.gv-modal__title').textContent='Delete \\u201c'+nm+'\\u201d forever?';
    document.body.appendChild(veil);
    var cancel=veil.querySelector('[data-m="cancel"]'), del=veil.querySelector('[data-m="del"]');
    function close(){ veil.remove(); document.removeEventListener('keydown',onKey,true); }
    function onKey(e){ if(e.key==='Escape'){ e.preventDefault(); close(); } }
    document.addEventListener('keydown',onKey,true);
    veil.addEventListener('pointerdown',function(e){ if(e.target===veil) close(); });
    cancel.addEventListener('click',close);
    cancel.focus();
    del.addEventListener('click',function(){
      del.disabled=true; cancel.disabled=true; del.textContent='Deleting\\u2026';
      fetch('/__delete',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({space:c.getAttribute('data-del-space'),path:c.getAttribute('data-del-path')})})
        .then(function(r){ return r.json().then(function(d){ return {status:r.status, d:d}; }); })
        .then(function(res){
          close();
          if(res.status===202){
            c.style.transition='opacity .2s ease'; c.style.opacity='0';
            setTimeout(function(){ c.remove(); },210);
            showToast('Deleting \\u201c'+nm+'\\u201d \\u2014 gone from the live site in ~2 minutes');
          }
          else if(res.status===501) showToast('Deletion is not configured on this instance');
          else if(res.status===403) showToast('Only admins can delete prototypes');
          else showToast('Delete failed \\u2014 nothing was removed');
        })
        .catch(function(){ close(); showToast('Delete failed \\u2014 nothing was removed'); });
    });
  }

  // ---- inline rename (highlight the label, type over it) ----
  function startRename(c){
    var el=nameEl(c); if(!el||el.isContentEditable) return;
    var key=c.getAttribute('data-rename-key'), def=c.getAttribute('data-default-name')||el.textContent, prev=el.textContent, done=false;
    el.setAttribute('contenteditable','true'); el.spellcheck=false; el.focus();
    var rg=document.createRange(); rg.selectNodeContents(el); var sl=getSelection(); sl.removeAllRanges(); sl.addRange(rg);
    function onKey(e){ if(e.key==='Enter'){e.preventDefault();finish(true);} else if(e.key==='Escape'){e.preventDefault();finish(false);} }
    function onBlur(){ finish(true); }
    function finish(commit){
      if(done) return; done=true;
      el.removeEventListener('keydown',onKey); el.removeEventListener('blur',onBlur); el.removeAttribute('contenteditable');
      var val=(el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,80);
      if(!commit){ el.textContent=prev; }
      else if(!val||val===def){ el.textContent=def; c.setAttribute('data-fkey',def); if(prev!==def) persistFor(c,key,''); }
      else { el.textContent=val; c.setAttribute('data-fkey',val); persistFor(c,key,val); }
      var s=getSelection(); if(s) s.removeAllRanges();
    }
    el.addEventListener('keydown',onKey); el.addEventListener('blur',onBlur);
  }

  // ---- inline description edit (the "what is it" cell) ----
  function startEditDesc(c){
    var el=descEl(c); if(!el||el.isContentEditable) return;
    var key=el.getAttribute('data-desc-key'), def=(el._defDesc!=null?el._defDesc:el.textContent), prev=el.textContent, done=false;
    el.setAttribute('contenteditable','true'); el.spellcheck=false; el.focus();
    var rg=document.createRange(); rg.selectNodeContents(el); var sl=getSelection(); sl.removeAllRanges(); sl.addRange(rg);
    function onKey(e){ if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();finish(true);} else if(e.key==='Escape'){e.preventDefault();finish(false);} }
    function onBlur(){ finish(true); }
    function finish(commit){
      if(done) return; done=true;
      el.removeEventListener('keydown',onKey); el.removeEventListener('blur',onBlur); el.removeAttribute('contenteditable');
      var val=(el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,280);
      if(!commit){ el.textContent=prev; }
      else if(!val||val===def){ el.textContent=def; if(prev!==def) persistName(key,''); }
      else { el.textContent=val; persistName(key,val); }
      var s=getSelection(); if(s) s.removeAllRanges();
    }
    el.addEventListener('keydown',onKey); el.addEventListener('blur',onBlur);
  }

  // ---- menu ----
  var ICON={
    open:'<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>',
    copy:'<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    dl:'<path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M5 21h14"/>',
    rename:'<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    desc:'<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h10"/>',
    del:'<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'
  };
  function item(act,label,icon,danger){ return '<button type="button" role="menuitem" data-act="'+act+'"'+(danger?' class="gv-ctx-danger"':'')+'><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">'+icon+'</svg>'+label+'</button>'; }
  var menu=null;
  function closeMenu(){ if(menu){ menu.remove(); menu=null; document.removeEventListener('keydown',onMenuKey,true); } }
  function onMenuKey(e){
    if(!menu) return;
    if(e.key==='Escape'){ e.preventDefault(); closeMenu(); return; }
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){ e.preventDefault();
      var btns=Array.prototype.slice.call(menu.querySelectorAll('button')); var i=btns.indexOf(document.activeElement);
      i=(i+(e.key==='ArrowDown'?1:-1)+btns.length)%btns.length; btns[i].focus(); }
  }
  function openMenu(x,y,c){
    closeMenu();
    menu=document.createElement('div'); menu.className='gv-ctx'; menu.setAttribute('role','menu');
    var html=item('open','Open',ICON.open);
    html+='<hr>'+item('copy','Copy link',ICON.copy);
    if(dlBtn(c)) html+=item('download','Download HTML',ICON.dl);
    html+='<hr>'+item('rename','Rename',ICON.rename);
    if(descEl(c)) html+=item('editdesc','Edit description',ICON.desc);
    // Delete = REAL repo deletion, admins only (see deleteCard). Non-admins never
    // see the item; the worker re-checks the role server-side regardless.
    // Created-canvas cards get the softer registry removal instead (recoverable).
    if(canDelete(c)) html+='<hr>'+item('delete','Delete forever\\u2026',ICON.del,true);
    else if(c.hasAttribute('data-canvas-path')) html+='<hr>'+item('delete','Remove canvas\\u2026',ICON.del,true);
    menu.innerHTML=html; document.body.appendChild(menu);
    var r=menu.getBoundingClientRect();
    menu.style.left=Math.max(8,Math.min(x, innerWidth-r.width-8))+'px';
    menu.style.top=Math.max(8,Math.min(y, innerHeight-r.height-8))+'px';
    menu.addEventListener('click',function(e){
      var b=e.target.closest('button'); if(!b) return; var act=b.getAttribute('data-act'); closeMenu();
      if(act==='open') openCard(c); else if(act==='copy') copyLink(c); else if(act==='download') downloadCard(c);
      else if(act==='rename') startRename(c); else if(act==='editdesc') startEditDesc(c); else if(act==='delete') deleteCard(c);
    });
    var f=menu.querySelector('button'); if(f) f.focus();
    document.addEventListener('keydown',onMenuKey,true);
  }
  document.addEventListener('contextmenu',function(e){
    var c=e.target.closest&&e.target.closest('[data-rename-key]'); if(!c) return;
    if(e.target.isContentEditable) return;
    e.preventDefault(); openMenu(e.clientX,e.clientY,c);
  });
  document.addEventListener('pointerdown',function(e){ if(menu&&!menu.contains(e.target)) closeMenu(); },true);
  window.addEventListener('blur',closeMenu);
  document.addEventListener('scroll',function(){ closeMenu(); },true);
})();
`;

// Client for the clickable dev-status chips. KV-frugal: reads the whole map from
// one endpoint AT MOST ONCE PER SESSION (cached in sessionStorage), writes only on
// an actual click. Pages without chips never fetch (the early return). Default
// state is "ignore"; clicking cycles ignore → in-progress → dev-ready → ignore.
const STATUS_JS = `
(function(){
  var chips = []; // filled by __gvStatusWire at boot + when cards arrive late
  var ORDER = ['ignore','in-progress','dev-ready'];
  var META = {
    'ignore':      {label:'Ignore',      cls:'is-ignore'},
    'in-progress': {label:'In progress', cls:'is-wip'},
    'dev-ready':   {label:'Dev ready',   cls:'is-ready'}
  };
  var ICONS = ${JSON.stringify(STATUS_ICONS)};
  var CACHE = 'gv_status_map';
  function paint(chip, status){
    if(!META[status]) status = 'ignore';
    var m = META[status];
    chip.className = 'status-chip ' + m.cls;
    chip.innerHTML = ICONS[status] || ICONS.ignore;
    chip.setAttribute('data-status', status);
    chip.setAttribute('aria-label', 'Status: ' + m.label + '. Change status.');
    // No title= on purpose: the picker opens on hover, and a native tooltip would
    // cover it.
  }
  function applyMap(map, list){
    (list || chips).forEach(function(chip){
      var k = chip.getAttribute('data-status-key');
      if(map && Object.prototype.hasOwnProperty.call(map, k)) paint(chip, map[k] || 'ignore');
    });
  }
  // Re-order cards to match the LIVE statuses (KV), since the build-time order only
  // knows the JSON baseline. Dev ready → In progress → Ignore; the build-time order
  // (recency) is preserved within each bucket because the sort is stable. Grouped by
  // grid container so multiple grids on a page sort independently.
  var RANK = { 'dev-ready':0, 'in-progress':1, 'ignore':2 };
  function resort(){
    var grids = [];
    chips.forEach(function(chip){
      var card = chip.closest('.card-proto, .card-opp'); if(!card) return;
      var grid = card.parentElement; if(!grid) return;
      var g = null; for(var i=0;i<grids.length;i++){ if(grids[i].grid===grid){ g=grids[i]; break; } }
      if(!g){ g = {grid:grid, cards:[]}; grids.push(g); }
      g.cards.push(card);
    });
    grids.forEach(function(g){
      g.cards
        .map(function(card, i){
          var chip = card.querySelector('[data-status-key]');
          var s = chip && chip.getAttribute('data-status');
          var r = Object.prototype.hasOwnProperty.call(RANK, s) ? RANK[s] : RANK.ignore;
          return { card: card, r: r, i: i };
        })
        .sort(function(a, b){ return a.r - b.r || a.i - b.i; })
        .forEach(function(o){ g.grid.appendChild(o.card); });
    });
  }
  // The map loads at most once per session (sessionStorage cache, else one fetch) and
  // only when a page actually has chips — late-wired chips reuse the same promise.
  var mapP = null;
  function loadMap(){
    if(mapP) return mapP;
    var cached = null;
    try { cached = JSON.parse(sessionStorage.getItem(CACHE) || 'null'); } catch(e){}
    mapP = cached ? Promise.resolve(cached)
      : fetch('/__status', {headers:{'Accept':'application/json'}})
          .then(function(r){ return r.json(); })
          .then(function(d){
            var map = (d && d.map) || {};
            try { sessionStorage.setItem(CACHE, JSON.stringify(map)); } catch(e){}
            return map;
          }).catch(function(){ return {}; });
    return mapP;
  }
  // A status change re-ranks the card, which yanks it out from under the pointer
  // mid-edit. So resorting WAITS: while the picker is open, or while the pointer is
  // still inside the grid you're editing, the new order is held back and applied the
  // moment you move away. Set three cards in a row, see one reflow.
  var needResort = false, mx = -1, my = -1;
  function laterResort(){ needResort = true; maybeResort(); }
  // Pointer GEOMETRY, not :hover — the open picker is a body-level overlay, so the
  // grid under it stops counting as hovered exactly when the pointer is most likely
  // to be sitting over a card the user just edited.
  function inGrid(){
    if(mx < 0) return false;
    for(var i=0;i<chips.length;i++){
      var card = chips[i].closest('.card-proto, .card-opp');
      var grid = card && card.parentElement;
      if(!grid) continue;
      var r = grid.getBoundingClientRect();
      if(mx >= r.left && mx <= r.right && my >= r.top && my <= r.bottom) return true;
    }
    return false;
  }
  function maybeResort(){
    if(!needResort || openChip || inGrid()) return;
    needResort = false; resort();
  }
  document.addEventListener('mousemove', function(e){ mx = e.clientX; my = e.clientY; maybeResort(); });
  window.addEventListener('blur', maybeResort);

  function save(chip, next){
    var prev = chip.getAttribute('data-status') || 'ignore';
    if(next === prev) return;
    paint(chip, next);
    laterResort();
    fetch('/__status', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ key: chip.getAttribute('data-status-key'), status: next })
    }).then(function(r){ return r.json(); }).then(function(d){
      if(d && d.map){
        try { sessionStorage.setItem(CACHE, JSON.stringify(d.map)); } catch(e){}
        mapP = Promise.resolve(d.map); // chips wired after this write paint fresh
        var k = chip.getAttribute('data-status-key');
        paint(chip, d.map[k] || 'ignore');
        laterResort();
      }
    }).catch(function(){ paint(chip, prev); laterResort(); });
  }

  // Hover/click picker: pick the state you want directly instead of cycling through
  // the others (every intermediate state used to be saved AND re-sorted). Ordered
  // like the sort itself — Dev ready first.
  var PICK = ['dev-ready','in-progress','ignore'];
  var menu = null, openChip = null, hideT = 0, showT = 0;
  function closeMenu(){
    if(!menu) return;
    menu.remove(); menu = null;
    if(openChip){ openChip.setAttribute('aria-expanded','false'); openChip = null; }
    maybeResort();
  }
  function openMenu(chip){
    if(openChip === chip) return;
    closeMenu();
    openChip = chip;
    chip.setAttribute('aria-expanded','true');
    menu = document.createElement('div');
    menu.className = 'gv-status-menu';
    menu.setAttribute('role','menu');
    var cur = chip.getAttribute('data-status') || 'ignore';
    menu.innerHTML = PICK.map(function(s){
      return '<button type="button" role="menuitemradio" data-pick="' + s + '" aria-checked="' + (s === cur) + '">'
        + ICONS[s] + '<span>' + META[s].label + '</span></button>';
    }).join('');
    document.body.appendChild(menu);
    // Anchored under the chip, flipped above when there is no room below, and
    // clamped to the viewport (chips sit at a card's bottom-left corner).
    var c = chip.getBoundingClientRect(), m = menu.getBoundingClientRect();
    var top = c.bottom + 6;
    if(top + m.height > innerHeight - 8) top = Math.max(8, c.top - m.height - 6);
    menu.style.top = top + 'px';
    menu.style.left = Math.max(8, Math.min(c.left - 4, innerWidth - m.width - 8)) + 'px';
    menu.addEventListener('mouseenter', function(){ clearTimeout(hideT); });
    menu.addEventListener('mouseleave', function(){ hideT = setTimeout(closeMenu, 180); });
    menu.addEventListener('click', function(e){
      var b = e.target.closest('button'); if(!b) return;
      e.preventDefault(); e.stopPropagation();
      var c2 = openChip; closeMenu(); save(c2, b.getAttribute('data-pick'));
    });
  }
  function wireChip(chip){
    chip.setAttribute('aria-haspopup','true');
    chip.setAttribute('aria-expanded','false');
    chip.addEventListener('mouseenter', function(){
      clearTimeout(hideT); clearTimeout(showT);
      showT = setTimeout(function(){ openMenu(chip); }, 90);
    });
    chip.addEventListener('mouseleave', function(){
      clearTimeout(showT);
      hideT = setTimeout(closeMenu, 180);
    });
    // Click and keyboard both just open the picker — no blind cycling.
    chip.addEventListener('click', function(e){
      e.preventDefault(); e.stopPropagation();
      if(openChip === chip) closeMenu(); else openMenu(chip);
    });
  }
  // Chips can arrive after boot (created-canvas cards are injected once /__canvases
  // answers) — wiring is a window hook NEWCANVAS_JS re-runs, same idiom as __gvPinsWire.
  window.__gvStatusWire = function(){
    var found = Array.prototype.slice.call(document.querySelectorAll('[data-status-key]'));
    var fresh = found.filter(function(c){ return chips.indexOf(c) < 0; });
    if(!fresh.length) return;
    fresh.forEach(function(c){ chips.push(c); wireChip(c); });
    loadMap().then(function(map){ applyMap(map, fresh); resort(); });
  };
  window.__gvStatusWire();
  document.addEventListener('keydown', function(e){
    if(!menu) return;
    if(e.key === 'Escape'){ var c = openChip; closeMenu(); if(c) c.focus(); return; }
    if(e.key === 'ArrowDown' || e.key === 'ArrowUp'){
      e.preventDefault();
      var btns = Array.prototype.slice.call(menu.querySelectorAll('button'));
      var i = btns.indexOf(document.activeElement);
      i = (i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length;
      btns[i].focus();
    }
  }, true);
  document.addEventListener('mousedown', function(e){
    if(menu && !e.target.closest('.gv-status-menu, [data-status-key]')) closeMenu();
  }, true);
  addEventListener('scroll', function(){ if(menu) closeMenu(); }, true);
})();
`;

// Clickable two-state validation chip for a component row (utmost-right cell). Unlike
// prototypes there is NO "ignore" — a component is either "in-progress" (default) or
// "reviewed" (validated). Keyed "components/<name>" so it shares the /__status KV map
// but never collides with prototype keys. Uses its OWN attribute (data-comp-status-key)
// so the 3-state prototype STATUS_JS skips these chips entirely.
function compStatusChip(name) {
  const key = `components/${name}`;
  const aria = "Validation: In progress. Click to mark reviewed.";
  return `<button type="button" class="status-chip is-wip" data-comp-status-key="${key}" data-status="in-progress" aria-label="${aria}" title="${aria}">${STATUS_ICONS["in-progress"]}</button>`;
}

// Component validation client. Two states only (in-progress ⇄ reviewed), reviewed
// sorts first. Shares the /__status endpoint + the gv_status_map session cache with
// STATUS_JS (component keys are namespaced, so no clash), and resorts <tr> rows inside
// their <tbody> rather than cards in a grid.
const COMP_STATUS_JS = `
(function(){
  var chips = Array.prototype.slice.call(document.querySelectorAll('[data-comp-status-key]'));
  if(!chips.length) return;
  var ORDER = ['in-progress','reviewed'];
  var META = {
    'in-progress': {label:'In progress', cls:'is-wip',  aria:'Validation: In progress. Click to mark reviewed.'},
    'reviewed':    {label:'Reviewed',    cls:'is-ready', aria:'Validation: Reviewed. Click to reset to in progress.'}
  };
  var ICONS = ${JSON.stringify({ "in-progress": STATUS_ICONS["in-progress"], reviewed: STATUS_ICONS["reviewed"] })};
  var RANK = { 'reviewed':0, 'in-progress':1 };
  var CACHE = 'gv_status_map';
  function paint(chip, status){
    if(!META[status]) status = 'in-progress';
    var m = META[status];
    chip.className = 'status-chip ' + m.cls;
    chip.innerHTML = ICONS[status] || ICONS['in-progress'];
    chip.setAttribute('data-status', status);
    chip.setAttribute('aria-label', m.aria);
    chip.setAttribute('title', m.aria);
  }
  function applyMap(map){
    chips.forEach(function(chip){
      var k = chip.getAttribute('data-comp-status-key');
      if(map && Object.prototype.hasOwnProperty.call(map, k)) paint(chip, map[k] || 'in-progress');
    });
  }
  function resort(){
    var bodies = [];
    chips.forEach(function(chip){
      var row = chip.closest('tr'); if(!row) return;
      var body = row.parentElement; if(!body) return;
      var b = null; for(var i=0;i<bodies.length;i++){ if(bodies[i].body===body){ b=bodies[i]; break; } }
      if(!b){ b = {body:body, rows:[]}; bodies.push(b); }
      b.rows.push(row);
    });
    bodies.forEach(function(b){
      b.rows
        .map(function(row, i){
          var chip = row.querySelector('[data-comp-status-key]');
          var s = chip && chip.getAttribute('data-status');
          var r = Object.prototype.hasOwnProperty.call(RANK, s) ? RANK[s] : RANK['in-progress'];
          return { row: row, r: r, i: i };
        })
        .sort(function(a, b){ return a.r - b.r || a.i - b.i; })
        .forEach(function(o){ b.body.appendChild(o.row); });
    });
  }
  var cached = null;
  try { cached = JSON.parse(sessionStorage.getItem(CACHE) || 'null'); } catch(e){}
  if(cached){ applyMap(cached); resort(); }
  else {
    fetch('/__status', {headers:{'Accept':'application/json'}})
      .then(function(r){ return r.json(); })
      .then(function(d){
        var map = (d && d.map) || {};
        try { sessionStorage.setItem(CACHE, JSON.stringify(map)); } catch(e){}
        applyMap(map); resort();
      }).catch(function(){});
  }
  chips.forEach(function(chip){
    chip.addEventListener('click', function(){
      var cur = chip.getAttribute('data-status') || 'in-progress';
      var next = ORDER[(ORDER.indexOf(cur) + 1 + ORDER.length) % ORDER.length];
      paint(chip, next);
      resort();
      chip.disabled = true;
      fetch('/__status', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ key: chip.getAttribute('data-comp-status-key'), status: next })
      }).then(function(r){ return r.json(); }).then(function(d){
        if(d && d.map){
          try { sessionStorage.setItem(CACHE, JSON.stringify(d.map)); } catch(e){}
          var k = chip.getAttribute('data-comp-status-key');
          paint(chip, d.map[k] || 'in-progress');
          resort();
        }
      }).catch(function(){ paint(chip, cur); resort(); }).then(function(){ chip.disabled = false; });
    });
  });
})();
`;

// Pins client. KV-frugal like STATUS_JS/CARD_MENU_JS: reads the whole pins map once
// per session (sessionStorage), writes only on a star click. Runs on every shell page
// to (a) render the rail's Pinned list from the map and (b) wire any star buttons on
// the current page. A pinned row's icon is the leading emoji of its label (the test
// emoji we prefix to prototype names), promoted into the icon slot.
// Inline global consumed by PINS_JS to scope the pinned list to the active space:
// { base: "<active space base>", others: [<every non-default space base>] }.
function spaceContextScript() {
  const spaces = NAV_STATE.spaces || [];
  const active = spaces.find((s) => s.id === NAV_STATE.activeSpace) || spaces[0] || { base: "" };
  const others = spaces.filter((s) => !s.default).map((s) => s.base);
  return `window.__GV_SPACE=${JSON.stringify({ base: active.base || "", others })};`;
}

const PINS_JS = `
(function(){
  var listEls = [].slice.call(document.querySelectorAll('[data-pinned-list]'));
  var emptyEls = [].slice.call(document.querySelectorAll('[data-pinned-empty]'));
  var btns = Array.prototype.slice.call(document.querySelectorAll('[data-pin-key]'));
  if(!listEls.length && !btns.length) return;
  var PCACHE = 'gv_pins_map';
  var EMO = /^(\\p{Extended_Pictographic}(\\uFE0F)?(\\u200D\\p{Extended_Pictographic}(\\uFE0F)?)*)\\s*/u;
  var map = {};
  var loaded = false; // have we synced an authoritative map from the server this session?
  function splitEmoji(s){ s = s || ''; var m; try { m = s.match(EMO); } catch(e){ m = null; } return m ? [m[1], s.slice(m[0].length)] : ['', s]; }
  function esc(s){ return (s||'').replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
  // Scope the rendered pin list to the CURRENT space. Pins live in one per-user bucket
  // across spaces (keys are full URL paths, e.g. "/opp/proto/" or "/space-2/opp/proto/"),
  // so the rail filters to this space: a non-default space keeps only keys under its base;
  // the default space keeps everything NOT under another space's base. (Storage/prune stay
  // on the full map — pinning is global per user; only the display is per-space.)
  function inSpace(k){
    var sp = window.__GV_SPACE || { base:'', others:[] };
    if(sp.base) return k.indexOf(sp.base + '/') === 0;
    for(var i=0;i<(sp.others||[]).length;i++){ if(sp.others[i] && k.indexOf(sp.others[i] + '/') === 0) return false; }
    return true;
  }
  // The card-rename overrides (/__name, global across users) are authoritative for the
  // displayed name. Pin keys are URL form ("/opp/proto/"); rename keys are bare
  // ("opp/proto"), so normalise before lookup. This makes a rename flow into the pinned
  // sidebar live — even for pins created BEFORE the rename (their stored label is just a
  // fallback). Seeded from the shared cache, then refreshed from the server below.
  var NAMES = {};
  try { NAMES = JSON.parse(sessionStorage.getItem('gv_names_map') || '{}'); } catch(e) {}
  function nameKeyOf(k){ try { return decodeURIComponent(k).replace(/^\\/+|\\/+$/g, ''); } catch(e){ return String(k).replace(/^\\/+|\\/+$/g, ''); } }
  function labelOf(k, it){ return NAMES[nameKeyOf(k)] || (it && it.label) || k; }
  function renderList(){
    if(!listEls.length) return;
    var keys = Object.keys(map).filter(inSpace);
    var html = keys.map(function(k){
      var it = map[k] || {}; var parts = splitEmoji(labelOf(k, it));
      var glyph = parts[0] || '📌';
      var txt = esc(parts[1] || it.label || k);
      var cur = (it.href === location.pathname) ? ' aria-current="page"' : '';
      return '<a href="'+esc(it.href||k)+'" draggable="true" data-k="'+esc(k)+'"'+cur+'><span class="gvpin-ic" aria-hidden="true">'+esc(glyph)+'</span><span>'+txt+'</span></a>';
    }).join('');
    listEls.forEach(function(el){ el.innerHTML = html; });
    emptyEls.forEach(function(el){ el.hidden = keys.length > 0; });
  }
  function paintBtns(){
    btns.forEach(function(b){
      var on = Object.prototype.hasOwnProperty.call(map, b.getAttribute('data-pin-key'));
      b.classList.toggle('is-pinned', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.setAttribute('aria-label', on ? 'Unpin from sidebar' : 'Pin to sidebar');
      b.setAttribute('title', on ? 'Pinned — click to remove' : 'Pin to sidebar');
    });
  }
  function cacheSave(){ try { sessionStorage.setItem(PCACHE, JSON.stringify(map)); } catch(e){} }
  // Adopt a server/peer map — but refuse a suspicious wipe (empty map while we already
  // show pins), which would otherwise let a stale KV read poison the cache.
  function adopt(m){
    if(!m || typeof m !== 'object') return false;
    if(Object.keys(m).length === 0 && Object.keys(map).length > 0) return false;
    map = m; cacheSave(); renderList(); paintBtns(); return true;
  }
  // Instant paint from the per-tab cache; then refresh from the server (authoritative).
  var cached = null; try { cached = JSON.parse(sessionStorage.getItem(PCACHE) || 'null'); } catch(e){}
  if(cached){ map = cached; renderList(); paintBtns(); loaded = true; }
  fetch('/__pins', {headers:{'Accept':'application/json'}}).then(function(r){ return r.json(); })
    .then(function(d){ if(d && !d.warning) adopt(d.map); loaded = true; pruneDead(); }).catch(function(){});
  // Refresh the rename overrides too, so the pinned sidebar reflects the latest names.
  fetch('/__name', {headers:{'Accept':'application/json'}}).then(function(r){ return r.json(); })
    .then(function(d){ if(d && d.map){ NAMES = d.map; renderList(); } }).catch(function(){});
  // Run cb once we hold a usable map — never persist before we've synced once, so a
  // fresh tab can't overwrite the server with a guessed-empty/partial map.
  function ready(cb){
    if(loaded){ cb(); return; }
    fetch('/__pins', {headers:{'Accept':'application/json'}}).then(function(r){ return r.json(); })
      .then(function(d){ if(d && !d.warning) adopt(d.map); loaded = true; cb(); }).catch(function(){ loaded = true; cb(); });
  }
  // Authoritative full-state write — send the COMPLETE map (no server read-modify-write).
  function save(allowEmpty){
    cacheSave();
    fetch('/__pins', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ set: map, allowEmpty: !!allowEmpty }) })
      .then(function(r){ return r.json(); }).then(function(d){ if(d && !d.skipped) adopt(d.map); }).catch(function(){});
  }
  // Auto-prune dead pins: a moved/deleted prototype 404s for a signed-in user (an
  // unauthed request would get the 200 login page instead, but in-app you're always
  // authed). HEAD each pin once after the authoritative load and drop only those that
  // return a definitive 404 — never on a network error or 5xx, to avoid false prunes —
  // then persist the cleaned map. Runs at most once per page load.
  var pruned = false;
  function pruneDead(){
    if(pruned) return; pruned = true;
    var keys = Object.keys(map); if(!keys.length) return;
    Promise.all(keys.map(function(k){
      var href = (map[k] && map[k].href) || k;
      return fetch(href, { method:'HEAD' }).then(function(r){ return r.status === 404 ? k : null; }).catch(function(){ return null; });
    })).then(function(res){
      var dead = res.filter(Boolean);
      if(!dead.length) return;
      dead.forEach(function(k){ delete map[k]; });
      renderList(); paintBtns();
      save(Object.keys(map).length === 0);
    });
  }
  function labelFor(b){
    var card = b.closest('[data-rename-key]') || b.closest('.card-proto, .card-opp');
    var nm = card && card.querySelector('.proto-name');
    return (nm && nm.textContent.trim()) || b.getAttribute('data-pin-key');
  }
  function wireBtn(b){
    if(b._gvPinWired) return; b._gvPinWired = true;
    b.addEventListener('click', function(e){
      e.preventDefault(); e.stopPropagation();
      var key = b.getAttribute('data-pin-key'), href = b.getAttribute('data-pin-href') || key, lbl = labelFor(b);
      ready(function(){
        if(Object.prototype.hasOwnProperty.call(map, key)){ delete map[key]; } else { map[key] = { label: lbl, href: href }; }
        renderList(); paintBtns();
        save(Object.keys(map).length === 0);
      });
    });
  }
  btns.forEach(wireBtn);
  // Cards injected AFTER load (e.g. created-canvas cards) call this to join: collects
  // any unwired [data-pin-key] buttons, wires them, and repaints pin state.
  window.__gvPinsWire = function(){
    [].forEach.call(document.querySelectorAll('[data-pin-key]'), function(b){
      if(!b._gvPinWired){ btns.push(b); wireBtn(b); }
    });
    paintBtns();
  };
  // ---- drag-and-drop reorder of the pinned list ----
  // Wrapped per-instance: there can now be two [data-pinned-list]s on the page (the
  // desktop sidebar's and the mobile sheet's, Task 3) and only one is ever visible at
  // a time, but both need independent, fully-working drag/right-click wiring.
  listEls.forEach(function(listEl){
    var dragEl = null, lastDrag = 0;
    function afterEl(y){
      var els = Array.prototype.slice.call(listEl.querySelectorAll('a:not(.gv-dragging)'));
      var best = { off: -Infinity, el: null };
      els.forEach(function(c){ var b = c.getBoundingClientRect(); var off = y - b.top - b.height/2; if(off < 0 && off > best.off){ best = { off: off, el: c }; } });
      return best.el;
    }
    function persistOrder(){
      var order = Array.prototype.slice.call(listEl.querySelectorAll('a')).map(function(a){ return a.getAttribute('data-k'); });
      ready(function(){
        var nm = {};
        order.forEach(function(k){ if(map[k]) nm[k] = map[k]; });
        Object.keys(map).forEach(function(k){ if(!nm[k]) nm[k] = map[k]; }); // keep keys not in the DOM
        map = nm;
        // Repaint every list instance (there can be two now — desktop rail + mobile
        // sheet) so the one NOT being dragged in picks up the new order too; without
        // this it would show the pre-reorder order until the next unrelated repaint.
        renderList();
        save(false); // a reorder must never empty the set
      });
    }
    listEl.addEventListener('dragstart', function(e){
      var a = e.target.closest('a'); if(!a){ return; } dragEl = a;
      try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', a.getAttribute('data-k') || ''); } catch(_){}
      setTimeout(function(){ if(dragEl) dragEl.classList.add('gv-dragging'); }, 0);
    });
    listEl.addEventListener('dragover', function(e){
      if(!dragEl) return; e.preventDefault(); try { e.dataTransfer.dropEffect = 'move'; } catch(_){}
      var after = afterEl(e.clientY);
      if(after == null){ if(listEl.lastElementChild !== dragEl) listEl.appendChild(dragEl); }
      else if(after !== dragEl){ listEl.insertBefore(dragEl, after); }
    });
    listEl.addEventListener('drop', function(e){ if(dragEl) e.preventDefault(); });
    listEl.addEventListener('dragend', function(){ if(!dragEl) return; dragEl.classList.remove('gv-dragging'); dragEl = null; lastDrag = Date.now(); persistOrder(); });
    listEl.addEventListener('click', function(e){ if(Date.now() - lastDrag < 150){ e.preventDefault(); } });
    // Right-click a pinned row to unpin it from the rail. Before this the only way to
    // remove a pin was to navigate back to the card that owns the star — for a pin
    // whose page you can no longer find, a dead end.
    var pinMenu = null, pinMenuFor = null;
    var I_UNPIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H9.24"/><path d="m2 2 20 20"/><path d="M4.73 4.73 4 6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 3 15.24V16a1 1 0 0 0 1 1h12"/></svg>';
    function closePinMenu(){
      if(!pinMenu) return;
      pinMenu.remove(); pinMenu = null;
      if(pinMenuFor){ pinMenuFor.classList.remove('gv-ctxopen'); pinMenuFor = null; }
    }
    listEl.addEventListener('contextmenu', function(e){
      var a = e.target.closest('a'); if(!a) return;
      e.preventDefault();
      closePinMenu();
      var k = a.getAttribute('data-k');
      pinMenuFor = a; a.classList.add('gv-ctxopen');
      pinMenu = document.createElement('div');
      pinMenu.className = 'gvpin-menu'; pinMenu.setAttribute('role','menu');
      var lbl = a.querySelector('span:last-child');
      pinMenu.innerHTML = '<div class="gvpin-menu__hd">' + esc(((lbl || a).textContent || '').trim()) + '</div>'
        + '<button type="button" role="menuitem">' + I_UNPIN + '<span>Remove from sidebar</span></button>';
      document.body.appendChild(pinMenu);
      var r = pinMenu.getBoundingClientRect();
      pinMenu.style.left = Math.max(8, Math.min(e.clientX, innerWidth - r.width - 8)) + 'px';
      pinMenu.style.top = Math.max(8, Math.min(e.clientY, innerHeight - r.height - 8)) + 'px';
      pinMenu.querySelector('button').addEventListener('click', function(){
        closePinMenu();
        ready(function(){
          if(!Object.prototype.hasOwnProperty.call(map, k)) return;
          delete map[k];
          renderList(); paintBtns();
          save(Object.keys(map).length === 0);
        });
      });
      pinMenu.querySelector('button').focus();
    });
    document.addEventListener('mousedown', function(e){ if(pinMenu && !e.target.closest('.gvpin-menu')) closePinMenu(); }, true);
    document.addEventListener('keydown', function(e){ if(pinMenu && e.key === 'Escape') closePinMenu(); }, true);
    addEventListener('blur', closePinMenu);
    listEl.addEventListener('keydown', function(e){
      var a = e.target.closest('a'); if(!a || !e.altKey) return;
      if(e.key === 'ArrowUp'){ e.preventDefault(); var p = a.previousElementSibling; if(p){ listEl.insertBefore(a, p); a.focus(); persistOrder(); } }
      else if(e.key === 'ArrowDown'){ e.preventDefault(); var n = a.nextElementSibling; if(n){ listEl.insertBefore(n, a); a.focus(); persistOrder(); } }
    });
  });
  window.addEventListener('storage', function(e){ if(e.key === PCACHE){ try { var nv = JSON.parse(e.newValue || '{}'); map = nv; renderList(); paintBtns(); } catch(_){} } });
})();
`;

// Profile chip behaviour: fetch the signed-in user from /__me, fill the avatar /
// name / email, reveal the admin link for admins, and reveal the whole chip (it's
// hidden until we confirm a user, so open/no-identity builds stay clean). Plus the
// dropdown open/close (outside-click + Escape to dismiss).
const PROFILE_JS = `(function(){
  var boxes = [].slice.call(document.querySelectorAll('[data-prof]'));
  if(!boxes.length) return;
  var ME = null;
  function initials(u){ return (u.initials || (u.name||'?').slice(0,2)).toUpperCase(); }
  // Identity paints PAGE-WIDE, not just inside the chip: the settings modal renders at
  // body level (outside [data-prof]) and its avatar / name / email carry the same hooks,
  // so one paint fills both surfaces off the single /__me fetch. Chip-only concerns
  // (revealing the box, the admin link) stay scoped to the box.
  function paint(u){
    ME = u;
    var avs = document.querySelectorAll('[data-prof-av]');
    for(var i=0;i<avs.length;i++){
      var a = avs[i];
      if(u.avatar){ a.style.backgroundImage = 'url("'+u.avatar+'")'; a.textContent=''; }
      else { a.style.backgroundImage = 'none'; a.style.background = u.color || '#4f46e5'; a.textContent = initials(u); }
    }
    var names = document.querySelectorAll('[data-prof-name]');
    for(var j=0;j<names.length;j++) names[j].textContent = u.name || u.email;
    var ems = document.querySelectorAll('[data-prof-email]');
    for(var k=0;k<ems.length;k++) ems[k].textContent = u.email || '';
    // style.display, not [hidden]: .gvprof__item sets display:flex and out-specifies
    // the [hidden] rule (same gotcha as the brand), so non-admins kept seeing this.
    // The admin link left this menu: workspace config belongs to the workspace, and it
    // now hangs off the cog on the space row (see spaceSwitcher/SPACE_JS). What stays
    // here is only what is genuinely personal.
    // Instance-wide admin surfaces (the Pitis paw, Delete forever) still reveal via
    // html.gv-admin — those are not per-space questions.
    document.documentElement.classList.toggle('gv-admin', !!u.admin);
    boxes.forEach(function(b){ b.hidden = false; });
    if(u.admin){ version(); }
    // SETTINGS_JS listens for this instead of fetching /__me a second time. Fired on
    // every paint, so it also carries a fresh photo back to an already-open modal.
    document.dispatchEvent(new CustomEvent('gv:me', {detail: u}));
  }
  // …and the way back: the settings modal saved something, so repaint. Both events
  // carry the values the WORKER returned, never what the client sent — a name is
  // cleaned server-side and its initials re-derived there.
  document.addEventListener('gv:avatar', function(e){
    if(!ME) return;
    ME.avatar = (e.detail && e.detail.avatar) || null;
    paint(ME);
  });
  document.addEventListener('gv:name', function(e){
    if(!ME || !e.detail || !e.detail.name) return;
    ME.name = e.detail.name;
    ME.initials = e.detail.initials || null; // null, so initials() re-derives from the name
    paint(ME);
  });
  // Bundle-store fill gauge in the rail foot — admins only (the worker 403s everyone
  // else) and only on instances that actually have a store.

  // Engine version footer + update nudge — admins only (the worker 403s everyone
  // else). One cheap fetch per page view; the release-feed check itself is
  // KV-cached server-side, so this never hits the network feed directly.
  function version(){
    fetch('/__admin/version', {headers:{'Accept':'application/json'}})
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(v){
        if(!v || !v.current) return;
        boxes.forEach(function(box){
          var row = box.querySelector('[data-prof-ver]');
          var cur = box.querySelector('[data-prof-vercur]');
          var lnk = box.querySelector('[data-prof-verlink]');
          if(cur) cur.textContent = 'Augur v' + v.current + (v.current.lastIndexOf('0.', 0) === 0 ? ' beta' : '');
          if(row) row.hidden = false;
          if(v.behind){
            var dot = box.querySelector('[data-prof-dot]'); if(dot) dot.hidden = false;
            if(lnk){ lnk.textContent = 'v' + v.latest + ' available'; if(v.url) lnk.href = v.url; lnk.hidden = false; }
          }
        });
      }).catch(function(){});
  }
  fetch('/__me', {headers:{'Accept':'application/json'}}).then(function(r){ return r.json(); })
    .then(function(d){
      if(d && d.user) paint(d.user);
      // No-identity build → everyone is the operator; admin-ish surfaces (e.g.
      // Delete forever) key off gv-operator there instead of gv-admin.
      if(d && d.accounts === false) document.documentElement.classList.add('gv-operator');
    }).catch(function(){});
  boxes.forEach(function(box){
    var btn = box.querySelector('[data-prof-toggle]');
    var menu = box.querySelector('[data-prof-menu]');
    function open(o){ if(!menu) return; menu.hidden = !o; if(btn) btn.setAttribute('aria-expanded', o ? 'true' : 'false'); }
    if(btn && menu){
      btn.addEventListener('click', function(e){ e.stopPropagation(); open(menu.hidden); });
      document.addEventListener('click', function(e){ if(!box.contains(e.target)) open(false); });
      document.addEventListener('keydown', function(e){ if(e.key === 'Escape') open(false); });
    }
  });
})();
`;

// Account settings behaviour: open the modal from the profile menu, and run the photo
// flow — pick a file, frame it over a circular mask (zoom + pan), then POST the result
// to /__me/avatar. The crop happens HERE because workers have no image library, so the
// browser is the only place a 4MB phone photo can become the ~10KB the roster stores.
//
// Identity is NOT fetched here. PROFILE_JS owns /__me and paints the avatar, name and
// email in this modal along with every other face; the two talk through one event each
// (gv:me down, gv:avatar up), so there is no second fetch and no script-order dependency.
const SETTINGS_JS = `(function(){
  var el = document.querySelector('[data-set]');
  var crop = document.querySelector('[data-crop]');
  if(!el || !crop) return;
  // 3.3x the 96px circle the modal draws, so the face is sharp at 2x and 3x device
  // pixel ratios. MAX mirrors AVATAR_MAX_CHARS in the worker — encode() steps down
  // until it fits rather than posting something the worker would 400.
  var SIZE = 320, MAX_CHARS = 64 * 1024;
  var ME = null, last = null, hideT = null;

  // ── Who is signed in ───────────────────────────────────────────────────────
  // All this needs from PROFILE_JS is the role (the chip never showed it) and the
  // fact that a real user exists — without one there is nothing to open.
  var roleEl = el.querySelector('[data-set-role]');
  document.addEventListener('gv:me', function(e){
    ME = e.detail || null;
    if(roleEl) roleEl.textContent = ME && ME.admin ? 'Admin' : 'User';
  });

  // ── The modal ──────────────────────────────────────────────────────────────
  var errEl = el.querySelector('[data-set-err]');
  function err(t){ if(!errEl) return; errEl.textContent = t || ''; errEl.hidden = !t; }
  function open(returnEl){
    if(!ME) return;
    if(hideT){ clearTimeout(hideT); hideT = null; }
    // Restore focus to whichever chip/sheet-button opened this (desktop dropdown or
    // the mobile Profile-tab button) — there can be more than one on the page now.
    last = returnEl || document.activeElement;
    el.hidden = false;
    requestAnimationFrame(function(){ el.classList.add('is-open'); });
    var x = el.querySelector('[data-set-close]'); if(x) x.focus();
  }
  function close(){
    err('');
    if(nameForm && !nameForm.hidden) nameEdit(false); // never reopen onto a half-finished rename
    el.classList.remove('is-open');
    // Hide after the fade; a timeout backstops reduced-motion (no transitionend).
    hideT = setTimeout(function(){ el.hidden = true; hideT = null; }, 220);
    if(last && last.focus) last.focus();
  }
  [].forEach.call(document.querySelectorAll('[data-prof-settings]'), function(o){
    o.addEventListener('click', function(e){
      e.preventDefault(); e.stopPropagation();
      // Scope to the box this button lives in — there can be more than one
      // [data-prof] on the page (desktop chip + mobile Profile sheet).
      var box = o.closest('[data-prof]');
      // The click never reaches PROFILE_JS's outside-click handler (and wouldn't
      // close the menu anyway, being inside it), so dismiss the menu here.
      var pm = box && box.querySelector('[data-prof-menu]'); if(pm) pm.hidden = true;
      var pt = box && box.querySelector('[data-prof-toggle]'); if(pt) pt.setAttribute('aria-expanded','false');
      open(pt);
    });
  });
  [].forEach.call(el.querySelectorAll('[data-set-close], [data-set-scrim]'), function(c){
    c.addEventListener('click', close);
  });
  // One tab today; wired generically so a second needs markup only, no JS.
  [].forEach.call(el.querySelectorAll('[data-set-tab]'), function(b){
    b.addEventListener('click', function(){
      var t = b.getAttribute('data-set-tab');
      [].forEach.call(el.querySelectorAll('[data-set-tab]'), function(o){
        var on = o.getAttribute('data-set-tab') === t;
        o.classList.toggle('is-active', on);
        o.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      [].forEach.call(el.querySelectorAll('[data-set-panel]'), function(s){
        s.hidden = s.getAttribute('data-set-panel') !== t;
      });
    });
  });

  // ── Change name ────────────────────────────────────────────────────────────
  // Inline rather than a third stacked dialog: one field with Save/Cancel in the row
  // it belongs to. On success PROFILE_JS repaints every name and every set of initials
  // on the page (gv:name), so the chip agrees with the modal without a reload.
  var nameView = el.querySelector('[data-set-name-view]');
  var nameForm = el.querySelector('[data-set-name-form]');
  var nameInput = el.querySelector('[data-set-name-input]');
  var nameSave = el.querySelector('[data-set-name-save]');
  var nameMsg = el.querySelector('[data-set-name-msg]');
  var rename = el.querySelector('[data-set-rename]');
  function nameEdit(on){
    if(!nameView || !nameForm) return;
    if(nameMsg) nameMsg.textContent = '';
    nameView.hidden = on;
    nameForm.hidden = !on;
    if(on && nameInput){
      nameInput.value = (ME && ME.name) || '';
      nameInput.focus(); nameInput.select();
    } else if(rename) rename.focus();
  }
  if(rename) rename.addEventListener('click', function(){ nameEdit(true); });
  var nameCancel = el.querySelector('[data-set-name-cancel]');
  if(nameCancel) nameCancel.addEventListener('click', function(){ nameEdit(false); });
  if(nameForm) nameForm.addEventListener('submit', function(e){
    e.preventDefault();
    var next = (nameInput && nameInput.value || '').trim();
    if(!next){ if(nameMsg) nameMsg.textContent = 'A name cannot be blank'; return; }
    if(ME && next === ME.name){ nameEdit(false); return; } // nothing to save
    if(nameSave) nameSave.setAttribute('aria-busy', 'true');
    if(nameMsg) nameMsg.textContent = '';
    fetch('/__me/name', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({name: next})
    }).then(function(r){ return r.json().catch(function(){ return {}; }).then(function(d){
      if(!r.ok || !d.ok) throw new Error(d.error || 'failed');
      // The server cleans the name (whitespace, control characters) and re-derives the
      // initials, so take BOTH from the response — never from what was typed.
      document.dispatchEvent(new CustomEvent('gv:name', {detail: {name: d.name, initials: d.initials}}));
      nameEdit(false);
    }); })
      .catch(function(){ if(nameMsg) nameMsg.textContent = 'Could not save that name'; })
      .then(function(){ if(nameSave) nameSave.setAttribute('aria-busy', 'false'); });
  });
  // ── The crop dialog ────────────────────────────────────────────────────────
  // ONE handler for every layer, so the order is guaranteed: crop dialog, then an open
  // name field, then the modal itself — innermost first, never two at once. It has to
  // live here rather than on each element: this listener CAPTURES (which is what keeps
  // the rail's own Escape handlers from also firing), so a listener on the name input
  // would never get its turn.
  document.addEventListener('keydown', function(e){
    if((e.key || '').toLowerCase() !== 'escape') return;
    if(!crop.hidden){ e.preventDefault(); e.stopPropagation(); cropClose(); return; }
    if(nameForm && !nameForm.hidden){ e.preventDefault(); e.stopPropagation(); nameEdit(false); return; }
    if(!el.hidden){ e.preventDefault(); e.stopPropagation(); close(); }
  }, true);

  var CV = crop.querySelector('[data-crop-canvas]');
  var G = CV.getContext('2d');
  var range = crop.querySelector('[data-crop-range]');
  var saveBtn = crop.querySelector('[data-crop-save]');
  var msgEl = crop.querySelector('[data-crop-msg]');
  var D = CV.width;              // 576 backing px behind a 288px CSS box — retina-crisp
  var img = null, scale = 1, ox = 0, oy = 0, frame = 0;
  function msg(t){ if(!msgEl) return; msgEl.textContent = t || ''; msgEl.hidden = !t; }

  // scale 1 = the image's SHORT side exactly fills the circle (a cover fit — the
  // framing the old silent centre-crop produced). Everything else scales off this.
  function base(){ return D / Math.min(img.width, img.height); }
  // Keep the drawn image covering the circle in both axes: the mask can never show a gap.
  function clamp(){
    var b = base();
    ox = Math.min(0, Math.max(D - img.width * b * scale, ox));
    oy = Math.min(0, Math.max(D - img.height * b * scale, oy));
  }
  // One transform, two resolutions: the preview (D) and the saved photo (SIZE) are the
  // same draw scaled by k, so what you frame is exactly what gets stored.
  function paintTo(g, size){
    var k = size / D, b = base() * scale * k;
    g.imageSmoothingQuality = 'high';
    g.fillStyle = '#fff'; g.fillRect(0, 0, size, size); // PNG transparency → white, not black
    g.drawImage(img, ox * k, oy * k, img.width * b, img.height * b);
  }
  function draw(){ frame = 0; if(img) paintTo(G, D); }
  function schedule(){ if(!frame) frame = requestAnimationFrame(draw); }
  // Zoom about the centre of the circle, so the face you framed stays framed.
  function zoom(next){
    next = Math.max(1, Math.min(3, next));
    if(next === scale) return;
    var half = D / 2, k = next / scale;
    ox = half - (half - ox) * k;
    oy = half - (half - oy) * k;
    scale = next;
    if(range) range.value = String(scale);
    clamp(); schedule();
  }

  var edit = el.querySelector('[data-set-edit]');
  var file = el.querySelector('[data-set-file]');
  function load(f){
    // from-image applies the EXIF orientation, so portraits off a phone aren't sideways.
    if(window.createImageBitmap) return createImageBitmap(f, {imageOrientation:'from-image'});
    return new Promise(function(res, rej){
      var i = new Image(), url = URL.createObjectURL(f);
      i.onload = function(){ URL.revokeObjectURL(url); res(i); };
      i.onerror = function(){ URL.revokeObjectURL(url); rej(new Error('decode')); };
      i.src = url;
    });
  }
  function cropOpen(){
    msg('');
    crop.hidden = false;
    if(saveBtn) saveBtn.focus();
    schedule();
  }
  function cropClose(){
    crop.hidden = true;
    if(img && img.close) img.close(); // release the decoded bitmap
    img = null;
    if(edit && edit.focus) edit.focus();
  }
  if(edit && file){
    edit.addEventListener('click', function(){ err(''); file.click(); });
    file.addEventListener('change', function(){
      var f = file.files && file.files[0];
      file.value = ''; // so picking the same file twice still fires
      if(!f) return;
      edit.setAttribute('aria-busy', 'true');
      load(f).then(function(bmp){
        img = bmp; scale = 1;
        var b = base();
        ox = (D - img.width * b) / 2;   // start centred — where the old crop landed
        oy = (D - img.height * b) / 2;
        if(range) range.value = '1';
        cropOpen();
      }).catch(function(){ err('Could not read that image'); })
        .then(function(){ edit.setAttribute('aria-busy', 'false'); });
    });
  }
  [].forEach.call(crop.querySelectorAll('[data-crop-close], [data-crop-scrim]'), function(c){
    c.addEventListener('click', cropClose);
  });
  if(range) range.addEventListener('input', function(){ zoom(parseFloat(range.value)); });
  var zoomOut = crop.querySelector('[data-crop-out]');
  var zoomIn = crop.querySelector('[data-crop-in]');
  if(zoomOut) zoomOut.addEventListener('click', function(){ zoom(scale - 0.2); });
  if(zoomIn) zoomIn.addEventListener('click', function(){ zoom(scale + 0.2); });

  // Drag to pan. Pointer deltas are CSS px; the canvas is backed at D, so scale them.
  var drag = null;
  CV.addEventListener('pointerdown', function(e){
    if(!img) return;
    drag = {x: e.clientX, y: e.clientY};
    CV.setPointerCapture(e.pointerId);
  });
  CV.addEventListener('pointermove', function(e){
    if(!drag || !img) return;
    var k = D / (CV.clientWidth || D);
    ox += (e.clientX - drag.x) * k;
    oy += (e.clientY - drag.y) * k;
    drag.x = e.clientX; drag.y = e.clientY;
    clamp(); schedule();
  });
  function endDrag(e){ if(drag){ drag = null; try { CV.releasePointerCapture(e.pointerId); } catch(_){} } }
  CV.addEventListener('pointerup', endDrag);
  CV.addEventListener('pointercancel', endDrag);

  // Encode the framed circle, stepping quality (then size) down until the data URI
  // fits what the worker stores. A dense photo at full quality can clear the ceiling,
  // and a 400 after all that framing would be the worst possible moment to fail.
  function encode(){
    var tries = [[SIZE, 0.82], [SIZE, 0.7], [SIZE, 0.58], [256, 0.7], [192, 0.7]];
    for(var i = 0; i < tries.length; i++){
      var c = document.createElement('canvas');
      c.width = c.height = tries[i][0];
      paintTo(c.getContext('2d'), tries[i][0]);
      var uri = c.toDataURL('image/jpeg', tries[i][1]);
      if(uri.length <= MAX_CHARS) return uri;
    }
    return null;
  }

  if(saveBtn) saveBtn.addEventListener('click', function(){
    if(!img) return;
    saveBtn.setAttribute('aria-busy', 'true'); msg('');
    var uri = encode();
    if(!uri){ msg('That image is too detailed to store'); saveBtn.setAttribute('aria-busy', 'false'); return; }
    fetch('/__me/avatar', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({avatar: uri})
    }).then(function(r){ return r.json().catch(function(){ return {}; }).then(function(d){
      if(!r.ok || !d.ok) throw new Error(d.error || 'failed');
      // The worker mints a content-hashed URL, so it never collides with the cached
      // previous photo. PROFILE_JS owns every face on the page — hand it over.
      document.dispatchEvent(new CustomEvent('gv:avatar', {detail: {avatar: d.avatar || null}}));
      cropClose();
    }); })
      // Keep the dialog open with the framing intact, so a retry needs no re-pick.
      .catch(function(){ msg('Could not save photo'); })
      .then(function(){ saveBtn.setAttribute('aria-busy', 'false'); });
  });
})();
`;

// "New canvas" behaviour — the folderbar button + the cards for canvases created
// that way. A created canvas is a worker-served loader page registered in the
// /__canvases KV map (no repo file until someone materializes the folder — see
// canvasesApi in src/_worker.js). This block (1) reveals the button once /__me
// confirms a signed-in user (or an open/no-identity build), (2) creates + navigates
// on click, and (3) appends a card for each canvas registered under this folder so
// created boards stay findable. KV-frugal: one /__canvases GET per page view.
const NEWCANVAS_JS = `
(function(){
  var btn = document.querySelector('[data-new-canvas]');
  if(!btn) return;
  var dir = btn.getAttribute('data-new-canvas');
  var IC_IGNORE = ${JSON.stringify(STATUS_ICONS.ignore)};
  function esc(s){ return String(s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
  // Mini-map thumbnail: the board doc drawn as an SVG floor plan — sections under
  // content, stickies in their colors, marker strokes as polylines. No iframe (a
  // live canvas page would join the multiplayer room as a ghost presence).
  function col(c, fb){ return /^#[0-9a-fA-F]{3,8}$/.test(String(c || '')) ? c : fb; }
  function minimap(host, doc){
    var ns = ((doc && doc.nodes) || []).filter(function(n){ return isFinite(n.x) && isFinite(n.y); });
    if(!host || !ns.length) return;
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    ns.forEach(function(n){
      var w = +n.w || 160, h = +n.h || 100;
      if(n.x < x0) x0 = n.x; if(n.y < y0) y0 = n.y;
      if(n.x + w > x1) x1 = n.x + w; if(n.y + h > y1) y1 = n.y + h;
    });
    var pad = Math.max(x1 - x0, y1 - y0) * 0.04 + 40;
    var RANK = { section: 0, image: 1, tile: 1, text: 1, sticky: 2, draw: 3 };
    var parts = [];
    ns.slice().sort(function(a, b){ return (RANK[a.type] || 1) - (RANK[b.type] || 1); }).forEach(function(n){
      var w = +n.w || 160, h = +n.h || 100;
      if(n.type === 'draw' && n.points && n.points.length){
        var pts = n.points.map(function(q){ return (n.x + (+q[0] || 0)).toFixed(1) + ',' + (n.y + (+q[1] || 0)).toFixed(1); }).join(' ');
        parts.push('<polyline points="' + pts + '" fill="none" stroke="' + col(n.color, '#f24822') + '" stroke-width="2.2" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>');
        return;
      }
      var fill = n.type === 'sticky' ? col(n.color, '#ffe066')
        : n.type === 'section' ? col(n.color, '#faf8f4')
        : n.type === 'image' ? '#dde3ea' : '#ffffff';
      parts.push('<rect x="' + n.x + '" y="' + n.y + '" width="' + w + '" height="' + h + '" rx="' + (Math.min(w, h) * 0.06).toFixed(1) + '" fill="' + fill + '"' + (n.type === 'section' ? ' fill-opacity=".55"' : '') + ' stroke="#d9d5cd" vector-effect="non-scaling-stroke"/>');
    });
    host.innerHTML = '<svg viewBox="' + (x0 - pad).toFixed(1) + ' ' + (y0 - pad).toFixed(1) + ' ' +
      (x1 - x0 + 2 * pad).toFixed(1) + ' ' + (y1 - y0 + 2 * pad).toFixed(1) +
      '" preserveAspectRatio="xMidYMid meet">' + parts.join('') + '</svg>';
  }
  function rel(t){
    var s = Math.max(0, (Date.now() - t) / 1000);
    if(s < 60) return 'just now';
    if(s < 3600) return Math.round(s/60) + ' min ago';
    if(s < 86400) return Math.round(s/3600) + ' hours ago';
    return Math.round(s/86400) + ' days ago';
  }
  fetch('/__me',{headers:{'Accept':'application/json'}}).then(function(r){return r.json();})
    .then(function(d){ if(d && (d.user || d.accounts === false)) btn.hidden = false; }).catch(function(){});
  btn.addEventListener('click', function(){
    var name = prompt('Name the new canvas:');
    if(!name || !name.trim()) return;
    btn.disabled = true;
    fetch('/__canvases',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dir:dir,name:name.trim()})})
      .then(function(r){return r.json();})
      .then(function(d){
        if(d && d.path && !d.error){ location.href = d.path; return; }
        btn.disabled = false;
        if(d && d.error === 'exists' && d.path){ if(confirm('Something already lives at that name. Open it?')) location.href = d.path; }
        else alert('Could not create the canvas.');
      })
      .catch(function(){ btn.disabled = false; alert('Could not create the canvas.'); });
  });
  var grid = document.querySelector('[data-fgroup] .opp-grid, [data-fgroup] .page-grid');
  if(!grid) return;
  fetch('/__canvases',{headers:{'Accept':'application/json'}}).then(function(r){return r.json();})
    .then(function(d){
      var map = (d && d.map) || {};
      // Ascending by creation time, then each PREPENDED to the grid — so the
      // newest created canvas lands first, where a just-made board is expected
      // (appending buried it below every prototype, so a fresh board got lost).
      var mine = Object.keys(map).filter(function(p){
        return p.indexOf(dir) === 0 && p.length > dir.length && p.slice(dir.length, -1).indexOf('/') === -1;
      }).sort(function(a,b){ return (map[a].t||0) - (map[b].t||0); });
      if(!mine.length) return;
      mine.forEach(function(p){
        var e = map[p] || {};
        var display = '\\uD83D\\uDDFA\\uFE0F ' + (e.name || p);
        var card = document.createElement('div');
        // Full citizen of the card grid: data-rename-key joins the right-click menu
        // (Open / Copy link / Rename / Remove canvas — CARD_MENU_JS branches on
        // data-canvas-path), the pin star joins PINS_JS via __gvPinsWire below.
        card.className = 'card-opp card-canvas';
        card.setAttribute('data-fitem','');
        card.setAttribute('data-fkey', e.name || p);
        card.setAttribute('data-rename-key', 'canvas:' + p);
        card.setAttribute('data-default-name', display);
        card.setAttribute('data-canvas-path', p);
        card.innerHTML =
          '<a class="card-cover-link" href="' + esc(p) + '" aria-label="Open ' + esc(e.name || 'canvas') + '"></a>' +
          '<div class="preview preview--canvas">' +
            '<div class="canvas-map" aria-hidden="true">\\uD83D\\uDDFA\\uFE0F</div>' +
            '<button type="button" class="status-chip is-ignore" data-status-key="canvas:' + esc(p) + '" data-status="ignore" aria-label="Status: Ignore. Click to change.">' + IC_IGNORE + '</button>' +
          '</div>' +
          '<div class="preview-actions"><button type="button" class="pin-btn" data-pin-key="' + esc(p) + '" data-pin-href="' + esc(p) + '" aria-pressed="false" aria-label="Pin to sidebar" title="Pin to sidebar">${IC_STAR}</button></div>' +
          '<div class="proto-meta"><div class="proto-text">' +
            '<div class="proto-name">' + esc(display) + '</div>' +
            '<div class="proto-date">Canvas' + (e.t ? ' \\u00b7 ' + rel(e.t) : '') + '</div>' +
          '</div></div>';
        grid.insertBefore(card, grid.firstChild);
        // The preview skeleton (.preview::after) is an OPAQUE shimmer that only clears
        // on .is-loaded, and the page's load handlers add that class from media load
        // events — a poster's onload, an iframe's. A canvas card has neither: its
        // content is the SVG mini-map this fetch draws, so nothing ever cleared the
        // skeleton and every created canvas showed a blank grey tile with a fully
        // rendered map underneath it. Clear it when the board settles, either way, so
        // the shimmer still reads as "loading the board" and an empty or unreachable
        // one lands on the dotted whiteboard + map-emoji ghost instead of a shimmer
        // that never stops.
        (function(mapEl, prev){
          function settled(){ if(prev) prev.classList.add('is-loaded'); }
          fetch('/__board?path=' + encodeURIComponent(p), {headers:{'Accept':'application/json'}})
            .then(function(r){ return r.json(); })
            .then(function(d){ if(d && d.doc) minimap(mapEl, d.doc); settled(); })
            .catch(settled);
        })(card.querySelector('.canvas-map'), card.querySelector('.preview'));
      });
      if(window.__gvPinsWire) window.__gvPinsWire();
      if(window.__gvStatusWire) window.__gvStatusWire();
    }).catch(function(){});
})();`;

// Space switcher behaviour — open/close the dropdown (the chip + rows are server-rendered,
// each row a plain <a> to the space's base URL, so switching is just navigation). The
// Create-new entry is a stub: spaces are REPOS (one repo per space, mounted as Augur
// submodules at spaces/<id>), so creating one is a maintainer act, not an in-app feature.
//
// Membership is applied HERE rather than at build time, because the build has no viewer.
// Every row ships hidden; /__me names the ones you belong to and this reveals only those.
// The worker gates the same paths server-side (spaceIdForPath + isMemberOf) — this half
// is what stops a space you cannot reach from appearing in your switcher at all.
const SPACE_JS = `(function(){
  var box = document.querySelector('[data-space]');
  if(!box) return;
  // The row names a workspace, so it stays dark until /__me confirms you are in one.
  // There is no list to filter any more (see spaceSwitcher) — just: do you belong
  // here, and do you administer it.
  fetch('/__me', {headers:{'Accept':'application/json'}}).then(function(r){
    return r.ok ? r.json() : null;
  }).then(function(d){
    if(!d) return;
    var mine = (d && d.spaces) || [];
    // No accounts at all (open/offline build) → everyone is the operator, so show it
    // rather than blanking the rail. Same degradation as every other surface.
    var open = d && d.accounts === false;
    var id = box.getAttribute('data-space-active') || '';
    var here = null;
    for(var i=0;i<mine.length;i++){ if(mine[i].id === id) here = mine[i]; }
    if(!open && !here) return;
    document.documentElement.classList.add('gv-spaces');
    if(here){
      var nm = box.querySelector('[data-space-name]');
      if(nm && here.name) nm.textContent = here.name;
      var ic = box.querySelector('[data-space-icon]');
      if(ic && here.icon) ic.src = here.icon;
    }
    if(open || (here && here.role === 'admin')){
      document.documentElement.classList.add('gv-space-admin');
      // Scope every Admin link to this workspace so each opens on the right one —
      // there can be more than one now (desktop rail + mobile Profile sheet).
      var links = document.querySelectorAll('[data-space-admin]');
      if(id) [].forEach.call(links, function(link){ link.setAttribute('href', '/admin/?space=' + encodeURIComponent(id)); });
    }
  }).catch(function(){});
})();
`;

// Admin page behaviour: a people table (name + email, role, last active) fed by
// /__admin/users — admin-only; the worker 403s everyone else and gates /admin/ itself.
// Three actions, all through the same API: INVITE an address (puts it on the runtime
// roster and mints its single-use link), RESET someone (revokes their password, mints a
// fresh link), REMOVE someone. No path here sets or reveals a password — every
// credential action ends in a link the admin copies and sends.
// Live-content table on /admin/ — reads the public build stamp and renders what the
// store is actually serving. Its reason for existing is the `dirty` flag: a publish
// from an uncommitted working tree serves bytes that exist in no repository, and
// until now that was invisible unless someone thought to curl /_build.json. One
// instance sat dirty for hours with nobody aware. Cache-busted because the CDN
// serves the stamp stale for a minute or two after a publish.
const LIVE_CONTENT_JS = `(function(){
  var body = document.querySelector('[data-live-content]');
  if(!body) return;
  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function ago(iso){
    if(!iso) return '';
    var t = Date.parse(iso); if(isNaN(t)) return '';
    var s = Math.max(0, (Date.now()-t)/1000);
    if(s < 90) return 'just now';
    if(s < 5400) return Math.round(s/60)+' min ago';
    if(s < 172800) return Math.round(s/3600)+' h ago';
    return Math.round(s/86400)+' days ago';
  }
  function row(id, d){
    var dirty = d && d.dirty
      ? '<span class="aulive__dirty" title="Published from an uncommitted working tree — these exact bytes are in no repository">working tree</span>' : '';
    var sha = d && d.sha ? '<span class="aulive__sha">'+esc(String(d.sha).slice(0,12))+'</span>' : '<span class="aulive__sha">—</span>';
    return '<tr>'+
      '<td><span class="aulive__id">'+esc(id)+'</span></td>'+
      '<td><span class="aulive__v">'+(d && d.version ? 'v'+esc(d.version) : '—')+'</span></td>'+
      '<td><span class="aulive__when">'+esc(ago(d && d.publishedAt))+'</span>'+
        (d && d.publishedBy ? '<br><span class="aulive__by">'+esc(d.publishedBy)+'</span>' : '')+'</td>'+
      '<td>'+sha+dirty+'</td>'+
    '</tr>';
  }
  fetch('/_build.json?t='+Date.now(), {headers:{'Accept':'application/json'}})
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(d){
      if(!d){ body.innerHTML = '<tr><td colspan="4" class="empty">Build stamp unavailable.</td></tr>'; return; }
      var out = '', spaces = d.spaces || {};
      Object.keys(spaces).sort().forEach(function(id){ out += row(id, spaces[id]); });
      out += row('engine chrome', d.engine || {});
      body.innerHTML = out || '<tr><td colspan="4" class="empty">Nothing published yet.</td></tr>';
    })
    .catch(function(){ body.innerHTML = '<tr><td colspan="4" class="empty">Build stamp unavailable.</td></tr>'; });
})();`;

const ADMIN_JS = `(function(){
  // Injected at build time so the client has the same icon set the rail uses.
  var ROLE_ICONS = {
    admin: ${JSON.stringify(IC_ROLE_ADMIN)},
    editor: ${JSON.stringify(IC_ROLE_EDITOR)},
    viewer: ${JSON.stringify(IC_ROLE_VIEWER)}
  };
  var host = document.querySelector('[data-admin-users]');
  if(!host) return;
  var menu = document.querySelector('[data-menu]');
  var linkbox = document.querySelector('[data-link]');
  var invite = document.querySelector('[data-invite]');
  var people = [], current = null, sortKey = 'seen', sortDir = -1, myEmail = '';
  // Who am I — so the row menu can hide "Remove user" on my own row (the API refuses
  // it with cannot-remove-self; the UI shouldn't offer a dialog that always errors).
  fetch('/__me',{headers:{'Accept':'application/json'}}).then(function(r){ return r.ok ? r.json() : null; })
    .then(function(d){ if(d && d.user) myEmail = (d.user.email||'').toLowerCase(); }).catch(function(){});

  function esc(s){ return (s||'').replace(/[&<>"]/g,function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
  function ago(iso){
    if(!iso) return 'Never';
    var t = Date.parse(iso); if(isNaN(t)) return 'Never';
    var s = (Date.now() - t) / 1000;
    if(s < 90) return 'Just now';
    if(s < 3600) return Math.floor(s/60) + ' min ago';
    if(s < 86400) return Math.floor(s/3600) + ' h ago';
    var d = Math.floor(s/86400);
    if(d === 1) return 'Yesterday';
    if(d < 30) return d + ' days ago';
    return new Date(t).toLocaleDateString();
  }

  // The invite/reset link is the whole point of both flows, so it gets its own strip
  // above the table rather than a cell that scrolls out of view.
  function showLink(who, url){
    linkbox.querySelector('[data-link-who]').textContent = who;
    var input = linkbox.querySelector('[data-link-url]');
    input.value = url; linkbox.hidden = false;
    linkbox.querySelector('[data-link-msg]').textContent = '';
    input.focus(); input.select();
  }

  function rowHtml(u){
    var ini = (u.initials || (u.name||'?').slice(0,2)).toUpperCase();
    var av = u.avatar
      ? '<span class="au__av" style="background:url(&quot;'+esc(u.avatar)+'&quot;) center/cover, '+esc(u.color||'#4f46e5')+'"></span>'
      : '<span class="au__av" style="background:'+esc(u.color||'#4f46e5')+'">'+esc(ini)+'</span>';
    var seen = u.state === 'accepted'
      ? '<span class="au__seen'+(u.lastSeen ? '' : ' au__seen--never')+'">'+esc(ago(u.lastSeen))+'</span>'
      : '<span class="au__chip">Invite pending</span>';
    return '<tr class="au" data-email="'+esc(u.email)+'" tabindex="0">'
      + '<td class="au__who">'+av+'<span class="au__id">'
      +   '<span class="au__name">'+esc(u.name)+'</span>'
      +   '<span class="au__email">'+esc(u.email)+'</span></span></td>'
      + '<td class="au__role">'+roleControl(u)+'</td>'
      + '<td class="au__last">'+seen+'</td>'
      + '<td class="au__go" aria-hidden="true">&rsaquo;</td>'
      + '</tr>';
  }

  // "user" is the legacy spelling of "editor"; an absent role means the same. The
  // panel never shows the old word — it would read as a fourth thing.
  function roleLabel(r){
    return r === 'admin' ? 'Admin' : (r === 'viewer' ? 'Viewer' : 'Editor');
  }
  // Icon + label per role, so the three read apart at a glance rather than by word
  // alone. ROLE_ICONS is injected by the build (see ADMIN_JS's caller).
  function roleIcon(r){
    return ROLE_ICONS[r === 'admin' ? 'admin' : (r === 'viewer' ? 'viewer' : 'editor')] || '';
  }
  // A <select> rather than a bespoke popover: it is a value the row OWNS, it is
  // keyboard- and screen-reader-correct for free, and it puts the change one click
  // away instead of behind a row menu. Your own row is disabled — the server refuses
  // a self-demotion anyway (you would be locking yourself out), so offering it would
  // only ever produce an error.
  function roleControl(u){
    var mine = u.email && u.email.toLowerCase() === myEmail;
    var cur = roleOf(u.email);
    var opts = ['admin','editor','viewer'].map(function(r){
      return '<option value="'+r+'"'+(r === cur ? ' selected' : '')+'>'+roleLabel(r)+'</option>';
    }).join('');
    return '<span class="au__rolewrap'+(cur === 'admin' ? ' is-admin' : '')+'">'
      + '<span class="au__roleic" aria-hidden="true">'+roleIcon(cur)+'</span>'
      + '<select class="au__rolesel" data-role-for="'+esc(u.email)+'" aria-label="Role for '+esc(u.name || u.email)+'"'
      +   (mine ? ' disabled title="You cannot change your own role"' : '')+'>'+opts+'</select>'
      + '</span>';
  }
  function roleOf(email){
    for(var i=0;i<people.length;i++) if(people[i].email === email){
      var r = people[i].role;
      return r === 'admin' || r === 'viewer' ? r : 'editor';
    }
    return 'editor';
  }

  function render(){
    var d = sortDir;
    people.sort(function(a,b){
      var r;
      if(sortKey === 'name') r = (a.name||'').localeCompare(b.name||'');
      else if(sortKey === 'role') r = (a.role||'').localeCompare(b.role||'');
      else r = (a.lastSeen ? Date.parse(a.lastSeen) : 0) - (b.lastSeen ? Date.parse(b.lastSeen) : 0);
      return (r * d) || (a.name||'').localeCompare(b.name||'');
    });
    host.innerHTML = people.map(rowHtml).join('');
    var ths = document.querySelectorAll('[data-sort]');
    for(var i=0;i<ths.length;i++){
      var k = ths[i].getAttribute('data-sort');
      ths[i].setAttribute('aria-sort', k === sortKey ? (d < 0 ? 'descending' : 'ascending') : 'none');
    }
  }

  function load(){
    // ?space= scopes the answer to this workspace's members, at their role HERE.
    // Without it the API answers the whole roster at global roles — which is what a
    // caller predating per-space admin expects, so the parameter is the only difference.
    var sp = new URLSearchParams(location.search).get('space');
    return fetch('/__admin/users' + (sp ? '?space=' + encodeURIComponent(sp) : ''),
      {headers:{'Accept':'application/json'}}).then(function(r){
      if(r.status === 403){ host.innerHTML = '<tr><td colspan="4" class="empty">Admins only.</td></tr>'; return null; }
      return r.json();
    }).then(function(d){
      if(!d) return;
      if(!d.users){ host.innerHTML = '<tr><td colspan="4" class="empty">Could not load users.</td></tr>'; return; }
      people = d.users;
      render();
    }).catch(function(){ host.innerHTML = '<tr><td colspan="4" class="empty">Could not load users.</td></tr>'; });
  }

  function post(body){
    return fetch('/__admin/users',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) })
      .then(function(r){ return r.json(); });
  }

  // ── Row menu — reset / remove, anchored to the row you clicked ──────────────
  function closeMenu(){ if(menu){ menu.hidden = true; } current = null; }
  function openMenu(tr){
    current = tr.getAttribute('data-email');
    menu.querySelector('[data-menu-who]').textContent = current;
    // Can't remove yourself (the API refuses it) — hide the option on your own row.
    var rm = menu.querySelector('[data-menu-remove]');
    if(rm) rm.style.display = (current && current.toLowerCase() === myEmail) ? 'none' : 'block';
    // A reset hands over the ACCOUNT, not a workspace, so the API refuses it when the
    // target belongs to a space you don't administer. Hide it rather than offer an
    // action that 403s — see mayResetPassword in the worker.
    var rs = menu.querySelector('[data-menu-reset]');
    if(rs){
      var may = true;
      for(var i=0;i<people.length;i++) if(people[i].email === current){
        may = people[i].mayReset !== false;
      }
      rs.style.display = may ? 'block' : 'none';
    }
    menu.hidden = false;
    var r = tr.getBoundingClientRect();
    var mh = menu.offsetHeight, mw = menu.offsetWidth;
    var rolesel = menu.querySelector('[data-menu-role]');
    if(rolesel) rolesel.value = roleOf(current);
    menu.style.left = Math.max(10, r.right - mw) + 'px';
    menu.style.top = Math.max(10, Math.min(window.innerHeight - mh - 10, r.bottom - 4)) + 'px';
  }
  // Changing a role from the table. Posts {op:"space"} when the page is scoped to a
  // workspace (roles are per workspace), falling back to the instance-wide {op:"role"}
  // on a build that has no space context. A refusal — last admin, beyond your
  // authority — puts the select back where it was rather than leaving a lie on screen.
  host.addEventListener('change', function(e){
    var sel = e.target && e.target.closest ? e.target.closest('[data-role-for]') : null;
    if(!sel) return;
    var email = sel.getAttribute('data-role-for');
    var want = sel.value;
    var was = roleOf(email);
    if(want === was) return;
    var sp = new URLSearchParams(location.search).get('space');
    var body = sp ? {op:'space', email:email, space:sp, role:want} : {op:'role', email:email, role:want};
    sel.disabled = true;
    fetch('/__admin/users', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body) })
      .then(function(r){ return r.json().catch(function(){ return {}; })
        .then(function(d){ return {ok:r.ok, d:d}; }); })
      .then(function(res){
        sel.disabled = false;
        if(!res.ok){
          sel.value = was;
          window.alert((res.d && res.d.message) || (res.d && res.d.error === 'last-admin'
            ? 'This is the only admin of this workspace.'
            : 'Could not change role.'));
          return;
        }
        for(var i=0;i<people.length;i++) if(people[i].email === email) people[i].role = want;
        var wrap = sel.closest('.au__rolewrap');
        if(wrap){
          wrap.classList.toggle('is-admin', want === 'admin');
          var ic = wrap.querySelector('.au__roleic');
          if(ic) ic.innerHTML = roleIcon(want);
        }
      })
      .catch(function(){ sel.disabled = false; sel.value = was; window.alert('Could not change role.'); });
  });
  host.addEventListener('click', function(e){
    // The role select lives inside the row; clicking it must not also open the menu.
    if(e.target.closest && e.target.closest('[data-role-for]')) return;
    var tr = e.target.closest ? e.target.closest('tr.au') : null;
    if(tr) openMenu(tr);
  });
  host.addEventListener('keydown', function(e){
    if(e.key !== 'Enter' && e.key !== ' ') return;
    var tr = e.target.closest ? e.target.closest('tr.au') : null;
    if(tr){ e.preventDefault(); openMenu(tr); }
  });
  document.addEventListener('click', function(e){
    if(menu && !menu.hidden && !menu.contains(e.target) && !(e.target.closest && e.target.closest('tr.au'))) closeMenu();
  });
  document.addEventListener('keydown', function(e){ if(e.key === 'Escape'){ closeMenu(); if(invite) invite.hidden = true; } });

  if(menu){
    var rolesel = menu.querySelector('[data-menu-role]');
    if(rolesel) rolesel.addEventListener('change', function(){
      var who = current, want = rolesel.value, was = roleOf(who);
      if(!who || want === was) return;
      // Demoting yourself is the one change that can lock you out of this panel, so it
      // is the one that asks. The server refuses the LAST admin outright either way.
      var warn = (was === 'admin')
        ? 'Remove admin from ' + who + '?\\n\\nThey lose the Admin panel and any all-space publish token.'
        : (want === 'viewer'
          ? 'Make ' + who + ' a viewer?\\n\\nThey can still sign in, comment and use boards, but cannot publish. Any publish token they hold stops working.'
          : 'Make ' + who + ' an ' + roleLabel(want).toLowerCase() + '?');
      if(!window.confirm(warn)){ rolesel.value = was; return; }
      closeMenu();
      post({ op:'role', email: who, role: want }).then(function(d){
        if(d && d.ok) load();
        else window.alert(d && d.error === 'last-admin'
          ? (d.message || 'This is the only admin.')
          : 'Could not change role: ' + ((d && d.error) || 'error'));
      }).catch(function(){ window.alert('Could not change role.'); });
    });
    menu.querySelector('[data-menu-reset]').addEventListener('click', function(){
      var who = current;
      if(!who) return;
      closeMenu();
      if(!window.confirm('Reset ' + who + '?\\n\\nTheir password stops working immediately. Send them the link that appears.')) return;
      post({ op:'reset', email: who }).then(function(d){
        if(d && d.ok && d.url){ showLink(who, d.url); load(); }
        else window.alert('Could not reset: ' + ((d && d.error) || 'error'));
      }).catch(function(){ window.alert('Could not reset.'); });
    });
    menu.querySelector('[data-menu-remove]').addEventListener('click', function(){
      var who = current;
      if(!who) return;
      closeMenu();
      if(!window.confirm('Remove ' + who + '?\\n\\nThey lose access immediately and any invite link they hold stops working.')) return;
      post({ op:'remove', email: who }).then(function(d){
        if(d && d.ok) load();
        else window.alert('Could not remove: ' + ((d && d.error) || 'error'));
      }).catch(function(){ window.alert('Could not remove.'); });
    });
  }

  // ── Invite ─────────────────────────────────────────────────────────────────
  var openBtn = document.querySelector('[data-invite-open]');
  if(openBtn && invite){
    openBtn.addEventListener('click', function(){
      invite.hidden = !invite.hidden;
      if(!invite.hidden) invite.querySelector('[data-invite-email]').focus();
    });
    invite.querySelector('[data-invite-cancel]').addEventListener('click', function(){ invite.hidden = true; });
    invite.addEventListener('submit', function(e){
      e.preventDefault();
      var email = invite.querySelector('[data-invite-email]').value.trim();
      var name = invite.querySelector('[data-invite-name]').value.trim();
      var role = invite.querySelector('[data-invite-role]').value;
      var msg = invite.querySelector('[data-invite-msg]');
      if(!email) return;
      msg.textContent = '…';
      post({ op:'invite', email: email, name: name, role: role }).then(function(d){
        if(d && d.ok && d.url){
          msg.textContent = '';
          invite.reset(); invite.hidden = true;
          showLink(d.email, d.url);
          load();
        } else {
          msg.textContent = d && d.error === 'already-a-user' ? 'already on the list'
            : d && d.error === 'bad-email' ? 'not a valid address'
            : (d && d.error) || 'error';
        }
      }).catch(function(){ msg.textContent = 'error'; });
    });
  }

  // ── Copy the link ──────────────────────────────────────────────────────────
  if(linkbox){
    linkbox.querySelector('[data-link-copy]').addEventListener('click', function(){
      var input = linkbox.querySelector('[data-link-url]');
      input.select();
      try { document.execCommand('copy'); linkbox.querySelector('[data-link-msg]').textContent = 'copied'; }
      catch(e){ linkbox.querySelector('[data-link-msg]').textContent = 'copy it manually'; }
    });
    linkbox.querySelector('[data-link-close]').addEventListener('click', function(){ linkbox.hidden = true; });
  }

  // Sortable headers — last active, newest first, is the default view.
  var ths = document.querySelectorAll('[data-sort]');
  for(var i=0;i<ths.length;i++){ (function(th){
    th.addEventListener('click', function(){
      var k = th.getAttribute('data-sort');
      if(k === sortKey) sortDir = -sortDir;
      else { sortKey = k; sortDir = k === 'name' ? 1 : -1; }
      render();
    });
  })(ths[i]); }

  load();
})();
`;

// The admin page: editable per-user passwords. Server-gated to admins (worker guards
// the /admin/ route + the /__admin API); the page just renders what the API returns.
// Branded 404 written to dist/404.html. KEEP IN SYNC with notFoundPage() in
// src/_worker.js — same shell language (near-white canvas, indigo accent, Inter, the
// Augur mark) so a direct hit on 404.html and a worker-wrapped 404 look identical.
function renderNotFoundPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="robots" content="noindex, nofollow" />
  <title>Not found · Augur</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" />
  <style>
    :root {
      --bg: #fbfbfd; --card: #ffffff; --fg: #16171a; --muted: #5b626e; --faint: #9aa0ab;
      --line: rgba(16,17,26,0.09); --line-2: rgba(16,17,26,0.15);
      --accent: #2c2150; --accent-solid: #2c2150;
      color-scheme: light;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; min-height: 100dvh; display: grid; place-items: center; padding: 24px;
      font: 15px/1.55 "Inter", "Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      letter-spacing: -0.011em; background: var(--bg); color: var(--fg);
      -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
    }
    .card {
      background: var(--card); border: 1px solid var(--line); border-radius: 14px;
      padding: 34px 32px 30px; max-width: 380px; width: 100%; text-align: center;
      box-shadow: 0 1px 2px rgba(16,24,40,0.05), 0 10px 28px -22px rgba(16,24,40,0.22);
    }
    .logo { display: flex; justify-content: center; margin: 2px 0 20px; }
    .logo svg { width: 40px; height: 40px; display: block; }
    .code { font-size: 13px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--faint); margin: 0 0 6px; }
    h1 { font-size: 19px; font-weight: 600; margin: 0 0 8px; }
    p { font-size: 14px; color: var(--muted); margin: 0 0 22px; }
    a.home {
      display: inline-block; font-weight: 600; font-size: 14px; color: #fff;
      background: var(--accent-solid); border-radius: 9px; padding: 9px 18px;
      text-decoration: none; transition: background .12s ease;
    }
    a.home:hover { background: #38295e; }
    a.home:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    @media (max-width: 420px) { .card { padding: 28px 22px; } }
    @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
  </style>
</head>
<body>
  <main class="card">
    <div class="logo">
      <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Augur">
        <g transform="translate(153.5 153.5) scale(1.115)" fill="#2C2150" fill-rule="evenodd"><path d="M303.668 0.501099C480.9 -9.31876 632.543 126.378 642.396 303.609C652.249 480.839 516.579 632.508 339.35 642.392C162.076 652.279 10.36 516.567 0.504883 339.291C-9.34912 162.015 126.39 10.3241 303.668 0.501099ZM321.31 58.589C313.993 78.2949 309.682 91.0001 300.003 110.42C256.894 196.544 185.761 265.436 98.3008 305.765C84.5568 312.054 73.3451 316.365 59.0391 321.205C166.492 358.562 254.54 437.345 303.567 540.001C306.201 545.441 320.11 580.712 320.888 581.447C329.254 559.649 338.869 536.27 350.55 515.916C397.544 434.024 469.471 370.244 555.57 331.86C563.577 328.29 574.85 323.736 583.145 321.47C472.786 278.754 383.1 203.746 334.938 93.8761C332.878 89.1732 321.885 59.2127 321.31 58.589Z"/></g>
      </svg>
    </div>
    <p class="code">404</p>
    <h1>Page not found</h1>
    <p>This URL doesn't match any page, prototype, or asset.</p>
    <a class="home" href="/">Back to Augur</a>
  </main>
</body>
</html>`;
}

// Section switching + the Settings readouts. Kept out of ADMIN_JS because that script
// is about PEOPLE — this one is about the page they sit on.
//
// The storage gauge and engine version used to live wedged in the rail foot, revealed
// by html.gv-admin on every page. They belong in one workspace's Settings, which is
// also the only place their scope reads correctly.
const ADMIN_SECTIONS_JS = `(function(){
  var nav = document.querySelector('[data-admin-nav]');
  if(!nav) return;
  var space = new URLSearchParams(location.search).get('space') || '';

  // Name the workspace in the nav, and point "back" at it rather than always at "/".
  fetch('/__me', {headers:{'Accept':'application/json'}}).then(function(r){
    return r.ok ? r.json() : null;
  }).then(function(d){
    var mine = (d && d.spaces) || [];
    var here = null;
    for(var i=0;i<mine.length;i++){ if(mine[i].id === space) here = mine[i]; }
    if(!here && mine.length === 1) here = mine[0];
    if(!here) return;
    space = here.id; // so the icon API always names a real workspace
    var label = document.querySelector('[data-admin-space-name]');
    if(label) label.textContent = here.name;
    var back = document.querySelector('[data-admin-back]');
    if(back) back.setAttribute('href', (here.base || '') + '/');
    // Settings shows the same name, and the icon it currently has.
    var nameEl = document.querySelector('[data-set-name]');
    if(nameEl) nameEl.value = here.name || '';
    if(here.icon){
      var i2 = document.querySelector('[data-set-icon-img]');
      if(i2) i2.src = here.icon;
      var c2 = document.querySelector('[data-set-icon-clear]');
      if(c2) c2.hidden = false;
    }
  }).catch(function(){});

  // Sections are plain show/hide — three small panels, no routing worth the name.
  // The hash keeps a reload (and a browser back) on the section you were reading.
  function show(name){
    // Document-wide, not nav-scoped: the mobile Admin sub-bar (tabBar()) renders its
    // three buttons in the bottom tab bar, outside adminRail()'s [data-admin-nav] —
    // same data-admin-tab attribute/values, so one query now reaches both.
    var tabs = document.querySelectorAll('[data-admin-tab]');
    tabs.forEach(function(t){
      var on = t.getAttribute('data-admin-tab') === name;
      t.classList.toggle('is-on', on);
      if(on) t.setAttribute('aria-current','page'); else t.removeAttribute('aria-current');
    });
    document.querySelectorAll('[data-admin-sec]').forEach(function(s){
      s.hidden = s.getAttribute('data-admin-sec') !== name;
    });
  }
  document.querySelectorAll('[data-admin-tab]').forEach(function(t){
    t.addEventListener('click', function(){
      var name = t.getAttribute('data-admin-tab');
      show(name);
      history.replaceState(null, '', location.pathname + location.search + '#' + name);
    });
  });
  var want = (location.hash || '').replace('#','');
  show(want && document.querySelector('[data-admin-sec="'+want+'"]') ? want : 'people');

  // Storage — the same /__admin/storage the rail foot used to read.
  var sEl = document.querySelector('[data-set-storage]');
  var sBar = document.querySelector('[data-set-storage-bar]');
  if(sEl){
    fetch('/__admin/storage', {headers:{'Accept':'application/json'}}).then(function(r){
      return r.ok ? r.json() : null;
    }).then(function(d){
      // No bar without a number to put in it — an empty track reads as "0 used".
      function hideBar(){ var g = sBar && sBar.parentNode; if(g) g.style.display = 'none'; }
      if(!d || d.enabled === false){ sEl.textContent = 'Not in use on this instance.'; hideBar(); return; }
      if(d.error){ sEl.textContent = 'Unavailable.'; hideBar(); return; }
      var gb = function(b){ return (b/1073741824).toFixed(2) + ' GB'; };
      var pct = typeof d.pct === 'number' ? d.pct
        : (d.limitBytes ? (d.bytes / d.limitBytes) * 100 : 0);
      if(sBar) sBar.style.width = Math.min(100, pct).toFixed(1) + '%';
      sEl.textContent = gb(d.bytes) + (d.limitBytes ? ' of ' + gb(d.limitBytes) : '')
        + ' used' + (d.objects != null ? ' · ' + d.objects + ' objects' : '');
    }).catch(function(){ sEl.textContent = 'Unavailable.'; });
  }

  // Engine version + the update nudge.
  var vEl = document.querySelector('[data-set-version]');
  if(vEl){
    fetch('/__admin/version', {headers:{'Accept':'application/json'}}).then(function(r){
      return r.ok ? r.json() : null;
    }).then(function(d){
      if(!d){ vEl.textContent = 'Unavailable.'; return; }
      vEl.textContent = (d.current ? d.current : 'unknown')
        + (d.latest && d.latest !== d.current ? ' — ' + d.latest + ' available' : ' — up to date');
    }).catch(function(){ vEl.textContent = 'Unavailable.'; });
  }

  // The address this workspace is actually served at, so the disabled Custom URL field
  // says something true rather than sitting empty next to a promise.
  var oEl = document.querySelector('[data-set-origin]');
  if(oEl) oEl.textContent = location.host;

  // ---- workspace icon ------------------------------------------------------
  // Same bargain as a profile photo: the workspace repo's /space-icon.png is the seed,
  // this overrides it, removing restores it. Downscaled to 256px before posting so the
  // stored data URI stays small — the rail draws it at 20px, settings at 56px.
  var pick = document.querySelector('[data-set-icon-pick]');
  var file = document.querySelector('[data-set-icon-file]');
  var img  = document.querySelector('[data-set-icon-img]');
  var clr  = document.querySelector('[data-set-icon-clear]');
  var msg  = document.querySelector('[data-set-icon-msg]');
  function say(t){ if(msg) msg.textContent = t || ''; }
  function send(method, body){
    return fetch('/__admin/space-icon', {
      method: method, headers: {'Content-Type':'application/json'},
      body: JSON.stringify(Object.assign({space: space}, body || {})),
    }).then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d}; }); });
  }
  if(pick && file){
    pick.addEventListener('click', function(){ file.click(); });
    file.addEventListener('change', function(){
      var f = file.files && file.files[0];
      if(!f) return;
      say('Uploading…');
      var fr = new FileReader();
      fr.onload = function(){
        var im = new Image();
        im.onload = function(){
          // Square-crop from the centre, then draw at 256 — a rectangular source would
          // otherwise stretch, and object-fit only fixes the display, not the bytes.
          var side = Math.min(im.width, im.height), S = 256;
          var c = document.createElement('canvas'); c.width = S; c.height = S;
          c.getContext('2d').drawImage(im, (im.width-side)/2, (im.height-side)/2, side, side, 0, 0, S, S);
          var q = 0.9, uri = c.toDataURL('image/jpeg', q);
          while(uri.length > 60000 && q > 0.4){ q -= 0.1; uri = c.toDataURL('image/jpeg', q); }
          send('POST', {icon: uri}).then(function(res){
            if(!res.ok){ say((res.d && res.d.error) || 'Upload failed'); return; }
            if(img) img.src = res.d.icon;
            var rail = document.querySelector('[data-space-icon]');
            if(rail) rail.src = res.d.icon;
            if(clr) clr.hidden = false;
            say('Saved');
          }).catch(function(){ say('Upload failed'); });
        };
        im.onerror = function(){ say('That file is not an image'); };
        im.src = fr.result;
      };
      fr.readAsDataURL(f);
      file.value = '';
    });
  }
  if(clr){
    clr.addEventListener('click', function(){
      say('Removing…');
      send('DELETE').then(function(res){
        if(!res.ok){ say((res.d && res.d.error) || 'Could not remove'); return; }
        if(img) img.src = '/space-icon.png';
        var rail = document.querySelector('[data-space-icon]');
        if(rail) rail.src = '/space-icon.png';
        clr.hidden = true;
        say('Removed');
      }).catch(function(){ say('Could not remove'); });
    });
  }
})();
`;

function renderAdminPage() {
  const body = `<style>
    /* People table — name + email, role, last active (the default sort, newest first).
       Row click opens the per-person menu; everything credential-related ends in a link. */
    .folderbar{ max-width:820px; } /* so the Invite button lands on the table's right edge */
    /* Workspace admin: a left nav beside the sections, the shape Figma's admin uses.
       The nav is what makes the scope legible — you are administering ONE workspace,
       named at the top, with a way back to it. */
    .auwrap{ display:block; }
    .aumain{ min-width:0; }
    .auset__row{ max-width:560px; margin:0 0 30px; }
    .auset__label{ display:block; margin:0 0 7px; font-size:13px; font-weight:600; color:#16171a; }
    .auset__row input{ width:100%; padding:8px 11px; border:1px solid rgba(16,17,26,0.16);
                       border-radius:8px; font:inherit; font-size:13.5px; background:#fff; }
    .auset__row input:disabled{ background:rgba(16,17,26,0.03); color:#9aa0ab; cursor:not-allowed; }
    .auset__note{ margin:7px 0 0; font-size:12.5px; line-height:1.5; color:#5b626e; }
    .auset__gauge{ height:6px; border-radius:999px; background:rgba(16,17,26,0.08); overflow:hidden; }
    .auset__gauge span{ display:block; height:100%; width:0; border-radius:999px; background:#4f46e5; }
    .auset__icon{ display:flex; align-items:center; gap:16px; }
    .auset__iconimg{ flex:none; width:56px; height:56px; border-radius:12px; overflow:hidden;
                     display:grid; place-items:center; background:#fff;
                     border:1px solid rgba(16,17,26,0.10); }
    .auset__iconimg img{ width:100%; height:100%; object-fit:cover; display:block; }
    .auset__iconacts{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
    .auset__msg{ font-size:12.5px; color:#5b626e; }
    .autbl{ width:100%; max-width:820px; border-collapse:collapse; }
    .autbl th{ text-align:left; padding:0 12px 9px; font-size:12px; font-weight:600; color:#5b626e;
               border-bottom:1px solid rgba(16,17,26,0.10); cursor:pointer; user-select:none; white-space:nowrap; }
    .autbl th:hover{ color:#16171a; }
    .autbl th::after{ content:''; display:inline-block; width:11px; margin-left:5px; color:#9aa0ab; }
    .autbl th[aria-sort=ascending]::after{ content:'\\2191'; }
    .autbl th[aria-sort=descending]::after{ content:'\\2193'; }
    .autbl td{ padding:11px 12px; border-bottom:1px solid rgba(16,17,26,0.07); vertical-align:middle; }
    .autbl td.empty{ color:#5b626e; font-size:13.5px; padding:18px 12px; }
    tr.au{ cursor:pointer; }
    tr.au:hover td, tr.au:focus-visible td{ background:rgba(16,17,26,0.028); }
    tr.au:focus-visible{ outline:2px solid #5e6ad2; outline-offset:-2px; }
    .au__who{ display:flex; align-items:center; gap:11px; }
    .au__av{ flex:none; width:32px; height:32px; border-radius:50%; display:grid; place-items:center;
             color:#fff; font-weight:700; font-size:11.5px; text-transform:uppercase; }
    .au__id{ display:flex; flex-direction:column; min-width:0; }
    .au__name{ font-weight:600; font-size:14px; color:#16171a; }
    .au__email{ font-size:12.5px; color:#5b626e; }
    .au__role{ font-size:13.5px; color:#5b626e; white-space:nowrap; }
    /* Role as icon + select. The icon sits UNDER the select rather than beside it so
       the whole cell is one target; the select is transparent and sized to its text. */
    .au__rolewrap{ display:inline-flex; align-items:center; gap:8px; border-radius:7px;
                   padding:3px 4px 3px 6px; }
    .au__rolewrap:hover{ background:rgba(16,17,26,0.05); }
    .au__roleic{ display:grid; place-items:center; width:24px; height:24px; flex:none;
                 border-radius:6px; background:rgba(16,17,26,0.05); color:#5b626e; }
    .au__roleic .gvic{ width:14px; height:14px; }
    .au__rolewrap.is-admin .au__roleic{ background:#eef2ff; color:#4f46e5; }
    .au__rolesel{ appearance:none; -webkit-appearance:none; border:0; background:transparent;
                  font:inherit; font-size:13.5px; color:#5b626e; cursor:pointer; padding:2px 16px 2px 0;
                  background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%239aa0ab' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='m6 9 6 6 6-6'/></svg>");
                  background-repeat:no-repeat; background-position:right 0 center; background-size:13px; }
    .au__rolewrap.is-admin .au__rolesel{ color:#4f46e5; font-weight:600; }
    .au__rolesel:focus-visible{ outline:2px solid #5e6ad2; outline-offset:2px; border-radius:4px; }
    .au__rolesel:disabled{ cursor:default; background-image:none; padding-right:0; opacity:.75; }
    .au__last{ white-space:nowrap; }
    .au__seen{ font-size:13.5px; color:#5b626e; }
    .au__seen--never{ color:#9aa0ab; }
    .au__chip{ font-size:12px; padding:2px 8px; border-radius:999px; background:#fef3c7; color:#92400e; white-space:nowrap; }
    .au__go{ width:24px; text-align:right; color:#9aa0ab; font-size:17px; }

    /* Buttons shared by the header action, the invite form and the link strip. */
    .aubtn{ font:inherit; font-size:13px; font-weight:500; padding:6px 12px; border-radius:8px;
            border:1px solid rgba(16,17,26,0.14); background:#fff; color:#16171a; cursor:pointer; white-space:nowrap; }
    .aubtn:hover{ background:rgba(16,17,26,0.04); }
    .aubtn--primary{ background:#2c2150; border-color:#2c2150; color:#fff; font-weight:600; }
    .aubtn--primary:hover{ background:#38295e; }

    .auinvite{ display:flex; flex-wrap:wrap; align-items:center; gap:8px; max-width:820px; margin:0 0 16px;
               padding:12px; border:1px solid rgba(16,17,26,0.10); border-radius:12px; background:#fff; }
    .auinvite[hidden]{ display:none; }
    .auinvite input, .auinvite select{ font:inherit; font-size:13px; padding:7px 10px; border-radius:8px;
                                       border:1px solid rgba(16,17,26,0.16); background:#fff; color:#16171a; }
    .auinvite input[type=email]{ flex:2 1 220px; }
    .auinvite input[type=text]{ flex:1 1 150px; }
    .auinvite__msg{ font-size:12px; color:#b45309; }

    .aulink{ display:flex; align-items:center; gap:9px; flex-wrap:wrap; max-width:820px; margin:0 0 16px;
             padding:12px; border:1px solid rgba(79,70,229,0.28); border-radius:12px; background:rgba(79,70,229,0.05); }
    .aulink[hidden]{ display:none; }
    .aulink__hd{ flex:1 1 100%; margin:0; font-size:13px; color:#2c2f36; }
    .aulink__hd b{ font-weight:600; }
    .aulink input{ flex:1 1 320px; font:12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
                   padding:7px 9px; border-radius:8px; border:1px solid rgba(16,17,26,0.16); background:#fff; }
    .aulink__msg{ font-size:12px; color:#5b626e; min-width:44px; }

    /* Row menu — fixed so it can never be clipped by the table's own overflow. */
    .aumenu{ position:fixed; z-index:60; min-width:190px; padding:5px; border-radius:10px; background:#fff;
             border:1px solid rgba(16,17,26,0.12); box-shadow:0 1px 2px rgba(16,24,40,0.05), 0 12px 30px -16px rgba(16,24,40,0.30); }
    .aumenu[hidden]{ display:none; }
    .aumenu__hd{ margin:0; padding:5px 9px 7px; font-size:11.5px; color:#9aa0ab;
                 overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:240px; }
    .aumenu__role{ display:flex; align-items:center; justify-content:space-between; gap:10px;
                   padding:4px 9px 8px; margin-bottom:4px; border-bottom:1px solid rgba(16,17,26,0.08); }
    .aumenu__role span{ font-size:13px; color:#16171a; }
    .aumenu__role select{ font:inherit; font-size:13px; padding:3px 6px; border-radius:6px;
                          border:1px solid rgba(16,17,26,0.18); background:#fff; color:#16171a; cursor:pointer; }
    .aumenu button{ display:block; width:100%; padding:7px 9px; border:0; border-radius:7px; background:none;
                    font:inherit; font-size:13px; color:#16171a; text-align:left; cursor:pointer; }
    .aumenu button:hover{ background:rgba(16,17,26,0.05); }
    .aumenu button.is-danger{ color:#b42318; }
    .aumenu button.is-danger:hover{ background:rgba(180,35,24,0.07); }

    @media (max-width:640px){ .autbl .au__role{ display:none; } .autbl th[data-sort=role]{ display:none; } }

    /* Live content — the published state of each space. Same table language as the
       people list; the only loud thing is the working-tree chip, which is the one
       state that can't be reproduced from any repository. */
    .aulive__bar{ margin-top:40px; }
    .aulive__hint{ max-width:820px; margin:0 0 16px; font-size:13.5px; line-height:1.55; color:#5b626e; }
    .aulive__id{ font-weight:600; font-size:14px; color:#16171a; }
    .aulive__v{ font:12.5px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color:#5b626e; }
    .aulive__when{ font-size:13.5px; color:#16171a; white-space:nowrap; }
    .aulive__by{ font-size:12.5px; color:#5b626e; }
    .aulive__sha{ font:12.5px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color:#5b626e; }
    .aulive__dirty{ display:inline-block; margin-left:8px; font-size:12px; padding:2px 8px; border-radius:999px;
                    background:#fee2e2; color:#b42318; font-weight:600; white-space:nowrap; }
  </style>
  ${adminSections()}
  <script>${ADMIN_JS}</script>
  <script>${LIVE_CONTENT_JS}</script>
  <script>${ADMIN_SECTIONS_JS}</script>`;
  return shell({ title: "Admin · Augur", activeTab: "admin", body });
}

// The workspace admin surface: one space's People, Content and Settings behind a left
// nav. It is one space's, not the instance's — which is the whole point of the cog that
// opens it. ADMIN_JS reads ?space= to know which, and asks /__admin/users for that
// space's members; the worker re-checks that the caller administers it.
function adminSections() {
  // No nav here — adminRail() IS the navigation (see appChrome). This is only the
  // sections it switches between.
  return `<div class="auwrap">
    <div class="aumain">

    <section data-admin-sec="people">
  <header class="folderbar">
    <h1 class="folderbar__title">People</h1>
    <span class="folderbar__rule"></span>
    <button type="button" class="aubtn aubtn--primary" data-invite-open>Invite</button>
  </header>

  <form class="auinvite" data-invite hidden>
    <input type="email" data-invite-email placeholder="name@example.org" aria-label="Email address" required />
    <input type="text" data-invite-name placeholder="Name (optional)" aria-label="Name" />
    <select data-invite-role aria-label="Role"><option value="editor">Editor</option><option value="viewer">Viewer</option><option value="admin">Admin</option></select>
    <button type="submit" class="aubtn aubtn--primary">Create link</button>
    <button type="button" class="aubtn" data-invite-cancel>Cancel</button>
    <span class="auinvite__msg" data-invite-msg aria-live="polite"></span>
  </form>

  <div class="aulink" data-link hidden>
    <p class="aulink__hd">Single-use link for <b data-link-who></b> — send it to them yourself.</p>
    <input type="text" data-link-url readonly aria-label="Invite link" />
    <button type="button" class="aubtn" data-link-copy>Copy</button>
    <button type="button" class="aubtn" data-link-close>Done</button>
    <span class="aulink__msg" data-link-msg aria-live="polite"></span>
  </div>

  <table class="autbl">
    <thead><tr>
      <th data-sort="name" aria-sort="none">Name</th>
      <th data-sort="role" aria-sort="none">Role</th>
      <th data-sort="seen" aria-sort="descending">Last active</th>
      <th aria-hidden="true"></th>
    </tr></thead>
    <tbody data-admin-users><tr><td colspan="4" class="empty">Loading…</td></tr></tbody>
  </table>

  <div class="aumenu" data-menu hidden role="menu">
    <p class="aumenu__hd" data-menu-who></p>
    <label class="aumenu__role"><span>Role</span>
      <select data-menu-role aria-label="Change role"><option value="admin">Admin</option><option value="editor">Editor</option><option value="viewer">Viewer</option></select>
    </label>
    <button type="button" role="menuitem" data-menu-reset>Reset password</button>
    <button type="button" role="menuitem" class="is-danger" data-menu-remove>Remove user</button>
  </div>

    </section>

    <section data-admin-sec="content" hidden>
  <header class="folderbar">
    <h1 class="folderbar__title">Content</h1>
    <span class="folderbar__rule"></span>
  </header>
  <p class="aulive__hint">What this workspace is serving right now. Content
    reaches production only by publishing — a redeploy ships chrome and worker code,
    never this — so this table is the whole answer to “is my work live?”.</p>
  <table class="autbl">
    <thead><tr>
      <th>Space</th><th>Version</th><th>Published</th><th>Built from</th>
    </tr></thead>
    <tbody data-live-content><tr><td colspan="4" class="empty">Loading…</td></tr></tbody>
  </table>
    </section>

    <section data-admin-sec="settings" hidden>
  <header class="folderbar">
    <h1 class="folderbar__title">Settings</h1>
    <span class="folderbar__rule"></span>
  </header>

  <div class="auset__row">
    <label class="auset__label">Workspace icon</label>
    <div class="auset__icon">
      <span class="auset__iconimg"><img src="/space-icon.png" alt="" width="56" height="56" data-set-icon-img /></span>
      <div class="auset__iconacts">
        <button type="button" class="aubtn" data-set-icon-pick>Upload image</button>
        <button type="button" class="aubtn" data-set-icon-clear hidden>Remove</button>
        <input type="file" accept="image/png,image/jpeg,image/webp" hidden data-set-icon-file />
        <span class="auset__msg" data-set-icon-msg aria-live="polite"></span>
      </div>
    </div>
    <p class="auset__note">Shown next to the workspace name in the sidebar. Square
      images work best. Removing it restores the one this workspace ships.</p>
  </div>

  <div class="auset__row">
    <label class="auset__label">Workspace name</label>
    <input type="text" data-set-name value="" disabled />
    <p class="auset__note">Set in this workspace's <code>space.json</code>. Changing it
      is a commit, not a click — the file stays the durable record.</p>
  </div>

  <div class="auset__row" data-custom-url>
    <label class="auset__label" for="auset-url">Custom URL</label>
    <input type="text" id="auset-url" data-set-url value="" placeholder="prototypes.yourdomain.com"
           disabled aria-describedby="auset-url-note" />
    <p class="auset__note" id="auset-url-note">Not available yet. This workspace is
      served at <b data-set-origin>its built-in address</b>.</p>
  </div>

  <div class="auset__row">
    <label class="auset__label">Storage</label>
    <div class="auset__gauge"><span data-set-storage-bar></span></div>
    <p class="auset__note" data-set-storage>Loading…</p>
  </div>

  <div class="auset__row">
    <label class="auset__label">Engine</label>
    <p class="auset__note" data-set-version>Loading…</p>
  </div>
    </section>

    </div>
  </div>`;
}

// Research chip disclosure — toggles the filename popover on the opportunity page.
// Self-contained; no-ops on pages with no .research-chip. Names are already in the
// (gated) HTML; this only shows/hides them.
const RESEARCH_JS = `(function(){
  function closeAll(except){
    [].forEach.call(document.querySelectorAll('.research-chip[aria-expanded="true"]'), function(b){
      if(b===except) return;
      b.setAttribute('aria-expanded','false');
      var p = b.parentNode.querySelector('.research-pop'); if(p) p.hidden = true;
    });
  }
  [].forEach.call(document.querySelectorAll('.research-chip'), function(btn){
    var pop = btn.parentNode.querySelector('.research-pop'); if(!pop) return;
    btn.addEventListener('click', function(e){
      e.stopPropagation();
      var open = btn.getAttribute('aria-expanded') === 'true';
      closeAll(btn);
      btn.setAttribute('aria-expanded', String(!open));
      pop.hidden = open;
    });
  });
  document.addEventListener('click', function(e){
    if(e.target.closest && e.target.closest('.research-wrap')) return;
    closeAll(null);
  });
  document.addEventListener('keydown', function(e){
    if((e.key||'').toLowerCase()==='escape') closeAll(null);
  });
})();`;

function shell({ title, body, back, activeTab = "prototypes", wrapClass = "" }) {
  const backLink = back
    ? `<a class="back" href="${back.href}">${back.label}</a>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="robots" content="noindex, nofollow" />
  <title>${title}</title>
  <link rel="icon" type="image/png" href="/augur-mark.png?v=${UI_VERSION}" />
  <link rel="apple-touch-icon" href="/augur-mark.png?v=${UI_VERSION}" />
  <link rel="manifest" href="/manifest.webmanifest" />
  <meta name="theme-color" content="#2C2150" />
  <link rel="preload" href="/fonts/inter-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin />
  <style>${FONT_CSS}${PAGE_CSS}${NAV_CSS}${TABBAR_CSS}${addon ? addon.css() : ""}
  </style>
</head>
<body>
  ${appChrome(activeTab)}
  <div class="wrap${wrapClass ? " " + wrapClass : ""}">
    ${backLink}
    ${body}
  </div>
  ${addon ? addon.cornerHtml() : ""}
  <script>${CAROUSEL_JS}
  </script>
  <script>${chromeScript()}
  </script>
  <script>${STATUS_JS}
  </script>
  <script>${COMP_STATUS_JS}
  </script>
  <script>${CARD_MENU_JS}
  </script>
  <script>${spaceContextScript()}
  </script>
  <script>${PINS_JS}
  </script>
  <script>${PROFILE_JS}
  </script>
  <script>${SETTINGS_JS}
  </script>
  <script>${NEWCANVAS_JS}
  </script>
  <script>${SPACE_JS}
  </script>
  <script>${TABBAR_JS()}
  </script>
  <script>${RESEARCH_JS}
  </script>
  <script>${FACE_JS}
  </script>
  ${addon ? addon.bodyScripts(UI_VERSION) : ""}
  ${SPECULATION_RULES}
</body>
</html>
`;
}

// The preview media for a card. Prefer a static, hyper-optimized WebP poster
// (one cached image, ~zero render cost) captured by `npm run shoot`; fall back to
// a live, scaled-down iframe (IntersectionObserver-gated) when a prototype has no
// poster yet. `href` is the folder href (ends with "/"), so the poster sits at
// `${href}preview.webp`.
function media(href, hasPoster) {
  return hasPoster
    ? `<img class="preview-img" src="${href}preview.webp" alt="" aria-hidden="true" loading="lazy" decoding="async" width="768" height="480" />`
    : `<iframe data-src="${href}" title="" aria-hidden="true" tabindex="-1" scrolling="no" sandbox="allow-scripts allow-same-origin"></iframe>`;
}

/** A preview tile (poster image, or live iframe fallback) wrapped for a card. */
function preview(href, hasPoster) {
  return `<div class="preview">${media(href, hasPoster)}</div>`;
}

function renderRootIndex(opportunities) {
  if (!opportunities.length) {
    return shell({
      title: "Augur",
      subtitle: "Private &mdash; do not share outside the team.",
      body: `<p class="empty">No prototypes yet. Add one under
       <code>&lt;folder&gt;/prototypes/&lt;name&gt;/</code> and rebuild.</p>`,
    });
  }

  const cards = opportunities
    .map((opp) => {
      const oppPath = `${encodeURIComponent(opp.name)}/`;
      // Cover = most-recent prototype of the opportunity (already sorted first).
      const cover = opp.prototypes[0];
      const coverSrc = cover ? `${oppPath}${cover.href}` : "";
      return `
        <div class="card-opp" data-fitem data-fkey="${titleCase(opp.name)}">
          <a class="card-cover-link" href="${oppPath}" aria-label="Open ${titleCase(opp.name)}"></a>
          ${preview(coverSrc, cover && cover.poster)}
          <div class="opp-meta">
            <div class="opp-name-row"><div class="proto-name">${titleCase(opp.name)}</div>${facePile(opp.people)}</div>
            <div class="proto-date">${plural(opp.prototypes.length, "prototype")} &middot; <span title="${fmtDate(opp.mtimeMs)}">${relTime(opp.mtimeMs)}</span></div>
          </div>
        </div>`;
    })
    .join("");

  // Nav (Playground + opportunities) now lives in the global left rail — the landing
  // page is just a single wide column of opportunity cards.
  const body = `
    <header class="folderbar"><h1 class="folderbar__title">${PROJECTS_LABEL}</h1><span class="folderbar__count">${opportunities.length}</span><span class="folderbar__rule"></span></header>
    <div data-fgroup>
      <div class="opp-grid">${cards}</div>
    </div>
    ${filterEmpty()}`;

  return shell({
    title: "Augur",
    wrapClass: "wrap--wide",
    body,
  });
}

// Clickable dev-status chip for a prototype card. Build-time state comes from
// prototype-status.json (the baseline); STATUS_JS overlays any live KV value and
// cycles it on click (Ignore → In progress → Dev ready → Ignore). Default is
// "ignore". Carries a text label, not colour alone (WCAG 1.4.1).
function statusChip(status, key) {
  const cur = STATUS_META[status] ? status : "ignore";
  const meta = STATUS_META[cur];
  const aria = `Status: ${meta.label}. Click to change.`;
  return `<button type="button" class="status-chip ${meta.cls}" data-status-key="${key}" data-status="${cur}" aria-label="${aria}" title="${aria}">${STATUS_ICONS[cur]}</button>`;
}

function renderOpportunityIndex(opp) {
  const cards = opp.prototypes
    .map((p) => {
      // Hidden trigger only — the visible download button was removed (it dominated
      // the card as a faux-primary action). Download now lives solely on the
      // right-click menu, which fires this element via dlBtn(c).click().
      const download = p.file
        ? `<button type="button" data-dl="${p.file}" data-dlname="${encodeURIComponent(p.name)}.html" aria-label="Download HTML" hidden></button>`
        : "";
      const pinKey = S(`/${encodeURIComponent(opp.name)}/${encodeURIComponent(p.name)}/`);
      const dname = protoName(p.name);
      return `
        <div class="card-proto" data-fitem data-fkey="${titleCase(p.name)}" data-rename-key="${SPACE_KEY}${opp.name}/${p.name}" data-default-name="${dname}" data-del-space="${NAV_STATE.activeSpace}" data-del-path="${opp.name}/prototypes/${p.name}">
          <div class="preview">
            ${media(p.href, p.poster)}
            <a class="preview-link" href="${p.href}" aria-label="Open ${titleCase(p.name)}"></a>
            <div class="preview-actions">
              ${download}
              ${pinStar(pinKey, pinKey)}
            </div>
            ${statusChip(p.status, SPACE_KEY + opp.name + "/" + p.name)}
          </div>
          <div class="proto-meta">
            <div class="proto-text">
              <div class="proto-name">${dname}</div>
              <div class="proto-date" title="${fmtDate(p.mtimeMs)}">${relTime(p.mtimeMs)}</div>
            </div>
            ${editorChip(p.editor)}
          </div>
        </div>`;
    })
    .join("");

  return shell({
    title: titleCase(opp.name),
    activeTab: opp.name,
    wrapClass: "wrap--wide",
    body: `<header class="folderbar"><a class="folderbar__up" href="${S("/")}" aria-label="All ${PROJECTS_LABEL.toLowerCase()}" title="All ${PROJECTS_LABEL.toLowerCase()}"><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></a><h1 class="folderbar__title">${titleCase(opp.name)}</h1><span class="folderbar__count">${opp.prototypes.length}</span><span class="folderbar__rule"></span>${researchChip(opp.research)}${newCanvasBtn(S(`/${opp.name}/`))}</header><div data-fgroup><div class="page-grid is-3up">${cards}</div></div>${filterEmpty()}`,
  });
}

function renderPlaygroundIndex(projects) {
  if (!projects.length) {
    return shell({
      title: "Playground",
      activeTab: "playground",
      body: `<p class="section-eyebrow">Playground 🛝</p>
        <p class="empty">No projects yet. Add one under
        <code>playground/&lt;project&gt;/</code> and rebuild.</p>`,
    });
  }

  // Folder cards — each project is a self-contained subfolder, same look as the
  // opportunity cards on the root so Playground reads as a sibling folder browser.
  const cards = projects
    .map((p) => {
      const folder = `${encodeURIComponent(p.name)}/`;
      const pinKey = S(`/playground/${encodeURIComponent(p.name)}/`);
      const dname = protoName(p.name);
      return `
        <div class="card-opp" data-fitem data-fkey="${titleCase(p.name)}" data-rename-key="${SPACE_KEY}playground/${p.name}" data-default-name="${dname}" data-del-space="${NAV_STATE.activeSpace}" data-del-path="playground/${p.name}">
          <a class="card-cover-link" href="${folder}" aria-label="Open ${titleCase(p.name)}"></a>
          <div class="preview">
            ${media(p.href, p.poster)}
            ${statusChip(p.status, SPACE_KEY + "playground/" + p.name)}
          </div>
          <div class="preview-actions">${pinStar(pinKey, pinKey)}</div>
          <div class="proto-meta">
            <div class="proto-text">
              <div class="proto-name">${dname}</div>
              <div class="proto-date" title="${fmtDate(p.mtimeMs)}">${relTime(p.mtimeMs)}</div>
            </div>
            ${editorChip(p.editor)}
          </div>
        </div>`;
    })
    .join("");

  return shell({
    title: "Playground",
    activeTab: "playground",
    wrapClass: "wrap--wide",
    body: `<header class="folderbar"><h1 class="folderbar__title">Playground</h1><span class="folderbar__count">${projects.length}</span><span class="folderbar__rule"></span>${newCanvasBtn(S("/playground/"))}</header><div data-fgroup><div class="opp-grid">${cards}</div></div>${filterEmpty()}`,
  });
}

function renderPagesIndex(pages) {
  if (!pages.length) {
    return shell({
      title: "Pages",
      subtitle: `Composed ${SPACE_NAME} reference pages &mdash; copy one as a starting point.`,
      activeTab: "pages",
      wrapClass: "wrap--wide",
      body: `<p class="empty">No reference pages yet. Add one under
        <code>pages/&lt;name&gt;/</code> and rebuild.</p>`,
    });
  }

  // Pages are a designer reference — Open only, no HTML download.
  const pageCard = (p) => `
        <div class="card-proto" data-fitem data-fkey="${titleCase(p.name)}" data-rename-key="${SPACE_KEY}pages/${p.name}" data-default-name="${titleCase(p.name)}">
          <div class="preview">
            ${media(p.href, p.poster)}
            <a class="preview-link" href="${p.href}" aria-label="Open ${titleCase(p.name)}"></a>
          </div>
          <div class="proto-meta">
            <div class="proto-name">${titleCase(p.name)}</div>
          </div>
        </div>`;

  // Split by surface into collapsible groups: Front office (city-themed
  // shells), Methods (participation-method runners), Back office (product-themed),
  // Upsells (locked-feature promo screens, tagged gv-surface="upsell" — grouped
  // separately to track how upsells are done across the product).
  // Superseded reference pages — kept available but grouped under a collapsed
  // "Legacy" section at the bottom. bo-project-phase is the old Project Editor,
  // superseded by the new editor (parallel-editor-builder-v3, being progressed to
  // canonical). Add a slug here to retire a page from the main groups.
  const LEGACY_PAGES = new Set(["bo-project-phase"]);
  const isLegacy = (p) => LEGACY_PAGES.has(p.name);
  const front = pages.filter((p) => p.surface === "front-office" && !isLegacy(p));
  const methods = pages.filter((p) => p.surface === "method" && !isLegacy(p));
  const back = pages.filter((p) => p.surface === "back-office" && !isLegacy(p));
  const upsells = pages.filter((p) => p.surface === "upsell" && !isLegacy(p));
  const legacy = pages.filter(isLegacy);
  // A collapsible section: <details> with the eyebrow as its <summary>. Filtering
  // (chromeScript) force-opens sections with matches, so search still reaches
  // collapsed cards. Legacy starts collapsed.
  const group = (label, inner, count, open = true) => `
        <details class="fsection" data-fgroup${open ? " open" : ""}>
          <summary class="section-eyebrow"><span class="fsection__caret" aria-hidden="true"></span>${label}${count == null ? "" : ` &middot; ${count}`}</summary>
          <div class="page-grid">${inner}</div>
        </details>`;
  const built = [
    ["Front office", front],
    ["Methods", methods],
    ["Back office", back],
    ["Upsells", upsells],
    ["Legacy", legacy],
  ].filter(([, list]) => list.length);
  // Two or more surfaces present → grouped; otherwise a single ungrouped list.
  const cards =
    built.length > 1
      ? built.map(([label, list]) => group(label, list.map(pageCard).join(""), list.length, label !== "Legacy")).join("")
      : `<section data-fgroup><p class="section-eyebrow">Composed reference screens</p><div class="page-grid">${pages.map(pageCard).join("")}</div></section>`;

  // Planned reference pages not built yet — shown as a roadmap of pending work.
  const builtSlugs = new Set(pages.map((p) => p.name));
  const pending = PENDING_PAGES.filter((s) => !builtSlugs.has(s))
    .map(
      (slug) => `
        <div class="card-proto is-pending" data-fitem data-fkey="${titleCase(slug)}" aria-label="${titleCase(slug)} — pending">
          <div class="preview preview--pending"><span class="pending-glyph" aria-hidden="true">◴</span></div>
          <div class="proto-meta">
            <div class="proto-name">${titleCase(slug)}</div>
            <span class="pending-badge">Pending</span>
          </div>
        </div>`
    )
    .join("");

  const pendingCount = PENDING_PAGES.filter((s) => !builtSlugs.has(s)).length;
  const pendingSection = pending
    ? group(`Pending &middot; ${pendingCount} planned`, pending, null)
    : "";

  return shell({
    title: "Pages",
    activeTab: "pages",
    wrapClass: "wrap--wide",
    body: `<header class="folderbar"><h1 class="folderbar__title">Pages</h1><span class="folderbar__count">${pages.length}</span><span class="folderbar__rule"></span></header>${cards}${pendingSection}${filterEmpty()}`,
  });
}

const SURFACE_LABEL = { fo: "Front office", bo: "Back office", cross: "Cross-surface" };
// Render the surface / category / status pills shown under a component's name on the
// Components page. `status` carries the cleanup signal — "review" is styled loud.
function metaBadges(meta) {
  const layer = meta.layer
    ? `<span class="cbadge cbadge--layer-${meta.layer}">${meta.layer}</span>`
    : "";
  const surf = `<span class="cbadge cbadge--surf-${meta.surface}">${SURFACE_LABEL[meta.surface] || meta.surface}</span>`;
  const cat = `<span class="cbadge cbadge--cat">${meta.category}</span>`;
  const stat = `<span class="cbadge cbadge--st-${meta.status}">${meta.status}</span>`;
  return `<div class="comp-badges">${layer}${surf}${cat}${stat}</div>`;
}

function renderComponentsIndex(components) {
  const subtitle =
    "Reusable building blocks &mdash; primitives composed into navbar, footer, cards, hero. They assemble into Pages.";
  if (!components.length) {
    return shell({
      title: "Components",
      subtitle,
      activeTab: "components",
      wrapClass: "wrap--wide",
      body: `<p class="empty">No components yet. Add one under
        <code>components/&lt;name&gt;/</code> and rebuild.</p>`,
    });
  }

  const rows = components
    .map((c) => {
      const blurb = COMPONENT_BLURBS[c.name] || { name: "", classes: "", desc: "" };
      const meta = COMPONENT_META[c.name] || null;
      // Display name = the canonical functional name from COMPONENT_BLURBS (falls back
      // to the title-cased folder). The live Rename overlays a KV value over this.
      const dname = blurb.name || titleCase(c.name);
      const classes = blurb.classes
        ? `<code>${blurb.classes}</code>`
        : "";
      const badges = meta ? metaBadges(meta) : "";
      const tags = meta && meta.tags && meta.tags.length
        ? `<div class="comp-tags">${meta.tags.map((t) => `<span>#${t}</span>`).join("")}</div>`
        : "";
      // Components are a designer reference — Open only, no HTML download.
      // Filter key spans name + classes + description + every metadata axis, so a
      // search like "bo", "review", or "wien" narrows the table.
      const metaKey = meta ? `${meta.surface} ${meta.category} ${meta.status} ${(meta.tags || []).join(" ")}` : "";
      const fkey = `${dname} ${blurb.classes} ${blurb.desc} ${metaKey}`.replace(/<[^>]+>/g, " ").replace(/"/g, "");
      // data-rename-key / data-desc-key feed CARD_MENU_JS (right-click → Rename / Edit
      // description), persisting a KV override under those keys. Both default back to
      // the canonical code values, which I fold the overrides into so we share one name.
      return `
        <tr data-fitem data-fkey="${fkey}" data-rename-key="${SPACE_KEY}components/${c.name}" data-default-name="${escAttr(dname)}">
          <td>
            <a class="comp-thumb" href="${c.href}" aria-label="Open ${escAttr(dname)}">
              ${media(c.href, c.poster)}
            </a>
          </td>
          <td><div class="comp-name"><span class="proto-name">${dname}</span>${classes}</div>${badges}${tags}</td>
          <td><div class="comp-desc" data-desc-key="components/${c.name}#desc">${blurb.desc}</div></td>
          <td class="comp-status">${compStatusChip(c.name)}</td>
        </tr>`;
    })
    .join("");

  return shell({
    title: "Components",
    activeTab: "components",
    wrapClass: "wrap--wide",
    body: `<header class="folderbar"><h1 class="folderbar__title">Components</h1><span class="folderbar__count">${components.length}</span><span class="folderbar__rule"></span></header><table class="comp-table">
      <thead><tr><th>Preview</th><th>Component</th><th>What it is</th><th class="comp-status">Status</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>${filterEmpty()}`,
  });
}

// ── Base / Patterns tabs (flat demo grids, like Pages) ───────────────────────
// Generic card-grid renderer for a library tier whose demos are self-contained
// folders (base/<name>/, patterns/<name>/). Same card contract as Pages.
function renderTierGrid(items, { title, activeTab, subtitle, addHint }) {
  if (!items.length) {
    return shell({
      title, activeTab, wrapClass: "wrap--wide",
      body: `<p class="empty">${subtitle} None yet — add one under <code>${activeTab}/&lt;name&gt;/</code> and rebuild.</p>`,
    });
  }
  const card = (p) => `
        <div class="card-proto" data-fitem data-fkey="${titleCase(p.name)}" data-rename-key="${SPACE_KEY}${activeTab}/${p.name}" data-default-name="${titleCase(p.name)}">
          <div class="preview">
            ${media(p.href, p.poster)}
            <a class="preview-link" href="${p.href}" aria-label="Open ${titleCase(p.name)}"></a>
          </div>
          <div class="proto-meta">
            <div class="proto-name">${titleCase(p.name)}</div>
          </div>
        </div>`;
  return shell({
    title, activeTab, wrapClass: "wrap--wide",
    body: `<header class="folderbar"><h1 class="folderbar__title">${title}</h1><span class="folderbar__count">${items.length}</span><span class="folderbar__rule"></span></header>` +
      (addHint ? `<p class="tier-hint">${addHint}</p>` : "") +
      `<div class="page-grid">${items.map(card).join("")}</div>${filterEmpty()}`,
  });
}
const renderBaseIndex = (items) =>
  renderTierGrid(items, {
    title: "Base", activeTab: "base", subtitle: "Base atoms.",
    addHint: "The source-grounded atoms — buttons, inputs, cards, badges, modal, icons. Components and Patterns are built from these; everything below drinks from <a href=\"/tokens/\">Tokens</a>.",
  });
const renderPatternsIndex = (items) =>
  renderTierGrid(items, {
    title: "Patterns", activeTab: "patterns", subtitle: "Composition patterns.",
    addHint: "Curated recurring compositions — several Components arranged the way real screens repeatedly arrange them (participation flow, idea feed, events section, phase nav…).",
  });

// ── Tokens tab — GENERATED from the canonical tokens stylesheet via the graph ─
// Every --gv-* token: a swatch (when its resolved raw value is a colour), the
// declared value, the alias chain down to the raw value, and how many tokens/
// classes drink from it. Proves the bottom of the import chain is real, not asserted.
function isColorVal(v) {
  return !!v && /^(#|rgb|hsl|color-mix)/i.test(v.trim());
}
// A palette primitive = a raw colour on a named scale step (grey-800, blue-500…),
// plus the standalone base hues. Everything else colour-typed is a semantic role
// (text-*, primary, error, tenant-*, bo-*, chart-*…) — usually an alias.
function isPrimitiveColor(name) {
  return /^--gv-(black|white|brown|green-mint)$/.test(name)
    || /^--gv-(grey|cool-grey|blue|teal|red|green|orange|amber)-\d/.test(name);
}
function tokenGroup(name) {
  if (/^--gv-type-/.test(name)) return "Type scale";       // semantic size/lh/weight triplets
  if (/^--gv-fs-/.test(name)) return "Font size";          // the raw size ramp
  if (/^--gv-font|^--gv-bo-font/.test(name)) return "Font family";
  if (/^--gv-space-/.test(name)) return "Spacing";
  if (/^--gv-radius/.test(name)) return "Radius";
  if (/^--gv-shadow/.test(name)) return "Elevation";
  if (/^--gv-focus/.test(name)) return "Focus";
  if (/width|height|padding|^--gv-menu-|frame-w|target-min/.test(name)) return "Layout";
  return isPrimitiveColor(name) ? "Palette" : "Semantic colour"; // the colour bulk, split
}
function tokPx(v) { const m = (v || "").match(/-?[\d.]+/); return m ? parseFloat(m[0]) : null; }
// WCAG contrast: returns the most-legible text colour on a swatch + its ratio/grade.
// Only for resolvable hex; aliased/rgba/color-mix values get no badge.
function hexToRgb(h) {
  h = (h || "").trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  const n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function relLum(rgb) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
}
function contrastBadge(raw) {
  const rgb = (raw || "").trim().startsWith("#") ? hexToRgb(raw) : null;
  if (!rgb) return "";
  const L = relLum(rgb);
  const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  const onWhite = ratio(L, 1), onBlack = ratio(L, 0);
  const whiteWins = onWhite >= onBlack;          // which TEXT colour reads best on the swatch
  const r = Math.max(onWhite, onBlack);
  const grade = r >= 7 ? "AAA" : r >= 4.5 ? "AA" : r >= 3 ? "AA Large" : "fail";
  const cls = r >= 4.5 ? "tok-contrast--pass" : r >= 3 ? "" : "tok-contrast--fail";
  return `<div class="tok-contrast ${cls}" title="Best text on this colour: ${r.toFixed(2)}:1 with ${whiteWins ? "white" : "black"} text (WCAG)">`
    + `<span class="tok-contrast__chip" style="background:${escAttr(raw)};color:${whiteWins ? "#fff" : "#000"}">Aa</span>`
    + `<b>${grade}</b> ${r.toFixed(1)}:1</div>`;
}
// Self-contained click-to-copy for the tokens page (chromeScript's showToast is
// scoped to its own IIFE, so we ship a tiny local one reusing the .gv-toast style).
const TOKENS_JS = `
(function(){
  if(!document.querySelector('[data-copy]')) return;
  var toast;
  function flash(m){ if(!toast){toast=document.createElement('div');toast.className='gv-toast';document.body.appendChild(toast);} toast.textContent=m; toast.classList.add('show'); clearTimeout(toast._t); toast._t=setTimeout(function(){toast.classList.remove('show');},1500); }
  function fb(v){ var t=document.createElement('textarea'); t.value=v; t.style.position='fixed'; t.style.opacity='0'; document.body.appendChild(t); t.focus(); t.select(); try{document.execCommand('copy'); flash('Copied  '+v);}catch(_){} t.remove(); }
  document.addEventListener('click', function(e){
    var el=e.target.closest('[data-copy]'); if(!el) return;
    e.preventDefault();
    var v=el.getAttribute('data-copy');
    if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(v).then(function(){flash('Copied  '+v);}, function(){fb(v);});
    else fb(v);
  });
})();
`;
function renderTokensIndex(graph) {
  const tokens = graph.tokens || {};
  const names = Object.keys(tokens);
  const groups = {};
  for (const name of names) (groups[tokenGroup(name)] ||= []).push(name);
  const ORDER = ["Palette", "Semantic colour", "Type scale", "Font size", "Font family", "Spacing", "Radius", "Elevation", "Layout", "Focus"];
  const ordered = [...ORDER.filter((g) => groups[g]), ...Object.keys(groups).filter((g) => !ORDER.includes(g))];

  // ── shared row pieces ──
  const fkey = (name, t) => `${name} ${t.raw || ""} ${t.value}`.replace(/"/g, "");
  const copyName = (n) => `data-copy="var(${n})" title="Copy var(${n})"`;
  const chainOf = (t) => t.chain.length > 1
    ? `<div class="tok-chain">${t.chain.map((c) => `<code ${copyName(c)}>${c}</code>`).join('<span class="tok-arrow">→</span>')}<span class="tok-arrow">→</span><code class="tok-raw" data-copy="${escAttr(t.raw || "")}" title="Copy value">${escAttr(t.raw || "")}</code></div>`
    : `<div class="tok-chain"><code class="tok-raw" data-copy="${escAttr(t.raw || t.value)}" title="Copy value">${escAttr(t.raw || t.value)}</code></div>`;
  // Where-used: the dead count becomes a disclosure listing the actual consuming
  // tokens (copyable) and classes, straight from the composition graph.
  const usedRender = (toks, cls) => {
    const total = toks.length + cls.length;
    if (!total) return `<div class="tok-meta">no direct consumers</div>`;
    const chips = [
      ...toks.map((x) => `<code class="tok-use" ${copyName(x)}>${x}</code>`),
      ...cls.map((x) => `<code class="tok-use tok-use--cls">.${x}</code>`),
    ].join("");
    return `<details class="tok-used"><summary class="tok-meta">${total} consumer${total === 1 ? "" : "s"}</summary><div class="tok-uses">${chips}</div></details>`;
  };
  const usedOf = (t) => usedRender(t.consumedBy.tokens, t.consumedBy.classes);
  const bodyOf = (name, t, extra = "") => `<div class="tok-body"><code class="tok-name" ${copyName(name)}>${name}</code>${chainOf(t)}${extra}${usedOf(t)}</div>`;

  // ── preview swatch for chip-grid groups (Palette / Semantic / Radius / Elevation / Layout / Focus) ──
  const swatchOf = (name, t, group) => {
    const raw = t.raw || t.value || "";
    if (isColorVal(raw)) return `<span class="tok-sw" style="background:${raw}" ${copyName(name)}></span>`;
    if (group === "Radius") return `<span class="tok-sw tok-sw--radius" style="border-radius:${raw}"></span>`;
    if (group === "Elevation") return `<span class="tok-sw tok-sw--shadow"><span class="tok-sw__card" style="box-shadow:${raw}"></span></span>`;
    const px = tokPx(raw); // Layout / Focus dims → show the number
    return `<span class="tok-sw tok-sw--mono" style="font-size:11px">${px != null ? px : "·"}</span>`;
  };
  const chipItem = (name, group) => {
    const t = tokens[name];
    const extra = (group === "Palette" || group === "Semantic colour") ? contrastBadge(t.raw) : "";
    return `<div class="tok" data-fitem data-fkey="${fkey(name, t)}">${swatchOf(name, t, group)}${bodyOf(name, t, extra)}</div>`;
  };
  const gridSection = (g) => `<div class="tok-grid">${groups[g].map((n) => chipItem(n, g)).join("")}</div>`;

  // ── Font family → a real type sample (pangram + glyph set) in the actual face ──
  const fontFamilySection = (g) => `<div class="tok-list">${groups[g].map((n) => {
    const t = tokens[n]; const fam = t.raw || t.value;
    return `<div class="tok-row tok-row--ff" data-fitem data-fkey="${fkey(n, t)}">
        <div class="ff-sample" style="font-family:${fam}"><b>The quick brown fox jumps</b>ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789</div>
        ${bodyOf(n, t)}
      </div>`;
  }).join("")}</div>`;

  // ── Spacing → bars at the real width (clamped past 240px, true value labelled) ──
  const spacingSection = (g) => {
    const order = groups[g].slice().sort((a, b) => (tokPx(tokens[a].raw) || 0) - (tokPx(tokens[b].raw) || 0));
    return `<div class="tok-list">${order.map((n) => {
      const t = tokens[n]; const w = Math.max(2, Math.min(tokPx(t.raw) || 0, 240));
      return `<div class="tok-row" data-fitem data-fkey="${fkey(n, t)}"><span class="sp-track"><span class="sp-bar" style="width:${w}px"></span></span>${bodyOf(n, t)}</div>`;
    }).join("")}</div>`;
  };

  // ── Font size → glyph rendered at the real size (visual capped at 64px, true px labelled) ──
  const fontSizeSection = (g) => {
    const order = groups[g].slice().sort((a, b) => (tokPx(tokens[a].raw) || 0) - (tokPx(tokens[b].raw) || 0));
    return `<div class="tok-list">${order.map((n) => {
      const t = tokens[n]; const vis = Math.min(tokPx(t.raw) || 16, 64);
      return `<div class="tok-row" data-fitem data-fkey="${fkey(n, t)}"><span class="ts-sample" style="font-size:${vis}px">Ag</span>${bodyOf(n, t)}</div>`;
    }).join("")}</div>`;
  };

  // ── Type scale → pair the size/lh/weight triplet per role into one live sample ──
  const ROLE_ORDER = ["display", "h1", "h2", "h3", "title", "body", "bodys", "label", "caption"];
  const typeRoles = (g) => {
    const roles = [...new Set(groups[g].map((n) => (n.match(/^--gv-type-(.+)-(size|lh|weight)$/) || [])[1]).filter(Boolean))];
    return roles.sort((a, b) => { const i = ROLE_ORDER.indexOf(a), j = ROLE_ORDER.indexOf(b); return (i < 0 ? 99 : i) - (j < 0 ? 99 : j); });
  };
  const typeScaleSection = (g) => `<div class="tok-list">${typeRoles(g).map((role) => {
    const kSz = `--gv-type-${role}-size`, kLh = `--gv-type-${role}-lh`, kWt = `--gv-type-${role}-weight`;
    const sz = tokens[kSz], lh = tokens[kLh], wt = tokens[kWt];
    const szRaw = (sz && sz.raw) || "16px", lhRaw = (lh && lh.raw) || "", wtRaw = (wt && wt.raw) || "400";
    const vis = Math.min(tokPx(szRaw) || 16, 52);
    const present = [kSz, kLh, kWt].filter((k) => tokens[k]);
    const usedToks = [...new Set(present.flatMap((k) => tokens[k].consumedBy.tokens))];
    const usedCls = [...new Set(present.flatMap((k) => tokens[k].consumedBy.classes))];
    const ann = `${szRaw}${wtRaw ? ` · ${wtRaw}` : ""}${lhRaw ? ` · ${lhRaw} line-height` : ""}`;
    return `<div class="tok-row" data-fitem data-fkey="${`${role} ${present.join(" ")} ${szRaw} ${wtRaw}`.replace(/"/g, "")}">
        <span class="ts-sample" style="font-size:${vis}px;font-weight:${wtRaw}">Ag</span>
        <div class="tok-body">
          <code class="tok-name">${role}</code>
          <div class="tok-meta--ann">${ann}</div>
          <div class="tok-chain">${present.map((k) => `<code ${copyName(k)}>${k}</code>`).join(" ")}</div>
          ${usedRender(usedToks, usedCls)}
        </div>
      </div>`;
  }).join("")}</div>`;

  const sectionBody = (g) => g === "Type scale" ? typeScaleSection(g)
    : g === "Font size" ? fontSizeSection(g)
    : g === "Font family" ? fontFamilySection(g)
    : g === "Spacing" ? spacingSection(g)
    : gridSection(g);
  const sectionCount = (g) => g === "Type scale" ? typeRoles(g).length : groups[g].length;
  const sections = ordered.map((g) => `
      <details class="fsection" data-fgroup open>
        <summary class="section-eyebrow"><span class="fsection__caret" aria-hidden="true"></span>${g} &middot; ${sectionCount(g)}</summary>
        ${sectionBody(g)}
      </details>`).join("");

  return shell({
    title: "Tokens", activeTab: "tokens", wrapClass: "wrap--wide",
    body: `<header class="folderbar"><h1 class="folderbar__title">Tokens</h1><span class="folderbar__count">${names.length}</span><span class="folderbar__rule"></span></header>` +
      `<p class="tier-hint">The design-system variables (<code>--gv-*</code>), parsed live from <code>${DS.prefix}-tokens.css</code> — each with its alias chain down to a raw value and how much of the system drinks from it. This is the bottom of every import chain Base · Components · Patterns · Pages resolve to. <strong>Click any token name or value to copy it</strong>; expand a consumer count to see exactly what uses it.</p>` +
      `${sections}${filterEmpty()}` +
      `<script>${TOKENS_JS}</script>`,
  });
}

// ── Changelog ───────────────────────────────────────────────────────────────
// Parse the hand-edited changelog.md (repo root, internal-only) into entries.
// Each entry = a heading "## YYYY-MM-DD — Optional title" followed by body lines,
// up to the next heading. Fenced ``` blocks (the format example in the intro) are
// skipped so the sample heading inside them isn't mistaken for a real entry.
async function loadChangelog() {
  if (!(await exists(CHANGELOG_SRC))) return [];
  const raw = await fs.readFile(CHANGELOG_SRC, "utf8");
  const head = /^##\s+(\d{4}-\d{2}-\d{2})\s*(?:[—-]\s*(.+))?\s*$/;
  const entries = [];
  let cur = null;
  let inFence = false;
  for (const line of raw.split(/\r?\n/)) {
    if (/^```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = line.match(head);
    if (m) {
      cur = { date: m[1], title: (m[2] || "").trim(), body: [] };
      entries.push(cur);
    } else if (cur && line.trim() !== "---") {
      cur.body.push(line);
    }
  }
  // Newest first (ISO YYYY-MM-DD sorts lexically).
  entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return entries.map((e) => ({ date: e.date, title: e.title, body: e.body.join("\n").trim() }));
}

// Minimal, safe inline markdown for changelog bodies: escape HTML, then re-enable
// only `code` and **bold**. Blank lines split paragraphs; single newlines fold to
// spaces (authored prose wraps for readability, renders as flowing text).
function clInline(text) {
  return text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}
function clBody(body) {
  return body
    .split(/\n{2,}/)
    .map((p) => `<p>${clInline(p.replace(/\s*\n\s*/g, " ").trim())}</p>`)
    .join("");
}

// Styles for the changelog list — a simple timeline of dated cards. Uses the
// shared PAGE_CSS design tokens so it tracks the rest of the chrome.
const CHANGELOG_CSS = `
    .cl-list { display: flex; flex-direction: column; gap: 14px; max-width: 720px; }
    .cl-entry { display: grid; grid-template-columns: 120px 1fr; gap: 18px; padding: 18px 20px;
      background: var(--card); border: 1px solid var(--line); border-radius: 14px; }
    .cl-when { font-size: 12.5px; font-weight: 600; color: var(--muted); white-space: nowrap; padding-top: 1px; }
    .cl-when time { cursor: default; }
    .cl-title { font-family: var(--font-display); font-size: 16px; font-weight: 600; color: var(--fg); margin: 0 0 6px; line-height: 1.3; }
    .cl-body p { font-size: 14px; line-height: 1.55; color: var(--fg); margin: 0 0 8px; }
    .cl-body p:last-child { margin-bottom: 0; }
    .cl-body code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.86em;
      background: var(--bg-2); border: 1px solid var(--line-2); border-radius: 5px; padding: 1px 5px; }
    @media (max-width: 560px) {
      .cl-entry { grid-template-columns: 1fr; gap: 6px; }
      .cl-when { padding-top: 0; }
    }`;

// Client script: rewrite each absolute date into a relative phrase at view time,
// so "Today" becomes "Yesterday" the next day with no rebuild. Absolute date stays
// as a hover tooltip.
const CHANGELOG_JS = `(function(){
  var MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function rel(iso){
    var t = iso.split('-'); var then = new Date(+t[0], +t[1]-1, +t[2]);
    var now = new Date(); var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var days = Math.round((today - then) / 86400000);
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return days + ' days ago';
    if (days < 14) return '1 week ago';
    if (days < 30) return Math.floor(days/7) + ' weeks ago';
    if (days < 60) return '1 month ago';
    if (days < 365) return Math.floor(days/30) + ' months ago';
    if (days < 730) return '1 year ago';
    return Math.floor(days/365) + ' years ago';
  }
  function abs(iso){ var t = iso.split('-'); return +t[2] + ' ' + MON[+t[1]-1] + ' ' + t[0]; }
  var els = document.querySelectorAll('[data-reldate]');
  for (var i=0;i<els.length;i++){
    var iso = els[i].getAttribute('data-reldate');
    els[i].textContent = rel(iso);
    els[i].setAttribute('title', abs(iso));
  }
})();`;

// Help lives here now rather than costing a permanent line in the rail — the drawer
// itself is still chrome and still opens from anywhere that carries [data-help-open].
const CHANGELOG_HELP_CSS = `
  .folderbar .aubtn{ display:inline-flex; align-items:center; gap:7px; font:inherit; font-size:13px;
                     font-weight:500; padding:6px 12px; border-radius:8px;
                     border:1px solid rgba(16,17,26,0.14); background:#fff; color:#16171a;
                     cursor:pointer; white-space:nowrap; }
  .folderbar .aubtn:hover{ background:rgba(16,17,26,0.04); }
  .folderbar .aubtn .gvic{ width:15px; height:15px; }
`;

function renderChangelogPage(entries) {
  const cards = entries
    .map((e) => {
      const fkey = `${e.title} ${e.body}`.replace(/[*`#]/g, "").replace(/"/g, "");
      const title = e.title ? `<h2 class="cl-title">${clInline(e.title)}</h2>` : "";
      return `<article class="cl-entry" data-fitem data-fkey="${escAttr(fkey)}">
        <div class="cl-when"><time datetime="${e.date}" data-reldate="${e.date}">${e.date}</time></div>
        <div class="cl-body">${title}${clBody(e.body)}</div>
      </article>`;
    })
    .join("");
  const body = entries.length
    ? `<header class="folderbar"><h1 class="folderbar__title">Changelog</h1><span class="folderbar__count">${entries.length}</span><span class="folderbar__rule"></span><button type="button" class="aubtn" data-help-open>${IC_HELP}Help</button></header>` +
      `<div data-fgroup><div class="cl-list">${cards}</div></div>${filterEmpty()}` +
      `<style>${CHANGELOG_CSS}${CHANGELOG_HELP_CSS}</style><script>${CHANGELOG_JS}</script>`
    : `<header class="folderbar"><h1 class="folderbar__title">Changelog</h1><span class="folderbar__rule"></span><button type="button" class="aubtn" data-help-open>${IC_HELP}Help</button></header>` +
      `<p class="empty">No updates yet. Add one to <code>changelog.md</code> and rebuild.</p><style>${CHANGELOG_HELP_CSS}</style>`;
  return shell({ title: "Changelog", activeTab: "changelog", body });
}

// Discover the spaces under SPACES_ROOT. Each space dir (a per-space repo, mounted as a
// submodule at spaces/<id> — or a sibling clone when offline points SPACES_ROOT at the
// multi-space parent) holds a space.json ({id,name,default,badge}) at its root; dirs
// WITHOUT a space.json are not spaces and are skipped, as are non-dir / dotfile entries.
// The DEFAULT space (space.json default:true, else the first) builds at the root URLs;
// the rest under /<id>/. Returns default-first.
async function discoverSpaces() {
  // Engine-only: there is deliberately nothing to discover. Returning early (rather
  // than tolerating an empty spaces dir) means the mode is explicit — an empty
  // GV_SPACES_ROOT still fails loudly, because that is a broken checkout, not an
  // intent.
  if (ENGINE_ONLY) return [];
  // GV_SPACES_ROOT may point DIRECTLY at one space (a dir carrying space.json at
  // its root) — the standalone `augur dev` case: a lone space clone with no
  // sibling layout. It builds as the default space of a one-space site.
  try {
    const meta = JSON.parse(await fs.readFile(path.join(SPACES_ROOT, "space.json"), "utf8"));
    return [{
      id: meta.id || path.basename(SPACES_ROOT),
      name: meta.name || titleCase(path.basename(SPACES_ROOT)),
      default: true, // a one-space site has no non-root mount
      badge: meta.badge || "",
      adminOnly: false,
      pendingPages: Array.isArray(meta.pendingPages) ? meta.pendingPages : [],
      methodPages: Array.isArray(meta.methodPages) ? meta.methodPages : [],
      designSystem: meta.designSystem || null,
      projectsLabel: typeof meta.projectsLabel === "string" ? meta.projectsLabel : "",
      ignore: Array.isArray(meta.ignore) ? meta.ignore : [],
      mcpAllowlists: Array.isArray(meta.mcpAllowlists) ? meta.mcpAllowlists : [],
      publishTracks: meta.publishTracks === true,
      root: SPACES_ROOT,
    }];
  } catch (e) {}
  let entries;
  try {
    entries = await fs.readdir(SPACES_ROOT, { withFileTypes: true });
  } catch (e) {
    throw new Error(`[spaces] could not read SPACES_ROOT (${SPACES_ROOT}): ${e.message}`);
  }
  const spaces = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const root = path.join(SPACES_ROOT, e.name);
    let meta;
    try { meta = JSON.parse(await fs.readFile(path.join(root, "space.json"), "utf8")); } catch { continue; }
    spaces.push({
      id: meta.id || e.name,
      name: meta.name || titleCase(e.name),
      default: !!meta.default,
      badge: meta.badge || "",
      // Admin-only space: the switcher still lists it for everyone (spaceSwitcher()
      // renders every space unconditionally); the gate is the worker, which seals the
      // space's base path (RESTRICTED_BASES) so a non-admin who clicks through is
      // bounced to the admin login. Default space is never gated.
      adminOnly: !!meta.adminOnly,
      // Space-authored content/config — the platform stays space-agnostic.
      pendingPages: Array.isArray(meta.pendingPages) ? meta.pendingPages : [],
      methodPages: Array.isArray(meta.methodPages) ? meta.methodPages : [],
      designSystem: meta.designSystem || null,
      projectsLabel: typeof meta.projectsLabel === "string" ? meta.projectsLabel : "",
      ignore: Array.isArray(meta.ignore) ? meta.ignore : [],
      // Paths (space-relative) of {"hosts":[…]} documents the space ships — exact
      // hosts its prototypes need the /__mcp/ proxy to forward (see main()).
      mcpAllowlists: Array.isArray(meta.mcpAllowlists) ? meta.mcpAllowlists : [],
      // Opt-in: this space's tracks/ audio may be served publicly (see the tracks/ block
      // in buildSpace). Default false — music is a local-preview folder, not a payload.
      publishTracks: meta.publishTracks === true,
      root,
    });
  }
  if (!spaces.length) throw new Error(`[spaces] no spaces found under ${SPACES_ROOT}`);
  if (!spaces.some((s) => s.default)) spaces[0].default = true;
  // Exactly one default wins (first declared); others demoted. Default sorts first.
  let seenDefault = false;
  for (const s of spaces) {
    if (s.default && !seenDefault) seenDefault = true;
    else s.default = false;
  }
  spaces.sort((a, b) => (b.default - a.default) || a.id.localeCompare(b.id));
  return spaces;
}

// Switch the ambient build context to a space: repoint the DS/WS roots + derived
// sources, reload its catalog, and set the URL prefix (BASE) + dist target (DIST_SPACE).
// The space's canonical UI skill, auto-detected: the dir under <root>/skills/ named
// "<prefix>-ui" that carries "<dirname>.css" (e.g. skills/acme-ui/acme-ui.css →
// prefix "acme"). Explicit override: space.json { "designSystem": { "skill": … } }.
// Every canonical asset name derives from the prefix (<prefix>-tokens.css, …), so
// the engine hardcodes no product-specific names.
function detectUiSkill(space) {
  // No space at all (an engine-only build has no default space): no design system.
  if (!space || !space.root) return { dirName: null, prefix: null };
  const declared = space && space.designSystem && space.designSystem.skill;
  const skillsDir = path.join(space.root, "skills");
  const candidates = declared ? [declared]
    : (existsSync(skillsDir)
        ? readdirSync(skillsDir).filter((d) => d.endsWith("-ui") && existsSync(path.join(skillsDir, d, `${d}.css`))).sort()
        : []);
  const dirName = candidates[0] || null;
  return { dirName, prefix: dirName ? dirName.replace(/-ui$/, "") : null };
}

function setSpaceContext(space) {
  DS_ROOT = space.root;
  WS_ROOT = space.root;
  DS = detectUiSkill(space);
  CANON_CSS_LAYERS = DS.prefix ? canonCssLayers(DS.prefix) : [];
  SPACE_NAME = space.name || "";
  PROJECTS_LABEL = space.projectsLabel || "Projects";
  SPACE_IGNORE = new Set(space.ignore || []);
  UI_SKILL = path.join(space.root, "skills", DS.dirName || "_ui");
  PAGES_SRC = path.join(space.root, "pages");
  COMPONENTS_SRC = path.join(space.root, "components");
  BASE_SRC = path.join(space.root, "base");
  PATTERNS_SRC = path.join(space.root, "patterns");
  ({ COMPONENT_INDEX, BASE_INDEX, PATTERN_INDEX, COMPONENT_BLURBS, COMPONENT_META } = loadCatalog(space.root));
  STATUS_FILE = path.join(space.root, "prototype-status.json");
  PENDING_PAGES = space.pendingPages || [];
  METHOD_PAGES = new Set(space.methodPages || []);
  BASE = space.default ? "" : `/${space.id}`;
  SPACE_KEY = space.default ? "" : `${space.id}/`;
  DIST_SPACE = space.default ? DIST : path.join(DIST, space.id);
  NAV_STATE.activeSpace = space.id;
}

// Build ONE space into dist: the default space at the dist root, others under dist/<id>/.
// Switches the ambient build context (DS_ROOT/WS_ROOT/sources/catalog/BASE/DIST_SPACE),
// scans every source (each copies its folders into DIST_SPACE), then writes the index /
// gallery pages. Returns the scan results so main() can fold this space's published paths
// into the single shared worker (gate + version map).
async function buildSpace(space) {
  setSpaceContext(space);
  await fs.mkdir(DIST_SPACE, { recursive: true });
  // Reset the canvas accumulators per space: each pass collects only ITS OWN
  // entries, which ride out in this space's routing fragment. (They used to
  // accumulate across every space into one shared file — which meant whoever
  // wrote that file last decided what the other spaces contributed.)
  CANVAS_CATALOG = [];
  CANVAS_TRACKS = [];

  // Scan every source (each also copies its folders into dist).
  const opportunities = await scan();
  const base = await scanBase();
  const components = await scanComponents();
  const patterns = await scanPatterns();
  const pages = await scanPages();
  // Composition graph, derived from this space's canonical CSS (the honesty backbone).
  const graph = await buildGraph();

  // Canvas insert-picker catalog: every embeddable thing in this space, so the canvas
  // "Prototype" tool can search + insert instead of pasting a URL. (BASE carries the space
  // prefix; poster preview.webp becomes the thumbnail.)
  for (const opp of opportunities) for (const p of opp.prototypes) {
    CANVAS_CATALOG.push({ type: "prototype", title: p.name, group: opp.name, url: `${BASE}/${opp.name}/${p.href}`, thumb: p.poster ? `${BASE}/${opp.name}/${p.href}preview.webp` : null, ...(p.desc ? { desc: p.desc } : {}) });
  }
  for (const p of pages) CANVAS_CATALOG.push({ type: "page", title: p.name, group: p.surface || "", url: `${BASE}/pages/${p.href}`, thumb: p.poster ? `${BASE}/pages/${p.href}preview.webp` : null });
  for (const c of components) CANVAS_CATALOG.push({ type: "component", title: c.name, url: `${BASE}/components/${c.href}`, thumb: c.poster ? `${BASE}/components/${c.href}preview.webp` : null });

  // Publish the nav context BEFORE any render so the left rail (space switcher +
  // Opportunities/Playground + Library) is identical on every page of this space.
  NAV_STATE.opportunities = opportunities;
  NAV_STATE.hasPlayground = await isDir(path.join(WS_ROOT, "playground"));
  if (space.default) DEFAULT_NAV = { space, opportunities, hasPlayground: NAV_STATE.hasPlayground };

  // Root index → opportunities.
  await fs.writeFile(path.join(DIST_SPACE, "index.html"), renderRootIndex(opportunities), "utf8");

  // Per-opportunity index → prototypes.
  for (const opp of opportunities) {
    await fs.writeFile(
      path.join(DIST_SPACE, opp.name, "index.html"),
      renderOpportunityIndex(opp),
      "utf8"
    );
  }

  // ── Primitives tab → ship the UI-skill gallery (tokens: colour, type, shadow,
  // and the base primitives) + its assets out of the skill (skills/ doesn't ship
  // on its own). Inject the site nav into the gallery.
  if (DS.prefix && (await exists(path.join(UI_SKILL, "gallery.html")))) {
    const patternsDir = path.join(DIST_SPACE, "primitives");
    await fs.mkdir(patternsDir, { recursive: true });
    const galleryHtml = await fs.readFile(path.join(UI_SKILL, "gallery.html"), "utf8");
    await fs.writeFile(
      path.join(patternsDir, "index.html"),
      injectPrimitives(galleryHtml),
      "utf8"
    );
    const patternAssets = ["tokens.css", "primitives.css", "ui.css", "themes.js", "cookies.js", "icons.js", "logo.svg"]
      .map((f) => `${DS.prefix}-${f}`);
    for (const asset of patternAssets) {
      if (await exists(path.join(UI_SKILL, asset))) {
        await fs.copyFile(path.join(UI_SKILL, asset), path.join(patternsDir, asset));
      }
    }
  }

  // ── Canonical shared assets → <space>/skills/<ui-skill>/ (whitelist ONLY — never
  // the internal .md files like SKILL.md / components.md). Each space ships its OWN copy
  // at its own root, so the ../../skills/<ui-skill>/ relative refs in library demos
  // (components/<name>/, pages/<name>/) and prototypes resolve WITHIN the space — local
  // (file://), the default space at the dist root, and a /<id>/-prefixed space alike.
  // That keeps primitives → components → pages hardwired to one source per space, so
  // drift is structurally impossible and a space can diverge its DS without touching
  // another. (Prototypes are the only tier that still copies assets — they may fork.)
  if (DS.dirName) {
    const sharedDir = path.join(DIST_SPACE, "skills", DS.dirName);
    await fs.mkdir(sharedDir, { recursive: true });
    // The skill declares what it ships: skills/<x>-ui/skill.json {"assets": [...]},
    // file or directory names relative to the skill root (dirs copy wholesale).
    // The inventory belongs to the WORKSPACE, not the engine; a skill with no
    // manifest gets the fixed default inventory below. Markdown at the skill root
    // (SKILL.md, components.md — internal notes) never ships either way, and
    // neither does skill.json itself. Contract: agents/ui-skill.md.
    let declared = null;
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(UI_SKILL, "skill.json"), "utf8"));
      if (Array.isArray(manifest.assets)) declared = manifest.assets;
    } catch { /* no manifest → legacy inventory */ }
    if (declared) {
      for (const name of declared) {
        // Stay inside the skill dir; a manifest can only name what sits in it.
        if (typeof name !== "string" || name.includes("..") || path.isAbsolute(name)) continue;
        if (name.toLowerCase().endsWith(".md") || name === "skill.json") continue;
        const src = path.join(UI_SKILL, name);
        const dest = path.join(sharedDir, name);
        if (await isDir(src)) {
          await copyDir(src, dest);
        } else if (await exists(src)) {
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.copyFile(src, dest);
        }
      }
    } else {
      const SHARED_ASSETS = [
        "tokens.css", "primitives.css", "ui.css", "bo.css",
        "themes.js", "cookies.js", "icons.js",
        "avatars.js", "rail.js", "partbar.js",
        "survey.css", "survey.js", "logo.svg",
        "charts.js",
        "pagebuilder.js", "widgets.js", "widgets.css",
        "instances.js",
      ].map((f) => `${DS.prefix}-${f}`);
      for (const asset of SHARED_ASSETS) {
        if (await exists(path.join(UI_SKILL, asset))) {
          await fs.copyFile(path.join(UI_SKILL, asset), path.join(sharedDir, asset));
        }
      }
      // Asset SUBDIRECTORIES the shared JS depends on (binary, so not in the file
      // whitelist above): e.g. avatars/ — the bundled face set the avatars JS drops
      // into every .av bubble. Copied wholesale so the faces resolve on the shipped
      // site exactly as they do locally (file://).
      const SHARED_ASSET_DIRS = ["avatars", "img", "vendor"];
      for (const d of SHARED_ASSET_DIRS) {
        if (await isDir(path.join(UI_SKILL, d))) {
          await copyDir(path.join(UI_SKILL, d), path.join(sharedDir, d));
        }
      }
    }
    // This space's composition graph (window.__GV_GRAPH), parsed from the very
    // stylesheets sitting next to it. Shipped here rather than under /__review/
    // because it is space content, not shared chrome — see reviewTag. It rides
    // the space's own publish, so it can never be stale against its own CSS.
    await fs.writeFile(
      path.join(sharedDir, "graph.js"),
      "window.__GV_GRAPH=" + JSON.stringify(graph) + ";",
      "utf8"
    );
  }

  // ── Tokens tab → GENERATED from the tokens stylesheet via the composition graph.
  await fs.mkdir(path.join(DIST_SPACE, "tokens"), { recursive: true });
  await fs.writeFile(
    path.join(DIST_SPACE, "tokens", "index.html"),
    renderTokensIndex(graph),
    "utf8"
  );

  // ── Base tab → base-atom demos from base/<name>/.
  await fs.mkdir(path.join(DIST_SPACE, "base"), { recursive: true });
  await fs.writeFile(
    path.join(DIST_SPACE, "base", "index.html"),
    renderBaseIndex(base),
    "utf8"
  );

  // ── Components tab → composed component library from components/<name>/.
  await fs.mkdir(path.join(DIST_SPACE, "components"), { recursive: true });
  await fs.writeFile(
    path.join(DIST_SPACE, "components", "index.html"),
    renderComponentsIndex(components),
    "utf8"
  );

  // ── Patterns tab → curated composition demos from patterns/<name>/.
  await fs.mkdir(path.join(DIST_SPACE, "patterns"), { recursive: true });
  await fs.writeFile(
    path.join(DIST_SPACE, "patterns", "index.html"),
    renderPatternsIndex(patterns),
    "utf8"
  );

  // ── Pages tab → composed reference pages from pages/<name>/.
  await fs.mkdir(path.join(DIST_SPACE, "pages"), { recursive: true });
  await fs.writeFile(
    path.join(DIST_SPACE, "pages", "index.html"),
    renderPagesIndex(pages),
    "utf8"
  );

  // ── Playground (per space) → a folder that acts like an opportunity but stays pinned
  // in the rail. Copy the whole tree verbatim (shared assets + project subfolders), then
  // overwrite its index.html with a generated folder browser of the subfolders.
  let playground = [];
  if (await isDir(path.join(WS_ROOT, "playground"))) {
    await copyDir(path.join(WS_ROOT, "playground"), path.join(DIST_SPACE, "playground"), isInternalOnly);
    playground = await scanPlayground();
    await fs.writeFile(
      path.join(DIST_SPACE, "playground", "index.html"),
      renderPlaygroundIndex(playground),
      "utf8"
    );
    // Playground projects are embeddable too — same insert-picker entry shape as
    // opportunity prototypes, grouped under "playground". (The catalog block above
    // runs before this scan, so playground joins the catalog here.)
    for (const p of playground) {
      CANVAS_CATALOG.push({ type: "prototype", title: p.name, group: "playground", url: `${BASE}/playground/${p.href}`, thumb: p.poster ? `${BASE}/playground/${p.href}preview.webp` : null, ...(p.desc ? { desc: p.desc } : {}) });
    }
  }

  // ── Canvas session music (per space) → tracks/ shipped verbatim, indexed into the shared
  // manifest. The space authors tracks/tracks.json as [{id,name,file,duration,color?,motif?}];
  // `file` is relative to tracks/ and `duration` (seconds) is what lets every client seek to
  // the same point in a loop, so a track without one plays but won't sync mid-stream.
  // `color` (CSS color) and `motif` (a label-art key the canvas knows) dress the track's
  // record label in the session panel; without them the canvas derives both from the id hash.
  //
  // ⚠️ Music is LOCAL-ONLY unless the space says otherwise. A folder of audio is almost
  // never licensed for redistribution, so tracks/ ships only in a local build (offline
  // preview, `augur dev`) or when the space opts in with "publishTracks": true. Even then
  // it is not public: the worker serves /tracks/*.mp3 to instance ADMINS only (isTrackPath),
  // so a published track reaches the people who run the instance and nobody else. Without
  // the flag the folder still plays locally and simply isn't part of what goes live.
  const publishTracks = LOCAL_BUILD || space.publishTracks === true;
  if (publishTracks && await isDir(path.join(WS_ROOT, "tracks"))) {
    await copyDir(path.join(WS_ROOT, "tracks"), path.join(DIST_SPACE, "tracks"), isInternalOnly);
    try {
      const raw = JSON.parse(await fs.readFile(path.join(WS_ROOT, "tracks", "tracks.json"), "utf8"));
      for (const t of Array.isArray(raw) ? raw : []) {
        if (!t || !t.id || !t.file) continue;
        CANVAS_TRACKS.push({
          // namespaced by space so two spaces can both ship a track called "ambient"
          id: `${space.id}:${t.id}`,
          name: t.name || t.id,
          // per-segment encoding: track filenames are human-typed ("01 It's Friday.mp3"), and a
          // raw space merely looks wrong while a raw # silently truncates the URL to nothing
          url: `${BASE}/tracks/${t.file.split("/").map(encodeURIComponent).join("/")}`,
          ...(Number(t.duration) > 0 ? { duration: Number(t.duration) } : {}),
          ...(typeof t.color === "string" ? { color: t.color } : {}),
          ...(typeof t.motif === "string" ? { motif: t.motif } : {}),
        });
      }
    } catch (e) {
      console.warn(`build: ${space.id} has tracks/ but no readable tracks.json — no music installed`);
    }
  }

  // ── Space-wide search index → <space>/__search.json ─────────────────────────
  // Feeds the rail's global fuzzy finder (chromeScript): every navigable thing in
  // this space — folders, prototypes, playground projects, pages, components, the
  // gallery indexes — as tiny {t title, y type, u url, g group, k rename-key}
  // entries. The client merges KV renames (by k) and created canvases at runtime.
  // Gated like the rail pages themselves (not in PUBLIC_PREFIXES) — the finder is
  // team chrome, not a public surface.
  {
    const idx = [{ t: PROJECTS_LABEL, y: "Index", u: S("/") }];
    if (playground.length) idx.push({ t: "Playground", y: "Index", u: S("/playground/") });
    if (pages.length) idx.push({ t: "Pages", y: "Index", u: S("/pages/") });
    if (components.length) idx.push({ t: "Components", y: "Index", u: S("/components/") });
    if (base.length) idx.push({ t: "Base", y: "Index", u: S("/base/") });
    if (patterns.length) idx.push({ t: "Patterns", y: "Index", u: S("/patterns/") });
    if (DS.prefix) idx.push({ t: "Primitives", y: "Index", u: S("/primitives/") }, { t: "Tokens", y: "Index", u: S("/tokens/") });
    for (const opp of opportunities) {
      const cover = opp.prototypes[0];
      idx.push({ t: titleCase(opp.name), y: "Folder", u: S(`/${encodeURIComponent(opp.name)}/`), ...(cover && cover.poster ? { th: S(`/${encodeURIComponent(opp.name)}/${cover.href}preview.webp`) } : {}) });
      for (const p of opp.prototypes)
        idx.push({ t: titleCase(p.name), y: "Prototype", g: titleCase(opp.name), u: S(`/${encodeURIComponent(opp.name)}/${p.href}`), k: `${SPACE_KEY}${opp.name}/${p.name}`, ...(p.poster ? { th: S(`/${encodeURIComponent(opp.name)}/${p.href}preview.webp`) } : {}) });
    }
    for (const p of playground)
      idx.push({ t: titleCase(p.name), y: "Playground", u: S(`/playground/${p.href}`), k: `${SPACE_KEY}playground/${p.name}`, ...(p.poster ? { th: S(`/playground/${p.href}preview.webp`) } : {}) });
    for (const p of pages)
      idx.push({ t: titleCase(p.name), y: "Page", ...(p.surface ? { g: p.surface } : {}), u: S(`/pages/${p.href}`), k: `${SPACE_KEY}pages/${p.name}`, ...(p.poster ? { th: S(`/pages/${p.href}preview.webp`) } : {}) });
    for (const c of components)
      idx.push({ t: titleCase(c.name), y: "Component", u: S(`/components/${c.href}`), k: `${SPACE_KEY}components/${c.name}`, ...(c.poster ? { th: S(`/components/${c.href}preview.webp`) } : {}) });
    await fs.writeFile(path.join(DIST_SPACE, "__search.json"), JSON.stringify(idx), "utf8");
  }

  // ── Per-space build log.
  const protoCount = opportunities.reduce((n, o) => n + o.prototypes.length, 0);
  console.log(
    `[${space.id}]${space.default ? " (default → /)" : ` → /${space.id}/`} — ` +
    `${plural(opportunities.length, "opportunity").replace("opportunitys", "opportunities")}, ` +
    `${plural(protoCount, "prototype")}, ${components.length} components, ${pages.length} pages` +
    `${playground.length ? `, ${plural(playground.length, "playground project")}` : ""}.`
  );

  return {
    opportunities, base, components, patterns, pages, playground, graph,
    // This space's slice of the two site-wide canvas aggregates. Returned rather
    // than left in the module globals because each slice must reach that space's
    // OWN routing fragment — the worker merges them at serve time.
    canvasCatalog: CANVAS_CATALOG, canvasTracks: CANVAS_TRACKS,
  };
}

async function main() {
  // Clean dist for a deterministic build. Retry the removal: on macOS a
  // concurrent .DS_Store / Spotlight write can re-create a dir entry between
  // node's readdir and rmdir, throwing ENOTEMPTY on an otherwise-empty tree.
  await fs.rm(DIST, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await fs.mkdir(DIST, { recursive: true });

  const spaces = await discoverSpaces();
  // Publish the space list (public meta) for the rail's space switcher — identical on
  // every page; setSpaceContext() stamps which one is active per build pass.
  NAV_STATE.spaces = spaces.map((s) => ({
    id: s.id, name: s.name, default: s.default, badge: s.badge, base: s.default ? "" : `/${s.id}`,
    adminOnly: s.adminOnly,
  }));

  // Worker inputs accumulate ACROSS spaces — one gate, one version map for the whole site.
  const publicPrefixes = [];
  const versionMap = {};
  const sigParts = [`ui:${UI_VERSION}`];
  let defaultGraph = null;

  // GV_ONLY_SPACE=<id> builds just that space's content (the direct-publish CLI's
  // fast path — it uploads only that space's manifest, so the other spaces' absence
  // here is harmless). The space LIST (switcher, routing) still reflects every
  // discovered space; cross-space accumulations (publicPrefixes, versionMap,
  // shell id) are partial by design — the publish server derives routing from ALL
  // live manifests, never from a partial build's routing.json.
  const ONLY_SPACE = process.env.GV_ONLY_SPACE || "";
  // Per-space routing fragments — merged into the global gate inputs below AND
  // carried in each space's content manifest, so the direct-publish server can
  // recompute site routing from the live manifests alone (a partial build's
  // global accumulations are incomplete by design).
  const spaceRouting = {};
  for (const space of spaces) {
    if (ONLY_SPACE && space.id !== ONLY_SPACE) continue;
    const r = await buildSpace(space); // sets BASE + DIST_SPACE for this space
    if (space.default) defaultGraph = r.graph;
    const sr = (spaceRouting[space.id] = {
      publicPrefixes: [], versionMap: {}, sigParts: [],
      canvasCatalog: r.canvasCatalog, canvasTracks: r.canvasTracks,
    });

    // Published, link-shareable paths (prototypes + playground), prefixed with this
    // space's BASE so the gate opens them and they stay isolated per space. Galleries
    // remain gated (not pushed here). S() reads the BASE just set by buildSpace().
    for (const opp of r.opportunities)
      for (const p of opp.prototypes) {
        const u = S(`/${encodeURIComponent(opp.name)}/${encodeURIComponent(p.name)}/`);
        sr.publicPrefixes.push(u);
        sr.versionMap[u] = String(p.mtimeMs);
      }
    // Playground prototype folders are public (link-shareable); the /playground/ index
    // listing itself stays gated (a shorter path matching no prefix).
    for (const pj of r.playground) {
      const u = S(`/playground/${encodeURIComponent(pj.name)}/`);
      sr.publicPrefixes.push(u);
      sr.versionMap[u] = String(pj.mtimeMs);
    }
    for (const c of r.components) sr.versionMap[S(`/components/${encodeURIComponent(c.name)}/`)] = String(c.mtimeMs);
    for (const b of r.base) sr.versionMap[S(`/base/${encodeURIComponent(b.name)}/`)] = String(b.mtimeMs);
    for (const pt of r.patterns) sr.versionMap[S(`/patterns/${encodeURIComponent(pt.name)}/`)] = String(pt.mtimeMs);
    for (const pg of r.pages) sr.versionMap[S(`/pages/${encodeURIComponent(pg.name)}/`)] = String(pg.mtimeMs);

    // Structural signature → shell live-reload id (NOT mtimes), namespaced per space.
    sr.sigParts.push(`space:${space.id}|pg:${r.playground.length > 0}`);
    for (const opp of r.opportunities)
      for (const p of opp.prototypes)
        sr.sigParts.push(`${space.id}:${opp.name}/${p.name}|${p.status || ""}|${p.editor ? p.editor.email : ""}`);
    for (const [label, arr] of [["c", r.components], ["b", r.base], ["pt", r.patterns], ["pg", r.pages], ["pl", r.playground]])
      for (const it of arr) sr.sigParts.push(`${space.id}:${label}:${it.name}`);

    publicPrefixes.push(...sr.publicPrefixes);
    Object.assign(versionMap, sr.versionMap);
    sigParts.push(...sr.sigParts);
  }

  // ── Shared chrome — emitted ONCE at the dist root (NOT space-scoped) ─────────────────

  // These pages live at the root, so they must render with the DEFAULT space's context —
  // the build loop above leaves it pointing at whichever space it finished with (which is
  // why Admin used to open showing the last space as "Current"). GV_ONLY_SPACE builds skip
  // the default space entirely; there we still restore its rail context, minus the
  // listings (nothing scanned), and the root chrome isn't published from that pass anyway.
  {
    const dflt = spaces.find((s) => s.default);
    if (dflt) {
      setSpaceContext(dflt);
      NAV_STATE.opportunities = DEFAULT_NAV ? DEFAULT_NAV.opportunities : [];
      NAV_STATE.hasPlayground = DEFAULT_NAV ? DEFAULT_NAV.hasPlayground : false;
    }
  }

  // Changelog (platform-level) → rendered from the hand-edited changelog.md (the .md
  // itself is internal and never copied; only this generated page ships).
  const changelog = await loadChangelog();
  await fs.mkdir(path.join(DIST, "changelog"), { recursive: true });
  await fs.writeFile(
    path.join(DIST, "changelog", "index.html"),
    renderChangelogPage(changelog),
    "utf8"
  );

  // Admin → editable per-user passwords. The page ships to /admin/ but the worker gates
  // the route to admins (and the /__admin API re-checks). Only meaningful when identity
  // is configured (src/identity.json); harmless otherwise.
  await fs.mkdir(path.join(DIST, "admin"), { recursive: true });
  await fs.writeFile(path.join(DIST, "admin", "index.html"), renderAdminPage(), "utf8");

  // Optional self-contained build addon emits its own dist files (if present).
  if (addon) await addon.emit({ ROOT, DIST, fs, path, copyDir, isInternalOnly, exists });

  // Live-reload id for the index/shell pages (everything not in VERSION_MAP) — a djb2
  // hash of the STRUCTURAL signature (which items exist + name/status/editor, NOT their
  // mtimes). Editing a prototype reloads only its own page (its VERSION_MAP token); the
  // nav reloads only when a listing changes (item added/removed/renamed/re-statused).
  let h = 5381;
  const sig = sigParts.sort().join("\n");
  for (let i = 0; i < sig.length; i++) h = ((h << 5) + h + sig.charCodeAt(i)) >>> 0; // djb2
  const shellId = h.toString(36);

  // Edge auth gate → runtime config. The worker ships VERBATIM (no string stamping);
  // everything it used to have injected — users, public prefixes, version map,
  // restricted bases, deploy knobs — now ships as two JSON documents under
  // dist/__config/ that the worker reads at request time (short per-isolate cache).
  // Same derivation, same can't-drift guarantee (emitted by the very build that
  // shipped the assets); the worker file itself no longer changes per build.
  const workerSrc = await fs.readFile(SRC_WORKER, "utf8");
  // Admin-only space base paths (an adminOnly space's "/<id>") seal those spaces
  // to admins. Derived from each space's space.json `adminOnly` flag (the default
  // space is never restricted), so it can't drift from what shipped.
  const restrictedBases = NAV_STATE.spaces
    .filter((s) => s.adminOnly && !s.default)
    .map((s) => s.base);
  // Deploy knobs (gate-exempt skill-asset prefixes from the DEFAULT space's detected
  // UI skill, the MCP-proxy host allowlist, vanity redirects) ride the runtime
  // config documents below instead of worker stamping.
  //
  // Space-declared MCP hosts: space.json "mcpAllowlists" names shipped JSON
  // documents ({"hosts":[…]}, e.g. a generated client list) whose union ships in
  // routing.json. Mounting a space is the trust act — its declared hosts ride
  // in with it, no per-instance config and no runtime fetch to go stale. Failures
  // are loud: a DECLARED list that is missing or malformed is a broken space, not
  // a knob to degrade past (unlike the URL knob, whose runtime fetch fails soft
  // by design). Hosts are validated against the worker's own host pattern and
  // stored bare (lowercase, no leading "www.") to match its exact-match lookup.
  const MCP_HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
  const mcpSpaceHosts = new Set();
  for (const space of spaces) {
    for (const rel of space.mcpAllowlists) {
      const file = path.resolve(space.root, rel);
      if (!file.startsWith(path.resolve(space.root) + path.sep))
        throw new Error(`[mcp] space "${space.id}": allowlist path escapes the space: ${rel}`);
      let doc;
      try {
        doc = JSON.parse(await fs.readFile(file, "utf8"));
      } catch (e) {
        throw new Error(`[mcp] space "${space.id}": cannot read allowlist ${rel}: ${e.message}`);
      }
      if (!doc || !Array.isArray(doc.hosts))
        throw new Error(`[mcp] space "${space.id}": allowlist ${rel} must be shaped {"hosts": […]}`);
      for (const h of doc.hosts) {
        const bare = String(h).toLowerCase().replace(/^www\./, "");
        if (!MCP_HOST_RE.test(bare))
          throw new Error(`[mcp] space "${space.id}": allowlist ${rel} carries an invalid host: ${JSON.stringify(h)}`);
        mcpSpaceHosts.add(bare);
        if (spaceRouting[space.id]) (spaceRouting[space.id].mcpHosts ||= new Set()).add(bare);
      }
    }
  }
  const defaultDs = detectUiSkill(spaces.find((s) => s.default));
  const gateExempt = defaultDs.dirName ? [`/skills/${defaultDs.dirName}/`] : [];

  // Runtime config: instance.json = who/where (identity + deploy knobs);
  // routing.json = what shipped (derived from this very build). Served through the
  // ASSETS binding for the worker's OWN reads only — fetch() rejects external
  // /__config/* requests before any asset serving, because instance.json carries
  // the user list (with seed passwords, same sensitivity the stamped worker had).
  await fs.mkdir(path.join(DIST, "__config"), { recursive: true });
  await fs.writeFile(path.join(DIST, "__config", "instance.json"), JSON.stringify({
    users: IDENTITY,
    engineVersion: ENGINE_VERSION,
    updateFeed: DEPLOY.updateFeed || "",
    mcpHostSuffixes: DEPLOY.mcpHostSuffixes || [],
    mcpHostAllowlistUrl: DEPLOY.mcpHostAllowlistUrl || "",
    vanityRedirects: DEPLOY.vanityRedirects || {},
    rtOrigin: DEPLOY.realtimeOrigin || "",
    sentinels: DEPLOY.sentinels || [],
    // Oldest publish protocol this instance accepts a commit from. Absent = no floor.
    minClientProtocol: DEPLOY.minClientProtocol || 0,
    loginHint: DEPLOY.loginHint || "",
    loginPrefill: DEPLOY.loginPrefill || {},
  }), "utf8");
  await fs.writeFile(path.join(DIST, "__config", "routing.json"), JSON.stringify({
    buildId: shellId,
    versionMap,
    publicPrefixes,
    publicSkillPrefixes: gateExempt,
    restrictedBases,
    mcpAllowlist: [...mcpSpaceHosts].sort(),
    // Assets mode's copy of the two canvas aggregates, merged here across every
    // space this build saw. (Bundle mode ignores routing.json entirely and merges
    // the same per-space fragments off the live manifests instead — one worker
    // code path, two ways of reaching the same fragments.)
    canvasCatalog: Object.values(spaceRouting).flatMap((sr) => sr.canvasCatalog || []),
    canvasTracks: Object.values(spaceRouting).flatMap((sr) => sr.canvasTracks || []),
    canvasLoaderExtras: addonHtml(reviewTag()),
    defaultSpace: (NAV_STATE.spaces.find((s) => s.default) || {}).id || null,
    spaces: NAV_STATE.spaces,
  }), "utf8");
  await fs.writeFile(path.join(DIST, "_worker.js"), workerSrc, "utf8");

  // Public build stamp: /_build.json — {builtAt, engine:{sha}, spaces:{<id>:{sha}}}.
  // A space-repo collaborator cannot see this repo's CI, so this is their deploy
  // verification: curl it and compare their space's sha to `git rev-parse HEAD`.
  // engine.sha is the engine commit the site was built from — deploy shells pin the
  // engine at different SHAs, so it's the cross-instance divergence check. Served
  // ungated (see isPublicPath in src/_worker.js); it exposes only commit SHAs the
  // collaborators already have (the engine is public).
  let engineSha = null;
  try {
    engineSha = execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {}
  // Local deploys pass GV_BUILD_DIRTY_JSON ({repo id → bool}) so a working-tree
  // ship is visible in the stamp; CI builds never set it (clean checkouts).
  let dirtyMap = {};
  try { dirtyMap = JSON.parse(process.env.GV_BUILD_DIRTY_JSON || "{}"); } catch {}
  const stampSpaces = {};
  for (const space of spaces) {
    let sha = null;
    try {
      sha = execFileSync("git", ["-C", space.root, "rev-parse", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {}
    stampSpaces[space.id] = { sha, ...(dirtyMap[space.id] ? { dirty: true } : {}) };
  }
  await fs.writeFile(
    path.join(DIST, "_build.json"),
    JSON.stringify({
      builtAt: new Date().toISOString(),
      engine: { sha: engineSha, ...(ENGINE_VERSION ? { version: ENGINE_VERSION } : {}), ...(dirtyMap.engine ? { dirty: true } : {}) },
      spaces: stampSpaces,
    }, null, 2),
    "utf8"
  );

  // Top-level 404.html. Cloudflare Pages serves this (with a genuine 404 status) for
  // any unmatched route — WITHOUT it, Pages falls back to serving the root index.html
  // at status 200, so the worker's `asset.status === 404` branch never fires and bogus
  // URLs render the internal landing page instead of a 404. Same shell/markup as the
  // worker's notFoundPage() so direct hits and worker-wrapped hits look identical.
  await fs.writeFile(path.join(DIST, "404.html"), renderNotFoundPage(), "utf8");

  // Review overlay assets (shared; injected into prototypes via absolute /__review/
  // paths). comments.js + the cat are the engine's own.
  await fs.mkdir(path.join(DIST, "__review"), { recursive: true });
  await fs.copyFile(SRC_REVIEW, path.join(DIST, "__review", "comments.js"));
  await fs.copyFile(SRC_REVIEW_CAT, path.join(DIST, "__review", "cat.png"));
  await fs.copyFile(SRC_REVIEW_CURSOR, path.join(DIST, "__review", "comment-cursor.svg"));
  // The composition graph is NOT written here — it belongs to the space whose
  // design system it was parsed from, and ships inside that space's skills/
  // folder (see buildSpace, and reviewTag for why /__review/ is the wrong home).

  // Canvas engine (shared; canvas prototypes mount it by absolute /__canvas/ path, the same
  // way every prototype embeds /__review/comments.js). Board DATA persists to KV via /__board.
  await fs.mkdir(path.join(DIST, "__canvas"), { recursive: true });
  await fs.copyFile(SRC_CANVAS_JS, path.join(DIST, "__canvas", "canvas.js"));
  await fs.copyFile(SRC_CANVAS_CSS, path.join(DIST, "__canvas", "canvas.css"));
  // capture.js is not on any page: canvas.js lazy-loads it by absolute path on the first ⌘⇧C
  await fs.copyFile(SRC_CANVAS_CAPTURE, path.join(DIST, "__canvas", "capture.js"));
  // seven-segment display font for the session clock (SIL OFL — its license ships beside it)
  await fs.copyFile(SRC_CANVAS_7SEG, path.join(DIST, "__canvas", "DSEG7Classic-Bold.woff2"));
  await fs.copyFile(SRC_CANVAS_7SEG_LICENSE, path.join(DIST, "__canvas", "DSEG-LICENSE.txt"));
  // catalog.json + tracks.json are NOT written here. They are the two site-wide
  // aggregates — every embeddable thing, and every track, across ALL spaces — and
  // a single file can only be produced by a build that saw every space. Direct
  // publish never does: one space publishes at a time. Written as files they made
  // each publish silently blank the other spaces' contributions, and made CI's
  // engine ship rewrite them from pinned checkouts. So each space carries its own
  // slice in its routing fragment and the worker merges the live fragments to
  // serve /__canvas/{catalog,tracks}.json (canvasAggregate in src/_worker.js) —
  // in bundle mode from the manifests, in assets mode from routing.json.

  // Self-hosted fonts → /fonts/ (served immutable + public by the worker). Replaces
  // the render-blocking Google Fonts link; one variable woff2 covers every weight.
  if (await isDir(path.join(ROOT, "fonts"))) {
    await copyDir(path.join(ROOT, "fonts"), path.join(DIST, "fonts"));
  }
  // LentiaNova — the Augur display/title face → /fonts/. Neutral (400) from the Linz
  // capture; Median (600) + Bulky (800) from brand/ (pulled from the same Linz font
  // server). Raw capture exports never ship, but these font files do, matching FONT_CSS.
  {
    const neutral = path.join(ROOT, "brand", "lentianova.woff2");
    if (await exists(neutral)) {
      await fs.copyFile(neutral, path.join(DIST, "fonts", "lentianova.woff2"));
    }
    for (const [src, out] of [
      ["lentianova-median.otf", "lentianova-median.otf"],
      ["lentianova-bulky.otf", "lentianova-bulky.otf"],
    ]) {
      const p = path.join(ROOT, "brand", src);
      if (await exists(p)) await fs.copyFile(p, path.join(DIST, "fonts", out));
    }
  }

  // Augur brand mark (the bone-tile falcon app icon) → /augur-mark.png. The rail brand
  // + every page's <link rel="icon"> reference it root-relative, so it resolves from
  // any depth. Rendered from brand/augur-mark.svg (internal source, never shipped).
  if (await exists(path.join(ROOT, "augur-mark.png"))) {
    await fs.copyFile(path.join(ROOT, "augur-mark.png"), path.join(DIST, "augur-mark.png"));
  }
  // Space-switcher icon → /space-icon.png (shared by every space's rail switcher).
  // Spaces own their branding: comes from the DEFAULT space's repo root
  // (space-icon.png); falls back to the engine mark. Referenced root-absolute,
  // served on gated rail pages to authed users.
  // Because its bytes come from a space, the DEFAULT SPACE owns it — it is not in
  // ENGINE_CHROME, so the root-path rule assigns it there, and it ships when that
  // space publishes. Emitted only when a default space was built: an engine-only
  // build has no space branding to ship (and must stay chrome-pure).
  {
    const defaultSpace = spaces.find((s) => s.default);
    if (defaultSpace) {
      for (const src of [
        path.join(defaultSpace.root, "space-icon.png"),
        path.join(ROOT, "augur-mark.png"),
      ]) {
        if (await exists(src)) { await fs.copyFile(src, path.join(DIST, "space-icon.png")); break; }
      }
    }
  }
  // Augur eye mark (transparent indigo disc + sparkle cutout) → /augur-eye.svg, the
  // in-app rail/top brand mark. (Same shape on the bone tile = augur-mark.png favicon.)
  // Source in brand/ (internal). The earlier falcon glyphs are retired.
  {
    const src = path.join(ROOT, "brand", "augur-eye.svg");
    if (await exists(src)) await fs.copyFile(src, path.join(DIST, "augur-eye.svg"));
  }
  // Full-bleed install icons (bone tile + indigo falcon) for the PWA manifest — they
  // fill the OS squircle edge-to-edge instead of floating the mark in a white tile.
  for (const f of ["augur-icon-192.png", "augur-icon-512.png"]) {
    if (await exists(path.join(ROOT, f))) {
      await fs.copyFile(path.join(ROOT, f), path.join(DIST, f));
    }
  }

  // Minimal web app manifest → /manifest.webmanifest. Makes the site installable as
  // a desktop/dock app (Chrome/Edge/Safari) with the Augur icon + name. No service
  // worker on purpose: offline is useless behind the Access gate and a SW is the only
  // high-maintenance part of a PWA. Uses the bone-tile augur-icon-* install icons.
  await fs.writeFile(
    path.join(DIST, "manifest.webmanifest"),
    JSON.stringify(
      {
        name: "Augur",
        short_name: "Augur",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#F4EFE6",
        theme_color: "#2C2150",
        icons: [
          { src: "/augur-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/augur-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/augur-icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      null,
      2
    )
  );

  // ── Content manifests (per space + the engine chrome) ────────────────────────
  // dist/__manifests/<id>.json — {id, files:{<site-relative path>: {h,ct,s}}},
  // h = sha256 of the body. The diffable unit for the direct-publish path: a
  // publish uploads only the blobs the store doesn't hold, then commits the
  // manifest (an atomic pointer flip). Ownership: files under a non-default
  // space's base belong to that space; the shared chrome (fixed list — emitted by
  // the engine, not by any space) publishes as the pseudo-space "_engine"; the
  // default space owns the rest of the root. Excluded entirely:
  // _worker.js (deployed code, not content), _build.json + __config/ (derived
  // per build/publish), __manifests/ (this very output).
  //
  // ENGINE_CHROME is a list of exact files (and whole-directory prefixes ending
  // "/") whose bytes derive from the ENGINE REPO ALONE. Two directories that look
  // like chrome deliberately are NOT listed wholesale, because they mix sources:
  //   __review/  — comments.js + cat.png are the engine's, but graph.js is the
  //                DEFAULT SPACE's composition graph, derived from its design
  //                system's CSS. It stays at the root path (the overlay loads it
  //                absolutely) and is owned by that space.
  //   __canvas/  — the canvas engine is the engine's; catalog.json + tracks.json
  //                were cross-space AGGREGATES and are no longer files at all
  //                (the worker synthesizes them from the live routing fragments).
  // Likewise space-icon.png comes from the default space's repo root.
  // Getting this wrong is not cosmetic: CI publishes _engine from checkouts that
  // may lag a direct publish, so anything space-derived listed here would be
  // silently overwritten with stale content on every shell push. The engine-only
  // build asserts this list is exhaustive — see the purity check below.
  const ENGINE_CHROME = [
    "fonts/", "admin/", "changelog/", "pitis/",
    "__review/comments.js", "__review/cat.png", "__review/comment-cursor.svg",
    "__canvas/canvas.js", "__canvas/canvas.css", "__canvas/capture.js",
    "__canvas/DSEG7Classic-Bold.woff2", "__canvas/DSEG-LICENSE.txt",
    "piti.js", "404.html", "manifest.webmanifest",
    "augur-eye.svg", "augur-icon-192.png", "augur-icon-512.png", "augur-mark.png",
  ];
  const MANIFEST_MIME = {
    html: "text/html; charset=utf-8", css: "text/css; charset=utf-8",
    js: "application/javascript; charset=utf-8", mjs: "application/javascript; charset=utf-8",
    json: "application/json; charset=utf-8", map: "application/json",
    svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    webp: "image/webp", gif: "image/gif", ico: "image/x-icon",
    txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8",
    woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
    mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg",
    opus: "audio/opus", wav: "audio/wav", flac: "audio/flac",
    webm: "video/webm", mp4: "video/mp4", pdf: "application/pdf",
    webmanifest: "application/manifest+json", xml: "application/xml",
  };
  const ctFor = (p) => MANIFEST_MIME[p.slice(p.lastIndexOf(".") + 1).toLowerCase()] || "application/octet-stream";
  const { createHash } = await import("node:crypto");
  const manifests = {};
  const nonDefaultBases = NAV_STATE.spaces.filter((s) => !s.default).map((s) => ({ id: s.id, prefix: s.id + "/" }));
  const manifestDefaultId = (NAV_STATE.spaces.find((s) => s.default) || { id: "_root" }).id;
  async function walkDist(dir, rel, out) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) await walkDist(path.join(dir, e.name), r, out);
      else out.push(r);
    }
    return out;
  }
  for (const rel of await walkDist(DIST, "", [])) {
    if (rel === "_worker.js" || rel === "_build.json") continue;
    if (rel.startsWith("__config/") || rel.startsWith("__manifests/")) continue;
    const sp = nonDefaultBases.find((b) => rel.startsWith(b.prefix));
    const owner = sp ? sp.id
      : ENGINE_CHROME.some((p) => rel === p || rel.startsWith(p)) ? "_engine"
      : manifestDefaultId;
    const body = await fs.readFile(path.join(DIST, rel));
    const h = createHash("sha256").update(body).digest("hex");
    (manifests[owner] ||= { id: owner, format: 1, files: {} }).files["/" + rel] = { h, ct: ctFor(rel), s: body.length };
  }
  // Chrome purity. An engine-only build has no space on disk, so EVERY file it
  // emitted must be engine chrome. If one isn't, ENGINE_CHROME has gone stale
  // against what the build emits — some new artifact is space-derived (or newly
  // engine-derived) and nobody updated the list. Failing here is the point: this
  // is the check that makes "`--engine` cannot ship space content" true by
  // construction rather than by comment, and it fires in CI on every deploy.
  if (ENGINE_ONLY) {
    const strays = Object.keys(manifests).filter((id) => id !== "_engine");
    if (strays.length) {
      const examples = strays.flatMap((id) => Object.keys(manifests[id].files)).slice(0, 10);
      throw new Error(
        `[manifests] engine-only build emitted ${examples.length >= 10 ? "10+" : examples.length} non-chrome file(s): ` +
        `${examples.join(", ")}. Either they belong to a space (emit them inside buildSpace) ` +
        `or they are new engine chrome (add them to ENGINE_CHROME).`
      );
    }
  }
  // Attach each space's meta + routing fragment (see spaceRouting above); the
  // engine manifest carries the chrome-derived pieces. djb2 over the space's own
  // structural signature gives the per-space shell-reload token the publish
  // server folds into the site buildId.
  const sigOf = (parts) => {
    let h = 5381;
    const s = [...parts].sort().join("\n");
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  };
  for (const [id, m] of Object.entries(manifests)) {
    if (id === "_engine") {
      m.routing = { canvasLoaderExtras: addonHtml(reviewTag()) };
      continue;
    }
    m.space = NAV_STATE.spaces.find((s) => s.id === id) || { id };
    const sr = spaceRouting[id];
    // canvasCatalog/canvasTracks ride in the fragment rather than shipping as
    // files: they are the space's OWN slice of two site-wide aggregates, and a
    // file can only be written by whoever holds the whole picture — which no
    // single publisher does. The worker merges the live fragments and serves
    // /__canvas/{catalog,tracks}.json from them (see canvasAggregate there), so
    // publishing one space can never blank another's entries.
    if (sr) m.routing = {
      publicPrefixes: sr.publicPrefixes,
      versionMap: sr.versionMap,
      shellSig: sigOf(sr.sigParts),
      mcpAllowlist: [...(sr.mcpHosts || [])].sort(),
      canvasCatalog: sr.canvasCatalog || [],
      canvasTracks: sr.canvasTracks || [],
      ...(m.space.default ? { publicSkillPrefixes: gateExempt } : {}),
    };
  }
  // A space that HAS a design system must ship it. This is the one silent failure the
  // whole publish path could not detect: the skill inventory is either declared in
  // skill.json or matched against a fixed default list, so a renamed asset, a typo in
  // the manifest or a moved directory drops the stylesheet without dropping a single
  // page. The site still builds, still publishes, still exports — and every prototype
  // renders unstyled, which nobody sees until they open one.
  //
  // Prototypes and the design system ARE the content worth protecting; comments,
  // canvases and rosters are recoverable conveniences. So this fails the build rather
  // than warning, in the same spirit as the ENGINE_CHROME assertion above.
  for (const sp of spaces) {
    // detectUiSkill is pure and is what setSpaceContext used per space, so re-deriving
    // beats stashing module state that would drift.
    const ds = detectUiSkill(sp);
    if (!ds.dirName) continue; // no design system to lose
    const m = manifests[sp.id];
    // GV_ONLY_SPACE (what `augur publish --space <id>` runs) builds ONE space while
    // discovery still lists the siblings, so a space can be present here and emit no
    // manifest at all. Asserting on it would fail a publish over a space this run never
    // touched — which is exactly what it did the first time.
    if (!m) continue;
    const prefix = `${sp.default ? "" : "/" + sp.id}/skills/${ds.dirName}/`;
    // Specifically a STYLESHEET, not merely "some file". graph.js is emitted by the
    // build rather than copied from the skill, so the prefix is never empty — checking
    // for any file at all is a guard that cannot fire. The CSS is what carries the
    // design system, and it is what a broken inventory actually drops.
    const css = m ? Object.keys(m.files).filter((f) => f.startsWith(prefix) && f.endsWith(".css")) : [];
    if (!css.length) {
      throw new Error(
        `[build] space "${sp.id}" has a design system at skills/${ds.dirName}/ but shipped NO stylesheet from it.\n` +
        `  Every prototype in this space would render unstyled — the site would still build,\n` +
        `  still publish and still export, and nobody would notice until they opened a page.\n` +
        `  Check that skills/${ds.dirName}/skill.json "assets" names files that exist (agents/ui-skill.md).`);
    }
  }

  // Stamp each manifest with the engine that BUILT these pages. This is not the same
  // fact as /_build.json's `engine.sha`, which is the last chrome+worker deploy — and
  // the difference is invisible in a way that costs real time: an instance can report a
  // current engine while every page it serves was composed by a much older one, because
  // page-level chrome (the rail, the profile menu, the overlays) is baked into each page
  // at build time and only changes when that SPACE republishes. An engine deploy alone
  // never touches it. Recording it here is what makes the drift detectable at all.
  for (const m of Object.values(manifests)) {
    m.builtWith = { engine: engineSha, ...(ENGINE_VERSION ? { version: ENGINE_VERSION } : {}) };
  }

  await fs.mkdir(path.join(DIST, "__manifests"), { recursive: true });
  for (const [id, m] of Object.entries(manifests))
    await fs.writeFile(path.join(DIST, "__manifests", id + ".json"), JSON.stringify(m), "utf8");

  console.log(`Built dist/ — ${plural(spaces.length, "space")} (${spaces.map((s) => s.id).join(", ")}).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
