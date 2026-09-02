// The migration this platform actually runs: shared KV on one side, a workspace object on
// the other — and the step that only exists for that move.
//
// `test/migrate-runner.test.mjs` next door drives KV → KV, which is the shape nobody
// migrates to. Every difference between the two backings therefore lives outside its cover,
// and one of them stopped the run dead on correct data:
//
//   THE VERIFICATION COMPARED A SHAPE, NOT A CONTENT. `pins:` reports as `{}` from KV — an
//   empty set of documents — and reported ABSENT from the workspace object whatever it held,
//   so `JSON.stringify(x ?? null)` put `{}` against `null`, called two identical empty
//   families a mismatch, and died. It died on a workspace where nobody had ever pinned
//   anything, which is most of them.
//
//   AND THE DIE SAT ABOVE THE BOARD MOVE. A canvas board in KV is a MIRROR, written by the
//   room on a dirty alarm and behind it by however long — measured on a live instance with
//   nobody editing: 21 nodes in the mirror against 24 in the room. `migrate` moves each board
//   over a socket from the room that owns it precisely because comparing two mirrors is the
//   one check that can be green while data is dropped. That step runs AFTER the family
//   verification, so on the only kind of migration this platform does, the fix written for
//   exactly this case could never execute. Half of what this file is for is proving control
//   reaches it.
//
// Same harness as the runner file: the real worker behind an HTTP server, driven by the real
// script as a child process, so what is under test is the command an operator types. The
// target's TENANTS namespace holds real `TenantStore`s over real SQLite.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import worker, { __testables as W } from "../src/_worker.js";
import { TenantStore } from "../src/tenant-do.js";

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
      return {
        keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      };
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

