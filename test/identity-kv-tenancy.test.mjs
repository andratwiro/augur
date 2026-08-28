// The identity KV documents carry the workspace, on the WRITE path.
//
// `B-identity-kv-write-segmentation`. `BUNDLE_TENANCY` closed the content half and
// `KV_CUTOVER` moved the identity READS to the workspace object; the identity WRITES still
// landed in one deployment-wide document each. A full state restore into a second workspace
// therefore overwrote the first one's `publish:tokens`, roster, roles, names, avatars and
// icons — and a nightly reset that CLEARS those families cleared them for every workspace
// at once, with no migration involved at all.
//
// ── WHAT A GREEN RESULT HERE IS EVIDENCE OF ──────────────────────────────────────────
//
// TWO WORKSPACES ON ONE DEPLOYMENT, sharing one KV namespace and one R2 bucket, resolved
// from the Host exactly as the hosted worker resolves them. Every case drives the REAL
// worker through `worker.fetch` over the same routes an operator or a person would use —
// a restore, a reset, a rename, a role change, a publish — and asserts each workspace's OWN
// answer rather than merely that the two differ. The stores are read to set a case up and,
// where the clause is about bytes, to compare documents before and after.
//
// ── AND WHAT IT IS NOT ───────────────────────────────────────────────────────────────
//
// `node:sqlite` behind a storage stub is not workerd and an in-memory Map is not KV. This
// proves the KEY SHAPE and the seam. `scripts/identity-tenancy-rehearsal.mjs` is the same
// clauses on real workerd with a real KV and a real R2, and it is what a key shape has to
// be believed on — the `PRAGMA table_info` bug in the sibling item was written and caught
// exactly there, green suite and all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TenantStore } from "../src/tenant-do.js";
import { STATE_INVENTORY } from "../src/state-inventory.mjs";
import * as WORKER from "../src/_worker.js";

const W = WORKER.__testables;

const SUFFIX = ".example.test";
const ADMIN = "ada@example.test";
const GUEST = "grace@example.test";
const PASSWORD = "a properly long password";
const PASS_HASH = await W.hashPassword(PASSWORD);

const ROSTER = [
  { email: ADMIN, name: "Ada", initials: "A", role: "admin", passHash: PASS_HASH },
  { email: GUEST, name: "Grace", initials: "G", role: "editor", passHash: PASS_HASH },
];

const CONFIG = {
  "/__config/instance.json": JSON.stringify({
    users: ROSTER, engineVersion: "1.0.0-idkv", updateFeed: "",
    mcpHostSuffixes: [], mcpHostAllowlistUrl: "", vanityRedirects: {}, rtOrigin: "", sentinels: [],
  }),
  "/__config/routing.json": JSON.stringify({
    buildId: "idkv-build", versionMap: {}, publicPrefixes: [], publicSkillPrefixes: [],
    restrictedBases: [], canvasLoaderExtras: "", canvasCatalog: [], canvasTracks: [], mcpAllowlist: [],
    spaces: [{ id: "one", name: "One", badge: "O", default: true, base: "", adminOnly: false }],
    defaultSpace: "one",
  }),
};

/** A DO storage stub with REAL transaction semantics. */
function storage(db) {
  const sql = {
    exec(stmt, ...params) {
      if (params.length) {
        const s = db.prepare(stmt);
        return /^\s*SELECT|RETURNING/i.test(stmt) ? s.all(...params) : (s.run(...params), []);
      }
      if (/^\s*SELECT/i.test(stmt)) return db.prepare(stmt).all();
      db.exec(stmt);
      return [];
    },
  };
  return {
    sql,
    transactionSync(cb) {
      db.exec("BEGIN");
      try { const out = cb(); db.exec("COMMIT"); return out; }
      catch (e) { db.exec("ROLLBACK"); throw e; }
    },
  };
}

function memKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async getWithMetadata(k) { return { value: store.has(k) ? store.get(k) : null, metadata: null }; },
    async put(k, v) { store.set(k, typeof v === "string" ? v : Buffer.from(v).toString("utf8")); },
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
      return { body: o, etag: "e", text: async () => Buffer.from(o).toString("utf8"), arrayBuffer: async () => Buffer.from(o) };
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

let seq = 0;

