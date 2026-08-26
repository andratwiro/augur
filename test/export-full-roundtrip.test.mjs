// `augur export --full` then `augur restore --state`, through the real scripts.
//
// `MIG-export-cli`. The endpoints are tested elsewhere; what this file is about is the two
// commands an operator actually runs, driven end to end against an instance that is the
// real worker. A copy is only worth what putting it back is worth, and the only way to know
// that is to put it back.
//
// The instance under test is `src/_worker.js` behind an HTTP server, so the scripts talk to
// it exactly as they talk to a deployment: a publish token, the same routes, the same
// refusals. Two of them — a source and a destination — so a restore is a restore rather
// than a re-write of the thing it came from.
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
    async list({ prefix = "" } = {}) {
      return { objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false };
    },
  };
}

// Real content, and REAL hashes: the store checks a blob against the name it is given, so
// a fixture with made-up hashes tests the guard rather than the round trip.
const PAGE = Buffer.from("<h1>hi");
const CSS = Buffer.from("body{}");
const sha256 = async (buf) => {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
};
const PAGE_H = await sha256(PAGE);
const CSS_H = await sha256(CSS);

const MANIFEST = {
  id: "alpha", version: 3, format: 1,
  space: { id: "alpha", default: true },
  source: { sha: "abc123", dirty: false, actor: "someone" },
  files: { "/toolkit/w/index.html": { h: PAGE_H, ct: "text/html", s: PAGE.length } },
  routing: { publicPrefixes: ["/toolkit/w/"], versionMap: {} },
  publishedAt: "2026-08-01T00:00:00.000Z",
};

/** A workspace with something in every family, plus one published space. */
async function instance() {
  const kv = memKv();
  await kv.put("publish:tokens", JSON.stringify({ [await W.tokenFor("pub:startok")]: { space: "*", label: "ci" } }));
  const r2 = memR2();
  const env = { COMMENTS: kv, BUNDLES: r2, GV_ASSET_SOURCE: "r2" };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      const request = new Request(`http://127.0.0.1${req.url}`, {
        method: req.method,
        headers: req.headers,
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
  return { env, kv, r2, server, origin: `http://127.0.0.1:${server.address().port}` };
}

// The engine chrome pseudo-space. The export walks every id in the build stamp, and an
// instance with no `_engine` manifest is one the stamp describes and the store does not —
// a real inconsistency the export is right to stop on, and not what these tests are about.
const ENGINE_MANIFEST = {
  id: "_engine", version: 1, format: 1,
  source: { sha: "eng123", dirty: false },
  files: { "/_chrome.css": { h: CSS_H, ct: "text/css", s: CSS.length } },
  routing: { publicPrefixes: [], versionMap: {} },
  publishedAt: "2026-08-01T00:00:00.000Z",
};

const IMG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]);
const imgHash = async () => {
  const digest = await crypto.subtle.digest("SHA-256", IMG);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
};

const run = (script, args, origin) => new Promise((resolve) => {
  // execFile ASYNC, never sync: a sync child blocks this event loop, so the in-process
  // server could never answer and the command would hang until its own timeout.
  execFile(process.execPath, [path.join(ROOT, "scripts", script), ...args], {
    cwd: ROOT,
    env: { ...process.env, AUGUR_ORIGIN: origin, AUGUR_TOKEN: "startok" },
  }, (err, stdout, stderr) => resolve({ code: err ? err.code || 1 : 0, out: `${stdout}${stderr}` }));
});

test("EXPORT --full THEN RESTORE --state PUTS EVERY FAMILY BACK", async () => {
  // The item's VERIFY, run for real: a copy taken from one instance, replayed into an empty
  // one, then compared family by family through the export route on the far side.
  const realHash = await imgHash();
  const from = await instanceWith(realHash);
  const to = await instance();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "augur-export-"));
  try {
    const exported = await run("export.mjs", ["--out", dir, "--full"], from.origin);
    assert.equal(exported.code, 0, exported.out);
    assert.match(exported.out, /state famil/);

    const meta = JSON.parse(fs.readFileSync(path.join(dir, "export.json"), "utf8"));
    assert.equal(meta.full, true);
    assert.ok(meta.state.families > 5, `only ${meta.state.families} families in the copy`);
    assert.equal(meta.state.assets, 1);
    assert.ok(fs.existsSync(path.join(dir, "state.json")));
    assert.ok(fs.existsSync(path.join(dir, "assets", realHash)), "the canvas image is not in the copy");

    // ⛔ And the thing that must never be in it.
    assert.ok(!fs.readFileSync(path.join(dir, "state.json"), "utf8").includes("pbkdf2"),
      "a password hash reached the backup directory");

    const restored = await run("restore.mjs", [dir, "--state"], to.origin);
    assert.equal(restored.code, 0, restored.out);

    // Compared through the far side's own export, which is the only comparison that says
    // the copy arrived rather than that the files were written.
    const before = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
    const after = await W.exportState(Object.freeze({ ...W.applyInstance({ users: [] }), tenantId: "acme" }), to.env);
    assert.deepEqual(after.families, before.families, "a family did not survive the round trip");
    assert.deepEqual(to.r2.store.get(W.ASSET_R2_PREFIX + realHash).body, IMG, "the canvas image did not survive");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    from.server.close(); to.server.close();
  }
});

