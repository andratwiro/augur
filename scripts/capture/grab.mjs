#!/usr/bin/env node
// GoVocal capture harness — System-building mode, step 1 of the pipeline.
//
// Point it at a live GoVocal URL; it dumps the raw material the fidelity pipeline
// needs into govocal-exports/<name>/:
//   page.png      full-page screenshot (the visual spec + verify target)
//   viewport.png  above-the-fold screenshot at the requested viewport
//   dom.html      the RENDERED outerHTML (the source of truth, not a guess)
//   styles.json   ALWAYS written. { digest, probed }:
//                   digest = every DISTINCT visual treatment on the page (deduped
//                            by style signature, exact computed values + count) —
//                            read these instead of eyeballing colours off the PNG.
//                   probed = the selectors you pass to --probe (pinned checkpoints
//                            for `npm run verify`); null when --probe is omitted.
//   meta.json     url, title, viewport, captured-at, surface guess
//
// Auth: logs into the demo platform once and reuses the saved session
// (scripts/capture/.auth/state.json — gitignored). Re-login with --login.
// Creds come from .env.capture (gitignored) — never hardcoded here.
//
// Usage:
//   node scripts/capture/grab.mjs <url> --name <slug> [options]
//   npm run capture -- <url> --name <slug> [options]
//
// Options:
//   --name <slug>        output folder under govocal-exports/ (required)
//   --probe "a|b|.c"     pipe-separated CSS selectors to extract computed styles for
//   --viewport WxH       default 1440x900
//   --wait <selector>    extra selector to wait for before capturing
//   --click <selector>   click this before capturing (reveal a menu/state)
//   --settle <ms>        extra settle time after load (default 800)
//   --headed             show the browser window
//   --login              force a fresh interactive login, refreshing the session
//
// Surface tag: URLs containing /admin/ are tagged back-office (GoVocal bluish
// theme); everything else front-office (per-city themed). Recorded in meta.json
// so the library knows which bucket a capture feeds.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const AUTH_DIR = path.join(HERE, '.auth');
const AUTH_STATE = path.join(AUTH_DIR, 'state.json');

// ---- tiny .env loader (no dependency) ----------------------------------
function loadEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}
const ENV = loadEnv(path.join(ROOT, '.env.capture'));

// ---- arg parsing -------------------------------------------------------
const argv = process.argv.slice(2);
const url = argv.find((a) => !a.startsWith('--'));
function opt(name, def = null) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const flag = (name) => argv.includes(`--${name}`);

const name = opt('name');
const [vw, vh] = (opt('viewport', '1440x900') + '').split('x').map(Number);
const probe = opt('probe');
const waitSel = opt('wait');
const clickSel = opt('click');
const settle = Number(opt('settle', 800));
const headed = flag('headed');
const forceLogin = flag('login');

if (!url || !name) {
  console.error('Usage: node scripts/capture/grab.mjs <url> --name <slug> [--probe "sel|sel"] [--viewport WxH] [--wait sel] [--click sel] [--headed] [--login]');
  process.exit(1);
}

const surface = /\/admin\//.test(url) ? 'back-office' : 'front-office';

// Curated computed-style properties — the reusable "chrome", not content.
const PROBE_PROPS = [
  'color', 'background-color', 'background-image',
  'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-transform',
  'padding', 'margin', 'gap',
  'border', 'border-width', 'border-color', 'border-radius', 'border-style',
  'box-shadow', 'outline',
  'display', 'flex-direction', 'align-items', 'justify-content',
  'width', 'height', 'min-height', 'max-width',
  'position', 'top', 'left', 'overflow', 'overflow-y', 'z-index',
  'opacity',
];

