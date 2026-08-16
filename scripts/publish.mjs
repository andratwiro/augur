// publish.mjs — incremental direct publish: build a space, upload only the blobs
// the store doesn't hold, commit its manifest (an atomic pointer flip).
//
//   node scripts/publish.mjs --space <id>     publish one space
//   node scripts/publish.mjs --all            publish every space + engine chrome
//                                             + push the instance config
//   … --dry-run                               diff against the store, ship nothing
//   … --allow-unpublish                       permit taking live public pages down
//
// Run from a space repo (a cwd with space.json) the --space flag is inferred.
// Contract (agents rely on this): synchronous, zero prompts, exit code = truth,
// "<live url>  v<version>" is the LAST line on stdout; progress goes to stderr.
//
// Auth: AUGUR_TOKEN env (a publish token minted in the Admin panel, or the
// instance's .env.deploy). Target: AUGUR_ORIGIN env, else the instance's
// deploy.config.json siteOrigin. Provenance: the space repo's git sha + a dirty
// flag ride in the manifest (a working-tree publish is visible, never hidden).

import { spawn, spawnSync, execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findShellDir, deployConfig } from "./lib/instance.mjs";
import { isAncestor, resolvePublish, applyManifestPatches } from "./lib/publish-resolve.mjs";
import { CLIENT_PROTOCOL, buildStamp } from "./lib/store.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const log = (msg) => console.error(`\x1b[32m[publish]\x1b[0m ${msg}`);
const die = (msg) => { log(msg); process.exit(1); };
// Appended to every "publish is not happening this run" failure: the sanctioned
// meanwhile is the real local shell (chrome, login, canvas — a faithful preview),
// never a bare file:// path opened directly, which has none of that and is only
// ever a personal sanity check, not something to hand to anyone else.
const MEANWHILE = "Meanwhile: `node scripts/dev.mjs` runs a full local preview " +
  "(chrome, login, canvas) — always local-only, not shipped, nobody else can see it. " +
  "Never hand over a file:// path.";

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const DRY = flag("--dry-run");
const ALL = flag("--all");
// --allow-unpublish: this publish MAY remove public pages that are live now.
// Off by default, because a publish ships one tree as the whole space — so a
// checkout missing a folder silently takes everyone's shareable links down, and
// the publisher cannot see it happen (their preview is right, and the gate shows
// a login page where the page used to be, which reads as locked, not gone).
// Deleting a prototype on purpose is the case this flag exists for.
const ALLOW_UNPUBLISH = flag("--allow-unpublish");
// --engine: shared chrome + instance config ONLY, never space content. The CI
// path uses this — its checkout may lag direct publishes, so it must never be
// able to overwrite newer space content with a stale tree.
//
// "Never" is enforced twice over. This flag only ever commits the _engine
// manifest, AND it runs the build with GV_ENGINE_ONLY=1, which skips space
// discovery entirely — so a space sitting in the workspace is not merely ignored,
// it is never read, and the build asserts it emitted nothing but chrome. Until
// that assertion existed, four files that LOOKED like chrome (the composition
// graph, the space icon, and the two canvas aggregates) were in fact derived from
// space content, and every CI run quietly republished them from its pinned tree.
const ENGINE_ONLY = flag("--engine");
// --no-self-update: keep a stale engine rather than fast-forwarding it. Off by default
// (see selfUpdate below) because the alternative is telling a person to run git.
const NO_SELF_UPDATE = flag("--no-self-update") || process.env.AUGUR_NO_SELF_UPDATE === "1";
// Declared here, not beside selfUpdate: `function` declarations hoist but `let` does
// not, and maybeRefreshEngine calls selfUpdate from earlier in the file. Leaving it
// below the callers is a ReferenceError that only fires on a clone that is behind —
// i.e. exactly the case the whole mechanism exists for.
let selfUpdateTried = false;

