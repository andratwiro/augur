#!/usr/bin/env node
/**
 * augur canon — resolve a canonical name to files, and promote a working screen into
 * the canon.
 *
 * WHY THIS EXISTS. "Pull screens X, Y and Z and wire them together" is the instruction
 * that makes a workspace's design system worth having, and it presumes X names something
 * an agent can find COLD — no human pointing, in a session that has never seen this
 * workspace before. Names decide whether that resolves, and names drift the moment they
 * are only a habit: one screen lands as `checkout-v2`, the next as `new_Checkout`, a
 * third as a scratch folder wearing the same name as a canonical page, and the
 * instruction stops resolving. Renaming everything afterwards works and costs a day.
 *
 * So the scheme is written down once (agents/canon.md), this command applies it, and
 * `canon save` is the reason a canon grows without anybody scheduling it: the screen
 * somebody just built is one command away from being canonical — correctly named, its
 * description carried over, and its design-system references repointed for the depth it
 * now sits at. That repoint is the hand-edit that used to be the reason promotion did
 * not happen, because skipping it produces a page that still LOOKS right on the site and
 * opens unstyled from disk.
 *
 *   augur canon list  [--tier <t>] [--json]
 *   augur canon find  <name>… [--json]
 *   augur canon save  <path> [--as <name>] [--tier <t>] [--desc "…"] [--replace] [--dry-run]
 *   augur canon check
 *
 * NOTHING IS CACHED AND NOTHING IS GENERATED. Every answer is read from the tree at the
 * moment it is asked, so there is no index file to regenerate and therefore none to go
 * stale: the directory names ARE the index. That is only true while they obey the
 * scheme, which is the whole job of `check`.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const C = { dim: "\x1b[2m", warn: "\x1b[33m", bad: "\x1b[31m", ok: "\x1b[32m", off: "\x1b[0m" };
const log = (m) => console.log(`\x1b[35m[canon]\x1b[0m ${m}`);
const die = (m) => { console.error(`${C.bad}[canon] ${m}${C.off}`); process.exit(1); };

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d = null) => { const i = argv.indexOf(n); return i > -1 && argv[i + 1] ? argv[i + 1] : d; };
const positional = () => {
  const out = [];
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith("--")) { if (VALUE_FLAGS.has(argv[i])) i++; continue; }
    out.push(argv[i]);
  }
  return out;
};
const VALUE_FLAGS = new Set(["--tier", "--as", "--desc", "--space"]);

// ── The canon's four tiers ───────────────────────────────────────────────────
// The same four directories build.js scans at a workspace root (PAGES_SRC /
// COMPONENTS_SRC / BASE_SRC / PATTERNS_SRC) and publishes as their own tabs. This
// command adds no tier and invents no directory: a tier that is not one of these is not
// part of the contract the site already serves.
const TIERS = ["base", "components", "patterns", "pages"];
const TIER_IS = {
  base: "one atom, every state on one page",
  components: "one composed component",
  patterns: "an arrangement several screens repeat",
  pages: "a whole screen",
};

// ── The name ─────────────────────────────────────────────────────────────────
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME = 40;
const MAX_WORDS = 4;

// The closed set of state qualifiers. Spelling the same idea the same way in every
// workspace is the point: an agent told "the empty state of the invoice list" can write
// down `invoice-empty` without asking.
const STATES = ["list", "detail", "new", "edit", "empty", "error", "loading", "confirm", "success"];

// The near misses — every one of these means a word already in STATES. Reported, never
// rewritten: which of two words a team says is theirs to settle, and a tool that renamed
// a folder on a hunch would be worse than the drift.
const NEAR_STATES = {
  index: "list", all: "list", overview: "list",
  view: "detail", show: "detail", single: "detail", item: "detail",
  create: "new", add: "new",
  blank: "empty", none: "empty", zero: "empty",
  fail: "error", failure: "error", broken: "error",
  busy: "loading", skeleton: "loading", pending: "loading",
  done: "success", ok: "success", saved: "success",
};

// A canonical name says WHAT, never WHEN. Everything here encodes a moment in somebody's
// afternoon — a version, a date, a state of mind — and a name carrying one cannot be
// guessed by the person who has to pull it tomorrow. `-new` is absent on purpose: it is a
// STATE (the create screen), so only `-new2` and friends are refused.
const SCRATCH_RE = /-(?:v\d+|\d{4,}|\d{4}-\d{2}(?:-\d{2})?|(?:old|final|copy|dupe|wip|tmp|temp|draft|bak|backup|fixed|updated|latest|test)\d*|(?:new)\d+)$/;

const words = (n) => n.split("-").filter(Boolean);

/** Every reason a name is not a canonical name. Empty array = it is one. */
function nameErrors(name) {
  const out = [];
  if (!name) out.push("empty");
  else {
    if (!NAME_RE.test(name)) out.push("not lowercase-hyphen (a-z, 0-9 and single hyphens only)");
    if (name.length > MAX_NAME) out.push(`${name.length} characters (the ceiling is ${MAX_NAME})`);
    if (SCRATCH_RE.test(name)) out.push(`ends in a version or a date — a canonical name says what, never when`);
  }
  return out;
}

