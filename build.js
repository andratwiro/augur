#!/usr/bin/env node
/**
 * build.js — scans opportunity folders and generates a static site in /dist.
 *
 * Convention (see CLAUDE.md):
 *   <opportunity>/
 *     research.md   <- context for agents, NEVER published
 *     context.md    <- context for agents, NEVER published
 *     prototypes/
 *       <prototype>/  <- self-contained static HTML/JS, THIS is what ships
 *
 * Rules:
 *   - ONLY files inside a prototypes/ folder are copied to /dist.
 *   - research.md, context.md, and anything outside prototypes/ are never copied.
 *
 * Output (two-level drill-down):
 *   /dist/index.html                     -> lists opportunities
 *   /dist/<opportunity>/index.html       -> lists that opportunity's prototypes
 *   /dist/<opportunity>/<prototype>/...  -> the prototype itself
 *   /dist/_worker.js                     -> edge auth gate (copied from src/)
 *
 * Plain Node, no dependencies.
 */

import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// Augur composes two read-only submodules mounted at the repo root: the design
// system (canonical assets + galleries) and the workspace (opportunities +
// research). The source paths below resolve into them.
const DS_ROOT = path.join(ROOT, "gv-design-system"); // submodule: canonical DS
const WS_ROOT = path.join(ROOT, "gv-workspace"); // submodule: opportunities + research
const DIST = path.join(ROOT, "dist");
const SRC_WORKER = path.join(ROOT, "src", "_worker.js");

// Optional, self-contained build addon. If present it can post-process copied HTML,
// add footer/style/script snippets to shell pages, and emit its own dist files via
// generic hooks (see its source). The site builds identically without it.
let addon = null;
try { addon = await import("./pitis/piti.build.js"); } catch (e) { addon = null; }
const addonHtml = (html) => (addon ? addon.transformHtml(html, UI_VERSION) : html);
const SRC_REVIEW = path.join(ROOT, "src", "review", "comments.js");
const SRC_REVIEW_CAT = path.join(ROOT, "src", "review", "aslam.png");

// Dev-facing prototype status. Source of truth is the committed prototype-status.json
// (keyed "<opportunity>/<prototype>"), rendered as a static chip at build time — no
// KV, no runtime cost. Internal file: it lives outside any prototypes/ folder, so it
// is never copied to dist. See STATUS_META for the allowed values.
const STATUS_FILE = path.join(ROOT, "prototype-status.json");
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
 * (../../../skills/govocal-ui/X — always canonical) OR carries a byte-identical
 * local copy. A drifted (forked) copy is silently excluded, so this is honest per
 * build: re-drift a copy and it drops out of the set on the next build.
 * Reads the SOURCE index.html (refs are still original there, pre-rewrite).
 */
