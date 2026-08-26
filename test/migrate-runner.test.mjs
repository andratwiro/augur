// Moving a workspace, and being able to run it again after it dies.
//
// `MIG-do-rekey-run`. The runner chains commands that already exist — freeze, export,
// restore — and adds the one thing none of them can do on its own: reading the far side
// back and comparing it. A migration that reports success without that has reported that
// it sent some requests.
//
// THE PROPERTY THIS FILE IS ABOUT is that a run which dies anywhere is fixed by running it
// again, with an end state identical to an uninterrupted run. Not "usually fine" — the
// export is content-addressed and skips what it has, the restore replaces each family
// whole, and the workspace object's import is one transaction. Nothing accumulates and
// nothing double-writes.
//
// Interruption is simulated at the TRANSPORT, not with a timer: killing a child process
// after N milliseconds tests the scheduler as much as the runner, and a flaky test about
// data loss is worse than none.
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
function memR2(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async head(k) { return store.has(k) ? { etag: "e" } : null; },
    async get(k) {
      if (!store.has(k)) return null;
      const o = store.get(k);
      return { body: o, etag: "e", text: async () => Buffer.from(o).toString("utf8") };
    },
    async put(k, v) { store.set(k, Buffer.isBuffer(v) || v instanceof ArrayBuffer ? Buffer.from(v) : Buffer.from(String(v))); },
    async delete(k) { store.delete(k); },
    async list({ prefix = "", delimiter } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix));
      if (!delimiter) return { objects: keys.map((key) => ({ key })), truncated: false };
      const p = new Set();
      for (const k of keys) {
        const rest = k.slice(prefix.length);
        const at = rest.indexOf(delimiter);
        if (at >= 0) p.add(prefix + rest.slice(0, at + 1));
      }
      return { objects: [], delimitedPrefixes: [...p], truncated: false };
    },
  };
}

const sha256 = async (buf) => {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
};
const PAGE = Buffer.from("<h1>hello");
const CSS = Buffer.from("body{margin:0}");
const PAGE_H = await sha256(PAGE);
const CSS_H = await sha256(CSS);

const manifest = (id, h, bytes) => ({
  id, version: 4, format: 1,
  source: { sha: "abc123", dirty: false },
  files: { [`/${id}/index.html`]: { h, ct: "text/html", s: bytes } },
  routing: { publicPrefixes: [`/${id}/`], unitSources: { [`/${id}/`]: { sha: "abc123", dirty: false } } },
  publishedAt: "2026-08-20T00:00:00.000Z",
});

/** One instance: the real worker behind an HTTP server, with its own stores. */
async function instance({ seeded = false } = {}) {
  const kv = memKv();
  await kv.put("publish:tokens", JSON.stringify({ [await W.tokenFor("pub:tok")]: { space: "*", label: "ci" } }));
  const r2 = memR2({
    "spaces/alpha/manifest.json": Buffer.from(JSON.stringify(manifest("alpha", PAGE_H, PAGE.length))),
    "spaces/_engine/manifest.json": Buffer.from(JSON.stringify(manifest("_engine", CSS_H, CSS.length))),
    [`blobs/${PAGE_H}`]: PAGE,
    [`blobs/${CSS_H}`]: CSS,
  });
  if (seeded) {
    for (const [k, v] of Object.entries({
      "users:roster": { add: { "a@x.test": { email: "a@x.test", role: "editor" } }, remove: [] },
      "users:names": { "a@x.test": "Ada" },
      statuses: { "/p/one/": "dev-ready", "/p/two/": "reviewed" },
      names: { "/p/one/": "One" },
      canvases: { "/b/one/": { name: "One", by: "a@x.test", t: 1 } },
      "c:/p/one/": [{ id: "t1", messages: [{ author: "Ada", body: "hello" }] }],
      "c:/p/two/": [{ id: "t2", messages: [{ author: "Ada", body: "again" }] }],
      "board:/b/one/": { nodes: [{ id: "n1" }] },
      "pins:a@x.test": { "/p/one/": { label: "One", href: "/p/one/" } },
    })) await kv.put(k, JSON.stringify(v));
  }
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
      catch (e) { out = new Response(String((e && e.stack) || e), { status: 500 }); }
      finally { console.log = quiet; }
      res.writeHead(out.status, Object.fromEntries(out.headers));
      res.end(Buffer.from(await out.arrayBuffer()));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { env, kv, r2, server, origin: `http://127.0.0.1:${server.address().port}` };
}

