// Graduation — take ONE prototype out, standing on its own, with nothing of this
// engine left in it.
//
// `F-graduate-path`. `augur clone` already turns a whole workspace back into an editable
// tree, and `augur migrate` already moves a whole workspace between instances. Neither is
// the thing observed usage asks for: a single tool inside a research workspace acquires a
// stable audience that is not the team, and then it needs to LEAVE — one artifact, not the
// workspace around it. Without a doorway it stays, and the research workspace quietly
// becomes a production host for somebody's customer-facing tool.
//
// So this is a doorway, not a policy. Everything here answers one question: what does a
// person need so that the folder they end up with can be served by anything, from anywhere,
// forever, with this engine deleted?
//
// THREE THINGS HAVE TO HAPPEN, and only the first is obvious.
//
//   1. RE-ROOT. A prototype lives at `<project>/prototypes/<name>/` in a repo and at
//      `/<project>/<name>/` on the site. Standalone it lives at `/`. Its files move up,
//      and the `../../../skills/<ds>/` references its author wrote have to move with them.
//      `stripBuildDecorations` already reverses that depth rewrite exactly (it is the peel
//      the adopt path uses), so re-rooting is that same peel with the new relative dir.
//
//   2. BRING THE DESIGN SYSTEM. A prototype is self-contained HTML except for the one
//      thing it deliberately shares: the workspace's UI skill. Left behind, the graduated
//      copy is an unstyled page. So the skill folders the prototype REFERENCES come too —
//      whole folders, not the files a scan happened to see, because a stylesheet reaches
//      its own fonts and a component script reaches its own assets by paths no reference
//      scan will find.
//
//   3. PROVE IT. "No Augur dependency" is not a claim to make by reading the diff. Every
//      written file is scanned afterwards: an injected-chrome marker, an engine `/__…`
//      route or a page global is FATAL (the peel failed, and the copy would call home from
//      somebody else's domain); a reference that resolves to nothing in the folder is a
//      warning with the file and the line, because off its old origin it is a 404 that the
//      original site quietly answered.
//
// Pure functions only — the fetching and the writing live in the command. That split is
// what lets the whole decision be tested against a real built manifest instead of mocked.

import path from "node:path";
import { stripBuildDecorations } from "./publish-conflict.mjs";

/** Text the reference scanner reads. Anything else is bytes and is copied through. */
const TEXT_EXT = new Set([".html", ".htm", ".css", ".js", ".mjs", ".json", ".svg", ".txt", ".md", ".webmanifest", ".map"]);
export const isText = (p) => TEXT_EXT.has(path.posix.extname(String(p)).toLowerCase());

/**
 * Files a skill folder carries that are this engine's contract with itself, not assets a
 * page loads. A published manifest never has them (a skill ships what its skill.json
 * declares); a source tree does, and copying them would put engine vocabulary into a
 * folder whose whole point is that the engine is gone.
 */
const SKILL_INTERNAL = new Set(["skill.json", "graph.js"]);
export const isSkillInternal = (rel) => {
  const base = path.posix.basename(rel);
  return SKILL_INTERNAL.has(base) || base.toLowerCase().endsWith(".md");
};

/**
 * Whatever a person typed → the `publicPrefixes` entry it means.
 *
 * They will type the URL they know (`/garden/seed-swap/`), the repo path they edit
 * (`garden/prototypes/seed-swap`), or just the name (`seed-swap`). All three resolve; an
 * ambiguous bare name lists the candidates rather than picking one, because picking one
 * graduates the wrong tool and nothing about the result would say so.
 */
