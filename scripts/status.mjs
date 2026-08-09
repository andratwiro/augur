// status.mjs — "what is live, and is it what I have?"
//
//   augur status            every space this checkout can see
//   … --fetch               ask each remote for its current main first
//
// This is the command that would have ended a whole evening. Space content ships by
// publishing, not by pushing, so work can be committed, pushed, reviewed and still
// not be on the site — and nothing about the repo tells you that. This puts the
// three numbers side by side: what the store is serving, what your clone has, and
// what the remote has.
//
// Reads /_build.json (public, cache-busted) plus plain git in each space clone. No
// token needed.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { resolveOrigin, buildStamp, ENGINE_ROOT } from "./lib/store.mjs";

const args = process.argv.slice(2);
const DO_FETCH = args.includes("--fetch");
const log = (msg) => console.error(`\x1b[36m[status]\x1b[0m ${msg}`);

const C = { dim: "\x1b[2m", red: "\x1b[31m", yellow: "\x1b[33m", green: "\x1b[32m", off: "\x1b[0m" };

const origin = resolveOrigin();
if (!origin) { log('no target origin — set AUGUR_ORIGIN, or add "siteOrigin" to space.json.'); process.exit(1); }

const git = (dir, ...a) => {
  try {
    return execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch (e) { return ""; }
};

// Space clones, found the same way build.js and publish.mjs find them: siblings of
// the engine, the shell's spaces/ mount, or the cwd itself.
function findSpaceDirs() {
  const roots = [];
  if (process.env.GV_SPACES_ROOT) roots.push(process.env.GV_SPACES_ROOT);
  roots.push(path.join(ENGINE_ROOT, ".."), path.join(ENGINE_ROOT, "spaces"));
  const out = new Map();
  if (existsSync(path.join(process.cwd(), "space.json"))) out.set(idOf(process.cwd()), process.cwd());
  for (const root of roots) {
    let entries = [];
    try { entries = readdirSync(root, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const dir = path.join(root, e.name);
      if (!existsSync(path.join(dir, "space.json"))) continue;
      const id = idOf(dir);
      if (!out.has(id)) out.set(id, dir);
    }
  }
  return out;
}
function idOf(dir) {
  try { return JSON.parse(readFileSync(path.join(dir, "space.json"), "utf8")).id || path.basename(dir); }
  catch (e) { return path.basename(dir); }
}

const stamp = await buildStamp(origin);
const clones = findSpaceDirs();
const ids = [...new Set([...Object.keys(stamp.spaces || {}), ...clones.keys()])].sort();

console.log(`${C.dim}${origin}${C.off}`);
console.log("");

let problems = 0;
for (const id of ids) {
  const liveInfo = (stamp.spaces || {})[id];
  const dir = clones.get(id);
  const head = dir ? git(dir, "rev-parse", "HEAD") : "";
  const localDirty = dir ? git(dir, "status", "--porcelain").length > 0 : false;
  if (dir && DO_FETCH) git(dir, "fetch", "--quiet", "origin");
  const remote = dir ? git(dir, "rev-parse", "origin/main") : "";
  // Direction matters and a plain inequality doesn't carry it: a clone can be
  // ahead of the remote (work nobody else can see) or behind it (work you
  // haven't got yet), and telling someone to pull when they need to push sends
  // them the wrong way.
  const [ahead, behind] = dir && remote
    ? git(dir, "rev-list", "--left-right", "--count", `${head}...${remote}`).split(/\s+/).map(Number)
    : [0, 0];

  const short = (s) => (s ? s.slice(0, 12) : "—");
  const bits = [];
  let verdict, colour;

  if (!liveInfo) {
    verdict = "never published"; colour = C.red; problems++;
  } else if (liveInfo.dirty) {
    verdict = "published from a working tree"; colour = C.red; problems++;
  } else if (!dir) {
    verdict = "live (no local clone to compare)"; colour = C.dim;
  } else if (liveInfo.sha === head && !localDirty && !ahead && !behind) {
    verdict = "live matches your clone"; colour = C.green;
  } else if (localDirty) {
    verdict = "uncommitted changes — run `augur ship`"; colour = C.yellow; problems++;
  } else if (liveInfo.sha !== head && !behind) {
    verdict = "your clone is AHEAD of live — run `augur ship`"; colour = C.yellow; problems++;
  } else if (ahead) {
    verdict = `${ahead} commit(s) only on this machine — run \`augur ship\``; colour = C.yellow; problems++;
  } else if (behind) {
    verdict = `${behind} commit(s) waiting on the remote — pull, then ship`; colour = C.yellow; problems++;
  } else {
    verdict = "live matches your clone"; colour = C.green;
  }

  if (liveInfo) {
    bits.push(`live ${short(liveInfo.sha)}${liveInfo.version ? ` v${liveInfo.version}` : ""}`);
    if (liveInfo.publishedBy) bits.push(`by ${liveInfo.publishedBy}`);
  }
  if (dir) bits.push(`local ${short(head)}${localDirty ? "*" : ""}`);
  if (remote && remote !== head) bits.push(`origin/main ${short(remote)}`);

  console.log(`  ${colour}${id.padEnd(16)}${verdict}${C.off}`);
  console.log(`  ${C.dim}${" ".repeat(16)}${bits.join("  ·  ")}${C.off}`);
}

const eng = stamp.engine || {};
console.log("");
console.log(`  ${C.dim}engine chrome    ${eng.sha ? eng.sha.slice(0, 12) : "—"}` +
  `${eng.version ? ` (v${eng.version})` : ""}${eng.publishedAt ? `  ·  shipped ${eng.publishedAt}` : ""}${C.off}`);

// Exit code is the answer, so this can gate a script: 0 = everything live is what
// its clone says it should be.
process.exit(problems ? 1 : 0);
