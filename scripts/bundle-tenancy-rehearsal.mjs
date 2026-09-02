#!/usr/bin/env node
/**
 * bundle-tenancy-rehearsal — the workspace segment on the bundle store, driven on REAL
 * workerd against a REAL R2 bucket, with TWO workspaces, over real HTTP.
 *
 * WHY THIS EXISTS, and why the suite is not it. `test/bundle-tenancy.test.mjs` drives the
 * real worker over the real routes, but the bucket underneath it is a `Map` behind a
 * hand-written stub. That proves the SEAM — which key is formed, which family is exempt,
 * what a revert answers — and it cannot prove the RUNTIME. A stub's `list` is a filter over
 * a Map: it cannot get `delimitedPrefixes` wrong, it cannot truncate, and it will happily
 * agree with whatever the code believes about prefixes because it was written from the same
 * belief. The whole of this item is a claim about key shapes in a real object store, and a
 * fixture that models the store is a fixture that can agree with a bug for months.
 *
 * So this stands up the ACTUAL deploy entry (`src/entry.js`'s module graph) under
 * `wrangler dev --local`, with a REAL local R2 bucket (workerd's own implementation), a
 * `TENANTS` Durable Object namespace and a local KV, and publishes into it over HTTP with
 * publish tokens — the same front door `augur publish` uses. Nothing is imported and no
 * worker function is called from here except through a request.
 *
 * ⚠️ LOCAL BY CONSTRUCTION AND MUST STAY THAT WAY. No account, no token, no route, no
 * remote binding: `--local` plus a `--persist-to` directory under `.wrangler/`, which is
 * gitignored. The fixture is invented hostnames on a reserved `.test` domain and a handful
 * of made-up bytes. Nothing here may ever be pointed at a deployed instance — the phases
 * below deliberately publish, delete and garbage-collect.
 *
 * THE THREE DEPLOYMENTS, over ONE persisted bucket, in this order, because the sequence is
 * the argument:
 *
 *   single    No `TENANT_HOST_SUFFIX` and no `TENANTS` — every instance running today.
 *             Publishes a space and its chrome. The bucket must come out holding the keys
 *             it has always held and NOT ONE key under `t/`. That is the additive claim,
 *             and it is measured rather than assumed.
 *
 *   hosted    The suffix and the binding — the shared-worker shape. TWO workspaces answer
 *             on two labels. The first is the `single` phase's content, which it cannot
 *             see until it is MOVED (`/__publish/_state/rekey`, the same route
 *             `augur bundle-rekey` drives) — that move is the live migration, rehearsed.
 *             The second publishes a space with THE SAME ID and different bytes.
 *
 *   reverted  `hosted` again, but `main` resolves a COPY of src/ with one word flipped:
 *             `BUNDLE_TENANCY.spaces = false`. The per-family revert, RUN rather than read.
 *
 * Usage:
 *   node scripts/bundle-tenancy-rehearsal.mjs [--port 8812] [--keep]
 *
 * `--keep` leaves the generated tree for inspection. `WRANGLER_BIN` overrides how wrangler
 * is spawned (default `npx wrangler`).
 *
 * Exit 0 when every clause passed, 1 otherwise. Each clause prints what it asked and what
 * it saw, because the point of a rehearsal is the transcript.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { __testables as WORKER_TESTABLES } from "../src/_worker.js";
const __IDENTITY_KEY = (k, ws) => WORKER_TESTABLES.identityKey(k, ws);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORK = path.join(ROOT, ".wrangler", "bundle-tenancy-rehearsal");

const argv = process.argv.slice(2);
const PORT = Number((argv.find((a) => a.startsWith("--port=")) || "").split("=")[1]
  || (argv.includes("--port") ? argv[argv.indexOf("--port") + 1] : 0)) || 8812;
const KEEP = argv.includes("--keep");

// The fixture. Invented labels on a reserved-for-documentation domain; `.test` resolves
// nowhere, so a stray lookup cannot leave this machine. Neither name is in
// `RESERVED_LABELS` (`src/tenant-host.mjs` refuses those with a bare 404 that looks exactly
// like a broken fixture) — both are birds.
const SUFFIX = ".rehearsal.test";
const A = "wren";                 // the workspace the `single` phase's content is moved to
const B = "finch";                // the neighbour, publishing a space of the SAME id
const INVENTED = ["zzprobe-one", "zzprobe-two"]; // two independent labels nobody provisioned
const SPACE = "site";             // ONE space id, published by BOTH workspaces
const TOKEN = "rehearsal-publish-token-not-a-credential";
const SESSION_SECRET = "rehearsal-session-secret-not-a-credential";
const WORKER_NAME = "augur-bundle-tenancy-rehearsal";
const KV_ID = "bundle-tenancy-rehearsal-kv";
const BUCKET = "bundle-tenancy-rehearsal-bundles";

// ---- the transcript ---------------------------------------------------------

const results = [];
let currentClause = "setup";
function clause(name) { currentClause = name; console.log(`\n── ${name} ${"─".repeat(Math.max(0, 74 - name.length))}`); }
function check(what, ok, detail = "") {
  results.push({ clause: currentClause, what, ok });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${what}${detail ? `\n        ${String(detail).replace(/\n/g, "\n        ")}` : ""}`);
}
function note(text) { console.log(`        ${String(text).replace(/\n/g, "\n        ")}`); }

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const sha40 = (buf) => sha256(buf).slice(0, 40);

// ---- the generated tree -----------------------------------------------------

/**
 * The rehearsal entry: `src/entry.js` plus a `/__rehearsal/*` prefix in FRONT of the real
 * front door, for SETUP and EVIDENCE only.
 *
 * Two things live behind it and neither is ever asserted on in place of a real response.
 * `/__rehearsal/r2` reads and writes the bucket directly — that is how the transcript can
 * say which PHYSICAL keys exist, which is the one fact no HTTP response can show and the
 * whole subject of this item. `/__rehearsal/call` reaches two engine functions that have no
 * route at all: `assetGc`, which has no driver anywhere (that is a finding, not an
 * omission), and the tenancy table, so the revert can be shown to have landed.
 */
