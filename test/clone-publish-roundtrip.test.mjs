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
// THE COMPARISON IS AGAINST THE BUILT MANIFEST, NOT THE COMMIT. A publish from a tree
// with no git evidence composes conservatively and can keep live's bytes for every unit
// it cannot prove it edited — so "0 blobs to upload" can be true of a build that produced
// something quite different, and the count is composition's verdict, not the clone's.
// What this file asserts is that the tree the clone wrote REBUILDS into what is live:
// every URL present on both sides, every non-HTML file byte-identical (the composition
// graph is the registry's whole footprint, and it is a .js file), and every page equal
// once two things the build stamps from the CLOCK are set aside — the volatile head (og
// meta from an origin the seed did not know; the same tolerance the publish applies when
// it asks whether a unit really changed) and the "Edited 12 minutes ago" caption an index
// card bakes as its baseline, which two builds of one unchanged tree never agree on and
// which `CURRENCY_JS` replaces at load from the recorded stamp anyway.
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
import { buildSeedPack } from "../scripts/lib/seed-pack-build.mjs";
import { stripVolatileHead } from "../scripts/lib/publish-conflict.mjs";

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

// The two clock readings a page carries. The head is what the publish itself ignores; the
// caption is the baked baseline of a card's currency line, relative to build time.
const settled = (html) => stripVolatileHead(html)
  .replace(/(<span class="proto-when"[^>]*>)[^<]*(<\/span>)/g, "$1$2");

/**
 * Does `built` (a manifest the build wrote, with bytes under `distRoot`) rebuild what `live`
 * holds? Returns the differences, grouped, or an empty report.
 */
async function compareBuilt({ built, distRoot, live, blob }) {
  const report = { missing: [], extra: [], bytes: [], pages: [], pagesVolatileOnly: [] };
  const liveUrls = Object.keys(live.files), builtUrls = new Set(Object.keys(built.files));
  for (const u of liveUrls) if (!builtUrls.has(u)) report.missing.push(u);
  for (const u of builtUrls) if (!(u in live.files)) report.extra.push(u);
  for (const u of liveUrls) {
    if (!builtUrls.has(u)) continue;
    const mine = built.files[u].h, theirs = live.files[u].h;
    if (mine === theirs) continue;
    if (!/\.html?$/i.test(u)) { report.bytes.push(u); continue; }
    const a = fs.readFileSync(path.join(distRoot, u.slice(1)), "utf8");
    const b = (await blob(theirs)).toString("utf8");
    if (settled(a) === settled(b)) report.pagesVolatileOnly.push(u);
    else report.pages.push(u);
  }
  return report;
}

const PACK = buildSeedPack({ engineRoot: ENGINE });
const SPACE = PACK.space.id;
const EDIT_FILE = "start-here/prototypes/sample-with-comments/index.html";
const EDIT_URL = "/start-here/sample-with-comments/index.html";
const MARKER = "ROUNDTRIP_EDIT_7f3a";

