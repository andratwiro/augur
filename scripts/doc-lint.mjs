#!/usr/bin/env node
// doc-lint — a doc-drift canary. Checks that .md files still tell the truth:
//   a. backtick-quoted relative file paths exist on disk
//   b. every `npm run <script>` mentioned exists in package.json
//   c. relative markdown links (and #anchors) resolve
// Usage: node scripts/doc-lint.mjs [--repo <path>]... [--quiet]
// No config, no dependencies. Exit 1 on any failure.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The canary guards the AGENT-CONTEXT layer (root docs, skills/<x>-ui/, agents/) — not
// scratch, archives, extracted research, prototype build notes, or source-embedded
// build notes, which carry their own noisy cross-refs (placeholder paths, throwaway
// links) and would swamp the signal. Recursion reaches the two-deep context docs
// (skills/<x>-ui/SKILL.md) while these trees stay out.
const SKIP_DIRS = new Set([
  "node_modules", "dist", ".git", "spaces",
  "playground", "prototypes", "docs", "references", "research", "context",
  "src", "tracks", "toolkit", "img", "webapp-testing", "_extracted", "_archive",
]);
const skipDir = (name) => SKIP_DIRS.has(name) || /-exports$/.test(name); // *-exports: local capture bundles
const args = process.argv.slice(2);
const quiet = args.includes("--quiet");
const repos = [];
for (let i = 0; i < args.length; i++) if (args[i] === "--repo" && args[i + 1]) repos.push(path.resolve(args[++i]));
if (!repos.length) repos.push(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const failures = [];
const fail = (file, line, kind, ref) => failures.push(`${file}:${line}: ${kind}: ${ref}`);

// GitHub heading slug: lowercase, strip punctuation, spaces → dashes.
const slug = (s) =>
  s.toLowerCase().trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/g, "-");

function headingsOf(file) {
  const out = new Set();
  const counts = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    let s = slug(m[1].replace(/`/g, ""));
    if (counts[s] != null) s = `${s}-${++counts[s]}`;
    else counts[s] = 0;
    out.add(s);
  }
  return out;
}

// Recurse the whole tree (skipping SKIP_DIRS, dotdirs, *-exports): the most-read docs
// live two levels down (e.g. skills/<x>-ui/SKILL.md) and a one-level scan never saw them.
function mdFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!skipDir(e.name) && !e.name.startsWith(".")) walk(path.join(dir, e.name));
      } else if (e.isFile() && e.name.endsWith(".md")) {
        out.push(path.join(dir, e.name));
      }
    }
  };
  walk(root);
  return out;
}

// A backtick span counts as a checkable file path only if it is plausibly one:
// has a slash, no placeholder/URL/flag/code characters, path-ish charset only.
function checkablePath(s) {
  if (/[<>*{}()$"'`=,;!?]|\s/.test(s)) return false;            // placeholders, code, prose
  if (/^(https?:|#|--|\/)/.test(s)) return false;               // URLs, anchors, flags, site routes
  // NB: `../` refs ARE checked — a space kernel points at `../augur/agents/*.md` (the
  // engine sibling, present locally and cloned next to the checkout in CI), so a renamed
  // engine doc must fail here. resolves() joins them against the .md's own dir.
  if (!s.includes("/")) return false;                           // bare names: not checkable in general
  if (/[:@]/.test(s)) return false;                             // scoped pkgs, remotes, key:value
  return /^[\w.-]+(\/[\w.-]+)+\/?$/.test(s);
}

function resolves(ref, repo, mdDir) {
  const clean = ref.replace(/\/$/, "");
  // Only judge paths whose first segment is a real dir here — anything else is
  // prose alternation ("upsert/del/rename") or a path rooted in another repo.
  const seg0 = clean.split("/")[0];
  if (!fs.existsSync(path.join(repo, seg0)) && !fs.existsSync(path.join(mdDir, seg0))) return true;
  if (fs.existsSync(path.join(repo, clean)) || fs.existsSync(path.join(mdDir, clean))) return true;
  // Gitignored paths (local-only by design, absent in a fresh clone) are not drift.
  return [repo, mdDir].some(
    (base) => spawnSync("git", ["check-ignore", "-q", path.join(base, clean)], { cwd: repo }).status === 0
  );
}

for (const repo of repos) {
  let scripts = {};
  try { scripts = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).scripts || {}; } catch {}

  for (const file of mdFiles(repo)) {
    const rel = path.relative(process.cwd(), file);
    const mdDir = path.dirname(file);
    const lines = fs.readFileSync(file, "utf8").split("\n");
    let inFence = false;

    lines.forEach((line, i) => {
      const no = i + 1;
      if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return; }

      // a. backtick-quoted file paths (inline code only — fenced blocks are examples)
      if (!inFence) {
        for (const m of line.matchAll(/`([^`]+)`/g)) {
          const ref = m[1];
          if (checkablePath(ref) && !resolves(ref, repo, mdDir)) fail(rel, no, "path", ref);
        }
      }

      // b. npm run <script> — checked everywhere, fences included (recipes must work)
      for (const m of line.matchAll(/npm (?:--prefix \S+ )?run (?:-s )?([\w:.-]+)/g)) {
        if (/--prefix/.test(m[0]) && !m[0].includes(`--prefix ${path.basename(repo)} `)) continue; // other repo's scripts
        if (!(m[1] in scripts)) fail(rel, no, "npm-script", m[1]);
      }

      // c. markdown links to relative files / anchors
      if (inFence) return;
      for (const m of line.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
        const target = m[1];
        if (/^(https?:|mailto:|\/)/.test(target)) continue;
        const [fp, anchor] = target.split("#");
        const dest = fp ? (fs.existsSync(path.join(mdDir, fp)) ? path.join(mdDir, fp)
                        : fs.existsSync(path.join(repo, fp)) ? path.join(repo, fp) : null)
                        : file; // pure #anchor → this file
        if (!dest) { fail(rel, no, "link", target); continue; }
        if (anchor && dest.endsWith(".md") && !headingsOf(dest).has(anchor.toLowerCase()))
          fail(rel, no, "anchor", target);
      }
    });
  }
}

for (const f of failures) console.log(f);
if (!failures.length && !quiet) console.log(`doc-lint: OK (${repos.length} repo${repos.length > 1 ? "s" : ""})`);
process.exit(failures.length ? 1 : 0);
