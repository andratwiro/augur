// `augur clone` then `augur publish` — what you download publishes again, unchanged.
//
// `C-clone-publish-roundtrip`. Found on staging against a freshly provisioned workspace:
// the clone came out fine and the publish back died in the build — "[catalog] could not
// read …/registry.json — the overlay catalog is REQUIRED and has no fallback" — and clone's
// own closing line admitted it could not recover that file. Leaving is free only if what
// you download publishes again; a tree that cannot be published is an export, not a clone.
//
// The workspace under test is the real worker behind an HTTP server, furnished the way a
// hosted workspace is furnished: the SEED PACK, written by `publishSeedPack` — the same
// document and the same write a provisioning makes, which is exactly the shape staging had.
// The CLI talks to it over the same routes it talks to a deployment, from a cloned folder
// with no `.git`, which is what a hosted workspace may never have anything else of.
//
// THREE CLAIMS, in the order a person meets them:
//
//   1. THE SOURCE ROUND-TRIPS. The tree the clone wrote REBUILDS into what is live: every
//      URL present on both sides, every authored file — the prototypes, the skill, the
//      root documents — byte-identical or different in the volatile head alone (og meta
//      stamped from an origin the seed did not know; the tolerance the publish itself
//      applies), and the composition graph byte-identical, because it is derived from the
//      catalog and the skill inventory and is the whole footprint of both. Judged on the
//      BUILT manifest, not the commit. The generated indexes are held to presence only:
//      their card order is recency, which for a repo-less tree is file mtime — the clone
//      moment — so two builds of one tree can order a status group differently.
//   2. AN UNCHANGED PUBLISH LEAVES LIVE ALONE. The seed yields to a real publish only where
//      the SOURCE changed (`F-seed-yields-to-real-publish`, judged on the pre-decoration
//      hash `sh`), so after a publish of the untouched clone every unit still carries the
//      seed pack's bytes AND its seed marker. Asserted directly on live, per unit.
//   3. AN EDIT LANDS, AND ONLY THE EDIT. After one file changes, that unit is the person's
//      — new bytes, no seed marker — while every other unit is still the seed's, bytes and
//      marker alike. A plain publish, no flags: the command a person actually runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import worker, { __testables as W } from "../src/_worker.js";
import { publishSeedPack } from "../src/seed-pack.mjs";
import { isSeedSource } from "../src/provenance.mjs";
import { unitPaths } from "../src/publish-units.mjs";
import { buildSeedPack } from "../scripts/lib/seed-pack-build.mjs";
import { stripVolatileHead } from "../scripts/lib/publish-conflict.mjs";
import { classify } from "../scripts/lib/materialize.mjs";

const ENGINE = fileURLToPath(new URL("..", import.meta.url));
const TOKEN = "startok";
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

// ── the instance: the real worker, over HTTP, furnished with the seed pack ──────────

function memKv() {
  const store = new Map();
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async getWithMetadata(k) { return { value: store.get(k) ?? null, metadata: null }; },
    async put(k, v) { store.set(k, typeof v === "string" ? v : JSON.stringify(v)); },
    async delete(k) { store.delete(k); },
    async list({ prefix = "" } = {}) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}
function memR2() {
  const store = new Map();
  const obj = (k) => {
    const v = store.get(k);
    return {
      key: k, size: v.byteLength, body: v,
      async text() { return Buffer.from(v).toString("utf8"); },
      async arrayBuffer() { return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength); },
    };
  };
  return {
    store,
    async head(k) { return store.has(k) ? { key: k, size: store.get(k).byteLength } : null; },
    async get(k) { return store.has(k) ? obj(k) : null; },
    async put(k, v) { store.set(k, typeof v === "string" ? Buffer.from(v) : Buffer.from(v)); },
    async delete(k) { store.delete(k); },
    // `delimiter` matters: loadManifests discovers spaces from `delimitedPrefixes`, and a
    // stub that ignores it makes every check answer "live v0" — a store with nothing in it.
    async list({ prefix = "", delimiter = "" } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix));
      if (!delimiter) return { objects: keys.map((key) => ({ key })), truncated: false };
      const objects = [], delimitedPrefixes = new Set();
      for (const key of keys) {
        const rest = key.slice(prefix.length), i = rest.indexOf(delimiter);
        if (i === -1) objects.push({ key });
        else delimitedPrefixes.add(prefix + rest.slice(0, i + delimiter.length));
      }
      return { objects, delimitedPrefixes: [...delimitedPrefixes], truncated: false };
    },
  };
}

