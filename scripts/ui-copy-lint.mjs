#!/usr/bin/env node
/**
 * ui-copy-lint — the empty states are a ghost and ONE short line, in a human voice.
 *
 * WHY THIS EXISTS. Nothing in this repo has ever constrained the text of an empty state:
 * no test, no script, no build assertion. Every commit that ever touched `emptyState` is
 * build.js-only, including 607c3db6, which fixed a first sentence that described a page
 * that does not exist. That bug was found by a person opening the page in a browser, and
 * the fix left behind no mechanism that would find the next one. Meanwhile the copy grew:
 * eight surfaces, two paragraphs each, a mean sentence of 49.8 words, and two of them
 * naming another company's product. The instruction that reset it was
 * "novels full of claudisms (em dashes, expressions, terrible)".
 *
 * WHAT IT CAN AND CANNOT DO. It cannot tell whether a sentence is TRUE — the false first
 * sentence would have passed every rule below — and it cannot tell whether writing is
 * good. It catches the specific tics that produced the last one, and the structural rule
 * that keeps a surface from growing back into a novel: one paragraph, twenty words.
 * Truth is still a review question, and the Tokens renderer carries a comment saying so
 * for the three readers who land on its empty branch.
 *
 * WHAT IT READS. The `emptyState(...)` call sites and the `addHint:` strings in build.js.
 * Those are a small, findable, closed set, and they are the copy a person meets on a
 * blank workspace.
 *
 * Run: node scripts/ui-copy-lint.mjs [ROOT]   (exit 1 on any finding)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.argv[2] || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = path.join(ROOT, "build.js");

const MAX_WORDS = 20;      // Rob's own median sentence is 11 words; 20 is the ceiling, not the target.
const MAX_PARAS = 1;       // The ghost does the explaining. A second paragraph is the novel growing back.
const MAX_HINT_WORDS = 34; // A populated tab's caption may say a little more; it is read beside content.

/** Pull the template literals passed to each `emptyState(` call, with their line numbers. */
function emptyStateCalls(src) {
  const out = [];
  const NEEDLE = "emptyState(";
  for (let i = src.indexOf(NEEDLE); i !== -1; i = src.indexOf(NEEDLE, i + 1)) {
    // Skip a mention inside a comment or a name like `renderEmptyState(`.
    const prev = src[i - 1];
    if (prev && /[A-Za-z0-9_$]/.test(prev)) continue;
    let d = 1, j = i + NEEDLE.length;
    const paras = [];
    while (j < src.length && d > 0) {
      const c = src[j];
      if (c === "(") d++;
      else if (c === ")") d--;
      else if (c === "`" && d === 1) {
        // Read to the closing backtick, honouring escapes and ${...} spans.
        let k = j + 1, lit = "";
        while (k < src.length) {
          if (src[k] === "\\") { lit += src[k + 1]; k += 2; continue; }
          if (src[k] === "`") break;
          if (src[k] === "$" && src[k + 1] === "{") {
            let dd = 1; k += 2;
            while (k < src.length && dd > 0) { if (src[k] === "{") dd++; else if (src[k] === "}") dd--; k++; }
            lit += "X"; // an interpolation stands in as one word
            continue;
          }
          lit += src[k]; k++;
        }
        paras.push(lit);
        j = k;
      }
      j++;
    }
    out.push({ line: src.slice(0, i).split("\n").length, paras });
  }
  return out;
}

/** `addHint: "..."` — the caption on a POPULATED tier. */
function addHints(src) {
  const out = [];
  const re = /addHint:\s*"((?:[^"\\]|\\.)*)"/g;
  for (const m of src.matchAll(re)) {
    out.push({ line: src.slice(0, m.index).split("\n").length, text: m[1].replace(/\\"/g, '"') });
  }
  return out;
}

const stripTags = (s) => s.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
const words = (s) => stripTags(s).split(/\s+/).filter(Boolean).length;

// The tics, each one quoted from the copy this replaced.
const TICS = [
  [/[—–]/, "an em or en dash. Rob has banned these three times; use a comma or a full stop."],
  [/;/, "a semicolon. It is the pivot the agent voice leans on and it appears once per 3,000 words in Rob's own writing."],
  [/\bthe honest way\b/i, '"the honest way" — an epistemic flourish, not information.'],
  [/\bwhich is the point\b/i, '"which is the point" — a closing clause that re-states the opening.'],
  [/\bworth having\b/i, '"worth having".'],
  [/\breads? as\b/i, '"reads as" — the house way of describing an impression. Say what it IS.'],
  [/\bnot\s+[a-z][\w' ]{0,28},\s*(?:but|it is|these are|they are)\b/i, 'the "not X, it is Y" antithesis. Define positively.'],
  [/<em>/i, "an <em>. That styling exists to make a quoted agent prompt liftable, and pasteable prompts are out."],
  [/agents\/[\w-]+\.md|registry\.json|space\.json|component-meta\.json|skill\.json/, "a filename. This copy is for a person instructing an agent, and an agent finds the contract by reading the repo."],
  [/&ldquo;|&rdquo;|“|”/, "a quoted incantation. No pasteable agent prompts in the UI."],
];

const findings = [];
const push = (line, what, detail, text) => findings.push({ line, what, detail, text });

const src = fs.readFileSync(BUILD, "utf8");

for (const call of emptyStateCalls(src)) {
  if (call.paras.length > MAX_PARAS) {
    push(call.line, "too many paragraphs",
      `${call.paras.length} paragraphs; an empty state is ${MAX_PARAS}. The ghost above it is the explanation.`,
      stripTags(call.paras[0]).slice(0, 80));
  }
  for (const p of call.paras) {
    const n = words(p);
    if (n > MAX_WORDS) push(call.line, "too long", `${n} words; the ceiling is ${MAX_WORDS}.`, stripTags(p).slice(0, 120));
    for (const [re, why] of TICS) if (re.test(p)) push(call.line, "claudism", why, stripTags(p).slice(0, 120));
  }
}

for (const h of addHints(src)) {
  const n = words(h.text);
  if (n > MAX_HINT_WORDS) push(h.line, "hint too long", `${n} words; the ceiling is ${MAX_HINT_WORDS}.`, stripTags(h.text).slice(0, 120));
  for (const [re, why] of TICS) {
    if (re.source.includes("em>") || re.source.includes("ldquo")) continue; // a hint carries no prompt
    if (re.test(h.text)) push(h.line, "claudism", why, stripTags(h.text).slice(0, 120));
  }
}

// A guard that finds nothing because it LOOKED at nothing is the failure mode this whole
// file exists to prevent, so say what was read and refuse to pass on an empty scan.
const scanned = emptyStateCalls(src).length;
if (!scanned) {
  console.log("ui-copy-lint: FAILED — found no emptyState() call sites in build.js. The extractor is broken, not the copy.");
  process.exit(1);
}

if (!findings.length) {
  console.log(`ui-copy-lint: OK — ${scanned} empty state(s) and ${addHints(src).length} tier hint(s) read, all within one paragraph and ${MAX_WORDS} words`);
  process.exit(0);
}
for (const f of findings) {
  console.log(`build.js:${f.line}  [${f.what}]`);
  console.log(`    ${f.detail}`);
  console.log(`    ${f.text}`);
}
console.log(`\n${findings.length} finding(s) across ${scanned} empty state(s).`);
console.log("This guard cannot tell whether a sentence is TRUE — the false first sentence that shipped here would have passed every rule above. That is still a review question.");
process.exit(1);