/**
 * ONE deployment, SEVERAL workspaces — the hosted shape, and the only shape this item is
 * about. `TENANT_HOST_SUFFIX` is set, so the workspace comes from the Host header and the
 * identity documents carry a segment; the KV namespace and the R2 bucket are shared, which
 * is exactly the sharing under test.
 */
async function deployment({ workspaces, workerModule = WORKER, broken = () => false } = {}) {
  const kv = memKV();
  const r2 = memR2();
  const objects = new Map();
  const dbs = new Map();
  for (const id of workspaces) {
    const db = new DatabaseSync(":memory:");
    dbs.set(id, db);
    const o = new TenantStore({ storage: storage(db), blockConcurrencyWhile: async (f) => f() }, {});
    await o.provision({ workspaceId: id, adminEmail: ADMIN });
    objects.set(id, o);
  }
  const pending = [];
  const env = {
    COMMENTS: kv,
    BUNDLES: r2,
    GV_ASSET_SOURCE: "r2",
    TENANT_HOST_SUFFIX: SUFFIX,
    SESSION_SECRET: "idkv-fixed-session-secret",
    TENANTS: {
      idFromName: (n) => n,
      get: (n) => ({
        fetch: (input, init) => {
          const url = new URL(typeof input === "string" ? input : input.url);
          if (broken(n) && url.pathname.startsWith("/identity/")) {
            return Promise.resolve(Response.json({ error: "storage-unavailable" }, { status: 500 }));
          }
          return objects.get(n).fetch(new Request(input, init));
        },
      }),
    },
    ASSETS: {
      async fetch(req) {
        const p = new URL(typeof req === "string" ? req : req.url).pathname;
        const body = CONFIG[p];
        return body === undefined
          ? new Response("Not Found", { status: 404 })
          : new Response(body, { headers: { "Content-Type": "application/json; charset=utf-8" } });
      },
    },
  };
  // Each workspace publishes the SAME space id, which is what the shared bucket used to
  // collide on and what `bundleKey` already separates. It is here so the publish routes
  // reach their auth check rather than answering "no such space" before it.
  for (const id of workspaces) {
    await r2.put(W.bundleKey("config/instance.json", id), Buffer.from(JSON.stringify({ tenantId: id, users: ROSTER })));
    await r2.put(W.bundleKey("spaces/one/manifest.json", id), Buffer.from(JSON.stringify({
      version: 1, space: "one", files: {}, routing: { publicPrefixes: [], versionMap: {} },
    })));
  }
  const T = workerModule.__testables;
  const fire = async (ws, p, init) => {
    T.__setTenantTestState({ memo: null });
    T.__setConfigTestState({ cfgAt: 0, cfgGoodAt: 0, roster: null, manifests: null, storage: null });
    // ⚠️ THE HOST HEADER IS SET EXPLICITLY. `resolveTenant` reads the header, not the
    // URL, and a `Request` built from a URL does not necessarily carry one — a fixture
    // that leaves it off resolves NO workspace and every route answers 404, which reads
    // as a broken change rather than as a broken fixture.
    const req = new Request(`https://${ws}${SUFFIX}${p}`, {
      ...(init || {}),
      headers: { ...((init && init.headers) || {}), host: `${ws}${SUFFIX}` },
    });
    const res = await workerModule.default.fetch(req, env, { waitUntil: (x) => pending.push(x) });
    await Promise.all(pending.splice(0));
    return res;
  };
  const cookieFor = async (ws, email) => {
    const u = ROSTER.find((r) => r.email === email);
    const secret = await T.effectiveSecret(env, u);
    const tctx = { tenantId: ws };
    return { Cookie: `__Host-augur_user=${email}.${await T.userToken(env, u, secret, false, tctx)}` };
  };
  /** What one workspace's identity documents ARE, read at the physical key. */
  const docs = (ws) => {
    const out = {};
    for (const [family, names] of Object.entries(W.IDENTITY_KV_FAMILIES)) {
      for (const name of names) {
        if (name.endsWith(":")) {
          const seg = W.IDENTITY_TENANT_PREFIX + ws + "/" + name;
          for (const k of kv.store.keys()) if (k.startsWith(seg)) out[k.slice((W.IDENTITY_TENANT_PREFIX + ws + "/").length)] = kv.store.get(k);
        } else {
          const k = W.identityKey(name, ws);
          if (kv.store.has(k)) out[name] = kv.store.get(k);
        }
      }
    }
    return out;
  };
  return { env, kv, r2, objects, fire, cookieFor, docs };
}