async function instance() {
  const kv = memKv();
  await kv.put("publish:tokens", JSON.stringify({ [await W.tokenFor(`pub:${TOKEN}`)]: { space: "*", label: "ci" } }));
  const r2 = memR2();
  const env = { COMMENTS: kv, BUNDLES: r2, GV_ASSET_SOURCE: "r2" };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      const request = new Request(`http://127.0.0.1${req.url}`, {
        method: req.method, headers: req.headers,
        ...(req.method === "GET" || req.method === "HEAD" ? {} : { body }),
      });
      const quiet = console.log; console.log = () => {};
      let out;
      try { out = await worker.fetch(request, env, { waitUntil() {} }); }
      catch (e) { out = new Response(String(e && e.stack), { status: 500 }); }
      finally { console.log = quiet; }
      res.writeHead(out.status, Object.fromEntries(out.headers));
      res.end(Buffer.from(await out.arrayBuffer()));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const api = async (p) => {
    const r = await fetch(`${origin}/__publish/${p}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (!r.ok) throw new Error(`GET ${p} → ${r.status}`);
    return r;
  };
  return {
    env, kv, r2, server, origin,
    manifest: async (id) => (await api(`${id}/manifest`)).json(),
    blob: async (id, h) => Buffer.from(await (await api(`${id}/blob/${h}`)).arrayBuffer()),
  };
}

// The CLI's dist/ is derived from the script's own location and `node --test` runs files
// in parallel, so the commands run out of a private copy of the engine — a fresh clone in
// a tmpdir — exactly as test/publish-cwd-wins.test.mjs does, and for the same reason.
const COPY_EXCLUDE = new Set([".git", "node_modules", "dist", ".wrangler", "test"]);
function isolatedEngineCopy() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "augur-roundtrip-engine-"));
  fs.cpSync(ENGINE, root, {
    recursive: true,
    filter: (src) => {
      const name = path.basename(src);
      if (name.startsWith(".env")) return false;
      return !COPY_EXCLUDE.has(name);
    },
  });
  return root;
}

const run = (engineRoot, script, args, { cwd, origin, home, env = {} }) => new Promise((resolve) => {
  // execFile ASYNC, never sync: a sync child blocks this event loop, so the in-process
  // server could never answer and the command would hang until its own timeout.
  execFile(process.execPath, [path.join(engineRoot, "scripts", script), ...args], {
    cwd,
    env: {
      ...process.env,
      HOME: home, // no publish cache, no saved credentials, nothing of this machine's
      AUGUR_ORIGIN: origin, AUGUR_TOKEN: TOKEN, AUGUR_NO_SELF_UPDATE: "1",
      ...env,
    },
    maxBuffer: 64 * 1024 * 1024,
  }, (err, stdout, stderr) => resolve({ code: err ? err.code || 1 : 0, out: `${stdout}${stderr}` }));
});

// ── comparators ────────────────────────────────────────────────────────────────────

/** The one clock reading an authored page carries: the head the publish itself ignores. */
const settled = (html) => stripVolatileHead(html);

/** Every URL a source tree would own, plus the graph derived from its catalog and skill. */
const isAuthored = (url, prefixes) => classify(url, prefixes).kind === "source" || url.endsWith("/graph.js");

/**
 * Does `built` (a manifest the build wrote, with bytes under `distRoot`) rebuild what `live`
 * holds? Presence is judged over every URL; bytes over the authored ones only.
 */
async function rebuildReport({ built, distRoot, live, blob }) {
  const prefixes = live.routing.publicPrefixes;
  const report = { missing: [], extra: [], bytes: [], pages: [], pagesVolatileOnly: [], generatedDiffer: [] };
  const liveUrls = Object.keys(live.files), builtUrls = new Set(Object.keys(built.files));
  for (const u of liveUrls) if (!builtUrls.has(u)) report.missing.push(u);
  for (const u of builtUrls) if (!(u in live.files)) report.extra.push(u);
  for (const u of liveUrls) {
    if (!builtUrls.has(u)) continue;
    const mine = built.files[u].h, theirs = live.files[u].h;
    if (mine === theirs) continue;
    if (!isAuthored(u, prefixes)) { report.generatedDiffer.push(u); continue; }
    if (!/\.html?$/i.test(u)) { report.bytes.push(u); continue; }
    const a = fs.readFileSync(path.join(distRoot, u.slice(1)), "utf8");
    const b = (await blob(theirs)).toString("utf8");
    if (settled(a) === settled(b)) report.pagesVolatileOnly.push(u);
    else report.pages.push(u);
  }
  return report;
}

/** The units of `after` that still hold `before`'s bytes, file for file, and their markers. */
function unitsAgainst(before, after) {
  const same = [], changed = [], seed = [], person = [];
  for (const u of before.routing.publicPrefixes) {
    const bp = unitPaths(before, u), ap = unitPaths(after, u);
    const identical = bp.length === ap.length && bp.every((p) => after.files[p] && after.files[p].h === before.files[p].h);
    (identical ? same : changed).push(u);
    (isSeedSource((after.routing.unitSources || {})[u]) ? seed : person).push(u);
  }
  return { same, changed, seed, person };
}

const PACK = buildSeedPack({ engineRoot: ENGINE });
const SPACE = PACK.space.id;
const EDIT_UNIT = "/start-here/sample-with-comments/";
const EDIT_FILE = "start-here/prototypes/sample-with-comments/index.html";
const EDIT_URL = `${EDIT_UNIT}index.html`;
const MARKER = "ROUNDTRIP_EDIT_7f3a";

test("⚠️ A CLONE OF A SEEDED WORKSPACE PUBLISHES BACK — the source round-trips, live keeps the seed, one edit lands alone", async () => {
  const inst = await instance();
  const engineCopy = isolatedEngineCopy();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "augur-roundtrip-"));
  const home = path.join(work, "home");
  const cloneDir = path.join(work, "clone");
  fs.mkdirSync(home, { recursive: true });
  try {
    // A workspace furnished the way provisioning furnishes one.
    await publishSeedPack({ store: inst.env.BUNDLES, pack: PACK, workspaceId: "local", origin: inst.origin, at: "2026-09-02T10:00:00.000Z" });
    const live1 = await inst.manifest(SPACE);
    assert.equal(live1.version, 1);
    const units = live1.routing.publicPrefixes;
    assert.equal(unitsAgainst(live1, live1).seed.length, units.length, "the pack did not mark every unit as the seed's");

    // ── 1. clone ──────────────────────────────────────────────────────────────────
    const cloned = await run(engineCopy, "clone.mjs", ["--space", SPACE, "--out", cloneDir], { cwd: work, origin: inst.origin, home });
    assert.equal(cloned.code, 0, cloned.out);
    assert.ok(fs.existsSync(path.join(cloneDir, "space.json")), "no space.json in the clone");
    assert.ok(!fs.existsSync(path.join(cloneDir, ".git")), "a clone is repo-less on purpose");
    // The build's own inputs are source files of the tree and they came with it.
    for (const f of ["registry.json", "prototype-status.json", "skills/starter-ui/skill.json"]) {
      assert.ok(fs.existsSync(path.join(cloneDir, f)), `${f} did not travel with the clone:\n${cloned.out}`);
    }
    assert.ok(!/cannot recover[^\n]*registry\.json/i.test(cloned.out), `clone still says it cannot recover registry.json:\n${cloned.out}`);

    // ── 2. publish --dry-run, changing nothing: THE SOURCE ROUND-TRIPS ───────────
    const publishEnv = { cwd: cloneDir, origin: inst.origin, home, env: { GV_SPACES_ROOT: cloneDir } };
    const dry = await run(engineCopy, "publish.mjs", ["--dry-run"], publishEnv);
    assert.ok(!/\[catalog\]/.test(dry.out), `the build died on the overlay catalog:\n${dry.out}`);
    assert.ok(!/build failed/i.test(dry.out), `the build failed:\n${dry.out}`);
    assert.equal(dry.code, 0, dry.out);

    const built = JSON.parse(fs.readFileSync(path.join(engineCopy, "dist", "__manifests", `${SPACE}.json`), "utf8"));
    const r = await rebuildReport({ built, distRoot: path.join(engineCopy, "dist"), live: live1, blob: (h) => inst.blob(SPACE, h) });
    const show = (k) => (r[k].length ? `\n  ${k}: ${r[k].join(", ")}` : "");
    const problems = ["missing", "extra", "bytes", "pages"].filter((k) => r[k].length);
    assert.equal(problems.length, 0,
      `the clone does not rebuild into what is live:${show("missing")}${show("extra")}${show("bytes")}${show("pages")}${show("pagesVolatileOnly")}${show("generatedDiffer")}`);
    // The six prototypes in particular: identical, or different in the head alone.
    for (const u of units) assert.ok(!r.pages.includes(`${u}index.html`), `${u} came back different`);

    // ── 2b. a real publish, still changing nothing: LIVE KEEPS THE SEED ──────────
    const same = await run(engineCopy, "publish.mjs", [], publishEnv);
    assert.ok(!/\[catalog\]/.test(same.out), same.out);
    assert.equal(same.code, 0, same.out);
    const live2 = await inst.manifest(SPACE);
    const after2 = unitsAgainst(live1, live2);
    assert.deepEqual(after2.changed, [], `an unchanged publish changed ${after2.changed.join(", ")}`);
    assert.deepEqual(after2.person, [], `an unchanged publish took ${after2.person.join(", ")} from the seed`);
    assert.deepEqual(live2.routing.publicPrefixes.slice().sort(), units.slice().sort(), "the set of units moved");
    // The skill, the catalog, the baseline: the seed's bytes, still.
    for (const u of Object.keys(live1.files).filter((p) => isAuthored(p, units) && !units.some((x) => p.startsWith(x)))) {
      assert.equal((live2.files[u] || {}).h, live1.files[u].h, `${u} changed under an unchanged publish`);
    }
    // What the CLI did with a tree that changed nothing is reported, not asserted: today it
    // is a version that carries no new authored byte (see the CARRY in the commit).
    const minted2 = live2.version > live1.version;

    // ── 3. change one file and publish, plainly: THE EDIT LANDS, AND ONLY THE EDIT ─
    const file = path.join(cloneDir, EDIT_FILE);
    assert.ok(fs.existsSync(file), `${EDIT_FILE} is not in the clone`);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("</body>", `<p>${MARKER}</p>\n</body>`));
    const edited = await run(engineCopy, "publish.mjs", [], publishEnv);
    assert.ok(!/\[catalog\]/.test(edited.out), edited.out);
    assert.equal(edited.code, 0, edited.out);
    assert.ok(!/would fork|conflict —/.test(edited.out), `the edit was treated as a conflict:\n${edited.out}`);
    const live3 = await inst.manifest(SPACE);
    assert.ok(live3.version > live2.version, `the edit did not produce a new version (${live3.version})`);
    const after3 = unitsAgainst(live1, live3);
    assert.deepEqual(after3.changed, [EDIT_UNIT], `the wrong units changed: ${after3.changed.join(", ") || "none"}`);
    assert.deepEqual(after3.person, [EDIT_UNIT], `the wrong units became a person's: ${after3.person.join(", ") || "none"}`);
    assert.equal(after3.seed.length, units.length - 1, "an untouched unit lost the seed marker");
    const page = (await inst.blob(SPACE, live3.files[EDIT_URL].h)).toString("utf8");
    assert.ok(page.includes(MARKER), "the edit is not in the page that is live");
    // And the catalog still rides: the same graph, byte for byte, from the same registry.
    const graphUrl = Object.keys(live1.files).find((u) => u.endsWith("/graph.js"));
    assert.ok(graphUrl, "the seed publishes no composition graph");
    assert.equal(live3.files[graphUrl].h, live1.files[graphUrl].h, "the composition graph changed across the round trip");

    console.log(`[roundtrip] unchanged publish: v${live1.version} → v${live2.version}${minted2 ? " (a version with nothing new)" : " (no version minted)"}; edit: v${live3.version}`);
  } finally {
    inst.server.close();
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(engineCopy, { recursive: true, force: true });
  }
});

test("the seed pack carries the build's own inputs, so a provisioned workspace can be cloned and published", () => {
  // The staging failure in one line: the pack is what a fresh workspace is furnished with,
  // and a pack without the catalog furnishes a workspace whose clone cannot be built.
  for (const p of ["/registry.json", "/prototype-status.json", "/skills/starter-ui/skill.json"]) {
    assert.ok(p in PACK.files, `the seed pack does not carry ${p} (${Object.keys(PACK.files).length} files)`);
  }
  const bytes = Buffer.from(PACK.files["/registry.json"].b64, "base64");
  assert.equal(sha256(bytes), PACK.files["/registry.json"].h);
  const reg = JSON.parse(bytes.toString("utf8"));
  assert.ok(Array.isArray(reg.items) && reg.items.length > 0, "the catalog in the pack is empty");
  assert.deepEqual(reg, JSON.parse(fs.readFileSync(path.join(ENGINE, "seed", "registry.json"), "utf8")),
    "the pack's registry is not seed/registry.json verbatim");
});
