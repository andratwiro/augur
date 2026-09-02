// The seed pack lands in a fresh workspace — publish seed/ first, then provision with its threads.
//
// `F-seed-pack-at-provision`. Four things are pinned here, in the order a provisioning meets
// them:
//
//   1. THE PACK the engine ships: built from seed/ by the real build, every prototype the
//      tree declares present at its site path, the connect slot carried exactly once, no
//      author stamp on any file (the engine author's id must not become the author of every
//      customer's welcome content), the threads beside it.
//   2. THE WRITE into one workspace's segment of the bundle store: every blob under its own
//      digest, `versions/1.json` then `manifest.json`, every version stamped as the seed and
//      nothing else — and the one substitution, the workspace's real connect command.
//   3. THE PROVISIONING that asks for it: content first, then ONE transaction holding the
//      admin, the threads (restamped to the provisioning instant) and the version row that
//      makes the space this workspace's. A crash between the two leaves no workspace; the
//      next provisioning of the same object writes its own content over the orphan's.
//   4. THE FRONT DOOR, which is what makes that order safe: an object that is not provisioned
//      resolves to nobody — the same bare answer a hostname naming nobody gets — however much
//      content sits at its keys.
//
// The store stub keeps real bytes and real keys, so "landed under t/<workspace>/" is read
// back off the key the front door would use, never inferred from a call count.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import {
  SEED_PACK_PATH, SEED_CONNECT_SLOT, connectCommandFor, workspaceOrigin, fillConnectCommand,
  validateSeedPack, seedOverlayFrom, publishSeedPack, loadSeedPack,
} from "../src/seed-pack.mjs";
import { buildSeedPack, seedPrototypes, SEED_CONNECT_FILE } from "../scripts/lib/seed-pack-build.mjs";
import { bundleStore } from "../src/bundle-keys.mjs";
import { SEED_ACTOR, isSeedSource, isSeedActor, SEED_DISPLAY_NAME } from "../src/provenance.mjs";
import { TenantStore } from "../src/tenant-do.js";

const ENGINE = fileURLToPath(new URL("..", import.meta.url));
const SEED = path.join(ENGINE, "seed");
const SUFFIX = ".example.com";
const WS = "amber-heron-204";
const ADMIN = "first@example.test";
const AT = "2026-09-02T10:00:00.000Z";
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

// ── stubs ───────────────────────────────────────────────────────────────────────────

/** An R2-shaped store holding real bytes under real keys. */
function r2Stub() {
  const map = new Map();
  const obj = (k) => {
    const v = map.get(k);
    return {
      key: k, size: v.byteLength,
      async text() { return new TextDecoder().decode(v); },
      async arrayBuffer() { return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength); },
    };
  };
  const stub = {
    map, puts: 0,
    async get(k) { return map.has(k) ? obj(k) : null; },
    async head(k) { return map.has(k) ? { key: k, size: map.get(k).byteLength } : null; },
    async put(k, v) {
      stub.puts++;
      map.set(k, typeof v === "string" ? new TextEncoder().encode(v) : new Uint8Array(v));
    },
    async delete(k) { map.delete(k); },
    async list({ prefix = "" } = {}) {
      return { objects: [...map.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ key: k })), truncated: false };
    },
  };
  return stub;
}

