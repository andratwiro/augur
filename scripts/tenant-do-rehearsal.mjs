#!/usr/bin/env node
/**
 * tenant-do-rehearsal — the identity families, driven on REAL workerd against a REAL
 * Durable Object.
 *
 * WHY THIS EXISTS. `test/kv-read-cutover.test.mjs` drives the real worker over the real
 * routes, but the store underneath it is `node:sqlite` behind a hand-written storage stub
 * and the namespace is an object literal with an `idFromName` that returns its argument.
 * That proves the SEAM — which store answers, what happens when it cannot, that the two
 * answers agree — and it cannot prove the RUNTIME. workerd's SQLite is not node's: column
 * affinity, the JS type a TEXT column comes back as, what a thrown error inside a Durable
 * Object looks like from the other side of `stub.fetch`, and whether a schema written by
 * one process is still there for the next one are all questions a stub answers by
 * construction rather than by being right. Every one of them is load-bearing here: the cut
 * families are the login gate's, and the first bug this cut-over found was an expiry
 * crossing as epoch milliseconds into an ISO TEXT column, which a strict read answers `NaN`
 * for and a tolerant one has to carry.
 *
 * So this stands up the ACTUAL deploy entry (`src/entry.js`'s module graph) under
 * `wrangler dev`, with a `TENANTS` binding to a `new_sqlite_classes` Durable Object and a
 * local KV namespace, and drives it over HTTP with nothing imported and no function called.
 *
 * ⚠️ IT IS LOCAL BY CONSTRUCTION AND MUST STAY THAT WAY. No account, no token, no route,
 * no remote binding: `--local` plus a `--persist-to` directory under `.wrangler/`, which is
 * gitignored. The fixture roster it generates is five invented addresses and a password it
 * prints in its own source. Nothing here may ever be pointed at a deployed instance — the
 * cases below deliberately break a workspace's store and delete rows.
 *
 * WHAT IS GENERATED AND WHY NONE OF IT IS COMMITTED. Three wrangler configs, an entry for
 * each, a two-file asset directory and a copy of `src/` with one word changed. They live in
 * `.wrangler/tenant-do-rehearsal/` for `scripts/lib/offline-wrangler.mjs`'s reason: a
 * config in the tree is a config a stray `wrangler` picks up, and an entry file carrying a
 * probe surface is a file that must never be deployable. The probe is the one liberty this
 * takes — a `/__rehearsal/*` prefix in front of the real front door, and a subclass of
 * `TenantStore` that adds ONE verb which runs a statement — and both exist only in the
 * generated tree. The engine's own request path, its worker and its store class are
 * untouched: every assertion below is made against a response the real front door produced.
 *
 * THE THREE DEPLOYMENTS, which differ in exactly what the clauses need them to:
 *   bound     `TENANTS` bound. The hosted shape.
 *   unbound   the same config with the binding and the migration removed, and nothing else.
 *   reverted  bound, but `main` resolves a COPY of src/ with one word flipped — the
 *             per-family revert, RUN rather than read.
 * All three share one `--persist-to` directory and one worker name, so the KV documents and
 * the object's SQLite survive from one to the next. That sharing is not a convenience: "the
 * two answer the same" and "the revert restores the KV answer" are both claims about one
 * workspace's state seen through two deployments, and a fresh store each time would make
 * either of them vacuous.
 *
 * Usage:
 *   node scripts/tenant-do-rehearsal.mjs [--port 8811] [--keep]
 *
 * `--keep` leaves the generated tree for inspection. `WRANGLER_BIN` overrides how wrangler
 * is spawned (default `npx wrangler`), for a machine that has one installed already.
 *
 * Exit 0 when every clause passed, 1 otherwise. Each clause prints the request it made and
 * the response it saw, because the point of a rehearsal is the transcript.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORK = path.join(ROOT, ".wrangler", "tenant-do-rehearsal");

const argv = process.argv.slice(2);
const PORT = Number((argv.find((a) => a.startsWith("--port=")) || "").split("=")[1]
  || (argv.includes("--port") ? argv[argv.indexOf("--port") + 1] : 0)) || 8811;
const KEEP = argv.includes("--keep");

// The fixture. Five invented addresses on a reserved-for-documentation domain, one
// password, one session secret — none of it is a credential and none of it leaves this
// machine. `.test` and `example.test` are reserved names by RFC, so a stray lookup resolves
// nowhere.
const SUFFIX = ".rehearsal.test";
// Not `alpha`, not `demo`, not `test`: `RESERVED_LABELS` in src/tenant-host.mjs refuses
// every name an operator reaches for in a hurry, and the resolver's refusal is a bare 404
// that looks exactly like a broken fixture. This one is a bird.
const WORKSPACE = "wren";
const HOST = WORKSPACE + SUFFIX;
const ADMIN = "ada@example.test";
const ONE = "grace@example.test";
const TWO = "hedy@example.test";
const THREE = "ida@example.test";
const FOUR = "jean@example.test";
const PASSWORD = "a properly long password";
const SESSION_SECRET = "rehearsal-session-secret-not-a-credential";
const WORKER_NAME = "augur-tenant-do-rehearsal";
const KV_ID = "tenant-do-rehearsal-kv";

const USER_INVITES_KEY = "users:invites";
const USER_SECRETS_KEY = "users:secrets";
const LASTSEEN_PREFIX = "users:lastseen:";
const DAY_MS = 24 * 60 * 60 * 1000;

// ---- the transcript ---------------------------------------------------------

const results = [];
let currentClause = "setup";
function clause(name) { currentClause = name; console.log(`\n── ${name} ${"─".repeat(Math.max(0, 74 - name.length))}`); }
function check(what, ok, detail = "") {
  results.push({ clause: currentClause, what, ok });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${what}${detail ? `\n        ${String(detail).replace(/\n/g, "\n        ")}` : ""}`);
}
function note(text) { console.log(`        ${String(text).replace(/\n/g, "\n        ")}`); }

// ---- the generated tree -----------------------------------------------------

/** sha256 hex of a string — the digest `tokenFor` computes, recomputed here without it. */
const sha256hex = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
/** How an invite token is keyed in the object: `tokenFor("inv:" + token)`. One contract. */
const inviteHash = (token) => sha256hex("gv:inv:" + token);
/** A token shaped like the ones `mintInvite` issues, for the rows written directly. */
const freshToken = () => crypto.randomBytes(32).toString("base64")
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * The rehearsal entry.
 *
 * Two additions to `src/entry.js`, both confined to a prefix the engine does not use:
 *
 *   `/__rehearsal/*` in FRONT of the worker — read and write the KV binding, call the
 *   workspace object directly, and report what the runtime says it is. Setup and
 *   inspection only: no clause is asserted from anything this returns except the two that
 *   ask what the runtime IS, and every clause's evidence is a response the real front door
 *   produced.
 *
 *   ONE verb on the store class, `/__rehearsal/sql`, which runs a statement. That is how a
 *   row is written in the shape an older copy wrote it, and how the store is BROKEN at the
 *   runtime level: renaming the `invites` table away makes the real `inviteRead`'s real
 *   SELECT throw inside the real object, which is an outage the way an outage happens
 *   rather than a stub returning a 500. `init()` short-circuits on a warm object, so the
 *   table does not spring back before the case can see it.
 */
