#!/usr/bin/env node
/* detach.mjs — Augur Phase 4: flatten ONE linked instance in a prototype to a local
 * fork (Figma "detach instance").
 *
 *   npm run detach -- <prototype> <component>
 *   e.g. npm run detach -- citytest participation-box
 *
 * A LINKED instance is a declarative mount the GV runtime renders on every load:
 *   <div data-gv-instance="participation-box" data-gv-props='{…}'></div>
 * It tracks the canonical master — edit the renderer and the prototype reflows.
 *
 * DETACH (this script) does, for every matching node in the prototype's HTML pages:
 *   1. runs GV.render(component, props) in node (the same renderer the browser uses)
 *      and FREEZES that markup INLINE inside the node — no longer re-rendered;
 *   2. stamps data-gv-detached on the node (so GV.mountAll SKIPS it) and adds the
 *      component's .gv-* families to window.__GV_DETACHED (the Shift+C overlay reads
 *      both to paint the "detached" health badge);
 *   3. writes a LOCAL CSS COPY — the component's family rules extracted from canonical
 *      into assets/detached/<component>.css, linked AFTER the canonical sheet so your
 *      edits win. (It loads globally; scope edits with the component's wrapper class.
 *      Lightweight by design — the markup is the fork; canonical still supplies tokens.)
 *   4. records the fork in <prototype>/.detached.json (lineage + re-detach + lint).
 *
 * This is the deliberate, reverse-of-default op: prototypes are LINKED by default
 * (npm run lint INV-10 enforces it); you detach only when you want a local copy to
 * freely edit. There is no auto-relink — delete the inline markup + restore the empty
 * <div data-gv-instance> (and drop the .detached.json entry) to go back to linked.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(ROOT, 'skills', 'govocal-ui');
const CANON_CSS = ['govocal-primitives.css', 'govocal-ui.css', 'govocal-bo.css', 'govocal-survey.css', 'govocal-widgets.css'];

function die(msg) { console.error('✗ ' + msg); process.exit(1); }

// ── args ──────────────────────────────────────────────────────────────────────
const [, , protoArg, component] = process.argv;
if (!protoArg || !component) die('usage: npm run detach -- <prototype> <component>   (e.g. citytest participation-box)');

// ── resolve the prototype dir (slug under any <opportunity>/prototypes/, or a path) ──
function findProto(slug) {
  const direct = path.resolve(ROOT, slug);
  if (fs.existsSync(path.join(direct, 'index.html')) || fs.existsSync(direct) && fs.statSync(direct).isDirectory()) {
    if (fs.existsSync(direct) && fs.statSync(direct).isDirectory()) return direct;
  }
  const hits = [];
  for (const opp of fs.readdirSync(ROOT)) {
    const pdir = path.join(ROOT, opp, 'prototypes');
    if (!fs.existsSync(pdir)) continue;
    for (const name of fs.readdirSync(pdir)) {
      if (name === slug && fs.statSync(path.join(pdir, name)).isDirectory()) hits.push(path.join(pdir, name));
    }
  }
  if (hits.length > 1) die(`ambiguous prototype "${slug}" — matches:\n  ${hits.map((h) => path.relative(ROOT, h)).join('\n  ')}\nPass a full path.`);
  return hits[0] || null;
}
const protoDir = findProto(protoArg);
if (!protoDir) die(`prototype "${protoArg}" not found under any <opportunity>/prototypes/.`);
const protoRel = path.relative(ROOT, protoDir);

// ── load the canonical GV registry in a browser-ish sandbox ────────────────────
const instancesPath = path.join(UI, 'govocal-instances.js');
if (!fs.existsSync(instancesPath)) die('canonical govocal-instances.js missing.');
const ctx = { console };
ctx.window = ctx;                       // window.GV === GV (bare identifier resolves)
ctx.document = { readyState: 'complete', addEventListener() {}, querySelectorAll: () => [] };
ctx.ResizeObserver = function () { this.observe = () => {}; this.disconnect = () => {}; };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(instancesPath, 'utf8'), ctx, { filename: 'govocal-instances.js' });
const GV = ctx.GV;
if (!GV || !GV.render) die('GV runtime failed to load.');
if (!GV.components[component]) die(`no canonical component "${component}". See skills/govocal-ui/INSTANCES.md.`);

// ── family extraction from canonical CSS ───────────────────────────────────────
const familyRoot = (cls) => cls.replace(/^\./, '').replace(/__.*/, '').replace(/--.*/, '');
function familiesIn(html) {
  const fams = new Set();
  for (const m of html.matchAll(/gv-[\w-]+/g)) { const f = familyRoot(m[0]); if (f.startsWith('gv-')) fams.add(f); }
  return fams;
}
// Walk CSS at brace-depth 0, yielding {kind:'rule'|'at', selector, body, raw}. @media
// (and other @-blocks) are recursed one level so we can keep only matching inner rules.
function topRules(css) {
  const out = [];
  let i = 0, n = css.length;
  while (i < n) {
    // skip whitespace + comments
    if (/\s/.test(css[i])) { i++; continue; }
    if (css[i] === '/' && css[i + 1] === '*') { const e = css.indexOf('*/', i + 2); i = e === -1 ? n : e + 2; continue; }
    let j = i, depth = 0, started = false;
    for (; j < n; j++) { if (css[j] === '{') { depth++; started = true; } else if (css[j] === '}') { depth--; if (depth === 0) { j++; break; } } else if (css[j] === ';' && !started) { j++; break; } }
    const raw = css.slice(i, j);
    const brace = raw.indexOf('{');
    if (brace === -1) { i = j; continue; }
    const head = raw.slice(0, brace).trim();
    const body = raw.slice(brace + 1, raw.lastIndexOf('}'));
    out.push(head.startsWith('@') ? { kind: 'at', head, body, raw } : { kind: 'rule', head, body, raw });
    i = j;
  }
  return out;
}
const selMatches = (selectorList, fams) =>
  selectorList.split(',').some((sel) => [...sel.matchAll(/\.(gv-[\w-]+)/g)].some((m) => fams.has(familyRoot('.' + m[1]))));

