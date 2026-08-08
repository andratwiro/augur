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

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "spaces"]);
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

function mdFiles(root) {
  const out = [];
  const grab = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }))
      if (e.isFile() && e.name.endsWith(".md")) out.push(path.join(dir, e.name));
  };
  grab(root);
  for (const e of fs.readdirSync(root, { withFileTypes: true }))
    if (e.isDirectory() && !skipDir(e.name) && !e.name.startsWith(".")) grab(path.join(root, e.name));
  return out;
}

// A backtick span counts as a checkable file path only if it is plausibly one:
// has a slash, no placeholder/URL/flag/code characters, path-ish charset only.
function checkablePath(s) {
  if (/[<>*{}()$"'`=,;!?]|\s/.test(s)) return false;            // placeholders, code, prose
  if (/^(https?:|#|--|\/|\.\.)/.test(s)) return false;          // URLs, anchors, flags, site routes, out-of-repo
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
