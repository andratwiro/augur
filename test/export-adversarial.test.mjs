// Trying to BREAK export/restore, rather than trying to watch it work.
//
// `MIG-export-adversarial`. `export-full-roundtrip.test.mjs` next door proves the happy
// path: a copy taken from one instance, replayed into another, compared family by family.
// That is the wrong question to stop on before moving a live workspace. The question here
// is the opposite one — what does this path do when it is INTERRUPTED, when it is pointed
// at the wrong target, when it is run twice, when the copy on disk is subtly wrong, when a
// value the source holds is one the destination cannot hold?
//
// THE BAR EVERY CASE IS HELD TO: succeed correctly, or fail with a clear error. Never
// silently produce a corrupted or partial restore that reports success. Where the answer
// today is "it is fine but nobody would know", that is written down as an assertion too,
// because an unstated property is one somebody optimises away.
//
// Same harness as the round-trip file: the real worker behind an HTTP server, driven by
// the real scripts, so what is under test is the command an operator runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import worker, { __testables as W } from "../src/_worker.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function memKv(initial = {}) {
  const store = new Map(Object.entries(initial));
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
function memR2(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async head(k) { return store.has(k) ? { size: 1 } : null; },
    async get(k) {
      if (!store.has(k)) return null;
      const o = store.get(k);
      return { body: o.body, httpMetadata: o.httpMetadata, text: async () => Buffer.from(o.body).toString("utf8") };
    },
    async put(k, v, opts) { store.set(k, { body: Buffer.from(v), httpMetadata: (opts || {}).httpMetadata }); },
    async delete(k) { store.delete(k); },
    // ⚠️ `delimiter` IS IMPLEMENTED HERE ON PURPOSE, and it is not a detail.
    // `loadManifests` enumerates spaces from `delimitedPrefixes`, so a fake that ignores
    // the option answers "this instance publishes nothing" — the build stamp comes back
    // with `spaces: {}`, `augur export` walks `_engine` alone, and a round-trip test over a
    // seeded space passes without the space ever having been in the copy. That is the exact
    // shape of vacuous pass this file exists to hunt, so the harness may not have it.
    async list({ prefix = "", delimiter = "" } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix));
      if (!delimiter) return { objects: keys.map((key) => ({ key })), truncated: false };
      const objects = [], prefixes = new Set();
      for (const key of keys) {
        const i = key.indexOf(delimiter, prefix.length);
        if (i === -1) objects.push({ key });
        else prefixes.add(key.slice(0, i + delimiter.length));
      }
      return { objects, delimitedPrefixes: [...prefixes], truncated: false };
    },
  };
}

const sha256 = async (buf) => {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

// Several files, and BIG ones, because half of what this file is about is what an
// interrupted transfer leaves behind and a one-byte blob is never interrupted.
const FILES = Object.fromEntries(
  Array.from({ length: 6 }, (_, i) => [`/toolkit/w/f${i}.html`, Buffer.alloc(300_000, `${i}`)]),
);
const CSS = Buffer.from("body{}");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);

/** Give the server a chance to answer a request that is deliberately slow. */
const holdOpen = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * ⚠️ POINT THE PER-ISOLATE MANIFEST CACHE AT THIS INSTANCE BEFORE TALKING TO IT.
 *
 * A deployed isolate serves ONE deployment, so the engine resolves the workspace id once
 * per isolate and caches that workspace's parsed manifests under it for ~1.5s. Several fake
 * instances in one process therefore SHARE both: they all resolve to the first config
 * written, and the second instance's `/_build.json` answers with the first one's manifests
 * until the tick expires. Every guard that consults the live build stamp — the whole
 * "would this bury newer content" question — is then being asked about the wrong instance,
 * and it answers "no" whatever the target actually holds.
 *
 * That is a property of this harness, not of the product, and it is worth knowing about
 * because it makes a guard test pass for a reason unrelated to what it asserts. Forcing a
 * reload against the env under test is instant and exact; waiting the tick out also works
 * and costs 1.7 seconds a switch.
 */
