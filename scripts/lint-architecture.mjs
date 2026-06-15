#!/usr/bin/env node
// GoVocal architecture lint — enforces the hardwired layering of a normal UI system:
//
//   primitives (tokens + .gv-* in skills/govocal-ui/)
//        ▼  referenced live, never copied
//   components (components/<name>/ — assemble primitives, define NOTHING new)
//        ▼  referenced live, never copied
//   pages (pages/<name>/ — components "dragged in", layout + content only)
//
// One source of truth. Fix a primitive → every component and page changes with it,
// because nothing downstream holds a private copy or its own definition. This lint
// makes that structural: it FAILS the build if a library tier copies an asset,
// links a local asset instead of canonical, or redefines a .gv-* class.
//
// Prototypes are intentionally EXEMPT — they're the one tier allowed to copy, fork
// and break. This only governs the shared library (components/ and pages/).
//
// Usage:  npm run lint   (exit 1 on any hard violation; warnings don't fail)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TIERS = ['components', 'pages'];
const ASSET_FILE = /^govocal-.*\.(css|js|svg)$/;
const CANONICAL = '../../skills/govocal-ui/';

const violations = []; // hard — break the layering
const warnings = [];    // soft — page-authored styling that should live upstream

for (const tier of TIERS) {
  const base = path.join(ROOT, tier);
  if (!fs.existsSync(base)) continue;
  for (const name of fs.readdirSync(base)) {
    const dir = path.join(base, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const rel = `${tier}/${name}`;

    // INV-1: no per-folder asset copies — copying IS the drift.
    const copies = fs.readdirSync(dir).filter((f) => ASSET_FILE.test(f));
    if (copies.length) {
      violations.push(`[copy]      ${rel}/ holds ${copies.length} asset copy(ies) [${copies.join(', ')}] — delete them; reference ${CANONICAL}<asset> so it tracks canonical.`);
    }

    const idx = path.join(dir, 'index.html');
    if (!fs.existsSync(idx)) continue;
    const html = fs.readFileSync(idx, 'utf8');

    // INV-2: asset refs must point at canonical, not a local filename.
    for (const m of html.matchAll(/(?:href|src)=("|')(govocal-[\w.\-]+)\1/g)) {
      violations.push(`[local-ref] ${rel}/index.html links local "${m[2]}" — use ${CANONICAL}${m[2]}.`);
    }

    // INV-3: a demo must USE .gv-* classes, never DEFINE them. Definitions belong
    // in canonical govocal-ui.css / govocal-bo.css so every consumer inherits them.
    // Only flag a .gv-* that is the SUBJECT of a rule (selector starts with it);
    // `.stage .gv-foo {…}` is legit demo-scoping, not a redefinition.
    const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
    const defined = [...new Set([...styleBlocks.matchAll(/(?:^|[}{;])\s*(\.gv-[\w-]+)\s*(?:[,{:]|::)/gm)].map((m) => m[1]))];
    if (defined.length) {
      violations.push(`[reinvent]  ${rel}/index.html defines library classes in <style>: ${defined.slice(0, 8).join(', ')}${defined.length > 8 ? ` (+${defined.length - 8})` : ''} — promote to canonical, then only use them here.`);
    }

    // INV-4 (warn, PAGES only): a page should be pure assembly — layout + content.
    // Raw colour/elevation/type in a page won't sync from upstream. (Component demos
    // are exempt: their <style> is showcase chrome, not the component itself.)
    if (tier === 'pages') {
      const inlineStyles = [...html.matchAll(/\sstyle=("|')([^"']*)\1/g)].map((m) => m[2]).join(';');
      const hay = styleBlocks + ';' + inlineStyles;
      const hex = (hay.match(/#[0-9a-fA-F]{3,8}\b/g) || []).filter((h) => !/^#(fff|ffffff|000|000000)$/i.test(h));
      const shadows = (hay.match(/box-shadow\s*:\s*(?!none)/g) || []).length;
      const fonts = (hay.match(/font-size\s*:\s*\d/g) || []).length;
      if (hex.length || shadows || fonts) {
        warnings.push(`[styling]   ${rel}/index.html page-authored visuals: ${hex.length} hex, ${shadows} box-shadow, ${fonts} font-size — move colour/elevation/type to tokens/components (layout css is fine).`);
      }
    }
  }
}

// INV-5 (warn, FO): every component-grade .gv-* block defined in the canonical FO
// stylesheet should be SURFACED by a components/<name>/ demo or documented as a
// primitive in components.md. This catches the drift that BURIES reusable blocks
// inside pages — real in the CSS, but invisible on the Components tab and in
// LIBRARY.md (both scan FOLDERS, not the prose in manifest page rows). When a block
// is authored straight into govocal-ui.css and only ever used in a page, the lists
// never grow even though the library did. Page-composition fragments and text/layout
// utilities are exempt (PAGE_LOCAL) — they're meant to live in a page, not stand
// alone. BO chrome (govocal-bo.css) is intentionally out of scope for now: it's
// surfaced via the bo-app-shell / bo-sidebar components plus the BO section pages.
const familyRoot = (cls) =>
  cls.replace(/^\./, '').replace(/__.*/, '').replace(/--.*/, '').replace(/\..*/, '');

const PAGE_LOCAL = new Set([
  // text / layout utilities — composition, not a standalone block
  'gv-prose', 'gv-section', 'gv-pgrid', 'gv-filterbar', 'gv-filters-btn',
  // single-page composition fragments (project-page header, event-detail layout, …)
  'gv-eventdetail', 'gv-projbar', 'gv-projhead', 'gv-projdesc', 'gv-pinfo',
  'gv-participants', 'gv-pcount', 'gv-poststat', 'gv-thumb-cap',
  // inline link / control utilities
  'gv-back', 'gv-readmore', 'gv-edit',
  // root / a11y helpers
  'gv-root', 'gv-sr-only',
]);

const uiCssPath = path.join(ROOT, 'skills/govocal-ui/govocal-ui.css');
if (fs.existsSync(uiCssPath)) {
  const css = fs.readFileSync(uiCssPath, 'utf8');
  const defined = new Set();
  for (const m of css.matchAll(/(?:^|[}{;])\s*(\.gv-[\w-]+)/g)) defined.add(familyRoot(m[1]));

  const surfaced = new Set();
  // classes USED in component demos (markup only — strip the showcase <style>).
  const compBase = path.join(ROOT, 'components');
  if (fs.existsSync(compBase)) {
    for (const name of fs.readdirSync(compBase)) {
      const idx = path.join(compBase, name, 'index.html');
      if (!fs.existsSync(idx)) continue;
      const markup = fs.readFileSync(idx, 'utf8').replace(/<style[\s\S]*?<\/style>/gi, '');
      for (const m of markup.matchAll(/gv-[\w-]+/g)) surfaced.add(familyRoot(m[0]));
    }
  }
  // families documented as primitives in components.md (before the Composed divider).
  const mdPath = path.join(ROOT, 'skills/govocal-ui/components.md');
  if (fs.existsSync(mdPath)) {
    const prim = fs.readFileSync(mdPath, 'utf8').split(/^#\s+Composed components/m)[0];
    for (const m of prim.matchAll(/gv-[\w-]+/g)) surfaced.add(familyRoot(m[0]));
  }

  const buried = [...defined]
    .filter((f) => f && f.startsWith('gv-') && !surfaced.has(f) && !PAGE_LOCAL.has(f))
    .sort();
  for (const f of buried) {
    warnings.push(`[unsurfaced] .${f} is in govocal-ui.css but no components/<name>/ demo or primitive surfaces it — add a component folder (or promote to a primitive), else it stays invisible on the Components tab/LIBRARY.md. If it's page-local layout, add it to PAGE_LOCAL in lint-architecture.mjs.`);
  }
}

// ── report ──────────────────────────────────────────────────────────────────
console.log(`\nArchitecture lint — library tiers must be hardwired to canonical (prototypes exempt)\n`);
if (violations.length) {
  console.log(`✗ ${violations.length} violation(s) — these break primitives→components→pages sync:`);
  for (const v of violations) console.log('  ' + v);
} else {
  console.log('✓ no violations — every component & page references canonical; nothing redefines or copies.');
}
if (warnings.length) {
  console.log(`\n⚠ ${warnings.length} warning(s) — page-authored styling [styling] + unsurfaced canonical blocks [unsurfaced]:`);
  for (const w of warnings) console.log('  ' + w);
}
console.log('');

process.exit(violations.length ? 1 : 0);
