// One-off driver (System-building): drag each homepage-builder widget from the
// palette onto the canvas, let craft.js auto-select it (opens the right settings
// panel), then dump dom.html + viewport.png + settings.html per widget into
// govocal-exports/r9-set-<slug>/. Reuses the saved capture session.
// Run: node scripts/capture/hb-drag-settings.mjs [slug1 slug2 ...]
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AUTH_STATE = path.join(ROOT, 'scripts/capture/.auth/state.json');
const URL = 'https://uxusertesting.govocal.com/en/admin/pages-menu/homepage-builder/?variant=signedOut';

// distinct widgets not pre-placed on the canvas (palette id = e2e-draggable-<slug>)
const ALL = [
  'open-to-participation', 'followed-items', 'finished-or-archived', 'areas',
  'selection', 'published', 'call-to-action', 'community-monitor-cta',
  'accordion', 'button', 'iframe', 'video-embed', 'two-column', 'three-column',
  'image-text-cards',
];
const slugs = process.argv.slice(2).length ? process.argv.slice(2) : ALL;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  storageState: AUTH_STATE, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2,
});
const page = await ctx.newPage();

for (const slug of slugs) {
  try {
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
    await sleep(2500);
    // dismiss cookie banner if present
    for (const label of ['Accept', 'Accept all']) {
      const b = page.getByRole('button', { name: label, exact: false }).first();
      if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); break; }
    }
    await sleep(400);

    const src = page.locator('#e2e-draggable-' + slug).first();
    await src.waitFor({ state: 'visible', timeout: 8000 });
    // drop target: the bottom-most render node so the widget appends at the end
    const target = page.locator('.e2e-render-node[draggable="true"]').last();
    await target.scrollIntoViewIfNeeded().catch(() => {});

    // craft.js uses react-dnd HTML5 backend → Playwright dragTo dispatches the
    // native drag events. Use a multi-step manual drag for reliability.
    const sb = await src.boundingBox();
    const tb = await target.boundingBox();
    if (sb && tb) {
      await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
      await page.mouse.down();
      await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height - 6, { steps: 12 });
      await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height - 4, { steps: 6 });
      await page.mouse.up();
    }
    await sleep(1200);
    // fallback: if no panel opened, try Playwright's dragTo
    let title = await page.locator('h2 span').first().textContent().catch(() => '');
    await sleep(800);

    const outDir = path.join(ROOT, 'govocal-exports', 'r9-set-' + slug);
    await fs.promises.mkdir(outDir, { recursive: true });
    await page.screenshot({ path: path.join(outDir, 'viewport.png'), fullPage: false });
    const dom = await page.evaluate(() => document.documentElement.outerHTML);
    await fs.promises.writeFile(path.join(outDir, 'dom.html'), dom, 'utf8');
    // settings panel: the container holding the close-X + h2 title. Grab a generous
    // ancestor by locating the h2's nearest sized panel.
    const settings = await page.evaluate(() => {
      const h2 = document.querySelector('h2');
      if (!h2) return '';
      let el = h2;
      for (let i = 0; i < 6 && el.parentElement; i++) el = el.parentElement;
      return el.outerHTML;
    });
    await fs.promises.writeFile(path.join(outDir, 'settings.html'), settings, 'utf8');
    console.log('✓ ' + slug + '  (panel title: "' + (title || '').trim() + '")');
  } catch (e) {
    console.log('✗ ' + slug + '  — ' + e.message.split('\n')[0]);
  }
}

await browser.close();