function extractCss(fams) {
  const chunks = [];
  for (const f of CANON_CSS) {
    const p = path.join(UI, f);
    if (!fs.existsSync(p)) continue;
    const css = fs.readFileSync(p, 'utf8');
    const kept = [];
    for (const r of topRules(css)) {
      if (r.kind === 'rule') { if (selMatches(r.head, fams)) kept.push(r.raw.trim()); }
      else { // @media / @supports — keep inner rules that match, re-wrapped
        const inner = topRules(r.body).filter((ir) => ir.kind === 'rule' && selMatches(ir.head, fams));
        if (inner.length) kept.push(`${r.head} {\n${inner.map((ir) => '  ' + ir.raw.trim()).join('\n')}\n}`);
      }
    }
    if (kept.length) chunks.push(`/* ── from ${f} ── */\n${kept.join('\n')}`);
  }
  return chunks.join('\n\n');
}

// ── find + flatten the declarative nodes across every .html page ───────────────
const pages = fs.readdirSync(protoDir).filter((f) => f.endsWith('.html'));
if (!pages.length) die(`no .html pages in ${protoRel}.`);

const allFams = new Set();
let totalNodes = 0;
let lastProps = {};
const touchedPages = [];

const nodeRe = new RegExp(
  `<(\\w+)((?:[^>]*?)\\sdata-gv-instance=(["'])${component.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\3(?:[^>]*?))>([\\s\\S]*?)<\\/\\1>`, 'g');

