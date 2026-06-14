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
const UI_VERSION = "0.05";

// Top-level folders that are never treated as opportunity folders.
const IGNORED_TOPLEVEL = new Set([
  "dist",
  "node_modules",
  "skills",
  "src",
  "pages", // composed reference pages — shipped via their own builder, not as an opportunity
  "components", // composed component library — shipped via its own builder, not as an opportunity
  "playground", // standalone scratch prototype — shipped to /playground/, not as an opportunity
  ".git",
  ".github",
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

/** Recursively copy a directory. Returns the latest mtime (ms) seen within it. */
async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  let latest = 0;
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      latest = Math.max(latest, await copyDir(srcPath, destPath));
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
        mtimeMs: latest,
      });
    }

    if (prototypes.length === 0) continue;

    prototypes.sort((a, b) => b.mtimeMs - a.mtimeMs);
    opportunities.push({
      name: top.name,
      prototypes,
      mtimeMs: Math.max(...prototypes.map((p) => p.mtimeMs)),
    });
  }

  // Most-recently-modified opportunity first.
  opportunities.sort((a, b) => b.mtimeMs - a.mtimeMs);
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
    pages.push({ name: e.name, href, file, mtimeMs: latest });
  }
  pages.sort((a, b) => b.mtimeMs - a.mtimeMs);
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
    components.push({ name: e.name, href, file, mtimeMs: latest });
  }
  components.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return components;
}

