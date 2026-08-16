#!/usr/bin/env node
// shell-lint — a template-drift canary for deploy shells.
//
// health.yml asks "is what's LIVE what's in git?" for space content. This asks the
// same question one layer up: is what a shell is RUNNING what the engine's template
// says it should be running? Those workflows were hand-authored per shell for a long
// time, so they drift silently — a fix lands in templates/shell/ and the shells that
// already had a copy never take it, or a shell edits its own copy and the change is
// invisible to everyone else.
//
// Run it FROM A SHELL, where both halves are already on disk:
//
//   node engine/scripts/shell-lint.mjs
//
// The engine submodule is the shell's pinned engine, so the templates it compares
// against are the ones that shell is actually on — no fetching, no sha juggling.
//
//   --shell <path>      shell root (default: cwd)
//   --templates <path>  template dir (default: <engine>/templates/shell)
//   --strict            treat comment-only drift as failure too
//   --quiet             only print problems
//
// Exit 1 on logic drift (or any drift under --strict). Missing/extra workflows are
// reported but never fatal: which workflows a shell runs is that shell's call, and a
// private prototype-delete or reseed workflow has no template by design.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENGINE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const opt = (f, d) => { const i = argv.indexOf(f); return i > -1 && argv[i + 1] ? argv[i + 1] : d; };
const has = (f) => argv.includes(f);

const SHELL = path.resolve(opt("--shell", process.cwd()));
const TEMPLATES = path.resolve(opt("--templates", path.join(ENGINE, "templates", "shell")));
const STRICT = has("--strict");
const QUIET = has("--quiet");

const say = (s) => { if (!QUIET) console.log(s); };
const warn = (s) => console.log(s);

// A template line whose VALUE is meant to be replaced before first use. The convention
// across templates/shell is a `your-…` stand-in (your-site-origin.example,
// your-pages-project), sometimes with a `# ←` pointer at what to put there; `<angled>`
// is the older form. A shell that filled one of these in has done the right thing, so
// a difference on such a line is expected, not drift.
const isPlaceholder = (line) => /your-[a-z0-9-]+/i.test(line) || /#\s*←/.test(line) || /<[a-z][a-z0-9-]*>/i.test(line);

// Not every fill-in has a `your-…` stand-in: some are a real, working value that a
// shell is nonetheless expected to CHOOSE (engine-bump's TRACK is the case in point —
// `release` is a legitimate setting, and so is `main`). Those are marked the way the
// templates already mark them, with a `SET BEFORE USE` note in the comment block
// directly above. Walk up the contiguous comment run to find it.
function markedSetBeforeUse(lines, i) {
  for (let k = i - 1; k >= 0; k--) {
    const s = lines[k].trim();
    if (!s.startsWith("#")) return false; // left the comment block without finding it
    if (/SET BEFORE USE/i.test(s)) return true;
  }
  return false;
}

// Comments and blank lines carry no behaviour. A shell rewording a comment is worth
// seeing but is not the thing this canary exists to catch, so it is reported apart
// from logic drift unless --strict.
const isProse = (line) => { const s = line.trim(); return s === "" || s.startsWith("#"); };

// Longest common subsequence over lines — enough to align two versions of the same
// file so an inserted block does not report every following line as changed.
function align(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: "=", a: a[i], i, j }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: "-", a: a[i], i }); i++; }
    else { ops.push({ t: "+", b: b[j], j }); j++; }
  }
  while (i < n) ops.push({ t: "-", a: a[i], i: i++ });
  while (j < m) ops.push({ t: "+", b: b[j], j: j++ });
  return ops;
}

// A removed line immediately followed by an added line is one line REWRITTEN. That
// pairing is what lets a filled-in placeholder be recognised: the template side is the
// line with `your-…` in it, and the shell side is whatever replaced it.
const yamlKey = (line) => { const m = /^(\s*)([A-Za-z_][\w-]*):/.exec(line); return m ? `${m[1].length}:${m[2]}` : null; };