/** Mint a publish token through the ADMIN ROUTE — the only way anyone ever gets one. */
async function mintToken(d, ws, space = "one") {
  const res = await d.fire(ws, "/__admin/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await d.cookieFor(ws, ADMIN)) },
    body: JSON.stringify({ op: "mint", space, label: `probe-${++seq}` }),
  });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  const body = JSON.parse(text);
  const token = body.token || body.value || (body.entry && body.entry.token);
  assert.ok(token, `no token in ${text}`);
  return token;
}

const authed = (token) => ({ Authorization: `Bearer ${token}` });

// ═══ THE LIST ITSELF ═════════════════════════════════════════════════════════════════
//
// The families are enumerated in `IDENTITY_KV_FAMILIES` rather than derived, so the risk
// is a family that exists and is not listed. These two cases close that from both ends
// against `src/state-inventory.mjs`, which is the engine's own account of what belongs to
// one workspace.

test("EVERY inventory family that belongs to a workspace has a home — the overlay or the segment", () => {
  // The content families answer from the workspace's own Durable Object on any deployment
  // that binds `TENANTS`, so their KV keys are never written there at all. Everything else
  // in `to: "workspace"` reaches KV through a raw handle and must be segmented.
  // The same match `readStateFamily` makes: a family id is the document name, that name
  // with a colon, or anything under it (`pt:view` under `pt`).
  const inOverlay = (id) => Object.values(W.OVERLAY_KV_KEYS).some((spec) =>
    spec.doc === id || spec.doc + ":" === id || id.startsWith(spec.doc + ":"));
  const segmented = new Set(Object.values(W.IDENTITY_KV_FAMILIES).flat());
  const homeless = [];
  for (const e of STATE_INVENTORY) {
    if (e.store !== "kv" || e.to !== "workspace") continue;
    if (inOverlay(e.id) || segmented.has(e.id)) continue;
    homeless.push(e.id);
  }
  assert.deepEqual(homeless, [],
    "an inventory family belongs to one workspace and is neither in the overlay nor segmented");
});

test("NOTHING is segmented that the inventory does not send to a workspace", () => {
  const wrong = [];
  for (const doc of Object.values(W.IDENTITY_KV_FAMILIES).flat()) {
    const e = STATE_INVENTORY.find((x) => x.id === doc);
    if (!e) { wrong.push(`${doc}: not in the inventory at all`); continue; }
    // `users:spaces` is `to: "drop"` and segmented anyway: it is still WRITTEN by the
    // membership route, and until it is deleted a shared copy hands one workspace's
    // membership decisions to another. Named rather than excused.
    if (e.to !== "workspace" && doc !== "users:spaces") wrong.push(`${doc}: to=${e.to}`);
  }
  assert.deepEqual(wrong, []);
});

test("⛔ `users:secrets` is NOT segmented, and that is the account-level boundary", () => {
  assert.equal(W.identityFamily("users:secrets"), "",
    "a credential is account-level — segmenting it belongs to B-cross-workspace-signin, not here");
  assert.equal(W.identityKey("users:secrets", "anyone"), "users:secrets");
});

// ═══ ADDITIVE FOR A DEPLOYMENT THAT BINDS NO WORKSPACE ═══════════════════════════════

test("with no workspace segment the key-former is the IDENTITY FUNCTION", () => {
  for (const doc of [...Object.values(W.IDENTITY_KV_FAMILIES).flat(), "statuses", "freeze", "rl:login:ip:1"]) {
    assert.equal(W.identityKey(doc, ""), doc);
  }
});

test("with no workspace segment the view IS THE BINDING — not a wrapper around it", () => {
  const kv = memKV();
  // Every self-hosted instance: `TENANT_HOST_SUFFIX` unset. There is then no new code at
  // all between the worker and KV, which is the claim, proved by identity rather than by
  // reading the source.
  assert.equal(W.identityKvView({}, kv, { tenantId: "anything" }), kv);
  assert.equal(W.identityKvView({ TENANT_HOST_SUFFIX: "  " }, kv, { tenantId: "x" }), kv);
  assert.equal(W.kvFor({ COMMENTS: kv }, { tenantId: "x" }), kv);
  assert.equal(W.kvFor({ COMMENTS: kv }), kv);
});