export function resolveUnit(arg, prefixes = []) {
  const list = prefixes.filter((p) => typeof p === "string" && p.startsWith("/"));
  const norm = String(arg || "").trim().replace(/^\/+|\/+$/g, "").replace(/\/prototypes\//, "/");
  if (!norm) throw new Error("name a prototype: --prototype <project>/<name>");

  const exact = list.find((p) => p === `/${norm}/`);
  if (exact) return { prefix: exact, name: exact.replace(/^\/+|\/+$/g, "").split("/").pop() };

  const byName = list.filter((p) => p.replace(/^\/+|\/+$/g, "").split("/").pop() === norm);
  if (byName.length === 1) return { prefix: byName[0], name: norm };
  if (byName.length > 1) {
    throw new Error(`"${norm}" names ${byName.length} prototypes — say which: ${byName.join(" ")}`);
  }
  throw new Error(`no published prototype "${norm}". Published: ${list.join(" ") || "(none)"}`);
}

/** Every published prototype, for a listing. */
export const publishedUnits = (manifest) =>
  ((manifest && manifest.routing && manifest.routing.publicPrefixes) || []).slice().sort();

/**
 * The unit's own files, from a published manifest → where each lands in the standalone
 * folder. The unit's URL prefix is stripped, so `/garden/seed-swap/index.html` becomes
 * `index.html` — the page a domain's root serves.
 */
export function unitFilesFromManifest(manifest, prefix) {
  const out = [];
  for (const [url, meta] of Object.entries((manifest && manifest.files) || {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!url.startsWith(prefix)) continue;
    const rel = url.slice(prefix.length);
    if (!rel) continue;
    out.push({ url, out: rel, h: meta && meta.h, s: (meta && meta.s) || 0 });
  }
  return out;
}

/**
 * The skill folders a set of files references. Reads the DIST form (`../../skills/x/`) and
 * the repo form (`../../../skills/x/`) identically — the depth is exactly what differs
 * between them, and it is not what is being asked here.
 */
export function skillDirsReferenced(texts) {
  const found = new Set();
  const re = /(?:\.\.\/)*skills\/([A-Za-z0-9._-]+)\//g;
  for (const t of texts) {
    let m;
    while ((m = re.exec(String(t)))) found.add(m[1]);
  }
  return [...found].sort();
}

/** Everything those skill folders published, at the same path in the standalone folder. */
export function skillFilesFromManifest(manifest, dirs) {
  const out = [];
  for (const [url, meta] of Object.entries((manifest && manifest.files) || {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const m = /^\/skills\/([^/]+)\/(.+)$/.exec(url);
    if (!m || !dirs.includes(m[1])) continue;
    if (isSkillInternal(m[2])) continue;
    out.push({ url, out: `skills/${m[1]}/${m[2]}`, h: meta && meta.h, s: (meta && meta.s) || 0 });
  }
  return out;
}

/**
 * The peel, aimed at the standalone folder rather than at a repo.
 *
 * Same transformer the adopt path uses — marker chrome out, og/twitter meta out, the
 * linked-assets stamp out, the title emoji off — with the skills depth rewritten for where
 * this file now SITS, which for the page at the root of a domain is no depth at all.
 * A file already in authored form (graduating straight from a repo) passes through it
 * unchanged except for that depth, which is exactly the one thing that has to change.
 */
export function rerootHtml(text, outPath) {
  const dir = path.posix.dirname(outPath);
  const relDir = dir === "." ? "" : dir;
  return stripBuildDecorations(String(text), relDir)
    .replace(/\n[ \t]*\n(\s*<\/head>)/g, "\n$1")
    .replace(/\n[ \t]*\n(\s*<\/body>)/g, "\n$1");
}

// ── the proof ────────────────────────────────────────────────────────────────

/**
 * What this engine leaves behind if the peel misses. Every one of these is a request back
 * to the instance the prototype came from, or a script that expects it to be there. A
 * graduated copy carrying any of them is not graduated — it is a page that will look fine
 * on the old origin and break, or leak, on the new one.
 */
const ENGINE_TRACES = [
  [/<!--gv-[a-z0-9-]+-(?:start|end)/i, "an injected-chrome marker the peel should have removed"],
  [/window\.__GV_[A-Z_]+/, "a page global this engine sets"],
  [/["'(\s]\/__[a-z][a-z0-9-]*\//i, "a request back to an engine route"],
];

const SKIP_REF = /^(?:#|data:|mailto:|tel:|javascript:|blob:|about:)/i;
const ABSOLUTE_REF = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i;

/** Every reference a page or stylesheet makes, with the line it is on. */
export function referencesIn(text, ext) {
  const refs = [];
  const push = (raw, line) => { if (raw) refs.push({ ref: raw.trim(), line }); };
  const lines = String(text).split("\n");
  const patterns = [
    /\b(?:href|src|poster|action|data-src)\s*=\s*["']([^"']*)["']/gi,
    /\bsrcset\s*=\s*["']([^"']*)["']/gi,
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
    /@import\s+(['"])([^'"]+)\1/gi,
  ];
  const wanted = ext === ".html" || ext === ".htm" ? patterns : patterns.slice(2);
  lines.forEach((text_, i) => {
    for (const re of wanted) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text_))) {
        const raw = m[2] != null ? m[2] : m[1];
        if (re.source.startsWith("\\bsrcset")) {
          for (const part of raw.split(",")) push(part.trim().split(/\s+/)[0], i + 1);
        } else push(raw, i + 1);
      }
    }
  });
  return refs;
}

/**
 * Scan the whole written folder. `files` is [{path, text}] for text files plus the set of
 * every path present, so a reference can be resolved against what is actually there.
 *
 * Returns findings, each `{level, path, line, ref, why}`. `level: "fatal"` means the copy
 * still depends on the engine — the command refuses on those, because a graduation that
 * silently keeps calling home is the failure this whole item exists to prevent.
 */
export function residualFindings(files, present, { sourceHost = "" } = {}) {
  const have = present instanceof Set ? present : new Set(present || []);
  const findings = [];

  for (const f of files) {
    const lines = String(f.text).split("\n");
    lines.forEach((line, i) => {
      for (const [re, why] of ENGINE_TRACES) {
        if (re.test(line)) findings.push({ level: "fatal", path: f.path, line: i + 1, ref: line.trim().slice(0, 120), why });
      }
      if (sourceHost && line.includes(sourceHost)) {
        findings.push({ level: "fatal", path: f.path, line: i + 1, ref: line.trim().slice(0, 120), why: `an absolute link back to ${sourceHost}` });
      }
    });

    const ext = path.posix.extname(f.path).toLowerCase();
    for (const { ref, line } of referencesIn(f.text, ext)) {
      if (!ref || SKIP_REF.test(ref)) continue;
      if (ABSOLUTE_REF.test(ref)) {
        findings.push({ level: "external", path: f.path, line, ref, why: "a request to another origin — it will follow this copy wherever it goes" });
        continue;
      }
      const clean = ref.split("#")[0].split("?")[0];
      if (!clean) continue;
      const dir = path.posix.dirname(f.path);
      let resolved = clean.startsWith("/")
        ? clean.replace(/^\/+/, "")
        : path.posix.normalize(path.posix.join(dir === "." ? "" : dir, clean));
      if (resolved.startsWith("..")) {
        findings.push({ level: "dangling", path: f.path, line, ref, why: "points outside the folder" });
        continue;
      }
      if (resolved.endsWith("/") || resolved === "") resolved += "index.html";
      if (!have.has(resolved) && !have.has(resolved.replace(/\/$/, "")) && !have.has(`${resolved}/index.html`)) {
        findings.push({ level: "dangling", path: f.path, line, ref, why: "nothing in the folder answers this" });
      }
    }
  }
  return findings.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));
}
