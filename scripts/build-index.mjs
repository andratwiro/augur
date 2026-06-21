#!/usr/bin/env node
/**
 * build-index.mjs — regenerates LIBRARY.md, the internal "reuse-first" recall index.
 *
 * Scans the whole repo's reusable surface — Primitives, Components, Pages, and the
 * existing Prototypes — and writes a single always-current index at the repo root.
 * It is the agent-facing twin of the ⌘K search baked into build.js: same idea
 * (one scan of what exists), two audiences — humans search the live site, agents
 * read LIBRARY.md before building so they REUSE instead of rebuilding GoVocal twice.
 *
 * Auto-updating: it derives everything from the filesystem (folder = item) and each
 * demo's own self-description (<p class="sub"> / <title>), so it never drifts as long
 * as you run `npm run index` after adding/removing an item.
 *
 * Internal-only: LIBRARY.md lives at the repo root (outside any prototypes/ folder),
 * so build.js never copies it into /dist. Plain Node, no dependencies.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, "LIBRARY.md");

// Top-level folders that are not opportunity folders (mirrors build.js).
const NON_OPP = new Set([
  "dist", "node_modules", "skills", "src", "pages", "components",
  "base", "patterns",
  "playground", "scripts", ".git", ".github",
]);

// ── small helpers ───────────────────────────────────────────────────────────
const ENT = {
  "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&#39;": "'",
  "&rsquo;": "’", "&lsquo;": "‘", "&ldquo;": "“", "&rdquo;": "”",
  "&mdash;": "—", "&ndash;": "–", "&middot;": "·", "&hellip;": "…",
  "&nbsp;": " ",
};
const decode = (s) => s.replace(/&[a-z#0-9]+;/gi, (m) => ENT[m] || m);

async function isDir(p) {
  try { return (await fs.stat(p)).isDirectory(); } catch { return false; }
}
async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

const titleCase = (slug) =>
  slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** First match of `re` (capture group 1) in `html`, stripped to clean text. */