test("a host-resolved deployment segments only the families the flags name", () => {
  assert.equal(W.identityKey("users:roster", "acme"), "t/acme/users:roster");
  assert.equal(W.identityKey("publish:tokens", "acme"), "t/acme/publish:tokens");
  assert.equal(W.identityKey("users:lastseen:a@x.test", "acme"), "t/acme/users:lastseen:a@x.test");
  assert.equal(W.identityKey("avatar:abc", "acme"), "t/acme/avatar:abc");
  assert.equal(W.identityKey("spaceicon:abc", "acme"), "t/acme/spaceicon:abc");
  // Not ours: transient, instance-global, or account-level.
  for (const k of ["users:secrets", "freeze", "rl:login:ip:1", "statuses", "board:/x/", "c:/x/"]) {
    assert.equal(W.identityKey(k, "acme"), k, `${k} must not take a workspace segment`);
  }
});

// ═══ CLAUSE 1 — A FULL STATE RESTORE INTO B LEAVES A ALONE ═══════════════════════════

test("a full `restore --state` into workspace B leaves A's documents BYTE-IDENTICAL", async () => {
  const A = "alfa", B = "bravo";
  const d = await deployment({ workspaces: [A, B] });

  // Give A a real identity: a publish token minted through the admin route, a display name
  // and a role change. Per-workspace tokens, never one shared token — a star token is what
  // made the old sharing invisible.
  const tokenA = await mintToken(d, A);
  await d.fire(A, "/__me/name", {
    method: "POST", headers: { "Content-Type": "application/json", ...(await d.cookieFor(A, ADMIN)) },
    body: JSON.stringify({ name: "Ada of Alfa" }),
  });
  await d.fire(A, "/__admin/users", {
    method: "POST", headers: { "Content-Type": "application/json", ...(await d.cookieFor(A, ADMIN)) },
    body: JSON.stringify({ op: "role", email: GUEST, role: "viewer" }),
  });
  const before = d.docs(A);
  assert.ok(Object.keys(before).length >= 2, `A wrote nothing to segment: ${JSON.stringify(before)}`);

  // A's token works, at A.
  assert.equal((await d.fire(A, "/__publish/one/check", {
    method: "POST", headers: { "Content-Type": "application/json", ...authed(tokenA) },
    body: JSON.stringify({ files: {} }),
  })).status, 200);

  // Now the act that destroyed a live workspace: a full state restore INTO B, carrying a
  // whole different deployment's identity documents.
  const tokenB = await mintToken(d, B, "*");
  const imported = await d.fire(B, "/__publish/_state/import", {
    method: "POST", headers: { "Content-Type": "application/json", ...authed(tokenB) },
    body: JSON.stringify({
      format: 1,
      families: {
        "users:roster": { add: { "zoe@elsewhere.test": { email: "zoe@elsewhere.test", role: "admin" } }, remove: [] },
        "users:names": { "zoe@elsewhere.test": "Zoe of Bravo" },
        "users:roles": { "zoe@elsewhere.test": "admin" },
        "users:avatars": { "zoe@elsewhere.test": "u/deadbeef" },
        "spaces:icons": { one: "u/cafebabe" },
        "users:spaces": { "zoe@elsewhere.test": ["one"] },
      },
    }),
  });
  assert.equal(imported.status, 200, await imported.text());

  const after = d.docs(A);
  assert.deepEqual(after, before,
    "the restore into B rewrote A's identity documents — the bug this item exists to close");

  // And the property a person would notice: A's publish token still authenticates.
  const still = await d.fire(A, "/__publish/one/check", {
    method: "POST", headers: { "Content-Type": "application/json", ...authed(tokenA) },
    body: JSON.stringify({ files: {} }),
  });
  assert.equal(still.status, 200, "A's publish token went 403 after a restore into B");

  // B genuinely received it — a green result must not be vacuous.
  const bDocs = d.docs(B);
  assert.match(bDocs["users:names"] || "", /Zoe of Bravo/);
  assert.match(bDocs["spaces:icons"] || "", /cafebabe/);
});

