#!/usr/bin/env node
/**
 * augur clone / augur pull — turn a live space back into an editable source tree.
 *
 * `C-clone-pull-materializer`, and it serves the goal that erodes quietly: leaving is free,
 * and self-hosting is the same product. A hosted workspace may never have had a git repo,
 * so "export your data" cannot mean "here is a tarball of hashes" — it has to mean a tree
 * somebody can open, edit and publish again.
 *
 *   augur clone --space <id> [--out <dir>] [--dry-run]
 *   augur pull  [--space <id>] [--dry-run]        (from inside a cloned tree)
 *
 * ── ONE PROTOTYPE, STANDALONE (the graduation form) ──────────────────────────────────
 *
 *   augur clone --prototype <project>/<name> [--space <id>] [--out <dir>] [--dry-run]
 *   augur clone --prototype <name> --from <space-dir> [--out <dir>]      (no credentials)
 *
 * `F-graduate-path`. The whole-workspace clone above serves "leaving is free" at workspace
 * granularity; this serves it at ARTIFACT granularity, which is the one observed usage
 * actually asks for. A single tool inside a research workspace acquires a stable audience
 * that is not the team — and then it should leave, on its own, before the research
 * workspace becomes its production host by default. It is a doorway, not a policy: see
 * docs/graduation.md for WHEN, which is the harder half.
 *
 * What comes out is a folder any static host can serve at a domain root: the prototype's
 * files re-rooted (its index.html at `/`), the design-system folders it references beside
 * them, and NOTHING of this engine. That last clause is verified rather than asserted —
 * every written file is scanned, and an injected marker, an engine route or a page global
 * fails the command. See scripts/lib/graduate.mjs.
 *
 * ⚠️ A CLONE IS NOT A BACKUP, and the difference matters enough that it is printed on
 * every run. A publish carries what a visitor can fetch, so a clone recovers exactly that.
 * It cannot recover what was never published: `context.md` and other research notes (which
 * the publish whitelist deliberately excludes), `registry.json`, `space.json`,
 * `prototype-status.json`, the skill manifest, or anything under `.github/`. `augur export`
 * is the backup — it copies the store, including history. This copies the SOURCE.
 *
 * HOW `pull` DECIDES. Three-way, against the same local cache `publish.mjs` already writes
 * at ~/.config/augur/published/<host>/<space>.json:
 *
 *   remote changed, local matches last-synced   → fast-forward. Somebody else published;
 *                                                 take it.
 *   remote changed, local ALSO changed          → CONFLICT. Left untouched, reported, and
 *                                                 never silently overwritten — that is the
 *                                                 whole reason this is not `clone --force`.
 *   remote unchanged                            → nothing to do, whatever the local file says.
 *
 * A conflict is left ON DISK as the local version, because the local version is the one
 * with somebody's unsaved thinking in it. The remote is one command away.
 */
import path from "node:path";
import os from "node:os";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { target, apiClient } from "./lib/store.mjs";
import { materializePlan, synthesizeSpaceJson } from "./lib/materialize.mjs";
import { stripBuildDecorations } from "./lib/publish-conflict.mjs";
import {
  resolveUnit, unitFilesFromManifest, skillDirsReferenced, skillFilesFromManifest,
  rerootHtml, residualFindings, isText, isSkillInternal,
} from "./lib/graduate.mjs";

const C = { dim: "\x1b[2m", warn: "\x1b[33m", bad: "\x1b[31m", ok: "\x1b[32m", off: "\x1b[0m" };
const log = (m) => console.log(`\x1b[35m[clone]\x1b[0m ${m}`);
const die = (m) => { console.error(`\x1b[31m[clone] ${m}\x1b[0m`); process.exit(1); };

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
// A flag never eats the NEXT flag as its value: `--prototype --from x` means "--prototype
// with no value", which is the shape a person types when they do not yet know the name.
// Reading `--from` as the prototype's name answers a question nobody asked.
const opt = (n, d = null) => {
  const i = argv.indexOf(n);
  const v = i > -1 ? argv[i + 1] : null;
  return v && !v.startsWith("--") ? v : d;
};
const MODE = process.env.AUGUR_CLONE_MODE || "clone"; // set by cli.mjs for `pull`
const DRY = flag("--dry-run");

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Every file under a tree, as repo-relative paths. */
async function walk(dir, base = dir, acc = []) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) await walk(abs, base, acc);
    else acc.push(path.relative(base, abs).split(path.sep).join("/"));
  }
  return acc;
}

