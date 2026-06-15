#!/usr/bin/env node
// GoVocal fidelity verifier — System-building mode, final step of the pipeline.
//
// Renders a component/page you BUILT and numerically diffs its computed styles
// against a live capture's pinned checkpoints (styles.json → `probed`). This is
// the step that gives the verify loop teeth: instead of eyeballing your render
// against the screenshot, you get an exact mismatch list (real vs yours) and a
// non-zero exit when anything drifts.
//
// Its core is exported (loadReference / verifyCheckpoint) so the ratchet runner
// `verify-all.mjs` re-checks every registered checkpoint with the same logic.
//
// Prereq: the reference capture must have been probed at grab time, e.g.
//   npm run capture -- <url> --name bo-sidebar --probe ".gv-bo-side|.gv-bo-nav__item"
// (Local renders can't reproduce the live computed styles from dom.html alone —
//  the real values must be captured live. The digest is for BUILDING; the probed
//  block is for VERIFYING.)
//
// Usage:
//   node scripts/capture/verify.mjs <built.html> --against <captureName> [options]
//   npm run verify -- <built.html> --against <captureName> [options]
//
// Options:
//   --against <name>     capture folder under govocal-exports/ (required)
//   --map "real=mine|…"  pair each REAL probed selector with YOUR local selector.
//                        Omit to auto-pair selectors present identically in both.
//   --props "a,b"        only diff these props (default: the visually salient set)
//   --tol <px>           px tolerance for length values (default 1)
//   --viewport WxH       render viewport (default: the capture's own viewport)
//   --headed             show the browser

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');

// Default props to compare — the ones that actually carry visual fidelity.
export const DEFAULT_PROPS = [
  'color', 'background-color', 'background-image',
  'font-family', 'font-size', 'font-weight', 'line-height', 'text-transform',
  'border', 'border-radius', 'box-shadow', 'padding',
];

// ── normalise + compare a single property value ───────────────────────────
const norm = (v) => (v || '').replace(/\s+/g, ' ').trim().toLowerCase();
const lengths = (v) => (v.match(/-?\d*\.?\d+px/g) || []).map(parseFloat);
export function propMatches(real, mine, tol = 1) {
  if (norm(real) === norm(mine)) return true;
  // tolerate sub-px / rounding differences when the non-numeric skeleton matches
  const rl = lengths(real || ''), ml = lengths(mine || '');
  if (rl.length && rl.length === ml.length) {
    const skeleton = (v) => norm(v).replace(/-?\d*\.?\d+px/g, '«»');
    if (skeleton(real) === skeleton(mine) && rl.every((n, i) => Math.abs(n - ml[i]) <= tol)) return true;
  }
  return false;
}

// Load a capture's pinned checkpoints. Throws (with a fix hint) if unusable.
export function loadReference(against) {
  const capDir = path.join(ROOT, 'govocal-exports', against);
  const stylesPath = path.join(capDir, 'styles.json');
  if (!fs.existsSync(stylesPath)) {
    throw new Error(`no styles.json in govocal-exports/${against} — re-capture that screen first.`);
  }
  const ref = JSON.parse(fs.readFileSync(stylesPath, 'utf8'));
  if (!ref.probed || !Object.keys(ref.probed).length) {
    throw new Error(`govocal-exports/${against}/styles.json has no "probed" checkpoints — re-capture with --probe "<real selectors>".`);
  }
  const metaPath = path.join(capDir, 'meta.json');
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};
  return { probed: ref.probed, meta };
}