/** A TENANTS namespace whose objects are real TenantStores over real SQLite. */
function namespace() {
  const objects = new Map();
  return {
    idFromName(name) { return { name, toString: () => `id:${name}` }; },
    get(id) {
      if (!objects.has(id.name)) {
        const db = new DatabaseSync(":memory:");
        const sql = {
          exec(stmt, ...params) {
            if (params.length) return db.prepare(stmt).all(...params);
            if (/^\s*(SELECT|INSERT|UPDATE)/i.test(stmt) && /RETURNING/i.test(stmt)) return db.prepare(stmt).all();
            if (/^\s*SELECT/i.test(stmt)) return db.prepare(stmt).all();
            db.exec(stmt);
            return [];
          },
        };
        objects.set(id.name, new TenantStore({ storage: { sql }, blockConcurrencyWhile: async (f) => f() }, {}));
      }
      const store = objects.get(id.name);
      return { id, store, fetch: (u, init) => store.fetch(new Request(u, init)) };
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

/**
 * ⚠️ EVERY INSTANCE IN THIS FILE IS A DIFFERENT WORKSPACE, RESOLVED BY HOST.
 *
 * The config cache, the manifest cache and the freeze cache are one slot per isolate, keyed
 * by workspace — correct in production, where an isolate serves one deployment, and a trap
 * in a file that stands two fake instances up inside one process. Two instances answering to
 * the same workspace name share a cached config, so the SOURCE's `rtOrigin` is what the
 * target's `/__rt` reports, and the board step below is then being asked about the wrong
 * instance.
 *
 * Naming them apart takes the Host branch of the resolver rather than the stamped one, since
 * the stamped id is memoised per isolate and the first instance stood up would name both. That
 * is also the shape a hosted target has: several workspaces behind one suffix, told apart by
 * the first label.
 */
const SUFFIX = ".ws.test";
let nextLabel = 0;

/**
 * One instance: the real worker behind an HTTP server, with its own stores.
 *
 * `workspace: true` binds a TENANTS namespace, which is the whole difference under test —
 * the overlay then lives in a Durable Object and KV keeps the identity families underneath
 * it, exactly as a half-migrated instance does.
 *
 * `rooms: true` writes an `rtOrigin` into the instance config, which is the one cheap signal
 * `/__rt` answers with: 501 from a deployment whose boards live only in KV, 426 from one
 * whose boards live in rooms.
 */
async function instance({ seeded = false, workspace = false, rooms = false } = {}) {
  const label = `ws${++nextLabel}`;
  const kv = memKv();
  // ⚠️ THE IDENTITY KEYS COME FROM THE PRODUCER TOO, and for the same reason the store
  // keys do: these instances set `TENANT_HOST_SUFFIX`, so the identity documents carry a
  // workspace segment (`identityKey`). A fixture spelling `publish:tokens` by hand would
  // seed a key this deployment shape does not read, and every publish here would be a 403
  // that looked like a token problem.
  const IK = (k) => W.identityKey(k, label);
  await kv.put(IK("publish:tokens"), JSON.stringify({ [await W.tokenFor("pub:tok")]: { space: "*", label: "ci" } }));
  // ⚠️ THE STORE KEYS COME FROM THE PRODUCER, NOT FROM THIS FILE. These instances set
  // `TENANT_HOST_SUFFIX`, which is what makes the bundle store carry a workspace segment
  // (`bundleKey`), so a fixture spelling `spaces/alpha/manifest.json` by hand would be
  // seeding a key this deployment shape does not read — and the instance would serve an
  // empty site while every assertion here still had something to say. `_engine` and
  // `blobs/` map to themselves, which is the exception being relied on rather than
  // restated.
  const K = (k) => W.bundleKey(k, label);
  const r2 = memR2({
    [K("spaces/alpha/manifest.json")]: Buffer.from(JSON.stringify(manifest("alpha", PAGE_H, PAGE.length))),
    [K("spaces/_engine/manifest.json")]: Buffer.from(JSON.stringify(manifest("_engine", CSS_H, CSS.length))),
    [`blobs/${PAGE_H}`]: PAGE,
    [`blobs/${CSS_H}`]: CSS,
  });
  await r2.put(K("config/instance.json"), Buffer.from(JSON.stringify({
    tenantId: label, users: [], ...(rooms ? { rtOrigin: "http://127.0.0.1:9" } : {}),
  })));
  if (seeded) {
    // Deliberately NO `pins:<address>` key: the family is genuinely, correctly empty, which
    // is the state the verification refused to accept.
    for (const [k, v] of Object.entries({
      "users:roster": { add: { "a@x.test": { email: "a@x.test", role: "editor" } }, remove: [] },
      "users:names": { "a@x.test": "Ada" },
      statuses: { "/p/one/": "dev-ready" },
      names: { "/p/one/": "One" },
      canvases: { "/b/one/": { name: "One", by: "a@x.test", t: 1 } },
      "c:/p/one/": [{ id: "t1", messages: [{ author: "Ada", body: "hello" }] }],
      "board:/b/one/": { name: "One", nodes: [{ id: "n1" }], clock: 4 },
    })) await kv.put(IK(k), JSON.stringify(v));
  }
  const env = {
    COMMENTS: kv, BUNDLES: r2, GV_ASSET_SOURCE: "r2", TENANT_HOST_SUFFIX: SUFFIX,
    ...(workspace ? { TENANTS: namespace() } : {}),
  };
  if (workspace) {
    // ⚠️ A HOSTED TARGET IS PROVISIONED BEFORE ANYTHING IS MOVED INTO IT — the order the
    // migration runbook mandates, and since `F-seed-pack-at-provision` the order the front
    // door ENFORCES: an object nobody has provisioned resolves to nobody, however much
    // content sits under its keys, because a provisioning writes its content first and
    // commits second. So this fixture does what an operator does: create the workspace
    // (a first admin the copy never names; the roster the target serves after the restore
    // is the copy's, and the comparison below still holds), then hold the publish
    // credential in the object, which is where a provisioned workspace's tokens live. The
    // KV token above stays for the KV-shaped instances.
    const { store } = env.TENANTS.get(env.TENANTS.idFromName(label));
    await store.provision({ workspaceId: label, adminEmail: "owner@x.test" });
    store.publishTokenMint({ tokenHash: await W.tokenFor("pub:tok"), space: "*", label: "ci" });
  }
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      // The Host is this instance's own workspace name, overriding the loopback one the
      // client sent — that is what keeps the two instances' caches apart. See SUFFIX above.
      const request = new Request(`http://${label}${SUFFIX}${req.url}`, {
        method: req.method, headers: { ...req.headers, host: `${label}${SUFFIX}` },
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
  return { env, kv, r2, server, label, origin: `http://127.0.0.1:${server.address().port}` };
}

const run = (argv, extraEnv = {}) => new Promise((resolve) => {
  execFile(process.execPath, [path.join(ROOT, "scripts", "migrate.mjs"), ...argv], {
    cwd: ROOT,
    env: { ...process.env, AUGUR_FROM_TOKEN: "tok", AUGUR_TO_TOKEN: "tok", ...extraEnv },
  }, (err, stdout, stderr) => resolve({ code: err ? err.code || 1 : 0, out: `${stdout}${stderr}` }));
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "migrate-ws-"));
const stateOf = (inst) => W.exportState(
  Object.freeze({ ...W.applyInstance({ users: [] }), tenantId: inst.label }), inst.env);

/**
 * The instance, reachable at a second origin, with its `_state/export` answer rewritten.
 *
 * The verification reads exactly that document, so this is how a target that restored
 * incompletely — or one whose export could not enumerate a family — presents itself to the
 * runner. Doing it at the wire rather than by damaging the store is deliberate: `migrate`
 * REPAIRS on a re-run, so a real mismatch will not hold still long enough to be asserted on.
 */
async function exportProxy(inst, mutate) {
  const port = new URL(inst.origin).port;
  const proxy = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const up = http.request({ port, path: req.url, method: req.method, headers: req.headers }, (r) => {
        const rewriting = req.method === "GET" && req.url.includes("/_state/export") && r.statusCode === 200;
        if (!rewriting) { res.writeHead(r.statusCode, r.headers); r.pipe(res); return; }
        const body = [];
        r.on("data", (c) => body.push(c));
        r.on("end", () => {
          const doc = JSON.parse(Buffer.concat(body).toString("utf8"));
          mutate(doc);
          const out = Buffer.from(JSON.stringify(doc));
          res.writeHead(200, { "content-type": "application/json", "content-length": out.length });
          res.end(out);
        });
      });
      up.on("error", () => { try { res.socket.destroy(); } catch (e) {} });
      up.end(Buffer.concat(chunks));
    });
  });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  return { origin: `http://127.0.0.1:${proxy.address().port}`, close: () => proxy.close() };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE REGRESSION
// ─────────────────────────────────────────────────────────────────────────────

test("A KV→WORKSPACE MIGRATION VERIFIES WHEN A FAMILY IS GENUINELY EMPTY", async () => {
  // Nobody has ever pinned anything. `pins:` is an empty set on both sides and the two are
  // equal in every sense that matters. This run died here.
  const from = await instance({ seeded: true });
  const to = await instance({ workspace: true });
  const dir = tmp();
  try {
    const before = await stateOf(from);
    assert.deepEqual(before.families["pins:"], {}, "the fixture must have an EMPTY family, not a missing one");

    const r = await run(["--from", from.origin, "--to", to.origin, "--out", dir]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /every family matches/);
    assert.doesNotMatch(r.out, /does not match the source/);
    assert.doesNotMatch(r.out, /can be judged/);

    // ⚠️ AND THE CHROME IS DECLINED BY THE TARGET, OUT LOUD. A copy from a single-workspace
    // instance always carries `_engine`, and a host-resolved target serves that bundle to
    // every workspace on it — so no workspace's publish token may write it and a restore has
    // to skip it. This is exactly the shape `augur migrate` moves, so the skip has to be
    // ordinary AND visible: a restore that dropped a space silently would be
    // indistinguishable from a complete one.
    assert.match(r.out, /_engine: this target serves it from a shared build/);
    assert.match(r.out, /declined by the target \(_engine\)/);

    // And not vacuously: the families that DID hold something arrived.
    const after = await stateOf(to);
    assert.deepEqual(after.families.statuses, before.families.statuses);
    assert.deepEqual(after.families["c:"], before.families["c:"]);
    assert.deepEqual(after.families["users:roster"], before.families["users:roster"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    from.server.close(); to.server.close();
  }
});

test("a family the source holds and the target does not STILL fails, empty or otherwise", async () => {
  // The half that makes the other half worth anything: leniency about two empties may not
  // become leniency about a difference. Two cases through the real script, against a target
  // whose export is rewritten on the wire — which is what an incomplete restore looks like
  // from here, and the only way to hold a mismatch still (a re-run repairs a real one).
  const from = await instance({ seeded: true });
  await from.kv.put("pins:a@x.test", JSON.stringify({ "/p/one/": { label: "One" } }));
  const to = await instance({ workspace: true });
  const dir = tmp();
  const proxies = [];
  try {
    // 1. A SET-OF-DOCUMENTS family emptied out. `pins:` is the family the whole fix is
    //    about, so it is the one that must not be waved through when it differs.
    const emptied = await exportProxy(to, (doc) => { doc.families["pins:"] = {}; });
    proxies.push(emptied);
    const a = await run(["--from", from.origin, "--to", emptied.origin, "--out", dir]);
    assert.equal(a.code, 1, a.out);
    assert.match(a.out, /the target does not match the source: pins:/);

    // 2. A WHOLE-DOCUMENT family with a key missing. Absent-equals-empty is a rule about
    //    nothing at all; one key out of a document is not nothing.
    const thinned = await exportProxy(to, (doc) => { delete doc.families.statuses["/p/one/"]; });
    proxies.push(thinned);
    const b = await run(["--from", from.origin, "--to", thinned.origin, "--out", dir]);
    assert.equal(b.code, 1, b.out);
    assert.match(b.out, /the target does not match the source: statuses/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const p of proxies) p.close();
    from.server.close(); to.server.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE STEP THE DIE WAS STANDING ON TOP OF
// ─────────────────────────────────────────────────────────────────────────────

test("THE BOARD MOVE IS REACHED ON A KV→WORKSPACE MIGRATION, and says which case it took", async () => {
  // Reachability, stated as the board step's own verdict appearing in the output. Neither
  // side serves rooms here, so the KV document IS the board and the copy carried the whole of
  // it — that is a legitimate skip, and it is a skip only something that RAN can report.
  const from = await instance({ seeded: true });
  const to = await instance({ workspace: true });
  const dir = tmp();
  try {
    const r = await run(["--from", from.origin, "--to", to.origin, "--out", dir]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /1 canvas board\(s\)/);
    assert.match(r.out, /serves no rooms/);
    assert.match(r.out, /Nothing to move over a socket/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    from.server.close(); to.server.close();
  }
});

test("a board that lives in a ROOM and a target with none is refused — which the die above hid", async () => {
  // The sharpest proof that control gets past the family verification, because the run still
  // fails and it fails for a DIFFERENT, correct reason. The source's boards live in rooms; the
  // target has no realtime, so what landed there is the KV mirror, which is not the board.
  // Before this fix the run died first on `pins:` and this refusal was unreachable — an
  // operator would have been told the copy did not match and never told the boards had nowhere
  // to go.
  const from = await instance({ seeded: true, rooms: true });
  const to = await instance({ workspace: true });
  const dir = tmp();
  try {
    const r = await run(["--from", from.origin, "--to", to.origin, "--out", dir]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /has no realtime configured/);
    assert.match(r.out, /what landed there is the KV MIRROR/i);
    assert.doesNotMatch(r.out, /the target does not match the source/,
      "the family verification must have passed for the board step to be the thing that refused");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    from.server.close(); to.server.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. WHAT LENIENCY MAY NOT BECOME
// ─────────────────────────────────────────────────────────────────────────────

test("a set-of-documents family reported ABSENT is refused, never read as empty", async () => {
  // The rule, driven through the real script against a target that reports one prefix family
  // absent while the source reports it empty. That is not a match: absent from a family that
  // is a SET means the export could not enumerate it, so the copy may be perfect and this run
  // cannot say so. Saying "equal, both empty" there is the shortcut that would have hidden
  // the sidebar hole this whole change came out of.
  const from = await instance({ seeded: true });
  const to = await instance({ workspace: true });
  const dir = tmp();
  let blinded = null;
  try {
    // The source holds no comment threads either, so the two families are equally empty — and
    // the run must STILL refuse, because one of the two cannot say so.
    await from.kv.delete("c:/p/one/");
    blinded = await exportProxy(to, (doc) => {
      delete doc.families["c:"];
      doc.absent = [...(doc.absent || []), "c:"];
    });
    const r = await run(["--from", from.origin, "--to", blinded.origin, "--out", dir]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /neither end can be judged on c:/);
    assert.match(r.out, /reported the family ABSENT rather than empty/);

    // And the contrast that makes it a rule rather than a blanket refusal: a WHOLE-DOCUMENT
    // family the source holds as an empty document and the target reports absent IS a match,
    // because a document that does not exist is a document holding nothing and there is no
    // third state either end could be in.
    await from.kv.put("c:/p/one/", JSON.stringify([{ id: "t1", messages: [] }])); // undo the blinding fixture
    await from.kv.put("mail:suppressed", "{}");
    const missingDoc = await exportProxy(to, (doc) => {
      delete doc.families["mail:suppressed"];
      doc.absent = [...(doc.absent || []), "mail:suppressed"];
    });
    const ok = await run(["--from", from.origin, "--to", missingDoc.origin, "--out", dir]);
    assert.equal(ok.code, 0, ok.out);
    missingDoc.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (blinded) blinded.close();
    from.server.close(); to.server.close();
  }
});