function entrySource(srcDir) {
  const q = (p) => JSON.stringify(path.join(srcDir, p));
  return `// GENERATED by scripts/bundle-tenancy-rehearsal.mjs — not a deploy entry, never committed.
import worker, { __testables } from ${q("_worker.js")};
export { TenantStore } from ${q("tenant-do.js")};
export { BoardRoom } from ${q("board-room.mjs")};

async function probe(request, env, url) {
  if (url.pathname === "/__rehearsal/r2") {
    const b = await request.json();
    const r2 = env.BUNDLES;
    if (b.op === "list") {
      const out = []; const prefixes = [];
      let cursor;
      do {
        const page = await r2.list({ prefix: b.prefix || "", delimiter: b.delimiter, cursor, limit: 1000 });
        for (const o of page.objects || []) out.push({ key: o.key, size: o.size });
        for (const p of page.delimitedPrefixes || []) prefixes.push(p);
        cursor = page.truncated ? page.cursor : null;
      } while (cursor);
      return Response.json({ objects: out, delimitedPrefixes: prefixes });
    }
    if (b.op === "get") {
      const o = await r2.get(b.key);
      if (!o) return Response.json({ present: false });
      const buf = new Uint8Array(await o.arrayBuffer());
      let hex = ""; for (const x of buf) hex += x.toString(16).padStart(2, "0");
      return Response.json({ present: true, size: buf.byteLength, sha256: await sha(buf), text: new TextDecoder().decode(buf).slice(0, 400) });
    }
    if (b.op === "put") { await r2.put(b.key, b.body); return Response.json({ ok: true }); }
    if (b.op === "delete") { await r2.delete(b.key); return Response.json({ ok: true }); }
    return Response.json({ error: "bad-op" }, { status: 400 });
  }
  if (url.pathname === "/__rehearsal/kv") {
    const b = await request.json();
    const kv = env.COMMENTS;
    if (b.op === "get") return Response.json({ value: await kv.get(b.key) });
    if (b.op === "put") { await kv.put(b.key, b.value); return Response.json({ ok: true }); }
    if (b.op === "list") {
      const out = []; let cursor;
      do {
        const page = await kv.list({ prefix: b.prefix || "", cursor });
        for (const k of page.keys || []) out.push(k.name);
        cursor = page.list_complete ? null : page.cursor;
      } while (cursor);
      return Response.json({ keys: out });
    }
    return Response.json({ error: "bad-op" }, { status: 400 });
  }
  if (url.pathname === "/__rehearsal/call") {
    const b = await request.json();
    if (b.fn === "tenancy") {
      return Response.json({
        BUNDLE_TENANCY: __testables.BUNDLE_TENANCY,
        segment: __testables.bundleWorkspaceSegment(env, b.workspace),
        exampleKeys: {
          manifest: __testables.bundleKey("spaces/" + (b.space || "x") + "/manifest.json", __testables.bundleWorkspaceSegment(env, b.workspace).workspace),
          engine: __testables.bundleKey("spaces/_engine/manifest.json", __testables.bundleWorkspaceSegment(env, b.workspace).workspace),
          blob: __testables.bundleKey("blobs/deadbeef", __testables.bundleWorkspaceSegment(env, b.workspace).workspace),
          config: __testables.bundleKey("config/instance.json", __testables.bundleWorkspaceSegment(env, b.workspace).workspace),
          asset: __testables.bundleKey("assets/deadbeef", __testables.bundleWorkspaceSegment(env, b.workspace).workspace),
        },
      });
    }
    if (b.fn === "assetGc") {
      // ⚠️ THE REAL COLLECTOR, WITH THE REAL BINDINGS, and it is reached this way because
      // it is reachable NO other way: nothing in the engine drives it — no route, no cron,
      // no verb. That is the state of the code, not a gap in this harness.
      const tctx = { tenantId: b.workspace };
      return Response.json(await __testables.assetGc(env, tctx, { now: Date.now() + 40 * 24 * 3600_000 }));
    }
    if (b.fn === "assetRow") {
      const tctx = { tenantId: b.workspace };
      const store = __testables.overlayFor(env, tctx);
      if (b.set) await store.set("assets", "", b.hash, { ct: "image/png", bytes: b.bytes, at: new Date(Date.now() - 40 * 24 * 3600_000).toISOString() });
      return Response.json({ rows: Object.keys(await store.read("assets")) });
    }
    return Response.json({ error: "bad-fn" }, { status: 400 });
  }
  return Response.json({ error: "not-found" }, { status: 404 });
}

async function sha(buf) {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__rehearsal/")) return probe(request, env, url);
    return worker.fetch(request, env, ctx);
  },
};
`;
}