/** Advice: true of names that resolve fine but will not be guessed the same way twice. */
function nameNotes(name) {
  const out = [];
  const w = words(name);
  if (w.length > MAX_WORDS) out.push(`${w.length} words — ${MAX_WORDS} is the outside`);
  const last = w[w.length - 1];
  if (NEAR_STATES[last]) out.push(`ends in "-${last}"; the word for that state is "-${NEAR_STATES[last]}"`);
  return out;
}

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");

/**
 * The name a source folder should be promoted under, and what had to change to get
 * there. Announced on every run rather than applied quietly — a promotion that renames
 * without saying so is a promotion nobody can predict.
 */
function normalizeName(raw) {
  const changes = [];
  let name = String(raw || "");
  const slug = slugify(name);
  if (slug !== name) { changes.push(`slug: "${name}" → "${slug}"`); name = slug; }
  for (let i = 0; i < 4 && SCRATCH_RE.test(name); i++) {
    const stripped = name.replace(SCRATCH_RE, "");
    if (!stripped) break;
    changes.push(`dropped "${name.slice(stripped.length)}" — a canonical name carries no version`);
    name = stripped;
  }
  return { name, changes };
}

// ── Reading a workspace ──────────────────────────────────────────────────────

/** The nearest ancestor carrying a space.json — the same thing every other script means by "the space". */
function spaceRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, "space.json"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * The workspace's UI skill directory, by the same detection build.js runs: the dir under
 * skills/ named `<prefix>-ui` carrying `<dirname>.css`, overridable by space.json.
 * Re-derived rather than imported because build.js is not a module.
 */
function skillDirName(root) {
  let declared = null;
  try { declared = (JSON.parse(fs.readFileSync(path.join(root, "space.json"), "utf8")).designSystem || {}).skill || null; } catch { /* no space.json is caught upstream */ }
  if (declared) return declared;
  const skills = path.join(root, "skills");
  if (!fs.existsSync(skills)) return null;
  return fs.readdirSync(skills)
    .filter((d) => d.endsWith("-ui") && fs.existsSync(path.join(skills, d, `${d}.css`)))
    .sort()[0] || null;
}