function titleCase(slug) {
  return slug.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
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
    /* Linear-style shell — deep near-black canvas, indigo accent, Inter type.
       This is the TOOLING UI, deliberately distinct from the GoVocal prototype brand. */
    :root {
      --bg: #08090a;          /* page canvas */
      --bg-2: #0e0f11;        /* subtle elevated zone */
      --card: #121315;        /* card surface */
      --card-hover: #17181b;
      --fg: #f7f8f8;          /* primary text */
      --muted: #9197a1;       /* secondary text */
      --faint: #6b7079;       /* tertiary */
      --line: rgba(255,255,255,0.08);
      --line-2: rgba(255,255,255,0.14);
      --accent: #939bf7;      /* indigo, lifted for AA on dark */
      --accent-solid: #5e6ad2;/* Linear indigo (fills) */
      --radius: 12px;
      --maxw: 1080px;
      color-scheme: dark;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 15px/1.55 "Inter", "Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg); color: var(--fg);
      -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
      letter-spacing: -0.011em;
    }
    /* Signature: a faint indigo aurora behind the hero, fixed so it doesn't scroll. */
    body::before {
      content: ""; position: fixed; inset: 0; z-index: 0; pointer-events: none;
      background:
        radial-gradient(920px 460px at 16% -10%, rgba(94,106,210,0.22), transparent 60%),
        radial-gradient(680px 420px at 96% -4%, rgba(140,99,210,0.13), transparent 55%);
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

    /* ---- Carousel ---- */
    .carousel { position: relative; margin: 0 -24px; }
    .carousel.single .cbtn, .carousel.single .dots { display: none; }
    .track {
      display: flex; gap: 24px; overflow-x: auto; scroll-snap-type: x mandatory;
      scroll-behavior: smooth; padding: 8px 24px 20px; scrollbar-width: none;
      -webkit-overflow-scrolling: touch;
    }
    .track::-webkit-scrollbar { display: none; }
    .slide { flex: 0 0 86%; scroll-snap-align: center; }
    @media (min-width: 760px) { .slide { flex: 0 0 76%; } }
    .cbtn {
      position: absolute; top: calc(50% - 28px); transform: translateY(-50%); z-index: 5;
      width: 38px; height: 38px; border-radius: 50%; border: 1px solid var(--line-2);
      background: rgba(18,19,21,0.82); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
      color: var(--fg); font-size: 18px; line-height: 1;
      cursor: pointer; box-shadow: 0 4px 18px rgba(0,0,0,0.4);
      transition: opacity .15s ease, background .15s ease, border-color .15s ease; display: grid; place-items: center;
    }
    .cbtn:hover { background: var(--card-hover); border-color: var(--accent); }
    .cbtn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .cbtn[disabled] { opacity: 0; pointer-events: none; }
    .cbtn.prev { left: 6px; } .cbtn.next { right: 6px; }
    .dots { display: flex; gap: 7px; justify-content: center; margin-top: 16px; }
    .dot {
      width: 6px; height: 6px; padding: 0; border: 0; border-radius: 50%;
      background: var(--line-2); cursor: pointer; transition: background .15s, width .15s;
    }
    .dot.on { background: var(--accent); width: 18px; border-radius: 3px; }

    /* ---- Cards & live previews ---- */
    .card-opp, .card-proto {
      display: block; background: var(--card); border: 1px solid var(--line);
      border-radius: var(--radius); overflow: hidden;
      text-decoration: none; color: inherit;
    }
    .card-opp { transition: box-shadow .2s ease, transform .2s ease, border-color .2s ease; }
    .card-opp:hover {
      border-color: var(--line-2);
      box-shadow: 0 16px 40px -12px rgba(0,0,0,0.6), 0 0 0 1px rgba(94,106,210,0.18);
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
    .opp-meta, .proto-meta { padding: 16px 18px; }
    .proto-meta {
      display: flex; align-items: center; justify-content: space-between;
      gap: 14px; flex-wrap: wrap;
    }
    .proto-name { font-weight: 600; font-size: 16px; letter-spacing: -0.015em; }
    .proto-date { color: var(--muted); font-size: 12.5px; margin-top: 3px; }
    .proto-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .btn {
      font: inherit; font-size: 13px; font-weight: 500; border-radius: 8px;
      padding: 8px 13px; text-decoration: none; cursor: pointer;
      border: 1px solid var(--line-2); background: transparent; color: var(--fg);
      display: inline-flex; align-items: center; gap: 6px;
      transition: background .12s ease, border-color .12s ease;
    }
    .btn:hover { background: var(--card-hover); border-color: var(--accent); }
    .btn.primary { background: var(--accent-solid); color: #fff; border-color: transparent; }
    .btn.primary:hover { background: #6b76e0; border-color: transparent; }
    .btn.ghost:hover { background: var(--bg-2); }

    /* ---- Pages grid (fast vertical scan, ~4 columns) ---- */
    .page-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 22px 20px; }
    .page-grid .card-proto { transition: box-shadow .18s ease, transform .18s ease; }
    .page-grid .card-proto:hover { box-shadow: 0 10px 30px rgba(0,0,0,0.13); transform: translateY(-3px); }
    .page-grid .proto-meta { padding: 12px 14px; }
    .page-grid .proto-name { font-size: 15px; }
    .page-grid .proto-actions { margin-top: 10px; gap: 8px; }
    .page-grid .btn { padding: 7px 12px; font-size: 13px; border-radius: 8px; }

    /* ---- Components table (small preview per row) ---- */
    .comp-table { width: 100%; border-collapse: collapse; }
    .comp-table th { text-align: left; font-size: 12px; text-transform: uppercase; letter-spacing: .05em;
      color: var(--muted); font-weight: 600; padding: 0 14px 10px; border-bottom: 1px solid var(--line); }
    .comp-table td { padding: 16px 14px; border-bottom: 1px solid var(--line); vertical-align: middle; }
    .comp-table tr:hover td { background: color-mix(in srgb, var(--accent) 4%, transparent); }
    .comp-thumb {
      position: relative; width: 200px; max-width: 38vw; aspect-ratio: 16 / 9; overflow: hidden;
      border-radius: 10px; border: 1px solid var(--line); background: var(--bg); display: block;
    }
    .comp-thumb iframe {
      position: absolute; top: 0; left: 0; width: 1280px; height: 720px; border: 0;
      transform-origin: top left; pointer-events: none;
    }
    .comp-name { font-weight: 600; font-size: 16px; letter-spacing: -0.01em; }
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

    /* ---- Prototype status badge (In progress / Closed), toggled in place ---- */
    .status-badge {
      display: inline-flex; align-items: center; gap: 7px; margin-top: 10px;
      font: inherit; font-size: 12.5px; font-weight: 600; line-height: 1;
      min-height: 30px; padding: 7px 13px; border-radius: 999px; cursor: pointer;
      border: 1px solid transparent; transition: filter .12s ease;
      -webkit-tap-highlight-color: transparent;
    }
    .status-badge .status-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
    .status-badge:hover { filter: brightness(0.97); }
    .status-badge:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .status-badge[disabled] { opacity: .55; cursor: progress; }
    /* Colour is never the only signal — the text label always states the status. */
    .status-badge.is-progress { background: #fef3c7; color: #8a5200; border-color: #fcd9a4; }
    .status-badge.is-progress .status-dot { background: #c2710c; }
    .status-badge.is-closed { background: #d1fae5; color: #05603a; border-color: #a7f3d0; }
    .status-badge.is-closed .status-dot { background: #059669; }
    @media (prefers-color-scheme: dark) {
      .status-badge.is-progress { background: rgba(194,113,12,.20); color: #fcd34d; border-color: rgba(194,113,12,.42); }
      .status-badge.is-closed { background: rgba(5,150,105,.22); color: #6ee7b7; border-color: rgba(5,150,105,.46); }
    }
    @media (prefers-reduced-motion: reduce) { .status-badge { transition: none; } }`;

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

      [].forEach.call(document.querySelectorAll('[data-carousel]'), function (c) {
        var track = c.querySelector('[data-track]');
        var prev = c.querySelector('[data-prev]');
        var next = c.querySelector('[data-next]');
        var dotsWrap = c.querySelector('[data-dots]');
        var slides = [].slice.call(track.children);
        function step() { return slides.length > 1 ? slides[1].offsetLeft - slides[0].offsetLeft : track.clientWidth; }
        function active() { return Math.round(track.scrollLeft / step()); }
        function goTo(i) { track.scrollTo({ left: i * step(), behavior: 'smooth' }); }

        var dots = [];
        if (slides.length > 1) {
          slides.forEach(function (s, i) {
            var d = document.createElement('button');
            d.className = 'dot';
            d.setAttribute('aria-label', 'Go to item ' + (i + 1));
            d.addEventListener('click', function () { goTo(i); });
            dotsWrap.appendChild(d); dots.push(d);
          });
        } else { c.classList.add('single'); }

        function update() {
          var a = active();
          dots.forEach(function (d, i) { d.classList.toggle('on', i === a); });
          if (prev) prev.disabled = a <= 0;
          if (next) next.disabled = a >= slides.length - 1;
        }
        if (prev) prev.addEventListener('click', function () { goTo(active() - 1); });
        if (next) next.addEventListener('click', function () { goTo(active() + 1); });
        track.addEventListener('scroll', function () { requestAnimationFrame(update); }, { passive: true });
        c.addEventListener('keydown', function (e) {
          if (e.key === 'ArrowLeft') { goTo(active() - 1); e.preventDefault(); }
          if (e.key === 'ArrowRight') { goTo(active() + 1); e.preventDefault(); }
        });
        update();
      });
    })();`;

// Prototype status badges (In progress / Closed). Each badge is a real toggle
// button; state is loaded from and persisted to the worker's KV-backed
// /__review/status endpoint (same gate as the comments overlay). On a static
// preview with no worker (local `serve`), the load/POST just no-op and the badge
// stays at its default — clicking optimistically flips, then reverts if unsaved.
const STATUS_JS = `
    (function () {
      var badges = [].slice.call(document.querySelectorAll('.status-badge'));
      if (!badges.length) return;
      var LABELS = { in_progress: 'In progress', closed: 'Closed' };
      function apply(b, s) {
        if (s !== 'closed') s = 'in_progress';
        b.dataset.status = s;
        b.classList.toggle('is-closed', s === 'closed');
        b.classList.toggle('is-progress', s !== 'closed');
        var l = b.querySelector('.status-label');
        if (l) l.textContent = LABELS[s];
        b.setAttribute('aria-label', 'Status: ' + LABELS[s] + '. Activate to change.');
      }
      fetch('/__review/status', { headers: { Accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (!d || !d.statuses) return;
          badges.forEach(function (b) {
            var s = d.statuses[b.getAttribute('data-status-for')];
            if (s) apply(b, s);
          });
        }).catch(function () {});
      badges.forEach(function (b) {
        b.addEventListener('click', function () {
          var cur = b.dataset.status === 'closed' ? 'closed' : 'in_progress';
          var next = cur === 'closed' ? 'in_progress' : 'closed';
          apply(b, next);
          b.disabled = true;
          fetch('/__review/status?path=' + encodeURIComponent(b.getAttribute('data-status-for')), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: next }),
          }).then(function (r) { if (!r.ok) apply(b, cur); })
            .catch(function () { apply(b, cur); })
            .then(function () { b.disabled = false; });
        });
      });
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
      background: rgba(8,9,10,0.72); -webkit-backdrop-filter: blur(14px) saturate(180%); backdrop-filter: blur(14px) saturate(180%);
      border-bottom: 1px solid rgba(255,255,255,0.08);
      font: 500 13.5px/1 "Inter", "Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    .gvhead__brand { display: inline-flex; align-items: center; gap: 9px; min-width: 0; }
    .gvhead__mark {
      width: 22px; height: 22px; flex: none; border-radius: 6px;
      background: linear-gradient(150deg, #828bf5, #5e6ad2 70%);
      box-shadow: 0 0 0 1px rgba(255,255,255,0.10) inset, 0 2px 8px rgba(94,106,210,0.5);
      display: grid; place-items: center; color: #fff; font-size: 12px; font-weight: 700; letter-spacing: -0.02em;
    }
    .gvhead__title { font-weight: 600; font-size: 13.5px; letter-spacing: -0.01em; color: #f7f8f8; white-space: nowrap; }
    .gvnav { display: flex; align-items: center; gap: 1px; }
    .gvnav a {
      display: inline-flex; align-items: center; height: 30px; padding: 0 12px;
      border-radius: 7px; text-decoration: none; color: #9197a1; white-space: nowrap; font-weight: 500;
      transition: background .12s ease, color .12s ease;
    }
    .gvnav a:hover { background: rgba(255,255,255,0.06); color: #f7f8f8; }
    .gvnav a[aria-current="page"] { background: rgba(255,255,255,0.09); color: #f7f8f8; }
    .gvnav a:focus-visible { outline: 2px solid #828bf5; outline-offset: 1px; }`;

function navBar(active) {
  const tab = (href, label, key) =>
    `<a href="${href}"${active === key ? ' aria-current="page"' : ""}>${label}</a>`;
  return `<header class="gvhead"><span class="gvhead__brand"><span class="gvhead__mark" aria-hidden="true">P</span><span class="gvhead__title">Product Team</span></span><nav class="gvnav" aria-label="Sections">${tab("/", "Prototypes", "prototypes")}${tab("/primitives/", "Primitives", "primitives")}${tab("/components/", "Components", "components")}${tab("/pages/", "Pages", "pages")}</nav></header>`;
}

/** Inject the nav (with its own styles) right after the opening <body> tag. */
function injectNav(html, active) {
  const m = html.match(/<body[^>]*>/i);
  if (!m) return html;
  return html.replace(m[0], `${m[0]}\n  <style>${NAV_CSS}</style>\n  ${navBar(active)}`);
}

function shell({ title, subtitle, body, back, activeTab = "prototypes" }) {
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
  <style>${PAGE_CSS}${NAV_CSS}
  </style>
</head>
<body>
  ${navBar(activeTab)}
  <div class="wrap">
    ${backLink}
    <h1>${title}</h1>
    ${subtitle ? `<p class="subtitle">${subtitle}</p>` : ""}
    ${body}
    <footer>GoVocal Prototypes &middot; v${UI_VERSION} &middot; ${fmtDate(Date.now())}</footer>
  </div>
  <script>${CAROUSEL_JS}
  </script>
  <script>${STATUS_JS}
  </script>
</body>
</html>
`;
}

/** A live, scaled-down, non-interactive preview of a page (iframe). */
function preview(src) {
  return `<div class="preview"><iframe src="${src}" title="" aria-hidden="true" tabindex="-1" scrolling="no" loading="lazy" sandbox="allow-scripts allow-same-origin"></iframe></div>`;
}

/** Wrap slide markup in the shared carousel chrome (arrows + dots). */
function carousel(slidesHtml) {
  return `<div class="carousel" data-carousel tabindex="0">
      <button class="cbtn prev" type="button" aria-label="Previous" data-prev>&lsaquo;</button>
      <div class="track" data-track>${slidesHtml}
      </div>
      <button class="cbtn next" type="button" aria-label="Next" data-next>&rsaquo;</button>
      <div class="dots" data-dots></div>
    </div>`;
}

function renderRootIndex(opportunities) {
  if (!opportunities.length) {
    return shell({
      title: "GoVocal Prototypes",
      subtitle: "Private &mdash; do not share outside the team.",
      body: `<p class="empty">No prototypes yet. Add one under
       <code>&lt;opportunity&gt;/prototypes/&lt;name&gt;/</code> and rebuild.</p>`,
    });
  }

  const slides = opportunities
    .map((opp) => {
      const oppPath = `${encodeURIComponent(opp.name)}/`;
      // Cover = most-recent prototype of the opportunity (already sorted first).
      const cover = opp.prototypes[0];
      const coverSrc = cover ? `${oppPath}${cover.href}` : "";
      return `
        <div class="slide">
          <a class="card-opp" href="${oppPath}">
            ${preview(coverSrc)}
            <div class="opp-meta">
              <div class="proto-name">${titleCase(opp.name)}</div>
              <div class="proto-date">${plural(opp.prototypes.length, "prototype")} &middot; ${fmtDate(opp.mtimeMs)}</div>
            </div>
          </a>
        </div>`;
    })
    .join("");

  // Standalone Playground entry — lives below the carousel, a quick scratch space.
  const playground = `
    <a class="playground" href="playground/">
      <span class="playground__icon" aria-hidden="true">🛝</span>
      <span class="playground__text">
        <span class="playground__name">Playground</span>
        <span class="playground__desc">A scratch space for quick experiments &mdash; jump in and build.</span>
      </span>
      <span class="playground__go" aria-hidden="true">&rsaquo;</span>
    </a>`;

  return shell({
    title: "GoVocal Prototypes",
    subtitle: "",
    body: carousel(slides) + playground,
  });
}

function renderOpportunityIndex(opp) {
  const slides = opp.prototypes
    .map((p) => {
      const download = p.file
        ? `<button type="button" class="btn ghost" data-dl="${p.file}" data-dlname="${encodeURIComponent(p.name)}.html">&darr; Download HTML</button>`
        : "";
      // KV identity = the absolute path the prototype is served at, matching the
      // comments overlay. Defaults to "In progress"; the STATUS_JS load corrects it.
      const protoPath = `/${encodeURIComponent(opp.name)}/${p.href}`;
      const status = `<button type="button" class="status-badge is-progress" data-status="in_progress" data-status-for="${protoPath}" aria-label="Status: In progress. Activate to change."><span class="status-dot" aria-hidden="true"></span><span class="status-label">In progress</span></button>`;
      return `
        <div class="slide">
          <div class="card-proto">
            <div class="preview">
              <iframe src="${p.href}" title="" aria-hidden="true" tabindex="-1" scrolling="no" loading="lazy" sandbox="allow-scripts allow-same-origin"></iframe>
              <a class="preview-link" href="${p.href}" aria-label="Open ${titleCase(p.name)}"></a>
            </div>
            <div class="proto-meta">
              <div>
                <div class="proto-name">${titleCase(p.name)}</div>
                <div class="proto-date">${fmtDate(p.mtimeMs)}</div>
                ${status}
              </div>
              <div class="proto-actions">
                <a class="btn primary" href="${p.href}">Open &rarr;</a>
                ${download}
              </div>
            </div>
          </div>
        </div>`;
    })
    .join("");

  return shell({
    title: titleCase(opp.name),
    subtitle: plural(opp.prototypes.length, "prototype"),
    body: carousel(slides),
    back: { href: "../", label: "&larr; All opportunities" },
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

  const cards = pages
    .map((p) => {
      const download = p.file
        ? `<button type="button" class="btn ghost" data-dl="${p.file}" data-dlname="${encodeURIComponent(p.name)}.html">&darr; HTML</button>`
        : "";
      return `
        <div class="card-proto">
          <div class="preview">
            <iframe src="${p.href}" title="" aria-hidden="true" tabindex="-1" scrolling="no" loading="lazy" sandbox="allow-scripts allow-same-origin"></iframe>
            <a class="preview-link" href="${p.href}" aria-label="Open ${titleCase(p.name)}"></a>
          </div>
          <div class="proto-meta">
            <div class="proto-name">${titleCase(p.name)}</div>
            <div class="proto-date">${fmtDate(p.mtimeMs)}</div>
            <div class="proto-actions">
              <a class="btn primary" href="${p.href}">Open &rarr;</a>
              ${download}
            </div>
          </div>
        </div>`;
    })
    .join("");

  return shell({
    title: "Pages",
    subtitle:
      "Whole composed pages &mdash; components assembled into real screens. Scan, then dive in to review.",
    activeTab: "pages",
    body: `<div class="page-grid">${cards}</div>`,
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
      const download = c.file
        ? `<button type="button" class="btn ghost" data-dl="${c.file}" data-dlname="${encodeURIComponent(c.name)}.html">&darr; HTML</button>`
        : "";
      return `
        <tr>
          <td>
            <a class="comp-thumb" href="${c.href}" aria-label="Open ${titleCase(c.name)}">
              <iframe src="${c.href}" title="" aria-hidden="true" tabindex="-1" scrolling="no" loading="lazy" sandbox="allow-scripts allow-same-origin"></iframe>
            </a>
          </td>
          <td><div class="comp-name">${titleCase(c.name)}${classes}</div></td>
          <td><div class="comp-desc">${blurb.desc}</div></td>
          <td class="comp-actions">
            <a class="btn primary" href="${c.href}">Open &rarr;</a>
            ${download}
          </td>
        </tr>`;
    })
    .join("");

  return shell({
    title: "Components",
    subtitle,
    activeTab: "components",
    body: `<table class="comp-table">
      <thead><tr><th>Preview</th><th>Component</th><th>What it is</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`,
  });
}

async function main() {
  // Clean dist for a deterministic build.
  await fs.rm(DIST, { recursive: true, force: true });
  await fs.mkdir(DIST, { recursive: true });

  const opportunities = await scan();

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
    injectNav(galleryHtml, "primitives"),
    "utf8"
  );
  const patternAssets = ["govocal-tokens.css", "govocal-ui.css", "govocal-themes.js", "govocal-cookies.js", "govocal-logo.svg"];
  for (const asset of patternAssets) {
    if (await exists(path.join(UI_SKILL, asset))) {
      await fs.copyFile(path.join(UI_SKILL, asset), path.join(patternsDir, asset));
    }
  }

  // ── Components tab → composed component library from components/<name>/.
  const components = await scanComponents();
  await fs.mkdir(path.join(DIST, "components"), { recursive: true });
  await fs.writeFile(
    path.join(DIST, "components", "index.html"),
    renderComponentsIndex(components),
    "utf8"
  );

  // ── Pages tab → composed reference pages from pages/<name>/.
  const pages = await scanPages();
  await fs.mkdir(path.join(DIST, "pages"), { recursive: true });
  await fs.writeFile(
    path.join(DIST, "pages", "index.html"),
    renderPagesIndex(pages),
    "utf8"
  );

  // ── Playground → standalone scratch prototype, copied to /playground/.
  let hasPlayground = false;
  if (await isDir(path.join(ROOT, "playground"))) {
    await copyDir(path.join(ROOT, "playground"), path.join(DIST, "playground"));
    hasPlayground = true;
  }

  // Edge auth gate.
  await fs.copyFile(SRC_WORKER, path.join(DIST, "_worker.js"));

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
  if (hasPlayground) console.log(`  playground/  (scratch prototype)`);
  console.log(`  primitives/  (Primitives gallery)`);
  console.log(`  pages/  — ${plural(pages.length, "reference page")}`);
  for (const p of pages) console.log(`    - ${p.name}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