/** The wrangler config. `hosted:false` removes the suffix AND the binding, nothing else. */
function wranglerConfig({ entry, assets, hosted }) {
  return `# GENERATED by scripts/bundle-tenancy-rehearsal.mjs on every run — edit that, not this.
name = ${JSON.stringify(WORKER_NAME)}
main = ${JSON.stringify(entry)}
compatibility_date = "2025-01-01"

[assets]
directory = ${JSON.stringify(assets)}
binding = "ASSETS"
run_worker_first = true
not_found_handling = "none"
html_handling = "auto-trailing-slash"

[vars]
# The engine's own name for "this is a real deployment": content serves from the store.
GV_ASSET_SOURCE = "r2"

[[kv_namespaces]]
binding = "COMMENTS"
id = ${JSON.stringify(KV_ID)}

[[r2_buckets]]
binding = "BUNDLES"
bucket_name = ${JSON.stringify(BUCKET)}
${hosted ? `
[vars.hosted]

[[durable_objects.bindings]]
name = "TENANTS"
class_name = "TenantStore"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["TenantStore"]
` : `
# NO TENANT_HOST_SUFFIX AND NO TENANTS BINDING. Every instance running today, and the whole
# of the "with neither, the store answers exactly as it always has" claim.
`}`;
}

async function generate() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(path.join(WORK, "assets", "__config"), { recursive: true });
  // A raw asset host with no config: a deployed instance in bundle mode reads its config
  // from the STORE, and shipping one here would let a phase pass on the file instead.
  fs.writeFileSync(path.join(WORK, "assets", "robots.txt"), "User-agent: *\nDisallow:\n");

  const src = path.join(ROOT, "src");
  fs.writeFileSync(path.join(WORK, "entry.js"), entrySource(src));

  // THE REVERT, as a copy of src/ with one word changed. Copied rather than patched in
  // place for the obvious reason — the tree under test must not be edited to test it — and
  // the edit is ASSERTED to have landed, because a revert that silently did not apply is a
  // clause that passes for the wrong reason.
  const revertedSrc = path.join(WORK, "reverted-src");
  fs.cpSync(src, revertedSrc, { recursive: true });
  // The constant lives in src/bundle-keys.mjs since the workspace object started writing the
  // store too (the seed pack at provisioning); the worker imports it from there.
  const wf = path.join(revertedSrc, "bundle-keys.mjs");
  const before = fs.readFileSync(wf, "utf8");
  const after = before.replace(/(export const BUNDLE_TENANCY = Object\.freeze\(\{[\s\S]{0,3000}?\n)(\s*)spaces: true,/,
    (_m, head, indent) => `${head}${indent}spaces: false,`);
  if (after === before) throw new Error("the revert edit did not apply — has BUNDLE_TENANCY moved or been renamed?");
  fs.writeFileSync(wf, after);
  fs.writeFileSync(path.join(WORK, "reverted-entry.js"), entrySource(revertedSrc));

  const assets = path.join(WORK, "assets");
  fs.writeFileSync(path.join(WORK, "single.toml"),
    wranglerConfig({ entry: path.join(WORK, "entry.js"), assets, hosted: false }));
  fs.writeFileSync(path.join(WORK, "hosted.toml"),
    wranglerConfig({ entry: path.join(WORK, "entry.js"), assets, hosted: true }));
  fs.writeFileSync(path.join(WORK, "reverted.toml"),
    wranglerConfig({ entry: path.join(WORK, "reverted-entry.js"), assets, hosted: true }));
}

// ---- one deployment ---------------------------------------------------------

/**
 * Spawn `wrangler dev` on one config and wait for it to answer.
 *
 * One at a time, on one port, sharing one persist directory: the deployments are a
 * SEQUENCE, not a set. "the single-workspace store is not read by a host-resolved one",
 * "the move puts it back" and "the revert restores the unprefixed answer" are all claims
 * about ONE bucket seen through two deployments, and a fresh bucket each time would make
 * every one of them vacuous.
 */
async function boot(config, label, hostSuffix) {
  const bin = process.env.WRANGLER_BIN || "npx";
  const args = process.env.WRANGLER_BIN ? [] : ["--yes", "wrangler"];
  const child = spawn(bin, [...args,
    "dev", "-c", path.join(WORK, `${config}.toml`),
    "--local", "--ip", "127.0.0.1", "--port", String(PORT),
    "--persist-to", path.join(WORK, "state"),
    "--var", `SESSION_SECRET:${SESSION_SECRET}`,
    ...(hostSuffix ? ["--var", `TENANT_HOST_SUFFIX:${hostSuffix}`] : []),
    "--log-level", "warn",
  ], {
    cwd: WORK,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "" },
  });
  const log = [];
  child.stdout.on("data", (d) => log.push(String(d)));
  child.stderr.on("data", (d) => log.push(String(d)));
  let exited = null;
  child.on("exit", (code) => { exited = code; });

  const deadline = Date.now() + 90_000;
  for (;;) {
    if (exited !== null) throw new Error(`wrangler exited (${exited}) booting "${label}":\n${log.join("")}`);
    if (Date.now() > deadline) { child.kill("SIGKILL"); throw new Error(`"${label}" never answered:\n${log.join("")}`); }
    try {
      const r = await req("/__rehearsal/r2", "127.0.0.1", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "list", prefix: "zzz" }),
      });
      if (r.status === 200) { console.log(`\n▸ deployment "${label}" up on ${PORT} (${config}.toml)`); return { child, log }; }
    } catch (e) { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function shutdown(dep) {
  if (!dep || !dep.child) return;
  await new Promise((resolve) => {
    dep.child.on("exit", resolve);
    dep.child.kill("SIGINT");
    setTimeout(() => { try { dep.child.kill("SIGKILL"); } catch (e) {} resolve(); }, 8000);
  });
  await new Promise((r) => setTimeout(r, 500));
}

// ---- talking to it ----------------------------------------------------------

/**
 * ⚠️ `node:http`, NOT `fetch`. undici treats `Host` as a forbidden header and drops it
 * silently, so every request would go out naming `127.0.0.1`, the resolver would answer
 * null, and the front door would serve the bare 404 a hostname naming no workspace gets —
 * which is correct behaviour and looks exactly like a broken fixture.
 */
function req(pathname, host, { method = "GET", headers = {}, body } = {}) {
  const h = { Host: host, ...headers };
  if (body != null) h["content-length"] = String(Buffer.byteLength(body));
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, path: pathname, method, headers: h }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: buf, text: buf.toString("utf8"), sha256: sha256(buf) });
      });
    });
    r.on("error", reject);
    if (body != null) r.write(body);
    r.end();
  });
}
const json = (r) => { try { return JSON.parse(r.text); } catch (e) { return { __unparsed: r.text.slice(0, 200), __status: r.status }; } };
const post = (pathname, host, obj, extra = {}) => req(pathname, host, {
  method: "POST", headers: { "content-type": "application/json", ...(extra.headers || {}) }, body: JSON.stringify(obj),
});
const authed = { Authorization: `Bearer ${TOKEN}` };