const decode = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'");
const encodeAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const DESC_TAG_RE = /<meta\s+[^>]*name\s*=\s*["']description["'][^>]*>/i;

/** The one-line blurb the gallery card, the link preview and the canvas picker already read. */
function readDesc(html) {
  const tag = (html.match(DESC_TAG_RE) || [])[0];
  if (!tag) return "";
  const m = tag.match(/content\s*=\s*["']([^"']*)["']/i);
  return m ? decode(m[1]).trim() : "";
}

function writeDesc(html, desc) {
  const tag = `<meta name="description" content="${encodeAttr(desc)}">`;
  if (DESC_TAG_RE.test(html)) return html.replace(DESC_TAG_RE, tag);
  const i = html.toLowerCase().indexOf("</head>");
  return i === -1 ? tag + "\n" + html : html.slice(0, i) + tag + "\n" + html.slice(i);
}

/** Which of the workspace's design-system assets a folder's entry page references. */
function linkedAssets(dir, skill) {
  if (!skill) return [];
  const idx = path.join(dir, "index.html");
  if (!fs.existsSync(idx)) return [];
  const html = fs.readFileSync(idx, "utf8");
  const re = new RegExp(String.raw`(?:href|src)\s*=\s*["']([^"']*skills/${skill}/[^"']+)["']`, "gi");
  const out = new Set();
  let m;
  while ((m = re.exec(html))) out.add(m[1].split("/").pop());
  return [...out];
}

/** Every skill reference in a page, with whether it resolves on disk from where it sits. */
function brokenSkillRefs(dir, skill) {
  if (!skill) return [];
  const idx = path.join(dir, "index.html");
  if (!fs.existsSync(idx)) return [];
  const html = fs.readFileSync(idx, "utf8");
  const re = new RegExp(String.raw`(?:href|src)\s*=\s*["']((?:\.\./)+skills/${skill}/[^"']+)["']`, "gi");
  const bad = [];
  let m;
  while ((m = re.exec(html))) if (!fs.existsSync(path.resolve(dir, m[1]))) bad.push(m[1]);
  return bad;
}

/** Every canonical entry in the workspace, tier by tier, in the order the site shows them. */
function scanCanon(root, skill) {
  const out = [];
  for (const tier of TIERS) {
    const dir = path.join(root, tier);
    if (!isDir(dir)) continue;
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const entryDir = path.join(dir, e.name);
      const entry = path.join(entryDir, "index.html");
      const html = fs.existsSync(entry) ? fs.readFileSync(entry, "utf8") : null;
      out.push({
        name: e.name,
        tier,
        dir: rel(root, entryDir),
        entry: html === null ? null : rel(root, entry),
        description: html === null ? "" : readDesc(html),
        links: linkedAssets(entryDir, skill),
      });
    }
  }
  return out;
}

/**
 * The folders that are NOT the canon: working prototypes and scratch. A bare name never
 * means one of these — but when a name resolves to nothing, or to a canon entry AND one
 * of these, saying so is the difference between "not found" and "somebody built a second
 * copy instead of promoting the first".
 */
function scanWorking(root) {
  const out = [];
  const push = (dir, kind) => {
    if (!fs.existsSync(path.join(dir, "index.html"))) return;
    out.push({ name: path.basename(dir), kind, dir: rel(root, dir) });
  };
  for (const e of dirsIn(root)) {
    if (TIERS.includes(e) || e === "skills" || e === "node_modules") continue;
    if (e === "playground") { for (const p of dirsIn(path.join(root, e))) push(path.join(root, e, p), "playground"); continue; }
    const protos = path.join(root, e, "prototypes");
    if (!isDir(protos)) continue;
    for (const p of dirsIn(protos)) push(path.join(protos, p), "prototype");
  }
  return out;
}

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const dirsIn = (p) => (isDir(p) ? fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort() : []);
const rel = (root, p) => path.relative(root, p).split(path.sep).join("/");

/** Levenshtein, for "did you mean" — a wrong name should cost a suggestion, not a search. */
function distance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