// Diff one already-loaded page against a reference's probed checkpoints.
// pairs: [{ real, mine }]. Returns a structured result (no printing, no exit).
export async function verifyCheckpoint(page, { pairs, probed, props = DEFAULT_PROPS, tol = 1 }) {
  const results = [];
  let totalDiffs = 0, missing = 0, checked = 0;

  for (const { real, mine } of pairs) {
    const refRec = (probed[real] || [])[0];
    if (!refRec) { results.push({ real, mine, status: 'no-ref' }); missing++; continue; }

    const mineRec = await page.evaluate(({ sel, props }) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      const rec = {};
      for (const p of props) rec[p] = cs.getPropertyValue(p);
      return rec;
    }, { sel: mine, props });

    if (!mineRec) { results.push({ real, mine, status: 'not-found' }); missing++; continue; }

    checked++;
    const diffs = [];
    for (const p of props) {
      if (!propMatches(refRec[p], mineRec[p], tol)) diffs.push({ prop: p, real: refRec[p], mine: mineRec[p] });
    }
    if (diffs.length) totalDiffs += diffs.length;
    results.push({ real, mine, status: diffs.length ? 'drift' : 'ok', diffs });
  }
  return { results, totalDiffs, missing, checked };
}

// Parse a "real=mine|real2=mine2" map string into pairs.
export function parseMap(str) {
  return (str + '').split('|').map((p) => {
    const [real, mine] = p.split('=').map((s) => s.trim());
    return { real, mine: mine || real };
  });
}

// Resolve a target path/url to something playwright can open.
export function toURL(target) {
  return /^https?:\/\//.test(target) ? target : 'file://' + path.resolve(ROOT, target);
}

// ── CLI ───────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  const target = argv.find((a) => !a.startsWith('--'));
  const opt = (name, def = null) => {
    const i = argv.indexOf(`--${name}`);
    if (i === -1) return def;
    const v = argv[i + 1];
    return v && !v.startsWith('--') ? v : true;
  };
  const flag = (name) => argv.includes(`--${name}`);

  const against = opt('against');
  if (!target || !against) {
    console.error('Usage: node scripts/capture/verify.mjs <built.html> --against <captureName> [--map "real=mine|…"] [--tol 1] [--viewport WxH]');
    process.exit(1);
  }

  let probed, meta;
  try { ({ probed, meta } = loadReference(against)); }
  catch (e) { console.error('✗ ' + e.message); process.exit(1); }

  const props = opt('props') ? (opt('props') + '').split(',').map((s) => s.trim()) : DEFAULT_PROPS;
  const tol = Number(opt('tol', 1));
  const pairs = opt('map') ? parseMap(opt('map')) : Object.keys(probed).map((real) => ({ real, mine: real }));
  const [vw, vh] = (opt('viewport', `${meta.viewport?.width || 1440}x${meta.viewport?.height || 900}`) + '').split('x').map(Number);

  const browser = await chromium.launch({ headless: !flag('headed') });
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(toURL(target), { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(300);

  const { results, totalDiffs, missing, checked } = await verifyCheckpoint(page, { pairs, probed, props, tol });
  await browser.close();

  console.log(`\nVerify  ${target}  vs  capture:${against}  @ ${vw}x${vh}`);
  for (const r of results) {
    if (r.status === 'no-ref') { console.log(`  ⚠ no probed reference for "${r.real}" in capture`); continue; }
    if (r.status === 'not-found') { console.log(`  ✗ "${r.mine}" not found in your render (maps to real "${r.real}")`); continue; }
    if (r.status === 'ok') { console.log(`  ✓ ${r.mine}  ← ${r.real}`); continue; }
    console.log(`  ✗ ${r.mine}  ← ${r.real}  (${r.diffs.length} off)`);
    for (const d of r.diffs) console.log(`      ${d.prop}\n        real: ${d.real}\n        you : ${d.mine}`);
  }
  console.log(`\n${checked} checkpoint(s) checked · ${totalDiffs} mismatch(es)` + (missing ? ` · ${missing} unresolved selector(s)` : ''));

  if (totalDiffs || missing) {
    console.log('→ fidelity drift — fix the values above (prefer --gv-* tokens) and re-run.\n');
    process.exit(1);
  }
  console.log('✓ matches the live capture within tolerance.\n');
}

// Only run the CLI when invoked directly (not when imported by verify-all).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error('✗ verify failed:', e.message); process.exit(1); });
}
