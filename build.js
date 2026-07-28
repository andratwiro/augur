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
const DIST = path.join(ROOT, "dist");
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
const IDENTITY_PUBLIC = IDENTITY.map(({ pass, ...u }) => u);
// Lower-cased email → public profile, for mapping git commit authors to a face.
const USER_BY_EMAIL = new Map(IDENTITY_PUBLIC.map((u) => [u.email.toLowerCase(), u]));

// Optional, self-contained build addon. If present it can post-process copied HTML,
// add footer/style/script snippets to shell pages, and emit its own dist files via
// generic hooks (see its source). The site builds identically without it.
let addon = null;
try { addon = await import("./pitis/piti.build.js"); } catch (e) { addon = null; }
const addonHtml = (html) => (addon ? addon.transformHtml(html, UI_VERSION) : html);
const SRC_REVIEW = path.join(ROOT, "src", "review", "comments.js");
const SRC_REVIEW_CAT = path.join(ROOT, "src", "review", "aslam.png");
const SRC_CANVAS_JS = path.join(ROOT, "src", "canvas", "canvas.js");
const SRC_CANVAS_CSS = path.join(ROOT, "src", "canvas", "canvas.css");

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
  return '<!--gv-review-start--><script src="/__review/graph.js?v=' + UI_VERSION +
    '" defer></script><script src="/__review/comments.js?v=' + UI_VERSION +
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
// vanity-host redirects, and the optional AI-builder prompts. Provided by the deploy
// shell via GV_DEPLOY_CONFIG_PATH; a raw engine build runs with empty defaults.
const DEPLOY_CONFIG_PATH = process.env.GV_DEPLOY_CONFIG_PATH || path.join(ROOT, "deploy.config.json");
const DEPLOY = existsSync(DEPLOY_CONFIG_PATH) ? JSON.parse(readFileSync(DEPLOY_CONFIG_PATH, "utf8")) : {};