// ── Copying ──────────────────────────────────────────────────────────────────
// Mirrors build.js's isInternalOnly: research and context material stays on the machine,
// and a repo or a credential checked out inside a folder is never content. A promotion
// copies into a PUBLISHED tier, so the same floor has to hold here.
const SECRET_FILE_RE = /(^\.env(\.|$)|\.env$|\.(pem|key|p12|pfx|ppk|keystore|jks)$|(^|[._-])(secret|secrets|credentials?)([._-]|$)|^id_(rsa|dsa|ecdsa|ed25519)$|^\.(npmrc|netrc|pgpass|htpasswd|ssh|aws|gnupg)$)/i;
const VCS_DIR_RE = /^\.(git|hg|svn|bzr)$/i;
const isInternalOnly = (name) =>
  name === "research" || name === "context" || name === "research.md" || name === "context.md" ||
  name === ".DS_Store" || name.endsWith(".zip") || VCS_DIR_RE.test(name) || SECRET_FILE_RE.test(name);

/**
 * The plan for a promotion: every file that would be written, and every skill reference
 * that would be repointed. Built before anything is touched so --dry-run and the real run
 * report the identical thing.
 */
function planCopy(srcDir, destDir, root, skill, desc) {
  const files = [];
  const walk = (from, to) => {
    for (const e of fs.readdirSync(from, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (isInternalOnly(e.name)) continue;
      const s = path.join(from, e.name), d = path.join(to, e.name);
      if (e.isDirectory()) { walk(s, d); continue; }
      if (!e.isFile()) continue;
      if (e.name.endsWith(".html")) {
        let html = fs.readFileSync(s, "utf8");
        let repointed = 0;
        if (skill) {
          // The same depth-aware rewrite build.js runs when it copies into dist — done
          // here against the SOURCE tree so the promoted page also opens from disk, which
          // dist never had to care about.
          const want = path.relative(path.dirname(d), path.join(root, "skills", skill)).split(path.sep).join("/") + "/";
          html = html.replace(new RegExp(String.raw`(?:\.\./)+skills/${skill}/`, "g"), (hit) => { if (hit !== want) repointed++; return want; });
        }
        if (e.name === "index.html" && desc) html = writeDesc(html, desc);
        files.push({ dest: d, text: html, repointed });
      } else {
        files.push({ dest: d, from: s });
      }
    }
  };
  walk(srcDir, destDir);
  return files;
}

// ── The workspace's own note ─────────────────────────────────────────────────
// One short file at the workspace root, written on the first promotion. It is what an
// agent that has never seen this workspace finds by looking at it, and the only reason it
// repeats anything from agents/canon.md is that the engine clone is not guaranteed to be
// beside every checkout. It lists no entries: an enumerated index is a second copy of the
// tree, and a second copy of the tree is a thing that goes stale.
//
// EXPORTED because a workspace has to carry it from birth, not from its first promotion.
// `augur init` writes it beside the space.json it scaffolds and the seed ships a copy, so
// the two ways a workspace can be born — self-hosted and hosted — describe their names the
// same way. Written once here and imported by both: a second copy is a thing that drifts,
// and `test/canon-naming.test.mjs` fails if either ever does.
export const NOTE = `# The canon

The screens and parts in this workspace that are meant to be **pulled by name** —
"build it the way \`invoice-detail\` is built", "pull \`invoice-list\`,
\`invoice-detail\` and \`invoice-empty\` and wire them together".

A canonical name is a directory name, in one of four places at this root:

| Where | What it holds |
| --- | --- |
| \`base/<name>/\` | ${TIER_IS.base} |
| \`components/<name>/\` | ${TIER_IS.components} |
| \`patterns/<name>/\` | ${TIER_IS.patterns} |
| \`pages/<name>/\` | ${TIER_IS.pages} |

Anything else is not the canon and is never what a bare name means: a folder under
\`<project>/prototypes/\` is a working prototype, \`playground/\` is scratch.

Names are lowercase and hyphenated, **subject first and qualifier last** —
\`invoice-list\`, \`invoice-detail\`, \`invoice-empty\`, never \`list-of-invoices\` — so
a directory listing sorts a subject's screens together and reads as a table of
contents. The qualifier comes from one closed set:

${STATES.map((s) => `\`-${s}\``).join(" · ")}