function readEnvFile(p) {
  const out = {};
  try {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch (e) {}
  return out;
}
const DEPLOY_ENV = readEnvFile(path.join(ROOT, ".env.deploy"));

// Target origin: env, instance file, deploy shell — and for a bare space clone
// (the collaborator layout, no shell anywhere) the space's own space.json
// `siteOrigin`: the one public fact a space repo knows about its instance.
const cwdSpaceOrigin = (() => {
  try { return JSON.parse(readFileSync(path.join(process.cwd(), "space.json"), "utf8")).siteOrigin || ""; }
  catch (e) { return ""; }
})();
const ORIGIN = (process.env.AUGUR_ORIGIN || DEPLOY_ENV.AUGUR_ORIGIN || deployConfig(ROOT).siteOrigin || cwdSpaceOrigin || "")
  .replace(/\/+$/, "");
if (!ORIGIN) die("no target origin — set AUGUR_ORIGIN, or add \"siteOrigin\" to space.json.");
// Token: env/instance file, else the saved `augur login` credential for this origin.
let TOKEN = process.env.AUGUR_TOKEN || DEPLOY_ENV.AUGUR_TOKEN || "";
if (!TOKEN) {
  try {
    const os = await import("node:os");
    const saved = JSON.parse(readFileSync(path.join(os.homedir(), ".config", "augur", "tokens.json"), "utf8"));
    TOKEN = (saved[new URL(ORIGIN).host] || {}).token || "";
  } catch (e) {}
}
if (!TOKEN) die(`no publish token — run \`augur login\` once (uses your web credentials). ${MEANWHILE}`);

// Space discovery: GV_SPACES_ROOT when set (explicit wins, same as build.js),
// else sibling clones (the maintainer-workspace layout), else ./spaces mounts. cwd
// inference: running inside a space repo publishes THAT space.
const PARENT = path.join(ROOT, "..");
const discoverIn = (root) => {
  // A root that IS a space (space.json at its top) is a one-space site — same
  // semantics as build.js discoverSpaces(). Symlinked space dirs count too.
  try {
    if (existsSync(path.join(root, "space.json"))) return [path.resolve(root)];
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith(".")
        && existsSync(path.join(root, e.name, "space.json")))
      .map((e) => path.join(root, e.name));
  } catch (e) { return []; }
};
let spaceDirs = process.env.GV_SPACES_ROOT ? discoverIn(process.env.GV_SPACES_ROOT) : discoverIn(PARENT);
const usingSiblings = !process.env.GV_SPACES_ROOT && spaceDirs.length > 0;
const SPACES_ROOT = process.env.GV_SPACES_ROOT || (usingSiblings ? PARENT : path.join(ROOT, "spaces"));
if (!process.env.GV_SPACES_ROOT && !usingSiblings) spaceDirs = discoverIn(SPACES_ROOT);
const idOf = (dir) => {
  try { return JSON.parse(readFileSync(path.join(dir, "space.json"), "utf8")).id || path.basename(dir); }
  catch (e) { return path.basename(dir); }
};
// Two sibling checkouts of the SAME space id make publish ambiguous and unsafe:
// byId keeps whichever sorts LAST, so `ship`/`publish` from one clone can push a
// different clone's (even uncommitted) tree — and the build then emits the space at
// BOTH / and /<id>/, moving every live URL onto /<id>/ and serving shared links the
// login page. Refuse it before anything is built: one checkout per space.
{
  const seenDir = {};
  for (const d of spaceDirs) {
    const id = idOf(d);
    if (seenDir[id]) {
      die(`two checkouts beside this engine both declare space "${id}":\n` +
          `    ${seenDir[id]}\n    ${d}\n\n` +
          `  Publishing would be ambiguous — it could ship the wrong tree or split the\n` +
          `  site across / and /${id}/. Keep one checkout per space next to the engine\n` +
          `  (move or remove the other), then re-run.`);
    }
    seenDir[id] = d;
  }
}
const byId = Object.fromEntries(spaceDirs.map((d) => [idOf(d), d]));

// Running inside a space repo publishes THAT space — the contract documented up
// top. `byId` above only ever looked at clones sitting next to the engine, so a
// cwd that is NOT a direct sibling (a nested clone, a worktree, the
// collab-sandbox layout) never lands in it — which also means the
// duplicate-checkout guard above never sees it. Left alone, a DIFFERENT sibling
// clone that happens to declare the SAME id keeps winning byId, and this run
// would silently build and publish THAT tree instead of the one it's standing
// in — exit 0, a plausible live URL, nothing to say it shipped the wrong thing.
// Make the cwd win for its own id. (Reaching the actual build too needs one
// more step — see BUILD_SPACES_ROOT below; byId alone only fixes what THIS
// script derives from the source dir: git sha, dirty flag, the shallow-clone
// guard, conflict-fork naming.)
// realpath, not path.resolve: cwd and a discovered sibling can be the SAME directory
// reached through different symlinks (e.g. macOS's /tmp → /private/tmp) — a lexical
// compare would call that a collision and pay for a mirror copy that changes nothing.
const real = (p) => { try { return realpathSync(p); } catch (e) { return path.resolve(p); } };
const cwdSpaceDir = existsSync(path.join(process.cwd(), "space.json")) ? real(process.cwd()) : "";
let overriddenSiblingId = null;
if (cwdSpaceDir) {
  const cwdId = idOf(cwdSpaceDir);
  if (byId[cwdId] && real(byId[cwdId]) !== cwdSpaceDir) overriddenSiblingId = cwdId;
  byId[cwdId] = cwdSpaceDir;
}

let targetSpace = opt("--space");
if (!targetSpace && !ALL && !ENGINE_ONLY && existsSync(path.join(process.cwd(), "space.json"))) {
  targetSpace = idOf(process.cwd());
}
if (!targetSpace && !ALL && !ENGINE_ONLY) die("name a target: --space <id>, --all, --engine, or run from a space repo.");
if (targetSpace && !byId[targetSpace]) die(`unknown space "${targetSpace}" (have: ${Object.keys(byId).join(", ")})`);

