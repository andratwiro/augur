import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";
import { makeEnv, ctxFor, manifestOf, remember, sha, liveNow } from "./fixtures/unit-env.mjs";

let n = 0;
const tenant = () => `unit-api-${++n}`;
const U = "/checkout/flow/";
const INDEX = remember("<h1>flow</h1>");
const CSS = remember("h1{color:red}");

const call = (ctx, env, verb, body, { method = "POST", session = "pass one", token = "tok" } = {}) => {
  const url = method === "GET"
    ? `https://x.test/__unit/${verb}?unit=${encodeURIComponent(body.unit)}`
    : `https://x.test/__unit/${verb}`;
  return W.unitApi(ctx, new Request(url, {
    method, headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", "X-Augur-Session": session },
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
  }), new URL(url), env);
};
const json = async (res) => ({ status: res.status, body: await res.json() });

// Wraps an R2-shaped store's read methods with counters, leaving everything else
// (including its `.store` Map that other fixtures reach into) untouched.
function countingBundles(bundles) {
  const counts = { get: 0, head: 0, list: 0 };
  const wrapped = {
    ...bundles,
    get: async (...a) => { counts.get++; return bundles.get(...a); },
    head: async (...a) => { counts.head++; return bundles.head(...a); },
    list: async (...a) => { counts.list++; return bundles.list(...a); },
  };
  return { wrapped, counts };
}

async function setup() {
  const t = tenant(), ctx = ctxFor(t);
  const live = manifestOf(7, { [U]: { "index.html": INDEX, "a.css": CSS } });
  const env = await makeEnv({ live });
  W.__setTenantTestState({ memo: { at: Date.now(), tenantId: t } });
  return { ctx, env };
}

test("open needs a token, answers the live table, and names the draft address", async () => {
  const { ctx, env } = await setup();
  const refused = await json(await call(ctx, env, "open", { unit: U }, { token: "nope" }));
  assert.equal(refused.status, 403);
  const o = await json(await call(ctx, env, "open", { unit: U }));
  assert.equal(o.status, 200, JSON.stringify(o.body));
  assert.equal(o.body.baseRevision, 1);
  assert.equal(o.body.table[`${U}index.html`].h, sha(INDEX));
  assert.equal(o.body.address, `${U}@${o.body.draftId}/`);
  const p = await json(await call(ctx, env, "presence", { unit: U }, { method: "GET" }));
  assert.deepEqual(p.body.drafts.map((d) => [d.session, d.active]), [["pass one", true]]);
});

test("save refuses a change whose blob is not in the store, then accepts it", async () => {
  const { ctx, env } = await setup();
  const o = (await json(await call(ctx, env, "open", { unit: U }))).body;
  const body = "<h1>flow v2</h1>";
  const change = { path: `${U}index.html`, h: sha(body), ct: "text/html; charset=utf-8", s: body.length, baseHash: sha(INDEX) };
  const missing = await json(await call(ctx, env, "save", { unit: U, draftId: o.draftId, draftRevision: 0, changes: [change] }));
  assert.equal(missing.status, 409);
  assert.deepEqual(missing.body, { error: "missing-blobs", missing: [sha(body)] });
  await env.BUNDLES.put(`blobs/${sha(body)}`, body);
  const ok = await json(await call(ctx, env, "save", { unit: U, draftId: o.draftId, draftRevision: 0, changes: [change] }));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.draftRevision, 1);
});

test("land rewrites the space manifest for that unit only, stamps changed files, and closes the draft", async () => {
  const { ctx, env } = await setup();
  const before = liveNow(env);
  const o = (await json(await call(ctx, env, "open", { unit: U }))).body;
  const body = "<h1>flow v2</h1>";
  await env.BUNDLES.put(`blobs/${sha(body)}`, body);
  await call(ctx, env, "save", { unit: U, draftId: o.draftId, draftRevision: 0,
    changes: [{ path: `${U}index.html`, h: sha(body), ct: "text/html; charset=utf-8", s: body.length, baseHash: sha(INDEX) }] });
  const l = await json(await call(ctx, env, "land", { unit: U, draftId: o.draftId, baseRevision: 1, note: "v2" }));
  assert.equal(l.status, 200, JSON.stringify(l.body));
  assert.equal(l.body.version, 8);
  assert.equal(l.body.revision, 2);
  assert.equal(l.body.url, `https://x.test${U}`);
  const after = liveNow(env);
  assert.equal(after.version, 8);
  assert.equal(after.files[`${U}index.html`].h, sha(body));
  assert.equal(after.files[`${U}index.html`].by, W.personId("ada@example.test"));
  assert.equal(typeof after.files[`${U}index.html`].editedAt, "string");
  assert.deepEqual(after.files[`${U}a.css`], before.files[`${U}a.css`], "an untouched file keeps its entry verbatim");
  assert.deepEqual(after.routing.publicPrefixes, [U]);
  assert.equal(after.routing.unitSources[U].landed, true);
  assert.equal(env.BUNDLES.store.has("spaces/alpha/versions/8.json"), true);
  const h = await json(await call(ctx, env, "history", { unit: U }, { method: "GET" }));
  assert.deepEqual(h.body.landings.map((x) => [x.revision, x.note]), [[2, "v2"], [1, "adopted from live"]]);
});