A name never carries a version, a date or a ticket id: it says what, never when.
Every entry carries one sentence in \`<meta name="description">\` saying what it
shows.

**To pull \`<name>\`, look for \`<name>/\` in those four directories.** The entry
page is \`<tier>/<name>/index.html\` and it opens on its own, from disk, with the
workspace's design system already on it. That is the whole resolution rule, and
it needs no tool.

With the engine's CLI on hand, the same thing plus the description and the
design-system assets each entry links:

    augur canon find <name>      # → the tier, the folder, the entry, what it links
    augur canon list             # → every canonical name and its description
    augur canon save <path>      # → promote a working screen into the canon
    augur canon check            # → names that will not be found the same way twice

The full rules, with the reasoning, are the engine's \`agents/canon.md\`.
`;

function ensureNote(root) {
  const p = path.join(root, "CANON.md");
  if (fs.existsSync(p)) return null;
  fs.writeFileSync(p, NOTE);
  return "CANON.md";
}

// ── Commands ─────────────────────────────────────────────────────────────────

function resolveRoot() {
  const root = spaceRoot(opt("--space") || process.cwd());
  if (!root) die(`no space.json above ${process.cwd()} — run this inside a workspace clone, or pass --space <dir>.`);
  return root;
}

function cmdList() {
  const root = resolveRoot();
  const skill = skillDirName(root);
  const only = opt("--tier");
  if (only && !TIERS.includes(only)) die(`unknown tier "${only}" — one of ${TIERS.join(", ")}.`);
  const entries = scanCanon(root, skill).filter((e) => !only || e.tier === only);
  if (flag("--json")) { console.log(JSON.stringify(entries, null, 2)); return; }
  if (!entries.length) {
    log(`no canonical entries yet in ${root}`);
    log(`the canon starts the first time you run \`augur canon save <path>\` on a screen worth pulling again.`);
    return;
  }
  for (const tier of TIERS) {
    const rows = entries.filter((e) => e.tier === tier);
    if (!rows.length) continue;
    console.log(`\n${tier}/  ${C.dim}${TIER_IS[tier]}${C.off}`);
    const w = Math.max(...rows.map((r) => r.name.length));
    for (const r of rows) console.log(`  ${r.name.padEnd(w)}  ${C.dim}${r.description || "(no description — augur canon check)"}${C.off}`);
  }
  console.log("");
}

function cmdFind() {
  const root = resolveRoot();
  const skill = skillDirName(root);
  const names = positional();
  if (!names.length) die(`usage: augur canon find <name>… — the canonical name, exactly as you were told it.`);
  const entries = scanCanon(root, skill);
  const working = scanWorking(root);
  const results = [];
  let missing = 0;

  for (const raw of names) {
    const name = slugify(raw);
    const hits = entries.filter((e) => e.name === name);
    const shadows = working.filter((w) => w.name === name);
    if (hits.length) {
      for (const h of hits) results.push({ ...h, query: raw, shadows });
      if (!flag("--json")) {
        for (const h of hits) {
          console.log(`\n${h.name}  ${C.dim}${h.tier}${C.off}  ${h.dir}/`);
          console.log(`  what   ${h.description || `${C.warn}(none — an entry with no description cannot be found by anyone who does not already know it)${C.off}`}`);
          console.log(`  entry  ${h.entry || `${C.bad}(no index.html)${C.off}`}`);
          if (h.links.length) console.log(`  links  ${h.links.join(", ")}`);
          for (const s of shadows) console.log(`  also   ${s.dir}/ ${C.dim}— a ${s.kind}, not the canon${C.off}`);
        }
      }
      if (hits.length > 1) console.error(`${C.bad}[canon] "${name}" is in ${hits.length} tiers at once — one name resolves to one thing. Rename one.${C.off}`);
      continue;
    }
    missing++;
    if (flag("--json")) { results.push({ query: raw, name, tier: null, dir: null, shadows }); continue; }
    console.log(`\n${name}  ${C.bad}not in the canon${C.off}`);
    for (const s of shadows) console.log(`  ${s.dir}/ ${C.dim}— a ${s.kind} of that name. \`augur canon save ${s.dir}\` makes it canonical.${C.off}`);
    const near = entries
      .map((e) => ({ e, d: distance(name, e.name) }))
      .filter((x) => x.d <= 3 || x.e.name.startsWith(words(name)[0] + "-"))
      .sort((a, b) => a.d - b.d).slice(0, 4);
    if (near.length) console.log(`  did you mean  ${near.map((x) => `${x.e.name} (${x.e.tier})`).join(", ")}`);
    else if (!shadows.length) console.log(`  ${C.dim}\`augur canon list\` prints every name this workspace has.${C.off}`);
  }

  if (flag("--json")) console.log(JSON.stringify(results, null, 2));
  else console.log("");
  if (missing) process.exit(1);
}