// ── credential pre-flight ─────────────────────────────────────────────────────
// A token that merely EXISTS is not a token that WORKS — expired, revoked, or
// scoped to a different space all look identical to the "no token" check above,
// but nothing used to catch them until deep inside the actual upload, by which
// point the build below had already run and left a real artifact on disk. Ping
// the same auth path the real publish hits (POST .../check, with no files — the
// same read the "true no-op" branch already relies on, so it costs nothing the
// classic path wasn't going to spend anyway) before spawning that build, so a
// bad-but-present token fails exactly as loud and exactly as early as an absent
// one: nothing is ever built for an agent to mistake for a completed hand-off.
//
// An unreachable origin fails exactly the same way, on purpose. It would be
// tempting to let a network blip through and let the real publish below retry —
// but that is precisely how the build got a chance to run and leave a local
// artifact lying around in the first place. There is no way to build here that
// isn't offline-first, and offline-first is what created the file:// hazard this
// whole check exists to close, so this errs terminal rather than guessing at
// "just a blip": if publishing can't be verified as possible, nothing gets built.
{
  const probeSpace = targetSpace || "_engine";
  let r;
  try {
    r = await fetch(`${ORIGIN}/__publish/${probeSpace}/check`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ files: {} }),
    });
  } catch (e) {
    die(`can't reach ${ORIGIN} to verify the publish token (${e.message}) — check your connection ` +
        `or AUGUR_ORIGIN. ${MEANWHILE}`);
  }
  if (r.status === 401 || r.status === 403) {
    die(`publish token rejected (${r.status}) by ${ORIGIN} — it's likely expired, revoked, or not ` +
        `scoped for "${probeSpace}". Run \`node scripts/login.mjs\` (or \`augur login\`) again. ${MEANWHILE}`);
  }
}

// ── build (single space unless --all; engine chrome always emitted) ──────────
// The byId override above fixed this script's OWN bookkeeping but not what
// build.js actually reads: it discovers space CONTENT itself, straight off
// SPACES_ROOT, which still resolves the collided id to the sibling — and a
// symlink swap wouldn't reach it either (discoverSpaces() only counts real
// directories; a symlinked entry reads as "not a space" and drops out
// silently). So when the cwd actually won something above, hand the build a
// throwaway mirror instead: a real copy of every directory byId now names,
// keyed by id, so it reads exactly the tree this script just resolved — same
// answer for "id → dir" on both sides. Skipped entirely when nothing was
// overridden (the overwhelmingly common case): SPACES_ROOT is used as-is, no
// copying, no cost.
let BUILD_SPACES_ROOT = SPACES_ROOT;
if (overriddenSiblingId && !ENGINE_ONLY) {
  const { mkdtempSync, cpSync } = await import("node:fs");
  const os = await import("node:os");
  const mirror = mkdtempSync(path.join(os.tmpdir(), "augur-publish-spaces-"));
  const skip = new Set([".git", "node_modules", "dist"]);
  for (const [id, dir] of Object.entries(byId)) {
    cpSync(dir, path.join(mirror, id), {
      recursive: true, dereference: true,
      filter: (src) => !skip.has(path.basename(src)),
    });
  }
  BUILD_SPACES_ROOT = mirror;
  log(`cwd wins space "${overriddenSiblingId}" over a same-id sibling next to the engine — building from a throwaway copy of the resolved tree`);
}
const SHELL_DIR = findShellDir(ROOT, (() => { try { return new URL(ORIGIN).host; } catch { return ""; } })());
const IDENTITY_PATH = process.env.GV_IDENTITY_PATH
  || (SHELL_DIR && existsSync(path.join(SHELL_DIR, "identity.json")) ? path.join(SHELL_DIR, "identity.json") : null);
const DEPLOY_CONFIG_PATH = process.env.GV_DEPLOY_CONFIG_PATH
  || (SHELL_DIR && existsSync(path.join(SHELL_DIR, "deploy.config.json")) ? path.join(SHELL_DIR, "deploy.config.json") : null);
