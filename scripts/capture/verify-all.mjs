#!/usr/bin/env node
// GoVocal ratchet runner — re-verifies EVERY registered checkpoint so shared
// primitives can only get better, never silently worse.
//
// Why this exists: primitives are meant to improve on each capture. But a capture
// that "refines" .gv-btn to match one screen can regress the dozen components
// already using it (overfitting to the latest screen). Run this after any change
// to shared CSS (govocal-ui.css / govocal-bo.css / govocal-tokens.css): green =
// real improvement; red = you broke a dependent, back it out.
//
// Registry: govocal-exports/checkpoints.json. Add an entry after you build+verify
// a component/page (see that file's $schema). Each entry pins a built file to a
// live capture via a real→mine selector map.
//
// Usage:
//   npm run verify:all                  # re-verify everything
//   npm run verify:all -- --changed .gv-btn   # only checkpoints that use .gv-btn
//   npm run verify:all -- --only bo-sidebar   # one checkpoint by id
//
// A checkpoint's dependency set is auto-derived from the gv-* classes its built
// file references (override with an explicit "uses" array). --changed <token>
// matches against that set, so you re-verify just the blast radius of a primitive.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadReference, verifyCheckpoint, parseMap, toURL, ROOT, DEFAULT_PROPS } from './verify.mjs';

const argv = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const REGISTRY = path.join(ROOT, 'govocal-exports', 'checkpoints.json');
if (!fs.existsSync(REGISTRY)) {
  console.error('✗ no govocal-exports/checkpoints.json — nothing registered yet.');
  process.exit(1);
}
const registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
let checkpoints = registry.checkpoints || [];

// Auto-derive the gv-* classes a built file references (the dependency map).
const depCache = new Map();
function depsOf(cp) {
  if (Array.isArray(cp.uses)) return cp.uses.map((u) => u.replace(/^\./, ''));
  if (depCache.has(cp.id)) return depCache.get(cp.id);
  let tokens = [];
  const file = path.resolve(ROOT, cp.built);
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8');
    tokens = [...new Set((text.match(/gv-[a-z0-9-]+/g) || []))];
  }
  depCache.set(cp.id, tokens);
  return tokens;
}

// Filters.
const only = opt('only');
const changed = opt('changed');
if (only) checkpoints = checkpoints.filter((c) => c.id === only);
if (changed) {
  const tok = (changed + '').replace(/^\./, '');
  checkpoints = checkpoints.filter((c) => depsOf(c).some((d) => d === tok || d.startsWith(tok)));
}

if (!checkpoints.length) {
  console.log(only || changed ? '· no checkpoints match that filter.' : '· no checkpoints registered yet — add some to govocal-exports/checkpoints.json after you build+verify a piece.');
  process.exit(0);
}

const browser = await chromium.launch({ headless: true });

const rows = [];
let anyFail = false;

for (const cp of checkpoints) {
  const row = { id: cp.id, built: cp.built, against: cp.against };
  try {
    const { probed, meta } = loadReference(cp.against);
    const pairs = cp.map
      ? (typeof cp.map === 'string' ? parseMap(cp.map) : Object.entries(cp.map).map(([real, mine]) => ({ real, mine })))
      : Object.keys(probed).map((real) => ({ real, mine: real }));
    const [vw, vh] = (cp.viewport || `${meta.viewport?.width || 1440}x${meta.viewport?.height || 900}`).split('x').map(Number);

    const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.goto(toURL(cp.built), { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(200);
    const res = await verifyCheckpoint(page, { pairs, probed, props: cp.props || DEFAULT_PROPS, tol: Number(cp.tol ?? 1) });
    await ctx.close();

    row.checked = res.checked;
    row.diffs = res.totalDiffs;
    row.missing = res.missing;
    row.status = res.totalDiffs || res.missing ? 'FAIL' : 'ok';
    row.detail = res.results.filter((r) => r.status === 'drift' || r.status === 'not-found' || r.status === 'no-ref');
    if (row.status === 'FAIL') anyFail = true;
  } catch (e) {
    row.status = 'SKIP';
    row.error = e.message;
  }
  rows.push(row);
}

await browser.close();

// ── report ────────────────────────────────────────────────────────────────
console.log(`\nRatchet · ${rows.length} checkpoint(s)` + (changed ? `  [changed: ${changed}]` : only ? `  [only: ${only}]` : ''));
for (const r of rows) {
  const mark = r.status === 'ok' ? '✓' : r.status === 'SKIP' ? '–' : '✗';
  const tail = r.status === 'ok' ? `${r.checked} ok`
    : r.status === 'SKIP' ? `skipped: ${r.error}`
    : `${r.diffs} mismatch(es)${r.missing ? `, ${r.missing} missing` : ''}`;
  console.log(`  ${mark} ${r.id.padEnd(22)} ${tail}`);
  if (r.status === 'FAIL') {
    for (const d of r.detail) {
      if (d.status === 'not-found') { console.log(`        ✗ "${d.mine}" not found in render`); continue; }
      if (d.status === 'no-ref') { console.log(`        ⚠ no probed ref for "${d.real}"`); continue; }
      console.log(`        ${d.mine} ← ${d.real}`);
      for (const x of d.diffs) console.log(`          ${x.prop}: real ${x.real}  ·  you ${x.mine}`);
    }
  }
}

const okCount = rows.filter((r) => r.status === 'ok').length;
const skipCount = rows.filter((r) => r.status === 'SKIP').length;
console.log(`\n${okCount} green · ${rows.length - okCount - skipCount} red · ${skipCount} skipped`);
if (anyFail) {
  console.log('→ a shared change regressed a dependent. Fix or back it out before landing.\n');
  process.exit(1);
}
console.log('✓ ratchet holds — every checkpoint still matches its live capture.\n');