const WORKSPACE_ID = "ws";
const focus = (inst) => W.loadManifests(WORKSPACE_ID, inst.env, true);

// ⚠️ EVERY INSTANCE IN THIS FILE GETS ITS OWN WORKSPACE ID.
// The manifest cache, the config cache and the freeze cache are all module-level and keyed
// by workspace — correct in production, where an isolate serves one deployment, and a trap
// in a test file that stands several fake instances up inside one process. Two instances
// both called `default` share a cached view, so a target reads back the SOURCE's build
// stamp and every guard that consults it is being tested against the wrong instance.
async function instance({ slowBlobsMs = 0, breakStamp = false, rooms = false } = {}) {
  const kv = memKv();
  await kv.put("publish:tokens", JSON.stringify({ [await W.tokenFor("pub:startok")]: { space: "*", label: "ci" } }));
  const r2 = memR2();
  const tenantId = WORKSPACE_ID;
  // `rtOrigin` is what makes `/__rt` answer 426 rather than 501 — the one cheap signal
  // that says whether this deployment's boards live in rooms or only in KV.
  await r2.put("config/instance.json", Buffer.from(JSON.stringify({
    tenantId, users: [], ...(rooms ? { rtOrigin: "http://127.0.0.1:9" } : {}),
  })));
  const env = { COMMENTS: kv, BUNDLES: r2, GV_ASSET_SOURCE: "r2" };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      // A target whose public build stamp cannot be read. Not a contrivance: an empty store,
      // a 500, a CDN error page and a wrong origin all present this way to a restore.
      if (breakStamp && req.url.startsWith("/_build.json")) { res.writeHead(503); res.end("nope"); return; }
      const request = new Request(`http://127.0.0.1${req.url}`, {
        method: req.method,
        headers: req.headers,
        ...(req.method === "GET" || req.method === "HEAD" ? {} : { body }),
      });
      if (slowBlobsMs && /\/blob\//.test(req.url) && req.method === "GET") await holdOpen(slowBlobsMs);
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
  return { env, kv, r2, server, tenantId, origin: `http://127.0.0.1:${server.address().port}` };
}

async function manifests() {
  const files = {};
  for (const [p, buf] of Object.entries(FILES)) files[p] = { h: await sha256(buf), ct: "text/html", s: buf.length };
  return {
    space: {
      id: "alpha", version: 3, format: 1,
      space: { id: "alpha", default: true },
      source: { sha: "abc123", dirty: false, actor: "someone" },
      files,
      routing: { publicPrefixes: ["/toolkit/w/"], versionMap: {} },
      publishedAt: "2026-08-01T00:00:00.000Z",
    },
    engine: {
      id: "_engine", version: 1, format: 1,
      source: { sha: "eng123", dirty: false },
      files: { "/_chrome.css": { h: await sha256(CSS), ct: "text/css", s: CSS.length } },
      routing: { publicPrefixes: [], versionMap: {} },
      publishedAt: "2026-08-01T00:00:00.000Z",
    },
  };
}

/** A source instance with content, a canvas image, a board and something in most families. */
async function seeded(opts = {}) {
  const inst = await instance(opts);
  const M = await manifests();
  const pngHash = (await sha256(PNG)).slice(0, 40);
  for (const [k, v] of Object.entries({
    "users:roster": { add: { "a@x.test": { email: "a@x.test", role: "editor" } }, remove: ["gone@x.test"] },
    "users:names": { "a@x.test": "Ada" },
    "users:lastseen:a@x.test": "2026-08-01T00:00:00.000Z",
    statuses: { "/toolkit/w/": "dev-ready" },
    names: { "/toolkit/w/": "Widget" },
    canvases: { "/b/one/": { name: "One", by: "a@x.test", t: 1 } },
    "pins:a@x.test": { "/q/": { label: "Q", href: "/q/" } },
    "c:/toolkit/w/": [{ id: "t1", messages: [{ author: "Ada", body: "hello" }] }],
    "board:/b/one/": { name: "One", nodes: [{ id: "n1", src: "/__asset/" + pngHash }], clock: 4 },
    ["basset-meta:" + pngHash]: { ct: "image/png", bytes: PNG.length, at: "2026-08-01T00:00:00.000Z" },
    "users:secrets": { "a@x.test": "pbkdf2$100000$salt$hash" },
  })) await inst.kv.put(k, JSON.stringify(v));
  await inst.r2.put("spaces/alpha/manifest.json", Buffer.from(JSON.stringify(M.space)));
  await inst.r2.put("spaces/_engine/manifest.json", Buffer.from(JSON.stringify(M.engine)));
  for (const buf of Object.values(FILES)) await inst.r2.put("blobs/" + (await sha256(buf)), buf);
  await inst.r2.put("blobs/" + (await sha256(CSS)), CSS);
  await inst.r2.put(W.ASSET_R2_PREFIX + pngHash, PNG, { httpMetadata: { contentType: "image/png" } });
  inst.pngHash = pngHash;
  return inst;
}

function run(script, args, origin, { kill = 0 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [path.join(ROOT, "scripts", script), ...args], {
      cwd: ROOT,
      env: { ...process.env, AUGUR_ORIGIN: origin, AUGUR_TOKEN: "startok" },
    }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, out: `${stdout}${stderr}`, killed: !!(err && err.killed) }));
    if (kill) setTimeout(() => { try { child.kill("SIGKILL"); } catch (e) {} }, kill);
  });
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "augur-adv-"));
const blobsIn = (dir) => {
  try { return fs.readdirSync(path.join(dir, "blobs")); } catch (e) { return []; }
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. INTERRUPTION
// ─────────────────────────────────────────────────────────────────────────────

test("a KILLED export leaves no file that a resume would trust, and the resume completes it", async () => {
  // The item's first clause. The claim being tested is the comment on the skip logic — "a
  // hash that is present is by definition the right bytes" — which holds only if the write
  // that produced the file was all-or-nothing. Killed mid-write it is not, and every later
  // run then reports a complete copy over bytes that are short.
  const from = await seeded({ slowBlobsMs: 400 });
  const dir = tmp();
  try {
    await focus(from);
    const killed = await run("export.mjs", ["--out", dir], from.origin, { kill: 350 });
    // A kill that happened to land after the last write is not a failure of this test; what
    // must never be true is a SHORT file wearing a finished name.
    for (const name of blobsIn(dir)) {
      assert.ok(!name.endsWith(".part"), `a partial file was left with a name a resume reads: ${name}`);
      const bytes = fs.readFileSync(path.join(dir, "blobs", name));
      assert.equal(await sha256(bytes), name,
        `${name} is on disk under a name that does not match its bytes — every later export will skip it`);
    }
    assert.notEqual(killed.code, 0, "the killed run should not have reported success");

    // And the resume finishes the job.
    await focus(from);
    const resumed = await run("export.mjs", ["--out", dir], from.origin);
    assert.equal(resumed.code, 0, resumed.out);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "export.json"), "utf8"));
    assert.equal(blobsIn(dir).length, meta.blobs, "the resumed copy is short of the blobs it claims");
    for (const name of blobsIn(dir)) {
      assert.equal(await sha256(fs.readFileSync(path.join(dir, "blobs", name))), name);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); from.server.close(); }
});

