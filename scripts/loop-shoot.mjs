#!/usr/bin/env node
// Overnight-loop render helper (internal, never ships). Renders a local prototype
// to PNG(s), capturing console errors + page errors, optionally clicking through a
// sequence of selectors and shooting after each.
//
// Usage:
//   node scripts/loop-shoot.mjs <file.html> <outPrefix> [WxH] [clickSel|clickSel|...]
import { chromium } from 'playwright';
import path from 'node:path';

const [file, outPrefix, size = '1440x1100', clicks = ''] = process.argv.slice(2);
if (!file || !outPrefix) { console.error('usage: node scripts/loop-shoot.mjs <file> <outPrefix> [WxH] [sel|sel]'); process.exit(1); }
const [w, h] = size.split('x').map(Number);
const abs = path.resolve(file);

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: w || 1440, height: h || 1100 } });
const errors = [];
p.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
p.on('pageerror', e => errors.push('PAGEERR: ' + e.message));
await p.goto('file://' + abs, { waitUntil: 'networkidle' }).catch(e => errors.push('GOTO: ' + e.message));
await p.waitForTimeout(500);
await p.screenshot({ path: `${outPrefix}-0.png`, fullPage: true });
const seq = clicks ? clicks.split('|').filter(Boolean) : [];
let i = 1;
for (const sel of seq) {
  try { await p.click(sel, { timeout: 3000 }); await p.waitForTimeout(450); await p.screenshot({ path: `${outPrefix}-${i}.png`, fullPage: true }); }
  catch (e) { errors.push(`CLICK ${sel}: ${e.message.split('\n')[0]}`); }
  i++;
}
await b.close();
if (errors.length) { console.log('ERRORS for', file); errors.forEach(e => console.log('  ' + e)); }
else console.log('clean:', file);
console.log('shots →', outPrefix + '-*.png');