/** The seeded instance, with the image's real hash woven through it. */
async function instanceWith(hash) {
  const inst = await instance();
  const kv = inst.kv;
  for (const [k, v] of Object.entries({
    "users:roster": { add: { "a@x.test": { email: "a@x.test", role: "editor" } }, remove: [] },
    "users:names": { "a@x.test": "Ada" },
    "users:lastseen:a@x.test": "2026-08-01T00:00:00.000Z",
    statuses: { "/p/": "dev-ready" },
    names: { "/p/": "Prototype" },
    canvases: { "/b/one/": { name: "One", by: "a@x.test", t: 1 } },
    "pins:a@x.test": { "/q/": { label: "Q", href: "/q/" } },
    "c:/p/": [{ id: "t1", messages: [{ author: "Ada", body: "hello" }] }],
    "board:/b/one/": { nodes: [{ id: "n1", src: "/__asset/" + hash }] },
    "pt:remarks": [{ id: 1, path: "/p/", text: "hi", ts: 1 }],
    ["basset-meta:" + hash]: { ct: "image/png", bytes: IMG.length, at: "2026-08-01T00:00:00.000Z" },
    "users:secrets": { "a@x.test": "pbkdf2$100000$salt$hash" },
  })) await kv.put(k, JSON.stringify(v));
  await inst.r2.put("spaces/alpha/manifest.json", Buffer.from(JSON.stringify(MANIFEST)));
  await inst.r2.put("spaces/_engine/manifest.json", Buffer.from(JSON.stringify(ENGINE_MANIFEST)));
  await inst.r2.put("blobs/" + PAGE_H, PAGE);
  await inst.r2.put("blobs/" + CSS_H, CSS);
  await inst.r2.put(W.ASSET_R2_PREFIX + hash, IMG, { httpMetadata: { contentType: "image/png" } });
  return inst;
}

test("a content-only copy SAYS SO, and a restore refuses to pretend otherwise", async () => {
  // The failure this prevents: somebody takes a nightly copy without `--full`, needs it a
  // year later, runs a restore with `--state`, and is told nothing.
  const from = await instance();
  await from.r2.put("spaces/alpha/manifest.json", Buffer.from(JSON.stringify(MANIFEST)));
  await from.r2.put("spaces/_engine/manifest.json", Buffer.from(JSON.stringify(ENGINE_MANIFEST)));
  await from.r2.put("blobs/" + PAGE_H, PAGE);
  await from.r2.put("blobs/" + CSS_H, CSS);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "augur-export-"));
  try {
    const exported = await run("export.mjs", ["--out", dir], from.origin);
    assert.equal(exported.code, 0, exported.out);
    assert.match(exported.out, /content only/, "a content-only copy did not say so");
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "export.json"), "utf8")).full, false,
      "`full: false` must be written rather than omitted, or a restore cannot tell the two apart");
    assert.equal(fs.existsSync(path.join(dir, "state.json")), false);

    const restored = await run("restore.mjs", [dir, "--state"], from.origin);
    assert.equal(restored.code, 1, restored.out);
    assert.match(restored.out, /content only/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    from.server.close();
  }
});

test("a full copy NUDGES a restore that forgot --state", async () => {
  // The opposite mistake, and the quieter one: the content comes back, the comments do not,
  // and nobody notices for a week.
  const from = await instanceWith(await imgHash());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "augur-export-"));
  try {
    assert.equal((await run("export.mjs", ["--out", dir, "--full"], from.origin)).code, 0);
    const restored = await run("restore.mjs", [dir], from.origin);
    assert.equal(restored.code, 0, restored.out);
    assert.match(restored.out, /pass --state/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    from.server.close();
  }
});

test("--full needs a star-scope token, and says which", async () => {
  const from = await instance();
  await from.kv.put("publish:tokens", JSON.stringify({
    [await W.tokenFor("pub:startok")]: { space: "alpha", label: "ci-alpha" },
  }));
  await from.r2.put("spaces/alpha/manifest.json", Buffer.from(JSON.stringify(MANIFEST)));
  await from.r2.put("spaces/_engine/manifest.json", Buffer.from(JSON.stringify(ENGINE_MANIFEST)));
  await from.r2.put("blobs/" + PAGE_H, PAGE);
  await from.r2.put("blobs/" + CSS_H, CSS);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "augur-export-"));
  try {
    const r = await run("export.mjs", ["--out", dir, "--full"], from.origin);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /STAR-SCOPE/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    from.server.close();
  }
});