function cmdSave() {
  const root = resolveRoot();
  const skill = skillDirName(root);
  const dry = flag("--dry-run");
  const args = positional();
  const src = path.resolve(args[0] || process.cwd());
  const srcDir = isDir(src) ? src : path.dirname(src);

  if (!fs.existsSync(path.join(srcDir, "index.html")))
    die(`${rel(root, srcDir)}/ has no index.html — a canon entry is a folder with an entry page (agents/prototype-contract.md).`);
  if (path.resolve(srcDir) === path.resolve(root)) die(`that is the workspace root, not a screen.`);
  const inTier = TIERS.find((t) => path.resolve(srcDir).startsWith(path.join(root, t) + path.sep));
  if (inTier) die(`${rel(root, srcDir)}/ is already canonical (${inTier}/). To rename it, move the folder — the folder name is the name.`);

  const tier = opt("--tier") || "pages";
  if (!TIERS.includes(tier)) die(`unknown tier "${tier}" — one of ${TIERS.join(", ")}.`);

  const { name, changes } = normalizeName(opt("--as") || path.basename(srcDir));
  const errs = nameErrors(name);
  if (errs.length) die(`"${name}" is not a canonical name: ${errs.join("; ")}. Pass --as <name>.`);

  const destDir = path.join(root, tier, name);
  if (fs.existsSync(destDir) && !flag("--replace"))
    die(`${tier}/${name}/ already exists. Pass --replace to overwrite it, or --as <name> to promote this as something else.`);

  const clash = TIERS.filter((t) => t !== tier && fs.existsSync(path.join(root, t, name)));
  if (clash.length) die(`"${name}" is already the name of ${clash.map((t) => `${t}/${name}/`).join(" and ")} — one name resolves to one thing. Pass --as <name>.`);

  const srcHtml = fs.readFileSync(path.join(srcDir, "index.html"), "utf8");
  const desc = opt("--desc") || readDesc(srcHtml);
  if (!desc)
    die(`${rel(root, srcDir)}/index.html has no <meta name="description">, so the promoted entry would carry no description — and a canon entry nobody can read the point of is one nobody pulls. Add the tag, or pass --desc "one sentence saying what it shows".`);

  const files = planCopy(srcDir, destDir, root, skill, opt("--desc") ? desc : null);
  const repointed = files.reduce((n, f) => n + (f.repointed || 0), 0);

  for (const c of changes) log(`${C.warn}${c}${C.off}`);
  log(`${dry ? "would promote" : "promoting"} ${rel(root, srcDir)}/ → ${tier}/${name}/`);
  for (const f of files) console.log(`  ${rel(root, f.dest)}`);
  if (repointed) log(`${repointed} design-system reference${repointed === 1 ? "" : "s"} repointed for the new depth (${tier}/${name}/ sits two levels down, not three)`);
  log(`what it shows: ${desc}`);

  if (dry) { log(`${C.dim}--dry-run: nothing written.${C.off}`); return; }

  for (const f of files) {
    fs.mkdirSync(path.dirname(f.dest), { recursive: true });
    if (f.text != null) fs.writeFileSync(f.dest, f.text, "utf8");
    else fs.copyFileSync(f.from, f.dest);
  }
  const wrote = ensureNote(root);
  if (wrote) log(`wrote ${wrote} — the note that tells the next agent how names in this workspace work`);

  for (const n of nameNotes(name)) log(`${C.warn}${n}${C.off}`);
  log(`${C.ok}${name} is canonical${C.off} — it appears under /${tier}/${name}/ on the next publish, and \`augur canon find ${name}\` resolves it now.`);
  log(`${C.dim}the source folder is untouched: a prototype is the record of an exploration, a canon entry is the thing to copy.${C.off}`);
}