const BUILD_ENV = {
  ...process.env,
  GV_SPACES_ROOT: BUILD_SPACES_ROOT,
  ...(IDENTITY_PATH ? { GV_IDENTITY_PATH: IDENTITY_PATH } : {}),
  ...(DEPLOY_CONFIG_PATH ? { GV_DEPLOY_CONFIG_PATH: DEPLOY_CONFIG_PATH } : {}),
  ...(targetSpace ? { GV_ONLY_SPACE: targetSpace } : {}),
  ...(ENGINE_ONLY ? { GV_ENGINE_ONLY: "1" } : {}),
};
// Contributor profiles come from the INSTANCE, always — the build only ever reads a
// file, and a file cannot know two things the live roster does: who has been invited
// since (the KV roster overlay) and, more importantly, what everyone's face is. A
// photo is a KV overlay that deliberately beats the config (it belongs to the person,
// not to the deployment), so a build that trusts the file alone renders initials for
// everyone who set one — and bakes `/__avatar/<seed-key>` URLs that stop resolving the
// moment the seed leaves identity.json, blanking the faces on every page published
// before that. Fetching here means each publish stamps the URLs the instance serves
// NOW.
//
//  - no identity file (a bare collaborator clone): the profiles ARE the identity.
//  - identity file (the workspace/shell layout): keep it as the roster of record and
//    take only `avatar` from the instance, so a locally-added user still builds.
// Either way a failed fetch is non-fatal: the file (or, without one, the engine's
// empty placeholder) still builds — with the faces it can name.
//
// NEVER under --engine. An engine publish builds no space cards, and it PUSHES the
// identity file as the live instance config — the config must carry each seed
// avatar's data: URI (what /__avatar/<key> serves), not the /__avatar/ URLs the
// profiles endpoint derives from it. Merging here would replace every data: URI
// with its own derived URL, and every seed face on the instance would 404.
if (!ENGINE_ONLY) try {
  const r = await fetch(`${ORIGIN}/__publish/_instance/profiles`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const { profiles } = await r.json();
  const os = await import("node:os");
  const { writeFile } = await import("node:fs/promises");
  const f = path.join(os.tmpdir(), `augur-profiles-${process.pid}.json`);
  let users = profiles;
  let note = `contributor profiles fetched (${profiles.length}) — card faces preserved`;
  if (IDENTITY_PATH) {
    // Index every address a profile answers to (people commit from several), so the
    // overlay lands on the same entry the build attributes commits to.
    const byEmail = new Map();
    for (const p of profiles) {
      for (const e of [p.email, ...(p.emails || [])]) if (e) byEmail.set(String(e).toLowerCase(), p);
    }
    const local = JSON.parse(readFileSync(IDENTITY_PATH, "utf8"));
    let faces = 0;
    users = local.map((u) => {
      const p = byEmail.get(String(u.email || "").toLowerCase());
      if (!p || !p.avatar) return u;
      faces++;
      return { ...u, avatar: p.avatar };
    });
    note = `contributor photos fetched (${faces}/${local.length}) — live faces on cards`;
  }
  await writeFile(f, JSON.stringify(users));
  BUILD_ENV.GV_IDENTITY_PATH = f;
  log(note);
} catch (e) {
  log(`profiles unavailable (${e.message}) — publishing with ${IDENTITY_PATH ? "config faces only" : "no editor faces"}`);
}

// Keeping the engine current cannot depend on anyone remembering to do it — that is
// what already failed. The adversarial-test sandbox sat for weeks on a lineage the
// public repo had re-cut, and every finding it produced was about code nobody runs,
// reported with total confidence. Discipline is not a mechanism.
//
// So the check rides the command everyone has to run anyway, throttled hard: at most
// once every 12h per clone, the stamp kept inside .git/ where it can never be committed
// or show up in `git status`. If the clone is clean and behind, selfUpdate fast-forwards
// it and re-execs; a dirty or diverged clone is left alone with a note to the agent.
// Never fatal, never blocking: a failed fetch just means we try again tomorrow.
const REFRESH_EVERY_MS = 12 * 60 * 60 * 1000;
async function maybeRefreshEngine() {
  if (NO_SELF_UPDATE || process.env.AUGUR_SELF_UPDATED === "1") return;
  const stamp = path.join(ROOT, ".git", "augur-last-refresh");
  try {
    const { statSync } = await import("node:fs");
    if (Date.now() - statSync(stamp).mtimeMs < REFRESH_EVERY_MS) return;
  } catch (e) { /* never checked before */ }
  try {
    // Touch the stamp FIRST: a fetch that hangs or fails must not make every subsequent
    // publish retry it, which would turn a network problem into a permanent slowdown.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(stamp, new Date().toISOString());
    execFileSync("git", ["-C", ROOT, "fetch", "--quiet", "origin"], { timeout: 10_000, stdio: "ignore" });
  } catch (e) { return; }
  const behind = (() => {
    try {
      return Number(execFileSync("git", ["-C", ROOT, "rev-list", "--count", "HEAD..@{u}"], { encoding: "utf8" }).trim());
    } catch (e) { return 0; }
  })();
  if (behind > 0) selfUpdate(`engine clone is ${behind} commit(s) behind its upstream`);
}

// The targeted version of the same problem, and the one that actually bit.
//
// A shell's engine submodule IS auto-bumped, so an instance's worker and shared chrome
// stay current on their own. But `publish` deliberately does not go through CI — that is
// the invariant that stops a redeploy overwriting a publish — which means the pages
// everyone sees are composed by THIS clone, on whoever's machine ran the command.
// Nothing was keeping that clone current, so a laptop three weeks behind would quietly
// rebuild every page with three-week-old chrome and publish it over the current ones.
//
// The instance already publishes what it is running, ungated: /_build.json engine.sha.
// If that commit is not in our history, the instance has an engine we do not — so our
// build would be a downgrade. One public GET, no auth, and it is the exact condition
// rather than a timer's guess.
async function refreshIfInstanceIsAhead(origin) {
  if (NO_SELF_UPDATE || process.env.AUGUR_SELF_UPDATED === "1") return;
  let deployed;
  try {
    const stamp = await buildStamp(origin);
    deployed = stamp && stamp.engine && stamp.engine.sha;
  } catch (e) { return; } // stamp unreachable or shapeless: not worth blocking a publish
  if (!deployed || !/^[0-9a-f]{40}$/.test(deployed)) return;
  try {
    // Already in our history (or IS our head) → our build is at least as new. Being
    // AHEAD is normal and fine: an engine change is published before CI catches up.
    execFileSync("git", ["-C", ROOT, "merge-base", "--is-ancestor", deployed, "HEAD"], { stdio: "ignore" });
    return;
  } catch (e) { /* not an ancestor — the instance has something we do not */ }
  selfUpdate(`${origin} runs engine ${deployed.slice(0, 12)}, which this clone does not have`);
}

const started = Date.now();
async function runBuild(label) {
  log(label || `building ${targetSpace || "all spaces"}…`);
  const code = await new Promise((resolve) => {
    spawn("node", ["build.js"], { cwd: ROOT, env: BUILD_ENV, stdio: ["ignore", 2, 2] }).on("close", resolve);
  });
  if (code !== 0) die(`build failed (exit ${code}). ${MEANWHILE}`);
}
await maybeRefreshEngine();               // periodic sweep; may re-exec and never return
await refreshIfInstanceIsAhead(ORIGIN);   // and the exact case: the instance is newer
await runBuild();

// Who forked, for conflict folder names — what git will actually sign as, not the
// often-unset user.email config (ship.mjs derives it the same way).
function whoFor(dir) {
  let ident = "";
  try {
    ident = execFileSync("git", ["-C", dir, "var", "GIT_AUTHOR_IDENT"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch (e) {}
  const email = (/<([^>]*)>/.exec(ident) || [, ""])[1];
  const n = email.split("@")[0] || (ident.split("<")[0] || "").trim() || process.env.USER || "someone";
  return n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "someone";
}

function repoState(dir) {
  const out = { sha: null, dirty: false };
  try {
    out.sha = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    out.dirty = execFileSync("git", ["-C", dir, "status", "--porcelain"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().length > 0;
  } catch (e) {}
  return out;
}

// Shallow clones collapse git history into one commit, which silently wrecks
// everything the build derives from it (per-card "Edited" dates, editor
// avatars). Refuse to publish content built from one — unshallowing is cheap.
function refuseShallow(dir) {
  try {
    const shallow = execFileSync("git", ["-C", dir, "rev-parse", "--is-shallow-repository"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (shallow === "true") {
      die(`${path.basename(dir)} is a SHALLOW clone — edit dates and editor chips would all collapse to the clone moment. Run \`git -C ${dir} fetch --unshallow origin\` first.` + `\n\n  ${MEANWHILE}`);
    }
  } catch (e) {}
}

// ── last-committed manifest cache (per origin+space) ─────────────────────────
// Lets a publish compute its delta locally and ship a small edit as ONE
// request (commit with blobs inline) instead of check → PUTs → commit. Purely
// an optimization: a stale/missing cache falls back to the classic protocol.
const CACHE_DIR = path.join(
  (await import("node:os")).homedir(), ".config", "augur", "published", new URL(ORIGIN).host);
function readPubCache(id) {
  try { return JSON.parse(readFileSync(path.join(CACHE_DIR, id + ".json"), "utf8")); }
  catch (e) { return null; }
}
async function writePubCache(id, data) {
  try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(path.join(CACHE_DIR, id + ".json"), JSON.stringify(data));
  } catch (e) {}
}
const INLINE_MAX_BLOBS = 16;
const INLINE_MAX_BYTES = 900_000;
// CLIENT_PROTOCOL (scripts/lib/store.mjs) is the version this CLI speaks; check
// responses echo the worker's. Newer worker → nudge the operator to pull; older
// worker → the fast path's failure fallback already degrades gracefully. An
// instance that publishes a floor above ours refuses us outright — see dieOutdated.
let warnedSkew = false;

// ── the digest protocol, per target ──────────────────────────────────────────
const api = (p) => `${ORIGIN}/__publish/${p}`;
const auth = { Authorization: `Bearer ${TOKEN}` };
async function req(url, init = {}) {
  const r = await fetch(url, { ...init, headers: { ...auth, ...(init.headers || {}) } });
  if (!r.ok && r.status !== 204) {
    const body = await r.text().catch(() => "");
    const e = new Error(`${init.method || "GET"} ${url} → ${r.status} ${body.slice(0, 300)}`);
    // Keep the structured refusal alongside the message: callers that know a
    // particular error can explain it properly instead of printing raw JSON.
    e.status = r.status;
    try { e.info = JSON.parse(body); } catch (_) {}
    throw e;
  }
  return r;
}

// The one refusal a person is likely to meet, so it gets a real explanation rather
// than a status code. Lists what would go dark and names both ways out — fix the
// checkout (nearly always right) or say you meant it.
function dieUnpublish(id, removed, count) {
  const shown = removed.slice(0, 12);
  die(`${id}: this publish would REMOVE ${count} public page(s) that are live right now:\n` +
      shown.map((p) => `    ${p}`).join("\n") +
      (count > shown.length ? `\n    … and ${count - shown.length} more` : "") + "\n\n" +
      `  Nothing was shipped. A publish sends YOUR tree as the whole space, so this\n` +
      `  usually means the tree being published is missing those folders or has them\n` +
      `  somewhere else. AGENT: reconcile the working tree first — do not ask the person\n` +
      `  you are working for to run git. Anyone's shared links and\n` +
      `  embeds for those pages would have started showing the login page.\n\n` +
      `  If you really are taking them down, re-run with --allow-unpublish.\n\n  ${MEANWHILE}`);
}

// The instance set a protocol floor and this clone is below it. Say what to do, and
// say plainly that nothing shipped — a refusal that reads as a transport error is how
// someone concludes the publish "mostly worked" and walks away.
// The engine clone is behind what the instance speaks. Fix it here rather than telling
// anyone to fix it: an editor has no reason to know this repo is a git checkout, and
// "run `git pull`" is a product failure dressed as a helpful message. The agent working
// on their behalf should not have to be told either — the default is that it just works.
//
// Strictly bounded, because this mutates a checkout nobody asked us to touch:
//   · only a clean tree (no local work to disturb, nothing to merge)
//   · only --ff-only (never a merge, never a rewrite — it cannot invent a conflict)
//   · only with an upstream configured, and only once per run (the re-exec carries a
//     guard so a server that still outranks us cannot loop)
// Anything else falls through to the caller's message, which addresses the AGENT.
// Returns true only if it re-executed (in which case this process has already exited).
function selfUpdate(why) {
  if (NO_SELF_UPDATE || selfUpdateTried || process.env.AUGUR_SELF_UPDATED === "1") return false;
  selfUpdateTried = true;
  const git = (...a) => execFileSync("git", ["-C", ROOT, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    if (git("rev-parse", "--is-inside-work-tree") !== "true") return false;
    if (git("status", "--porcelain")) {
      log(`engine checkout has uncommitted changes — leaving it alone (${why}).`);
      return false;
    }
    git("rev-parse", "--abbrev-ref", "@{u}"); // throws when no upstream is configured
    const before = git("rev-parse", "--short", "HEAD");
    git("pull", "--ff-only");
    const after = git("rev-parse", "--short", "HEAD");
    if (before === after) return false; // already current; the skew is something else
    log(`engine updated ${before} → ${after} (${why}) — retrying the publish.`);
  } catch (e) {
    return false; // not a git clone, no upstream, diverged, offline: caller reports it
  }
  // Re-exec so the NEW code runs: this process is still the old one.
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    cwd: process.cwd(),
    env: { ...process.env, AUGUR_SELF_UPDATED: "1" },
    stdio: "inherit",
  });
  process.exit(r.status ?? 1);
}

function dieOutdated(id, minProtocol) {
  die(`${id}: this instance requires publish protocol ${minProtocol}; this clone speaks ${CLIENT_PROTOCOL}.\n\n` +
      `  Nothing was shipped and the live site is untouched.\n\n` +
      `  An older client does not just miss features — it silently skips guards it has\n` +
      `  never heard of. A pre-3 client sends no baseVersion, so the store cannot tell\n` +
      `  whether this tree is built on what is live, and a stale checkout can revert\n` +
      `  whoever published last without either of you seeing it happen.\n\n` +
      `  This clone could not update itself (uncommitted changes, no upstream, or offline).\n` +
      `  AGENT: bring the engine clone at ${ROOT} up to date and re-run. Do not hand this\n` +
      `  instruction to the person you are working for — they have no reason to know the\n` +
      `  engine is a git checkout.\n\n  ${MEANWHILE}`);
}

async function publishOne(id, sourceDir) {
  if (id !== "_engine") refuseShallow(sourceDir);
  const fetchBlob = async (h) => {
    try { return Buffer.from(await (await req(api(`${id}/blob/${h}`))).arrayBuffer()); }
    catch (e) { return null; }
  };
  // Set once the live store has been reconciled against this tree; carried across
  // loop attempts (a rebuild re-reads the manifest, a stale-base retry re-checks).
  let resolution = null;
  let cached = readPubCache(id);

  for (let attempt = 1; attempt <= 4; attempt++) {
    const manifest = JSON.parse(await readFile(path.join(ROOT, "dist", "__manifests", id + ".json"), "utf8"));
    manifest.source = { ...repoState(sourceDir), actor: process.env.USER || "" };
    if (resolution) applyManifestPatches(manifest, resolution.patches);
    // Rides in the commit body; the store strips it before persisting. Sent only when
    // asked for, so an older instance (which would keep an unknown field) sees nothing.
    if (ALLOW_UNPUBLISH) manifest.allowUnpublish = true;
    const files = manifest.files;
    const total = Object.keys(files).length;

    // Fast path: with a cache of the last commit, a small delta ships as ONE
    // request — the commit carries its fresh blobs base64-inline. Any failure
    // (stale cache, older worker, sentinel) falls through to the classic path.
    // It only rides when it can carry `baseVersion` (the instance speaks
    // protocol ≥3, learned on any classic publish) and nothing is unresolved:
    // the store then proves live is exactly my last publish, which is the one
    // situation where committing a whole tree cannot revert anyone.
    if (!DRY && !resolution && attempt === 1 && cached && cached.files
      && (cached.protocol || 0) >= 3 && !(cached.unresolved || []).length) {
      const had = new Set(Object.values(cached.files).map((f) => f && f.h));
      const freshHashes = new Map(); // hash → one path that has it
      for (const [p, f] of Object.entries(files)) {
        if (f && f.h && !had.has(f.h) && !freshHashes.has(f.h)) freshHashes.set(f.h, p);
      }
      const changed = freshHashes.size > 0
        || Object.keys(files).length !== Object.keys(cached.files).length
        || Object.entries(files).some(([p, f]) => !cached.files[p] || cached.files[p].h !== f.h)
        || (cached.source || {}).sha !== manifest.source.sha
        || !!(cached.source || {}).dirty !== !!manifest.source.dirty;
      const bytes = [...freshHashes.values()].reduce((n, p) => n + files[p].s, 0);
      if (changed && freshHashes.size <= INLINE_MAX_BLOBS && bytes <= INLINE_MAX_BYTES) {
        try {
          const blobs = {};
          for (const [h, p] of freshHashes) {
            blobs[h] = (await readFile(path.join(ROOT, "dist", p.slice(1)))).toString("base64");
          }
          // Omit the blobs key when empty: a pre-inline worker would persist it
          // verbatim into the stored manifest (it only strips what it knows).
          const res = await (await req(api(`${id}/commit`), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...(freshHashes.size ? { ...manifest, blobs } : manifest), baseVersion: cached.version, clientProtocol: CLIENT_PROTOCOL }),
          })).json();
          log(`${id}: ${total} files, ${freshHashes.size} blobs inline (${(bytes / 1e6).toFixed(1)} MB), v${res.version}${manifest.source.dirty ? " \x1b[33m[dirty]\x1b[0m" : ""}`);
          await writePubCache(id, { version: res.version, files, source: manifest.source, protocol: cached.protocol, unresolved: [] });
          return res.version;
        } catch (e) {
          // A refusal is a verdict, not a transport hiccup: the classic path would
          // upload blobs and then be told the same thing. Report it here.
          if (e.info && e.info.error === "cli-outdated") dieOutdated(id, e.info.minProtocol);
          if (e.info && e.info.error === "unpublish-refused") {
            dieUnpublish(id, e.info.removed || [], e.info.count || (e.info.removed || []).length);
          }
          if (e.info && e.info.error === "stale-base") {
            log(`${id}: someone published v${e.info.liveVersion} since my last — reconciling`);
          } else {
            log(`${id}: fast commit declined (${e.message.slice(0, 80)}) — classic path`);
          }
        }
      }
    }

    const check = await (await req(api(`${id}/check`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files }),
    })).json();
    // Too old to be allowed: stop HERE, before uploading a single blob. The commit
    // would refuse anyway (426 cli-outdated), and the difference between finding out
    // now and finding out after the upload is the whole point of check advertising it.
    if (check.minProtocol && CLIENT_PROTOCOL < check.minProtocol) {
      selfUpdate(`this instance requires publish protocol ${check.minProtocol}`); // exits on success
      dieOutdated(id, check.minProtocol);
    }
    // Behind the instance, but not below its floor (or it has none). This used to read
    // "for the faster path", which is how a correctness problem gets filed as a
    // performance tip and ignored: what an older client actually loses is the GUARD.
    // Below protocol 3 it sends no `baseVersion`, so the store cannot tell whether this
    // tree was built on what is live, and a stale checkout can revert whoever published
    // last with neither of them seeing it happen.
    if (!warnedSkew && check.protocol && check.protocol > CLIENT_PROTOCOL) {
      warnedSkew = true;
      const unguarded = CLIENT_PROTOCOL < 3 && check.protocol >= 3;
      // Try to make the problem go away before describing it.
      selfUpdate(`${ORIGIN} speaks publish protocol ${check.protocol}, this clone ${CLIENT_PROTOCOL}`);
      log(`⚠ this clone speaks publish protocol ${CLIENT_PROTOCOL}; ${ORIGIN} speaks ${check.protocol}, and it could not be updated automatically.`);
      if (unguarded) {
        log(`  Publishes from this clone are NOT covered by the revert guard: it cannot tell the`);
        log(`  store what version it was built on, so a stale tree can roll back someone else's`);
        log(`  work silently.`);
      }
      // Addressed to the agent. Whoever is being helped has no reason to know this is a
      // git checkout, and should never be handed a git command to run.
      log(`  AGENT: update the engine clone at ${ROOT} yourself and re-run. Do not ask the`);
      log(`  person you are working for to do it.`);
    }

    // ── The store guard: can this publish prove it contains what is live? ─────
    // Proof is one of: live is empty; live is exactly my own last publish from
    // this machine (version match); or live was built from a clean commit my
    // history contains (its content is in my tree, or I deliberately changed
    // it). No proof → reconcile against the live manifest: adopt what they
    // changed, fork what we both changed, never silently revert (see
    // lib/publish-resolve.mjs). `unresolved` paths (a shared file where theirs
    // is live and mine is not) force re-classification every publish until
    // someone merges — the version match alone must not ship mine over theirs.
    if (!resolution && id !== "_engine") {
      const clean = !(cached && (cached.unresolved || []).length);
      const safe = check.liveVersion === 0
        || (clean && cached && cached.version === check.liveVersion)
        || (clean && check.liveSource && check.liveSource.sha && !check.liveSource.dirty
          && isAncestor(sourceDir, check.liveSource.sha));
      if (!safe) {
        const live = await (await req(api(`${id}/manifest`))).json();
        const spaceBase = (manifest.space || {}).default ? "" : "/" + id;
        resolution = await resolvePublish({
          id, manifest, live, sourceDir, spaceBase,
          liveSource: check.liveSource || (live.source
            ? { sha: live.source.sha || null, dirty: !!live.source.dirty, actor: live.source.actor } : null),
          cached, fetchBlob, log, warn: log, dry: DRY,
          canTouchTree: !!targetSpace, who: whoFor(sourceDir),
        });
        if (resolution.changedTree) {
          await runBuild(`${id}: rebuilding with adopted live content…`);
          continue; // re-read the manifest; patches (if any) apply next pass
        }
        if (resolution.patches) continue; // re-check with the patched file set
      }
    }

    const missing = new Set(check.missing || []);
    const toUpload = Object.entries(files).filter(([, f]) => missing.has(f.h));
    // Blobs are content-addressed: many paths can share one hash; upload each once.
    const uniq = new Map();
    for (const [p, f] of toUpload) if (!uniq.has(f.h)) uniq.set(f.h, p);
    const bytes = [...uniq.values()].reduce((n, p) => n + files[p].s, 0);
    log(`${id}: ${total} files, ${uniq.size} blobs to upload (${(bytes / 1e6).toFixed(1)} MB), live v${check.liveVersion}${manifest.source.dirty ? " \x1b[33m[dirty]\x1b[0m" : ""}`);
    // Same verdict the commit will reach, reached before uploading anything — and the
    // only place --dry-run can surface it, since a dry run never commits. `livePrefixes`
    // is absent on older instances; the commit still refuses there.
    if (!ALLOW_UNPUBLISH && check.livePrefixes) {
      const keep = new Set((manifest.routing || {}).publicPrefixes || []);
      const removed = [...new Set(check.livePrefixes)].filter((p) => !keep.has(p));
      if (removed.length) dieUnpublish(id, removed, removed.length);
    }
    if (DRY) return null;

    // True no-op: live already holds these exact files AND this exact provenance
    // (sha + dirty) — a commit would bump the version without changing anything.
    if (check.filesUnchanged && check.liveSource
      && check.liveSource.sha === manifest.source.sha
      && !!check.liveSource.dirty === !!manifest.source.dirty) {
      log(`${id}: unchanged — commit skipped (live v${check.liveVersion})`);
      await writePubCache(id, { version: check.liveVersion, files, source: manifest.source, protocol: check.protocol || 0, unresolved: [] });
      return check.liveVersion;
    }

    const entries = [...uniq.entries()];
    let done = 0, failed = 0;
    const workers = Array.from({ length: 8 }, async () => {
      while (entries.length) {
        const [h, p] = entries.pop();
        const body = await readFile(path.join(ROOT, "dist", p.slice(1)));
        for (let tryN = 0; ; tryN++) {
          try {
            await req(api(`${id}/blob/${h}`), { method: "PUT", body });
            done++;
            if (done % 200 === 0) log(`${id}: ${done}/${uniq.size} blobs…`);
            break;
          } catch (e) {
            if (tryN >= 2) { failed++; log(`${id}: blob ${h.slice(0, 12)} failed: ${e.message}`); break; }
          }
        }
      }
    });
    await Promise.all(workers);
    if (failed) die(`${id}: ${failed} blob uploads failed — nothing committed, live site untouched. ${MEANWHILE}`);

    let res;
    try {
      res = await (await req(api(`${id}/commit`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify((check.protocol || 0) >= 3
          ? { ...manifest, baseVersion: check.liveVersion, clientProtocol: CLIENT_PROTOCOL }
          : { ...manifest, clientProtocol: CLIENT_PROTOCOL }),
      })).json();
    } catch (e) {
      // Reachable when the early check couldn't see it (an instance predating
      // `livePrefixes`, or someone else publishing in between).
      if (e.info && e.info.error === "cli-outdated") dieOutdated(id, e.info.minProtocol);
      if (e.info && e.info.error === "unpublish-refused") {
        dieUnpublish(id, e.info.removed || [], e.info.count || (e.info.removed || []).length);
      }
      if (e.info && e.info.error === "stale-base") {
        // Live moved between my check and my commit — re-evaluate from scratch.
        log(`${id}: live moved to v${e.info.liveVersion} mid-publish — re-evaluating`);
        resolution = null;
        cached = readPubCache(id);
        continue;
      }
      throw e;
    }
    if (resolution && resolution.forks) {
      for (const f of resolution.forks) {
        log(`${id}: conflict resolved — ${f.folder} is ${f.theirs}'s, yours lives at ${f.fork} (both live)`);
      }
    }
    await writePubCache(id, {
      version: res.version, files, source: manifest.source,
      protocol: check.protocol || 0,
      unresolved: (resolution && resolution.unresolved) || [],
    });
    return res.version;
  }
  die(`${id}: live kept changing while publishing — re-run. ${MEANWHILE}`);
}

let results = [];
if (ALL || ENGINE_ONLY) {
  // Config, engine chrome and every space are independent pipelines — run them
  // concurrently (each is its own check/upload/commit chain against its own
  // manifest); total time is the slowest chain, not the sum.
  const jobs = [];
  if (!DRY) {
    jobs.push([null, (async () => {
      const inst = await readFile(path.join(ROOT, "dist", "__config", "instance.json"), "utf8");
      await req(api("_instance/config"), { method: "POST", headers: { "content-type": "application/json" }, body: inst });
      log("instance config pushed");
    })()]);
  }
  jobs.push(["_engine", publishOne("_engine", ROOT)]);
  if (!ENGINE_ONLY) for (const id of Object.keys(byId)) jobs.push([id, publishOne(id, byId[id])]);
  const settled = await Promise.allSettled(jobs.map(([, p]) => p));
  const failed = settled.filter((s) => s.status === "rejected");
  for (const f of failed) log(`FAILED: ${f.reason && f.reason.message}`);
  if (failed.length) die(`${failed.length} target(s) failed — see above. ${MEANWHILE}`);
  results = jobs
    .map(([id], i) => [id, settled[i].value])
    .filter(([id]) => id !== null);
} else {
  results.push([targetSpace, await publishOne(targetSpace, byId[targetSpace])]);
}

log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
if (DRY) { console.log("(dry-run, nothing shipped)"); process.exit(0); }
const spaceMeta = (id) => {
  try { return JSON.parse(readFileSync(path.join(byId[id], "space.json"), "utf8")); } catch (e) { return {}; }
};
const last = results[results.length - 1];
const base = last[0] === "_engine" || (spaceMeta(last[0]) || {}).default ? "" : `/${last[0]}/`;
console.log(`${ORIGIN}${base}  v${last[1]}`);
