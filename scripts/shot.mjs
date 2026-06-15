#!/usr/bin/env node
// Reusable screenshot helper for fidelity audits (internal dev tool, never ships).
// Renders a local page to a PNG, optionally clicking a tab first to reveal a panel.
//
// Usage:
//   node scripts/shot.mjs <file.html> <out.png> [WxH] [clickSelector]
// Examples:
//   node scripts/shot.mjs pages/bo-settings/index.html /tmp/s.png 1440x1300
//   node scripts/shot.mjs pages/bo-dashboard/index.html /tmp/d.png 1440x1300 '[data-db="users"]'
import { chromium } from 'playwright';
import path from 'node:path';

const [file, out, size = '1440x1100', clickSel] = process.argv.slice(2);
if (!file || !out) { console.error('usage: node scripts/shot.mjs <file> <out> [WxH] [clickSelector]'); process.exit(1); }
const [w, h] = size.split('x').map(Number);
const abs = path.resolve(file);

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: w || 1440, height: h || 1100 } });
await p.goto('file://' + abs, { waitUntil: 'networkidle' });
if (clickSel) { await p.click(clickSel); await p.waitForTimeout(350); }
await p.waitForTimeout(400);
await p.screenshot({ path: out, fullPage: true });
await b.close();
console.log('shot →', out);