function compare(templateSrc, shellSrc) {
  const tLines = templateSrc.split("\n");
  const ops = align(tLines, shellSrc.split("\n"));

  // Pair each removal with the addition that REPLACED it, so a rewritten line reads as
  // one change rather than two. Adjacency catches most of it. Same-key pairing catches
  // the rest: when a shell also rewrites the comment block above a setting, the two
  // halves drift apart in the op stream, and `TRACK: release` → `TRACK: main` would
  // otherwise report as an unexplained insertion with nothing to compare it against.
  const dels = [], adds = [];
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (op.t === "-") dels.push({ ...op, adjacent: ops[k + 1] && ops[k + 1].t === "+" ? ops[k + 1] : null });
    else if (op.t === "+") adds.push(op);
  }
  const pairs = [], usedAdd = new Set(), usedDel = new Set();
  for (const d of dels) {
    // Adjacency alone is not enough to call two lines the same line rewritten: when a
    // shell expands the comment block above a setting, the template's last comment line
    // sits immediately before the shell's new SETTING, and pairing those two would both
    // mis-report the comment and starve the setting of its real counterpart. Only pair
    // adjacent lines that agree about being a keyed setting.
    if (!d.adjacent || usedAdd.has(d.adjacent.j)) continue;
    if (yamlKey(d.a) !== yamlKey(d.adjacent.b)) continue;
    pairs.push([d, d.adjacent]); usedAdd.add(d.adjacent.j); usedDel.add(d.i);
  }
  for (const d of dels) {
    if (usedDel.has(d.i)) continue;
    const key = yamlKey(d.a);
    if (!key) continue;
    const a = adds.find((x) => !usedAdd.has(x.j) && yamlKey(x.b) === key);
    if (a) { pairs.push([d, a]); usedAdd.add(a.j); usedDel.add(d.i); }
  }

  const out = [];
  for (const [d, a] of pairs) {
    if (isPlaceholder(d.a) || markedSetBeforeUse(tLines, d.i)) continue; // filled in / chosen, as intended
    out.push({ kind: isProse(d.a) && isProse(a.b) ? "prose" : "logic", line: d.i + 1, from: d.a, to: a.b });
  }
  for (const d of dels) if (!usedDel.has(d.i)) out.push({ kind: isProse(d.a) ? "prose" : "logic", line: d.i + 1, from: d.a, to: null });
  for (const a of adds) if (!usedAdd.has(a.j)) out.push({ kind: isProse(a.b) ? "prose" : "logic", line: a.j + 1, from: null, to: a.b });
  return out.sort((x, y) => x.line - y.line);
}

const wfDir = path.join(SHELL, ".github", "workflows");
if (!fs.existsSync(wfDir)) {
  console.error(`[shell-lint] no .github/workflows/ under ${SHELL} — is this a deploy shell? (pass --shell <path>)`);
  process.exit(1);
}
if (!fs.existsSync(TEMPLATES)) {
  console.error(`[shell-lint] no templates at ${TEMPLATES} — is the engine submodule checked out? (pass --templates <path>)`);
  process.exit(1);
}

const templates = fs.readdirSync(TEMPLATES).filter((f) => f.endsWith(".yml")).sort();
const installed = fs.readdirSync(wfDir).filter((f) => f.endsWith(".yml")).sort();

let logicDrift = 0, proseDrift = 0;
const missing = [], extra = [];

for (const f of templates) {
  if (!installed.includes(f)) { missing.push(f); continue; }
  const diffs = compare(
    fs.readFileSync(path.join(TEMPLATES, f), "utf8"),
    fs.readFileSync(path.join(wfDir, f), "utf8"),
  );
  const logic = diffs.filter((d) => d.kind === "logic");
  const prose = diffs.filter((d) => d.kind === "prose");
  logicDrift += logic.length;
  proseDrift += prose.length;
  if (!diffs.length) { say(`  ok       ${f}`); continue; }
  const bad = STRICT ? diffs : logic;
  warn(`  ${bad.length ? "DRIFT   " : "reworded"} ${f}  (${logic.length} logic, ${prose.length} prose)`);
  for (const d of bad.slice(0, 12)) {
    warn(`      line ${d.line}:`);
    if (d.from !== null) warn(`        template: ${d.from.trim().slice(0, 120)}`);
    if (d.to !== null) warn(`        shell:    ${d.to.trim().slice(0, 120)}`);
  }
  if (bad.length > 12) warn(`      … and ${bad.length - 12} more`);
}
for (const f of installed) if (!templates.includes(f)) extra.push(f);

say("");
if (missing.length) warn(`  not installed (this shell's call, not an error): ${missing.join(", ")}`);
if (extra.length) warn(`  no template (instance-specific, expected): ${extra.join(", ")}`);

const fatal = STRICT ? logicDrift + proseDrift : logicDrift;
if (fatal) {
  console.log("");
  console.error(`::error::shell-lint: ${fatal} line(s) diverge from the engine's templates — a fix in templates/shell/ has not reached this shell, or this shell edited its copy without sending it upstream.`);
  process.exit(1);
}
console.log(`shell-lint: clean — ${templates.length - missing.length} workflow(s) match their template${proseDrift ? ` (${proseDrift} comment line(s) reworded; --strict to fail on those)` : ""}.`);