// ═══ CLAUSE 2 — A RESET OF A CLEARS A AND NOTHING ELSE ═══════════════════════════════

test("a nightly RESET of workspace A leaves B's roster and display names untouched", async () => {
  const A = "alfa", B = "bravo";
  const d = await deployment({ workspaces: [A, B] });

  for (const ws of [A, B]) {
    await d.fire(ws, "/__me/name", {
      method: "POST", headers: { "Content-Type": "application/json", ...(await d.cookieFor(ws, ADMIN)) },
      body: JSON.stringify({ name: `Ada of ${ws}` }),
    });
    await d.fire(ws, "/__admin/users", {
      method: "POST", headers: { "Content-Type": "application/json", ...(await d.cookieFor(ws, ADMIN)) },
      body: JSON.stringify({ op: "role", email: GUEST, role: "viewer" }),
    });
  }
  const beforeB = d.docs(B);
  assert.match(beforeB["users:names"] || "", /Ada of bravo/, "the fixture never gave B a display name");

  // The demo's nightly job, as the engine sees it: `clear` on the families that shadow a
  // durable record. This is the exact list `seed/policy.mjs` names.
  const tokenA = await mintToken(d, A, "*");
  const reset = await d.fire(A, "/__publish/_state/import", {
    method: "POST", headers: { "Content-Type": "application/json", ...authed(tokenA) },
    body: JSON.stringify({
      format: 1, families: {},
      clear: ["users:names", "users:avatars", "users:roles", "users:roster", "users:spaces", "spaces:icons", "avatar:", "spaceicon:"],
    }),
  });
  const resetBody = JSON.parse(await reset.text());
  assert.equal(reset.status, 200, JSON.stringify(resetBody));
  assert.ok((resetBody.cleared || []).includes("users:names"),
    `the reset did not actually clear anything: ${JSON.stringify(resetBody)}`);

  const afterA = d.docs(A);
  assert.equal(afterA["users:names"], undefined, "A's own reset did not clear A");
  assert.deepEqual(d.docs(B), beforeB,
    "A's nightly reset reached into B — the clause that proves this is not only a migration fix");
});

// ═══ CLAUSE 3 — AN ORDINARY RENAME AND ROLE CHANGE IN A ══════════════════════════════

test("a rename and a role change in A change NOTHING in B", async () => {
  const A = "alfa", B = "bravo";
  const d = await deployment({ workspaces: [A, B] });
  // B is given a distinguishable value first, so "unchanged" cannot be produced by B
  // simply never having had one.
  await d.fire(B, "/__me/name", {
    method: "POST", headers: { "Content-Type": "application/json", ...(await d.cookieFor(B, ADMIN)) },
    body: JSON.stringify({ name: "Bravo's Own Ada" }),
  });
  await d.fire(B, "/__admin/users", {
    method: "POST", headers: { "Content-Type": "application/json", ...(await d.cookieFor(B, ADMIN)) },
    body: JSON.stringify({ op: "role", email: GUEST, role: "admin" }),
  });
  const beforeB = d.docs(B);

  await d.fire(A, "/__me/name", {
    method: "POST", headers: { "Content-Type": "application/json", ...(await d.cookieFor(A, ADMIN)) },
    body: JSON.stringify({ name: "Alfa's Own Ada" }),
  });
  await d.fire(A, "/__admin/users", {
    method: "POST", headers: { "Content-Type": "application/json", ...(await d.cookieFor(A, ADMIN)) },
    body: JSON.stringify({ op: "role", email: GUEST, role: "viewer" }),
  });

  assert.deepEqual(d.docs(B), beforeB, "A's rename or role change reached B's documents");

  // Asserted over HTTP as well, because a document is not an answer: what B SERVES must
  // still be B's.
  const me = await d.fire(B, "/__admin/users", { headers: await d.cookieFor(B, ADMIN) });
  const list = JSON.parse(await me.text());
  const g = (list.users || []).find((u) => u.email === GUEST);
  assert.equal(g && g.role, "admin", "B's roster answered with A's role change");
});

// ═══ CLAUSE 4 — THE PER-FAMILY REVERT, RUN ═══════════════════════════════════════════

