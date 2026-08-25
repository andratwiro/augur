#!/usr/bin/env node
// one-tenant-resolver — the seam stays a seam.
//
// WHY. `resolveTenant(request, env)` is the single place that decides which workspace a
// request belongs to. Its value is that it is SINGLE: today it answers statically, and
// swapping in a Host-header resolver is then a body change with nothing else to find.
// The way that value is lost is not a red test — it is one more `await resolveTenant(…)`
// added somewhere convenient, which in a single-workspace deployment returns the same
// answer as the first one and is therefore invisible to every other check. A second call
// site is also a second place to forget, and two callers with different answers is the
// bug the whole phase exists to remove.
//
// WHAT IS ENFORCED.
//
//   ONE DECLARATION, with the pinned signature `async function resolveTenant(request, env)`.
//   The signature is the contract the next implementation has to honour: a resolver that
//   quietly grows a third parameter is a resolver its callers have to know something extra
//   about.
//
//   ONE CALL SITE, and it is inside the worker's `fetch()`, BEFORE the config load. After
//   the load is too late — the config would have been read for whichever workspace the
//   isolate happened to look at last, which is the failure being designed out.
//
// Comments do not count as calls: the header above names the function repeatedly, and so
// does the worker's own. Lines whose first non-space character starts a comment are
// skipped, which is enough here because the worker writes no code after a `//` on the
// same line and its embedded client scripts are all indented inside template literals.
//
// Usage: node scripts/one-tenant-resolver.mjs [--worker <path>] [--quiet]
// No config, no dependencies. Exit 1 on any failure.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DECLARATION = /^async function resolveTenant\(request, env\)\s*\{/;
const CALL = /\bresolveTenant\s*\(/;
const FETCH_OPEN = /^\s*async fetch\(request, env, ctx\)\s*\{/;
const LOAD_CONFIG = /\bloadConfig\s*\(/;

const isComment = (line) => {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
};

// Returns every problem found, each as `{ kind, line, message }`. An empty list passes.
export function checkTenantResolver(source) {
  const lines = source.split("\n");
  const problems = [];
  const at = (re, from = 0) => {
    for (let i = from; i < lines.length; i++) if (!isComment(lines[i]) && re.test(lines[i])) return i;
    return -1;
  };

  const declared = [];
  const calls = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isComment(line)) continue;
    if (DECLARATION.test(line)) { declared.push(i + 1); continue; }
    if (/^\s*(async\s+)?function resolveTenant\b/.test(line) || /^\s*(const|let|var)\s+resolveTenant\b/.test(line)) {
      problems.push({
        kind: "signature", line: i + 1,
        message: "resolveTenant is declared with a different shape — the pinned contract is " +
          "`async function resolveTenant(request, env)` at module scope",
      });
      continue;
    }
    if (CALL.test(line)) calls.push(i + 1);
  }

  if (declared.length !== 1) {
    problems.push({
      kind: "declaration", line: declared[1] || 0,
      message: `expected exactly 1 declaration of resolveTenant, found ${declared.length}`,
    });
  }

  if (calls.length !== 1) {
    problems.push({
      kind: "call-sites", line: calls[1] || 0,
      message: `expected exactly 1 call site, found ${calls.length}` +
        (calls.length ? ` (lines ${calls.join(", ")})` : "") +
        " — the seam's whole value is that there is one place to change",
    });
  }

  const fetchOpen = at(FETCH_OPEN);
  if (fetchOpen < 0) {
    problems.push({
      kind: "fetch", line: 0,
      message: "could not find `async fetch(request, env, ctx) {` — this checker is reading the wrong file, " +
        "or the worker's entry point was renamed and this check needs updating with it",
    });
  } else if (calls.length === 1) {
    const call = calls[0];
    const loadConfig = at(LOAD_CONFIG, fetchOpen) + 1;
    if (call <= fetchOpen) {
      problems.push({
        kind: "placement", line: call,
        message: `the call site is at line ${call}, outside fetch() (which opens at ${fetchOpen + 1}) — ` +
          "the tenant is a property of the request and must be resolved where the request arrives",
      });
    } else if (loadConfig > 0 && call > loadConfig) {
      problems.push({
        kind: "placement", line: call,
        message: `the call site (line ${call}) comes AFTER the config load (line ${loadConfig}) — ` +
          "config must be loaded FOR a tenant, so the tenant has to be known first",
      });
    }
  }

  return { declared, calls, problems };
}

// ---- CLI ----------------------------------------------------------------------------

function main(argv) {
  const opt = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i > -1 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const quiet = argv.includes("--quiet");
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const worker = path.resolve(opt("--worker", path.join(root, "src", "_worker.js")));

  const from = path.relative(process.cwd(), worker);
  const rel = !from || from.startsWith("..") ? worker : from;
  const { calls, problems } = checkTenantResolver(fs.readFileSync(worker, "utf8"));

  if (problems.length) {
    for (const p of problems) {
      const where = p.line ? `${rel}:${p.line}` : rel;
      console.error(`${where}: resolveTenant: ${p.message}`);
    }
    console.error(`\n${problems.length} problem(s) — see the header of scripts/one-tenant-resolver.mjs`);
    return 1;
  }

  if (!quiet) console.log(`${rel}: resolveTenant declared once, called once (line ${calls[0]}), before the config load`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