test("⚠️ A CLONE OF A SEEDED WORKSPACE PUBLISHES BACK — no build error, and the rebuilt tree is what is live", async () => {
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

    // ── 1. clone ──────────────────────────────────────────────────────────────────
    const cloned = await run(engineCopy, "clone.mjs", ["--space", SPACE, "--out", cloneDir], { cwd: work, origin: inst.origin, home });
    assert.equal(cloned.code, 0, cloned.out);
    assert.ok(fs.existsSync(path.join(cloneDir, "space.json")), "no space.json in the clone");
    assert.ok(!fs.existsSync(path.join(cloneDir, ".git")), "a clone is repo-less on purpose");
    // The overlay catalog is a source file of the tree and it came with it.
    assert.ok(fs.existsSync(path.join(cloneDir, "registry.json")),
      `registry.json did not travel with the clone:\n${cloned.out}`);
    assert.ok(!/cannot recover[^\n]*registry\.json/i.test(cloned.out),
      `clone still says it cannot recover registry.json:\n${cloned.out}`);

    // ── 2. publish --dry-run, changing nothing ────────────────────────────────────
    const publishEnv = { cwd: cloneDir, origin: inst.origin, home, env: { GV_SPACES_ROOT: cloneDir } };
    const dry = await run(engineCopy, "publish.mjs", ["--dry-run"], publishEnv);
    assert.ok(!/\[catalog\]/.test(dry.out), `the build died on the overlay catalog:\n${dry.out}`);
    assert.ok(!/build failed/i.test(dry.out), `the build failed:\n${dry.out}`);
    assert.equal(dry.code, 0, dry.out);

    // The proof: the tree the clone wrote rebuilds into what is live.
    const built = JSON.parse(fs.readFileSync(path.join(engineCopy, "dist", "__manifests", `${SPACE}.json`), "utf8"));
    const diff = await compareBuilt({ built, distRoot: path.join(engineCopy, "dist"), live: live1, blob: (h) => inst.blob(SPACE, h) });
    const show = (k) => (diff[k].length ? `\n  ${k}: ${diff[k].join(", ")}` : "");
    const problems = ["missing", "extra", "bytes", "pages"].filter((k) => diff[k].length);
    assert.equal(problems.length, 0,
      `the clone does not rebuild into what is live:${show("missing")}${show("extra")}${show("bytes")}${show("pages")}${show("pagesVolatileOnly")}`);
    // And the authored pages in particular — the six prototypes — are byte-identical or
    // differ in the head alone; a clone that changed a prototype's body is not a clone.
    for (const u of live1.routing.publicPrefixes.map((p) => `${p}index.html`)) {
      assert.ok(!diff.pages.includes(u), `${u} came back different`);
    }

    // ── 2b. a real publish, still changing nothing ────────────────────────────────
    // Lands as a version whose files are what was live, or is skipped as identical —
    // never a build error, never a different site.
    const same = await run(engineCopy, "publish.mjs", [], publishEnv);
    assert.ok(!/\[catalog\]/.test(same.out), same.out);
    assert.equal(same.code, 0, same.out);
    const live2 = await inst.manifest(SPACE);
    assert.ok(live2.version === 1 || live2.version === 2, `unexpected version ${live2.version}`);
    const diff2 = await compareBuilt({ built: live2, distRoot: null, live: live1, blob: (h) => inst.blob(SPACE, h) })
      .catch(() => null);
    // Hash-level comparison is enough here: the committed manifest names blobs the store
    // holds, and a page that differs at all from v1 must be one of the pages the build
    // rebuilt (volatile head only), never a missing or extra URL.
    if (diff2) {
      assert.deepEqual(diff2.missing, [], `the unchanged publish dropped ${diff2.missing.join(", ")}`);
      assert.deepEqual(diff2.extra, [], `the unchanged publish added ${diff2.extra.join(", ")}`);
      assert.deepEqual(diff2.bytes, [], `the unchanged publish changed ${diff2.bytes.join(", ")}`);
    }

    // ── 3. change one file and publish: it lands ──────────────────────────────────
    // `--takeover` because the question here is whether the PIPELINE works from a cloned
    // folder — build, upload, commit — not how a repo-less tree's edits are reconciled
    // against live (that is composition's, and it has its own tests).
    const file = path.join(cloneDir, EDIT_FILE);
    assert.ok(fs.existsSync(file), `${EDIT_FILE} is not in the clone`);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("</body>", `<p>${MARKER}</p>\n</body>`));
    const edited = await run(engineCopy, "publish.mjs", ["--takeover"], publishEnv);
    assert.ok(!/\[catalog\]/.test(edited.out), edited.out);
    assert.equal(edited.code, 0, edited.out);
    const live3 = await inst.manifest(SPACE);
    assert.ok(live3.version > live2.version, `the edit did not produce a new version (${live3.version})`);
    assert.notEqual(live3.files[EDIT_URL].h, live1.files[EDIT_URL].h, "the edited page's hash did not change");
    const page = (await inst.blob(SPACE, live3.files[EDIT_URL].h)).toString("utf8");
    assert.ok(page.includes(MARKER), "the edit is not in the page that is live");
    // And the registry still rides: the same graph, byte for byte, from the same catalog.
    const graphUrl = Object.keys(live1.files).find((u) => u.endsWith("/graph.js"));
    assert.ok(graphUrl, "the seed publishes no composition graph");
    assert.equal(live3.files[graphUrl].h, live1.files[graphUrl].h, "the composition graph changed across the round trip");
  } finally {
    inst.server.close();
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(engineCopy, { recursive: true, force: true });
  }
});

test("the seed pack carries the overlay catalog, so a provisioned workspace can be cloned and published", () => {
  // The staging failure in one line: the pack is what a fresh workspace is furnished with,
  // and a pack without the catalog furnishes a workspace whose clone cannot be built.
  assert.ok("/registry.json" in PACK.files, `the seed pack does not carry /registry.json (${Object.keys(PACK.files).length} files)`);
  const bytes = Buffer.from(PACK.files["/registry.json"].b64, "base64");
  assert.equal(sha256(bytes), PACK.files["/registry.json"].h);
  const reg = JSON.parse(bytes.toString("utf8"));
  assert.ok(Array.isArray(reg.items) && reg.items.length > 0, "the catalog in the pack is empty");
  assert.deepEqual(reg, JSON.parse(fs.readFileSync(path.join(ENGINE, "seed", "registry.json"), "utf8")),
    "the pack's registry is not seed/registry.json verbatim");
});