/**
 * A COPY of the worker with ONE family's flag flipped back in ONE table, loaded as its own
 * module. RUN, NOT READ — a test that asserted about the diff would pass against a flag
 * nothing consults.
 */
async function revertedWorker(family, table = "IDENTITY_TENANCY") {
  const src = fileURLToPath(new URL("../src/_worker.js", import.meta.url));
  const text = fs.readFileSync(src, "utf8");
  const start = text.indexOf(`const ${table} = Object.freeze({`);
  assert.ok(start >= 0, `no such flag table: ${table}`);
  const end = text.indexOf("\n});", start);
  const block = text.slice(start, end);
  const needle = `\n  ${family}: true,`;
  assert.equal(block.split(needle).length, 2, `the flag this revert edits has moved: ${table}.${family}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `augur-idkv-revert-${family}-`));
  for (const entry of fs.readdirSync(path.dirname(src))) {
    if (entry === "_worker.js") continue;
    fs.symlinkSync(path.join(path.dirname(src), entry), path.join(dir, entry));
  }
  fs.writeFileSync(path.join(dir, "_worker.js"),
    text.slice(0, start) + block.replace(needle, `\n  ${family}: false,`) + text.slice(start + block.length));
  const mod = await import(pathToFileURL(path.join(dir, "_worker.js")).href);
  const flags = mod.__testables[table];
  assert.equal(flags[family], false, "the edit did not take");
  for (const other of Object.keys(flags)) {
    if (other !== family) assert.equal(flags[other], true, `the revert reached ${other}, which it was not for`);
  }
  setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} }, 0).unref?.();
  return mod;
}

for (const family of ["roster", "publishTokens", "icons", "invites", "lastseen", "spaces", "avatars", "sessionkeys", "mail"]) {
  test(`REVERTING \`${family}\` sends that family's keys back, and touches nothing else`, async () => {
    const mod = await revertedWorker(family);
    const T = mod.__testables;
    for (const doc of T.IDENTITY_KV_FAMILIES[family]) {
      const probe = doc.endsWith(":") ? doc + "x" : doc;
      assert.equal(T.identityKey(probe, "acme"), probe, `${probe} still took a segment after the revert`);
    }
    for (const [other, docs] of Object.entries(T.IDENTITY_KV_FAMILIES)) {
      if (other === family) continue;
      for (const doc of docs) {
        const probe = doc.endsWith(":") ? doc + "x" : doc;
        assert.equal(T.identityKey(probe, "acme"), `t/acme/${probe}`,
          `the revert of ${family} also reverted ${other}`);
      }
    }
  });
}

test("the DUAL WRITE is what makes the revert a revert: the unsegmented key keeps its copy", async () => {
  const A = "alfa";
  const d = await deployment({ workspaces: [A, "bravo"] });
  await d.fire(A, "/__me/name", {
    method: "POST", headers: { "Content-Type": "application/json", ...(await d.cookieFor(A, ADMIN)) },
    body: JSON.stringify({ name: "Ada of Alfa" }),
  });
  assert.match(d.kv.store.get(`t/${A}/users:names`) || "", /Ada of Alfa/);
  assert.match(d.kv.store.get("users:names") || "", /Ada of Alfa/,
    "nothing was written to the unsegmented key, so flipping the flag back would be a rollback");
});

test("a DELETE does NOT reach the unsegmented key — which is why one reset is not deployment-wide", async () => {
  const A = "alfa";
  const d = await deployment({ workspaces: [A, "bravo"] });
  await d.fire(A, "/__me/name", {
    method: "POST", headers: { "Content-Type": "application/json", ...(await d.cookieFor(A, ADMIN)) },
    body: JSON.stringify({ name: "Ada of Alfa" }),
  });
  const shared = d.kv.store.get("users:names");
  const view = W.identityKvView(d.env, d.kv, { tenantId: A });
  await view.delete("users:names");
  assert.equal(d.kv.store.has(`t/${A}/users:names`), false, "the segmented key survived its own delete");
  assert.equal(d.kv.store.get("users:names"), shared,
    "the delete reached the unsegmented key, which may be a neighbour's");
});

// ═══ CLAUSE 4b — THE LOGIN GATE REFUSES RATHER THAN ADMITS ═══════════════════════════