// ---- login -------------------------------------------------------------
async function login(browser) {
  if (!ENV.GOVOCAL_USER || !ENV.GOVOCAL_PASS) {
    throw new Error('Missing GOVOCAL_USER / GOVOCAL_PASS in .env.capture');
  }
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh } });
  const page = await ctx.newPage();
  const signin = ENV.GOVOCAL_SIGNIN || `${ENV.GOVOCAL_BASE}/en/sign-in`;
  console.log('· logging in at', signin);
  await page.goto(signin, { waitUntil: 'networkidle' });

  // GoVocal uses an email-first two-step auth modal (and the page has many other
  // submit buttons, so target by role/id, never "first submit"):
  //   1) #email  → "Continue"  2) #e2e-password-input → "Log in"
  try {
    await page.locator('#email').fill(ENV.GOVOCAL_USER, { timeout: 10000 });
    await page.getByRole('button', { name: 'Continue' }).click({ timeout: 8000 });
    const pw = page.locator('#e2e-password-input');
    await pw.waitFor({ state: 'visible', timeout: 10000 });
    await pw.fill(ENV.GOVOCAL_PASS);
    await page.getByRole('button', { name: 'Log in' }).click({ timeout: 8000 });
    // Success = the auth modal's password field goes away.
    await pw.waitFor({ state: 'detached', timeout: 20000 }).catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
  } catch (e) {
    console.log('· autofill incomplete (' + e.message.split('\n')[0] + ') — finish login in the window if open');
    if (headed) await page.locator('#e2e-password-input').waitFor({ state: 'detached', timeout: 180000 }).catch(() => {});
  }
  await fs.promises.mkdir(AUTH_DIR, { recursive: true });
  await ctx.storageState({ path: AUTH_STATE });
  console.log('· session saved →', path.relative(ROOT, AUTH_STATE));
  await ctx.close();
}

// ---- capture -----------------------------------------------------------
async function main() {
  const browser = await chromium.launch({ headless: !headed && !forceLogin });

  if (forceLogin || !fs.existsSync(AUTH_STATE)) {
    await login(browser);
  }

  const ctx = await browser.newContext({
    storageState: fs.existsSync(AUTH_STATE) ? AUTH_STATE : undefined,
    viewport: { width: vw, height: vh },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();

  console.log('· capturing', url);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });

  // If we got bounced to sign-in, the session expired — re-login and retry once.
  if (/sign-in/.test(page.url())) {
    console.log('· bounced to sign-in — refreshing session');
    await page.close();
    await ctx.close();
    await login(browser);
    const ctx2 = await browser.newContext({ storageState: AUTH_STATE, viewport: { width: vw, height: vh }, deviceScaleFactor: 2 });
    const page2 = await ctx2.newPage();
    await page2.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    await finish(page2);
    await ctx2.close();
    await browser.close();
    return;
  }

  await finish(page);
  await ctx.close();
  await browser.close();
}