// ── one prototype, standalone ────────────────────────────────────────────────

/**
 * The prototype folders a space TREE holds, written as publicPrefixes.
 *
 * Not a second vocabulary: expressing the tree in the same terms the manifest uses is what
 * lets ONE resolver, one set of error messages and one plan serve both sources. A
 * repo-backed workspace and a hosted one that never had a repo are the two shapes that
 * exist, and a doorway only one of them fits is not a doorway.
 */
async function treePrefixes(root) {
  const out = [];
  let top = [];
  try { top = await readdir(root, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of top) {
    if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules" || e.name === "skills") continue;
    let protos = [];
    try { protos = await readdir(path.join(root, e.name, "prototypes"), { withFileTypes: true }); } catch (err) { continue; }
    for (const p of protos) if (p.isDirectory()) out.push(`/${e.name}/${p.name}/`);
  }
  return out.sort();
}

async function graduate() {
  if (MODE === "pull") {
    die("`augur pull` syncs a whole tree. To take one prototype out of it, run `augur clone --prototype <name>`.");
  }
  const from = opt("--from");
  const unitArg = opt("--prototype");

  // Where the bytes come from. A repo-backed workspace can graduate with no credentials
  // and no network at all; a hosted one reads the same prototype out of the live store.
  let prefixes, sourceHost = "", read, manifest = null, origin = "", spaceId = opt("--space"), root = "";
  if (from) {
    root = path.resolve(from);
    if (!existsSync(path.join(root, "space.json"))) die(`${root} is not a workspace folder — no space.json in it.`);
    try { sourceHost = new URL(JSON.parse(readFileSync(path.join(root, "space.json"), "utf8")).siteOrigin || "http://x.invalid").host; } catch (e) {}
    if (sourceHost === "x.invalid") sourceHost = "";
    prefixes = await treePrefixes(root);
    read = async (f) => readFileSync(path.join(root, f.src));
  } else {
    const t = target({ needToken: true });
    origin = t.origin;
    const req = apiClient(origin, t.token);
    sourceHost = new URL(origin).host;
    if (!spaceId) die("name the workspace: augur clone --prototype <name> --space <id>   (or --from <space-dir> to graduate straight out of a repo)");
    try { manifest = await (await req(`${spaceId}/manifest`)).json(); }
    catch (e) { die(`could not read ${spaceId}'s manifest — ${e.message}`); }
    prefixes = (manifest.routing && manifest.routing.publicPrefixes) || [];
    read = async (f) => {
      const body = Buffer.from(await (await req(`${spaceId}/blob/${f.h}`)).arrayBuffer());
      const got = sha256(body);
      if (got !== f.h) die(`${f.url}: the store returned bytes whose hash is ${got.slice(0, 12)}, not ${String(f.h).slice(0, 12)}. Refusing to write content that is not what the manifest names.`);
      return body;
    };
  }

  // `--prototype` with nothing after it asks the question a person actually starts with:
  // which ones are there? Nothing else lists them — the first cold run of this command
  // went and read the directory tree by hand to pick one, which is a doorway with no sign
  // on it.
  if (!unitArg) {
    if (!prefixes.length) die("this workspace publishes no prototypes.");
    log(`${prefixes.length} prototype(s) to graduate from:`);
    for (const p of prefixes) console.log(`  ${p}`);
    console.log(`\n${C.dim}Take one out with --prototype <name>. Add --dry-run to see what would come with it.${C.off}`);
    process.exit(0);
  }

  let unit;
  try { unit = resolveUnit(unitArg, prefixes); } catch (e) { die(e.message); }
  const segs = unit.prefix.replace(/^\/+|\/+$/g, "").split("/");
  const out = path.resolve(opt("--out") || path.join(process.cwd(), unit.name));

  // The prototype's own files, re-rooted: what lived at /<project>/<name>/ now lives at /.
  let plan;
  if (from) {
    const dir = path.join(root, segs[0], "prototypes", segs[1]);
    plan = (await walk(dir)).sort().map((rel) => ({ out: rel, src: path.join(segs[0], "prototypes", segs[1], rel) }));
  } else {
    plan = unitFilesFromManifest(manifest, unit.prefix);
  }
  if (!plan.length) die(`${unit.prefix} has no files. Nothing to graduate.`);

  const files = [];
  for (const f of plan) {
    let body = await read(f);
    if (f.out.endsWith(".html")) body = Buffer.from(rerootHtml(body.toString("utf8"), f.out), "utf8");
    files.push({ out: f.out, body });
  }

  // The design system comes too. A prototype is self-contained HTML except for the one
  // thing it deliberately shares, and left behind it is an unstyled page on somebody's
  // domain. Whole folders, not the files a scan saw: a stylesheet reaches its own fonts by
  // paths no reference scan finds.
  const dirs = skillDirsReferenced(files.filter((f) => isText(f.out)).map((f) => f.body.toString("utf8")));
  let skillPlan = [];
  if (dirs.length) {
    if (from) {
      for (const d of dirs) {
        for (const rel of (await walk(path.join(root, "skills", d))).sort()) {
          if (isSkillInternal(rel)) continue;
          skillPlan.push({ out: `skills/${d}/${rel}`, src: path.join("skills", d, rel) });
        }
      }
    } else {
      skillPlan = skillFilesFromManifest(manifest, dirs);
    }
  }
  for (const f of skillPlan) {
    let body = await read(f);
    if (f.out.endsWith(".html")) body = Buffer.from(rerootHtml(body.toString("utf8"), f.out), "utf8");
    files.push({ out: f.out, body });
  }

  // THE PROOF, and it runs before anything is written so --dry-run gives the whole verdict.
  const present = new Set(files.map((f) => f.out));
  const texts = files.filter((f) => isText(f.out)).map((f) => ({ path: f.out, text: f.body.toString("utf8") }));
  const findings = residualFindings(texts, present, { sourceHost });
  const fatal = findings.filter((f) => f.level === "fatal");
  const suspect = findings.filter((f) => f.level === "suspect");
  const dangling = findings.filter((f) => f.level === "dangling");
  const external = findings.filter((f) => f.level === "external");

  const bytes = files.reduce((n, f) => n + f.body.length, 0);
  log(`${unit.prefix} → ${files.length} file(s), ${(bytes / 1e6).toFixed(2)} MB${dirs.length ? `, design system: ${dirs.join(" ")}` : ", no design system referenced"}`);

  for (const f of fatal) console.log(`  ${C.bad}engine${C.off}    ${f.path}:${f.line}  ${f.why}\n            ${C.dim}${f.ref}${C.off}`);
  for (const f of dangling) console.log(`  ${C.warn}dangling${C.off}  ${f.path}:${f.line}  ${f.ref}  ${C.dim}${f.why}${C.off}`);
  // Capped: the case that produces these produces them in bulk (a page whose subject IS
  // the platform), and a thousand lines of prose scrolled past is the same as none.
  for (const f of suspect.slice(0, 12)) console.log(`  ${C.warn}mention${C.off}   ${f.path}:${f.line}  ${C.dim}${f.ref}${C.off}`);
  if (suspect.length > 12) console.log(`  ${C.dim}… and ${suspect.length - 12} more mention(s)${C.off}`);
  for (const f of external) console.log(`  ${C.dim}external  ${f.path}:${f.line}  ${f.ref}${C.off}`);

  // Say the verdict out loud, including when it is all zeroes. The first cold run of this
  // read a clean result as "the tool printed nothing" and said so: a person checking
  // "carries no dependency on the engine" needs the check to have SPOKEN, not to have been
  // quiet. Silence is what a broken checker also produces.
  log(`checked ${texts.length} text file(s) of ${files.length}: ${fatal.length} engine, ${suspect.length} mention, ${dangling.length} dangling, ${external.length} external`);

  // Refuse BEFORE writing. A folder that still fetches from the instance looks perfect on
  // the old origin, and the person moving it has usually pointed a domain at it before
  // anyone finds out — so it must not exist on disk to be copied somewhere by mistake.
  // --dry-run is how you look at one without producing it.
  if (fatal.length) {
    log(`${C.bad}${fatal.length} reference(s) still reach this engine — nothing was written.${C.off}`);
    console.log(`${C.dim}Each one is listed above with its file and line. They are the whole difference between a copy that serves anywhere and one that quietly needs this instance to stay up.${C.off}`);
    process.exit(1);
  }

  if (DRY) {
    log(`${C.dim}dry run — would write ${files.length} file(s) to ${out}${C.off}`);
  } else {
    if (existsSync(out) && (await readdir(out).catch(() => [])).length) {
      die(`${out} already has something in it. Graduating writes a whole site; name an empty --out.`);
    }
    for (const f of files) {
      const abs = path.join(out, f.out);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, f.body);
    }
    log(`${C.ok}graduated ${files.length} file(s) → ${out}${C.off}`);
  }

  if (dangling.length) {
    log(`${C.warn}${dangling.length} reference(s) resolve to nothing in the folder.${C.off} ${C.dim}The old site answered them; a domain serving only this folder will 404 them. Links to sibling prototypes are the usual cause — they did not come along.${C.off}`);
  }
  if (suspect.length) {
    log(`${C.warn}${suspect.length} engine-shaped mention(s) in the text.${C.off} ${C.dim}Nothing fetches them or they would be listed above as engine. A page whose SUBJECT is the platform produces these by the hundred and depends on none of them — but a request built inside a script looks the same from here, so they are yours to glance at.${C.off}`);
  }
  console.log(
    `\n${C.dim}Nothing in this folder fetches anything from Augur. Serve it with any static file server:\n` +
    `  cd ${out} && python3 -m http.server 8080\n` +
    `Putting it on a domain, and when a tool is ready to leave at all: docs/graduation.md${C.off}`
  );
  process.exit(dangling.length || suspect.length ? 3 : 0);
}