test("a SHORT blob left by an older export is re-fetched, not skipped forever", async () => {
  // The same failure as above, already on disk — an atomic write cannot repair a file a
  // previous version of this command wrote. The manifest records every blob's length, so
  // "present" can mean "present and the right length" for the price of one stat.
  const from = await seeded();
  const dir = tmp();
  try {
    await focus(from);
    assert.equal((await run("export.mjs", ["--out", dir], from.origin)).code, 0);
    const victim = blobsIn(dir).find((n) => fs.statSync(path.join(dir, "blobs", n)).size > 1000);
    assert.ok(victim, "no blob big enough to truncate");
    const full = fs.readFileSync(path.join(dir, "blobs", victim));
    fs.writeFileSync(path.join(dir, "blobs", victim), full.subarray(0, 100));

    await focus(from);
    const again = await run("export.mjs", ["--out", dir], from.origin);
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /wrong length/, "a truncated blob was skipped in silence");
    assert.deepEqual(fs.readFileSync(path.join(dir, "blobs", victim)), full, "the short blob was not repaired");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); from.server.close(); }
});

test("a corrupt blob the export cannot detect is still refused by the RESTORE, with nothing committed", async () => {
  // Defence in depth, and worth pinning because it is what makes the whole path safe rather
  // than merely careful: the store hashes what it is given. A copy corrupted in a way no
  // length check can see cannot become live content.
  const from = await seeded();
  const to = await instance();
  const dir = tmp();
  try {
    await focus(from);
    assert.equal((await run("export.mjs", ["--out", dir], from.origin)).code, 0);
    const victim = blobsIn(dir).find((n) => fs.statSync(path.join(dir, "blobs", n)).size > 1000);
    const buf = fs.readFileSync(path.join(dir, "blobs", victim));
    buf[10] ^= 0xff; // same length, different bytes
    fs.writeFileSync(path.join(dir, "blobs", victim), buf);

    await focus(to);
    const restored = await run("restore.mjs", [dir], to.origin);
    assert.equal(restored.code, 1, restored.out);
    assert.match(restored.out, /nothing committed, live untouched/);
    assert.equal(await to.r2.get("spaces/alpha/manifest.json"), null,
      "a corrupt copy reached the live manifest");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); from.server.close(); to.server.close(); }
});