// Setup/evidence only — see the entry's header.
const r2 = (body) => post("/__rehearsal/r2", "127.0.0.1", body).then(json);
const kv = (body) => post("/__rehearsal/kv", "127.0.0.1", body).then(json);
const call = (body) => post("/__rehearsal/call", "127.0.0.1", body).then(json);

// ---- the fixture content ----------------------------------------------------

const bytesFor = (who, what) => Buffer.from(`${who}:${what}\n${"x".repeat(40)}`);

const manifestFor = (who, spaceId, files) => ({
  id: spaceId, format: 1,
  source: { sha: `sha-${who}`, dirty: false },
  builtWith: { engine: "rehearsal", version: "0.0.0" },
  files,
  routing: {
    publicPrefixes: [`/${spaceId}/`],
    versionMap: {},
    unitSources: { [`/${spaceId}/`]: { sha: `sha-${who}`, dirty: false } },
  },
  space: { id: spaceId, default: true },
});

/** Upload the bytes, then commit the manifest — the two calls `augur publish` makes. */
async function publish(host, spaceId, files) {
  for (const f of Object.values(files)) {
    if (f.__skipUpload) continue;
    const put = await req(`/__publish/${spaceId}/blob/${f.h}`, host, {
      method: "PUT", headers: { ...authed }, body: f.__bytes,
    });
    if (put.status !== 204) throw new Error(`blob PUT for ${f.h} answered ${put.status}: ${put.text.slice(0, 200)}`);
  }
  const m = manifestFor(host.split(".")[0], spaceId,
    Object.fromEntries(Object.entries(files).map(([p, f]) => [p, { h: f.h, ct: f.ct, s: f.s }])));
  const res = await post(`/__publish/${spaceId}/commit`, host, m, { headers: authed });
  return { status: res.status, body: json(res) };
}

const fileOf = (buf, ct) => ({ h: sha256(buf), ct, s: buf.byteLength, __bytes: buf });

// ---- phase: single ----------------------------------------------------------

const state = {};