test("a landing made by the old publish path is adopted, so the next land is refused with the delta", async () => {
  const { ctx, env } = await setup();
  const o = (await json(await call(ctx, env, "open", { unit: U }))).body;
  // somebody publishes the unit the old way: the manifest moves under the draft
  const live = liveNow(env);
  const other = "<h1>flow by publish</h1>";
  await env.BUNDLES.put(`blobs/${sha(other)}`, other);
  live.files[`${U}index.html`] = { h: sha(other), ct: "text/html; charset=utf-8", s: other.length };
  live.version = 9;
  await env.BUNDLES.put("spaces/alpha/manifest.json", JSON.stringify(live));
  const l = await json(await call(ctx, env, "land", { unit: U, draftId: o.draftId, baseRevision: 1, note: "" }));
  assert.equal(l.status, 409);
  assert.equal(l.body.error, "main-moved");
  assert.equal(l.body.mainRevision, 2);
  assert.deepEqual(l.body.changed.map((c) => [c.path, c.h]), [[`${U}index.html`, sha(other)]]);
});

test("a new unit lands into publicPrefixes", async () => {
  const { ctx, env } = await setup();
  const NEW = "/checkout/fresh/";
  const o = (await json(await call(ctx, env, "open", { unit: NEW }))).body;
  assert.deepEqual(o.table, {});
  const body = "<h1>fresh</h1>";
  await env.BUNDLES.put(`blobs/${sha(body)}`, body);
  await call(ctx, env, "save", { unit: NEW, draftId: o.draftId, draftRevision: 0,
    changes: [{ path: `${NEW}index.html`, h: sha(body), ct: "text/html; charset=utf-8", s: body.length, baseHash: null }] });
  const l = await json(await call(ctx, env, "land", { unit: NEW, draftId: o.draftId, baseRevision: o.baseRevision, note: "" }));
  assert.equal(l.status, 200, JSON.stringify(l.body));
  assert.deepEqual(liveNow(env).routing.publicPrefixes, [U, NEW]);
});

test("a bad unit, a missing store and a missing binding are each named", async () => {
  const { ctx, env } = await setup();
  const bad = await json(await call(ctx, env, "open", { unit: "/a/@zzzzzz/" }));
  assert.equal(bad.status, 400);
  const noUnits = await json(await call(ctx, { ...env, UNITS: undefined }, "open", { unit: U }));
  assert.equal(noUnits.status, 501);
  assert.equal(noUnits.body.error, "units-not-configured");
});

test("an unauthenticated call never reads the store", async () => {
  const t = tenant();
  const live = manifestOf(7, { [U]: { "index.html": INDEX, "a.css": CSS } });
  const rawEnv = await makeEnv({ live });
  const { wrapped, counts } = countingBundles(rawEnv.BUNDLES);
  const env = { ...rawEnv, BUNDLES: wrapped };
  // The one caller `defaultSpaceIdFromManifests`'s fallback exists for is a context with no SPACES.
  // Production always has this filled in by the time `unitApi` runs, so populate it
  // here too: a call with a populated `tctx.SPACES` must not touch the store to find
  // the space id, refused or not.
  const ctx = { ...ctxFor(t), SPACES: [{ id: "alpha", default: true, adminOnly: false, name: "Alpha" }] };
  W.__setTenantTestState({ memo: { at: Date.now(), tenantId: t } });

  const refused = await json(await call(ctx, env, "open", { unit: U }, { token: "nope" }));
  assert.equal(refused.status, 403);
  assert.deepEqual(counts, { get: 0, head: 0, list: 0 }, "a refused caller must never read the store");

  const ok = await json(await call(ctx, env, "open", { unit: U }));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(counts.get + counts.head + counts.list > 0, "an authenticated caller does read the store");
});

