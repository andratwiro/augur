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
const DIST = path.join(ROOT, "dist");
const SRC_WORKER = path.join(ROOT, "src", "_worker.js");
const SRC_REVIEW = path.join(ROOT, "src", "review", "comments.js");

// Marker-wrapped tag injected into every prototype's HTML. Dormant until the
// reviewer hits Shift+C; the markers let the Download HTML button strip it so
// devs get a clean file. Absolute path => served from /dist root by the worker.
const REVIEW_TAG =
  '<!--gv-review-start--><script src="/__review/comments.js" defer></script><!--gv-review-end-->';

/** Inject the review overlay tag before </body> (or append if none). */
function injectReview(html) {
  if (html.includes("gv-review-start")) return html; // already injected
  const i = html.toLowerCase().lastIndexOf("</body>");
  return i === -1 ? html + REVIEW_TAG : html.slice(0, i) + REVIEW_TAG + html.slice(i);
}

// Version of the PROTOTYPES SITE UI (the landing/shell pages this file generates),
// shown in the footer. Bump this ONLY when the site UI changes — i.e. edits to
// build.js shell/CSS, the index pages, or features like carousel/comments/download.
// Do NOT bump it for changes inside individual prototypes; their content is
// versioned by their own modified date, not this number.
const UI_VERSION = "0.22";

// Top-level folders that are never treated as opportunity folders.
const IGNORED_TOPLEVEL = new Set([
  "dist",
  "node_modules",
  "skills",
  "src",
  "pages", // composed reference pages — shipped via their own builder, not as an opportunity
  "components", // composed component library — shipped via its own builder, not as an opportunity
  "playground", // standalone scratch prototype — shipped to /playground/, not as an opportunity
  "references", // internal source exports (raw GoVocal HTML + screenshots) — NEVER ships
  "govocal-exports", // internal raw GoVocal page exports (HTML + screenshots) — NEVER ships
  ".git",
  ".github",
]);

// Planned reference pages (Pages tab) that aren't built yet — rendered as a
// "Pending" roadmap so the team sees what's coming. Remove a slug here once its
// real page lands under pages/<slug>/. Slugs are kebab-case; titleCase() labels them.
const PENDING_PAGES = [
  "survey-builder",
  "voting",
  "common-ground",
  "ideation",
];

// Pages index has three top-level groups: Front office, Methods, Back office.
// "Methods" are the front-office screens where a resident actually runs a
// participation method (survey, proposals, …). Classified by slug here; a page
// can also opt in/out via <meta name="gv-surface" content="method">.
const METHOD_PAGES = new Set([
  "project-survey", // Survey
  "project-proposals", // Proposals / Petitions
  "project-volunteering", // Recruit volunteers
  "project-common-ground", // Common Ground
  "perspectives-feed", // Ideation — Perspectives feed view
  "perspectives-entry", // Ideation — Perspectives intro
  "input-form", // Ideation — input/submission form
]);

// Source for the reference tabs (Primitives · Components · Pages).
const UI_SKILL = path.join(ROOT, "skills", "govocal-ui"); // Primitives gallery + assets
const PAGES_SRC = path.join(ROOT, "pages"); // composed reference pages
const COMPONENTS_SRC = path.join(ROOT, "components"); // composed component library

