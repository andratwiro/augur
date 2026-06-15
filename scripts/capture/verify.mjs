#!/usr/bin/env node
// GoVocal fidelity verifier — System-building mode, final step of the pipeline.
//
// Renders a component/page you BUILT and numerically diffs its computed styles
// against a live capture's pinned checkpoints (styles.json → `probed`). This is
// the step that gives the verify loop teeth: instead of eyeballing your render
// against the screenshot, you get an exact mismatch list (real vs yours) and a
// non-zero exit when anything drifts.
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
const ROOT = path.resolve(HERE, '..', '..');

const argv = process.argv.slice(2);
const target = argv.find((a) => !a.startsWith('--'));
function opt(name, def = null) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const flag = (name) => argv.includes(`--${name}`);

const against = opt('against');
if (!target || !against) {
  console.error('Usage: node scripts/capture/verify.mjs <built.html> --against <captureName> [--map "real=mine|…"] [--tol 1] [--viewport WxH]');
  process.exit(1);
}

const capDir = path.join(ROOT, 'govocal-exports', against);
const stylesPath = path.join(capDir, 'styles.json');
if (!fs.existsSync(stylesPath)) {
  console.error(`✗ no styles.json in ${path.relative(ROOT, capDir)} — re-capture that screen first.`);
  process.exit(1);
}
const ref = JSON.parse(fs.readFileSync(stylesPath, 'utf8'));
if (!ref.probed || !Object.keys(ref.probed).length) {
  console.error(`✗ ${against}/styles.json has no "probed" checkpoints. Re-capture with --probe "<real selectors>" so there's something to verify against.`);
  process.exit(1);
}

// Default props to compare — the ones that actually carry visual fidelity.
const DEFAULT_PROPS = [
  'color', 'background-color', 'background-image',
  'font-family', 'font-size', 'font-weight', 'line-height', 'text-transform',
  'border', 'border-radius', 'box-shadow', 'padding',
];
const PROPS = opt('props') ? (opt('props') + '').split(',').map((s) => s.trim()) : DEFAULT_PROPS;
const TOL = Number(opt('tol', 1));

// Build the selector pairs: real (key in probed) → mine (local selector).
let pairs;
if (opt('map')) {
  pairs = (opt('map') + '').split('|').map((p) => {
    const [real, mine] = p.split('=').map((s) => s.trim());
    return { real, mine: mine || real };
  });
} else {
  pairs = Object.keys(ref.probed).map((real) => ({ real, mine: real }));
}

const capMeta = (() => {
  const m = path.join(capDir, 'meta.json');
  return fs.existsSync(m) ? JSON.parse(fs.readFileSync(m, 'utf8')) : {};
})();
const [vw, vh] = (opt('viewport', `${capMeta.viewport?.width || 1440}x${capMeta.viewport?.height || 900}`) + '').split('x').map(Number);

// ── normalise + compare a single property value ───────────────────────────
const norm = (v) => (v || '').replace(/\s+/g, ' ').trim().toLowerCase();
const lengths = (v) => (v.match(/-?\d*\.?\d+px/g) || []).map(parseFloat);
function propMatches(real, mine) {
  if (norm(real) === norm(mine)) return true;
  // tolerate sub-px / rounding differences when the non-numeric skeleton matches
  const rl = lengths(real), ml = lengths(mine);
  if (rl.length && rl.length === ml.length) {
    const skeleton = (v) => norm(v).replace(/-?\d*\.?\d+px/g, '«»');
    if (skeleton(real) === skeleton(mine) && rl.every((n, i) => Math.abs(n - ml[i]) <= TOL)) return true;
  }
  return false;
}

async function main() {
  const browser = await chromium.launch({ headless: !flag('headed') });
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();

  const url = /^https?:\/\//.test(target) ? target : 'file://' + path.resolve(ROOT, target);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(300);

  let totalDiffs = 0, missing = 0, checked = 0;
  const lines = [];

  for (const { real, mine } of pairs) {
    const refRec = (ref.probed[real] || [])[0];
    if (!refRec) { lines.push(`  ⚠ no probed reference for "${real}" in capture`); missing++; continue; }

    const mineRec = await page.evaluate(({ sel, props }) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      const rec = {};
      for (const p of props) rec[p] = cs.getPropertyValue(p);
      return rec;
    }, { sel: mine, props: PROPS });

    if (!mineRec) { lines.push(`  ✗ "${mine}" not found in your render (maps to real "${real}")`); missing++; continue; }

    checked++;
    const diffs = [];
    for (const p of PROPS) {
      if (!propMatches(refRec[p], mineRec[p])) {
        diffs.push(`      ${p}\n        real: ${refRec[p]}\n        you : ${mineRec[p]}`);
      }
    }
    if (diffs.length) {
      totalDiffs += diffs.length;
      lines.push(`  ✗ ${mine}  ← ${real}  (${diffs.length} off)`);
      lines.push(...diffs);
    } else {
      lines.push(`  ✓ ${mine}  ← ${real}`);
    }
  }

  await browser.close();

  console.log(`\nVerify  ${path.relative(ROOT, target)}  vs  capture:${against}  @ ${vw}x${vh}`);
  console.log(lines.join('\n'));
  console.log(`\n${checked} checkpoint(s) checked · ${totalDiffs} mismatch(es)` + (missing ? ` · ${missing} unresolved selector(s)` : ''));

  if (totalDiffs || missing) {
    console.log('→ fidelity drift — fix the values above (prefer --gv-* tokens) and re-run.\n');
    process.exit(1);
  }
  console.log('✓ matches the live capture within tolerance.\n');
}

main().catch((e) => {
  console.error('✗ verify failed:', e.message);
  process.exit(1);
});
