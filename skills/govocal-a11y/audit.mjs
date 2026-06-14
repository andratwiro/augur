#!/usr/bin/env node
/**
 * audit.mjs — run axe-core (WCAG 2.2 AA) against prototypes in headless Chromium.
 *
 * Usage:
 *   node skills/govocal-a11y/audit.mjs                 # audit every prototype
 *   node skills/govocal-a11y/audit.mjs <path>          # audit one prototype dir or .html file
 *   npm run audit -- <path>
 *
 * NON-BLOCKING by design: always exits 0 (pass `--strict` to exit 1 on violations).
 * These are design prototypes — the goal is awareness. Read the report, fix or flag.
 *
 * Requires devDependencies: playwright, @axe-core/playwright
 * First run also needs the browser: npx playwright install chromium
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// WCAG 2.0/2.1/2.2 — Level A + AA. This is the bar the real GoVocal platform meets.
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

// These are DESIGN prototypes — visual guidance, not the shipping implementation.
// By default we report only the rules a mockup is actually responsible for: the
// perceivable / visual decisions (contrast, use of color, zoom, target size).
// Deeper code issues (keyboard operation, ARIA, semantics, focus management) are
// the dev team's job on the real GoVocal codebase. Pass --all to run the full
// WCAG 2.2 AA audit (use that when handing a prototype off to engineering).
const DESIGN_RULES = new Set([
  "color-contrast",       // 1.4.3 text contrast — the one we can't afford to fail
  "link-in-text-block",   // 1.4.1 links distinguishable by more than color
  "meta-viewport",        // 1.4.4 don't disable pinch-zoom
  "meta-viewport-large",  // best practice — allow zoom to 500%
  "target-size",          // 2.5.8 pointer targets ≥ 24×24px (a layout decision)
]);

const STRICT = process.argv.includes("--strict");
const ALL = process.argv.includes("--all");
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));

const C = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

/** Find the entry .html for a prototype dir (prefer index.html). */
async function entryFile(dir) {
  if (await exists(path.join(dir, "index.html"))) return path.join(dir, "index.html");
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const html = entries.find((e) => e.isFile() && e.name.endsWith(".html"));
  return html ? path.join(dir, html.name) : null;
}

/** Discover every prototype's entry HTML across all opportunities. */
async function discoverAll() {
  const out = [];
  const tops = await fs.readdir(ROOT, { withFileTypes: true });
  for (const top of tops) {
    if (!top.isDirectory() || top.name.startsWith(".")) continue;
    const protoParent = path.join(ROOT, top.name, "prototypes");
    if (!(await exists(protoParent))) continue;
    const protos = await fs.readdir(protoParent, { withFileTypes: true });
    for (const p of protos) {
      if (!p.isDirectory()) continue;
      const file = await entryFile(path.join(protoParent, p.name));
      if (file) out.push(file);
    }
  }
  return out;
}

/** Resolve CLI arg → list of entry HTML files. */
async function resolveTargets() {
  if (args.length === 0) return discoverAll();
  const targets = [];
  for (const a of args) {
    const abs = path.resolve(a);
    if (!(await exists(abs))) {
      console.error(C.red(`Not found: ${a}`));
      continue;
    }
    const stat = await fs.stat(abs);
    if (stat.isDirectory()) {
      const file = await entryFile(abs);
      if (file) targets.push(file);
      else console.error(C.yellow(`No .html in ${a}`));
    } else {
      targets.push(abs);
    }
  }
  return targets;
}

function rel(p) {
  return path.relative(ROOT, p);
}

async function auditFile(browser, file) {
  // axe-core/playwright requires a page from its own context (not a shared page).
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(pathToFileURL(file).href, { waitUntil: "load" });
    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    return ALL
      ? results.violations
      : results.violations.filter((v) => DESIGN_RULES.has(v.id));
  } finally {
    await context.close();
  }
}

function printViolations(file, violations) {
  if (violations.length === 0) {
    console.log(`${C.green("✓ PASS")}  ${rel(file)}  ${C.dim("(no axe violations)")}`);
    return;
  }
  const total = violations.reduce((n, v) => n + v.nodes.length, 0);
  console.log(`${C.red("✗ FAIL")}  ${C.bold(rel(file))}  ${C.red(`${violations.length} rule(s), ${total} element(s)`)}`);
  for (const v of violations) {
    const impact = (v.impact || "n/a").toUpperCase();
    console.log(`  ${C.yellow("•")} ${C.bold(v.id)} ${C.dim(`[${impact}]`)} — ${v.help}`);
    console.log(`    ${C.dim(v.helpUrl)}`);
    for (const node of v.nodes.slice(0, 5)) {
      const sel = Array.isArray(node.target) ? node.target.join(" ") : String(node.target);
      console.log(`      ${C.dim("↳")} ${sel}`);
      const msg = (node.failureSummary || "").split("\n").filter(Boolean).slice(1, 2).join(" ");
      if (msg) console.log(`        ${C.dim(msg.trim())}`);
    }
    if (v.nodes.length > 5) console.log(`      ${C.dim(`…and ${v.nodes.length - 5} more element(s)`)}`);
  }
}

async function main() {
  const targets = await resolveTargets();
  if (targets.length === 0) {
    console.log(C.yellow("No prototypes found to audit."));
    return;
  }

  console.log(
    C.dim(
      `axe-core · ${ALL ? "WCAG 2.2 AA (full — dev handoff)" : "design-level checks (contrast, color, zoom, target size)"} · ${targets.length} prototype(s)\n`
    )
  );

  const browser = await chromium.launch();
  let failed = 0;

  for (const file of targets) {
    try {
      const violations = await auditFile(browser, file);
      printViolations(file, violations);
      if (violations.length) failed++;
    } catch (err) {
      console.log(`${C.red("! ERROR")} ${rel(file)} — ${err.message}`);
      failed++;
    }
  }

  await browser.close();

  const tail = ALL
    ? "(Full WCAG 2.2 AA. axe catches ~30–50% — devs still do a manual keyboard/SR pass.)"
    : "(Design-level only. Deeper keyboard/ARIA/semantics are the dev team's job — run with --all for the full audit.)";
  console.log(
    `\n${failed === 0 ? C.green("All prototypes pass.") : C.red(`${failed} prototype(s) with violations.`)} ${C.dim(tail)}`
  );

  if (STRICT && failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(STRICT ? 1 : 0);
});