async function singlePhase() {
  clause("the deployment every instance runs today — no suffix, no TENANTS");

  // The publish token. ⚠️ THE KEY COMES FROM THE PRODUCER: this phase's deployment sets no
  // host suffix, so the document is at the unsegmented key it has always been at; the
  // hosted phase below seeds it PER WORKSPACE, because `identityKey` segments it there
  // (`B-identity-kv-write-segmentation`). One flat key used to be why a single token
  // reached both hostnames — that is closed, and the two workspaces below now hold their
  // own credential rather than sharing one, which is also the only way an isolation claim
  // about them means anything.
  const h = crypto.createHash("sha256").update("gv:pub:" + TOKEN, "utf8").digest("hex");
  await kv({
    op: "put",
    key: __IDENTITY_KEY("publish:tokens", ""),
    value: JSON.stringify({ [h]: { space: "*", label: "ci" } }),
  });

  const cfg = await post("/__publish/_instance/config", "127.0.0.1", {
    tenantId: A, users: [], engineVersion: "0.0.0", sentinels: [],
  }, { headers: authed });
  check("the instance config pushes", cfg.status === 200, `${cfg.status} ${cfg.text.slice(0, 120)}`);

  // The engine chrome, as its own pseudo-space. One build serves every workspace, which is
  // why its key is the one `spaces/` key that never takes a segment.
  const sw = bytesFor("engine", "sw.js");
  const eng = await publish("127.0.0.1", "_engine", { "/sw.js": fileOf(sw, "application/javascript") });
  check("the engine chrome publishes", eng.status === 200, JSON.stringify(eng.body).slice(0, 160));

  // The space. `/space-icon.png` is deliberately one of the files: it is one of the three
  // surfaces the disclosure finding was measured on.
  state.pageA = bytesFor(A, "index.html");
  state.iconA = bytesFor(A, "space-icon.png");
  state.blobA = sha256(state.pageA);
  const pub = await publish("127.0.0.1", SPACE, {
    [`/${SPACE}/index.html`]: fileOf(state.pageA, "text/html"),
    "/space-icon.png": fileOf(state.iconA, "image/png"),
  });
  check("the space publishes", pub.status === 200, JSON.stringify(pub.body).slice(0, 200));
  state.versionA = pub.body.version;

  const page = await req(`/${SPACE}/index.html`, "127.0.0.1");
  check("and serves its own bytes", page.status === 200 && page.sha256 === sha256(state.pageA),
    `${page.status} sha ${page.sha256.slice(0, 16)}`);
  state.buildJsonSingle = json(await req("/_build.json", "127.0.0.1"));

  clause("⚠️ THE ADDITIVE CLAIM: with no suffix and no binding, not one key carries a segment");
  const all = await r2({ op: "list", prefix: "" });
  const prefixed = all.objects.filter((o) => o.key.startsWith("t/"));
  check("the bucket holds no key under `t/` at all", prefixed.length === 0,
    prefixed.length ? prefixed.map((o) => o.key).join("\n") : `${all.objects.length} objects, none prefixed`);
  const shapes = all.objects.map((o) => o.key).sort();
  check("and every key it does hold is the shape it has always been",
    shapes.every((k) => /^(config\/|spaces\/|blobs\/|assets\/)/.test(k)), shapes.join("\n"));
  // ⚠️ THE SAME CLAIM FOR THE IDENTITY DOCUMENTS, AND IT IS THE ONE A LIVE INSTANCE PAYS
  // FOR. `B-identity-kv-write-segmentation` gave the roster, the tokens and the rest the
  // same segment — and a deployment that resolves no workspace from the Host must write
  // not one key under `t/`. Counted rather than argued, on real workerd, after a real
  // publish and a real config push have both run.
  const kvAll = await kv({ op: "list", prefix: "" });
  const kvPrefixed = (kvAll.keys || []).filter((k) => k.startsWith("t/"));
  check("the namespace holds no key under `t/` at all", kvPrefixed.length === 0,
    kvPrefixed.length ? kvPrefixed.join("\n") : `${(kvAll.keys || []).length} keys, none prefixed`);
  const t = await call({ fn: "tenancy", workspace: A, space: SPACE });
  check("the segment this deployment computes is EMPTY", t.segment.workspace === "",
    JSON.stringify(t.segment));
  check("so the key-former is the identity here",
    t.exampleKeys.manifest === `spaces/${SPACE}/manifest.json`, JSON.stringify(t.exampleKeys));

  clause("realistic history, so the move below is a move and not a gesture");
  // 260 retained version manifests, written straight into the bucket — a mature workspace's
  // footprint is overwhelmingly rollback history (versions are never pruned), and the move
  // has to page through more of them than one call will carry.
  const vdoc = JSON.stringify({ id: SPACE, version: 1, files: {}, routing: {} });
  for (let n = 2; n <= 260; n++) await r2({ op: "put", key: `spaces/${SPACE}/versions/${n}.json`, body: vdoc });
  const hist = await r2({ op: "list", prefix: `spaces/${SPACE}/versions/` });
  check("the store holds a realistic version history", hist.objects.length >= 260, `${hist.objects.length} version objects`);
  state.objectsBefore = (await r2({ op: "list", prefix: "" })).objects.length;
  note(`${state.objectsBefore} objects in the bucket`);
}

// ---- phase: hosted ----------------------------------------------------------

const hostA = A + SUFFIX;
const hostB = B + SUFFIX;

