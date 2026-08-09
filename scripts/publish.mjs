// publish.mjs — incremental direct publish: build a space, upload only the blobs
// the store doesn't hold, commit its manifest (an atomic pointer flip).
//
//   node scripts/publish.mjs --space <id>     publish one space
//   node scripts/publish.mjs --all            publish every space + engine chrome
//                                             + push the instance config
//   … --dry-run                               diff against the store, ship nothing
//
// Run from a space repo (a cwd with space.json) the --space flag is inferred.
// Contract (agents rely on this): synchronous, zero prompts, exit code = truth,
// "<live url>  v<version>" is the LAST line on stdout; progress goes to stderr.
//
// Auth: AUGUR_TOKEN env (a publish token minted in the Admin panel, or the
// instance's .env.deploy). Target: AUGUR_ORIGIN env, else the instance's
// deploy.config.json siteOrigin. Provenance: the space repo's git sha + a dirty
// flag ride in the manifest (a working-tree publish is visible, never hidden).

import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findShellDir, deployConfig } from "./lib/instance.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const log = (msg) => console.error(`\x1b[32m[publish]\x1b[0m ${msg}`);
const die = (msg) => { log(msg); process.exit(1); };

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const DRY = flag("--dry-run");
const ALL = flag("--all");
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
if (!TOKEN) die("no publish token — run `augur login` once (uses your web credentials).");

// Space discovery: sibling clones (the god-mode layout) or ./spaces mounts —
// same filter build.js applies. cwd inference: running inside a space repo
// publishes THAT space.
const PARENT = path.join(ROOT, "..");
let spaceDirs = [];
try {
  spaceDirs = readdirSync(PARENT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".")
      && existsSync(path.join(PARENT, e.name, "space.json")))
    .map((e) => path.join(PARENT, e.name));
} catch (e) {}
const usingSiblings = spaceDirs.length > 0;
const SPACES_ROOT = process.env.GV_SPACES_ROOT || (usingSiblings ? PARENT : path.join(ROOT, "spaces"));
if (!usingSiblings) {
  try {
    spaceDirs = readdirSync(SPACES_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(path.join(SPACES_ROOT, e.name, "space.json")))
      .map((e) => path.join(SPACES_ROOT, e.name));
  } catch (e) {}
}
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

let targetSpace = opt("--space");
if (!targetSpace && !ALL && !ENGINE_ONLY && existsSync(path.join(process.cwd(), "space.json"))) {
  targetSpace = idOf(process.cwd());
}
if (!targetSpace && !ALL && !ENGINE_ONLY) die("name a target: --space <id>, --all, --engine, or run from a space repo.");
if (targetSpace && !byId[targetSpace]) die(`unknown space "${targetSpace}" (have: ${Object.keys(byId).join(", ")})`);

// ── build (single space unless --all; engine chrome always emitted) ──────────
const SHELL_DIR = findShellDir(ROOT);
const IDENTITY_PATH = process.env.GV_IDENTITY_PATH
  || (SHELL_DIR && existsSync(path.join(SHELL_DIR, "identity.json")) ? path.join(SHELL_DIR, "identity.json") : null);
const DEPLOY_CONFIG_PATH = process.env.GV_DEPLOY_CONFIG_PATH
  || (SHELL_DIR && existsSync(path.join(SHELL_DIR, "deploy.config.json")) ? path.join(SHELL_DIR, "deploy.config.json") : null);
