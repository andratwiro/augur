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

/** Href for a prototype, RELATIVE to its opportunity page. Prefer index.html. */
async function entryHref(prototype, protoDir) {
  const base = `${encodeURIComponent(prototype)}/`;
  if (await exists(path.join(protoDir, "index.html"))) return base;
  const entries = await fs.readdir(protoDir, { withFileTypes: true });
  const html = entries.find((e) => e.isFile() && e.name.endsWith(".html"));
  if (html) return `${base}${encodeURIComponent(html.name)}`;
  return base;
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

      prototypes.push({
        name: proto.name,
        href: await entryHref(proto.name, protoDir),
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
    .wrap { max-width: 720px; margin: 0 auto; padding: 56px 24px 96px; }
    .back {
      display: inline-block; margin-bottom: 28px; color: var(--muted);
      text-decoration: none; font-size: 14px;
    }
    .back:hover { color: var(--accent); }
    h1 { font-size: 26px; font-weight: 650; margin: 0 0 6px; letter-spacing: -0.02em; }
    .subtitle { color: var(--muted); margin: 0 0 36px; font-size: 15px; }
    ul.rows { list-style: none; margin: 0; padding: 0; }
    .rows li a {
      display: flex; align-items: baseline; justify-content: space-between; gap: 16px;
      padding: 16px; margin: 0 -16px; border-radius: 10px;
      text-decoration: none; color: var(--fg);
      border-bottom: 1px solid var(--line); transition: background 0.12s ease;
    }
    .rows li:last-child a { border-bottom: 0; }
    .rows li a:hover { background: var(--card); box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
    .row-name { font-weight: 500; }
    .row-meta { color: var(--muted); font-size: 13px; white-space: nowrap; }
    .empty { color: var(--muted); }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
    footer { margin-top: 56px; color: var(--muted); font-size: 13px; }`;

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
    <footer>Generated by build.js &middot; ${fmtDate(Date.now())}</footer>
  </div>
</body>
</html>
`;
}

function renderRootIndex(opportunities) {
  const rows = opportunities
    .map(
      (opp) => `
      <li><a href="${encodeURIComponent(opp.name)}/">
        <span class="row-name">${titleCase(opp.name)}</span>
        <span class="row-meta">${plural(opp.prototypes.length, "prototype")} &middot; ${fmtDate(opp.mtimeMs)}</span>
      </a></li>`
    )
    .join("");

  const body = opportunities.length
    ? `<ul class="rows">${rows}\n    </ul>`
    : `<p class="empty">No prototypes yet. Add one under
       <code>&lt;opportunity&gt;/prototypes/&lt;name&gt;/</code> and rebuild.</p>`;

  return shell({
    title: "GoVocal Prototypes",
    subtitle: "Pick an opportunity. Private &mdash; do not share outside the team.",
    body,
  });
}

function renderOpportunityIndex(opp) {
  const rows = opp.prototypes
    .map(
      (p) => `
      <li><a href="${p.href}">
        <span class="row-name">${titleCase(p.name)}</span>
        <span class="row-meta">${fmtDate(p.mtimeMs)}</span>
      </a></li>`
    )
    .join("");

  return shell({
    title: titleCase(opp.name),
    subtitle: plural(opp.prototypes.length, "prototype"),
    body: `<ul class="rows">${rows}\n    </ul>`,
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