for (const page of pages) {
  const pPath = path.join(protoDir, page);
  let html = fs.readFileSync(pPath, 'utf8');
  let pageNodes = 0;
  html = html.replace(nodeRe, (full, tag, attrs, q, inner) => {
    if (/\sdata-gv-detached\b/.test(attrs)) return full; // already detached
    const pm = attrs.match(/\sdata-gv-props=(["'])([\s\S]*?)\1/);
    let props = {};
    if (pm) { try { props = JSON.parse(pm[2]); } catch (e) { die(`bad data-gv-props on <${tag} data-gv-instance="${component}"> in ${page}: ${e.message}`); } }
    const rendered = GV.render(component, props);
    familiesIn(rendered).forEach((f) => allFams.add(f));
    lastProps = props;
    pageNodes++;
    const cleanAttrs = attrs.replace(/\s+$/, '');
    return `<${tag}${cleanAttrs} data-gv-detached>\n${rendered}\n</${tag}>`;
  });
  if (!pageNodes) continue;
  pageNodes && (totalNodes += pageNodes);
  touchedPages.push(page);

  // 1) ensure the local CSS copy is linked (after the canonical sheet) — once per page
  const cssHref = `assets/detached/${component}.css`;
  if (!html.includes(cssHref)) {
    const linkTag = `\n  <link rel="stylesheet" href="${cssHref}" /><!-- detached: ${component} -->`;
    // insert after the last canonical govocal css link, else before </head>
    const lastLink = [...html.matchAll(/<link[^>]*govocal-[\w.-]+\.css[^>]*>/g)].pop();
    if (lastLink) html = html.slice(0, lastLink.index + lastLink[0].length) + linkTag + html.slice(lastLink.index + lastLink[0].length);
    else html = html.replace(/<\/head>/i, linkTag + '\n</head>');
  }

  // 2) stamp window.__GV_DETACHED (merge) so the overlay badges every family detached
  const famArr = [...allFams];
  const stamp = `<script>window.__GV_DETACHED=(window.__GV_DETACHED||[]).concat(${JSON.stringify(famArr)}).filter((v,i,a)=>a.indexOf(v)===i);</script>`;
  html = html.replace(/<script>window\.__GV_DETACHED=[\s\S]*?<\/script>\n?/g, ''); // replace prior stamp
  html = html.replace(/<\/head>/i, '  ' + stamp + '\n</head>');

  fs.writeFileSync(pPath, html, 'utf8');
}

if (!totalNodes) die(`no LINKED <… data-gv-instance="${component}"> nodes found in ${protoRel}. (Already detached, or the prototype doesn't import this instance.)`);

// ── write the local CSS copy ───────────────────────────────────────────────────
const fams = [...allFams];
const css = extractCss(new Set(fams));
const outDir = path.join(protoDir, 'assets', 'detached');
fs.mkdirSync(outDir, { recursive: true });
const header = `/* DETACHED LOCAL COPY — ${component}\n` +
  ` * Forked from canonical by \`npm run detach -- ${path.basename(protoDir)} ${component}\`.\n` +
  ` * Families: ${fams.join(', ')}\n` +
  ` * Loaded AFTER the canonical sheet so edits here win. Editing this no longer tracks\n` +
  ` * canonical. Loads globally — scope edits with the component's wrapper class to avoid\n` +
  ` * affecting other ${fams[0] || 'gv-*'} on the page. Tokens (var(--gv-*)) still resolve from canonical.\n */\n\n`;
fs.writeFileSync(path.join(outDir, `${component}.css`), header + (css || '/* (no canonical rules matched — markup-only fork) */\n'), 'utf8');

// ── record the fork manifest ───────────────────────────────────────────────────
const manifestPath = path.join(protoDir, '.detached.json');
let manifest = {};
if (fs.existsSync(manifestPath)) { try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch {} }
manifest[component] = { families: fams, css: `assets/detached/${component}.css`, nodes: totalNodes, pages: touchedPages, props: lastProps };
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

console.log(`✓ detached "${component}" in ${protoRel}`);
console.log(`  · ${totalNodes} node(s) frozen across: ${touchedPages.join(', ')}`);
console.log(`  · families: ${fams.join(', ')}`);
console.log(`  · local css: ${path.relative(ROOT, path.join(outDir, component + '.css'))}`);
console.log(`  · manifest:  ${path.relative(ROOT, manifestPath)}`);
console.log(`  Edit the inline markup + assets/detached/${component}.css freely — it no longer tracks canonical.`);