test("GATE — with the workspace object's identity store broken the answer is REFUSAL, not admission", async () => {
  const A = "alfa";
  let down = false;
  const d = await deployment({ workspaces: [A, "bravo"], broken: () => down });
  const token = await mintToken(d, A);
  const check = () => d.fire(A, "/__publish/one/check", {
    method: "POST", headers: { "Content-Type": "application/json", ...authed(token) },
    body: JSON.stringify({ files: {} }),
  });
  assert.equal((await check()).status, 200, "the fixture could not publish at all");
  down = true;
  assert.equal((await check()).status, 403,
    "a broken workspace store fell OPEN onto the shared KV document");
  down = false;
  assert.equal((await check()).status, 200, "the refusal did not lift when the store came back");
});

// ═══ THE MOVE, FOR A WORKSPACE THAT IS ALREADY LIVE ══════════════════════════════════

test("`identity-rekey` moves a live workspace's documents onto the segment, idempotently", async () => {
  const A = "alfa";
  const d = await deployment({ workspaces: [A] });
  // The state a live workspace is in the moment before this ships: its documents at the
  // keys it has always written, with nothing under a segment.
  await d.kv.put("users:roster", JSON.stringify({ add: { "old@x.test": { email: "old@x.test", role: "editor" } }, remove: [] }));
  await d.kv.put("users:names", JSON.stringify({ "old@x.test": "Older" }));
  await d.kv.put("publish:tokens", JSON.stringify({ deadbeef: { space: "one", label: "legacy" } }));
  await d.kv.put("avatar:abc123", "data:image/png;base64,AAAA");
  await d.kv.put("users:secrets", JSON.stringify({ "old@x.test": "pbkdf2$x" }));

  const token = await mintToken(d, A, "*");
  const dry = JSON.parse(await (await d.fire(A, "/__publish/_state/identity-rekey", {
    method: "POST", headers: { "Content-Type": "application/json", ...authed(token) }, body: "{}",
  })).text());
  assert.equal(dry.dryRun, true);
  assert.ok(dry.copied >= 4, `a dry run found nothing to move: ${JSON.stringify(dry)}`);

  const run = JSON.parse(await (await d.fire(A, "/__publish/_state/identity-rekey", {
    method: "POST", headers: { "Content-Type": "application/json", ...authed(token) },
    body: JSON.stringify({ confirm: A }),
  })).text());
  assert.equal(run.ok, true);
  assert.equal(run.done, true);
  assert.match(d.kv.store.get(`t/${A}/users:names`) || "", /Older/);
  assert.match(d.kv.store.get(`t/${A}/avatar:abc123`) || "", /base64/);
  // ⛔ The credential did not move: it is account-level.
  assert.equal(d.kv.store.has(`t/${A}/users:secrets`), false);
  // A COPY, never a cut — the revert reads the source.
  assert.match(d.kv.store.get("users:names") || "", /Older/);

  const again = JSON.parse(await (await d.fire(A, "/__publish/_state/identity-rekey", {
    method: "POST", headers: { "Content-Type": "application/json", ...authed(token) },
    body: JSON.stringify({ confirm: A }),
  })).text());
  assert.equal(again.copied, 0, "a second run copied something — the move is not idempotent");
});

test("`identity-rekey` REFUSES once a second workspace holds a prefix", async () => {
  const A = "alfa", B = "bravo";
  const d = await deployment({ workspaces: [A, B] });
  const token = await mintToken(d, A, "*");
  const out = JSON.parse(await (await d.fire(A, "/__publish/_state/identity-rekey", {
    method: "POST", headers: { "Content-Type": "application/json", ...authed(token) },
    body: JSON.stringify({ confirm: A }),
  })).text());
  assert.equal(out.ok, false);
  assert.equal(out.reason, "not-the-only-workspace",
    "an unsegmented key on a shared namespace is unattributable — moving it as the second workspace hands A B's roster");
});

test("`identity-rekey` is a NO-OP on a deployment that resolves no workspace from the Host", async () => {
  const kv = memKV({ "users:roster": "{}" });
  const out = await W.rekeyIdentityToSegment({ tenantId: "solo" }, { COMMENTS: kv }, { dryRun: true });
  assert.deepEqual(out, { ok: true, done: true, reason: "no-segment", workspace: "solo" });
  assert.deepEqual([...kv.store.keys()], ["users:roster"]);
});
