#!/usr/bin/env node
/* link-prototypes.mjs — Augur Phase 4 migration: make prototypes LINKED by default.
 *
 *   node scripts/link-prototypes.mjs [--dry-run] [<prototype-slug> …]
 *
 * Today a prototype is born DETACHED: it copies canonical govocal-*.css/js into its
 * own folder (assets/ or root) and links the copy. Those copies drift — they predate
 * the Phase-0 token correction. This flips the default to LINKED: every canonical
 * asset reference is repointed to ../../../skills/govocal-ui/<asset> (resolves on
 * file:// at a prototype's depth-3, and build.js repoints it for /dist), and the local
 * copies are deleted. The corrected canonical now flows in — accept the visual shift
 * (spec: "better, not different"). Re-shoot posters after.
 *
 * SAFE because the drift is value-correction, not prototype-specific additions
 * (verified: ~0 local-only selectors). NON-canonical local assets (pp-page.css,
 * sidebar.css, rail-explorer.js, …) and asset DIRS (img/, avatars/) are left alone.
 * Idempotent: a ref already pointing at ../…/skills/govocal-ui/ is untouched.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(ROOT, 'skills', 'govocal-ui');
const CANON = new Set(fs.readdirSync(UI).filter((f) => /^govocal-.*\.(css|js|svg)$/.test(f)));
const DRY = process.argv.includes('--dry-run');
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));

// discover every <opportunity>/prototypes/<name>/ (skip worktrees/node_modules)
function prototypes() {
  const out = [];
  for (const opp of fs.readdirSync(ROOT)) {
    if (opp.startsWith('.') || opp === 'node_modules') continue;
    const pdir = path.join(ROOT, opp, 'prototypes');
    if (!fs.existsSync(pdir) || !fs.statSync(pdir).isDirectory()) continue;
    for (const name of fs.readdirSync(pdir)) {
      const d = path.join(pdir, name);
      if (fs.statSync(d).isDirectory() && (!only.length || only.includes(name))) out.push(d);
    }
  }
  return out;
}

// canonical ref → depth-3 prototype-relative canonical path. Matches href/src to a
// canonical govocal-* asset whether referenced bare, ./, assets/, or any ../ prefix
// that is NOT already the skills/govocal-ui canonical path.
const REL = '../../../skills/govocal-ui/';
function relink(html) {
  let n = 0;
  const out = html.replace(/((?:href|src)\s*=\s*)(["'])([^"']+?)\2/gi, (full, pre, q, url) => {
    if (/skills\/govocal-ui\//.test(url)) return full;            // already linked
    const base = url.split('/').pop();
    if (!CANON.has(base)) return full;                            // not a canonical asset
    n++;
    return `${pre}${q}${REL}${base}${q}`;
  });
  return { out, n };
}

let totalRefs = 0, totalFiles = 0, touched = 0;
for (const dir of prototypes()) {
  const rel = path.relative(ROOT, dir);
  let refs = 0;
  const pages = fs.readdirSync(dir).filter((f) => f.endsWith('.html'));
  for (const page of pages) {
    const p = path.join(dir, page);
    const html = fs.readFileSync(p, 'utf8');
    const { out, n } = relink(html);
    if (n && !DRY) fs.writeFileSync(p, out, 'utf8');
    refs += n;
  }
  // delete local canonical copies (root + assets/), keep dirs + non-canonical files
  const deleted = [];
  for (const loc of [dir, path.join(dir, 'assets')]) {
    if (!fs.existsSync(loc)) continue;
    for (const f of fs.readdirSync(loc)) {
      if (CANON.has(f) && fs.statSync(path.join(loc, f)).isFile()) {
        deleted.push(path.relative(dir, path.join(loc, f)));
        if (!DRY) fs.rmSync(path.join(loc, f));
      }
    }
  }
  if (refs || deleted.length) {
    touched++;
    totalRefs += refs; totalFiles += deleted.length;
    console.log(`${DRY ? '[dry] ' : ''}${rel}`);
    console.log(`   refs relinked: ${refs} across ${pages.length} page(s)`);
    if (deleted.length) console.log(`   copies deleted: ${deleted.join(', ')}`);
  }
}
console.log(`\n${DRY ? '[dry-run] ' : ''}${touched} prototype(s) · ${totalRefs} refs relinked · ${totalFiles} local copies removed`);