// Absolute origin used to build absolute og:image / og:url (unfurl bots need
// absolute URLs). From the deploy config; empty → root-relative page URLs.
const SITE_ORIGIN = DEPLOY.siteOrigin || "";

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
const UI_VERSION = "0.92";

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
  // ── tokens: name → declared value (first definition wins) ──────────────────
  const tokensCss = (await readCanon(`${DS.prefix}-tokens.css`)).replace(/\/\*[\s\S]*?\*\//g, "");
  const tokenVals = {};
  for (const m of tokensCss.matchAll(/(--gv-[\w-]+)\s*:\s*([^;]+);/g)) {
    if (!(m[1] in tokenVals)) tokenVals[m[1]] = m[2].trim();
  }
  const refsOf = (v) => [...new Set([...v.matchAll(/var\(\s*(--gv-[\w-]+)/g)].map((x) => x[1]))];
  // Resolve a token's alias chain down to the first non-(solo-var) value = its raw.
  function resolve(name, seen) {
    seen = seen || new Set();
    if (seen.has(name) || !(name in tokenVals)) return { chain: [name], raw: tokenVals[name] || null };
    seen.add(name);
    const v = tokenVals[name];
    const solo = v.match(/^var\(\s*(--gv-[\w-]+)\s*\)$/);
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
      const vars = [...new Set([...body.matchAll(/var\(\s*(--gv-[\w-]+)/g)].map((x) => x[1]))];
      // Subject family = the first .gv-/.sv- class of each comma-separated part.
      const fams = new Set();
      for (const part of sel.split(",")) {
        const m = part.trim().match(/\.((?:gv|sv)-[\w-]+)/);
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
 * Two subtleties this solves (both bit us on 2026-07-02):
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
 * Returns { file: Map<relPath, {t,email}>, dir: Map<relDirPath, {t,email}> } or
 * null when git/history is unavailable (untracked content falls back to fs mtime).
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
    const tokens = raw.split("\0");
    const alias = new Map();   // historical path → today's path
    const file = new Map();    // today's path → {t, email} of last real change
    const cur = (p) => alias.get(p) || p;
    let t = 0, email = "";
    for (let i = 0; i < tokens.length; i++) {
      let tok = tokens[i];
      if (!tok) continue;
      const at = tok.indexOf("\x01");
      if (at !== -1) { // commit header (may be glued to the previous record's tail)
        const head = tok.slice(at + 1).trim().split(" ");
        t = Number(head[0]) * 1000;
        email = (head[1] || "").toLowerCase();
        tok = tok.slice(0, at);
        if (!tok) continue;
      }
      const st = tok[0];
      if (st === "R" || st === "C") {
        const from = tokens[++i], to = tokens[++i];
        if (to === undefined) break;
        const today = cur(to);
        if (st === "R") alias.set(from, today);
        // A pure rename (R100) isn't an edit; a rename-with-change (R0xx) and any
        // copy are. Stamp only the newest occurrence (we walk newest→oldest).
        if (tok !== "R100" && !file.has(today)) file.set(today, { t, email });
      } else { // A / M / T / D — single path
        const p = tokens[++i];
        if (p === undefined) break;
        if (st === "D") continue; // deleted names don't exist today
        const today = cur(p);
        if (!file.has(today)) file.set(today, { t, email });
      }
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
    parsed = { file, dir };
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
 * Last real-change author email for a folder, mapped to an internal user (a "face"
 * on the card). Same rename-transparent map as modifiedTime — a repo restructure
 * doesn't claim authorship of every card. Returns the public profile of a known
 * user, or null (uncommitted folder, or an author we don't know).
 */
function lastEditor(absDir) {
  const d = dateFor(absDir);
  return d && d.email ? USER_BY_EMAIL.get(d.email) || null : null;
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
    name.endsWith(".zip")
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
        editor: lastEditor(protoDir),
      });
    }

    if (prototypes.length === 0) continue;

    prototypes.sort(byStatusThenRecency);
    opportunities.push({
      name: top.name,
      prototypes,
      research: await scanResearch(path.join(WS_ROOT, top.name)),
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
      poster: await exists(path.join(dir, "preview.webp")),
      mtimeMs: modifiedTime(dir, await latestMtime(dir)),
      status: statusMap[`${SPACE_KEY}playground/${e.name}`] || "in-progress",
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
      flex: none; width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center;
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
    .page-grid.is-3up { grid-template-columns: repeat(3, 1fr); }
    @media (max-width: 760px) { .page-grid.is-3up { grid-template-columns: repeat(2, 1fr); } }
    @media (max-width: 480px) { .page-grid.is-3up { grid-template-columns: 1fr; } }
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
    @media (prefers-reduced-motion: reduce) { .gv-ctx, .gv-toast { animation: none; transition: none; } }

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
    .wrap--wide { max-width: 1280px; }
    /* Auto-fill grid: as many ~248px columns as fit, no carousel. */
    .opp-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 22px; }
    @media (max-width: 760px) { .opp-grid { grid-template-columns: repeat(2, 1fr); } }
    @media (max-width: 480px) { .opp-grid { grid-template-columns: 1fr; } }

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
      function loadFrame(p) {
        var f = p.querySelector('iframe');
        if (!f || f.dataset.gvLoaded) return;
        f.dataset.gvLoaded = '1';
        f.addEventListener('load', function () { reveal(p); });
        var src = f.getAttribute('data-src');
        if (src) f.src = src; // navigates the iframe to the real page
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
      align-items: center; gap: 12px; padding: 0 14px;
      background: rgba(255,255,255,0.82); -webkit-backdrop-filter: blur(14px) saturate(180%); backdrop-filter: blur(14px) saturate(180%);
      border-bottom: 1px solid rgba(16,17,26,0.09);
      font: 600 14.5px/1 "Inter", "Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    .gvtop__brand { display: inline-flex; align-items: center; gap: 9px; color: #16171a; text-decoration: none; letter-spacing: 0; }
    .gvtop__brand span { font-family: var(--font-display); font-weight: 800; font-size: 16px; }
    .gvburger {
      width: 36px; height: 34px; flex: none; padding: 0; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: 9px; border: 1px solid rgba(16,17,26,0.12); background: rgba(16,17,26,0.03); color: #16171a;
      transition: background .12s ease, border-color .12s ease;
    }
    .gvburger:hover { background: rgba(16,17,26,0.06); border-color: rgba(16,17,26,0.20); }
    .gvburger:focus-visible { outline: 2px solid #5e6ad2; outline-offset: 1px; }
    .gvburger__bars { position: relative; display: block; width: 16px; height: 12px; }
    .gvburger__bars span { position: absolute; left: 0; right: 0; height: 2px; border-radius: 2px; background: currentColor; transition: transform .18s ease, opacity .12s ease, top .18s ease; }
    .gvburger__bars span:nth-child(1) { top: 0; }
    .gvburger__bars span:nth-child(2) { top: 5px; }
    .gvburger__bars span:nth-child(3) { top: 10px; }
    .gvburger[aria-expanded="true"] .gvburger__bars span:nth-child(1) { top: 5px; transform: rotate(45deg); }
    .gvburger[aria-expanded="true"] .gvburger__bars span:nth-child(2) { opacity: 0; }
    .gvburger[aria-expanded="true"] .gvburger__bars span:nth-child(3) { top: 5px; transform: rotate(-45deg); }

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
    .gvtop__brand .gvmark { width: 22px; height: 22px; }

    /* Profile chip — the signed-in face + dropdown, in the brand spot. Hidden until
       PROFILE_JS confirms a logged-in user (open/no-identity builds show nothing). */
    .gvprof { position: relative; margin: 0 0 6px; }
    .gvprof__btn {
      display: flex; align-items: center; gap: 8px; width: 100%; padding: 5px 8px;
      border: 1px solid transparent; border-radius: 8px; background: none; cursor: pointer;
      font: inherit; color: #16171a; text-align: left; transition: background .12s ease;
    }
    .gvprof__btn:hover { background: rgba(16,17,26,0.05); }
    .gvprof__btn:focus-visible { outline: 2px solid #5e6ad2; outline-offset: 1px; }
    .gvprof__btn[aria-expanded=true] { background: rgba(16,17,26,0.06); }
    .gvprof__av {
      flex: none; width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center;
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

    /* Space switcher — active space icon+name+badge with a dropdown of all spaces.
       Server-rendered from the build-time space list; SPACE_JS only toggles the menu.
       Admin-only: only Rob owns the 2.0 workspace, so the switcher is hidden by default
       and revealed once /__me confirms an admin (html.gv-admin) — same reveal mechanism
       as the other admin surfaces. Regular users (Irene, Tali) never see it. */
    .gvspace { display: none; position: relative; margin: 2px 1px 8px; }
    html.gv-admin .gvspace { display: block; }
    .gvspace__btn {
      display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px;
      border: 1px solid rgba(16,17,26,0.10); border-radius: 8px; background: #fff; cursor: pointer;
      font: inherit; color: #16171a; text-align: left; transition: background .12s ease, border-color .12s ease;
    }
    .gvspace__btn:hover { background: rgba(16,17,26,0.03); border-color: rgba(16,17,26,0.16); }
    .gvspace__btn:focus-visible { outline: 2px solid #5e6ad2; outline-offset: 1px; }
    .gvspace__btn[aria-expanded=true] { background: rgba(16,17,26,0.04); }
    .gvspace__icon { flex: none; width: 20px; height: 20px; border-radius: 5px; overflow: hidden; display: grid; place-items: center; background: #fff; }
    .gvspace__icon img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .gvspace__name { flex: 1 1 auto; min-width: 0; font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .gvspace__cv { width: 15px; height: 15px; flex: none; color: #9aa0ab; }
    .gvspace__badge { flex: none; font-size: 10px; font-weight: 700; letter-spacing: .02em; text-transform: capitalize;
      padding: 1px 6px; border-radius: 999px; background: rgba(16,17,26,0.07); color: #5b626e; }
    .gvspace__badge.is-new { background: #2c2150; color: #fff; }
    .gvspace__menu {
      position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 6;
      background: #fff; border: 1px solid rgba(16,17,26,0.12); border-radius: 10px; padding: 5px;
      box-shadow: 0 1px 2px rgba(16,24,40,0.05), 0 12px 30px -16px rgba(16,24,40,0.30);
    }
    .gvspace__item { display: flex; align-items: center; gap: 9px; padding: 7px 8px; border-radius: 7px; text-decoration: none; color: #16171a; font-size: 13px; font-weight: 500; }
    .gvspace__item:hover { background: rgba(16,17,26,0.05); }
    .gvspace__iname { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .gvspace__chk { width: 16px; height: 16px; flex: none; color: #5e6ad2; opacity: 0; }
    .gvspace__item.is-active .gvspace__chk { opacity: 1; }
    .gvspace__sep { height: 1px; background: rgba(16,17,26,0.08); margin: 4px 2px; }
    .gvspace__create { display: flex; align-items: center; gap: 9px; width: 100%; padding: 7px 8px; border: 0; border-radius: 7px; background: none; cursor: pointer; font: inherit; font-size: 13px; font-weight: 500; color: #5b626e; }
    .gvspace__create:hover { background: rgba(16,17,26,0.05); color: #16171a; }
    .gvspace__create svg { width: 15px; height: 15px; flex: none; }

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
    .gvsearch__clear {
      position: absolute; right: 7px; top: 50%; transform: translateY(-50%);
      width: 22px; height: 22px; padding: 0; display: grid; place-items: center;
      border: 0; border-radius: 6px; background: transparent; color: #6b7280;
      font-size: 17px; line-height: 1; cursor: pointer;
    }
    .gvsearch__clear:hover { background: rgba(16,17,26,0.08); color: #16171a; }
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
    .gvside a[aria-current="page"] .gvic { color: #16171a; }
    /* Pinned rows: the leading emoji sits in the same slot a nav icon would. */
    .gvpin-ic { width: 16px; flex: none; display: inline-flex; align-items: center; justify-content: center; font-size: 14px; line-height: 1; }
    .gvside__pinhint { color: #6b7280; font-size: 12px; line-height: 1.45; margin: 2px 8px 2px; }
    .gvside [data-pinned-list] a { cursor: grab; }
    .gvside [data-pinned-list] a.gv-dragging { opacity: .45; cursor: grabbing; }

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

    /* Mobile drawer scrim. */
    .gvscrim { display: none; position: fixed; inset: 0; z-index: 2147483099; background: rgba(16,17,26,0.34); opacity: 0; transition: opacity .2s ease; }

    @media (max-width: 860px) {
      body { padding-left: 0; padding-top: 52px; }
      .gvtop { display: flex; }
      .gvside { transform: translateX(-100%); transition: transform .22s ease; box-shadow: 0 24px 60px -20px rgba(16,24,40,0.40); }
      .gvside.is-open { transform: translateX(0); }
      .gvscrim.is-open { display: block; opacity: 1; }
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

    @media (prefers-reduced-motion: reduce) {
      .gvside, .gvscrim, .gvburger__bars span, .gvside__caret, .gvhelp__scrim, .gvhelp__panel { transition: none; }
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
const GV_MARK = `<img class="gvmark" src="/augur-eye.svg" alt="" aria-hidden="true" width="24" height="24" />`;

// Rail item glyphs — real Lucide icons (ISC license), the clean line set Linear-class
// apps use. Verbatim official paths, rendered at a refined 1.75 stroke for that crisp
// Linear weight; 24px viewBox, currentColor, tinted/sized via .gvic.
const ic = (inner) => `<svg class="gvic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
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
// Static (landing card): at-a-glance count only, no popover (clicks fall through to
// the card's cover link, which opens the opportunity where the chip is interactive).
function researchTag(research) {
  if (!research || !research.length) return "";
  const label = researchLabel(research.length);
  return `<span class="research-tag" title="${label}" aria-label="${label}">${IC_RESEARCH}<span class="research-chip__n">${research.length}</span></span>`;
}
const IC_LIBRARY = ic(`<path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/>`); // library
const IC_CHANGELOG = ic(`<path d="M12 8v4l3 2"/><path d="M3.05 11a9 9 0 1 1 .5 4"/><path d="M3 21v-5h5"/>`); // history (clock + counter-rotate)
const IC_CHEV = ic(`<path d="m9 18 6-6-6-6"/>`); // chevron-right (rotates open via CSS)
const IC_GEAR = ic(`<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>`); // settings
const IC_SIGNOUT = ic(`<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>`); // log-out
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

// A small avatar for the prototype's last git-commit author (mapped to an internal
// user by build's lastEditor). "" when the author is unknown / uncommitted.
function editorChip(ed) {
  if (!ed) return "";
  const ini = (ed.initials || (ed.name || "?").slice(0, 2)).toUpperCase();
  const style = ed.avatar
    ? `background-image:url('${ed.avatar}')`
    : `background:${ed.color || "#4f46e5"}`;
  return `<span class="proto-editor" style="${style}" title="Last edited by ${escAttr(ed.name)}" aria-label="Last edited by ${escAttr(ed.name)}">${ed.avatar ? "" : escAttr(ini)}</span>`;
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

// The omni search field — lives in the rail, filters whatever cards are on the right
// (the shared chrome script wires [data-filter] to the current page's [data-fitem]).
function railSearch() {
  return `<div class="gvsearch">${SEARCH_ICON}` +
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
        <svg class="gvprof__cv" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <div class="gvprof__menu" data-prof-menu role="menu" hidden>
        <div class="gvprof__id">
          <span class="gvprof__av lg" data-prof-av aria-hidden="true"></span>
          <span class="gvprof__idtext"><span class="gvprof__name" data-prof-name></span><span class="gvprof__email" data-prof-email></span></span>
        </div>
        <a class="gvprof__item" href="/admin/" role="menuitem" data-prof-admin hidden>${IC_GEAR}<span>Admin settings</span></a>
        <a class="gvprof__item" href="/__logout" role="menuitem" data-prof-signout>${IC_SIGNOUT}<span>Sign out</span></a>
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
  if (spaces.length < 2) return "";
  const active = spaces.find((s) => s.id === NAV_STATE.activeSpace) || spaces[0];
  const icon = `<span class="gvspace__icon"><img src="/space-icon.png" alt="" width="20" height="20" /></span>`;
  const badge = (b) => (b ? `<span class="gvspace__badge${b === "new" ? " is-new" : ""}">${escAttr(b)}</span>` : "");
  const rows = spaces
    .map(
      (s) => `<a class="gvspace__item${s.id === active.id ? " is-active" : ""}" href="${s.base}/" role="menuitemradio" aria-checked="${s.id === active.id}">
          ${icon}<span class="gvspace__iname">${escAttr(s.name)}</span>${badge(s.badge)}
          <svg class="gvspace__chk" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>
        </a>`
    )
    .join("");
  return `<div class="gvspace" data-space>
      <button type="button" class="gvspace__btn" data-space-toggle aria-haspopup="true" aria-expanded="false" aria-label="Switch space">
        ${icon}<span class="gvspace__name">${escAttr(active.name)}</span>${badge(active.badge)}
        <svg class="gvspace__cv" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <div class="gvspace__menu" data-space-menu role="menu" hidden>
        ${rows}
        <div class="gvspace__sep"></div>
        <button type="button" class="gvspace__create" data-space-create>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
          <span>Create new</span>
        </button>
      </div>
    </div>`;
}

// The persistent left rail: brand → omni search → Playground → Opportunities → Pinned
// (the user's starred prototypes/projects, rendered client-side by PINS_JS) → Library
// (collapsible, pinned to the bottom). `active` is a single key: 'prototypes' |
// 'playground' | <opportunity name> | 'primitives' | 'components' | 'pages'.
function sideRail(active) {
  const item = (href, label, key, icon) =>
    `<a href="${S(href)}"${active === key ? ' aria-current="page"' : ""}>${icon}<span>${label}</span></a>`;
  const playground = NAV_STATE.hasPlayground ? item("/playground/", "Playground", "playground", IC_PLAY) : "";
  // Pinned is rendered live from the KV pins map (PINS_JS fills [data-pinned-list] and
  // toggles the empty hint); nothing is server-rendered here.
  const pinned = `<p class="gvside__label">Pinned</p>
      <div class="gvside__group" data-pinned-list></div>
      <p class="gvside__pinhint" data-pinned-empty hidden>Star a prototype to pin it here.</p>`;
  // Library is a collapsible section in the pinned foot (Changelog sits below it);
  // collapsed by default, auto-opens when you're on one of its pages. Its own icon
  // leads; the disclosure chevron sits on the right.
  // Layered design system: Tokens → Base → Components → Patterns → Pages.
  const LIB_KEYS = ["tokens", "base", "components", "patterns", "pages", "primitives"];
  const libOpen = LIB_KEYS.includes(active);
  const library = `<details class="gvside__sect"${libOpen ? " open" : ""}>
      <summary class="gvside__sum"><span>Library</span><span class="gvside__caret" aria-hidden="true">${IC_CHEV}</span></summary>
      <div class="gvside__group">
        ${item("/tokens/", "Tokens", "tokens", IC_TOKEN)}
        ${item("/base/", "Base", "base", IC_PRIM)}
        ${item("/components/", "Components", "components", IC_COMP)}
        ${item("/patterns/", "Patterns", "patterns", IC_PATTERN)}
        ${item("/pages/", "Pages", "pages", IC_PAGE)}
      </div>
    </details>`;
  return `<aside class="gvside" id="gvside" aria-label="Augur">
    ${profileChip()}
    ${railSearch()}
    <div class="gvside__rule"></div>
    ${spaceSwitcher()}
    <div class="gvside__scroll">
      <div class="gvside__group">
        ${item("/", PROJECTS_LABEL, "prototypes", IC_HOME)}
        ${playground}
      </div>
      ${pinned}
    </div>
    <div class="gvside__foot">
      <div class="gvside__rule"></div>
      ${library}
      <div class="gvside__group" style="margin-top:6px">
        <button type="button" class="gvside__act" data-help-open>${IC_HELP}<span>Help</span></button>
        <a href="/changelog/"${active === "changelog" ? ' aria-current="page"' : ""}>${IC_CHANGELOG}<span>Changelog</span><span class="gvside__ver">v${UI_VERSION}</span></a>
      </div>
    </div>
  </aside>`;
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
// Two tracks: Reviewing (stakeholders giving feedback) + Building (driving Claude). Present
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
          <ul><li>Claude may answer or resolve your comment in-thread. That is the comment loop (see Building).</li></ul>
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

          <h4>Comment loop <span class="gvhelp__tag">godmode</span></h4>
          <ul>
            <li><code>npm run review --open</code> lists open threads.</li>
            <li>Claude fixes, replies, resolves in-thread. Put it on <code>/loop</code> to keep watching.</li>
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

// Full chrome injected at the top of <body>: slim mobile top bar + the rail + the
// drawer scrim (the last two are off-canvas / hidden on desktop via CSS).
function appChrome(active) {
  const top = `<header class="gvtop">
    <button type="button" class="gvburger" data-side-toggle aria-expanded="false" aria-controls="gvside" aria-label="Open navigation"><span class="gvburger__bars" aria-hidden="true"><span></span><span></span><span></span></span></button>
    <a class="gvtop__brand" href="${S("/")}">${GV_MARK}<span>augur</span></a>
  </header>`;
  return `${top}${sideRail(active)}<div class="gvscrim" data-side-scrim></div>${helpDrawer()}`;
}

/** Shared chrome script: real-time in-page filter + the mobile rail drawer. */
function chromeScript() {
  return `(function(){
  // ── In-page real-time filter ─────────────────────────────────────────────
  var input = document.querySelector('[data-filter]');
  if (input && !input.dataset.wired) {
    input.dataset.wired = '1';
    var clear = document.querySelector('[data-filter-clear]');
    var kbd = document.querySelector('[data-filter-kbd]');
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
    var isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
    document.addEventListener('keydown', function(e){
      var k = (e.key || '').toLowerCase();
      var el = document.activeElement, tag = el && el.tagName;
      var typing = tag === 'INPUT' || tag === 'TEXTAREA' || (el && el.isContentEditable);
      if((e.metaKey || e.ctrlKey) && k === 'k'){ e.preventDefault(); input.focus(); input.select(); return; }
      if(k === '/' && !typing){ e.preventDefault(); input.focus(); }
    });
    apply();
  }

  // ── Mobile rail drawer (hamburger + scrim) ───────────────────────────────
  var sideToggle = document.querySelector('[data-side-toggle]');
  var side = document.getElementById('gvside');
  var scrim = document.querySelector('[data-side-scrim]');
  if(sideToggle && side){
    function closeSide(){ sideToggle.setAttribute('aria-expanded','false'); side.classList.remove('is-open'); if(scrim) scrim.classList.remove('is-open'); }
    function openSide(){ sideToggle.setAttribute('aria-expanded','true'); side.classList.add('is-open'); if(scrim) scrim.classList.add('is-open'); }
    sideToggle.addEventListener('click', function(e){ e.stopPropagation(); side.classList.contains('is-open') ? closeSide() : openSide(); });
    if(scrim) scrim.addEventListener('click', closeSide);
    side.addEventListener('click', function(e){ if(e.target.closest('a')) closeSide(); });
    document.addEventListener('keydown', function(e){ if((e.key||'').toLowerCase() === 'escape') closeSide(); });
    window.addEventListener('resize', function(){ if(window.innerWidth > 860) closeSide(); });
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

/** Inject the nav (with its own styles) right after the opening <body> tag. */
function injectNav(html, active) {
  const m = html.match(/<body[^>]*>/i);
  if (!m) return html;
  return html.replace(
    m[0],
    `${m[0]}\n  <style>${NAV_CSS}</style>\n  ${appChrome(active)}\n  <script>${chromeScript()}</script>\n  <script>${spaceContextScript()}</script>\n  <script>${PINS_JS}</script>\n  <script>${PROFILE_JS}</script>\n  <script>${SPACE_JS}</script>`
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
  function deleteCard(c){
    var nm=((nameEl(c)&&nameEl(c).textContent)||'this prototype').trim();
    if(!confirm('Delete "'+nm+'" for good?\\n\\nThis can\\'t be undone from here. The card is removed from view now; ask Claude to delete the files to finalize.')) return;
    c.style.transition='opacity .15s ease'; c.style.opacity='0';
    setTimeout(function(){ c.remove(); },160);
    showToast('Removed — tell Claude: delete "'+nm+'"');
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
      else if(!val||val===def){ el.textContent=def; c.setAttribute('data-fkey',def); if(prev!==def) persistName(key,''); }
      else { el.textContent=val; c.setAttribute('data-fkey',val); persistName(key,val); }
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
    // Delete intentionally removed from the UI — too risky (deleting prototypes is a
    // repo edit; ask Claude to remove files instead).
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
  var chips = Array.prototype.slice.call(document.querySelectorAll('[data-status-key]'));
  if(!chips.length) return;
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
    chip.setAttribute('aria-label', 'Status: ' + m.label + '. Click to change.');
    chip.setAttribute('title', 'Status: ' + m.label + '. Click to change.');
  }
  function applyMap(map){
    chips.forEach(function(chip){
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
  // First paint from the per-session cache if we have it — skips the network read.
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
      var cur = chip.getAttribute('data-status') || 'ignore';
      var next = ORDER[(ORDER.indexOf(cur) + 1 + ORDER.length) % ORDER.length];
      paint(chip, next);
      resort();
      chip.disabled = true;
      fetch('/__status', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ key: chip.getAttribute('data-status-key'), status: next })
      }).then(function(r){ return r.json(); }).then(function(d){
        if(d && d.map){
          try { sessionStorage.setItem(CACHE, JSON.stringify(d.map)); } catch(e){}
          var k = chip.getAttribute('data-status-key');
          paint(chip, d.map[k] || 'ignore');
          resort();
        }
      }).catch(function(){ paint(chip, cur); resort(); }).then(function(){ chip.disabled = false; });
    });
  });
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
  var listEl = document.querySelector('[data-pinned-list]');
  var emptyEl = document.querySelector('[data-pinned-empty]');
  var btns = Array.prototype.slice.call(document.querySelectorAll('[data-pin-key]'));
  if(!listEl && !btns.length) return;
  var PCACHE = 'gv_pins_map';
  var EMO = /^(\\p{Extended_Pictographic}(\\uFE0F)?(\\u200D\\p{Extended_Pictographic}(\\uFE0F)?)*)\\s*/u;
  var map = {};
  var loaded = false; // have we synced an authoritative map from the server this session?
  function splitEmoji(s){ s = s || ''; var m; try { m = s.match(EMO); } catch(e){ m = null; } return m ? [m[1], s.slice(m[0].length)] : ['', s]; }
  function esc(s){ return (s||'').replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
  // Scope the rendered pin list to the CURRENT space. Pins live in one per-user bucket
  // across spaces (keys are full URL paths, e.g. "/opp/proto/" or "/go-vocal-2/opp/proto/"),
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
    if(!listEl) return;
    var keys = Object.keys(map).filter(inSpace);
    listEl.innerHTML = keys.map(function(k){
      var it = map[k] || {}; var parts = splitEmoji(labelOf(k, it));
      var glyph = parts[0] || '📌';
      var txt = esc(parts[1] || it.label || k);
      var cur = (it.href === location.pathname) ? ' aria-current="page"' : '';
      return '<a href="'+esc(it.href||k)+'" draggable="true" data-k="'+esc(k)+'"'+cur+'><span class="gvpin-ic" aria-hidden="true">'+esc(glyph)+'</span><span>'+txt+'</span></a>';
    }).join('');
    if(emptyEl) emptyEl.hidden = keys.length > 0;
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
  btns.forEach(function(b){
    b.addEventListener('click', function(e){
      e.preventDefault(); e.stopPropagation();
      var key = b.getAttribute('data-pin-key'), href = b.getAttribute('data-pin-href') || key, lbl = labelFor(b);
      ready(function(){
        if(Object.prototype.hasOwnProperty.call(map, key)){ delete map[key]; } else { map[key] = { label: lbl, href: href }; }
        renderList(); paintBtns();
        save(Object.keys(map).length === 0);
      });
    });
  });
  // ---- drag-and-drop reorder of the pinned list ----
  if(listEl){
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
    listEl.addEventListener('keydown', function(e){
      var a = e.target.closest('a'); if(!a || !e.altKey) return;
      if(e.key === 'ArrowUp'){ e.preventDefault(); var p = a.previousElementSibling; if(p){ listEl.insertBefore(a, p); a.focus(); persistOrder(); } }
      else if(e.key === 'ArrowDown'){ e.preventDefault(); var n = a.nextElementSibling; if(n){ listEl.insertBefore(n, a); a.focus(); persistOrder(); } }
    });
  }
  window.addEventListener('storage', function(e){ if(e.key === PCACHE){ try { var nv = JSON.parse(e.newValue || '{}'); map = nv; renderList(); paintBtns(); } catch(_){} } });
})();
`;

// Profile chip behaviour: fetch the signed-in user from /__me, fill the avatar /
// name / email, reveal the admin link for admins, and reveal the whole chip (it's
// hidden until we confirm a user, so open/no-identity builds stay clean). Plus the
// dropdown open/close (outside-click + Escape to dismiss).
const PROFILE_JS = `(function(){
  var box = document.querySelector('[data-prof]');
  if(!box) return;
  function initials(u){ return (u.initials || (u.name||'?').slice(0,2)).toUpperCase(); }
  function paint(u){
    var avs = box.querySelectorAll('[data-prof-av]');
    for(var i=0;i<avs.length;i++){
      var a = avs[i];
      if(u.avatar){ a.style.backgroundImage = 'url("'+u.avatar+'")'; a.textContent=''; }
      else { a.style.background = u.color || '#4f46e5'; a.textContent = initials(u); }
    }
    var names = box.querySelectorAll('[data-prof-name]');
    for(var j=0;j<names.length;j++) names[j].textContent = u.name || u.email;
    var em = box.querySelector('[data-prof-email]'); if(em) em.textContent = u.email || '';
    // style.display, not [hidden]: .gvprof__item sets display:flex and out-specifies
    // the [hidden] rule (same gotcha as the brand), so non-admins kept seeing this.
    var adm = box.querySelector('[data-prof-admin]'); if(adm) adm.style.display = u.admin ? 'flex' : 'none';
    // Admin-only surfaces (e.g. the Pitis paw) reveal via html.gv-admin.
    document.documentElement.classList.toggle('gv-admin', !!u.admin);
    box.hidden = false;
  }
  fetch('/__me', {headers:{'Accept':'application/json'}}).then(function(r){ return r.json(); })
    .then(function(d){ if(d && d.user) paint(d.user); }).catch(function(){});
  var btn = box.querySelector('[data-prof-toggle]');
  var menu = box.querySelector('[data-prof-menu]');
  function open(o){ if(!menu) return; menu.hidden = !o; if(btn) btn.setAttribute('aria-expanded', o ? 'true' : 'false'); }
  if(btn && menu){
    btn.addEventListener('click', function(e){ e.stopPropagation(); open(menu.hidden); });
    document.addEventListener('click', function(e){ if(!box.contains(e.target)) open(false); });
    document.addEventListener('keydown', function(e){ if(e.key === 'Escape') open(false); });
  }
})();
`;

// Space switcher behaviour — open/close the dropdown (the chip + rows are server-rendered,
// each row a plain <a> to the space's base URL, so switching is just navigation). The
// Create-new entry is a stub: spaces are REPOS (one repo per space, mounted as Augur
// submodules at spaces/<id>), so creating one is a maintainer act, not an in-app feature.
const SPACE_JS = `(function(){
  var box = document.querySelector('[data-space]');
  if(!box) return;
  var btn = box.querySelector('[data-space-toggle]');
  var menu = box.querySelector('[data-space-menu]');
  function open(o){ if(!menu) return; menu.hidden = !o; if(btn) btn.setAttribute('aria-expanded', o ? 'true' : 'false'); }
  if(btn && menu){
    btn.addEventListener('click', function(e){ e.stopPropagation(); open(menu.hidden); });
    document.addEventListener('click', function(e){ if(!box.contains(e.target)) open(false); });
    document.addEventListener('keydown', function(e){ if(e.key === 'Escape') open(false); });
  }
  var create = box.querySelector('[data-space-create]');
  if(create) create.addEventListener('click', function(e){
    e.stopPropagation();
    alert('Spaces are repos: to add one, create a new GitHub repo templated from go-vocal (space.json + DS assets at its root), mount it in Augur as a submodule at spaces/<id>, and give it the deploy-trigger workflow. Ask Rob.');
  });
})();
`;

// Admin page behaviour: load every user from /__admin/users (admin-only — 403s for
// anyone else, though the worker also gates the /admin/ route) and render an editable
// password row per user. Saving POSTs the new password; the worker stores it as a KV
// override and that user's cookie stops matching, so they re-login with the new one.
const ADMIN_JS = `(function(){
  var host = document.querySelector('[data-admin-users]');
  if(!host) return;
  function esc(s){ return (s||'').replace(/[&<>"]/g,function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
  function ago(iso){
    if(!iso) return 'never';
    var t = Date.parse(iso); if(isNaN(t)) return 'never';
    var s = (Date.now() - t) / 1000;
    if(s < 90) return 'just now';
    if(s < 3600) return Math.floor(s/60) + ' min ago';
    if(s < 86400) return Math.floor(s/3600) + ' h ago';
    var d = Math.floor(s/86400);
    if(d === 1) return 'yesterday';
    if(d < 30) return d + ' days ago';
    return new Date(t).toLocaleDateString();
  }
  function row(u){
    var ini = (u.initials || (u.name||'?').slice(0,2)).toUpperCase();
    var badge = u.role === 'admin' ? ' <span class="au__badge">admin</span>' : '';
    return '<div class="au" data-email="'+esc(u.email)+'">'
      + '<span class="au__av" style="background:'+esc(u.color||'#4f46e5')+'">'+esc(ini)+'</span>'
      + '<span class="au__id"><span class="au__name">'+esc(u.name)+badge+'</span><span class="au__email">'+esc(u.email)+'</span></span>'
      + '<span class="au__seen'+(u.lastSeen ? '' : ' au__seen--never')+'" title="'+(u.lastSeen ? 'Last connection: '+esc(u.lastSeen) : 'Never signed in')+'">'+esc(ago(u.lastSeen))+'</span>'
      + '<span class="au__pw"><input type="text" class="au__input" value="'+esc(u.pass)+'" aria-label="Password for '+esc(u.email)+'" autocapitalize="off" autocorrect="off" spellcheck="false" />'
      + '<button type="button" class="au__save">Save</button><span class="au__msg" aria-live="polite"></span></span>'
      + '</div>';
  }
  function wire(){
    var rows = host.querySelectorAll('.au');
    for(var i=0;i<rows.length;i++){ (function(el){
      var btn = el.querySelector('.au__save'), inp = el.querySelector('.au__input'), msg = el.querySelector('.au__msg');
      btn.addEventListener('click', function(){
        var pass = inp.value;
        if(!pass){ msg.textContent = 'empty'; return; }
        btn.disabled = true; msg.textContent = '…';
        fetch('/__admin/users',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email: el.getAttribute('data-email'), pass: pass }) })
          .then(function(r){ return r.json(); })
          .then(function(d){ btn.disabled = false; msg.textContent = d && d.ok ? 'saved ✓' : (d && d.error) || 'error'; setTimeout(function(){ msg.textContent = ''; }, 2500); })
          .catch(function(){ btn.disabled = false; msg.textContent = 'error'; });
      });
    })(rows[i]); }
  }
  fetch('/__admin/users',{headers:{'Accept':'application/json'}}).then(function(r){
    if(r.status === 403){ host.innerHTML = '<p class="empty">Admins only.</p>'; return null; }
    return r.json();
  }).then(function(d){
    if(!d) return;
    if(!d.users){ host.innerHTML = '<p class="empty">Could not load users.</p>'; return; }
    // Most recent connection first; never-signed-in sink to the bottom (A–Z within ties).
    d.users.sort(function(a,b){
      var ta = a.lastSeen ? Date.parse(a.lastSeen) : 0, tb = b.lastSeen ? Date.parse(b.lastSeen) : 0;
      return (tb - ta) || (a.name || '').localeCompare(b.name || '');
    });
    host.innerHTML = d.users.map(row).join('');
    wire();
  }).catch(function(){ host.innerHTML = '<p class="empty">Could not load users.</p>'; });
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
  <meta name="viewport" content="width=device-width, initial-scale=1" />
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

function renderAdminPage() {
  const body = `<style>
    .admin-intro{ color:#5b626e; font-size:14px; margin:0 0 18px; max-width:62ch; line-height:1.6; }
    .admin-users{ display:flex; flex-direction:column; gap:8px; max-width:700px; }
    .au{ display:flex; align-items:center; gap:12px; padding:11px 14px; border:1px solid rgba(16,17,26,0.09); border-radius:12px; background:#fff; }
    .au__av{ flex:none; width:34px; height:34px; border-radius:50%; display:grid; place-items:center; color:#fff; font-weight:700; font-size:12px; text-transform:uppercase; }
    .au__id{ display:flex; flex-direction:column; min-width:0; flex:1 1 auto; }
    .au__name{ font-weight:600; font-size:14px; display:flex; align-items:center; gap:7px; }
    .au__badge{ font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; color:#4f46e5; background:rgba(79,70,229,.1); padding:1px 6px; border-radius:5px; }
    .au__email{ font-size:12.5px; color:#5b626e; }
    .au__seen{ flex:none; font-size:12.5px; color:#5b626e; white-space:nowrap; margin-right:14px; }
    .au__seen--never{ color:#9aa0ab; font-style:italic; }
    .au__pw{ display:flex; align-items:center; gap:8px; flex:none; }
    .au__input{ font:inherit; font-size:13px; padding:6px 10px; border:1px solid rgba(16,17,26,0.15); border-radius:8px; width:160px; background:#fff; }
    .au__input:focus{ outline:2px solid #5e6ad2; outline-offset:1px; border-color:transparent; }
    .au__save{ font:inherit; font-size:13px; font-weight:600; padding:6px 13px; border-radius:8px; border:1px solid transparent; background:#2c2150; color:#fff; cursor:pointer; }
    .au__save:hover{ background:#38295e; }
    .au__save:disabled{ opacity:.5; cursor:default; }
    .au__msg{ font-size:12px; color:#5b626e; min-width:42px; }
    @media (max-width:620px){ .au{ flex-wrap:wrap; } .au__pw{ width:100%; } .au__input{ flex:1 1 auto; width:auto; } }
  </style>
  <header class="folderbar"><h1 class="folderbar__title">Admin</h1><span class="folderbar__rule"></span></header>
  <p class="admin-intro">Internal users and their passwords (admin-only). Editing a password saves immediately and signs that person out — they sign back in with the new one. Names, emails and roles live in <code>src/identity.json</code>.</p>
  <div class="admin-users" data-admin-users><p class="empty">Loading…</p></div>
  <script>${ADMIN_JS}</script>`;
  return shell({ title: "Admin · Augur", activeTab: "admin", body });
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
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>${title}</title>
  <link rel="icon" type="image/png" href="/augur-mark.png?v=${UI_VERSION}" />
  <link rel="apple-touch-icon" href="/augur-mark.png?v=${UI_VERSION}" />
  <link rel="manifest" href="/manifest.webmanifest" />
  <meta name="theme-color" content="#2C2150" />
  <link rel="preload" href="/fonts/inter-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin />
  <style>${FONT_CSS}${PAGE_CSS}${NAV_CSS}${addon ? addon.css() : ""}
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
  <script>${SPACE_JS}
  </script>
  <script>${RESEARCH_JS}
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
            <div class="opp-name-row"><div class="proto-name">${titleCase(opp.name)}</div>${researchTag(opp.research)}</div>
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
        <div class="card-proto" data-fitem data-fkey="${titleCase(p.name)}" data-rename-key="${SPACE_KEY}${opp.name}/${p.name}" data-default-name="${dname}">
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
    body: `<header class="folderbar"><a class="folderbar__up" href="${S("/")}" aria-label="All ${PROJECTS_LABEL.toLowerCase()}" title="All ${PROJECTS_LABEL.toLowerCase()}"><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></a><h1 class="folderbar__title">${titleCase(opp.name)}</h1><span class="folderbar__count">${opp.prototypes.length}</span><span class="folderbar__rule"></span>${researchChip(opp.research)}</header><div data-fgroup><div class="page-grid is-3up">${cards}</div></div>${filterEmpty()}`,
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
        <div class="card-opp" data-fitem data-fkey="${titleCase(p.name)}" data-rename-key="${SPACE_KEY}playground/${p.name}" data-default-name="${dname}">
          <a class="card-cover-link" href="${folder}" aria-label="Open ${titleCase(p.name)}"></a>
          <div class="preview">
            ${media(p.href, p.poster)}
            ${statusChip(p.status, SPACE_KEY + "playground/" + p.name)}
          </div>
          <div class="preview-actions">${pinStar(pinKey, pinKey)}</div>
          <div class="opp-meta">
            <div class="proto-name">${dname}</div>
            <div class="proto-date" title="${fmtDate(p.mtimeMs)}">${relTime(p.mtimeMs)}</div>
          </div>
        </div>`;
    })
    .join("");

  return shell({
    title: "Playground",
    activeTab: "playground",
    wrapClass: "wrap--wide",
    body: `<header class="folderbar"><h1 class="folderbar__title">Playground</h1><span class="folderbar__count">${projects.length}</span><span class="folderbar__rule"></span></header><div data-fgroup><div class="opp-grid">${cards}</div></div>${filterEmpty()}`,
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
    ? `<header class="folderbar"><h1 class="folderbar__title">Changelog</h1><span class="folderbar__count">${entries.length}</span><span class="folderbar__rule"></span></header>` +
      `<div data-fgroup><div class="cl-list">${cards}</div></div>${filterEmpty()}` +
      `<style>${CHANGELOG_CSS}</style><script>${CHANGELOG_JS}</script>`
    : `<header class="folderbar"><h1 class="folderbar__title">Changelog</h1><span class="folderbar__rule"></span></header>` +
      `<p class="empty">No updates yet. Add one to <code>changelog.md</code> and rebuild.</p>`;
  return shell({ title: "Changelog", activeTab: "changelog", body });
}

// Discover the spaces under SPACES_ROOT. Each space dir (a per-space repo, mounted as a
// submodule at spaces/<id> — or a sibling clone when offline points SPACES_ROOT at the
// god-mode parent) holds a space.json ({id,name,default,badge}) at its root; dirs
// WITHOUT a space.json are not spaces and are skipped, as are non-dir / dotfile entries.
// The DEFAULT space (space.json default:true, else the first) builds at the root URLs;
// the rest under /<id>/. Returns default-first.
async function discoverSpaces() {
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
    const SHARED_ASSETS = [
      "tokens.css", "primitives.css", "ui.css", "bo.css",
      "themes.js", "cookies.js", "icons.js",
      "avatars.js", "rail.js", "partbar.js",
      "survey.css", "survey.js", "logo.svg",
      "charts.js",
      "pagebuilder.js", "widgets.js", "widgets.css",
      "instances.js",
    ].map((f) => `${DS.prefix}-${f}`);
    const sharedDir = path.join(DIST_SPACE, "skills", DS.dirName);
    await fs.mkdir(sharedDir, { recursive: true });
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
  }

  // ── Per-space build log.
  const protoCount = opportunities.reduce((n, o) => n + o.prototypes.length, 0);
  console.log(
    `[${space.id}]${space.default ? " (default → /)" : ` → /${space.id}/`} — ` +
    `${plural(opportunities.length, "opportunity").replace("opportunitys", "opportunities")}, ` +
    `${plural(protoCount, "prototype")}, ${components.length} components, ${pages.length} pages` +
    `${playground.length ? `, ${plural(playground.length, "playground project")}` : ""}.`
  );

  return { opportunities, base, components, patterns, pages, playground, graph };
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

  for (const space of spaces) {
    const r = await buildSpace(space); // sets BASE + DIST_SPACE for this space
    if (space.default) defaultGraph = r.graph;

    // Published, link-shareable paths (prototypes + playground), prefixed with this
    // space's BASE so the gate opens them and they stay isolated per space. Galleries
    // remain gated (not pushed here). S() reads the BASE just set by buildSpace().
    for (const opp of r.opportunities)
      for (const p of opp.prototypes) {
        const u = S(`/${encodeURIComponent(opp.name)}/${encodeURIComponent(p.name)}/`);
        publicPrefixes.push(u);
        versionMap[u] = String(p.mtimeMs);
      }
    // Playground prototype folders are public (link-shareable); the /playground/ index
    // listing itself stays gated (a shorter path matching no prefix).
    for (const pj of r.playground) {
      const u = S(`/playground/${encodeURIComponent(pj.name)}/`);
      publicPrefixes.push(u);
      versionMap[u] = String(pj.mtimeMs);
    }
    for (const c of r.components) versionMap[S(`/components/${encodeURIComponent(c.name)}/`)] = String(c.mtimeMs);
    for (const b of r.base) versionMap[S(`/base/${encodeURIComponent(b.name)}/`)] = String(b.mtimeMs);
    for (const pt of r.patterns) versionMap[S(`/patterns/${encodeURIComponent(pt.name)}/`)] = String(pt.mtimeMs);
    for (const pg of r.pages) versionMap[S(`/pages/${encodeURIComponent(pg.name)}/`)] = String(pg.mtimeMs);

    // Structural signature → shell live-reload id (NOT mtimes), namespaced per space.
    sigParts.push(`space:${space.id}|pg:${r.playground.length > 0}`);
    for (const opp of r.opportunities)
      for (const p of opp.prototypes)
        sigParts.push(`${space.id}:${opp.name}/${p.name}|${p.status || ""}|${p.editor ? p.editor.email : ""}`);
    for (const [label, arr] of [["c", r.components], ["b", r.base], ["pt", r.patterns], ["pg", r.pages], ["pl", r.playground]])
      for (const it of arr) sigParts.push(`${space.id}:${label}:${it.name}`);
  }

  // ── Shared chrome — emitted ONCE at the dist root (NOT space-scoped) ─────────────────

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

  // Edge auth gate. Inject the PUBLIC prototype path-prefixes (every space), the version
  // map, the shell id, and the user identities. (Derived from what actually shipped, so
  // the gate can never drift.)
  const workerSrc = await fs.readFile(SRC_WORKER, "utf8");
  const gatedWorker = workerSrc.replace(
    "const PUBLIC_PREFIXES = [];",
    `const PUBLIC_PREFIXES = ${JSON.stringify(publicPrefixes)};`
  );
  if (gatedWorker === workerSrc) {
    throw new Error("build: PUBLIC_PREFIXES placeholder not found in src/_worker.js");
  }
  const versionedWorker = gatedWorker
    .replace('const BUILD_ID = "dev";', `const BUILD_ID = ${JSON.stringify(shellId)};`)
    .replace("const VERSION_MAP = {};", `const VERSION_MAP = ${JSON.stringify(versionMap)};`);
  if (versionedWorker === gatedWorker) {
    throw new Error("build: BUILD_ID / VERSION_MAP placeholder not found in src/_worker.js");
  }
  // Inject the internal users (identity + seed passwords) from the identity file so
  // the gate knows who exists (same injection model as BUILD_ID / VERSION_MAP above).
  // Presence-check the placeholder BEFORE replacing: an empty identity ([]) makes the
  // replacement a no-op by value, which is legitimate (raw engine build → open gate).
  if (!versionedWorker.includes("const USERS = [];")) {
    throw new Error("build: USERS placeholder not found in src/_worker.js");
  }
  const stampedWorker = versionedWorker.replace(
    "const USERS = [];",
    `const USERS = ${JSON.stringify(IDENTITY)};`
  );
  // Inject the admin-only space base paths (e.g. "/go-vocal-2") so the gate seals them
  // to admins. Derived from each space's space.json `adminOnly` flag (default space is
  // never restricted), so it can't drift from what shipped.
  const restrictedBases = NAV_STATE.spaces
    .filter((s) => s.adminOnly && !s.default)
    .map((s) => s.base);
  // Presence check, not before/after inequality — with zero restricted spaces the
  // injected value IS the placeholder (`[]`), which a diff check misreads as "not found".
  if (!stampedWorker.includes("const RESTRICTED_BASES = [];")) {
    throw new Error("build: RESTRICTED_BASES placeholder not found in src/_worker.js");
  }
  const sealedWorker = stampedWorker.replace(
    "const RESTRICTED_BASES = [];",
    `const RESTRICTED_BASES = ${JSON.stringify(restrictedBases)};`
  );
  // Deploy knobs → worker (same injection model, presence-checked): the gate-exempt
  // skill-asset prefixes (from the DEFAULT space's detected UI skill — root paths
  // only, mirroring the /skills and /pages doors), the MCP-proxy host allowlist,
  // vanity redirects, and the optional AI-builder prompts from the deploy config.
  const defaultDs = detectUiSkill(spaces.find((s) => s.default));
  const gateExempt = defaultDs.dirName ? [`/skills/${defaultDs.dirName}/`] : [];
  let finalWorker = sealedWorker;
  for (const [ph, value] of [
    ["const PUBLIC_SKILL_PREFIXES = [];", gateExempt],
    ["const MCP_HOST_SUFFIXES = [];", DEPLOY.mcpHostSuffixes || []],
    ["const VANITY_REDIRECTS = {};", DEPLOY.vanityRedirects || {}],
    ["const BUILDER_CONFIG = null;", DEPLOY.builder || null],
    ['const RT_ORIGIN = "";', DEPLOY.realtimeOrigin || ""],
  ]) {
    if (!finalWorker.includes(ph)) throw new Error(`build: placeholder missing in src/_worker.js: ${ph}`);
    finalWorker = finalWorker.replace(ph, ph.replace(/= [^=]*;$/, `= ${JSON.stringify(value)};`));
  }
  await fs.writeFile(path.join(DIST, "_worker.js"), finalWorker, "utf8");

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
  const stampSpaces = {};
  for (const space of spaces) {
    let sha = null;
    try {
      sha = execFileSync("git", ["-C", space.root, "rev-parse", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {}
    stampSpaces[space.id] = { sha };
  }
  await fs.writeFile(
    path.join(DIST, "_build.json"),
    JSON.stringify({ builtAt: new Date().toISOString(), engine: { sha: engineSha }, spaces: stampSpaces }, null, 2),
    "utf8"
  );

  // Top-level 404.html. Cloudflare Pages serves this (with a genuine 404 status) for
  // any unmatched route — WITHOUT it, Pages falls back to serving the root index.html
  // at status 200, so the worker's `asset.status === 404` branch never fires and bogus
  // URLs render the internal landing page instead of a 404. Same shell/markup as the
  // worker's notFoundPage() so direct hits and worker-wrapped hits look identical.
  await fs.writeFile(path.join(DIST, "404.html"), renderNotFoundPage(), "utf8");

  // Review overlay assets (shared; injected into prototypes via absolute /__review/
  // paths). The composition graph is the DEFAULT space's — prototypes live there.
  await fs.mkdir(path.join(DIST, "__review"), { recursive: true });
  await fs.copyFile(SRC_REVIEW, path.join(DIST, "__review", "comments.js"));
  await fs.copyFile(SRC_REVIEW_CAT, path.join(DIST, "__review", "aslam.png"));
  // Composition graph (DERIVED from canonical CSS) → window.__GV_GRAPH, loaded before
  // comments.js so the overlay can recurse tokens → base → components → patterns.
  await fs.writeFile(
    path.join(DIST, "__review", "graph.js"),
    "window.__GV_GRAPH=" + JSON.stringify(defaultGraph || { tokens: {} }) + ";",
    "utf8"
  );

  // Canvas engine (shared; canvas prototypes mount it by absolute /__canvas/ path, the same
  // way every prototype embeds /__review/comments.js). Board DATA persists to KV via /__board.
  await fs.mkdir(path.join(DIST, "__canvas"), { recursive: true });
  await fs.copyFile(SRC_CANVAS_JS, path.join(DIST, "__canvas", "canvas.js"));
  await fs.copyFile(SRC_CANVAS_CSS, path.join(DIST, "__canvas", "canvas.css"));
  await fs.writeFile(path.join(DIST, "__canvas", "catalog.json"), JSON.stringify(CANVAS_CATALOG), "utf8");

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
  {
    const defaultSpace = spaces.find((s) => s.default);
    for (const src of [
      defaultSpace && path.join(defaultSpace.root, "space-icon.png"),
      path.join(ROOT, "augur-mark.png"),
    ].filter(Boolean)) {
      if (await exists(src)) { await fs.copyFile(src, path.join(DIST, "space-icon.png")); break; }
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

  console.log(`Built dist/ — ${plural(spaces.length, "space")} (${spaces.map((s) => s.id).join(", ")}).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