test("a blob the copy is MISSING stops the restore before anything is committed", async () => {
  const from = await seeded();
  const to = await instance();
  const dir = tmp();
  try {
    await focus(from);
    assert.equal((await run("export.mjs", ["--out", dir], from.origin)).code, 0);
    fs.unlinkSync(path.join(dir, "blobs", blobsIn(dir)[0]));
    await focus(to);
    const restored = await run("restore.mjs", [dir], to.origin);
    assert.equal(restored.code, 1, restored.out);
    assert.match(restored.out, /not in this export/);
    assert.equal(await to.r2.get("spaces/alpha/manifest.json"), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); from.server.close(); to.server.close(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. RESTORING OVER SOMETHING
// ─────────────────────────────────────────────────────────────────────────────

test("a restore REFUSES to bury live content newer than the copy, and --force is the only way past", async () => {
  // The item's second clause.
  const from = await seeded();
  const to = await seeded();
  const dir = tmp();
  try {
    await focus(from);
    assert.equal((await run("export.mjs", ["--out", dir], from.origin)).code, 0);
    // The target holds DIFFERENT content, published after the copy was taken — somebody
    // else's work, which is the only thing this guard exists to protect.
    const live = JSON.parse((await to.r2.get("spaces/alpha/manifest.json")).body.toString());
    live.publishedAt = new Date(Date.now() + 60_000).toISOString();
    delete live.files["/toolkit/w/f0.html"];
    await to.r2.put("spaces/alpha/manifest.json", Buffer.from(JSON.stringify(live)));

    await focus(to);
    const refused = await run("restore.mjs", [dir], to.origin);
    assert.equal(refused.code, 1, refused.out);
    assert.match(refused.out, /is NEWER than this copy/);
    assert.match(refused.out, /--force/, "the refusal did not say how to mean it");

    await focus(to);
    const forced = await run("restore.mjs", [dir, "--force"], to.origin);
    assert.equal(forced.code, 0, forced.out);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); from.server.close(); to.server.close(); }
});

test("the newer-than guard is stamped from when the export STARTED, not when it finished", async () => {
  // The window this closes: a publish that lands DURING an export is not in the copy, but
  // stamped at the end the copy's own date is LATER than that publish's, so the guard reads
  // the live site as older and waves the restore through. On a real instance the export
  // takes minutes, and a migration without `--freeze` runs while people are publishing.
  const from = await seeded({ slowBlobsMs: 40 });
  const dir = tmp();
  try {
    await focus(from);
    const r = await run("export.mjs", ["--out", dir], from.origin);
    assert.equal(r.code, 0, r.out);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "export.json"), "utf8"));
    assert.ok(meta.finishedAt, "the copy does not record when it finished");
    assert.ok(meta.exportedAt <= meta.finishedAt);
    assert.ok(Date.parse(meta.finishedAt) - Date.parse(meta.exportedAt) > 0,
      "exportedAt is being taken after the work, so it does not cover the export window");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); from.server.close(); }
});

