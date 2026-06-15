#!/usr/bin/env node
// Local render → screenshot. Companion to grab.mjs (which captures LIVE urls).
// grab.mjs gives you the real product's screenshot + computed-style digest; this
// renders a BUILT local page (or any url) in the same headless Chromium at one or
// more viewports so you can put your render next to the captured real screenshot
// and diff them by eye. The numeric half stays in verify.mjs — this is the visual half.
//
// Usage:
//   node scripts/capture/shoot.mjs <file.html|url> --out <dir> [options]
//   node scripts/capture/shoot.mjs pages/perspectives-feed/index.html --out /tmp/pf --viewport 1440x900,390x844
//
// Options:
//   --out <dir>        output dir (required); writes shot-<W>x<H>.png per viewport
//   --viewport WxH[,…] comma-separated viewports (default 1440x900,390x844 = desktop+mobile)
//   --theme <slug>     append ?theme=<slug> so the page re-skins to a tenant
//   --click "<sel>"    click before shooting (reveal a state/modal)
//   --wait "<sel>"     wait for selector before shooting
//   --settle <ms>      extra settle after load (default 700)
//   --no-full          above-the-fold only (default is full-page)
//   --headed           show the browser

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const target = argv.find((a) => !a.startsWith('--'));
const opt = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const flag = (n) => argv.includes(`--${n}`);

const out = opt('out');
if (!target || !out) {
  console.error('Usage: node scripts/capture/shoot.mjs <file.html|url> --out <dir> [--viewport WxH,WxH] [--theme slug] [--click sel] [--wait sel] [--settle ms] [--no-full]');
  process.exit(1);
}

const viewports = (opt('viewport', '1440x900,390x844') + '')
  .split(',').map((s) => s.trim()).filter(Boolean)
  .map((s) => { const [w, h] = s.split('x').map(Number); return { width: w, height: h }; });
const theme = opt('theme');
const clickSel = opt('click');
const waitSel = opt('wait');
const settle = Number(opt('settle', 700));
const fullPage = !flag('no-full');
const headed = flag('headed');

// resolve target → url
let url = target;
if (!/^https?:\/\//.test(target)) {
  const abs = path.isAbsolute(target) ? target : path.join(ROOT, target);
  if (!fs.existsSync(abs)) { console.error('✗ file not found:', abs); process.exit(1); }
  url = pathToFileURL(abs).href;
}
if (theme) url += (url.includes('?') ? '&' : '?') + 'theme=' + theme;

const browser = await chromium.launch({ headless: !headed });
await fs.promises.mkdir(path.isAbsolute(out) ? out : path.join(ROOT, out), { recursive: true });
const outDir = path.isAbsolute(out) ? out : path.join(ROOT, out);

for (const vp of viewports) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch((e) => console.warn('· nav warn:', e.message.split('\n')[0]));
  if (waitSel) await page.waitForSelector(waitSel, { timeout: 8000 }).catch(() => console.warn('· --wait not found:', waitSel));
  if (clickSel) await page.click(clickSel, { timeout: 6000 }).catch(() => console.warn('· --click not found:', clickSel));
  await page.waitForTimeout(settle);
  const file = path.join(outDir, `shot-${vp.width}x${vp.height}.png`);
  await page.screenshot({ path: file, fullPage });
  console.log('· shot', `${vp.width}x${vp.height}`, '→', path.relative(ROOT, file));
  await ctx.close();
}
await browser.close();
console.log('✓ shots →', path.relative(ROOT, outDir) + '/');