const BUILD_ENV = {
  ...process.env,
  GV_SPACES_ROOT: SPACES_ROOT,
  ...(IDENTITY_PATH ? { GV_IDENTITY_PATH: IDENTITY_PATH } : {}),
  ...(DEPLOY_CONFIG_PATH ? { GV_DEPLOY_CONFIG_PATH: DEPLOY_CONFIG_PATH } : {}),
  ...(targetSpace ? { GV_ONLY_SPACE: targetSpace } : {}),
  ...(ENGINE_ONLY ? { GV_ENGINE_ONLY: "1" } : {}),
};
// Identity-less checkout (the collaborator layout — no deploy shell anywhere):
// fetch the instance's sanitized contributor profiles so editor chips survive
// the build. Without this, publishing from a bare clone silently strips every
// card face site-wide (the chips are matched against identity at build time).
if (!IDENTITY_PATH) {
  try {
    const r = await fetch(`${ORIGIN}/__publish/_instance/profiles`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (r.ok) {
      const { profiles } = await r.json();
      const os = await import("node:os");
      const { writeFile } = await import("node:fs/promises");
      const f = path.join(os.tmpdir(), `augur-profiles-${process.pid}.json`);
      await writeFile(f, JSON.stringify(profiles));
      BUILD_ENV.GV_IDENTITY_PATH = f;
      log(`contributor profiles fetched (${profiles.length}) — card faces preserved`);
    } else {
      log(`profiles unavailable (${r.status}) — publishing without editor faces`);
    }
  } catch (e) {
    log("profiles fetch failed — publishing without editor faces");
  }
}

const started = Date.now();
log(`building ${targetSpace || "all spaces"}…`);
const code = await new Promise((resolve) => {
  spawn("node", ["build.js"], { cwd: ROOT, env: BUILD_ENV, stdio: ["ignore", 2, 2] }).on("close", resolve);
});
if (code !== 0) die(`build failed (exit ${code})`);

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
      die(`${path.basename(dir)} is a SHALLOW clone — edit dates and editor chips would all collapse to the clone moment. Run \`git -C ${dir} fetch --unshallow origin\` first.`);
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
// The publish-protocol version this CLI speaks; check responses echo the
// worker's. Newer worker → nudge the operator to pull; older worker → the
// fast path's failure fallback already degrades gracefully.
const CLIENT_PROTOCOL = 2;
let warnedSkew = false;

// ── the digest protocol, per target ──────────────────────────────────────────
const api = (p) => `${ORIGIN}/__publish/${p}`;
const auth = { Authorization: `Bearer ${TOKEN}` };
async function req(url, init = {}) {
  const r = await fetch(url, { ...init, headers: { ...auth, ...(init.headers || {}) } });
  if (!r.ok && r.status !== 204) {
    const body = await r.text().catch(() => "");
    throw new Error(`${init.method || "GET"} ${url} → ${r.status} ${body.slice(0, 300)}`);
  }
  return r;
}

async function publishOne(id, sourceDir) {
  if (id !== "_engine") refuseShallow(sourceDir);
  const manifest = JSON.parse(await readFile(path.join(ROOT, "dist", "__manifests", id + ".json"), "utf8"));
  manifest.source = { ...repoState(sourceDir), actor: process.env.USER || "" };
  const files = manifest.files;
  const total = Object.keys(files).length;

  // Fast path: with a cache of the last commit, a small delta ships as ONE
  // request — the commit carries its fresh blobs base64-inline. Any failure
  // (stale cache, older worker, sentinel) falls through to the classic path.
  const cached = readPubCache(id);
  if (!DRY && cached && cached.files) {
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
          body: JSON.stringify(freshHashes.size ? { ...manifest, blobs } : manifest),
        })).json();
        log(`${id}: ${total} files, ${freshHashes.size} blobs inline (${(bytes / 1e6).toFixed(1)} MB), v${res.version}${manifest.source.dirty ? " \x1b[33m[dirty]\x1b[0m" : ""}`);
        await writePubCache(id, { version: res.version, files, source: manifest.source });
        return res.version;
      } catch (e) {
        log(`${id}: fast commit declined (${e.message.slice(0, 80)}) — classic path`);
      }
    }
  }

  const check = await (await req(api(`${id}/check`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ files }),
  })).json();
  if (!warnedSkew && check.protocol && check.protocol > CLIENT_PROTOCOL) {
    warnedSkew = true;
    log(`⚠ the instance speaks publish protocol ${check.protocol} (this clone: ${CLIENT_PROTOCOL}) — \`git pull\` your engine checkout for the faster path.`);
  }
  const missing = new Set(check.missing || []);
  const toUpload = Object.entries(files).filter(([, f]) => missing.has(f.h));
  // Blobs are content-addressed: many paths can share one hash; upload each once.
  const uniq = new Map();
  for (const [p, f] of toUpload) if (!uniq.has(f.h)) uniq.set(f.h, p);
  const bytes = [...uniq.values()].reduce((n, p) => n + files[p].s, 0);
  log(`${id}: ${total} files, ${uniq.size} blobs to upload (${(bytes / 1e6).toFixed(1)} MB), live v${check.liveVersion}${manifest.source.dirty ? " \x1b[33m[dirty]\x1b[0m" : ""}`);
  if (DRY) return null;

  // True no-op: live already holds these exact files AND this exact provenance
  // (sha + dirty) — a commit would bump the version without changing anything.
  if (check.filesUnchanged && check.liveSource
    && check.liveSource.sha === manifest.source.sha
    && !!check.liveSource.dirty === !!manifest.source.dirty) {
    log(`${id}: unchanged — commit skipped (live v${check.liveVersion})`);
    await writePubCache(id, { version: check.liveVersion, files, source: manifest.source });
    return check.liveVersion;
  }

  const entries = [...uniq.entries()];
  let done = 0, failed = 0;
  const workers = Array.from({ length: 8 }, async () => {
    while (entries.length) {
      const [h, p] = entries.pop();
      const body = await readFile(path.join(ROOT, "dist", p.slice(1)));
      for (let attempt = 0; ; attempt++) {
        try {
          await req(api(`${id}/blob/${h}`), { method: "PUT", body });
          done++;
          if (done % 200 === 0) log(`${id}: ${done}/${uniq.size} blobs…`);
          break;
        } catch (e) {
          if (attempt >= 2) { failed++; log(`${id}: blob ${h.slice(0, 12)} failed: ${e.message}`); break; }
        }
      }
    }
  });
  await Promise.all(workers);
  if (failed) die(`${id}: ${failed} blob uploads failed — nothing committed, live site untouched.`);

  const res = await (await req(api(`${id}/commit`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(manifest),
  })).json();
  await writePubCache(id, { version: res.version, files, source: manifest.source });
  return res.version;
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
  if (failed.length) die(`${failed.length} target(s) failed — see above.`);
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