test("a target whose build stamp cannot be read says the guard is OFF rather than 'proceeding'", async () => {
  // An empty store is the expected reason and not the only one. Whatever the reason, the
  // next thing that happens is a publish over whatever is live with no date compared.
  const from = await seeded();
  const to = await instance({ breakStamp: true });
  const dir = tmp();
  try {
    await focus(from);
    assert.equal((await run("export.mjs", ["--out", dir], from.origin)).code, 0);
    await focus(to);
    const r = await run("restore.mjs", [dir], to.origin);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /guard is OFF/, "a restore with no date comparison did not say so");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); from.server.close(); to.server.close(); }
});

test("restoring TWICE changes nothing but the version number", async () => {
  // The item's third clause. Idempotence is what makes "safe to re-run after any failure"
  // true, which is the whole recovery story for a migration that dies halfway.
  const from = await seeded();
  const to = await instance();
  const dir = tmp();
  try {
    await focus(from);
    assert.equal((await run("export.mjs", ["--out", dir, "--full"], from.origin)).code, 0);
    await focus(to);
    const one = await run("restore.mjs", [dir, "--state"], to.origin);
    assert.equal(one.code, 0, one.out);
    const ctx = (i) => Object.freeze({ ...W.applyInstance({ users: [] }), tenantId: i.tenantId });
    const first = await W.exportState(ctx(to), to.env);
    const firstManifest = (await to.r2.get("spaces/alpha/manifest.json")).body.toString();

    // ⚠️ THE SECOND RUN IS THE POINT. A restore stamps `publishedAt` at commit, so its own
    // result is newer than the copy that made it — and read as a date alone, the
    // bury-protection guard fires on every re-run, including the one after a half-finished
    // migration. `migrate` passes no `--force` and promises in its own header that a failed
    // run is fixed by repeating it, so this must pass without one.
    await focus(to);
    const second = await run("restore.mjs", [dir, "--state"], to.origin);
    assert.equal(second.code, 0, second.out);
    assert.match(second.out, /this is a re-run/, "a re-run was allowed for some reason other than recognising itself");
    assert.match(second.out, /0 blobs to upload/, "a second restore re-uploaded blobs it had already sent");
    const after = await W.exportState(ctx(to), to.env);
    assert.deepEqual(after.families, first.families, "a second restore changed the state");
    assert.deepEqual(after.assets.sort(), first.assets.sort());

    // Only the version moves — deliberately, because a restore is an ordinary publish.
    const secondManifest = JSON.parse((await to.r2.get("spaces/alpha/manifest.json")).body.toString());
    assert.equal(secondManifest.version, JSON.parse(firstManifest).version + 1);
    assert.deepEqual(secondManifest.files, JSON.parse(firstManifest).files);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); from.server.close(); to.server.close(); }
});