// Short blurb + key classes per component, shown in the Components table.
// Keyed by folder name; falls back to a generic line for anything unlisted.
const COMPONENT_BLURBS = {
  "header-nav": {
    classes: ".gv-header / .gv-nav / .gv-nav-m",
    desc: "Responsive 78px site chrome: logo slot, dropdown + “Mehr ···” overflow, search, CTA; CSS-only hamburger drawer on mobile.",
  },
  footer: {
    classes: ".gv-footer / .gv-powered-logo",
    desc: "Centered tenant logo, middot-separated legal links, and the “Ermöglicht durch go·vocal” powered-by attribution.",
  },
  "project-card": {
    classes: ".gv-rail / .gv-pcard",
    desc: "Participation-project card (thumb, title, status meta, CTA) + horizontal rail. Stretched-link card — no nested anchors.",
  },
  hero: {
    classes: ".gv-hero / .gv-avatars",
    desc: "Full-bleed page banner: tenant-tinted overlay, title/lead, avatar + count stack, primary CTA. Image-agnostic.",
  },
};

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
async function copyDir(src, dest, exclude) {
  await fs.mkdir(dest, { recursive: true });
  let latest = 0;
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (exclude && exclude(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      latest = Math.max(latest, await copyDir(srcPath, destPath, exclude));
    } else if (entry.isFile()) {
      if (entry.name.endsWith(".html")) {
        const html = await fs.readFile(srcPath, "utf8");
        await fs.writeFile(destPath, injectReview(html), "utf8");
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
  const topEntries = await fs.readdir(ROOT, { withFileTypes: true });

  for (const top of topEntries) {
    if (!top.isDirectory()) continue;
    if (IGNORED_TOPLEVEL.has(top.name) || top.name.startsWith(".")) continue;

    const protoParent = path.join(ROOT, top.name, "prototypes");
    if (!(await isDir(protoParent))) continue;

    const protoEntries = await fs.readdir(protoParent, { withFileTypes: true });
    const prototypes = [];

    for (const proto of protoEntries) {
      if (!proto.isDirectory()) continue;
      const protoDir = path.join(protoParent, proto.name);

      // Copy ONLY the prototype folder into dist.
      const destDir = path.join(DIST, top.name, proto.name);
      const latest = await copyDir(protoDir, destDir);

      const { href, file } = await entryPoint(proto.name, protoDir);
      prototypes.push({
        name: proto.name,
        href,
        file,
        mtimeMs: modifiedTime(protoDir, latest),
      });
    }

    if (prototypes.length === 0) continue;

    prototypes.sort(byRecency);
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
    const latest = await copyDir(dir, path.join(DIST, "pages", e.name));
    const { href, file } = await entryPoint(e.name, dir);
    // Surface = back-office (GoVocal's own theme), front-office (city-themed), or
    // method (a front-office participation-method runner — its own Pages group).
    // Base it on the bo-/fo- name prefix + METHOD_PAGES, then let the
    // <meta name="gv-surface"> tag override (back | front | method).
    let surface = /^bo-/.test(e.name) ? "back-office" : "front-office";
    if (METHOD_PAGES.has(e.name)) surface = "method";
    try {
      const html = await fs.readFile(file, "utf8");
      const m = html.match(/<meta\s+name=["']gv-surface["']\s+content=["']([^"']+)["']/i);
      if (m) {
        const v = m[1].toLowerCase();
        surface = /back/.test(v) ? "back-office" : /method/.test(v) ? "method" : "front-office";
      }
    } catch {}
    pages.push({ name: e.name, href, file, surface, mtimeMs: modifiedTime(dir, latest) });
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
    const latest = await copyDir(dir, path.join(DIST, "components", e.name));
    const { href, file } = await entryPoint(e.name, dir);
    components.push({ name: e.name, href, file, mtimeMs: modifiedTime(dir, latest) });
  }
  components.sort(byRecency);
  return components;
}

/**
 * Scan playground/<project>/ subfolders. Playground is "a folder, just outside"
 * the opportunities: a pinned scratch container the user drops project folders
 * into. Each subfolder is a self-contained prototype (its own index.html). The
 * whole playground/ tree is copied verbatim elsewhere (copyDir) — this only reads
 * the subfolders to render the Playground landing, so adding a folder = it appears.
 * hrefs are relative to dist/playground/index.html.
 */
async function scanPlayground() {
  const root = path.join(ROOT, "playground");
  if (!(await isDir(root))) return [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  const projects = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const dir = path.join(root, e.name);
    const { href, file } = await entryPoint(e.name, dir);
    projects.push({ name: e.name, href, file, mtimeMs: modifiedTime(dir, await latestMtime(dir)) });
  }
  projects.sort(byRecency);
  return projects;
}

// Slug words that should render fully upper-cased (acronyms) rather than
// Capitalized — so `sms-verification` reads "SMS Verification", not "Sms …".
const ACRONYMS = new Set(["sms", "ui", "ux", "uxui", "api", "url", "faq", "sso", "cta", "pdf", "csv", "riot"]);

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

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

const PAGE_CSS = `
    /* Linear-style shell — light edition: near-white canvas, indigo accent, Inter type.
       This is the TOOLING UI; a light shell sits comfortably next to GoVocal's light brand. */
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
    .wrap { position: relative; z-index: 1; max-width: var(--maxw); margin: 0 auto; padding: 60px 24px 120px; }
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

    /* ---- In-page real-time filter field ---- */
    .pfilter {
      display: flex; align-items: center; gap: 9px; width: min(420px, 100%); height: 40px;
      padding: 0 10px 0 12px; margin: 0 0 28px; box-sizing: border-box;
      background: var(--card); border: 1px solid var(--line); border-radius: 10px;
      transition: border-color .12s ease, box-shadow .12s ease;
    }
    .pfilter:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(94,106,210,0.14); }
    .pfilter svg { width: 16px; height: 16px; flex: none; color: var(--faint); }
    .pfilter input { flex: 1; min-width: 0; background: none; border: 0; outline: none; color: var(--fg); font: inherit; font-size: 14px; }
    .pfilter input::placeholder { color: var(--faint); }
    .pfilter kbd {
      flex: none; font: inherit; font-size: 11px; line-height: 1; padding: 3px 6px; border-radius: 5px;
      background: var(--bg-2); border: 1px solid var(--line); color: var(--muted);
    }
    .pfilter__clear {
      flex: none; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 6px; cursor: pointer;
      display: grid; place-items: center; background: var(--bg-2); color: var(--muted); font-size: 16px; line-height: 1;
      transition: background .12s ease, color .12s ease;
    }
    .pfilter__clear:hover { background: var(--line); color: var(--fg); }
    .pfilter kbd[hidden], .pfilter__clear[hidden] { display: none; }
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
    footer { margin-top: 64px; padding-top: 22px; border-top: 1px solid var(--line); color: var(--faint); font-size: 12.5px; }

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
    .preview-link { position: absolute; inset: 0; z-index: 2; }
    /* Download icon overlays the preview image, top-right, above the cover link.
       A translucent white backdrop keeps it legible over any screenshot. */
    .preview-actions { position: absolute; top: 8px; right: 8px; z-index: 3; display: flex; gap: 6px; }
    .preview-actions .btn-icon {
      background: rgba(255,255,255,0.92); border-color: rgba(16,24,40,0.14); color: #1d2333;
      box-shadow: 0 2px 8px -2px rgba(16,24,40,0.30); backdrop-filter: blur(4px);
    }
    .preview-actions .btn-icon:hover { background: #fff; border-color: var(--accent); }
    .opp-meta, .proto-meta { padding: 16px 18px; }
    .proto-meta {
      display: flex; align-items: flex-start; justify-content: space-between;
      gap: 12px; flex-wrap: wrap;
    }
    .proto-text { min-width: 0; flex: 1 1 auto; }
    .proto-name { font-weight: 600; font-size: 16px; letter-spacing: -0.015em; }
    .proto-date { color: var(--muted); font-size: 12.5px; margin-top: 3px; }
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
    .page-grid .card-proto { transition: box-shadow .18s ease, transform .18s ease; }
    .page-grid .card-proto:hover { box-shadow: 0 12px 28px -14px rgba(16,24,40,0.28); border-color: var(--line-2); transform: translateY(-3px); }
    .page-grid .proto-meta { padding: 12px 14px; }
    .page-grid .proto-name { font-size: 15px; }

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
    .comp-desc { color: var(--muted); font-size: 14px; max-width: 42ch; }
    .comp-actions { white-space: nowrap; }
    @media (max-width: 620px) {
      .comp-table, .comp-table tbody, .comp-table tr, .comp-table td { display: block; }
      .comp-table thead { display: none; }
      .comp-table td { border: 0; padding: 4px 0; }
      .comp-table tr { border-bottom: 1px solid var(--line); padding: 16px 0; }
      .comp-thumb { max-width: 100%; width: 100%; }
    }

    /* ---- Root layout: sticky sidebar + opportunity grid ----
       The landing page swaps the single centered column for a two-column shell:
       a thin nav rail (Playground pinned on top, then every opportunity) beside a
       responsive card grid that grows columns with available width. */
    .wrap--root { max-width: 1240px; display: grid; grid-template-columns: 212px minmax(0, 1fr); gap: 44px; align-items: start; }
    .root-side { position: sticky; top: 72px; display: flex; flex-direction: column; gap: 4px; }
    .side-pin {
      display: flex; align-items: center; gap: 11px; padding: 11px 13px;
      background: var(--card); border: 1px solid var(--line); border-radius: 10px;
      text-decoration: none; color: inherit; font-weight: 600; font-size: 14.5px;
      transition: border-color .14s ease, background .14s ease, transform .14s ease;
    }
    .side-pin:hover { border-color: var(--line-2); background: var(--card-hover); transform: translateY(-1px); }
    .side-pin__icon { font-size: 18px; line-height: 1; flex: none; }
    .side-divider { height: 1px; background: var(--line); margin: 12px 2px; }
    .side-label {
      font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase;
      color: var(--faint); margin: 0 0 8px 13px;
    }
    .side-nav { display: flex; flex-direction: column; gap: 1px; }
    .side-nav a {
      display: block; padding: 8px 13px; border-radius: 8px; text-decoration: none;
      color: var(--muted); font-weight: 500; font-size: 14px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      transition: background .12s ease, color .12s ease;
    }
    .side-nav a:hover { background: rgba(16,17,26,0.05); color: var(--fg); }
    .side-pin:focus-visible, .side-nav a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

    /* Figma-style auto-fill grid: as many ~260px columns as fit, no carousel. */
    .opp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 22px; }

    @media (max-width: 820px) {
      .wrap--root { grid-template-columns: 1fr; gap: 26px; }
      .root-side { position: static; flex-direction: row; flex-wrap: wrap; align-items: center; gap: 8px; }
      .side-divider, .side-label { display: none; }
      .side-nav { flex-direction: row; flex-wrap: wrap; gap: 6px; }
      .side-nav a { border: 1px solid var(--line); border-radius: 999px; padding: 6px 13px; }
    }

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
    }`;

const CAROUSEL_JS = `
    (function () {
      // Download HTML: fetch the prototype, strip the injected review tag so
      // devs get a clean, self-contained file.
      document.addEventListener('click', function (e) {
        var b = e.target.closest && e.target.closest('[data-dl]');
        if (!b) return;
        e.preventDefault();
        fetch(b.getAttribute('data-dl')).then(function (r) { return r.text(); }).then(function (t) {
          t = t.replace(/<!--gv-review-start-->[\\s\\S]*?<!--gv-review-end-->/g, '');
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
      if (window.ResizeObserver) {
        var ro = new ResizeObserver(function (es) { es.forEach(function (e) { fit(e.target); }); });
        previews.forEach(function (p) { ro.observe(p); fit(p); });
      } else {
        window.addEventListener('resize', function () { previews.forEach(fit); });
        previews.forEach(fit);
      }
    })();`;

// Top-right tab nav for the site's chrome/reference pages (Prototypes · Primitives ·
// Components · Pages). NOT injected into prototypes themselves. Styles are self-contained
// so the same nav can be injected into the Primitives gallery, which doesn't use PAGE_CSS.
// Root-relative hrefs => correct from any depth.
// Full-width sticky top bar (Linear-style). Self-contained literal colours so the
// same bar can be injected into the Primitives gallery (which doesn't load PAGE_CSS).
// The 52px bar height is reserved via body padding so content never hides under it.
const NAV_CSS = `
    body { padding-top: 52px; }
    .gvhead {
      position: fixed; top: 0; left: 0; right: 0; z-index: 2147483100; height: 52px;
      display: flex; align-items: center; justify-content: space-between; gap: 16px;
      padding: 0 18px;
      background: rgba(255,255,255,0.78); -webkit-backdrop-filter: blur(14px) saturate(180%); backdrop-filter: blur(14px) saturate(180%);
      border-bottom: 1px solid rgba(16,17,26,0.09);
      font: 500 13.5px/1 "Inter", "Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    .gvhead__brand { display: inline-flex; align-items: center; gap: 9px; min-width: 0; overflow: hidden; text-decoration: none; color: inherit; border-radius: 7px; transition: opacity .12s ease; }
    .gvhead__brand:hover { opacity: .72; }
    .gvhead__brand:focus-visible { outline: 2px solid #5e6ad2; outline-offset: 3px; }
    .gvhead__mark {
      width: 22px; height: 22px; flex: none; border-radius: 6px;
      background: linear-gradient(150deg, #828bf5, #5e6ad2 70%);
      box-shadow: 0 0 0 1px rgba(255,255,255,0.25) inset, 0 2px 8px rgba(94,106,210,0.4);
      display: grid; place-items: center; color: #fff; font-size: 12px; font-weight: 700; letter-spacing: -0.02em;
    }
    .gvhead__title { font-weight: 600; font-size: 13.5px; letter-spacing: -0.01em; color: #16171a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    /* Only drop the wordmark on the very narrowest phones — the hamburger frees the
       room the inline tabs used to eat, so the brand can stay visible far longer. */
    @media (max-width: 400px) { .gvhead__title { display: none; } }
    .gvnav { display: flex; align-items: center; gap: 1px; }
    .gvnav a {
      display: inline-flex; align-items: center; height: 30px; padding: 0 12px;
      border-radius: 7px; text-decoration: none; color: #5b626e; white-space: nowrap; font-weight: 500;
      transition: background .12s ease, color .12s ease;
    }
    .gvnav a:hover { background: rgba(16,17,26,0.05); color: #16171a; }
    .gvnav a[aria-current="page"] { background: rgba(16,17,26,0.08); color: #16171a; }
    .gvnav a:focus-visible { outline: 2px solid #5e6ad2; outline-offset: 1px; }

    /* ── Mobile menu (hamburger) ──────────────────────────────────────────────
       Below 720px the four inline tabs would crowd the search + brand, so they
       collapse into a dropdown opened by the hamburger. Desktop is untouched. */
    .gvnav-toggle {
      display: none; width: 34px; height: 32px; flex: none; padding: 0;
      align-items: center; justify-content: center; cursor: pointer;
      border-radius: 8px; border: 1px solid rgba(16,17,26,0.12);
      background: rgba(16,17,26,0.03); color: #16171a;
      transition: background .12s ease, border-color .12s ease;
    }
    .gvnav-toggle:hover { background: rgba(16,17,26,0.06); border-color: rgba(16,17,26,0.20); }
    .gvnav-toggle:focus-visible { outline: 2px solid #5e6ad2; outline-offset: 1px; }
    .gvnav-toggle__bars { position: relative; display: block; width: 16px; height: 12px; }
    .gvnav-toggle__bars span {
      position: absolute; left: 0; right: 0; height: 2px; border-radius: 2px; background: currentColor;
      transition: transform .18s ease, opacity .12s ease, top .18s ease;
    }
    .gvnav-toggle__bars span:nth-child(1) { top: 0; }
    .gvnav-toggle__bars span:nth-child(2) { top: 5px; }
    .gvnav-toggle__bars span:nth-child(3) { top: 10px; }
    .gvnav-toggle[aria-expanded="true"] .gvnav-toggle__bars span:nth-child(1) { top: 5px; transform: rotate(45deg); }
    .gvnav-toggle[aria-expanded="true"] .gvnav-toggle__bars span:nth-child(2) { opacity: 0; }
    .gvnav-toggle[aria-expanded="true"] .gvnav-toggle__bars span:nth-child(3) { top: 5px; transform: rotate(-45deg); }

    @media (max-width: 720px) {
      .gvnav-toggle { display: inline-flex; }
      .gvnav {
        position: absolute; top: calc(100% + 7px); right: 10px; z-index: 5;
        flex-direction: column; align-items: stretch; gap: 2px;
        min-width: 200px; padding: 7px;
        background: rgba(255,255,255,0.97); -webkit-backdrop-filter: blur(14px) saturate(180%); backdrop-filter: blur(14px) saturate(180%);
        border: 1px solid rgba(16,17,26,0.10); border-radius: 12px;
        box-shadow: 0 18px 48px -16px rgba(16,24,40,0.34);
        opacity: 0; visibility: hidden; transform: translateY(-6px);
        transition: opacity .15s ease, transform .15s ease, visibility .15s;
      }
      .gvnav.is-open { opacity: 1; visibility: visible; transform: translateY(0); }
      .gvnav a { height: 42px; padding: 0 14px; border-radius: 8px; font-size: 14.5px; }
      .gvnav a[aria-current="page"] { color: #3b43b0; }
    }
    @media (prefers-reduced-motion: reduce) {
      .gvnav, .gvnav-toggle__bars span { transition: none; }
    }

    .gvhead__actions { display: inline-flex; align-items: center; gap: 14px; min-width: 0; }`;

// Magnifier glyph reused by the trigger + the overlay input row.
const SEARCH_ICON = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/><path d="M21 21l-4.3-4.3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;

// In-page real-time filter field. Each listing page renders one near the top; the
// shared chrome script (filterScript) wires it to that page's [data-fitem] cards.
function filterField(placeholder) {
  return `<div class="pfilter">${SEARCH_ICON}` +
    `<input type="text" data-filter placeholder="${placeholder}" aria-label="${placeholder}" autocomplete="off" autocapitalize="off" spellcheck="false" />` +
    `<button type="button" class="pfilter__clear" data-filter-clear aria-label="Clear search" hidden>&times;</button>` +
    `<kbd data-filter-kbd>/</kbd>` +
  `</div>`;
}

// "No matches" line shown under the cards when a query filters everything out.
function filterEmpty() {
  return `<p class="filter-empty" data-filter-empty hidden>No matches.</p>`;
}

function navBar(active) {
  const tab = (href, label, key) =>
    `<a href="${href}"${active === key ? ' aria-current="page"' : ""}>${label}</a>`;
  const hamburger = `<button type="button" class="gvnav-toggle" data-nav-toggle aria-expanded="false" aria-controls="gvnav-menu" aria-label="Open menu"><span class="gvnav-toggle__bars" aria-hidden="true"><span></span><span></span><span></span></span></button>`;
  return `<header class="gvhead"><a class="gvhead__brand" href="/" aria-label="Product Prototypes — back to Prototypes"><span class="gvhead__mark" aria-hidden="true">P</span><span class="gvhead__title">Product Prototypes</span></a><div class="gvhead__actions">${hamburger}<nav class="gvnav" id="gvnav-menu" aria-label="Sections">${tab("/", "Prototypes", "prototypes")}${tab("/primitives/", "Primitives", "primitives")}${tab("/components/", "Components", "components")}${tab("/pages/", "Pages", "pages")}</nav></div></header>`;
}

/** Shared chrome script: real-time in-page filter + the mobile nav dropdown. */
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

  // ── Mobile nav dropdown (hamburger) ──────────────────────────────────────
  var navToggle = document.querySelector('[data-nav-toggle]');
  var nav = document.getElementById('gvnav-menu');
  if(navToggle && nav){
    function closeNav(){ navToggle.setAttribute('aria-expanded','false'); nav.classList.remove('is-open'); }
    function openNav(){ navToggle.setAttribute('aria-expanded','true'); nav.classList.add('is-open'); }
    navToggle.addEventListener('click', function(e){
      e.stopPropagation();
      nav.classList.contains('is-open') ? closeNav() : openNav();
    });
    nav.addEventListener('click', function(e){ if(e.target.closest('a')) closeNav(); });
    document.addEventListener('click', function(e){
      if(nav.classList.contains('is-open') && !nav.contains(e.target) && !navToggle.contains(e.target)) closeNav();
    });
    document.addEventListener('keydown', function(e){ if((e.key||'').toLowerCase() === 'escape') closeNav(); });
    window.addEventListener('resize', function(){ if(window.innerWidth > 720) closeNav(); });
  }
})();`;
}

/** Inject the nav (with its own styles) right after the opening <body> tag. */
function injectNav(html, active) {
  const m = html.match(/<body[^>]*>/i);
  if (!m) return html;
  return html.replace(
    m[0],
    `${m[0]}\n  <style>${NAV_CSS}</style>\n  ${navBar(active)}\n  <script>${chromeScript()}</script>`
  );
}

// "Shell skin" for the Primitives gallery so it matches the light shell: the page
// canvas takes the shell's near-white bg + faint indigo wash, and the gallery's white
// .gv-card sections get a crisp hairline + soft shadow. The gallery owns its own
// (side-nav) layout; the skin only harmonises colours and reserves the top-bar height.
// Injected last so it wins over the gallery's own body rule (equal specificity).
const PRIMITIVES_SKIN = `
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
    body.gv-root {
      background: #fbfbfd !important;
      padding-top: 76px !important;
    }
    body.gv-root::before {
      content: ""; position: fixed; inset: 0; z-index: 0; pointer-events: none;
      background:
        radial-gradient(940px 440px at 14% -12%, rgba(94,106,210,0.10), transparent 60%),
        radial-gradient(700px 420px at 98% -6%, rgba(140,99,210,0.07), transparent 55%);
    }
    body.gv-root > .gv-gallery { position: relative; z-index: 1; }
    body.gv-root .gv-sidenav { top: 72px; }
    body.gv-root .gv-card {
      border: 1px solid rgba(16,17,26,0.07);
      box-shadow: 0 12px 30px -18px rgba(16,24,40,0.22);
    }`;

/** Inject the nav + the Primitives skin (light, matches the shell) into the gallery. */
function injectPrimitives(html) {
  const withNav = injectNav(html, "primitives");
  return withNav.replace(/<\/head>/i, `  <style>${PRIMITIVES_SKIN}</style>\n</head>`);
}

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
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" />
  <style>${PAGE_CSS}${NAV_CSS}
  </style>
</head>
<body>
  ${navBar(activeTab)}
  <div class="wrap${wrapClass ? " " + wrapClass : ""}">
    ${backLink}
    ${body}
    <footer>Product Prototypes &middot; v${UI_VERSION} &middot; ${fmtDate(Date.now())}</footer>
  </div>
  <script>${CAROUSEL_JS}
  </script>
  <script>${chromeScript()}
  </script>
</body>
</html>
`;
}

/** A live, scaled-down, non-interactive preview of a page (iframe). */
function preview(src) {
  return `<div class="preview"><iframe src="${src}" title="" aria-hidden="true" tabindex="-1" scrolling="no" loading="lazy" sandbox="allow-scripts allow-same-origin"></iframe></div>`;
}

function renderRootIndex(opportunities) {
  if (!opportunities.length) {
    return shell({
      title: "Product Prototypes",
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
          ${preview(coverSrc)}
          <div class="opp-meta">
            <div class="proto-name">${titleCase(opp.name)}</div>
            <div class="proto-date">${plural(opp.prototypes.length, "prototype")} &middot; ${fmtDate(opp.mtimeMs)}</div>
          </div>
        </div>`;
    })
    .join("");

  // Sidebar nav rail: Playground locked on top, then a jump link per opportunity.
  const sideLinks = opportunities
    .map((opp) => `<a href="${encodeURIComponent(opp.name)}/">${titleCase(opp.name)}</a>`)
    .join("");

  const sidebar = `
    <aside class="root-side">
      <a class="side-pin" href="playground/">
        <span class="side-pin__icon" aria-hidden="true">🛝</span>
        <span>Playground</span>
      </a>
      <div class="side-divider"></div>
      <p class="side-label">Opportunities</p>
      <nav class="side-nav" aria-label="Opportunities">${sideLinks}</nav>
    </aside>`;

  const main = `
    <div class="root-main">
      ${filterField("Search opportunities…")}
      <div data-fgroup>
        <p class="section-eyebrow">${plural(opportunities.length, "opportunity").replace("opportunitys", "opportunities")}</p>
        <div class="opp-grid">${cards}</div>
      </div>
      ${filterEmpty()}
    </div>`;

  return shell({
    title: "Product Prototypes",
    wrapClass: "wrap--root",
    body: sidebar + main,
  });
}

function renderOpportunityIndex(opp) {
  const cards = opp.prototypes
    .map((p) => {
      const download = p.file
        ? `<button type="button" class="btn-icon" data-dl="${p.file}" data-dlname="${encodeURIComponent(p.name)}.html" aria-label="Download HTML" title="Download HTML">&darr;</button>`
        : "";
      return `
        <div class="card-proto" data-fitem data-fkey="${titleCase(p.name)}">
          <div class="preview">
            <iframe src="${p.href}" title="" aria-hidden="true" tabindex="-1" scrolling="no" loading="lazy" sandbox="allow-scripts allow-same-origin"></iframe>
            <a class="preview-link" href="${p.href}" aria-label="Open ${titleCase(p.name)}"></a>
            <div class="preview-actions">
              ${download}
            </div>
          </div>
          <div class="proto-meta">
            <div class="proto-text">
              <div class="proto-name">${titleCase(p.name)}</div>
              <div class="proto-date">${fmtDate(p.mtimeMs)}</div>
            </div>
          </div>
        </div>`;
    })
    .join("");

  return shell({
    title: titleCase(opp.name),
    body: `<p class="section-eyebrow">${titleCase(opp.name)} &middot; ${plural(opp.prototypes.length, "prototype")}</p>${filterField("Search prototypes…")}<div data-fgroup><div class="page-grid">${cards}</div></div>${filterEmpty()}`,
    back: { href: "../", label: "&larr; All opportunities" },
  });
}

function renderPlaygroundIndex(projects) {
  if (!projects.length) {
    return shell({
      title: "Playground",
      body: `<p class="section-eyebrow">Playground 🛝</p>
        <p class="empty">No projects yet. Add one under
        <code>playground/&lt;project&gt;/</code> and rebuild.</p>`,
      back: { href: "/", label: "&larr; All prototypes" },
    });
  }

  // Folder cards — each project is a self-contained subfolder, same look as the
  // opportunity cards on the root so Playground reads as a sibling folder browser.
  const cards = projects
    .map((p) => {
      const folder = `${encodeURIComponent(p.name)}/`;
      return `
        <div class="card-opp" data-fitem data-fkey="${titleCase(p.name)}">
          <a class="card-cover-link" href="${folder}" aria-label="Open ${titleCase(p.name)}"></a>
          ${preview(p.href)}
          <div class="opp-meta">
            <div class="proto-name">${titleCase(p.name)}</div>
            <div class="proto-date">${fmtDate(p.mtimeMs)}</div>
          </div>
        </div>`;
    })
    .join("");

  return shell({
    title: "Playground",
    body: `<p class="section-eyebrow">Playground 🛝 &middot; ${plural(projects.length, "project")}</p>${filterField("Search projects…")}<div data-fgroup><div class="opp-grid">${cards}</div></div>${filterEmpty()}`,
    back: { href: "/", label: "&larr; All prototypes" },
  });
}

function renderPagesIndex(pages) {
  if (!pages.length) {
    return shell({
      title: "Pages",
      subtitle: "Composed GoVocal reference pages &mdash; copy one as a starting point.",
      activeTab: "pages",
      body: `<p class="empty">No reference pages yet. Add one under
        <code>pages/&lt;name&gt;/</code> and rebuild.</p>`,
    });
  }

  // Pages are a designer reference — Open only, no HTML download.
  const pageCard = (p) => `
        <div class="card-proto" data-fitem data-fkey="${titleCase(p.name)}">
          <div class="preview">
            <iframe src="${p.href}" title="" aria-hidden="true" tabindex="-1" scrolling="no" loading="lazy" sandbox="allow-scripts allow-same-origin"></iframe>
            <a class="preview-link" href="${p.href}" aria-label="Open ${titleCase(p.name)}"></a>
          </div>
          <div class="proto-meta">
            <div class="proto-name">${titleCase(p.name)}</div>
          </div>
        </div>`;

  // Split by surface into three collapsible groups: Front office (city-themed
  // shells), Methods (participation-method runners), Back office (GoVocal's theme).
  const front = pages.filter((p) => p.surface === "front-office");
  const methods = pages.filter((p) => p.surface === "method");
  const back = pages.filter((p) => p.surface === "back-office");
  // A collapsible section: <details> with the eyebrow as its <summary>. Filtering
  // (chromeScript) force-opens sections with matches, so search still reaches
  // collapsed cards.
  const group = (label, inner, count) => `
        <details class="fsection" data-fgroup open>
          <summary class="section-eyebrow"><span class="fsection__caret" aria-hidden="true"></span>${label}${count == null ? "" : ` &middot; ${count}`}</summary>
          <div class="page-grid">${inner}</div>
        </details>`;
  const built = [
    ["Front office", front],
    ["Methods", methods],
    ["Back office", back],
  ].filter(([, list]) => list.length);
  // Two or more surfaces present → grouped; otherwise a single ungrouped list.
  const cards =
    built.length > 1
      ? built.map(([label, list]) => group(label, list.map(pageCard).join(""), list.length)).join("")
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
    body: `${filterField("Search pages…")}${cards}${pendingSection}${filterEmpty()}`,
  });
}

function renderComponentsIndex(components) {
  const subtitle =
    "Reusable building blocks &mdash; primitives composed into navbar, footer, cards, hero. They assemble into Pages.";
  if (!components.length) {
    return shell({
      title: "Components",
      subtitle,
      activeTab: "components",
      body: `<p class="empty">No components yet. Add one under
        <code>components/&lt;name&gt;/</code> and rebuild.</p>`,
    });
  }

  const rows = components
    .map((c) => {
      const blurb = COMPONENT_BLURBS[c.name] || { classes: "", desc: "" };
      const classes = blurb.classes
        ? `<code>${blurb.classes}</code>`
        : "";
      // Components are a designer reference — Open only, no HTML download.
      // Filter key spans name + classes + description so a search matches any of them.
      const fkey = `${titleCase(c.name)} ${blurb.classes} ${blurb.desc}`.replace(/<[^>]+>/g, " ").replace(/"/g, "");
      return `
        <tr data-fitem data-fkey="${fkey}">
          <td>
            <a class="comp-thumb" href="${c.href}" aria-label="Open ${titleCase(c.name)}">
              <iframe src="${c.href}" title="" aria-hidden="true" tabindex="-1" scrolling="no" loading="lazy" sandbox="allow-scripts allow-same-origin"></iframe>
            </a>
          </td>
          <td><div class="comp-name">${titleCase(c.name)}${classes}</div></td>
          <td><div class="comp-desc">${blurb.desc}</div></td>
        </tr>`;
    })
    .join("");

  return shell({
    title: "Components",
    activeTab: "components",
    body: `<p class="section-eyebrow" style="margin-bottom:26px">Reusable building blocks</p>${filterField("Search components…")}<table class="comp-table">
      <thead><tr><th>Preview</th><th>Component</th><th>What it is</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>${filterEmpty()}`,
  });
}

async function main() {
  // Clean dist for a deterministic build.
  await fs.rm(DIST, { recursive: true, force: true });
  await fs.mkdir(DIST, { recursive: true });

  // Scan all three sources (each also copies its folders into dist).
  const opportunities = await scan();
  const components = await scanComponents();
  const pages = await scanPages();

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
    "govocal-avatars.js", "govocal-rail.js",
    "govocal-survey.css", "govocal-survey.js", "govocal-logo.svg",
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
  const SHARED_ASSET_DIRS = ["avatars", "img"];
  for (const d of SHARED_ASSET_DIRS) {
    if (await isDir(path.join(UI_SKILL, d))) {
      await copyDir(path.join(UI_SKILL, d), path.join(sharedDir, d));
    }
  }

  // ── Components tab → composed component library from components/<name>/.
  await fs.mkdir(path.join(DIST, "components"), { recursive: true });
  await fs.writeFile(
    path.join(DIST, "components", "index.html"),
    renderComponentsIndex(components),
    "utf8"
  );

  // ── Pages tab → composed reference pages from pages/<name>/.
  await fs.mkdir(path.join(DIST, "pages"), { recursive: true });
  await fs.writeFile(
    path.join(DIST, "pages", "index.html"),
    renderPagesIndex(pages),
    "utf8"
  );

  // ── Playground → a folder that acts like an opportunity but stays pinned in the
  // root sidebar. Copy the whole tree verbatim (shared assets + project subfolders),
  // then overwrite its index.html with a generated folder browser of the subfolders.
  let playground = [];
  if (await isDir(path.join(ROOT, "playground"))) {
    await copyDir(path.join(ROOT, "playground"), path.join(DIST, "playground"), isInternalOnly);
    playground = await scanPlayground();
    await fs.writeFile(
      path.join(DIST, "playground", "index.html"),
      renderPlaygroundIndex(playground),
      "utf8"
    );
  }
  const hasPlayground = playground.length >= 0 && (await isDir(path.join(DIST, "playground")));

  // Edge auth gate. Inject the list of PUBLIC prototype path-prefixes so the
  // password gate covers only the internal site — published prototypes stay open.
  // (Derived from what actually shipped above, so the gate can never drift.)
  const publicPrefixes = opportunities.flatMap((opp) =>
    opp.prototypes.map(
      (p) => `/${encodeURIComponent(opp.name)}/${encodeURIComponent(p.name)}/`
    )
  );
  const workerSrc = await fs.readFile(SRC_WORKER, "utf8");
  const gatedWorker = workerSrc.replace(
    "const PUBLIC_PREFIXES = [];",
    `const PUBLIC_PREFIXES = ${JSON.stringify(publicPrefixes)};`
  );
  if (gatedWorker === workerSrc) {
    throw new Error("build: PUBLIC_PREFIXES placeholder not found in src/_worker.js");
  }
  await fs.writeFile(path.join(DIST, "_worker.js"), gatedWorker, "utf8");

  // Review overlay asset (shared by every injected prototype).
  await fs.mkdir(path.join(DIST, "__review"), { recursive: true });
  await fs.copyFile(SRC_REVIEW, path.join(DIST, "__review", "comments.js"));

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
  console.log(`  primitives/  (Primitives gallery)`);
  console.log(`  pages/  — ${plural(pages.length, "reference page")}`);
  for (const p of pages) console.log(`    - ${p.name}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