async function main() {
  if (flag("--prototype")) return graduate();
  const { origin, token } = target({ needToken: true });
  const req = apiClient(origin, token);

  // `pull` runs from inside a cloned tree, so the space is whatever that tree says it is.
  let spaceId = opt("--space");
  let out = opt("--out");
  if (MODE === "pull") {
    out = out || process.cwd();
    const sj = path.join(out, "space.json");
    if (!existsSync(sj)) die(`no space.json in ${out} — run \`augur pull\` from inside a cloned tree, or \`augur clone --space <id>\` first.`);
    try { spaceId = spaceId || JSON.parse(readFileSync(sj, "utf8")).id; } catch (e) { die(`could not read ${sj}: ${e.message}`); }
  }
  if (!spaceId) die("name a space: augur clone --space <id> [--out <dir>]");
  out = out || path.resolve(process.cwd(), spaceId);

  let manifest;
  try { manifest = await (await req(`${spaceId}/manifest`)).json(); }
  catch (e) { die(`could not read ${spaceId}'s manifest — ${e.message}`); }

  const { files, skipped } = materializePlan(manifest);
  if (!files.length) die(`${spaceId} has no published source files. Nothing to clone.`);

  // The last-synced state publish.mjs already records, so `pull` is three-way rather than
  // last-writer-wins.
  const cacheDir = path.join(os.homedir(), ".config", "augur", "published", new URL(origin).host);
  const cachePath = path.join(cacheDir, spaceId + ".json");
  let cached = null;
  try { cached = JSON.parse(readFileSync(cachePath, "utf8")); } catch (e) {}
  const lastSynced = (cached && cached.files) || {};

  log(`${spaceId} v${manifest.version || 0} at ${origin} — ${files.length} source file(s), ${skipped.length} generated and skipped`);

  const plan = { write: [], skip: [], conflict: [] };
  for (const f of files) {
    const abs = path.join(out, f.path);
    if (!existsSync(abs)) { plan.write.push({ ...f, why: "new" }); continue; }
    const local = sha256(readFileSync(abs));
    if (local === f.h) { plan.skip.push({ ...f, why: "already identical" }); continue; }
    // The URL is the key publish.mjs records under, not the source path.
    const synced = lastSynced[f.url] && (lastSynced[f.url].h || lastSynced[f.url]);
    if (MODE === "clone") { plan.write.push({ ...f, why: "overwriting (clone)" }); continue; }
    if (synced && local === synced) { plan.write.push({ ...f, why: "fast-forward" }); continue; }
    plan.conflict.push({ ...f, why: synced ? "changed on BOTH sides since last sync" : "changed locally, and never synced from here" });
  }

  for (const c of plan.conflict) {
    console.log(`  ${C.warn}conflict${C.off}  ${c.path}  ${C.dim}${c.why}${C.off}`);
  }
  if (DRY) {
    log(`${C.dim}dry run — would write ${plan.write.length}, leave ${plan.skip.length} identical, ${plan.conflict.length} conflict(s)${C.off}`);
    process.exit(plan.conflict.length ? 2 : 0);
  }

  let wrote = 0, bytes = 0, peeled = 0;
  for (const f of plan.write) {
    const body = Buffer.from(await (await req(`${spaceId}/blob/${f.h}`)).arrayBuffer());
    // Hash the bytes the store returned, BEFORE peeling: the manifest names the published
    // content, and a store that answered with something else is the failure worth stopping
    // on. Peeling afterwards is a local transform, not a trust decision.
    const got = sha256(body);
    if (got !== f.h) die(`${f.url}: the store returned bytes whose hash is ${got.slice(0, 12)}, not ${String(f.h).slice(0, 12)}. Refusing to write content that is not what the manifest names.`);

    // A PUBLISHED PAGE IS NOT ITS SOURCE, and writing it as though it were is how a clone
    // stops being republishable. The build decorates authored HTML on the way out: og and
    // twitter meta, the linked-assets stamp, an emoji on the <title>, marker-wrapped
    // review and companion scripts, and a rewritten depth on every skills/ path. The
    // marker regions would survive a republish idempotently; the meta would not, so a
    // clone-publish-clone cycle would accumulate it. `stripBuildDecorations` is the peel
    // the publish adopt path already uses for exactly this, including putting the skills/
    // depth back to what the file's REPO location needs.
    let outBody = body;
    if (f.path.endsWith(".html")) {
      const text = body.toString("utf8");
      const relDir = path.dirname(f.path) === "." ? "" : path.dirname(f.path);
      // The peel leaves the blank line the removed block sat on. Harmless — the adopt
      // path compares through a whitespace-collapsing comparator — but a clone is read by
      // a person and diffed against a repo, so close the gap it leaves rather than
      // shipping 18 files that differ from their source by an empty line. Only immediately
      // before the two closing tags the build writes at; authored blank lines are not ours.
      const peeledText = stripBuildDecorations(text, relDir)
        .replace(/\n[ \t]*\n(\s*<\/head>)/g, "\n$1")
        .replace(/\n[ \t]*\n(\s*<\/body>)/g, "\n$1");
      if (peeledText !== text) peeled++;
      outBody = Buffer.from(peeledText, "utf8");
    }

    const abs = path.join(out, f.path);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, outBody);
    wrote++; bytes += outBody.length;
  }

  // space.json is not a served asset and is in no manifest, so a clone synthesizes it —
  // and never overwrites one that already exists, because a real tree's space.json carries
  // decisions (a display name, a projects label) this cannot know.
  const sj = path.join(out, "space.json");
  if (!existsSync(sj)) {
    await writeFile(sj, JSON.stringify(synthesizeSpaceJson(spaceId, origin), null, 2) + "\n");
    log(`wrote a minimal space.json — it carries only id, default and siteOrigin, because nothing else is recoverable from a publish`);
  }

  log(`${C.ok}${MODE === "pull" ? "pulled" : "cloned"} ${wrote} file(s), ${(bytes / 1e6).toFixed(2)} MB → ${out}${C.off}`);
  if (peeled) log(`${C.dim}${peeled} page(s) peeled back to source: the build meta, the marker chrome and the depth rewrites removed${C.off}`);
  if (plan.skip.length) log(`${C.dim}${plan.skip.length} already identical${C.off}`);
  if (plan.conflict.length) {
    log(`${C.warn}${plan.conflict.length} file(s) left untouched because they changed on both sides. Yours are still on disk; the live copy is one \`augur clone --out <elsewhere>\` away.${C.off}`);
  }

  // Said every time, because somebody will otherwise use this as a backup.
  console.log(`\n${C.dim}A clone is what a visitor could fetch, not the repository. It cannot recover research notes (context.md and friends), registry.json, prototype-status.json, the skill manifest or anything under .github/ — a publish never carried them. \`augur export\` is the backup.${C.off}`);
  process.exit(plan.conflict.length ? 2 : 0);
}

main().catch((e) => die(e && e.stack ? e.stack : String(e)));