test("a restore interrupted between the content and the state is finished by re-running it", async () => {
  // What a half-finished run leaves: the content, which is the half a site needs to serve
  // at all. Running it again converges — nothing has to be undone first.
  const from = await seeded();
  const to = await instance();
  const dir = tmp();
  try {
    await focus(from);
    assert.equal((await run("export.mjs", ["--out", dir, "--full"], from.origin)).code, 0);
    // Content only — exactly the state a run killed after the commits leaves behind.
    await focus(to);
    assert.equal((await run("restore.mjs", [dir], to.origin)).code, 0);
    const ctx = (i) => Object.freeze({ ...W.applyInstance({ users: [] }), tenantId: i.tenantId });
    const half = await W.exportState(ctx(to), to.env);
    assert.deepEqual(half.families["c:"], {}, "comments arrived without --state");

    await focus(to);
    const finish = await run("restore.mjs", [dir, "--state"], to.origin);
    assert.equal(finish.code, 0, finish.out);
    const whole = await W.exportState(ctx(to), to.env);
    const source = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
    assert.deepEqual(whole.families, source.families, "the re-run did not converge on the copy");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); from.server.close(); to.server.close(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. WHAT THE COPY DOES NOT CARRY, AND WHAT THE FAR SIDE CHANGES
// ─────────────────────────────────────────────────────────────────────────────

test("publish HISTORY is exported and NEVER replayed — and the restore says so", async () => {
  // `augur migrate` exports with `--history`, which walks every retained version and
  // downloads every blob any of them referenced. None of it is restored: the target holds
  // one version per space, so `rollback` on a migrated workspace reaches nothing. That is a
  // defensible trade and an indefensible surprise.
  const from = await seeded();
  const to = await instance();
  const dir = tmp();
  try {
    await from.r2.put("spaces/alpha/versions/2.json",
      Buffer.from(JSON.stringify({ ...(await manifests()).space, version: 2 })));
    await focus(from);
    const e = await run("export.mjs", ["--out", dir, "--history"], from.origin);
    assert.equal(e.code, 0, e.out);

    await focus(to);
    const r = await run("restore.mjs", [dir], to.origin);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /does not replay it/, "a copy with history was restored without saying history is dropped");
    assert.equal(JSON.parse((await to.r2.get("spaces/alpha/manifest.json")).body.toString()).version, 1,
      "the target should hold exactly the one version a restore creates");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); from.server.close(); to.server.close(); }
});

test("a restored canvas image keeps the type it was served as", async () => {
  // The destination takes an image's type from the request header and stores anything that
  // is not an image type as `image/jpeg`, cached immutable for a year. A restore that sends
  // no header therefore re-labels every PNG, GIF and WebP on the way in — and content
  // addressing cannot notice, because the bytes are right. Nothing that compares hashes,
  // including `augur migrate`'s own verification, can see it either.
  const from = await seeded();
  const to = await instance();
  const dir = tmp();
  try {
    await focus(from);
    assert.equal((await run("export.mjs", ["--out", dir, "--full"], from.origin)).code, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "assets.json"), "utf8"))[from.pngHash], "image/png",
      "the export did not record what type the image was served as");

    await focus(to);
    assert.equal((await run("restore.mjs", [dir, "--state"], to.origin)).code, 0);
    const landed = to.r2.store.get(W.ASSET_R2_PREFIX + from.pngHash);
    assert.deepEqual(Buffer.from(landed.body), PNG);
    assert.equal(landed.httpMetadata.contentType, "image/png",
      "a PNG arrived on the far side declared as something else");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); from.server.close(); to.server.close(); }
});

