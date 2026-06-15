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
// Hard invariants (exit 1): INV-1 no asset copies · INV-2 canonical refs only ·
//   INV-3 no .gv-* redefinition · INV-6 no redundant text literals — a page
//   font-size / text `color:` whose value already equals a token MUST use the token
//   (parsed live from govocal-tokens.css; the lint names the exact replacement).
//   INV-6 is what makes "text drinks from tokens" self-enforcing instead of a
//   recurring manual sweep — a value with NO token is a legitimate one-off, untouched.
// Soft warnings (don't fail): INV-4 judgment-zone visuals (non-text colour, elevation,
//   untokenized font-sizes) · INV-5 canonical .gv-* blocks no demo/primitive surfaces.
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

// ── Token tables (parsed from canonical govocal-tokens.css) ───────────────────
// INV-6 below uses these to catch the recurring drift: a page hardcodes a value
// (font-size:14px, color:#333) that ALREADY has a token. That's never correct for
// text — the token exists, so the literal must drink from it. We only know it's
// redundant because we read the real token values here; a value with NO token is a
// legitimate one-off (per the "tokenize by judgment" rule) and is left alone.
const expandHex = (h) => {
  h = h.toLowerCase().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return '#' + h;
};
const fsByValue = new Map();    // "14px" → "--gv-fs-s"
const colorByValue = new Map(); // "#333333" → "--gv-grey-800"
const tokensPath = path.join(ROOT, 'skills/govocal-ui/govocal-tokens.css');
if (fs.existsSync(tokensPath)) {
  const t = fs.readFileSync(tokensPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of t.matchAll(/(--gv-fs-[\w-]+):\s*([0-9.]+px)\s*;/g)) {
    if (!fsByValue.has(m[2])) fsByValue.set(m[2], m[1]); // first definition wins
  }
  for (const m of t.matchAll(/(--gv-[\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    const v = expandHex(m[2]);
    if (!colorByValue.has(v)) colorByValue.set(v, m[1]);
  }
}

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

    // INV-4 (warn) + INV-6 (hard), PAGES only: a page should be pure assembly —
    // layout + content. Raw colour/elevation/type won't sync from upstream.
    // (Component demos are exempt: their <style> is showcase chrome, not the
    // component itself.) We split the old fuzzy "page-authored visuals" warning:
    //   • INV-6 [redundant] (HARD): a font-size or text `color:` literal whose value
    //     EXACTLY equals a token. Zero judgment — the token exists, so the literal is
    //     strictly wrong. We name the replacement so the fix is mechanical. This is
    //     the recurring drift; making it a violation means "text drinks from tokens"
    //     is enforced, not re-swept by hand every time.
    //   • INV-4 [styling] (SOFT): the judgment zone — non-text colour (bg/border),
    //     elevation, and font-sizes with NO token (genuine one-offs). Surfaced, not failed.
    if (tier === 'pages') {
      const inlineStyles = [...html.matchAll(/\sstyle=("|')([^"']*)\1/g)].map((m) => m[2]).join(';');
      // strip /* */ comments — documented hexes in comments aren't rendered styling.
      const css = styleBlocks.replace(/\/\*[\s\S]*?\*\//g, '') + ';' + inlineStyles;

      // INV-6: literals that already have a token (must use it).
      const redundant = new Map(); // "font-size:14px → var(--gv-fs-s)" → count
      const bump = (k) => redundant.set(k, (redundant.get(k) || 0) + 1);
      for (const m of css.matchAll(/font-size:\s*([0-9.]+px)/g)) {
        const tok = fsByValue.get(m[1]);
        if (tok) bump(`font-size:${m[1]} → var(${tok})`);
      }
      // text colour only — `color:` not `background-color:`/`border-color:`, so chart
      // fills and viz backgrounds (genuine one-offs) are out of scope.
      for (const m of css.matchAll(/(?<![-\w])color:\s*(#[0-9a-fA-F]{3,8})\b/g)) {
        const tok = colorByValue.get(expandHex(m[1]));
        if (tok) bump(`color:${m[1]} → var(${tok})`);
      }
      if (redundant.size) {
        const total = [...redundant.values()].reduce((a, b) => a + b, 0);
        const list = [...redundant.entries()].map(([k, n]) => (n > 1 ? `${k} (×${n})` : k)).join('; ');
        violations.push(`[redundant] ${rel}/index.html — ${total} text literal(s) already have a token; drink from it: ${list}`);
      }

      // INV-4: remaining judgment-zone visuals (non-text colour + elevation + untokenized type).
      const hex = (css.match(/#[0-9a-fA-F]{3,8}\b/g) || []).filter((h) => !/^#(fff|ffffff|000|000000)$/i.test(h));
      const shadows = (css.match(/box-shadow\s*:\s*(?!none)/g) || []).length;
      const looseFonts = (css.match(/font-size:\s*([0-9.]+px)/g) || []).filter((s) => !fsByValue.has(s.split(/:\s*/)[1])).length;
      if (hex.length || shadows || looseFonts) {
        warnings.push(`[styling]   ${rel}/index.html page-authored visuals: ${hex.length} hex, ${shadows} box-shadow, ${looseFonts} non-token font-size — promote what's systemic to tokens/components; genuine one-offs are fine (layout css is fine).`);
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