function entrySource(srcDir) {
  const q = (p) => JSON.stringify(path.join(srcDir, p));
  return `// GENERATED by scripts/tenant-do-rehearsal.mjs — not a deploy entry, never committed.
import worker, { __testables } from ${q("_worker.js")};
import { TenantStore as RealTenantStore } from ${q("tenant-do.js")};
export { BoardRoom } from ${q("board-room.mjs")};

export class TenantStore extends RealTenantStore {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__rehearsal/sql") {
      const { stmt, params = [] } = await request.json();
      try {
        const rows = [...this.ctx.storage.sql.exec(stmt, ...params)];
        return Response.json({ ok: true, rows, types: rows.map((r) => Object.fromEntries(
          Object.entries(r).map(([k, v]) => [k, v === null ? "null" : typeof v]))) });
      } catch (e) {
        return Response.json({ ok: false, error: String((e && e.message) || e) });
      }
    }
    return super.fetch(request);
  }
}

async function probe(request, env, url) {
  if (url.pathname === "/__rehearsal/runtime") {
    let sqlite = null;
    let sqliteVersion = null;
    if (env.TENANTS) {
      const stub = env.TENANTS.get(env.TENANTS.idFromName(${JSON.stringify(WORKSPACE)}));
      const ask = async (stmt) => {
        const r = await stub.fetch("https://workspace/__rehearsal/sql", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ stmt }),
        });
        return r.json();
      };
      // The tables, which is the proof; and sqlite_version(), which workerd REFUSES and
      // node:sqlite answers — the cheapest evidence that this is not the test harness.
      sqlite = await ask("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
      sqliteVersion = await ask("SELECT sqlite_version() AS v");
    }
    return Response.json({
      userAgent: (globalThis.navigator && globalThis.navigator.userAgent) || null,
      compatibilityDate: null,
      tenantsBound: !!env.TENANTS,
      namespaceCtor: env.TENANTS ? String(env.TENANTS.constructor && env.TENANTS.constructor.name) : null,
      idFromName: env.TENANTS ? String(env.TENANTS.idFromName(${JSON.stringify(WORKSPACE)})) : null,
      kvCutover: __testables.KV_CUTOVER,
      hostSuffix: env.TENANT_HOST_SUFFIX || null,
      sqlite, sqliteVersion,
    });
  }
  if (url.pathname === "/__rehearsal/kv") {
    const b = await request.json();
    const kv = env.COMMENTS;
    if (b.op === "get") return Response.json({ value: await kv.get(b.key) });
    if (b.op === "put") { await kv.put(b.key, b.value); return Response.json({ ok: true }); }
    if (b.op === "delete") { await kv.delete(b.key); return Response.json({ ok: true }); }
    if (b.op === "list") return Response.json(await kv.list({ prefix: b.prefix || "" }));
    return Response.json({ error: "bad-op" }, { status: 400 });
  }
  if (url.pathname === "/__rehearsal/do") {
    if (!env.TENANTS) return Response.json({ error: "no-binding" }, { status: 400 });
    const b = await request.json();
    const stub = env.TENANTS.get(env.TENANTS.idFromName(b.workspace));
    try {
      const res = await stub.fetch("https://workspace" + b.path, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(b.body || {}),
      });
      return Response.json({ status: res.status, body: await res.text() });
    } catch (e) {
      return Response.json({ threw: String((e && e.message) || e) });
    }
  }
  return Response.json({ error: "not-found" }, { status: 404 });
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

/** The wrangler config. `tenants:false` removes the binding AND the migration, nothing else. */
function wranglerConfig({ entry, assets, tenants }) {
  return `# GENERATED by scripts/tenant-do-rehearsal.mjs on every run — edit that, not this.
name = ${JSON.stringify(WORKER_NAME)}
main = ${JSON.stringify(entry)}
compatibility_date = "2025-01-01"

[assets]
directory = ${JSON.stringify(assets)}
binding = "ASSETS"
# The gate. Same line, same reason, as scripts/lib/offline-wrangler.mjs.
run_worker_first = true
not_found_handling = "none"
html_handling = "auto-trailing-slash"

[vars]
# Set means the workspace is the first Host label — the dynamic resolver, which is the only
# shape a TENANTS binding is legal in (scripts/wrangler-preflight.mjs refuses the halves).
TENANT_HOST_SUFFIX = ${JSON.stringify(SUFFIX)}

[[kv_namespaces]]
binding = "COMMENTS"
id = ${JSON.stringify(KV_ID)}
${tenants ? `
[[durable_objects.bindings]]
name = "TENANTS"
class_name = "TenantStore"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["TenantStore"]
` : `
# NO TENANTS BINDING. The single difference from the bound config, and the whole of the
# "with it unbound the instance answers from KV" clause.
`}`;
}

async function generate() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(path.join(WORK, "assets", "__config"), { recursive: true });

  // The roster. `passHash` is computed by the engine's own hasher — the fixture has to be a
  // hash this worker will verify, and reimplementing PBKDF2 here would be a second opinion
  // about the credential format. It is the only thing this file imports from src/, it runs
  // before any deployment exists, and nothing below calls a worker function.
  const { __testables: W } = await import(path.join(ROOT, "src", "_worker.js"));
  const passHash = await W.hashPassword(PASSWORD);
  const roster = [
    { email: ADMIN, name: "Ada", initials: "A", role: "admin", passHash },
    { email: ONE, name: "Grace", initials: "G", role: "editor" },
    { email: TWO, name: "Hedy", initials: "H", role: "editor" },
    { email: THREE, name: "Ida", initials: "I", role: "editor" },
    { email: FOUR, name: "Jean", initials: "J", role: "editor" },
  ];
  fs.writeFileSync(path.join(WORK, "assets", "__config", "instance.json"), JSON.stringify({
    users: roster, engineVersion: "0.0.0-rehearsal", updateFeed: "",
    mcpHostSuffixes: [], mcpHostAllowlistUrl: "", vanityRedirects: {}, rtOrigin: "", sentinels: [],
  }));
  fs.writeFileSync(path.join(WORK, "assets", "__config", "routing.json"), JSON.stringify({
    buildId: "rehearsal", versionMap: {}, publicPrefixes: [], publicSkillPrefixes: [],
    restrictedBases: [], canvasLoaderExtras: "", canvasCatalog: [], canvasTracks: [], mcpAllowlist: [],
    spaces: [{ id: "one", name: "One", badge: "O", default: true, base: "", adminOnly: false }],
    defaultSpace: "one",
  }));

  const src = path.join(ROOT, "src");
  fs.writeFileSync(path.join(WORK, "entry.js"), entrySource(src));

  // THE REVERT, as a copy of src/ with one word changed. Copied rather than patched in
  // place for the obvious reason — the tree under test must not be edited to test it — and
  // the edit is asserted to have landed, because a revert that silently did not apply is a
  // clause that passes for the wrong reason.
  const revertedSrc = path.join(WORK, "reverted-src");
  fs.cpSync(src, revertedSrc, { recursive: true });
  const wf = path.join(revertedSrc, "_worker.js");
  const before = fs.readFileSync(wf, "utf8");
  const after = before.replace(/(const KV_CUTOVER = Object\.freeze\(\{[\s\S]{0,4000}?\n)(\s*)invites: true,/,
    (_m, head, indent) => `${head}${indent}invites: false,`);
  if (after === before) throw new Error("the revert edit did not apply — has KV_CUTOVER moved or been renamed?");
  fs.writeFileSync(wf, after);
  fs.writeFileSync(path.join(WORK, "reverted-entry.js"), entrySource(revertedSrc));

  const assets = path.join(WORK, "assets");
  fs.writeFileSync(path.join(WORK, "bound.toml"),
    wranglerConfig({ entry: path.join(WORK, "entry.js"), assets, tenants: true }));
  fs.writeFileSync(path.join(WORK, "unbound.toml"),
    wranglerConfig({ entry: path.join(WORK, "entry.js"), assets, tenants: false }));
  fs.writeFileSync(path.join(WORK, "reverted.toml"),
    wranglerConfig({ entry: path.join(WORK, "reverted-entry.js"), assets, tenants: true }));
}

// ---- one deployment ---------------------------------------------------------

const BASE = () => `http://127.0.0.1:${PORT}`;

/**
 * Spawn `wrangler dev` on one config and wait for it to answer.
 *
 * One at a time, on one port, sharing one persist directory: the deployments are a
 * SEQUENCE, not a set. Two of them at once would be two workerd processes with the same
 * SQLite files open.
 */
async function boot(config, label) {
  const bin = process.env.WRANGLER_BIN || "npx";
  const args = process.env.WRANGLER_BIN ? [] : ["--yes", "wrangler"];
  const child = spawn(bin, [...args,
    "dev", "-c", path.join(WORK, `${config}.toml`),
    "--local", "--ip", "127.0.0.1", "--port", String(PORT),
    "--persist-to", path.join(WORK, "state"),
    "--var", `SESSION_SECRET:${SESSION_SECRET}`,
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
      const r = await req("/__rehearsal/runtime", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
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
 * Every request carries the workspace's Host — that is the whole of the resolver's input.
 *
 * ⚠️ `node:http`, NOT `fetch`. undici treats `Host` as a forbidden header and drops it
 * silently, so every request goes out naming `127.0.0.1`, `tenantLabelFromHost` answers
 * null and the front door serves the bare 404 a hostname naming no workspace gets. Which
 * is correct behaviour, and looks exactly like a broken fixture.
 */
function req(pathname, { method = "GET", headers = {}, body, cookie } = {}) {
  const h = { Host: HOST, ...headers };
  if (cookie) h.Cookie = cookie;
  if (body != null) h["content-length"] = String(Buffer.byteLength(body));
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, path: pathname, method, headers: h }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        setCookie: (res.headers["set-cookie"] || [])[0] || null,
        text: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    r.on("error", reject);
    if (body != null) r.write(body);
    r.end();
  });
}
const form = (obj) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(obj).toString(),
});
async function rehearse(pathname, body) {
  const res = await req(pathname, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return JSON.parse(res.text);
}
const kvGet = (key) => rehearse("/__rehearsal/kv", { op: "get", key });
const kvPut = (key, value) => rehearse("/__rehearsal/kv", { op: "put", key, value });
const kvDel = (key) => rehearse("/__rehearsal/kv", { op: "delete", key });
const sql = (stmt, params = []) => rehearse("/__rehearsal/do", {
  workspace: WORKSPACE, path: "/__rehearsal/sql", body: { stmt, params },
}).then((r) => (r.body ? JSON.parse(r.body) : r));
const identityCall = (op, body) => rehearse("/__rehearsal/do", {
  workspace: WORKSPACE, path: `/identity/${op}`, body: { ...body, workspaceId: WORKSPACE },
});

/** Sign in over the real login form. Returns the session cookie pair. */
async function signIn(email) {
  const r = await req("/__auth", form({ email, password: PASSWORD, redirect: "/" }));
  if (r.status !== 303 || !r.setCookie) throw new Error(`sign-in failed (${r.status})`);
  return r.setCookie.split(";")[0];
}

/** Mint an invite the only way a person ever gets one: the admin route. */
async function mintVia(cookie, email) {
  const r = await req("/__admin/users", {
    method: "POST", headers: { "content-type": "application/json" }, cookie,
    body: JSON.stringify({ op: "reset", email }),
  });
  if (r.status !== 200) throw new Error(`mint failed (${r.status}): ${r.text.slice(0, 300)}`);
  return new URL(JSON.parse(r.text).url).searchParams.get("t");
}

const invitesDoc = async () => JSON.parse((await kvGet(USER_INVITES_KEY)).value || "{}");
const secretsDoc = async () => JSON.parse((await kvGet(USER_SECRETS_KEY)).value || "{}");
const inviteRow = async (token) => {
  const r = await sql("SELECT token_hash, email, expires_at FROM invites WHERE token_hash = ?", [inviteHash(token)]);
  return r.ok && r.rows.length ? { row: r.rows[0], type: r.types[0].expires_at } : null;
};

// ---- the clauses ------------------------------------------------------------

const state = {};

async function boundPhase() {
  clause("0 · the runtime is workerd and the store is a real Durable Object");
  const rt = await rehearse("/__rehearsal/runtime", {});
  check("the isolate reports a workerd user agent", /workerd|Cloudflare-Workers/i.test(rt.userAgent || ""), rt.userAgent);
  check("TENANTS is a Durable Object namespace: idFromName is a 64-hex object id, not its argument",
    rt.tenantsBound && /^[0-9a-f]{64}$/.test(String(rt.idFromName)),
    `idFromName("${WORKSPACE}") = ${rt.idFromName}`);
  check("this deployment reads invites AND lastseen from the object",
    rt.kvCutover.invites === true && rt.kvCutover.lastseen === true, JSON.stringify(rt.kvCutover));
  // One identity call, which is what applies the schema — the object is created lazily and
  // `init()` runs on the first request the request path makes to it.
  await identityCall("lastseen/read", {});
  const tables = await sql("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
  const names = tables.ok ? tables.rows.map((r) => r.name) : [];
  check("the object's storage is SQLite and carries the engine's schema",
    ["invites", "lastseen", "members", "meta", "publish_tokens"].every((t) => names.includes(t)),
    names.join(", "));
  check("and it is workerd's SQLite, not node's: sqlite_version() is REFUSED here",
    rt.sqliteVersion && rt.sqliteVersion.ok === false && /not authorized/i.test(rt.sqliteVersion.error || ""),
    JSON.stringify(rt.sqliteVersion));

  clause("1 · the cut families answer from the object, and the read is not vacuous");
  const cookie = await signIn(ADMIN);
  check("the login gate admits the admin over the real form", !!cookie, cookie.slice(0, 34) + "…");
  const t1 = await mintVia(cookie, ONE);
  const row1 = await inviteRow(t1);
  check("minting wrote a row to the object's invites table", !!row1 && row1.row.email === ONE,
    row1 ? JSON.stringify(row1.row) : "no row");
  check("and wrote the same invite to KV, which is what makes the flag a revert",
    !!(await invitesDoc())[t1], `users:invites keys: ${Object.keys(await invitesDoc()).length}`);

  // The expiry, in the column, as real SQLite holds it. This is the shape the bug was.
  const isoish = row1 && /^\d{4}-\d{2}-\d{2}T/.test(String(row1.row.expires_at));
  const ms = row1 ? Date.parse(row1.row.expires_at) : NaN;
  check("the expiry round-tripped as a parseable ISO stamp, not epoch milliseconds",
    isoish && Number.isFinite(ms) && Math.abs(ms - (Date.now() + 7 * DAY_MS)) < 5 * 60_000,
    `expires_at = ${row1 && row1.row.expires_at} (${row1 && row1.type}) → Date.parse = ${ms}`);

  // NON-VACUOUS: with the KV document gone, only the object can answer.
  await kvDel(USER_INVITES_KEY);
  check("KV's invite document is deleted, so nothing but the object can answer",
    Object.keys(await invitesDoc()).length === 0);
  const g1 = await req(`/__invite?t=${encodeURIComponent(t1)}`);
  check("GET /__invite resolves the invitee from the object with KV deleted",
    g1.status === 200 && g1.text.includes(ONE), `${g1.status}, names ${ONE}: ${g1.text.includes(ONE)}`);
  const p1 = await req("/__invite", form({ token: t1, password: PASSWORD }));
  check("POST /__invite is ADMITTED on the object path with KV deleted",
    p1.status === 303 && !!p1.setCookie, `${p1.status}, Set-Cookie: ${p1.setCookie ? "yes" : "no"}`);
  check("redeeming wrote the credential", !!(await secretsDoc())[ONE]);
  check("and burned the object's row", (await inviteRow(t1)) === null);

  clause("5 · the second use of the same link is refused, on the object path");
  const p2 = await req("/__invite", form({ token: t1, password: PASSWORD }));
  check("POST /__invite a second time is refused with no session",
    p2.status === 400 && !p2.setCookie && /no longer valid/i.test(p2.text),
    `${p2.status}, Set-Cookie: ${p2.setCookie ? "yes" : "no"}`);

  // ⚠️ THE CLAIM A STUB CANNOT TEST. `consumeInvite`'s comment says a Durable Object is
  // single-threaded, so the read and the delete cannot interleave and the second of two
  // concurrent redemptions gets null. The harness's `blockConcurrencyWhile` is `(f) => f()`
  // and its storage is one synchronous database, so it agrees with that claim for reasons
  // that have nothing to do with the runtime. Six requests in flight at once, on workerd.
  const race = await mintVia(cookie, ONE);
  const flight = await Promise.all(Array.from({ length: 6 },
    () => req("/__invite", form({ token: race, password: PASSWORD }))));
  const admitted = flight.filter((r) => r.status === 303 && r.setCookie);
  check("six simultaneous redemptions of one link admit EXACTLY ONE",
    admitted.length === 1, `statuses: ${flight.map((r) => r.status).join(" ")}`);

  clause("4 · the expiry round-trips through real SQLite, both spellings");
  // (b) A row in the OLD numeric shape — what a copy written before the fix left behind.
  const tOld = freshToken();
  const oldMs = String(Date.now() + 3 * DAY_MS);
  const ins = await sql(
    `INSERT INTO invites (token_hash, email, created_at, expires_at, created_by) VALUES (?,?,?,?,NULL)`,
    [inviteHash(tOld), TWO, new Date().toISOString(), oldMs]);
  check("a pre-fix row (epoch milliseconds in the ISO TEXT column) inserts", ins.ok, JSON.stringify(ins).slice(0, 200));
  const rOld = await inviteRow(tOld);
  note(`workerd returns that column as a JS ${rOld && rOld.type}: ${JSON.stringify(rOld && rOld.row.expires_at)}`);
  check("Date.parse still cannot read it — the bug is real on this runtime",
    !Number.isFinite(Date.parse(String(rOld && rOld.row.expires_at))),
    `Date.parse(${JSON.stringify(rOld && rOld.row.expires_at)}) = ${Date.parse(String(rOld && rOld.row.expires_at))}`);
  const gOld = await req(`/__invite?t=${encodeURIComponent(tOld)}`);
  check("and the pre-fix row is STILL REDEEMABLE — stampMs carries it",
    gOld.status === 200 && gOld.text.includes(TWO), `${gOld.status}, names ${TWO}: ${gOld.text.includes(TWO)}`);
  const pOld = await req("/__invite", form({ token: tOld, password: PASSWORD }));
  check("redeeming the pre-fix row issues a session", pOld.status === 303 && !!pOld.setCookie, `${pOld.status}`);

  // The same row, written the way the COPY actually wrote it — through the object's own
  // `/state/import`, with `expiresAt` a JS NUMBER. `writeIdentity` binds it verbatim, so
  // what the column ends up holding is workerd's affinity decision and not this file's.
  const tImport = freshToken();
  const imported = await rehearse("/__rehearsal/do", {
    workspace: WORKSPACE, path: "/state/import",
    body: {
      workspaceId: WORKSPACE, overlay: {},
      identity: { invites: [{
        tokenHash: inviteHash(tImport), email: TWO,
        createdAt: new Date().toISOString(), expiresAt: Date.now() + 3 * DAY_MS, createdBy: null,
      }] },
    },
  });
  check("the copy's own import verb accepts a numeric expiry without throwing",
    imported.status === 200, JSON.stringify(imported).slice(0, 220));
  const rImp = await inviteRow(tImport);
  note(`bound as a JS number, workerd's TEXT column returns a ${rImp && rImp.type}: ${JSON.stringify(rImp && rImp.row.expires_at)}`);
  const gImp = await req(`/__invite?t=${encodeURIComponent(tImport)}`);
  check("and a row the copy wrote that way redeems over the real route",
    gImp.status === 200 && gImp.text.includes(TWO), `${gImp.status}`);

  // (a) Expiry is enforced, in both spellings.
  const tExpIso = freshToken(), tExpNum = freshToken();
  await sql(`INSERT INTO invites (token_hash, email, created_at, expires_at, created_by) VALUES (?,?,?,?,NULL)`,
    [inviteHash(tExpIso), TWO, new Date(Date.now() - DAY_MS).toISOString(), new Date(Date.now() - 60_000).toISOString()]);
  await sql(`INSERT INTO invites (token_hash, email, created_at, expires_at, created_by) VALUES (?,?,?,?,NULL)`,
    [inviteHash(tExpNum), TWO, new Date(Date.now() - DAY_MS).toISOString(), String(Date.now() - 60_000)]);
  const eIso = await req(`/__invite?t=${encodeURIComponent(tExpIso)}`);
  const eNum = await req(`/__invite?t=${encodeURIComponent(tExpNum)}`);
  check("an expired invite (ISO) is refused", eIso.status === 400 && /no longer valid/i.test(eIso.text), `${eIso.status}`);
  check("an expired invite (epoch milliseconds) is refused too — the tolerant read is not a blanket yes",
    eNum.status === 400 && /no longer valid/i.test(eNum.text), `${eNum.status}`);

  clause("3 · THE LOGIN GATE FAILS CLOSED ON A REAL OBJECT");
  const t5 = await mintVia(cookie, THREE);
  check("a fresh invite exists in BOTH stores, so a fall-through to KV would succeed",
    !!(await inviteRow(t5)) && !!(await invitesDoc())[t5]);
  check("the invitee has no credential yet", !(await secretsDoc())[THREE]);

  // THE BREAK, at the runtime level: the table the real SELECT reads is renamed away, so
  // the real method throws inside the real object. init() is a no-op on a warm object, so
  // nothing puts it back before the case can look.
  const broke = await sql(`ALTER TABLE invites RENAME TO invites_broken`);
  check("the object's invites table is renamed away", broke.ok, JSON.stringify(broke).slice(0, 160));
  const direct = await identityCall("invite/read", { tokenHash: inviteHash(t5), now: Date.now() });
  check("the object now ANSWERS AN ERROR to an identity read (a real throw, not a stub)",
    direct.status >= 500 || !!direct.threw, JSON.stringify(direct).slice(0, 220));

  const gBroke = await req(`/__invite?t=${encodeURIComponent(t5)}`);
  check("GET /__invite REFUSES rather than falling through to the live KV row",
    gBroke.status === 400 && /no longer valid/i.test(gBroke.text), `${gBroke.status}`);
  const pBroke = await req("/__invite", form({ token: t5, password: PASSWORD }));
  check("POST /__invite is a REFUSAL, NOT AN ADMISSION", pBroke.status === 400, `${pBroke.status}`);
  check("no Set-Cookie was issued", !pBroke.setCookie, `Set-Cookie: ${pBroke.setCookie || "none"}`);
  check("no credential was written", !(await secretsDoc())[THREE]);
  const stillIn = await signIn(ADMIN).then(() => true, () => false);
  check("a family that was NOT broken still answers — the outage is scoped, not global", stillIn);
  const meBroke = await req("/__me", { cookie });
  check("an ALREADY-SIGNED-IN session still resolves while the object's read is broken",
    meBroke.status === 200 && JSON.parse(meBroke.text).user
      && JSON.parse(meBroke.text).user.email === ADMIN, meBroke.text.slice(0, 120));

  const fixed = await sql(`ALTER TABLE invites_broken RENAME TO invites`);
  check("the object's table is restored", fixed.ok);
  const pOk = await req("/__invite", form({ token: t5, password: PASSWORD }));
  check("THE SAME LINK IS NOW ADMITTED", pOk.status === 303 && !!pOk.setCookie, `${pOk.status}`);
  check("and the credential is written", !!(await secretsDoc())[THREE]);

  clause("7 · revocation on the object path — DELETE … RETURNING, on workerd's SQLite");
  // `inviteRevoke` and `lastseenForget` are the only statements in the cut families that
  // use RETURNING, and they are the two whose failure is a way back in for somebody who was
  // just removed: redeeming calls `setUserSecret`, which REPLACES the tombstone removal
  // wrote. If this dialect were unsupported the call would throw, and `revokeInvitesFor`
  // does not swallow it — so this is the case that says which of the two happened.
  const tGone = await mintVia(cookie, FOUR);
  check("the person has an outstanding link in the object", !!(await inviteRow(tGone)));
  const rm = await req("/__admin/users", {
    method: "POST", headers: { "content-type": "application/json" }, cookie,
    body: JSON.stringify({ op: "remove", email: FOUR }),
  });
  check("removing them succeeds — the RETURNING statements ran", rm.status === 200, `${rm.status} ${rm.text.slice(0, 160)}`);
  check("their invite row is gone from the object", (await inviteRow(tGone)) === null);
  check("and gone from KV too", !(await invitesDoc())[tGone]);
  const gGone = await req(`/__invite?t=${encodeURIComponent(tGone)}`);
  check("their link is dead", gGone.status === 400 && !gGone.setCookie, `${gGone.status}`);

  clause("2 · setup — an answer to compare, and a state only one store holds");
  await req("/__me", { cookie });                       // stamps lastseen on both stores
  const seenRow = await sql(`SELECT email, at FROM lastseen WHERE email = ?`, [ADMIN]);
  check("the object holds the admin's lastseen stamp", seenRow.ok && seenRow.rows.length === 1,
    JSON.stringify(seenRow.rows));
  const seenKv = (await kvGet(LASTSEEN_PREFIX + ADMIN)).value;
  check("and KV holds the mirror of it — the dual write", !!seenKv, String(seenKv));
  state.lastSeenAt = seenRow.rows[0].at;
  // The throttle is the object's now, and the mirror is written from ITS verdict — so a
  // second page view inside the window must move neither stamp.
  await kvDel(LASTSEEN_PREFIX + ADMIN);
  await req("/__me", { cookie });
  const seenAgain = await sql(`SELECT at FROM lastseen WHERE email = ?`, [ADMIN]);
  check("a second page view inside the window rewrites nothing — the throttle is the object's",
    seenAgain.rows[0].at === state.lastSeenAt && !(await kvGet(LASTSEEN_PREFIX + ADMIN)).value,
    `object ${seenAgain.rows[0].at}, KV mirror rewritten: ${!!(await kvGet(LASTSEEN_PREFIX + ADMIN)).value}`);
  await kvPut(LASTSEEN_PREFIX + ADMIN, state.lastSeenAt);  // put the mirror back for clause 2

  // The token both deployments will be asked about: minted through the admin route, so it
  // is in both stores, which is the only way "the two answers agree" means anything.
  state.shared = await mintVia(cookie, ONE);
  const gShared = await req(`/__invite?t=${encodeURIComponent(state.shared)}`);
  state.boundInvite = { status: gShared.status, names: gShared.text.includes(ONE) };
  const admin = await req("/__admin/users", { cookie });
  state.boundAdmin = JSON.parse(admin.text).users.find((u) => u.email === ADMIN);
  note(`bound: GET /__invite → ${gShared.status}; admin list lastSeen = ${state.boundAdmin.lastSeen}`);

  // The object-only token for the revert clause, and the admin cookie the next two
  // deployments reuse. Minted now, stripped from KV after the unbound comparison.
  state.objectOnly = await mintVia(cookie, TWO);
  state.cookie = cookie;
}

async function unboundPhase() {
  clause("2 · bound and unbound return the same answer for the same workspace");
  const rt = await rehearse("/__rehearsal/runtime", {});
  check("this deployment binds no workspace object", rt.tenantsBound === false, JSON.stringify({ tenantsBound: rt.tenantsBound }));
  const g = await req(`/__invite?t=${encodeURIComponent(state.shared)}`);
  check("GET /__invite: same status and same invitee as the bound deployment",
    g.status === state.boundInvite.status && g.text.includes(ONE) === state.boundInvite.names,
    `bound ${state.boundInvite.status}/${state.boundInvite.names} · unbound ${g.status}/${g.text.includes(ONE)}`);
  const admin = await req("/__admin/users", { cookie: state.cookie });
  const me = JSON.parse(admin.text).users.find((u) => u.email === ADMIN);
  check("GET /__admin/users: the same lastSeen stamp for the same person",
    me.lastSeen === state.boundAdmin.lastSeen, `bound ${state.boundAdmin.lastSeen} · unbound ${me.lastSeen}`);

  // Set up the revert clause from here, where there is no object to touch by accident:
  // one invite left only in the object, and a lastseen stamp left only in the object.
  const doc = await invitesDoc();
  delete doc[state.objectOnly];
  await kvPut(USER_INVITES_KEY, JSON.stringify(doc));
  await kvDel(LASTSEEN_PREFIX + ADMIN);
  check("one invite is now object-only, and the admin's lastseen stamp is object-only",
    !(await invitesDoc())[state.objectOnly] && !(await kvGet(LASTSEEN_PREFIX + ADMIN)).value);
}

async function revertedPhase() {
  clause("6 · the per-family revert, RUN on the real runtime");
  const rt = await rehearse("/__rehearsal/runtime", {});
  check("this deployment is bound, and reads invites from KV while lastseen stays on the object",
    rt.tenantsBound === true && rt.kvCutover.invites === false && rt.kvCutover.lastseen === true,
    JSON.stringify(rt.kvCutover));

  const rowStillThere = await inviteRow(state.objectOnly);
  check("the object still HOLDS the object-only invite — the revert loses no data",
    !!rowStillThere, rowStillThere ? JSON.stringify(rowStillThere.row) : "gone");
  const g = await req(`/__invite?t=${encodeURIComponent(state.objectOnly)}`);
  check("and it is no longer answered — the object is not read for this family any more",
    g.status === 400, `${g.status}`);
  const gKv = await req(`/__invite?t=${encodeURIComponent(state.shared)}`);
  check("the invite KV still holds IS answered — KV answers again",
    gKv.status === 200 && gKv.text.includes(ONE), `${gKv.status}`);

  const t8 = await mintVia(state.cookie, THREE);
  check("a new invite goes to KV", !!(await invitesDoc())[t8]);
  check("and NOT to the object", (await inviteRow(t8)) === null);
  const p8 = await req("/__invite", form({ token: t8, password: PASSWORD }));
  check("and redeems over the KV path", p8.status === 303 && !!p8.setCookie, `${p8.status}`);

  check("KV still holds no lastseen stamp for the admin", !(await kvGet(LASTSEEN_PREFIX + ADMIN)).value);
  const admin = await req("/__admin/users", { cookie: state.cookie });
  const me = JSON.parse(admin.text).users.find((u) => u.email === ADMIN);
  check("yet the admin list still shows one — lastseen did NOT come back with invites",
    me.lastSeen === state.lastSeenAt, `object ${state.lastSeenAt} · served ${me.lastSeen}`);
}

// ---- run --------------------------------------------------------------------

async function main() {
  console.log(`tenant-do-rehearsal — real workerd, real Durable Object, port ${PORT}`);
  console.log(`  generated tree: ${WORK}`);
  await generate();

  let dep = null;
  try {
    dep = await boot("bound", "bound"); await boundPhase(); await shutdown(dep); dep = null;
    dep = await boot("unbound", "unbound"); await unboundPhase(); await shutdown(dep); dep = null;
    dep = await boot("reverted", "reverted (KV_CUTOVER.invites = false)"); await revertedPhase();
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