test("EMPTY and MISSING are the same thing for an overlay family and different for an identity one", async () => {
  // A restore is additive for a family the copy does not carry and destructive for one it
  // carries as empty — which is correct in both cases and NOT symmetric across families,
  // because only some of them can report absence at all.
  //
  //   `statuses` is a whole KV document read through the overlay accessor, and a missing
  //   document reads as `{}`. It is therefore never in `absent`, always in `families`, and
  //   a restore of a source that never had one CLEARS the target's.
  //
  //   `users:roles` is read straight from KV, so a missing document is `null`, lands in
  //   `absent`, and a restore LEAVES the target's alone.
  //
  // Both are defensible. What is not defensible is assuming the first behaves like the
  // second, which is the assumption anybody makes reading `absent` as "everything missing".
  const from = await instance(); // nothing seeded at all
  const M = await manifests();
  await from.r2.put("spaces/alpha/manifest.json", Buffer.from(JSON.stringify(M.space)));
  await from.r2.put("spaces/_engine/manifest.json", Buffer.from(JSON.stringify(M.engine)));
  for (const buf of Object.values(FILES)) await from.r2.put("blobs/" + (await sha256(buf)), buf);
  await from.r2.put("blobs/" + (await sha256(CSS)), CSS);

  const to = await seeded();
  const dir = tmp();
  try {
    await focus(from);
    assert.equal((await run("export.mjs", ["--out", dir, "--full"], from.origin)).code, 0);
    const doc = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
    assert.ok(doc.absent.includes("users:roles"), "an unwritten identity family should report absent");
    assert.deepEqual(doc.families.statuses, {},
      "an unwritten overlay family reports as empty, not absent — this is the asymmetry");
    assert.ok(!doc.absent.includes("statuses"));

    await focus(to);
    assert.equal((await run("restore.mjs", [dir, "--state", "--force"], to.origin)).code, 0);
    const after = await W.exportState(Object.freeze({ ...W.applyInstance({ users: [] }), tenantId: to.tenantId }), to.env);
    assert.deepEqual(after.families.statuses, {}, "an empty family did not clear the target's");
    assert.deepEqual(after.families["users:names"], { "a@x.test": "Ada" },
      "an ABSENT family was treated as empty and wiped the target's — that would be a silent deletion");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); from.server.close(); to.server.close(); }
});