// ── a draft carries its own unit's paths, and nothing else ────────────────────
//
// The hole this closes: an ordinary space-scoped token opened a draft on one prototype
// and saved `/admin/index.html`, `/__canvas/canvas.js` and `/piti.js` into it. Landing
// wrote them into the space manifest, and a space manifest shadows `_engine` in
// `lookupBundleFile` — so the planted bytes were served as the admin panel and as the
// chrome every prototype on the site loads by absolute URL.
test("a save may not carry a path outside its own unit", async () => {
  const { ctx, env } = await setup();
  const before = await W.assetFetch(ctx.tenantId, env, new Request("https://x.test/admin/index.html"));
  const o = (await json(await call(ctx, env, "open", { unit: U }))).body;
  const planted = "<script>everywhere()</script>";
  await env.BUNDLES.put(`blobs/${sha(planted)}`, planted);
  const change = (path) => ({ path, h: sha(planted), ct: "text/html; charset=utf-8", s: planted.length, baseHash: null });
  for (const path of ["/admin/index.html", "/__canvas/canvas.js", "/piti.js", "/checkout/other/x.html"]) {
    const r = await json(await call(ctx, env, "save", { unit: U, draftId: o.draftId, draftRevision: 0, changes: [change(path)] }));
    assert.equal(r.status, 400, `${path} was accepted`);
    assert.deepEqual(r.body, { error: "bad-path", path });
  }
  for (const path of [`${U}../admin/index.html`, `${U}/a.css`, `${U}a//b.css`, "checkout/flow/a.css"]) {
    const r = await json(await call(ctx, env, "save", { unit: U, draftId: o.draftId, draftRevision: 0, changes: [change(path)] }));
    assert.equal(r.status, 400, `${path} was accepted`);
    assert.equal(r.body.error, "bad-path");
  }
  const after = await W.assetFetch(ctx.tenantId, env, new Request("https://x.test/admin/index.html"));
  assert.equal(after.status, before.status, "the chrome path answers exactly as it did before");
  assert.equal(liveNow(env).files["/admin/index.html"], undefined);
});

test("a save states a content type the store can serve", async () => {
  const { ctx, env } = await setup();
  const o = (await json(await call(ctx, env, "open", { unit: U }))).body;
  const body = "<h1>typed</h1>";
  await env.BUNDLES.put(`blobs/${sha(body)}`, body);
  const path = `${U}index.html`;
  for (const ct of ["text/html; charset=utf-8\nX-Evil: 1", "", "text/html; charset=utf-8; boundary=x", "not-a-type"]) {
    const r = await json(await call(ctx, env, "save", { unit: U, draftId: o.draftId, draftRevision: 0,
      changes: [{ path, h: sha(body), ct, s: body.length, baseHash: sha(INDEX) }] }));
    assert.equal(r.status, 400, `${JSON.stringify(ct)} was accepted`);
    assert.deepEqual(r.body, { error: "bad-type", path });
  }
  const ok = await json(await call(ctx, env, "save", { unit: U, draftId: o.draftId, draftRevision: 0,
    changes: [{ path, h: sha(body), ct: "text/html; charset=utf-8", s: body.length, baseHash: sha(INDEX) }] }));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test("a unit is never engine chrome, an engine route or the root", async () => {
  const { ctx, env } = await setup();
  for (const unit of ["/admin/", "/__canvas/", "/piti.js", "/fonts/inter/", "/__search.json"]) {
    const r = await json(await call(ctx, env, "open", { unit }));
    assert.equal(r.status, 400, `${unit} was opened`);
    assert.deepEqual(r.body, { error: "bad-unit", reason: "not-publishable" });
  }
  // The root names no folder at all, so it never reaches the ownership rule.
  const root = await json(await call(ctx, env, "open", { unit: "/" }));
  assert.equal(root.status, 400);
  assert.deepEqual(root.body, { error: "bad-unit" });
});

test("a landing onto a path another live manifest owns is refused, and the lease is let go", async () => {
  const { ctx, env } = await setup();
  const o = (await json(await call(ctx, env, "open", { unit: U }))).body;
  // The engine manifest claims one of the unit's paths. Nothing writes this today; the
  // object could be reached by a caller that does not check, so the write checks.
  await env.BUNDLES.put("spaces/_engine/manifest.json", JSON.stringify({
    id: "_engine", version: 1, format: 1, files: { [`${U}index.html`]: { h: sha("chrome"), ct: "text/html", s: 6 } }, routing: {},
  }));
  const before = liveNow(env).version;
  const l = await json(await call(ctx, env, "land", { unit: U, draftId: o.draftId, baseRevision: 1, note: "" }));
  assert.equal(l.status, 409, JSON.stringify(l.body));
  assert.deepEqual(l.body, { error: "path-conflict", path: `${U}index.html`, owner: "_engine" });
  assert.equal(liveNow(env).version, before, "nothing was published");
  const p = await json(await call(ctx, env, "presence", { unit: U }, { method: "GET" }));
  assert.equal(p.body.drafts.length, 1, "the draft is still open, so the lease was let go");
});
