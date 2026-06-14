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

// Version of the PROTOTYPES SITE UI (the landing/shell pages this file generates),
// shown in the footer. Bump this ONLY when the site UI changes — i.e. edits to
// build.js shell/CSS, the index pages, or features like carousel/comments/download.
// Do NOT bump it for changes inside individual prototypes; their content is
// versioned by their own modified date, not this number.
const UI_VERSION = "0.02";

// Top-level folders that are never treated as opportunity folders.
const IGNORED_TOPLEVEL = new Set([
  "dist",
  "node_modules",
  "skills",
  "src",
  ".git",
  ".github",
]);

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
      await fs.copyFile(srcPath, destPath);
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
    :root {
      --bg: #fafafa; --fg: #1a1a1a; --muted: #6b7280;
      --line: #e5e7eb; --accent: #2563eb; --card: #ffffff;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0d0d0f; --fg: #f3f4f6; --muted: #9ca3af;
        --line: #26262b; --accent: #60a5fa; --card: #161619;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg); color: var(--fg); -webkit-font-smoothing: antialiased;
    }
    .wrap { max-width: 1040px; margin: 0 auto; padding: 56px 24px 96px; }
    .back {
      display: inline-block; margin-bottom: 28px; color: var(--muted);
      text-decoration: none; font-size: 14px;
    }
    .back:hover { color: var(--accent); }
    h1 { font-size: 28px; font-weight: 650; margin: 0 0 6px; letter-spacing: -0.02em; }
    .subtitle { color: var(--muted); margin: 0 0 28px; font-size: 15px; }
    .empty { color: var(--muted); }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
    footer { margin-top: 56px; color: var(--muted); font-size: 13px; }

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
      width: 46px; height: 46px; border-radius: 50%; border: 1px solid var(--line);
      background: var(--card); color: var(--fg); font-size: 22px; line-height: 1;
      cursor: pointer; box-shadow: 0 2px 12px rgba(0,0,0,0.14);
      transition: opacity .15s ease, filter .15s ease; display: grid; place-items: center;
    }
    .cbtn:hover { filter: brightness(1.06); }
    .cbtn[disabled] { opacity: 0; pointer-events: none; }
    .cbtn.prev { left: 4px; } .cbtn.next { right: 4px; }
    .dots { display: flex; gap: 8px; justify-content: center; margin-top: 6px; }
    .dot {
      width: 8px; height: 8px; padding: 0; border: 0; border-radius: 50%;
      background: var(--line); cursor: pointer; transition: background .15s, transform .15s;
    }
    .dot.on { background: var(--accent); transform: scale(1.35); }

    /* ---- Cards & live previews ---- */
    .card-opp, .card-proto {
      display: block; background: var(--card); border: 1px solid var(--line);
      border-radius: 16px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.06);
      text-decoration: none; color: inherit;
    }
    .card-opp { transition: box-shadow .18s ease, transform .18s ease; }
    .card-opp:hover { box-shadow: 0 10px 34px rgba(0,0,0,0.13); transform: translateY(-3px); }
    .preview {
      position: relative; width: 100%; aspect-ratio: 16 / 10; overflow: hidden;
      background: var(--bg); border-bottom: 1px solid var(--line);
    }
    .preview iframe {
      position: absolute; top: 0; left: 0; width: 1280px; height: 800px; border: 0;
      transform-origin: top left; pointer-events: none;
    }
    .preview-link { position: absolute; inset: 0; z-index: 2; }
    .opp-meta, .proto-meta { padding: 18px 20px; }
    .proto-meta {
      display: flex; align-items: center; justify-content: space-between;
      gap: 14px; flex-wrap: wrap;
    }
    .proto-name { font-weight: 600; font-size: 18px; letter-spacing: -0.01em; }
    .proto-date { color: var(--muted); font-size: 13px; margin-top: 2px; }
    .proto-actions { display: flex; gap: 10px; flex-wrap: wrap; }
    .btn {
      font: inherit; font-size: 14px; font-weight: 500; border-radius: 10px;
      padding: 10px 16px; text-decoration: none; cursor: pointer;
      border: 1px solid var(--line); background: transparent; color: var(--fg);
      display: inline-flex; align-items: center; gap: 6px;
      transition: filter .12s ease, background .12s ease;
    }
    .btn.primary { background: var(--accent); color: #fff; border-color: transparent; }
    .btn.primary:hover { filter: brightness(1.08); }
    .btn.ghost:hover { background: var(--bg); }`;

const CAROUSEL_JS = `
    (function () {
      // Scale each live preview iframe so the whole page fits the card.
      function fit(p) {
        var f = p.querySelector('iframe');
        if (f) f.style.transform = 'scale(' + (p.clientWidth / 1280) + ')';
      }
      var previews = [].slice.call(document.querySelectorAll('.preview'));
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

function shell({ title, subtitle, body, back }) {
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
  <style>${PAGE_CSS}
  </style>
</head>
<body>
  <div class="wrap">
    ${backLink}
    <h1>${title}</h1>
    <p class="subtitle">${subtitle}</p>
    ${body}
    <footer>GoVocal Prototypes &middot; v${UI_VERSION} &middot; ${fmtDate(Date.now())}</footer>
  </div>
  <script>${CAROUSEL_JS}
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

  return shell({
    title: "GoVocal Prototypes",
    subtitle: "Browse opportunities &mdash; private, do not share outside the team.",
    body: carousel(slides),
  });
}

function renderOpportunityIndex(opp) {
  const slides = opp.prototypes
    .map((p) => {
      const download = p.file
        ? `<a class="btn ghost" href="${p.file}" download="${encodeURIComponent(p.name)}.html">&darr; Download HTML</a>`
        : "";
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

  // Edge auth gate.
  await fs.copyFile(SRC_WORKER, path.join(DIST, "_worker.js"));

  const protoCount = opportunities.reduce((n, o) => n + o.prototypes.length, 0);
  console.log(
    `Built dist/ — ${plural(opportunities.length, "opportunity").replace("opportunitys", "opportunities")}, ${plural(protoCount, "prototype")}.`
  );
  for (const opp of opportunities) {
    console.log(`  ${opp.name}/`);
    for (const p of opp.prototypes) console.log(`    - ${p.name}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
