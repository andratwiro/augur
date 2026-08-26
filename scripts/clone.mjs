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

const C = { dim: "\x1b[2m", warn: "\x1b[33m", bad: "\x1b[31m", ok: "\x1b[32m", off: "\x1b[0m" };
const log = (m) => console.log(`\x1b[35m[clone]\x1b[0m ${m}`);
const die = (m) => { console.error(`\x1b[31m[clone] ${m}\x1b[0m`); process.exit(1); };

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d = null) => { const i = argv.indexOf(n); return i > -1 && argv[i + 1] ? argv[i + 1] : d; };
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

async function main() {
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