async function finish(page) {
  // Dismiss GoVocal's cookie-consent modal — it overlays every page.
  // (--keep-cookie leaves it up if you actually want to capture the consent UI.)
  if (!flag('keep-cookie')) {
    for (const label of ['Accept', 'Accept all', 'Allow all']) {
      const btn = page.getByRole('button', { name: label, exact: false }).first();
      if (await btn.isVisible().catch(() => false)) { await btn.click().catch(() => {}); break; }
    }
    await page.waitForTimeout(300);
  }
  if (waitSel) await page.waitForSelector(waitSel, { timeout: 15000 }).catch(() => console.warn('· --wait selector not found:', waitSel));
  if (clickSel) await page.click(clickSel, { timeout: 8000 }).catch(() => console.warn('· --click selector not found:', clickSel));
  await page.waitForTimeout(settle);

  const outDir = path.join(ROOT, 'govocal-exports', name);
  await fs.promises.mkdir(outDir, { recursive: true });

  await page.screenshot({ path: path.join(outDir, 'page.png'), fullPage: true });
  await page.screenshot({ path: path.join(outDir, 'viewport.png'), fullPage: false });

  const dom = await page.evaluate(() => document.documentElement.outerHTML);
  await fs.promises.writeFile(path.join(outDir, 'dom.html'), dom, 'utf8');

  // ── styles.json: always-on visual digest (+ optional targeted probe) ──────
  // digest = every DISTINCT visual treatment on the page (deduped by a style
  // signature, with a representative selector + occurrence count). This is the
  // exact-value source the build agent reads INSTEAD of eyeballing the PNG.
  // probed = your hand-picked selectors, kept as pinned checkpoints for verify.
  const selectors = probe ? (probe + '').split('|').map((s) => s.trim()).filter(Boolean) : [];
  const styles = await page.evaluate(
    ({ selectors, props }) => {
      const read = (el) => {
        const cs = getComputedStyle(el);
        const rec = { tag: el.tagName.toLowerCase(), class: el.className || null, text: (el.textContent || '').trim().slice(0, 60) };
        for (const p of props) rec[p] = cs.getPropertyValue(p);
        return rec;
      };

      // -- probed (targeted, backward-compatible) --
      const probed = {};
      for (const sel of selectors) {
        probed[sel] = Array.from(document.querySelectorAll(sel)).slice(0, 8).map(read);
      }

      // -- digest (auto, whole-page, deduped) --
      const SKIP = new Set(['SCRIPT', 'STYLE', 'META', 'LINK', 'HEAD', 'TITLE', 'PATH', 'G', 'SVG', 'DEFS', 'BR', 'NOSCRIPT']);
      const isTransparent = (c) => !c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)';
      const hasDirectText = (el) => Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
      const seen = new Map();
      for (const el of document.querySelectorAll('*')) {
        if (SKIP.has(el.tagName)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
        const hasBorder = cs.borderStyle !== 'none' && parseFloat(cs.borderWidth) > 0;
        const interesting =
          !isTransparent(cs.backgroundColor) || cs.backgroundImage !== 'none' ||
          hasBorder || cs.boxShadow !== 'none' || parseFloat(cs.borderRadius) > 0 ||
          hasDirectText(el);
        if (!interesting) continue;
        // signature = visual identity (not size/position/text) so look-alikes collapse
        const sig = JSON.stringify([
          el.tagName, cs.color, cs.backgroundColor, cs.backgroundImage, cs.border,
          cs.borderRadius, cs.boxShadow, cs.fontFamily, cs.fontSize, cs.fontWeight,
          cs.lineHeight, cs.textTransform, cs.padding, cs.display,
        ]);
        if (seen.has(sig)) { seen.get(sig).count++; continue; }
        const rec = read(el);
        const cls = (el.className || '').toString().trim().split(/\s+/).filter(Boolean).slice(0, 2);
        rec.selector = el.tagName.toLowerCase() + cls.map((c) => '.' + c).join('');
        rec.count = 1;
        seen.set(sig, rec);
      }
      const digest = Array.from(seen.values())
        .sort((a, b) => b.count - a.count || parseFloat(b['font-size']) - parseFloat(a['font-size']))
        .slice(0, 500);

      return { probed: selectors.length ? probed : null, digest };
    },
    { selectors, props: PROBE_PROPS }
  );
  await fs.promises.writeFile(path.join(outDir, 'styles.json'), JSON.stringify(styles, null, 2), 'utf8');
  console.log(`· styles.json → ${styles.digest.length} distinct treatments` + (probe ? `, ${selectors.length} probed selector(s)` : ''));

  const meta = {
    url,
    title: await page.title(),
    surface,
    viewport: { width: vw, height: vh },
    capturedAt: new Date().toISOString(),
  };
  await fs.promises.writeFile(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

  console.log(`\n✓ captured → ${path.relative(ROOT, outDir)}/  [${surface}]`);
  console.log('  page.png · viewport.png · dom.html · styles.json · meta.json');
}

main().catch((e) => {
  console.error('✗ capture failed:', e.message);
  process.exit(1);
});