test("a copy taken from an instance that could not read a family cannot be restored at all", async () => {
  // `failed` is the one signal that says "this copy is not what it looks like", and both
  // ends refuse on it: the export never writes such a document, and the import refuses one
  // if it somehow arrives.
  const to = await seeded();
  const res = await W.importState(
    Object.freeze({ ...W.applyInstance({ users: [] }), tenantId: to.tenantId }),
    to.env,
    { format: 1, families: { statuses: {} }, failed: [{ id: "c:", error: "kv exploded" }] },
  );
  assert.equal(res.ok, false);
  assert.equal(res.reason, "incomplete-export");
  to.server.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE BOARD, WHICH IS THE ONE FAMILY A COMPARISON CANNOT JUDGE
// ─────────────────────────────────────────────────────────────────────────────

test("a board is exported from the KV MIRROR, so nothing that compares two exports can see it drift", async () => {
  // `MIG-board-snapshot-via-ws` established that the authoritative board lives in the room
  // and KV holds a mirror written on a dirty alarm. The export reads the mirror. So does
  // the target's export after the restore. The two therefore MATCH whether or not the
  // mirror was current — measured on a live instance with nobody editing: mirror 21 nodes,
  // room 24.
  //
  // Demonstrated here by moving the mirror out from under a comparison that then passes.
  const from = await seeded();
  const to = await instance();
  const dir = tmp();
  try {
    await focus(from);
    assert.equal((await run("export.mjs", ["--out", dir, "--full"], from.origin)).code, 0);
    await focus(to);
    assert.equal((await run("restore.mjs", [dir, "--state"], to.origin)).code, 0);

    const ctx = (i) => Object.freeze({ ...W.applyInstance({ users: [] }), tenantId: i.tenantId });
    const a = await W.exportState(ctx(from), from.env);
    const b = await W.exportState(ctx(to), to.env);
    assert.deepEqual(b.families["board:"], a.families["board:"],
      "the two mirrors agree — which is exactly the reading `augur migrate` calls a pass");

    // And what that pass is worth: the room can hold anything at all and this is unmoved.
    assert.equal(a.families["board:"]["/b/one/"].nodes.length, 1);
    assert.ok(!JSON.stringify(a).includes("__rt"), "the export never reads a room");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); from.server.close(); to.server.close(); }
});

test("the commands that move a workspace say the board came from the mirror, and name the fix", async () => {
  // A property of the SOURCE, because the thing that must not regress is that neither
  // command can report a clean move over a stale board without saying so. `restore` names
  // the per-board command; `migrate` actually runs it, over a socket, and fails if it cannot.
  const restore = fs.readFileSync(path.join(ROOT, "scripts", "restore.mjs"), "utf8");
  const migrate = fs.readFileSync(path.join(ROOT, "scripts", "migrate.mjs"), "utf8");
  assert.match(restore, /board-snapshot/, "restore does not tell an operator the board needs moving separately");
  assert.match(migrate, /board-snapshot\.mjs/, "migrate verifies boards against the mirror and calls it a match");
  assert.match(migrate, /\bmove\b/);
  // And the freeze's own gap, written where an operator reads it rather than only in a doc.
  assert.match(migrate, /WebSocket upgrade is a GET/,
    "the freeze does not stop canvas editing, and the migration runner must say so");
});

const migrate = (from, to, dir) => new Promise((resolve) => {
  execFile(process.execPath, [path.join(ROOT, "scripts", "migrate.mjs"),
    "--from", from.origin, "--to", to.origin, "--out", dir], {
    cwd: ROOT,
    env: { ...process.env, AUGUR_FROM_TOKEN: "startok", AUGUR_TO_TOKEN: "startok" },
  }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, out: `${stdout}${stderr}` }));
});

test("/__rt is the discriminator a migration leans on: 501 means the KV board is the whole board", async () => {
  // `migrate` skips the socket-level board move when the source serves no rooms, because
  // there the KV document IS the board and the copy already carried it — and it REFUSES
  // when the source has rooms and the target does not, because then what landed is a stale
  // mirror nothing will ever correct. Both branches turn on this one status code, so it is
  // the thing that must not drift.
  //
  // Asserted one instance at a time. The config a request is answered with is cached per
  // ISOLATE for ~1.5s under the resolved workspace, so two instances in one process answer
  // each other's questions for a tick — see `focus` above; there is no force hook for the
  // config cache the way there is for manifests.
  const bare = await instance();
  try {
    const r = await fetch(`${bare.origin}/__rt?path=/b/one/`);
    assert.equal(r.status, 501, "a deployment with no rooms must be distinguishable from one with them");
    assert.equal((await r.json()).error, "realtime-not-configured");
  } finally { bare.server.close(); }

  await holdOpen(1700); // let the per-isolate config cache expire before the other shape
  const withRooms = await instance({ rooms: true });
  try {
    const r = await fetch(`${withRooms.origin}/__rt?path=/b/one/`);
    assert.equal(r.status, 426, "a deployment that serves rooms must not read as room-less");
  } finally { withRooms.server.close(); }
});

test("a migration between two room-less deployments SKIPS the board move, and says why", async () => {
  // The other half, and it has to be a skip rather than a failure: with no room anywhere,
  // nothing ever wrote that KV document but the rail itself, so the copy already holds the
  // whole board. Failing here would teach an operator to ignore the step that matters.
  const from = await seeded();
  const to = await instance();
  const dir = tmp();
  try {
    await focus(from);
    const r = await migrate(from, to, dir);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /serves no rooms/);
    assert.match(r.out, /Nothing to move over a socket/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); from.server.close(); to.server.close(); }
});