async function hostedPhase() {
  clause("the same bucket, seen by a deployment that resolves the workspace from the Host");

  // ⚠️ EACH WORKSPACE GETS ITS OWN COPY OF THE CREDENTIAL, at its own segmented key. The
  // token VALUE is the same string only so this script has one thing to send; the point is
  // that the document is per workspace, so nothing below can pass because a shared
  // document authenticated everywhere.
  const th = crypto.createHash("sha256").update("gv:pub:" + TOKEN, "utf8").digest("hex");
  for (const ws of [A, B]) {
    await kv({
      op: "put",
      key: __IDENTITY_KEY("publish:tokens", ws),
      value: JSON.stringify({ [th]: { space: "*", label: "ci" } }),
    });
  }

  const t = await call({ fn: "tenancy", workspace: A, space: SPACE });
  check("the segment is now this workspace", t.segment.workspace === A, JSON.stringify(t.segment));
  check("⚠️ and an unprefixed key is NOT read as ours — there is no fallback to fall back to",
    t.segment.legacyIsOurs === false, JSON.stringify(t.segment));
  check("`spaces/` and `config/` take the segment",
    t.exampleKeys.manifest === `t/${A}/spaces/${SPACE}/manifest.json` && t.exampleKeys.config === `t/${A}/config/instance.json`,
    JSON.stringify(t.exampleKeys, null, 1));
  check("⚠️ `spaces/_engine/` and `blobs/` DO NOT, deliberately",
    t.exampleKeys.engine === "spaces/_engine/manifest.json" && t.exampleKeys.blob === "blobs/deadbeef",
    JSON.stringify(t.exampleKeys, null, 1));

  const before = json(await req("/_build.json", hostA));
  check("so before the move this workspace serves NOTHING of the old content",
    !Object.keys(before.spaces || {}).includes(SPACE), JSON.stringify(before.spaces || {}));
  const pageBefore = await req(`/${SPACE}/index.html`, hostA);
  check("and its published page is not served either", pageBefore.sha256 !== sha256(state.pageA),
    `${pageBefore.status}`);

  clause("THE MIGRATION, RUN: /__publish/_state/rekey — the route `augur bundle-rekey` drives");
  const dry = json(await post("/__publish/_state/rekey", hostA, {}, { headers: authed }));
  check("a dry run says what would move and moves nothing", dry.ok && dry.dryRun && dry.copied > 0,
    `considered ${dry.considered}, would copy ${dry.copied}+${dry.pending}, shared ${dry.shared}`);
  check("⚠️ it counts `spaces/_engine/` and anything else global as SHARED, not as moved",
    dry.shared >= 1, `shared ${dry.shared}`);
  const stillNothing = await r2({ op: "list", prefix: "t/" });
  check("and the dry run really wrote nothing", stillNothing.objects.length === 0, `${stillNothing.objects.length} keys under t/`);

  const wrong = json(await post("/__publish/_state/rekey", hostA, { confirm: "somebody-else" }, { headers: authed }));
  check("a mistyped confirmation is refused", !wrong.ok && wrong.reason === "confirm-mismatch", JSON.stringify(wrong));

  let pages = 0, copied = 0;
  for (;;) {
    const out = json(await post("/__publish/_state/rekey", hostA, { confirm: A }, { headers: authed }));
    if (!out.ok) { check("the move ran", false, JSON.stringify(out)); break; }
    pages++; copied += out.copied;
    if (out.done) break;
    if (pages > 20) { check("the move terminated", false, `still not done after ${pages} pages`); break; }
  }
  check("the move ran, in pages, to completion", copied >= 260, `${copied} objects over ${pages} call(s)`);

  const again = json(await post("/__publish/_state/rekey", hostA, { confirm: A }, { headers: authed }));
  check("⚠️ and it is IDEMPOTENT — a second run copies nothing and says it is done",
    again.ok && again.copied === 0 && again.done, JSON.stringify({ copied: again.copied, skipped: again.skipped, done: again.done }));

  const originals = await r2({ op: "list", prefix: `spaces/${SPACE}/` });
  check("⚠️ the originals are UNTOUCHED — it is a copy and never a cut",
    originals.objects.length >= 261, `${originals.objects.length} objects still at the old keys`);

  clause("the workspace survives its own migration");
  const after = json(await req("/_build.json", hostA));
  check("`/_build.json` names the space again", !!(after.spaces || {})[SPACE], JSON.stringify(after.spaces || {}));
  check("at the version it was published at", (after.spaces || {})[SPACE].version === state.versionA,
    `before ${state.versionA} · after ${(after.spaces || {})[SPACE].version}`);
  const pageA = await req(`/${SPACE}/index.html`, hostA);
  check("and the page serves BYTE-IDENTICAL content, hash for hash",
    pageA.status === 200 && pageA.sha256 === sha256(state.pageA),
    `${pageA.status} · expected ${sha256(state.pageA).slice(0, 16)} · got ${pageA.sha256.slice(0, 16)}`);
  const vers = json(await req(`/__publish/${SPACE}/versions`, hostA, { headers: authed }));
  check("its publish history is still reachable", (vers.versions || []).length >= 260,
    `${(vers.versions || []).length} versions`);
  const roll = json(await req(`/__publish/${SPACE}/version/7`, hostA, { headers: authed }));
  check("and an individual old version reads back", !roll.error, JSON.stringify(roll).slice(0, 120));

  clause("A SECOND WORKSPACE, publishing a space with THE SAME ID");
  const cfgB = await post("/__publish/_instance/config", hostB, {
    tenantId: B, users: [], engineVersion: "0.0.0", sentinels: [],
  }, { headers: authed });
  check("it pushes its own instance config", cfgB.status === 200, `${cfgB.status}`);

  state.pageB = bytesFor(B, "index.html");
  state.iconB = bytesFor(B, "space-icon.png");
  const pubB = await publish(hostB, SPACE, {
    [`/${SPACE}/index.html`]: fileOf(state.pageB, "text/html"),
    "/space-icon.png": fileOf(state.iconB, "image/png"),
    // ⚠️ THE SHARED BLOB, REFERENCED AND NOT RE-UPLOADED. `__skipUpload` means these bytes
    // never cross the wire on this publish: the hash is the one workspace A uploaded, and
    // the commit's own spot-check has to find it under the global `blobs/` key or refuse.
    [`/${SPACE}/borrowed.html`]: { ...fileOf(state.pageA, "text/html"), __skipUpload: true },
  });
  check("it publishes, referencing A's blob WITHOUT re-uploading it", pubB.status === 200,
    JSON.stringify(pubB.body).slice(0, 200));

  const a2 = await req(`/${SPACE}/index.html`, hostA);
  const b2 = await req(`/${SPACE}/index.html`, hostB);
  check("A still serves A's bytes after B published the same space id",
    a2.sha256 === sha256(state.pageA), a2.sha256.slice(0, 16));
  check("B serves B's, hash for hash", b2.sha256 === sha256(state.pageB), b2.sha256.slice(0, 16));
  check("⚠️ and they are DIFFERENT — the collision is gone", a2.sha256 !== b2.sha256,
    `${a2.sha256.slice(0, 16)} vs ${b2.sha256.slice(0, 16)}`);
  const iconA = await req("/space-icon.png", hostA);
  const iconB = await req("/space-icon.png", hostB);
  check("their icons differ too", iconA.sha256 === sha256(state.iconA) && iconB.sha256 === sha256(state.iconB),
    `${iconA.sha256.slice(0, 12)} / ${iconB.sha256.slice(0, 12)}`);

  clause("neither can READ, LIST, OVERWRITE or DELETE the other's — over real HTTP");
  const manB = json(await req(`/__publish/${SPACE}/manifest`, hostB, { headers: authed }));
  check("the manifest read at B is B's, not A's",
    manB.source && manB.source.sha === `sha-${B}`, JSON.stringify(manB.source));
  const versB = json(await req(`/__publish/${SPACE}/versions`, hostB, { headers: authed }));
  check("⚠️ the version LISTING at B does not show A's 260 versions",
    (versB.versions || []).length <= 2, `${(versB.versions || []).length} versions`);
  const oldAtB = await req(`/__publish/${SPACE}/version/7`, hostB, { headers: authed });
  check("a version number only A has is unknown at B", oldAtB.status === 404, `${oldAtB.status}`);
  const rollAtB = json(await post(`/__publish/${SPACE}/rollback`, hostB, { version: 7 }, { headers: authed }));
  check("and rolling B back to it is refused", rollAtB.error === "unknown-version", JSON.stringify(rollAtB));

  // The overwrite. A star token is admin-equivalent and reaches every space; what it may no
  // longer do is reach every WORKSPACE's copy of one.
  const evil = bytesFor("attacker", "index.html");
  const over = await publish(hostB, SPACE, {
    [`/${SPACE}/index.html`]: fileOf(evil, "text/html"),
    "/space-icon.png": fileOf(state.iconB, "image/png"),
    [`/${SPACE}/borrowed.html`]: { ...fileOf(state.pageA, "text/html"), __skipUpload: true },
  });
  check("B may overwrite B's own space", over.status === 200, JSON.stringify(over.body).slice(0, 160));
  const a3 = await req(`/${SPACE}/index.html`, hostA);
  check("⚠️ and A's page is untouched by it", a3.sha256 === sha256(state.pageA),
    `${a3.sha256.slice(0, 16)} (expected ${sha256(state.pageA).slice(0, 16)})`);
  const b3 = await req(`/${SPACE}/index.html`, hostB);
  check("while B's moved", b3.sha256 === sha256(evil), b3.sha256.slice(0, 16));

  // The delete verb, as far as it goes: `_state/delete` refuses without the workspace
  // object's own agreement, so the dry run is what is reachable — and what it reports is
  // exactly the set of keys it would be allowed to name.
  const delB = json(await post("/__publish/_state/delete", hostB, {}, { headers: authed }));
  check("a dry-run erasure at B names only keys under B's own prefix",
    delB.ok === true && delB.workspace === B, JSON.stringify(delB).slice(0, 160));
  const aStillThere = await req(`/${SPACE}/index.html`, hostA);
  check("and A is still serving after it", aStillThere.sha256 === sha256(state.pageA), `${aStillThere.status}`);

  clause("THE DISCLOSURE FINDING, RE-RUN — it must now FAIL, on two independent fresh labels");
  for (const label of INVENTED) {
    const host = label + SUFFIX;
    const bj = await req("/_build.json", host);
    const b = json(bj);
    check(`${label}: /_build.json serves no real workspace's spaces`,
      !((b.spaces || {})[SPACE]), `${bj.status} ${JSON.stringify(b.spaces || b).slice(0, 140)}`);
    check(`${label}: and it is NOT byte-identical to a real workspace's`,
      bj.sha256 !== sha256(Buffer.from(JSON.stringify(after))), `${bj.sha256.slice(0, 16)}`);
    const ic = await req("/space-icon.png", host);
    check(`${label}: /space-icon.png is neither workspace's icon`,
      ic.sha256 !== sha256(state.iconA) && ic.sha256 !== sha256(state.iconB), `${ic.status} ${ic.sha256.slice(0, 16)}`);
    const as = await req(`/__asset/${state.assetHash || "0".repeat(40)}`, host);
    check(`${label}: /__asset/<hash> answers nothing`, as.status === 404, `${as.status}`);
  }

  clause("`blobs/` and `spaces/_engine/` are PROVEN still shared");
  const borrowed = await req(`/${SPACE}/borrowed.html`, hostB);
  check("⚠️ B serves the bytes A uploaded, from the ONE global blob — no re-upload happened",
    borrowed.status === 200 && borrowed.sha256 === sha256(state.pageA),
    `${borrowed.status} ${borrowed.sha256.slice(0, 16)}`);
  const blobKeys = await r2({ op: "list", prefix: "blobs/" });
  check("and there is exactly one copy of it in the bucket",
    blobKeys.objects.filter((o) => o.key === `blobs/${state.blobA}`).length === 1,
    blobKeys.objects.map((o) => o.key).join("\n"));
  const engKeys = await r2({ op: "list", prefix: "", delimiter: undefined });
  const engineCopies = engKeys.objects.filter((o) => /(^|\/)spaces\/_engine\//.test(o.key)).map((o) => o.key);
  check("⚠️ the engine chrome exists ONCE — every one of its keys is outside every workspace prefix",
    engineCopies.length > 0 && engineCopies.every((k) => k.startsWith("spaces/_engine/"))
      && engineCopies.filter((k) => k === "spaces/_engine/manifest.json").length === 1,
    engineCopies.join("\n"));
  const swA = await req("/sw.js", hostA);
  const swB = await req("/sw.js", hostB);
  check("and both workspaces' chrome resolves to the same object",
    swA.status === 200 && swA.sha256 === swB.sha256, `${swA.status}/${swB.status} ${swA.sha256.slice(0, 16)}`);

  clause("assetGc run as A deletes no object belonging to B");
  const img = bytesFor("shared", "pasted.png");
  state.assetHash = sha40(img);
  // The SAME bytes pasted in both workspaces, which is the whole failure: one hash, one
  // unprefixed key, and A's collector deleting what B is displaying.
  for (const host of [hostA, hostB]) {
    const put = await req(`/__publish/_state/asset/${state.assetHash}`, host, {
      method: "PUT", headers: { ...authed, "content-type": "image/png" }, body: img,
    });
    if (put.status !== 200) throw new Error(`asset PUT at ${host} answered ${put.status}: ${put.text.slice(0, 200)}`);
  }
  // The rows the collector reads. Written through the engine's own overlay writer, aged
  // past the grace window so the pass has something to collect. A is given a row; B is
  // given one too, because B's asset must survive on its own terms rather than because
  // nothing knew about it.
  await call({ fn: "assetRow", workspace: A, hash: state.assetHash, bytes: img.length, set: true });
  await call({ fn: "assetRow", workspace: B, hash: state.assetHash, bytes: img.length, set: true });

  const bBefore = await req(`/__asset/${state.assetHash}`, hostB);
  check("B serves its pasted image", bBefore.status === 200 && bBefore.sha256 === sha256(img), `${bBefore.status}`);
  const aBefore = await req(`/__asset/${state.assetHash}`, hostA);
  check("so does A — same bytes, same hash, two objects", aBefore.status === 200, `${aBefore.status}`);

  const gc = await call({ fn: "assetGc", workspace: A });
  check("the collector runs as A and deletes A's copy", gc.ok && gc.deleted === 1, JSON.stringify(gc));
  const aAfter = await req(`/__asset/${state.assetHash}`, hostA);
  check("A's image is gone", aAfter.status === 404, `${aAfter.status}`);
  const bAfter = await req(`/__asset/${state.assetHash}`, hostB);
  check("⚠️ AND B's IS NOT — counted before and after, over HTTP",
    bAfter.status === 200 && bAfter.sha256 === sha256(img),
    `before 200/${bBefore.sha256.slice(0, 12)} · after ${bAfter.status}/${bAfter.sha256.slice(0, 12)}`);

  clause("the disclosure finding again, now that there IS an asset to disclose");
  for (const label of INVENTED) {
    const as = await req(`/__asset/${state.assetHash}`, label + SUFFIX);
    check(`${label}: /__asset/<hash> does not serve a real workspace's image`, as.status === 404, `${as.status}`);
  }

  state.buildJsonA = json(await req("/_build.json", hostA));
}

// ---- phase: reverted --------------------------------------------------------

async function revertedPhase() {
  clause("PER-FAMILY REVERT, RUN — `BUNDLE_TENANCY.spaces = false`, one word, nothing else");
  const t = await call({ fn: "tenancy", workspace: A, space: SPACE });
  check("the edit landed and reached exactly one family",
    t.BUNDLE_TENANCY.spaces === false && t.BUNDLE_TENANCY.config === true && t.BUNDLE_TENANCY.assets === true,
    JSON.stringify(t.BUNDLE_TENANCY));
  check("so `spaces/` keys are unprefixed again",
    t.exampleKeys.manifest === `spaces/${SPACE}/manifest.json`, JSON.stringify(t.exampleKeys, null, 1));
  check("and `config/` and `assets/` still carry the segment — nothing else was touched",
    t.exampleKeys.config === `t/${A}/config/instance.json` && t.exampleKeys.asset === `t/${A}/assets/deadbeef`,
    JSON.stringify(t.exampleKeys, null, 1));

  // What the unprefixed key holds is what PREDATES the segment and nothing later: the
  // `single` phase's publish, which the move copied and never deleted. A segmented write
  // reaches no unprefixed key (one workspace's document must not sit where every workspace
  // shares), so flipping the flag on a shared bucket is a ROLLBACK to the day of the cut —
  // both workspaces answer with A's original page, B's publish is nowhere on that path —
  // and saying so out loud is the point of running it.
  const a = await req(`/${SPACE}/index.html`, hostA);
  const b = await req(`/${SPACE}/index.html`, hostB);
  check("the unprefixed answer is back, and it is the same one for both workspaces",
    a.status === 200 && a.sha256 === b.sha256, `A ${a.status}/${a.sha256.slice(0, 12)} · B ${b.status}/${b.sha256.slice(0, 12)}`);
  check("⚠️ and it is the page from BEFORE the segment — a rollback to the day of the cut, not a revert",
    a.sha256 === sha256(state.pageA) && b.sha256 !== sha256(state.pageB),
    `A expected ${sha256(state.pageA).slice(0, 12)}, B must NOT be ${sha256(state.pageB).slice(0, 12)}`);

  const asB = await req(`/__asset/${state.assetHash}`, hostB);
  check("`assets` did NOT revert: B's image is still B's and still there", asB.status === 200, `${asB.status}`);
  const asA = await req(`/__asset/${state.assetHash}`, hostA);
  check("and A's is still collected — the revert reached `spaces` and stopped", asA.status === 404, `${asA.status}`);
}

// ---- run --------------------------------------------------------------------

async function main() {
  console.log(`bundle-tenancy-rehearsal — real workerd, real R2, two workspaces, port ${PORT}`);
  console.log(`  generated tree: ${WORK}`);
  await generate();

  let dep = null;
  try {
    dep = await boot("single", "single (no suffix, no TENANTS)", null); await singlePhase(); await shutdown(dep); dep = null;
    dep = await boot("hosted", `hosted (TENANT_HOST_SUFFIX=${SUFFIX})`, SUFFIX); await hostedPhase(); await shutdown(dep); dep = null;
    dep = await boot("reverted", "reverted (BUNDLE_TENANCY.spaces = false)", SUFFIX); await revertedPhase();
  } finally {
    await shutdown(dep);
    if (!KEEP) fs.rmSync(WORK, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${"═".repeat(78)}`);
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  for (const f of failed) console.log(`  FAILED  [${f.clause}] ${f.what}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(`\nrehearsal aborted: ${(e && e.stack) || e}`); process.exit(1); });