/** The ASSETS binding, serving one pack (or nothing). */
const assetsStub = (pack) => ({
  async fetch(url) {
    if (pack && new URL(url).pathname === "/" + SEED_PACK_PATH) {
      return new Response(JSON.stringify(pack), { headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  },
});

/** The DO storage stub test/tenant-provisioning.test.mjs uses — real transaction semantics. */
function storage(db, { failCommit = null } = {}) {
  const sql = {
    exec(stmt, ...params) {
      if (params.length) {
        const s = db.prepare(stmt);
        return /^\s*SELECT/i.test(stmt) ? s.all(...params) : (s.run(...params), []);
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
      try {
        const out = cb();
        if (failCommit && failCommit()) throw new Error("injected: the process died before the commit");
        db.exec("COMMIT");
        return out;
      } catch (e) { db.exec("ROLLBACK"); throw e; }
    },
  };
}

function workspace(env = {}, opts = {}) {
  const db = new DatabaseSync(":memory:");
  const ctx = { storage: storage(db, opts), blockConcurrencyWhile: async (f) => f() };
  return { db, store: new TenantStore(ctx, env) };
}

// The pack is built ONCE for the whole file: a child build of seed/ (~1s).
const PACK = buildSeedPack({ engineRoot: ENGINE });
const hostedEnv = (extra = {}) => ({
  TENANT_HOST_SUFFIX: SUFFIX, BUNDLES: r2Stub(), ASSETS: assetsStub(PACK), ...extra,
});
const spaceId = PACK.space.id;
const manifestOf = async (r2, ws = WS) => JSON.parse(await (await r2.get(`t/${ws}/spaces/${spaceId}/manifest.json`)).text());

// ── 1. the pack the engine ships ───────────────────────────────────────────────────

test("THE PACK HOLDS EVERY PROTOTYPE seed/ DECLARES, at the path the site serves it", () => {
  assert.equal(validateSeedPack(PACK), null);
  const declared = seedPrototypes(SEED);
  assert.equal(declared.length, 6, `seed/ declares ${declared.length} prototypes`);
  for (const p of declared) assert.ok(p in PACK.files, `${p} missing from the pack`);
  for (const p of ["/start-here/connect-your-terminal/", "/start-here/set-up-your-design-system/",
    "/start-here/sample-with-comments/", "/worked-examples/specimen-viewer/"]) {
    assert.ok(PACK.routing.publicPrefixes.includes(p), `${p} is not a public prefix`);
  }
  // The design system rides with it — a prototype with no stylesheet renders unstyled.
  assert.ok(Object.keys(PACK.files).some((p) => p.startsWith("/skills/") && p.endsWith(".css")));
});

test("⚠️ NO FILE IN THE PACK CARRIES AN AUTHOR — the engine author is not the author of every workspace", () => {
  for (const [p, f] of Object.entries(PACK.files)) {
    assert.equal(f.by, undefined, `${p} carries by`);
    assert.equal(f.editedAt, undefined, `${p} carries editedAt`);
    assert.equal(f.h, sha256(Buffer.from(f.b64, "base64")), `${p}: the bytes do not hash to h`);
  }
  assert.equal(validateSeedPack({ ...PACK, files: { ...PACK.files, "/x.html": { ...PACK.files[SEED_CONNECT_FILE], by: "abc" } } }), "stamped:/x.html");
});

test("the connect page carries the slot exactly once, and the threads name a page the pack has", () => {
  const html = Buffer.from(PACK.files[PACK.connectCommandFile].b64, "base64").toString("utf8");
  assert.equal(html.split(SEED_CONNECT_SLOT).length - 1, 1);
  assert.equal(PACK.connectCommandFile, SEED_CONNECT_FILE);
  const pages = Object.keys(PACK.threads);
  assert.deepEqual(pages, ["/start-here/sample-with-comments/"]);
  assert.equal(PACK.threads[pages[0]].length, 2, "two seeded threads on the sample page");
  assert.ok(!("_comment" in PACK.threads));
});

test("the pack is what the deployed bundle serves, read the way /__config/ is read", async () => {
  assert.deepEqual((await loadSeedPack({ ASSETS: assetsStub(PACK) })).space, PACK.space);
  assert.equal(await loadSeedPack({ ASSETS: assetsStub(null) }), null, "no pack in the bundle");
  assert.equal(await loadSeedPack({}), null, "no ASSETS binding");
  assert.equal(await loadSeedPack({ ASSETS: { fetch: async () => new Response("{}") } }), null, "not a pack");
});

// ── the small pieces ────────────────────────────────────────────────────────────────

test("the connect command is the CLI's real form, from the workspace's real origin", () => {
  assert.equal(workspaceOrigin({ TENANT_HOST_SUFFIX: SUFFIX }, WS), `https://${WS}${SUFFIX}`);
  assert.equal(workspaceOrigin({}, WS), null, "no suffix: not a hosted address");
  assert.equal(workspaceOrigin({ TENANT_HOST_SUFFIX: SUFFIX }, ""), null);
  assert.equal(connectCommandFor(`https://${WS}${SUFFIX}/`), `npx augur connect --origin https://${WS}${SUFFIX}`);
  assert.equal(connectCommandFor(""), "");
});

test("the slot is filled once, and a page with no slot or two is left alone", () => {
  const cmd = "npx augur connect --origin https://a.b";
  const one = fillConnectCommand(`<script>${SEED_CONNECT_SLOT}</script>`, cmd);
  assert.equal(one.filled, true);
  assert.equal(one.html, `<script>var CONNECT_COMMAND = "npx augur connect --origin https://a.b";</script>`);
  assert.equal(fillConnectCommand("<script>var x = 1;</script>", cmd).filled, false);
  assert.equal(fillConnectCommand(`${SEED_CONNECT_SLOT} ${SEED_CONNECT_SLOT}`, cmd).filled, false);
  assert.equal(fillConnectCommand(SEED_CONNECT_SLOT, "").filled, false);
  // Quoting is JSON's, so a command can never break out of the string it is written into.
  assert.match(fillConnectCommand(SEED_CONNECT_SLOT, 'a"b</script>').html, /"a\\"b<\/script>"/);
});

test("the threads become the comments family, restamped to the provisioning instant, in order", () => {
  const seed = seedOverlayFrom(PACK, AT);
  const list = seed.comments[""]["/start-here/sample-with-comments/"];
  assert.equal(list.length, 2);
  assert.equal(list[0].messages[0].at, AT);
  assert.equal(list[1].messages[0].at, "2026-09-02T10:00:01.000Z", "the second message follows the first");
  assert.equal(list[0].sel, "#fee-note", "the record is carried verbatim apart from its stamps");
  assert.deepEqual(seedOverlayFrom({ ...PACK, threads: {} }, AT), {});
});

// ── 2. the write ────────────────────────────────────────────────────────────────────

test("THE PACK LANDS UNDER THE WORKSPACE'S SEGMENT, as version 1 of its space, every byte where the front door reads it", async () => {
  const r2 = r2Stub();
  const out = await publishSeedPack({ store: bundleStore({ BUNDLES: r2 }, WS), pack: PACK, workspaceId: WS, at: AT });
  assert.deepEqual({ space: out.space, version: out.version, files: out.files, units: out.units },
    { space: spaceId, version: 1, files: Object.keys(PACK.files).length, units: 6 });
  const m = await manifestOf(r2);
  const v1 = JSON.parse(await (await r2.get(`t/${WS}/spaces/${spaceId}/versions/1.json`)).text());
  assert.deepEqual(m, v1, "versions/1.json and manifest.json are the same document");
  assert.equal(m.version, 1);
  assert.equal(m.publishedAt, AT);
  for (const [p, f] of Object.entries(m.files)) {
    const blob = await r2.get(`blobs/${f.h}`);
    assert.ok(blob, `${p}: blob ${f.h} not in the store`);
    assert.equal(sha256(new Uint8Array(await blob.arrayBuffer())), f.h, `${p}: blob bytes do not hash to their key`);
    assert.equal(f.s, blob.size);
  }
  // Nothing at the unsegmented key — that is where every workspace would collide.
  assert.equal(await r2.get(`spaces/${spaceId}/manifest.json`), null);
});

test("⚠️ EVERY SEED VERSION READS AS SEED, and no file is credited to a person", async () => {
  const r2 = r2Stub();
  await publishSeedPack({ store: bundleStore({ BUNDLES: r2 }, WS), pack: PACK, workspaceId: WS, at: AT });
  const m = await manifestOf(r2);
  assert.ok(isSeedSource(m.source), JSON.stringify(m.source));
  assert.equal(m.source.actor, SEED_ACTOR);
  assert.equal(m.source.sha, PACK.engine);
  assert.equal(m.publishedBy, SEED_ACTOR);
  assert.ok(isSeedActor(m.publishedBy));
  for (const u of m.routing.publicPrefixes) assert.ok(isSeedSource(m.routing.unitSources[u]), `${u} is not a seed unit`);
  for (const [p, f] of Object.entries(m.files)) {
    assert.equal(f.by, undefined, `${p} names a person`);
    assert.equal(f.editedAt, AT, `${p} is not stamped with the provisioning instant`);
  }
  assert.equal(SEED_DISPLAY_NAME, "Augur");
});

test("THE CONNECT COMMAND IS THIS WORKSPACE'S, filled at the moment it is published", async () => {
  const r2 = r2Stub();
  const out = await publishSeedPack({
    store: bundleStore({ BUNDLES: r2 }, WS), pack: PACK, workspaceId: WS, at: AT, origin: `https://${WS}${SUFFIX}`,
  });
  assert.equal(out.connectCommand, `npx augur connect --origin https://${WS}${SUFFIX}`);
  const m = await manifestOf(r2);
  const entry = m.files[SEED_CONNECT_FILE];
  assert.notEqual(entry.h, PACK.files[SEED_CONNECT_FILE].h, "the filled page is a new blob");
  const html = await (await r2.get(`blobs/${entry.h}`)).text();
  assert.ok(html.includes(`var CONNECT_COMMAND = "npx augur connect --origin https://${WS}${SUFFIX}";`));
  assert.ok(!html.includes(SEED_CONNECT_SLOT));
  // Every other file is the pack's own blob, shared across workspaces.
  for (const [p, f] of Object.entries(m.files)) if (p !== SEED_CONNECT_FILE) assert.equal(f.h, PACK.files[p].h, p);
  // With no origin (a deployment that does not address workspaces by label) the slot stays
  // and the page derives its command from the URL it is served on.
  const r2b = r2Stub();
  const plain = await publishSeedPack({ store: bundleStore({ BUNDLES: r2b }, WS), pack: PACK, workspaceId: WS, at: AT });
  assert.equal(plain.connectCommand, null);
  assert.equal((await manifestOf(r2b)).files[SEED_CONNECT_FILE].h, PACK.files[SEED_CONNECT_FILE].h);
});

test("⛔ IT REFUSES TO WRITE OVER A REAL PUBLISH, and a corrupt pack writes nothing", async () => {
  const r2 = r2Stub();
  const store = bundleStore({ BUNDLES: r2 }, WS);
  await r2.put(`t/${WS}/spaces/${spaceId}/manifest.json`, JSON.stringify({ version: 4, source: { sha: "abc", actor: "somebody" }, files: {} }));
  await assert.rejects(() => publishSeedPack({ store, pack: PACK, workspaceId: WS, at: AT }), /seed-over-real-content/);
  assert.equal(JSON.parse(await (await r2.get(`t/${WS}/spaces/${spaceId}/manifest.json`)).text()).version, 4, "the real publish stands");
  assert.equal(r2.puts, 1, "nothing else was written");

  const corrupt = { ...PACK, files: { ...PACK.files } };
  const [p0, f0] = Object.entries(PACK.files)[0];
  corrupt.files[p0] = { ...f0, b64: Buffer.from("not the bytes").toString("base64") };
  const r2c = r2Stub();
  await assert.rejects(() => publishSeedPack({ store: bundleStore({ BUNDLES: r2c }, WS), pack: corrupt, workspaceId: WS, at: AT }), /seed-pack-corrupt/);
  assert.equal(r2c.puts, 0, "a corrupt pack wrote a blob before it was caught");
});

test("a seed publish may be written again over a seed publish — the same keys, the new instant", async () => {
  const r2 = r2Stub();
  const store = bundleStore({ BUNDLES: r2 }, WS);
  await publishSeedPack({ store, pack: PACK, workspaceId: WS, at: AT });
  await publishSeedPack({ store, pack: PACK, workspaceId: WS, at: "2026-09-03T00:00:00.000Z" });
  assert.equal((await manifestOf(r2)).publishedAt, "2026-09-03T00:00:00.000Z");
  const versions = [...r2.map.keys()].filter((k) => k.startsWith(`t/${WS}/spaces/${spaceId}/versions/`));
  assert.deepEqual(versions, [`t/${WS}/spaces/${spaceId}/versions/1.json`], "still exactly one version");
});

// ── 3. the provisioning ─────────────────────────────────────────────────────────────

test("A PROVISIONING THAT ASKS FOR THE PACK OPENS WITH THE CONTENT LIVE, THE THREADS PINNED, AND THE SPACE ITS OWN", async () => {
  const env = hostedEnv();
  const { db, store } = workspace(env);
  const out = await store.provision({ workspaceId: WS, adminEmail: ADMIN, seedPack: true, now: AT });
  assert.equal(out.created, true);
  assert.deepEqual({ space: out.seedPack.space, version: out.seedPack.version, files: out.seedPack.files, connectCommand: out.seedPack.connectCommand },
    { space: spaceId, version: 1, files: Object.keys(PACK.files).length, connectCommand: `npx augur connect --origin https://${WS}${SUFFIX}` });
  assert.ok(!("overlay" in out.seedPack), "the overlay is not echoed back over the wire");
  assert.ok(store.isProvisioned());
  // The content, under this workspace's segment.
  const m = await manifestOf(env.BUNDLES);
  assert.equal(m.version, 1);
  assert.equal(m.publishedAt, AT, "content and workspace share one instant");
  assert.ok(isSeedSource(m.source));
  // The threads, on the sample page, in the same transaction as the admin.
  const threads = store.overlayRead("comments", "")["/start-here/sample-with-comments/"];
  assert.equal(threads.length, 2);
  assert.equal(threads[0].messages[0].at, AT, "restamped to the provisioning instant");
  assert.equal(threads[0].sel, "#fee-note");
  assert.equal(store.status().threads, 1, "one page carries threads");
  assert.equal(out.seeded, 1);
  // The version row that makes the space THIS workspace's — what a delete walks and the
  // next real publish counts up from.
  assert.deepEqual(store.publishedSpaces(), { provisioned: true, spaces: [spaceId] });
  // (The counter's RETURNING clause is not visible through this harness's exec stub; the
  // row is read directly. Version 1 is what the store holds, so the next issue is 2.)
  assert.deepEqual(db.prepare("SELECT space, version FROM publish_versions").all().map((r) => ({ ...r })), [{ space: spaceId, version: 1 }]);
});

test("⚠️ A PROVISIONING THAT DIES AFTER THE CONTENT PUBLISH LEAVES NO WORKSPACE — and the next one writes its own content over it", async () => {
  const env = hostedEnv();
  let die = true;
  const { db, store } = workspace(env, { failCommit: () => die });
  await assert.rejects(() => store.provision({ workspaceId: WS, adminEmail: ADMIN, seedPack: true, now: AT }), /injected/);
  // The content is in the store...
  assert.equal((await manifestOf(env.BUNDLES)).publishedAt, AT);
  // ...and the workspace does not exist: no admin, no version row, no threads, and the
  // front door's read says so.
  assert.equal(store.isProvisioned(), false);
  assert.equal(store.status().provisioned, false);
  assert.equal(store.suspension().provisioned, false);
  assert.deepEqual(db.prepare("SELECT email FROM members").all(), []);
  assert.deepEqual(db.prepare("SELECT space FROM publish_versions").all(), []);
  assert.deepEqual(store.overlayRead("comments", ""), {});

  // The same label, provisioned again (a reconciliation, or the operator re-running the
  // create): its content is the content it published — the orphan's stamp is gone.
  die = false;
  const again = await store.provision({ workspaceId: WS, adminEmail: ADMIN, seedPack: true, now: "2026-09-03T00:00:00.000Z" });
  assert.equal(again.created, true);
  assert.equal((await manifestOf(env.BUNDLES)).publishedAt, "2026-09-03T00:00:00.000Z");
  assert.equal(store.suspension().provisioned, true);
  assert.deepEqual(store.publishedSpaces().spaces, [spaceId]);
  assert.equal(store.overlayRead("comments", "")["/start-here/sample-with-comments/"][0].messages[0].at, "2026-09-03T00:00:00.000Z");
});

test("⛔ NO PACK, NO WORKSPACE: a deployment that cannot furnish one refuses rather than opening an empty room", async () => {
  const env = hostedEnv({ ASSETS: assetsStub(null) });
  const { db, store } = workspace(env);
  await assert.rejects(() => store.provision({ workspaceId: WS, adminEmail: ADMIN, seedPack: true, now: AT }),
    (e) => e.code === "seed-pack-unavailable");
  assert.equal(store.isProvisioned(), false);
  assert.deepEqual(db.prepare("SELECT email FROM members").all(), []);
  assert.equal(env.BUNDLES.puts, 0, "nothing reached the store");
  // No store binding at all: the same refusal, before any read of the pack matters.
  const { store: s2 } = workspace({ TENANT_HOST_SUFFIX: SUFFIX, ASSETS: assetsStub(PACK) });
  await assert.rejects(() => s2.provision({ workspaceId: WS, adminEmail: ADMIN, seedPack: true }), (e) => e.code === "seed-pack-unavailable");
  assert.equal(s2.isProvisioned(), false);
});

test("re-provisioning a workspace that exists neither re-seeds nor touches the store", async () => {
  const env = hostedEnv();
  const { store } = workspace(env);
  await store.provision({ workspaceId: WS, adminEmail: ADMIN, seedPack: true, now: AT });
  const puts = env.BUNDLES.puts;
  store.overlaySet("comments", "", "/start-here/sample-with-comments/", [{ id: "t1", messages: [{ body: "a real conversation" }] }], "2026-09-05T00:00:00Z");
  const again = await store.provision({ workspaceId: WS, adminEmail: "second@example.test", seedPack: true, now: "2026-09-06T00:00:00.000Z" });
  assert.equal(again.created, false);
  assert.equal(again.seedPack, undefined);
  assert.equal(env.BUNDLES.puts, puts, "the store was written again");
  assert.equal((await manifestOf(env.BUNDLES)).publishedAt, AT);
  assert.equal(store.overlayRead("comments", "")["/start-here/sample-with-comments/"][0].messages[0].body, "a real conversation");
  assert.equal(store.members()[0].email, ADMIN);
});

test("a provisioning that does not ask for the pack is exactly what it was — nothing in the store, nothing seeded", async () => {
  const env = hostedEnv();
  const { store } = workspace(env);
  const out = await store.provision({ workspaceId: WS, adminEmail: ADMIN, now: AT });
  assert.equal(out.created, true);
  assert.equal(out.seedPack, undefined);
  assert.equal(env.BUNDLES.puts, 0);
  assert.deepEqual(store.publishedSpaces(), { provisioned: true, spaces: [] });
  assert.equal(store.suspension().provisioned, true);
  // A caller's own overlay seed still rides, and merges beside the pack's when both come.
  const env2 = hostedEnv();
  const { store: s2 } = workspace(env2);
  await s2.provision({
    workspaceId: WS, adminEmail: ADMIN, seedPack: true, now: AT,
    seed: { comments: { "": { "/mine/": [{ id: "m", messages: [] }] } }, statuses: { "": { "/mine/": "dev-ready" } } },
  });
  const comments = s2.overlayRead("comments", "");
  assert.equal(comments["/mine/"].length, 1);
  assert.equal(comments["/start-here/sample-with-comments/"].length, 2);
  assert.equal(s2.overlayRead("statuses", "")["/mine/"], "dev-ready");
});

// ── the control verb, over the wire ─────────────────────────────────────────────────

const control = (store, body) => store.fetch(new Request("https://workspace/__control/provision", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}));

test("`provision {seedPack: true}` over /__control answers with what it furnished", async () => {
  const env = hostedEnv();
  const { store } = workspace(env);
  const res = await control(store, { workspaceId: WS, adminEmail: ADMIN, seedPack: true, at: AT });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.created, true);
  assert.equal(body.seedPack.space, spaceId);
  assert.equal(body.seedPack.version, 1);
  assert.equal(body.seedPack.connectCommand, `npx augur connect --origin https://${WS}${SUFFIX}`);
});

test("⚠️ A REFUSAL IS A 4xx/5xx, NEVER ok:false IN A 200 — and it creates nothing", async () => {
  const noPack = workspace(hostedEnv({ ASSETS: assetsStub(null) }));
  const res = await control(noPack.store, { workspaceId: WS, adminEmail: ADMIN, seedPack: true });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { ok: false, error: "seed-pack-unavailable" });
  assert.equal(noPack.store.isProvisioned(), false);

  // Real content already under this label's keys: a 409, and the content stands.
  const env = hostedEnv();
  await env.BUNDLES.put(`t/${WS}/spaces/${spaceId}/manifest.json`, JSON.stringify({ version: 9, source: { sha: "x", actor: "someone" }, files: {} }));
  const real = workspace(env);
  const res2 = await control(real.store, { workspaceId: WS, adminEmail: ADMIN, seedPack: true });
  assert.equal(res2.status, 409);
  assert.deepEqual(await res2.json(), { ok: false, error: "seed-over-real-content" });
  assert.equal(real.store.isProvisioned(), false);
  assert.equal((await manifestOf(env.BUNDLES)).version, 9);
});

// ── 4. the front door ───────────────────────────────────────────────────────────────

const { default: worker, __testables: W } = await import("../src/_worker.js");

test("`readSuspension` KEEPS `provisioned: false`, and an older object that says nothing reads as before", async () => {
  const env = (answer) => ({
    TENANTS: { idFromName: (n) => n, get: () => ({ fetch: async () => new Response(JSON.stringify(answer)) }) },
  });
  assert.deepEqual(await W.readSuspension("unprovisioned-1", env({ provisioned: false, suspended: false })), { provisioned: false, suspended: false });
  assert.equal(await W.readSuspension("live-3", env({ provisioned: true, suspended: false })), null);
  assert.equal(await W.readSuspension("old-object-1", env({ suspended: false })), null, "no field: no change");
});

test("⚠️ AN UNPROVISIONED WORKSPACE RESOLVES TO NOBODY — byte-identical to a hostname naming nobody, on every path", async () => {
  const env = {
    TENANTS: { idFromName: (n) => n, get: () => ({ fetch: async () => new Response(JSON.stringify({ provisioned: false, suspended: false })) }) },
    // Deliberately nothing else: a request that reached the config load would fail here.
  };
  const nobody = await W.unknownHostResponse().text();
  for (const path of ["/", "/start-here/sample-with-comments/", "/_build.json", "/__auth", "/__publish/_state/export", "/__publish/workspace/manifest"]) {
    W.__setTenantTestState({ memo: { at: Date.now(), tenantId: `unprov-${path.length}` } });
    const res = await worker.fetch(new Request(`https://x.test${path}`, { headers: { Accept: "text/html" } }), env, { waitUntil() {} });
    assert.equal(res.status, W.unknownHostResponse().status, path);
    assert.equal(await res.text(), nobody, `${path} does not answer as a hostname naming nobody`);
  }
});

test("the pack is sealed from the outside, like /__config/", async () => {
  for (const path of ["/__seed/pack.json", "/__seed/", "/__seed"]) {
    const res = await worker.fetch(new Request(`https://x.test${path}`), {}, { waitUntil() {} });
    const cfg = await worker.fetch(new Request("https://x.test/__config/instance.json"), {}, { waitUntil() {} });
    assert.equal(res.status, cfg.status, path);
    assert.equal(await res.text(), await cfg.text(), path);
  }
});

test("a seeded version's publisher reads as the platform on a screen, never as a label with a colon in it", () => {
  assert.equal(isSeedActor(SEED_ACTOR), true);
  assert.equal(isSeedActor("augur:restore"), true, "the whole namespace, not one string");
  assert.equal(isSeedActor("ci"), false);
  assert.equal(isSeedActor("person@example.test"), false);
});

test("the seed source lands in the engine's dist as one sealed document, and nowhere in a manifest", () => {
  // The dist-emission baseline records `__seed/pack.json`; this pins the two facts that
  // baseline compares by shape only.
  const baseline = JSON.parse(fs.readFileSync(path.join(ENGINE, "test", "dist-emission.baseline.json"), "utf8"));
  assert.ok("__seed/pack.json" in baseline, "the engine-only build does not emit the pack");
  assert.ok(String(baseline["__seed/pack.json"]).startsWith("shape:"), "the pack carries a build stamp and must be compared by shape");
  assert.ok("bundle-keys.mjs" in baseline, "the key-shape module the worker imports is not emitted beside it");
});