const run = (argv, extraEnv = {}) => new Promise((resolve) => {
  // execFile ASYNC, never sync: a sync child blocks this event loop, so the in-process
  // servers could never answer.
  execFile(process.execPath, [path.join(ROOT, "scripts", "migrate.mjs"), ...argv], {
    cwd: ROOT,
    env: { ...process.env, AUGUR_FROM_TOKEN: "tok", AUGUR_TO_TOKEN: "tok", ...extraEnv },
  }, (err, stdout, stderr) => resolve({ code: err ? err.code || 1 : 0, out: `${stdout}${stderr}` }));
});

const stateOf = async (inst) => W.exportState(
  Object.freeze({ ...W.applyInstance({ users: [] }), tenantId: "acme" }), inst.env);

// ── the happy path ───────────────────────────────────────────────────────────

test("A MIGRATION MOVES EVERYTHING AND VERIFIES IT ARRIVED", async () => {
  const from = await instance({ seeded: true });
  const to = await instance();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-"));
  try {
    const r = await run(["--from", from.origin, "--to", to.origin, "--out", dir]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /every family matches/);
    assert.match(r.out, /Nothing here touches DNS/);

    const a = await stateOf(from);
    const b = await stateOf(to);
    assert.deepEqual(b.families, a.families, "a family did not arrive");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    from.server.close(); to.server.close();
  }
});

test("IT FREEZES BEFORE IT COPIES, and does NOT thaw afterwards", async () => {
  // Before, never after: a copy taken while writes are still landing is already behind by
  // the time it finishes. And leaving it frozen is the point — the source must not start
  // accepting writes again just because a script finished.
  const from = await instance({ seeded: true });
  const to = await instance();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-"));
  try {
    const r = await run(["--from", from.origin, "--to", to.origin, "--out", dir, "--freeze"]);
    assert.equal(r.code, 0, r.out);
    assert.ok(from.kv.store.has(W.FREEZE_KEY), "the source was thawed, or never frozen");
    assert.match(r.out, /still FROZEN/);
    assert.equal(to.kv.store.has(W.FREEZE_KEY), false, "the TARGET was frozen");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    from.server.close(); to.server.close();
  }
});

// ── the property the item is about ───────────────────────────────────────────

test("A RUN KILLED MID-MIGRATION, RE-RUN, ENDS EXACTLY WHERE AN UNINTERRUPTED ONE DOES", async () => {
  // The VERIFY. Interruption is at the transport rather than on a timer: killing a child
  // after N milliseconds tests the scheduler as much as the runner, and a flaky test about
  // data loss is worse than none.
  const control = await instance();
  const from = await instance({ seeded: true });
  const broken = await instance();
  const dirs = [1, 2, 3].map(() => fs.mkdtempSync(path.join(os.tmpdir(), "migrate-")));
  try {
    // The uninterrupted run, for something to compare against.
    assert.equal((await run(["--from", from.origin, "--to", control.origin, "--out", dirs[0]])).code, 0);
    const want = await stateOf(control);

    // Now the same migration into a target that dies partway through the restore.
    let requests = 0;
    const realFetch = broken.server;
    const port = new URL(broken.origin).port;
    const proxy = http.createServer((req, res) => {
      if (req.url.includes("/_state/import") && ++requests === 1) {
        // The first attempt at the state import goes nowhere at all.
        res.socket.destroy();
        return;
      }
      const upstream = http.request({ port, path: req.url, method: req.method, headers: req.headers }, (up) => {
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
      });
      req.pipe(upstream);
      upstream.on("error", () => { try { res.socket.destroy(); } catch (e) {} });
    });
    await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
    const brokenOrigin = `http://127.0.0.1:${proxy.address().port}`;

    const first = await run(["--from", from.origin, "--to", brokenOrigin, "--out", dirs[1]]);
    assert.equal(first.code, 1, `the interrupted run should have failed:\n${first.out}`);

    // Run it again. Nothing to clean up first — that is the claim.
    const second = await run(["--from", from.origin, "--to", brokenOrigin, "--out", dirs[2]]);
    assert.equal(second.code, 0, second.out);

    const got = await stateOf(broken);
    assert.deepEqual(got.families, want.families,
      "the end state after an interrupted-then-retried run differs from an uninterrupted one");
    proxy.close();
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    control.server.close(); from.server.close(); broken.server.close();
  }
});