function textFrom(html, re) {
  const m = html.match(re);
  if (!m) return "";
  return decode(m[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** A short, table-safe one-liner describing a demo, pulled from the file itself. */
function describe(html, { max = 160 } = {}) {
  const sub = textFrom(html, /<p[^>]*class="[^"]*\bsub\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
  const title = textFrom(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  let d = sub || title || "";
  if (d.length > max) d = d.slice(0, max - 1).trimEnd() + "…";
  return d.replace(/\|/g, "\\|"); // never break the markdown table
}

/** Resolve a folder's entry HTML (index.html, else first .html). Returns "" if none. */
async function entryHtml(dir) {
  let file = path.join(dir, "index.html");
  if (!(await exists(file))) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const html = entries.find((e) => e.isFile() && e.name.endsWith(".html"));
    if (!html) return "";
    file = path.join(dir, html.name);
  }
  try { return await fs.readFile(file, "utf8"); } catch { return ""; }
}

/** Scan a folder of self-contained demo subfolders (components/ or pages/). */
async function scanFolder(srcRel) {
  const src = path.join(ROOT, srcRel);
  if (!(await isDir(src))) return [];
  const out = [];
  for (const e of await fs.readdir(src, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = path.join(src, e.name);
    out.push({ name: titleCase(e.name), slug: e.name, desc: describe(await entryHtml(dir)) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Scan every <opportunity>/prototypes/<name>/ across the repo. */
async function scanPrototypes() {
  const out = [];
  for (const top of await fs.readdir(ROOT, { withFileTypes: true })) {
    if (!top.isDirectory() || NON_OPP.has(top.name) || top.name.startsWith(".")) continue;
    const protoParent = path.join(ROOT, top.name, "prototypes");
    if (!(await isDir(protoParent))) continue;
    for (const proto of await fs.readdir(protoParent, { withFileTypes: true })) {
      if (!proto.isDirectory()) continue;
      out.push({
        name: titleCase(proto.name),
        opp: titleCase(top.name),
        oppSlug: top.name,
        slug: proto.name,
        desc: describe(await entryHtml(path.join(protoParent, proto.name))),
      });
    }
  }
  out.sort((a, b) => a.opp.localeCompare(b.opp) || a.name.localeCompare(b.name));
  return out;
}

/** Primitive names, parsed from the catalog headings before the "Composed" divider. */
async function scanPrimitives() {
  try {
    const md = await fs.readFile(path.join(ROOT, "skills/govocal-ui/components.md"), "utf8");
    const head = md.split(/^#\s+Composed components/m)[0];
    return [...head.matchAll(/^##\s+(.+)$/gm)]
      .map((m) => m[1].split(/\s+—\s+|\s+-\s+/)[0].replace(/`/g, "").trim())
      .filter((n) => n && n.toLowerCase() !== "setup");
  } catch { return []; }
}

// ── render ──────────────────────────────────────────────────────────────────
function table(headers, rows) {
  const head = `| ${headers.join(" | ")} |\n|${headers.map(() => "---").join("|")}|`;
  return [head, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

function main() {
  return (async () => {
    const [primitives, base, components, patterns, pages, prototypes] = await Promise.all([
      scanPrimitives(), scanFolder("base"), scanFolder("components"), scanFolder("patterns"), scanFolder("pages"), scanPrototypes(),
    ]);

    const baseRows = base.map((c) =>
      [`**${c.name}**`, `\`/base/${c.slug}/\``, `\`base/${c.slug}/\``, c.desc || "_(atom demo)_"]);
    const compRows = components.map((c) =>
      [`**${c.name}**`, `\`/components/${c.slug}/\``, `\`components/${c.slug}/\``, c.desc || "_(add a `.sub` line to its demo)_"]);
    const patternRows = patterns.map((c) =>
      [`**${c.name}**`, `\`/patterns/${c.slug}/\``, `\`patterns/${c.slug}/\``, c.desc || "_(composition demo)_"]);
    const pageRows = pages.map((p) =>
      [`**${p.name}**`, `\`/pages/${p.slug}/\``, `\`pages/${p.slug}/\``, p.desc || "_(no description)_"]);
    const protoRows = prototypes.map((p) =>
      [`**${p.name}**`, p.opp, `\`${p.oppSlug}/prototypes/${p.slug}/\``, p.desc || "_(no description)_"]);

    const md = `# GoVocal Prototype Library — recall index (generated)

> **Generated by \`npm run index\` (\`scripts/build-index.mjs\`). DO NOT EDIT BY HAND** —
> your changes will be overwritten. Internal-only: lives at the repo root, never ships.
> Regenerate after adding/removing a primitive, component, page, or prototype.

> **Augur instances (lean lookup):** every base + component is a live \`window.GV\`
> instance. For the slim name → props → renderer map, read
> \`skills/govocal-ui/INSTANCES.md\` (≈7 KB, 58 components) and load only the one
> renderer you need — don't ingest the 6k-line registry or the 100 KB \`components.md\`.
> Call \`GV.render('<name>', props)\` / \`GV.mount(el, '<name>', props)\`.

## Reuse-first (read me before building a prototype)

Before building **anything** in a prototype, scan this index and **reuse an existing
layer** — Tokens → Base → Components → Patterns → Pages — instead of rebuilding it. Workflow:

1. **Find it here first.** Need a footer, a card, a nav, a login modal, a whole
   page? Check the tables below — if it exists, start from it.
2. **Copy it in.** Prototypes are self-contained: copy the asset/snippet into the
   prototype folder (assets: \`govocal-tokens.css\`, \`govocal-primitives.css\`,
   \`govocal-ui.css\` (which \`@import\`s primitives), \`govocal-themes.js\`, +
   \`govocal-logo.svg\`/\`govocal-cookies.js\` as needed).
   Markup/snippets live in \`skills/govocal-ui/components.md\`; details for each
   component in \`components/manifest.md\`.
3. **Then adapt it freely.** A prototype is allowed to fork, restyle, version, and
   **break** a copied component — that's what prototypes are for. The only rule:
   **don't edit the canonical source** (\`skills/govocal-ui/govocal-ui.css\` and the
   \`components/<name>/\` demos) from inside a prototype. Library = shared truth;
   your prototype-local copy = yours to mangle.
4. **Only build new** when nothing here fits — then consider promoting it into the
   library (a component/page) so the next prototype can reuse it, and \`npm run index\`.

Humans get the same index as the **⌘K search** on the review site (Prototypes ·
Components · Pages); this file is the agent-readable twin.

---

> **Layered design system:** Tokens → Base → Components → Patterns → Pages. The
> review site has a tab per layer (\`/tokens/\` · \`/base/\` · \`/components/\` ·
> \`/patterns/\` · \`/pages/\`). Each layer imports live from the one below — proven by
> the composition graph the review overlay recurses (\`dist/__review/graph.js\`,
> derived from the canonical CSS).

## Tokens — \`skills/govocal-ui/govocal-tokens.css\`

The design-system variables (\`--gv-*\`): palette, type scale, radius, shadows, focus,
tenant colours. Generated **Tokens** tab (\`/tokens/\`) shows each with its alias chain
to a raw value + its consumers.

## Base (atoms) — \`base/<name>/\`

The source-grounded \`.gv-*\` atoms (button, input, card, badge, modal, icon, toggle,
checkbox/radio, status-label, divider, avatar, typography). Shipped on the **Base**
tab. Full live gallery: \`skills/govocal-ui/gallery.html\` (\`/primitives/\`, legacy).
**Snippets:** \`skills/govocal-ui/components.md\`. Parsed primitive families:

${primitives.length ? primitives.map((p) => `- ${p}`).join("\n") : "_(none parsed)_"}

${base.length ? table(["Atom", "Open", "Source", "What it is"], baseRows) : ""}

## Components (blocks) — \`components/<name>/\`

Section-level blocks assembled from base atoms. Shipped on the **Components** tab.
Class-level detail + “how to reuse”: \`components/manifest.md\`.

${components.length ? table(["Component", "Open", "Source", "What it is"], compRows) : "_(none yet)_"}

## Patterns (compositions) — \`patterns/<name>/\`

Curated recurring compositions — several components arranged the way real screens
repeatedly arrange them. Shipped on the **Patterns** tab.

${patterns.length ? table(["Pattern", "Open", "Source", "What it is"], patternRows) : "_(none yet)_"}

## Pages (screens) — \`pages/<name>/\`

Whole reference screens built from components. Shipped on the **Pages** tab. Copy one
as a starting point for a prototype.

${pages.length ? table(["Page", "Open", "Source", "What it is"], pageRows) : "_(none yet)_"}

## Prototypes (existing — for reference & patterns) — \`<opportunity>/prototypes/<name>/\`

Not part of the shared library, but listed so you can see what's already been built
and reuse patterns. Prototypes are free to diverge from the library.

${prototypes.length ? table(["Prototype", "Opportunity", "Source", "What it is"], protoRows) : "_(none yet)_"}
`;

    await fs.writeFile(OUT, md, "utf8");
    console.log(
      `Wrote LIBRARY.md — ${primitives.length} primitives, ${base.length} base, ${components.length} components, ` +
      `${patterns.length} patterns, ${pages.length} pages, ${prototypes.length} prototypes.`
    );
    // Also refresh the lean Augur instance index (skills/govocal-ui/INSTANCES.md) so it
    // stays in lockstep with the registry everywhere build-index runs (index/build/CI).
    await import("./build-instances-index.mjs");
  })();
}

main().catch((err) => { console.error(err); process.exit(1); });
