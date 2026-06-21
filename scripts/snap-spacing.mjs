#!/usr/bin/env node
// Augur snapper: align off-grid SPACING literals in canonical CSS to the space scale —
// the 8-point grid with a 4-point half-step, so on-grid = any MULTIPLE OF 4. Scope is
// deliberately tight to avoid layout breakage:
//   • only spacing props: margin/padding/gap/row-gap/column-gap (+ their longhands).
//     NOT inset/top/right/bottom/left (positioning) or width/height (dimension).
//   • only positive px ≥4. Negatives (overlap nudges) and 1-2px hairlines are skipped.
//   • snap to nearest multiple of 4, ties → up.   --apply to write; default = dry run.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const onGrid = (v) => v % 4 === 0;
export const snapVal = (v) => Math.floor(v / 4 + 0.5) * 4; // nearest multiple of 4, ties up
const SPACING_PROP = /^(margin|padding|gap|row-gap|column-gap)(-(top|right|bottom|left|block|inline)(-(start|end))?)?$/;
const FILES = ['govocal-primitives.css', 'govocal-ui.css', 'govocal-bo.css', 'govocal-survey.css', 'govocal-widgets.css'];
const apply = process.argv.includes('--apply');
let grand = 0;
for (const f of FILES) {
  const p = path.join(ROOT, 'skills/govocal-ui', f);
  if (!fs.existsSync(p)) continue;
  let css = fs.readFileSync(p, 'utf8');
  const changes = [];
  // operate on declarations OUTSIDE comments: split out comments, process the rest.
  css = css.replace(/([\w-]+)\s*:\s*([^;{}]*?)\s*(;|(?=}))/g, (full, prop, val, end, off) => {
    // skip if inside a comment
    const before = css.slice(0, off);
    const lastOpen = before.lastIndexOf('/*'), lastClose = before.lastIndexOf('*/');
    if (lastOpen > lastClose) return full;
    if (!SPACING_PROP.test(prop.toLowerCase())) return full;
    if (/var\(|calc\(|clamp\(/.test(val)) return full; // leave token/calc-bearing values
    const nv = val.replace(/(-?\d*\.?\d+)px/g, (tok, num) => {
      const v = parseFloat(num);
      if (v < 4 || onGrid(v)) return tok;                     // hairline/0 or already on-grid
      if (!Number.isInteger(v)) return tok;                   // leave fractional
      const s = snapVal(v);
      changes.push(`${prop}: ${v}px → ${s}px`);
      return s + 'px';
    });
    return prop + (full.includes(': ') ? ': ' : ':') + nv + end;
  });
  if (changes.length) {
    grand += changes.length;
    const tally = {}; changes.forEach(c => tally[c] = (tally[c] || 0) + 1);
    console.log(`\n${f}: ${changes.length} snap(s)`);
    Object.entries(tally).sort((a,b)=>b[1]-a[1]).forEach(([c,n]) => console.log(`   ${c}${n>1?`  (×${n})`:''}`));
    if (apply) fs.writeFileSync(p, css);
  }
}
console.log(`\n${apply ? 'APPLIED' : 'DRY RUN'} — ${grand} total spacing snap(s).`);