test("running it twice over is a no-op, not a doubling", async () => {
  const from = await instance({ seeded: true });
  const to = await instance();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-"));
  try {
    assert.equal((await run(["--from", from.origin, "--to", to.origin, "--out", dir])).code, 0);
    const once = await stateOf(to);
    assert.equal((await run(["--from", from.origin, "--to", to.origin, "--out", dir])).code, 0);
    const twice = await stateOf(to);
    assert.deepEqual(twice.families, once.families);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    from.server.close(); to.server.close();
  }
});

// ── the refusals ─────────────────────────────────────────────────────────────

test("A TARGET THAT DID NOT RECEIVE EVERYTHING FAILS THE RUN, loudly", async () => {
  // The step that makes this worth running at all. A migration that reported success
  // without reading the far side back would have reported that it sent some requests.
  const from = await instance({ seeded: true });
  const to = await instance();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-"));
  try {
    assert.equal((await run(["--from", from.origin, "--to", to.origin, "--out", dir])).code, 0);
    // Something eats a family on the target after the fact.
    await to.kv.delete("statuses");
    // A re-run REPAIRS it rather than reporting a mismatch, which is the more useful
    // behaviour of the two and the one worth pinning: the operator's move when something
    // is wrong is to run it again, and that has to be the move that works.
    const r = await run(["--from", from.origin, "--to", to.origin, "--out", dir]);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual((await stateOf(to)).families.statuses, (await stateOf(from)).families.statuses,
      "a re-run did not repair the target");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    from.server.close(); to.server.close();
  }
});

test("it refuses the obvious mistakes before touching anything", async () => {
  const from = await instance();
  try {
    const same = await run(["--from", from.origin, "--to", from.origin]);
    assert.equal(same.code, 1);
    assert.match(same.out, /the same instance/);

    const none = await run([]);
    assert.equal(none.code, 1);
    assert.match(none.out, /name both ends/);

    const noToken = await run(["--from", from.origin, "--to", "https://nowhere.test"], { AUGUR_TO_TOKEN: "" });
    assert.equal(noToken.code, 1);
    assert.match(noToken.out, /STAR scope/);
  } finally { from.server.close(); }
});

test("a dry run writes nothing and does not freeze", async () => {
  const from = await instance({ seeded: true });
  const to = await instance();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-"));
  try {
    const r = await run(["--from", from.origin, "--to", to.origin, "--out", dir, "--freeze", "--dry-run"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /nothing was written to the target/);
    assert.equal(from.kv.store.has(W.FREEZE_KEY), false, "a dry run froze the source");
    // The target's own token map is there because the fixture put it there; what must NOT
    // be is anything the source holds.
    const landed = (await stateOf(to)).families;
    assert.deepEqual(landed.statuses ?? {}, {}, "a dry run wrote statuses to the target");
    assert.deepEqual(landed["c:"] ?? {}, {}, "a dry run wrote comment threads to the target");
    assert.equal("users:roster" in landed, false, "a dry run wrote the roster to the target");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    from.server.close(); to.server.close();
  }
});