async function computeLinkedAssets(protoDir) {
  const idx = path.join(protoDir, "index.html");
  if (!(await exists(idx))) return [];
  const html = await fs.readFile(idx, "utf8");
  const re = /(?:href|src)\s*=\s*["']([^"']*\bgovocal-[^"'/]+\.(?:css|js))["']/gi;
  const refs = [];
  let m;
  while ((m = re.exec(html))) refs.push(m[1]);
  const linked = new Set();
  for (const ref of refs) {
    const base = ref.split("/").pop();
    const canon = path.join(UI_SKILL, base);
    if (!(await exists(canon))) continue; // not a canonical asset
    if (/skills\/govocal-ui\//.test(ref)) { linked.add(base); continue; } // live-linked
    try {
      const [a, b] = await Promise.all([fs.readFile(path.resolve(protoDir, ref)), fs.readFile(canon)]);
      if (a.equals(b)) linked.add(base); // byte-identical local copy = in sync
    } catch { /* missing/unreadable local copy → not linked */ }
  }
  // Follow canonical @import chains: a linked CSS that @imports another canonical
  // CSS (e.g. govocal-ui.css @imports govocal-primitives.css) pulls it in transitively
  // and in-sync — even though the page never <link>s it directly. Without this a
  // component whose deps include primitives.css would never badge on an FO page.
  const queue = [...linked];
  while (queue.length) {
    const base = queue.shift();
    if (!base.endsWith(".css")) continue;
    const canon = path.join(UI_SKILL, base);
    let css;
    try { css = await fs.readFile(canon, "utf8"); } catch { continue; }
    for (const m of css.matchAll(/@import\s+(?:url\()?["']?(govocal-[\w.\-]+\.css)["']?/g)) {
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
 * — not just prototypes. Library tiers live-reference ../../skills/govocal-ui/* so
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

// Absolute origin used to build absolute og:image / og:url (unfurl bots need
// absolute URLs). Update here if a custom domain replaces the pages.dev one.
const SITE_ORIGIN = "https://govocal-prototypes.pages.dev";

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
  const desc = (dm ? dm[1] : subtitle) || "Clickable design prototype · Go Vocal";
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
const UI_VERSION = "0.79";

// One id per build (ms timestamp). Baked into every page's live-reload poller AND
// into the worker's /__version endpoint, so a fresh deploy = a new id = open tabs
// notice and reload. Same value across this whole build run.
const BUILD_ID = String(Date.now());

// Top-level folders that are never treated as opportunity folders.
const IGNORED_TOPLEVEL = new Set([
  "dist",
  "node_modules",
  "skills",
  "src",
  "pages", // composed reference pages — shipped via their own builder, not as an opportunity
  "components", // composed component library — shipped via its own builder, not as an opportunity
  "base", // base-atom demos — shipped via their own builder (Base tab), not as an opportunity
  "patterns", // curated composition demos — shipped via their own builder (Patterns tab)
  "playground", // standalone scratch prototype — shipped to /playground/, not as an opportunity
  "references", // internal source exports (raw Go Vocal HTML + screenshots) — NEVER ships
  "govocal-exports", // internal raw Go Vocal page exports (HTML + screenshots) — NEVER ships
  "gv-design-system", // the DS submodule nested inside the workspace — not an opportunity
  "skills", // the workspace's skills→DS symlink (local-open convenience) — not an opportunity
  ".git",
  ".github",
]);

// Planned reference pages (Pages tab) that aren't built yet — rendered as a
// "Pending" roadmap so the team sees what's coming. Remove a slug here once its
// real page lands under pages/<slug>/. Slugs are kebab-case; titleCase() labels them.
const PENDING_PAGES = [
  // FO method pages not yet built
  "fo-method-voting",
  "fo-method-mapping",
  "fo-method-budgeting",
  "fo-method-information",
  // BO method pages (all methods need a focused phase-config page)
  "bo-method-survey",
  "bo-method-ideation",
  "bo-method-perspectives",
  "bo-method-mapping",
  "bo-method-common-ground",
  "bo-method-voting",
  "bo-method-budgeting",
  "bo-method-information",
  "bo-method-volunteering",
  // Other pending pages
  "sensemaking",
  "autoinsights",
  "official-updates",
];

// Pages index has three top-level groups: Front office, Methods, Back office.
// "Methods" are the front-office screens where a resident actually runs a
// participation method (survey, proposals, …). Classified by slug here; a page
// can also opt in/out via <meta name="gv-surface" content="method">.
// Any page whose slug starts with fo-method- or bo-method- is auto-classified as
// "method" surface. Add explicit entries here only for exceptions (pages that
// belong in Methods but don't follow the prefix convention).
const METHOD_PAGES = new Set([
  "input-form", // Ideation — input/submission form
]);

// Source for the reference tabs (Primitives · Components · Pages).
const UI_SKILL = path.join(DS_ROOT, "skills", "govocal-ui"); // Primitives gallery + assets
const PAGES_SRC = path.join(DS_ROOT, "pages"); // composed reference pages
const COMPONENTS_SRC = path.join(DS_ROOT, "components"); // composed component library
const BASE_SRC = path.join(DS_ROOT, "base"); // base-atom demos (Base tab)
const PATTERNS_SRC = path.join(DS_ROOT, "patterns"); // curated composition demos (Patterns tab)
const CHANGELOG_SRC = path.join(ROOT, "changelog.md"); // hand-edited changelog source (internal; rendered to /changelog/)

// Display name + key classes + one-line "what is it" per component, shown on the
// Components page. Keyed by folder name; `name` is the SHARED, functional display name
// (never a city — folders may be city-grounded, the name describes what it IS). This is
// the CANONICAL source of truth: the live right-click Rename / Edit-description writes a
// KV override (/__name), which is folded back here so code and live stay in one language.
const COMPONENT_BLURBS = {
  accordion: { name: "FAQ accordion", classes: ".gv-accordion / .gv-acc__item / __head / __chev", desc: "CSS-only &lt;details&gt; FAQ accordion, collapsed by default, chevron rotates on open; steps up to 18px inside project description copy." },
  "approval-voting": { name: "Voting method body", classes: ".gv-voteoptions / .gv-voteoption / .gv-tally / .gv-voteresults", desc: "The per-method panel for a voting phase: a collapsible options accordion plus a final-tally card over a grid of ranked result bars." },
  attachment: { name: "File attachment row", classes: ".gv-attachment / __icon / __name / __size", desc: "The Content-Builder file-download row on a custom/info page: outlined row with paperclip glyph, file-name link and size span." },
  "avatar-overflow-bubble": { name: "Avatar overflow-count bubble", classes: ".gv-bubbles .count.bubble (.sm / .xs)", desc: "The participant-overflow count rendered as a solid cool-grey circle capping the avatar overlap stack; holds abbreviated or full counts." },
  banner: { name: "Image-only project banner", classes: ".gv-banner / __art / __sticker", desc: "Image-only project hero (no title/CTA): a full-width teal-gradient art panel holding an illustration SVG plus an optional rotated campaign sticker." },
  "bo-analysis": { name: "Back-office AI analysis (sensemaking)", classes: ".gv-bo-analysis / .gv-bo-tagitem / .gv-bo-matrix / .gv-bo-aiqa", desc: "The back-office AI sensemaking surface: tag rail, insight cards and AI summary panel, plus the auto-insights cross-tab matrix opened via 'View all insights'." },
  "bo-app-shell": { name: "Back-office app shell", classes: ".gv-bo / .gv-bo-shell / .gv-bo-side / .gv-bo-topbar / .gv-bo-tabs", desc: "The staff-facing chrome shared by every back-office screen: dark teal/navy sidebar, project top-bar with status pills and actions, and the tab row." },
  "bo-menu": { name: "Back-office menu + notification flyout", classes: ".gv-bo-menu (.is-flyout) / .gv-bo-notifflyout__item / .gv-badge.is-count", desc: "The one canonical back-office dropdown panel powering both the exports menu and the bell notification flyout, plus the red unread count badge." },
  "bo-sidebar": { name: "Back-office sidebar", classes: ".gv-bo-side (.is-rail) / .gv-bo-nav / __item / __icon", desc: "The back-office sidebar as a standalone responsive component: 224px extended teal/navy nav that collapses to an 80px icon rail under 1200px." },
  "bo-templatecard": { name: "Back-office template card + facet rail", classes: ".gv-bo-templatecard / __img / .gv-bo-facetgroup / __head", desc: "The new-project \"from a template\" gallery pieces: a grey-blue template tile and the collapsible left-rail filter disclosure group." },
  "community-monitor": { name: "Community Monitor sentiment modal", classes: ".gv-modal.size-monitor / .gv-monitor__question / .gv-sentiment-scale / __opt", desc: "The \"City at a glance\" satisfaction module: an ongoing-survey modal asking how residents feel via a 5-point emoji sentiment scale." },
  "content-builder-render": { name: "Content-Builder render layer", classes: ".gv-cb-frame / .gv-cb-row (.cols-1/2/3) / .gv-cb-col / .gv-cb-textbox", desc: "What the back-office Content Builder outputs onto a live page: a full-width frame of 1/2/3-column rows of text-box, image and white-space cells." },
  "cookie-modal": { name: "Cookie-consent modal", classes: ".gv-cookie__content / __icon / .gv-modal__footer", desc: "The global cookie blocker as a content variant on the modal shell: tinted cookie icon, title, body and a Manage/Reject/Accept 3-action footer." },
  "cta-banner": { name: "CTA banner — full-width strip", classes: ".gv-cta-banner / __inner / __cta", desc: "The Content-Builder \"CTA banner\" block: a thin full-bleed coloured strip carrying one centered call-to-action button on the tenant-primary fill." },
  "event-card-bordered": { name: "Event card — bordered", classes: ".gv-event-card.bordered (.is-imageless) / .gv-event-datechip--stacked / .gv-event-info-panel", desc: "The bordered EventsWidget card: a white framed event with a 3-tier stacked date chip and a \"Date &amp; time\" info panel, plus an imageless degrade." },
  "event-card": { name: "Event card", classes: ".gv-event-card / __media / __date / __rsvp / .gv-events__grid", desc: "The two-tone-date-chip event card: date chip over the media, clock/location/registrant rows and a Register CTA, with grid and empty state." },
  "fo-linz-monitorband": { name: "Monitor band — duration variant", classes: ".gv-monitorband__ctameta--duration / .gv-monitorband / .gv-event-datechip--stacked", desc: "A small additive monitor-band modifier adding a \"Takes N minutes\" duration line, confirming the cross-tenant community-monitor band formula." },
  "folder-card": { name: "Folder card", classes: ".gv-pcard.boxed.folder / __fmedia / __fbody / __fpile / .gv-pcard__count", desc: "The projects-list folder card: borderless card with a hero image, top-right project-count badge, title, description preview and child-project avatars." },
  "footer-logos": { name: "Footer logo band + dual-auth header", classes: ".gv-footer__logos (.row) / .gv-nav.tinted / .gv-auth-dual", desc: "Three optional header/footer config variants: a white centered logo band above the footer, brand-tinted nav labels, and the dual log-in/register CTA." },
  footer: { name: "Footer", classes: ".gv-footer / .gv-footer__links / .gv-powered-logo", desc: "The site footer: a secondary-nav list of legal links plus a \"powered by go·vocal\" attribution; links left, attribution right, stacking under 720px." },
  "header-nav": { name: "Header + nav", classes: ".gv-header / .gv-nav / .gv-nav-m / .gv-account-dd", desc: "Responsive full-width 78px site chrome: logo, primary nav with dropdown and overflow, search, CTA; flips signed-out/signed-in via data-auth, hamburger drawer on mobile." },
  hero: { name: "Hero / banner", classes: ".gv-hero (.signed-out/.centered/.layout-tworow/.layout-fixed) / .gv-hero__media / .gv-avatars", desc: "Full-bleed page banner with tenant-tinted overlay, title/lead, avatar-count stack and CTA; image-agnostic, with the three homepage-banner layouts." },
  "homepage-featured-row": { name: "Featured 3-up spotlight row", classes: ".gv-featured-row / .gv-pcard.featured / .gv-bubbles.xs", desc: "The homepage \"we want to hear from you\" row: three large image-led featured project cards with title and avatar row, sitting above the project grid." },
  "homepage-survey-band": { name: "Embedded-survey band", classes: ".gv-monitorband / __inner / __text / __media / __cta", desc: "The homepage \"help us serve you better\" banner promoting the community-monitor survey: a 3-zone tinted card with text, preview image and CTA." },
  "idea-card": { name: "Idea card", classes: ".gv-ideacard / __thumb / __body / __title / .gv-react", desc: "The shared idea/proposal card: square thumb, author meta and excerpt with a footer of circular like/dislike react controls and a comment count." },
  "idea-feed": { name: "Idea feed", classes: ".gv-feed / .gv-feedfilter / .gv-viewseg / .gv-idealist", desc: "The ideation feed layout: an idea count and List/Map toggle over a two-column grid pairing the idea list with a sort/status/topic sidebar." },
  "issue-canvas": { name: "Issue canvas", classes: ".gv-issuecanvas (.is-detail) / __pile / __add / .gv-issuefeed", desc: "The dotted-grid Perspectives canvas that floats sticky-note ideas in a masonry pile, with a floating \"Add an idea\" button and a raised detail state." },
  "login-modal": { name: "Modal + login", classes: ".gv-modal-overlay / .gv-modal / __header / __body / .gv-or", desc: "Reusable dialog abstraction (overlay → card → titled header, close, scrollable body), shown via the real \"before you participate\" auth flow." },
  "extra-survey": { name: "Extra survey CTA", classes: ".gv-extra-survey (--card) / __tag / __title / __desc / .gv-btn", desc: "A survey linked into a project page or Content Builder, rendered as a button or a legible card; uses the same primary / secondary-outlined button pair as the participation box." },
  "participation-bar": { name: "Participation bar", classes: ".gv-partbar / __inner / __status / .gv-btn.on-color", desc: "The sticky project-page action footer: participation status on the left and a primary on-color CTA on the right that pins as residents scroll." },
  "participation-box": { name: "Participation box", classes: ".gv-pbox / __actions / __people / __empty / .gv-btn.primary + .secondary-outlined", desc: "The resident-facing project CTA block: the project's active participation methods stacked as full-width buttons (current = primary, others = secondary-outlined), then an always-bottom participant row. Mirrored in the Content Builder." },
  "phase-timeline": { name: "Phase timeline", classes: ".gv-phases__bar / .gv-stepper / .gv-pstep / .gv-phasepanel", desc: "The project phase nav: a connected row of interlocking chevron ribbon segments with current (mint+dot) and viewing (slate) states, plus a content panel." },
  poll: { name: "Poll method body", classes: ".gv-poll / __question / __qhead / __options / __send", desc: "The per-method panel for a poll phase: a stack of question cards holding single/multi-choice options, a full-width Send, and the sticky participation band." },
  "project-card": { name: "Project card + rail", classes: ".gv-rail / .gv-pcard (.boxed/.horizontal) / .gv-pgrid", desc: "The participation-project card (thumb, title, status meta, CTA) in two layouts: the horizontal scroll rail and the bordered boxed grid card." },
  "proposal-threshold": { name: "Proposal threshold", classes: ".gv-threshold / __icon / __count / __fill / .gv-statuspill", desc: "The proposals signature votes-needed bar: vote icon, count-over-target and tenant-tinted fill paired with an open/expired status pill." },
  "signed-out-hero": { name: "Signed-out hero banner", classes: ".gv-hero.signed-out (.centered) / __title / __lead / .gv-btn.primary-inverse", desc: "The home-page banner a visitor sees before signing in: a full-bleed photo with tenant overlay, white headline, avatar overflow cluster and an inverse CTA." },
  "spotlight-carousel": { name: "Project carousel", classes: ".gv-carousel / __head / __controls / __scroll / .gv-rail", desc: "The homepage project row: a section title with prev/next scroll controls wrapping the canonical scroll/snap rail of project cards, with a11y skip scaffolding." },
  spotlight: { name: "Spotlight", classes: ".gv-spotlight / __eyebrow / __title / __media / .gv-progress", desc: "The homepage \"currently working on\" spotlight: a copy column (eyebrow/title/lead/actions plus avatar count) beside a media tile with a no-image placeholder." },
  "sticky-note": { name: "Sticky note", classes: ".gv-sticky (.is-raised / pastel variants) / __author / __title / __react", desc: "The pastel Perspectives idea note: a 320px card with author chip, emoji, title, excerpt and react counts, in resting/raised states and four pastel colours." },
  "survey-band": { name: "Survey band", classes: ".gv-surveyband / __inner / __status / __dot / __cta", desc: "The \"Take the survey\" CTA strip on a project-page survey phase: a live-dot status on the left and an on-color CTA on the right." },
  "survey-fields": { name: "Survey fields", classes: ".sv-optcard / .sv-rating / .sv-matrix / .sv-map · GVSurvey.mount()", desc: "Every Go Vocal survey question type (text, select, rating, ranking, scale, sentiment, image-select, matrix, map, upload) plus the page-by-page runner." },
  "theme-card": { name: "Theme card", classes: ".gv-themecard (.is-active) / __emoji / __name / __count / __bar", desc: "The ranked Perspectives category card: an emoji swatch, name, response count and a mini share bar, with an active-selection state." },
  "twocol-accordion": { name: "Two-column image + text + accordion", classes: ".gv-cb-row.cols-2 / .gv-cb-image / .gv-prose / .gv-accordion", desc: "The Content-Builder homepage \"about + FAQ\" section: a two-column row pairing an image cell with a rich-text column carrying a heading, intro and FAQ accordion." },
  "volunteer-cause": { name: "Volunteer cause", classes: ".gv-cause / __media / __badge / __body / .gv-btn.volunteer", desc: "The volunteering opportunity card: photo with participant badge, title, count and description plus a green volunteer button that toggles a withdrawn state." },
  voting: { name: "Project-page events section", classes: ".gv-project-events / __sec / __rule / __empty / .gv-event-card", desc: "The \"upcoming\" and \"past events\" sections a project page renders below the phase body, reusing the events grid, card and date-filter pill." },
};

// Structured metadata per component, surfaced as badges on the Components page so the
// "mix" is eyeball-able and the library can be cleaned up. Derived from manifest.md.
//   surface : "fo" | "bo" | "cross"   — which product surface it belongs to
//   category: navigation|cards|banners|modals|survey|shell|voting|events|content|media|misc
//   status  : "canonical" — real standalone source-grounded component
//             "variant"   — additive variant/config on top of a base component
//             "page-demo" — a page-level composition, not a standalone component
//             "review"    — overlaps another entry / mislabeled → candidate for cleanup
//   tags    : source tenant + a couple of descriptive keywords
const COMPONENT_META = {
  accordion: { surface: "fo", category: "content", status: "canonical", tags: ["faq", "details"] },
  "approval-voting": { surface: "fo", category: "voting", status: "canonical", tags: ["cultuurconnect", "results"] },
  attachment: { surface: "fo", category: "content", status: "canonical", tags: ["stlouis", "download"] },
  "avatar-overflow-bubble": { surface: "cross", category: "misc", status: "variant", tags: ["falkirk", "avatars"] },
  banner: { surface: "fo", category: "banners", status: "canonical", tags: ["hero", "illustration"] },
  "bo-analysis": { surface: "bo", category: "content", status: "canonical", tags: ["ai", "sensemaking"] },
  "bo-app-shell": { surface: "bo", category: "shell", status: "canonical", tags: ["chrome", "topbar"] },
  "bo-menu": { surface: "bo", category: "navigation", status: "canonical", tags: ["dropdown", "flyout"] },
  "bo-sidebar": { surface: "bo", category: "shell", status: "canonical", tags: ["nav", "rail"] },
  "bo-templatecard": { surface: "bo", category: "cards", status: "canonical", tags: ["raleigh", "templates"] },
  "community-monitor": { surface: "fo", category: "survey", status: "canonical", tags: ["wietsedemo", "sentiment"] },
  "content-builder-render": { surface: "fo", category: "content", status: "canonical", tags: ["copenhagen", "layout"] },
  "cookie-modal": { surface: "fo", category: "modals", status: "variant", tags: ["wien", "consent"] },
  "cta-banner": { surface: "fo", category: "banners", status: "review", tags: ["stlouis", "strip"] },
  "event-card-bordered": { surface: "fo", category: "events", status: "variant", tags: ["copenhagen", "linz", "eventswidget"] },
  "event-card": { surface: "fo", category: "events", status: "canonical", tags: ["datechip", "rsvp"] },
  "fo-linz-monitorband": { surface: "fo", category: "banners", status: "variant", tags: ["linz", "monitorband"] },
  "folder-card": { surface: "fo", category: "cards", status: "variant", tags: ["stlouis", "projects-list"] },
  "footer-logos": { surface: "fo", category: "navigation", status: "variant", tags: ["luxembourg", "linz", "config"] },
  footer: { surface: "fo", category: "navigation", status: "canonical", tags: ["wien", "chrome"] },
  "header-nav": { surface: "fo", category: "navigation", status: "canonical", tags: ["wien", "chrome"] },
  hero: { surface: "fo", category: "banners", status: "canonical", tags: ["banner", "homepage"] },
  "homepage-featured-row": { surface: "fo", category: "cards", status: "variant", tags: ["wietsedemo", "featured"] },
  "homepage-survey-band": { surface: "fo", category: "banners", status: "variant", tags: ["wietsedemo", "monitorband"] },
  "idea-card": { surface: "fo", category: "cards", status: "canonical", tags: ["ideation", "proposals"] },
  "idea-feed": { surface: "fo", category: "content", status: "canonical", tags: ["ideation", "feed"] },
  "issue-canvas": { surface: "fo", category: "content", status: "canonical", tags: ["perspectives", "canvas"] },
  "login-modal": { surface: "fo", category: "modals", status: "canonical", tags: ["auth", "dialog"] },
  "extra-survey": { surface: "cross", category: "survey", status: "canonical", tags: ["parallel-participation", "cta"] },
  "participation-bar": { surface: "fo", category: "misc", status: "canonical", tags: ["sticky", "cta"] },
  "participation-box": { surface: "cross", category: "misc", status: "canonical", tags: ["parallel-participation", "cta"] },
  "phase-timeline": { surface: "fo", category: "navigation", status: "canonical", tags: ["phases", "stepper"] },
  poll: { surface: "fo", category: "survey", status: "canonical", tags: ["wietsedemo", "method"] },
  "project-card": { surface: "fo", category: "cards", status: "canonical", tags: ["rail", "boxed"] },
  "proposal-threshold": { surface: "fo", category: "voting", status: "canonical", tags: ["proposals", "votes"] },
  "signed-out-hero": { surface: "fo", category: "banners", status: "variant", tags: ["stlouis", "banner"] },
  "spotlight-carousel": { surface: "fo", category: "cards", status: "variant", tags: ["falkirk", "rail"] },
  spotlight: { surface: "fo", category: "banners", status: "canonical", tags: ["homepage", "media"] },
  "sticky-note": { surface: "fo", category: "cards", status: "canonical", tags: ["perspectives", "pastel"] },
  "survey-band": { surface: "fo", category: "survey", status: "canonical", tags: ["cta", "strip"] },
  "survey-fields": { surface: "fo", category: "survey", status: "canonical", tags: ["fieldkit", "runner"] },
  "theme-card": { surface: "fo", category: "cards", status: "canonical", tags: ["perspectives", "category"] },
  "twocol-accordion": { surface: "fo", category: "content", status: "canonical", tags: ["stlouis", "faq"] },
  "volunteer-cause": { surface: "fo", category: "cards", status: "canonical", tags: ["volunteering", "cause"] },
  voting: { surface: "fo", category: "events", status: "review", tags: ["wietsedemo", "events-section"] },
};

// ── Layer per component demo (Tokens → Base → Components → Patterns → Pages) ──
// Most components/<name>/ demos are component-grade compositions of base atoms; a
// curated few are PATTERNS (recurring multi-component compositions). Atoms now live
// in base/, so no components/<name>/ is base-grade. Stamped onto COMPONENT_META so
// every entry carries `layer` without 40 hand-edits; surfaced as a badge + used by
// the lint/overlay alongside the CSS-derived graph.
const PATTERN_COMPONENTS = new Set([
  "idea-feed", "voting", "spotlight-carousel", "content-builder-render", "twocol-accordion",
]);
for (const [k, v] of Object.entries(COMPONENT_META)) {
  v.layer = PATTERN_COMPONENTS.has(k) ? "pattern" : "component";
}

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
const CANON_CSS_LAYERS = [
  ["govocal-primitives.css", "base"],
  ["govocal-ui.css", "components"],
  ["govocal-bo.css", "components"],
  ["govocal-survey.css", "components"],
  ["govocal-widgets.css", "components"],
];

// Family root → base/ demo {label, slug}. Atoms surfaced in base/<slug>/.
const BASE_INDEX = {
  "gv-btn": { label: "Button", slug: "button" },
  "gv-iconbtn": { label: "Icon button", slug: "icon" },
  "gv-icon": { label: "Icon", slug: "icon" },
  "gv-input": { label: "Input", slug: "input" },
  "gv-textarea": { label: "Textarea", slug: "input" },
  "gv-select": { label: "Select", slug: "input" },
  "gv-label": { label: "Field label", slug: "input" },
  "gv-checkbox": { label: "Checkbox", slug: "checkbox-radio" },
  "gv-radio": { label: "Radio", slug: "checkbox-radio" },
  "gv-toggle": { label: "Toggle", slug: "checkbox-radio" },
  "gv-card": { label: "Card", slug: "card" },
  "gv-badge": { label: "Badge", slug: "badge" },
  "gv-status-label": { label: "Status label", slug: "status-label" },
  "gv-spinner": { label: "Spinner", slug: "badge" },
  "gv-modal": { label: "Modal", slug: "modal" },
  "gv-divider": { label: "Divider", slug: "divider" },
  "gv-avatars": { label: "Avatar stack", slug: "avatar" },
  "gv-title": { label: "Title", slug: "typography" },
  "gv-text": { label: "Body text", slug: "typography" },
};

// Family root → components/ demo slug (label comes from COMPONENT_BLURBS). Ported
// from the old hardcoded overlay list, MINUS the atoms (now base/) and MINUS deps
// (now derived from the CSS file that defines the family).
const COMPONENT_INDEX = {
  "gv-bo-side": "bo-sidebar", "gv-bo-topbar": "bo-app-shell", "gv-bo-tabs": "bo-app-shell",
  "gv-bo-menu": "bo-menu", "gv-bo-analysis": "bo-analysis", "gv-bo-templatecard": "bo-templatecard",
  "gv-header": "header-nav", "gv-footer": "footer", "gv-hero": "hero", "gv-banner": "banner",
  "gv-pbox": "participation-box", "gv-partbar": "participation-bar", "gv-pcard": "project-card",
  "gv-featured-row": "homepage-featured-row", "gv-spotlight": "spotlight",
  "gv-event-card": "event-card", "gv-ideacard": "idea-card", "gv-issuecanvas": "issue-canvas",
  "gv-sticky": "sticky-note", "gv-themecard": "theme-card", "gv-accordion": "accordion",
  "gv-cause": "volunteer-cause", "gv-poll": "poll", "gv-threshold": "proposal-threshold",
  "gv-monitorband": "homepage-survey-band", "gv-surveyband": "survey-band",
  "gv-extra-survey": "extra-survey", "gv-cta-banner": "cta-banner", "gv-voteoptions": "approval-voting",
  "sv-optcard": "survey-fields",
};

// Curated PATTERN layer — recurring compositions promoted above components. Keyed by
// the outermost family root; overrides the file-derived component layer. Slugs map
// to patterns/<slug>/.
const PATTERN_INDEX = {
  "gv-feed": { label: "Idea feed", slug: "idea-feed" },
  "gv-project-events": { label: "Events section", slug: "events-section" },
  "gv-phases": { label: "Phase navigation", slug: "phase-nav" },
  "gv-carousel": { label: "Spotlight row", slug: "homepage-spotlight-row" },
  "gv-cb-frame": { label: "Content-builder grid", slug: "content-builder-grid" },
  "gv-cb-row": { label: "Content-builder grid", slug: "content-builder-grid" },
};

const readCanon = (f) => fs.readFile(path.join(UI_SKILL, f), "utf8").catch(() => "");

/**
 * Parse the canonical CSS into the composition graph. Async (reads the files).
 * Returns { tokens, classes, generatedFrom } — see the block comment above.
 */
async function buildGraph() {
  // ── tokens: name → declared value (first definition wins) ──────────────────
  const tokensCss = (await readCanon("govocal-tokens.css")).replace(/\/\*[\s\S]*?\*\//g, "");
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
      ? "govocal-primitives.css"
      : (["govocal-ui.css", "govocal-bo.css", "govocal-survey.css", "govocal-widgets.css"].find((f) => files.includes(f)) || files[0]);
    const deps = new Set([primaryFile, "govocal-tokens.css"]);
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
 * Last-commit time (ms) for a path, from git. Returns 0 when git is unavailable
 * or the path is untracked (e.g. a brand-new, uncommitted prototype).
 *
 * Why git instead of filesystem mtime: a checkout (the CI deploy) stamps EVERY
 * file with the same checkout time, collapsing any mtime-based "most recent first"
 * ordering. Git's last-commit time is stable across checkouts, so local
 * (`npm run deploy`) and CI builds produce the same, correct order. Needs full
 * history at build time — the deploy workflow sets `fetch-depth: 0` for this.
 */
function gitMtime(absPath) {
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%ct", "--", absPath], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out ? Number(out) * 1000 : 0;
  } catch {
    return 0;
  }
}

/**
 * The "last worked on" time (ms) for a copied folder: git last-commit time when
 * available, else the latest filesystem mtime within it (covers new/untracked
 * folders that have no commit yet). This is the sort key for every listing.
 */
function modifiedTime(srcDir, fsLatest) {
  return gitMtime(srcDir) || fsLatest;
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
        // them as ../../../skills/govocal-ui/X (resolves on disk when opened
        // directly). In dist the shared export lives at dist/skills/govocal-ui/, one
        // level shallower, so repoint any such ref to the correct dist-relative path.
        // Depth-aware (computed from this file's dist dir) and idempotent for the
        // library tiers (pages/, components/ already sit at ../../skills/govocal-ui/).
        const relCanon = path.relative(dest, path.join(DIST, "skills", "govocal-ui")).split(path.sep).join("/");
        html = html.replace(/(?:\.\.\/)+skills\/govocal-ui\//g, relCanon + "/");
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

async function scan() {
  const opportunities = [];
  const topEntries = await fs.readdir(WS_ROOT, { withFileTypes: true });
  const statusMap = await loadStatusMap();

  for (const top of topEntries) {
    if (!top.isDirectory()) continue;
    if (IGNORED_TOPLEVEL.has(top.name) || top.name.startsWith(".")) continue;

    const protoParent = path.join(WS_ROOT, top.name, "prototypes");
    if (!(await isDir(protoParent))) continue;

    const protoEntries = await fs.readdir(protoParent, { withFileTypes: true });
    const prototypes = [];

    for (const proto of protoEntries) {
      if (!proto.isDirectory()) continue;
      const protoDir = path.join(protoParent, proto.name);

      // Copy ONLY the prototype folder into dist.
      const destDir = path.join(DIST, top.name, proto.name);
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
        poster: await exists(path.join(protoDir, "preview.webp")),
        mtimeMs: modifiedTime(protoDir, latest),
        status: statusMap[`${top.name}/${proto.name}`] || null,
      });
    }

    if (prototypes.length === 0) continue;

    prototypes.sort(byStatusThenRecency);
    opportunities.push({
      name: top.name,
      prototypes,
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
    const destDir = path.join(DIST, "pages", e.name);
    const latest = await copyDir(dir, destDir, isInternalOnly);
    await stampLinkedInto(dir, destDir); // overlay badges on Pages (live-linked → full set)
    const { href, file } = await entryPoint(e.name, dir);
    // Surface = back-office (Go Vocal's own theme), front-office (city-themed), or
    // method (a front-office participation-method runner — its own Pages group).
    // fo-method-* and bo-method-* slugs are auto-classified as "method". Add
    // exceptions to METHOD_PAGES. Let <meta name="gv-surface"> override any of these.
    let surface = /^bo-/.test(e.name) ? "back-office" : "front-office";
    if (METHOD_PAGES.has(e.name) || /^(?:fo|bo)-method-/.test(e.name)) surface = "method";
    try {
      const html = await fs.readFile(file, "utf8");
      const m = html.match(/<meta\s+name=["']gv-surface["']\s+content=["']([^"']+)["']/i);
      if (m) {
        const v = m[1].toLowerCase();
        surface = /back/.test(v) ? "back-office" : /method/.test(v) ? "method" : "front-office";
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
    const destDir = path.join(DIST, "components", e.name);
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
    const destDir = path.join(DIST, distSub, e.name);
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
 * scratch opportunity living in gv-workspace/playground/ (WS_ROOT), not augur.
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
      status: statusMap[`playground/${e.name}`] || "in-progress",
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
       This is the TOOLING UI; a light shell sits comfortably next to Go Vocal's light brand. */
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
    /* Title + date share a size (Figma file-row pattern); weight + colour carry the
       hierarchy, not scale. Kept small for app-like density. */
    .proto-name { font-weight: 600; font-size: 13px; letter-spacing: -0.01em; }
    .proto-date { color: var(--faint); font-weight: 450; font-size: 13px; margin-top: 1px; }
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

    /* ---- Right-click card menu (Figma-style dark popover) ---- */
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
       The Figma-style global left rail (NAV_CSS) is the nav now; listing pages are a
       single centered column. The wide variant gives the homepage card grid more room. */
    .wrap--wide { max-width: 1280px; }
    /* Figma-style auto-fill grid: as many ~248px columns as fit, no carousel. */
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

// Figma-style global LEFT RAIL — the site's persistent chrome on every page
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

    /* Workspace brand — Augur + falcon mark, sitting in the SAME icon column as
       every nav row below it. No dropdown; the name just links home. */
    .gvside__brand {
      display: flex; align-items: center; gap: 10px; padding: 6px 8px; margin-bottom: 3px;
      border-radius: 8px; text-decoration: none; color: #16171a;
      transition: background .12s ease;
    }
    .gvside__brand:hover { background: rgba(16,17,26,0.05); }
    .gvside__brand:focus-visible { outline: 2px solid #5e6ad2; outline-offset: 1px; }
    .gvside__brandname { font-family: var(--font-display); font-weight: 800; font-size: 16px; letter-spacing: 0; }
    .gvmark { display: block; flex: none; object-fit: contain; }
    /* Match the 16px nav-icon column (.gvic) exactly so the "augur" wordmark left-aligns
       with the Opportunities / Playground labels below it (same 8px pad + 10px gap). */
    .gvside__brand .gvmark { width: 16px; height: 16px; }
    .gvtop__brand .gvmark { width: 22px; height: 22px; }
    /* Each rail-brand hover spins the mark one full turn and rests there (the angle is
       accumulated in JS — see chromeScript). The disc is a circle so only the sparkle
       cut-out reads as turning; easeOutExpo gives a fast whip that settles home. */
    .gvside__brand .gvmark { transition: transform .9s cubic-bezier(.16,1,.3,1); }
    @media (prefers-reduced-motion: reduce) { .gvside__brand .gvmark { transition: none; } }

    /* Omni search — one field, filters whatever cards are on the right. Figma-style
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

    /* Nav groups + items — higher-contrast, roomier rows to match the Figma reference. */
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
    @media (prefers-reduced-motion: reduce) {
      .gvside, .gvscrim, .gvburger__bars span, .gvside__caret { transition: none; }
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
const IC_LIBRARY = ic(`<path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/>`); // library
const IC_CHANGELOG = ic(`<path d="M12 8v4l3 2"/><path d="M3.05 11a9 9 0 1 1 .5 4"/><path d="M3 21v-5h5"/>`); // history (clock + counter-rotate)
const IC_CHEV = ic(`<path d="m9 18 6-6-6-6"/>`); // chevron-right (rotates open via CSS)
const IC_TOKEN = ic(`<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>`); // palette (tokens)
const IC_PATTERN = ic(`<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M10 6.5h4M6.5 10v4M17.5 10v4M10 17.5h4"/>`); // grid + links (patterns)

// Star toggle on cards — Lucide 'star'. Outline (grey) when unpinned, gold-filled
// when pinned (PINS_JS toggles .is-pinned). Its own class so CSS can flip the fill.
const IC_STAR = `<svg class="pin-star" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/></svg>`;

// A "pin to sidebar" star button for a pinnable card. PINS_JS reads/sets state.
function pinStar(key, href) {
  return `<button type="button" class="pin-btn" data-pin-key="${key}" data-pin-href="${href}" aria-pressed="false" aria-label="Pin to sidebar" title="Pin to sidebar">${IC_STAR}</button>`;
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
const NAV_STATE = { opportunities: [], hasPlayground: false };

// The omni search field — lives in the rail, filters whatever cards are on the right
// (the shared chrome script wires [data-filter] to the current page's [data-fitem]).
function railSearch() {
  return `<div class="gvsearch">${SEARCH_ICON}` +
    `<input type="text" data-filter placeholder="Search…" aria-label="Search content" autocomplete="off" autocapitalize="off" spellcheck="false" />` +
    `<button type="button" class="gvsearch__clear" data-filter-clear aria-label="Clear search" hidden>&times;</button>` +
    `<kbd data-filter-kbd>/</kbd></div>`;
}

// The persistent left rail: brand → omni search → Playground → Opportunities → Pinned
// (the user's starred prototypes/projects, rendered client-side by PINS_JS) → Library
// (collapsible, pinned to the bottom). `active` is a single key: 'prototypes' |
// 'playground' | <opportunity name> | 'primitives' | 'components' | 'pages'.
function sideRail(active) {
  const item = (href, label, key, icon) =>
    `<a href="${href}"${active === key ? ' aria-current="page"' : ""}>${icon}<span>${label}</span></a>`;
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
    <a class="gvside__brand" href="/" aria-label="Augur — home">
      ${GV_MARK}<span class="gvside__brandname">augur</span>
    </a>
    ${railSearch()}
    <div class="gvside__rule"></div>
    <div class="gvside__scroll">
      <div class="gvside__group">
        ${item("/", "Opportunities", "prototypes", IC_HOME)}
        ${playground}
      </div>
      ${pinned}
    </div>
    <div class="gvside__foot">
      <div class="gvside__rule"></div>
      ${library}
      <div class="gvside__group" style="margin-top:6px">
        <a href="/changelog/"${active === "changelog" ? ' aria-current="page"' : ""}>${IC_CHANGELOG}<span>Changelog</span><span class="gvside__ver">v${UI_VERSION}</span></a>
      </div>
    </div>
  </aside>`;
}

// Full chrome injected at the top of <body>: slim mobile top bar + the rail + the
// drawer scrim (the last two are off-canvas / hidden on desktop via CSS).
function appChrome(active) {
  const top = `<header class="gvtop">
    <button type="button" class="gvburger" data-side-toggle aria-expanded="false" aria-controls="gvside" aria-label="Open navigation"><span class="gvburger__bars" aria-hidden="true"><span></span><span></span><span></span></span></button>
    <a class="gvtop__brand" href="/">${GV_MARK}<span>augur</span></a>
  </header>`;
  return `${top}${sideRail(active)}<div class="gvscrim" data-side-scrim></div>`;
}

/** Shared chrome script: real-time in-page filter + the mobile rail drawer. */
function chromeScript() {
  return `(function(){
  // ── Brand mark: each hover spins it a full turn forward, then rests there ──
  var brand = document.querySelector('.gvside__brand');
  if (brand && !brand.dataset.spin) {
    brand.dataset.spin = '1';
    var mark = brand.querySelector('.gvmark');
    var turns = 0;
    brand.addEventListener('mouseenter', function(){
      if (!mark) return;
      turns++;
      mark.style.transform = 'rotate(' + (turns * 360) + 'deg)';
    });
  }
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
})();`;
}

/** Inject the nav (with its own styles) right after the opening <body> tag. */
function injectNav(html, active) {
  const m = html.match(/<body[^>]*>/i);
  if (!m) return html;
  return html.replace(
    m[0],
    `${m[0]}\n  <style>${NAV_CSS}</style>\n  ${appChrome(active)}\n  <script>${chromeScript()}</script>\n  <script>${PINS_JS}</script>`
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

// Right-click menu for prototype cards (Figma-style). Acts on any card carrying
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
    html+='<hr>'+item('delete','Delete',ICON.del,true);
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
  function renderList(){
    if(!listEl) return;
    var keys = Object.keys(map);
    listEl.innerHTML = keys.map(function(k){
      var it = map[k] || {}; var parts = splitEmoji(it.label || k);
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
    .then(function(d){ if(d && !d.warning) adopt(d.map); loaded = true; }).catch(function(){});
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
  <script>${PINS_JS}
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
       <code>&lt;opportunity&gt;/prototypes/&lt;name&gt;/</code> and rebuild.</p>`,
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
            <div class="proto-name">${titleCase(opp.name)}</div>
            <div class="proto-date">${plural(opp.prototypes.length, "prototype")} &middot; <span title="${fmtDate(opp.mtimeMs)}">${relTime(opp.mtimeMs)}</span></div>
          </div>
        </div>`;
    })
    .join("");

  // Nav (Playground + opportunities) now lives in the global left rail — the landing
  // page is just a single wide column of opportunity cards.
  const body = `
    <header class="folderbar"><h1 class="folderbar__title">Opportunities</h1><span class="folderbar__count">${opportunities.length}</span><span class="folderbar__rule"></span></header>
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
      const pinKey = `/${encodeURIComponent(opp.name)}/${encodeURIComponent(p.name)}/`;
      const dname = protoName(p.name);
      return `
        <div class="card-proto" data-fitem data-fkey="${titleCase(p.name)}" data-rename-key="${opp.name}/${p.name}" data-default-name="${dname}">
          <div class="preview">
            ${media(p.href, p.poster)}
            <a class="preview-link" href="${p.href}" aria-label="Open ${titleCase(p.name)}"></a>
            <div class="preview-actions">
              ${download}
              ${pinStar(pinKey, pinKey)}
            </div>
            ${statusChip(p.status, opp.name + "/" + p.name)}
          </div>
          <div class="proto-meta">
            <div class="proto-text">
              <div class="proto-name">${dname}</div>
              <div class="proto-date" title="${fmtDate(p.mtimeMs)}">${relTime(p.mtimeMs)}</div>
            </div>
          </div>
        </div>`;
    })
    .join("");

  return shell({
    title: titleCase(opp.name),
    activeTab: opp.name,
    wrapClass: "wrap--wide",
    body: `<header class="folderbar"><a class="folderbar__up" href="/" aria-label="All opportunities" title="All opportunities"><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></a><h1 class="folderbar__title">${titleCase(opp.name)}</h1><span class="folderbar__count">${opp.prototypes.length}</span><span class="folderbar__rule"></span></header><div data-fgroup><div class="page-grid is-3up">${cards}</div></div>${filterEmpty()}`,
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
      const pinKey = `/playground/${encodeURIComponent(p.name)}/`;
      const dname = protoName(p.name);
      return `
        <div class="card-opp" data-fitem data-fkey="${titleCase(p.name)}" data-rename-key="playground/${p.name}" data-default-name="${dname}">
          <a class="card-cover-link" href="${folder}" aria-label="Open ${titleCase(p.name)}"></a>
          <div class="preview">
            ${media(p.href, p.poster)}
            ${statusChip(p.status, "playground/" + p.name)}
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
      subtitle: "Composed Go Vocal reference pages &mdash; copy one as a starting point.",
      activeTab: "pages",
      wrapClass: "wrap--wide",
      body: `<p class="empty">No reference pages yet. Add one under
        <code>pages/&lt;name&gt;/</code> and rebuild.</p>`,
    });
  }

  // Pages are a designer reference — Open only, no HTML download.
  const pageCard = (p) => `
        <div class="card-proto" data-fitem data-fkey="${titleCase(p.name)}" data-rename-key="pages/${p.name}" data-default-name="${titleCase(p.name)}">
          <div class="preview">
            ${media(p.href, p.poster)}
            <a class="preview-link" href="${p.href}" aria-label="Open ${titleCase(p.name)}"></a>
          </div>
          <div class="proto-meta">
            <div class="proto-name">${titleCase(p.name)}</div>
          </div>
        </div>`;

  // Split by surface into three collapsible groups: Front office (city-themed
  // shells), Methods (participation-method runners), Back office (Go Vocal's theme).
  // Superseded reference pages — kept available but grouped under a collapsed
  // "Legacy" section at the bottom. bo-project-phase is the old Project Editor,
  // superseded by the new editor (parallel-editor-builder-v3, being progressed to
  // canonical). Add a slug here to retire a page from the main groups.
  const LEGACY_PAGES = new Set(["bo-project-phase"]);
  const isLegacy = (p) => LEGACY_PAGES.has(p.name);
  const front = pages.filter((p) => p.surface === "front-office" && !isLegacy(p));
  const methods = pages.filter((p) => p.surface === "method" && !isLegacy(p));
  const back = pages.filter((p) => p.surface === "back-office" && !isLegacy(p));
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
        <tr data-fitem data-fkey="${fkey}" data-rename-key="components/${c.name}" data-default-name="${escAttr(dname)}">
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
        <div class="card-proto" data-fitem data-fkey="${titleCase(p.name)}" data-rename-key="${activeTab}/${p.name}" data-default-name="${titleCase(p.name)}">
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

// ── Tokens tab — GENERATED from the canonical govocal-tokens.css via the graph ─
// Every --gv-* token: a swatch (when its resolved raw value is a colour), the
// declared value, the alias chain down to the raw value, and how many tokens/
// classes drink from it. Proves the bottom of the import chain is real, not asserted.
function isColorVal(v) {
  return !!v && /^(#|rgb|hsl|color-mix)/i.test(v.trim());
}
function tokenGroup(name) {
  if (/^--gv-fs-|^--gv-font/.test(name)) return "Typography";
  if (/^--gv-shadow/.test(name)) return "Elevation";
  if (/^--gv-radius|width|height|padding|^--gv-menu-|frame-w/.test(name)) return "Sizing & layout";
  if (/^--gv-focus/.test(name)) return "Focus";
  return "Colour"; // default — the bulk of the palette
}
function renderTokensIndex(graph) {
  const tokens = graph.tokens || {};
  const names = Object.keys(tokens);
  const groups = {};
  for (const name of names) (groups[tokenGroup(name)] ||= []).push(name);
  const ORDER = ["Colour", "Typography", "Sizing & layout", "Elevation", "Focus"];
  const ordered = [...ORDER.filter((g) => groups[g]), ...Object.keys(groups).filter((g) => !ORDER.includes(g))];

  const chip = (name) => {
    const t = tokens[name];
    const consumers = (t.consumedBy.tokens.length + t.consumedBy.classes.length);
    const swatch = isColorVal(t.raw)
      ? `<span class="tok-sw" style="background:${t.raw}"></span>`
      : `<span class="tok-sw tok-sw--mono">Aa</span>`;
    const chain = t.chain.length > 1
      ? `<div class="tok-chain">${t.chain.map((c) => `<code>${c}</code>`).join('<span class="tok-arrow">→</span>')}<span class="tok-arrow">→</span><code class="tok-raw">${escAttr(t.raw || "")}</code></div>`
      : `<div class="tok-chain"><code class="tok-raw">${escAttr(t.raw || t.value)}</code></div>`;
    const fkey = `${name} ${t.raw || ""} ${t.value}`.replace(/"/g, "");
    return `
      <div class="tok" data-fitem data-fkey="${fkey}">
        ${swatch}
        <div class="tok-body">
          <code class="tok-name">${name}</code>
          ${chain}
          <div class="tok-meta">${consumers ? `${consumers} consumer${consumers === 1 ? "" : "s"}` : "no direct consumers"}</div>
        </div>
      </div>`;
  };
  const sections = ordered.map((g) => `
      <details class="fsection" data-fgroup open>
        <summary class="section-eyebrow"><span class="fsection__caret" aria-hidden="true"></span>${g} &middot; ${groups[g].length}</summary>
        <div class="tok-grid">${groups[g].map(chip).join("")}</div>
      </details>`).join("");

  return shell({
    title: "Tokens", activeTab: "tokens", wrapClass: "wrap--wide",
    body: `<header class="folderbar"><h1 class="folderbar__title">Tokens</h1><span class="folderbar__count">${names.length}</span><span class="folderbar__rule"></span></header>` +
      `<p class="tier-hint">The design-system variables (<code>--gv-*</code>), parsed live from <code>govocal-tokens.css</code> — each with its alias chain down to a raw value and how much of the system drinks from it. This is the bottom of every import chain Base · Components · Patterns · Pages resolve to.</p>` +
      `${sections}${filterEmpty()}`,
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

async function main() {
  // Clean dist for a deterministic build. Retry the removal: on macOS a
  // concurrent .DS_Store / Spotlight write can re-create a dir entry between
  // node's readdir and rmdir, throwing ENOTEMPTY on an otherwise-empty tree.
  await fs.rm(DIST, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await fs.mkdir(DIST, { recursive: true });

  // Scan every source (each also copies its folders into dist).
  const opportunities = await scan();
  const base = await scanBase();
  const components = await scanComponents();
  const patterns = await scanPatterns();
  const pages = await scanPages();
  // Composition graph, derived from the canonical CSS (the honesty backbone).
  const graph = await buildGraph();

  // Publish the nav context BEFORE any render so the global left rail (org switcher +
  // Prototypes/Playground + Opportunities + Library) is identical on every page.
  NAV_STATE.opportunities = opportunities;
  NAV_STATE.hasPlayground = await isDir(path.join(WS_ROOT, "playground"));

  // Root index → opportunities.
  await fs.writeFile(path.join(DIST, "index.html"), renderRootIndex(opportunities), "utf8");

  // Per-opportunity index → prototypes.
  for (const opp of opportunities) {
    await fs.writeFile(
      path.join(DIST, opp.name, "index.html"),
      renderOpportunityIndex(opp),
      "utf8"
    );
  }

  // ── Primitives tab → ship the govocal-ui gallery (tokens: colour, type, shadow,
  // and the base primitives) + its assets out of the skill (skills/ doesn't ship
  // on its own). Inject the site nav into the gallery.
  const patternsDir = path.join(DIST, "primitives");
  await fs.mkdir(patternsDir, { recursive: true });
  const galleryHtml = await fs.readFile(path.join(UI_SKILL, "gallery.html"), "utf8");
  await fs.writeFile(
    path.join(patternsDir, "index.html"),
    injectPrimitives(galleryHtml),
    "utf8"
  );
  const patternAssets = ["govocal-tokens.css", "govocal-primitives.css", "govocal-ui.css", "govocal-themes.js", "govocal-cookies.js", "govocal-icons.js", "govocal-logo.svg"];
  for (const asset of patternAssets) {
    if (await exists(path.join(UI_SKILL, asset))) {
      await fs.copyFile(path.join(UI_SKILL, asset), path.join(patternsDir, asset));
    }
  }

  // ── Canonical shared assets → dist/skills/govocal-ui/ (whitelist ONLY — never
  // the internal .md files like SKILL.md / components.md). Library demos
  // (components/<name>/, pages/<name>/) reference these via ../../skills/govocal-ui/
  // so they're HARDWIRED to the live canonical source — no per-folder snapshot, so
  // drift between primitives → components → pages is structurally impossible. The
  // same relative path resolves locally (file://) and here on the shipped site.
  // (Prototypes are the only tier that still copies assets — they're allowed to fork.)
  const SHARED_ASSETS = [
    "govocal-tokens.css", "govocal-primitives.css", "govocal-ui.css", "govocal-bo.css",
    "govocal-themes.js", "govocal-cookies.js", "govocal-icons.js",
    "govocal-avatars.js", "govocal-rail.js", "govocal-partbar.js",
    "govocal-survey.css", "govocal-survey.js", "govocal-logo.svg",
    "govocal-charts.js",
    "govocal-pagebuilder.js", "govocal-widgets.js", "govocal-widgets.css",
    "govocal-instances.js",
  ];
  const sharedDir = path.join(DIST, "skills", "govocal-ui");
  await fs.mkdir(sharedDir, { recursive: true });
  for (const asset of SHARED_ASSETS) {
    if (await exists(path.join(UI_SKILL, asset))) {
      await fs.copyFile(path.join(UI_SKILL, asset), path.join(sharedDir, asset));
    }
  }
  // Asset SUBDIRECTORIES the shared JS depends on (binary, so not in the file
  // whitelist above): e.g. avatars/ — the bundled face set govocal-avatars.js
  // drops into every .av bubble. Copied wholesale so the faces resolve on the
  // shipped site exactly as they do locally (file://).
  const SHARED_ASSET_DIRS = ["avatars", "img", "vendor"];
  for (const d of SHARED_ASSET_DIRS) {
    if (await isDir(path.join(UI_SKILL, d))) {
      await copyDir(path.join(UI_SKILL, d), path.join(sharedDir, d));
    }
  }

  // ── Tokens tab → GENERATED from govocal-tokens.css via the composition graph.
  await fs.mkdir(path.join(DIST, "tokens"), { recursive: true });
  await fs.writeFile(
    path.join(DIST, "tokens", "index.html"),
    renderTokensIndex(graph),
    "utf8"
  );

  // ── Base tab → base-atom demos from base/<name>/.
  await fs.mkdir(path.join(DIST, "base"), { recursive: true });
  await fs.writeFile(
    path.join(DIST, "base", "index.html"),
    renderBaseIndex(base),
    "utf8"
  );

  // ── Components tab → composed component library from components/<name>/.
  await fs.mkdir(path.join(DIST, "components"), { recursive: true });
  await fs.writeFile(
    path.join(DIST, "components", "index.html"),
    renderComponentsIndex(components),
    "utf8"
  );

  // ── Patterns tab → curated composition demos from patterns/<name>/.
  await fs.mkdir(path.join(DIST, "patterns"), { recursive: true });
  await fs.writeFile(
    path.join(DIST, "patterns", "index.html"),
    renderPatternsIndex(patterns),
    "utf8"
  );

  // ── Pages tab → composed reference pages from pages/<name>/.
  await fs.mkdir(path.join(DIST, "pages"), { recursive: true });
  await fs.writeFile(
    path.join(DIST, "pages", "index.html"),
    renderPagesIndex(pages),
    "utf8"
  );

  // ── Changelog → rendered from the hand-edited changelog.md (the .md itself is
  // internal and never copied; only this generated page ships).
  const changelog = await loadChangelog();
  await fs.mkdir(path.join(DIST, "changelog"), { recursive: true });
  await fs.writeFile(
    path.join(DIST, "changelog", "index.html"),
    renderChangelogPage(changelog),
    "utf8"
  );

  // ── Playground → a folder that acts like an opportunity but stays pinned in the
  // root sidebar. Copy the whole tree verbatim (shared assets + project subfolders),
  // then overwrite its index.html with a generated folder browser of the subfolders.
  let playground = [];
  if (await isDir(path.join(WS_ROOT, "playground"))) {
    await copyDir(path.join(WS_ROOT, "playground"), path.join(DIST, "playground"), isInternalOnly);
    playground = await scanPlayground();
    await fs.writeFile(
      path.join(DIST, "playground", "index.html"),
      renderPlaygroundIndex(playground),
      "utf8"
    );
  }
  const hasPlayground = playground.length >= 0 && (await isDir(path.join(DIST, "playground")));

  // Optional self-contained build addon emits its own dist files (if present).
  if (addon) await addon.emit({ ROOT, DIST, fs, path, copyDir, isInternalOnly, exists });

  // Edge auth gate. Inject the list of PUBLIC prototype path-prefixes so the
  // password gate covers only the internal site — published prototypes stay open.
  // (Derived from what actually shipped above, so the gate can never drift.)
  const publicPrefixes = opportunities.flatMap((opp) =>
    opp.prototypes.map(
      (p) => `/${encodeURIComponent(opp.name)}/${encodeURIComponent(p.name)}/`
    )
  );
  // Playground projects ship verbatim and are public too — individual scratch
  // prototypes are link-shareable. Only the prototype folders are opened; the
  // /playground/ index listing itself stays gated (a shorter path that matches no
  // prefix), so the scratch catalogue isn't exposed.
  for (const pj of playground) {
    publicPrefixes.push(`/playground/${encodeURIComponent(pj.name)}/`);
  }

  // Per-page live-reload versions. Map each shipped folder's URL prefix → a token
  // that changes ONLY when that folder's content changes (its git/fs last-change
  // time). The worker injects the matching token into each page and serves it from
  // /__version?path=…; a tab reloads only when ITS token changes — so a deploy that
  // touched a different prototype never reloads an unrelated open tab. Anything not
  // matched (index/shell pages, assets) falls back to BUILD_ID (reload every deploy,
  // which is fine for the listings — they're meant to show the latest).
  const versionMap = {};
  for (const opp of opportunities)
    for (const p of opp.prototypes)
      versionMap[`/${encodeURIComponent(opp.name)}/${encodeURIComponent(p.name)}/`] = String(p.mtimeMs);
  for (const c of components) versionMap[`/components/${encodeURIComponent(c.name)}/`] = String(c.mtimeMs);
  for (const b of base) versionMap[`/base/${encodeURIComponent(b.name)}/`] = String(b.mtimeMs);
  for (const pt of patterns) versionMap[`/patterns/${encodeURIComponent(pt.name)}/`] = String(pt.mtimeMs);
  for (const pg of pages) versionMap[`/pages/${encodeURIComponent(pg.name)}/`] = String(pg.mtimeMs);
  for (const pj of playground) versionMap[`/playground/${encodeURIComponent(pj.name)}/`] = String(pj.mtimeMs);

  const workerSrc = await fs.readFile(SRC_WORKER, "utf8");
  const gatedWorker = workerSrc.replace(
    "const PUBLIC_PREFIXES = [];",
    `const PUBLIC_PREFIXES = ${JSON.stringify(publicPrefixes)};`
  );
  if (gatedWorker === workerSrc) {
    throw new Error("build: PUBLIC_PREFIXES placeholder not found in src/_worker.js");
  }
  const stampedWorker = gatedWorker
    .replace('const BUILD_ID = "dev";', `const BUILD_ID = ${JSON.stringify(BUILD_ID)};`)
    .replace("const VERSION_MAP = {};", `const VERSION_MAP = ${JSON.stringify(versionMap)};`);
  if (stampedWorker === gatedWorker) {
    throw new Error("build: BUILD_ID / VERSION_MAP placeholder not found in src/_worker.js");
  }
  await fs.writeFile(path.join(DIST, "_worker.js"), stampedWorker, "utf8");

  // Review overlay asset (shared by every injected prototype).
  await fs.mkdir(path.join(DIST, "__review"), { recursive: true });
  await fs.copyFile(SRC_REVIEW, path.join(DIST, "__review", "comments.js"));
  await fs.copyFile(SRC_REVIEW_CAT, path.join(DIST, "__review", "aslam.png"));
  // Composition graph (DERIVED from canonical CSS) → window.__GV_GRAPH, loaded before
  // comments.js so the overlay can recurse tokens → base → components → patterns.
  await fs.writeFile(
    path.join(DIST, "__review", "graph.js"),
    "window.__GV_GRAPH=" + JSON.stringify(graph) + ";",
    "utf8"
  );

  // Self-hosted fonts → /fonts/ (served immutable + public by the worker). Replaces
  // the render-blocking Google Fonts link; one variable woff2 covers every weight.
  if (await isDir(path.join(ROOT, "fonts"))) {
    await copyDir(path.join(ROOT, "fonts"), path.join(DIST, "fonts"));
  }
  // LentiaNova — the Augur display/title face → /fonts/. Neutral (400) from the Linz
  // capture; Median (600) + Bulky (800) from brand/ (pulled from the same Linz font
  // server). govocal-exports never ships, but these font files do, matching FONT_CSS.
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

  const protoCount = opportunities.reduce((n, o) => n + o.prototypes.length, 0);
  console.log(
    `Built dist/ — ${plural(opportunities.length, "opportunity").replace("opportunitys", "opportunities")}, ${plural(protoCount, "prototype")}.`
  );
  for (const opp of opportunities) {
    console.log(`  ${opp.name}/`);
    for (const p of opp.prototypes) console.log(`    - ${p.name}`);
  }
  if (hasPlayground) {
    console.log(`  playground/  — ${plural(playground.length, "project")}`);
    for (const p of playground) console.log(`    - ${p.name}`);
  }
  console.log(`  tokens/  — ${Object.keys(graph.tokens).length} tokens (generated from govocal-tokens.css)`);
  console.log(`  base/  — ${plural(base.length, "atom demo")}`);
  console.log(`  components/  — ${plural(components.length, "component")}`);
  console.log(`  patterns/  — ${plural(patterns.length, "pattern")}`);
  console.log(`  primitives/  (Primitives gallery — legacy, not in nav)`);
  console.log(`  pages/  — ${plural(pages.length, "reference page")}`);
  for (const p of pages) console.log(`    - ${p.name}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