function cmdCheck() {
  const root = resolveRoot();
  const skill = skillDirName(root);
  const entries = scanCanon(root, skill);
  const working = scanWorking(root);
  const errors = [], notes = [];

  if (!entries.length) {
    log(`no canonical entries in ${root} — nothing to check.`);
    log(`${C.dim}the canon starts the first time you run \`augur canon save <path>\`.${C.off}`);
    return;
  }

  const seen = new Map();
  for (const e of entries) {
    const where = `${e.tier}/${e.name}/`;
    for (const err of nameErrors(e.name)) errors.push(`${where} ${err}`);
    for (const n of nameNotes(e.name)) notes.push(`${where} ${n}`);
    if (!e.entry) errors.push(`${where} no index.html — nothing to pull`);
    else if (!e.description) errors.push(`${where} no <meta name="description"> — nobody can find it who does not already know it`);
    for (const bad of brokenSkillRefs(path.join(root, e.dir), skill))
      errors.push(`${where} references ${bad}, which does not resolve from there — the page opens unstyled from disk (wrong depth for this tier)`);
    if (seen.has(e.name)) errors.push(`${where} and ${seen.get(e.name)} share a name — one name resolves to one thing`);
    else seen.set(e.name, where);
  }
  for (const w of working) if (seen.has(w.name)) notes.push(`${w.dir}/ shadows ${seen.get(w.name)} — the canon wins, so this copy is one nobody will be sent to`);
  if (!fs.existsSync(path.join(root, "CANON.md"))) notes.push(`no CANON.md at the workspace root — an agent arriving cold has nothing to read. \`augur canon save\` writes one.`);

  for (const n of notes) console.log(`${C.warn}note${C.off}  ${n}`);
  for (const e of errors) console.log(`${C.bad}fail${C.off}  ${e}`);
  log(`${entries.length} canonical entr${entries.length === 1 ? "y" : "ies"} · ${errors.length} to fix · ${notes.length} to look at`);
  if (!errors.length && !notes.length) log(`${C.ok}every name resolves, and every entry says what it is.${C.off}`);
  // A green run says the names are FINDABLE, never that they are the right names for the
  // things — whether `invoice-detail` is the screen a person would ask for by that name is
  // a review question, and no lint has ever been able to answer it.
  if (errors.length) process.exit(1);
}

// Only when this file IS the command. Imported (for NOTE), it must do nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sub = argv[0];
  const run = { list: cmdList, find: cmdFind, save: cmdSave, check: cmdCheck }[sub];
  if (!run) {
    console.error("usage: augur canon <list|find|save|check> [options]");
    console.error("  augur canon find  <name>…                     resolve a canonical name to files");
    console.error("  augur canon list  [--tier <t>] [--json]       every canonical name and what it shows");
    console.error("  augur canon save  <path> [--as <name>] [--tier <t>] [--desc \"…\"] [--replace] [--dry-run]");
    console.error("  augur canon check                             names that will not be found the same way twice");
    process.exit(sub ? 1 : 0);
  }
  run();
}
