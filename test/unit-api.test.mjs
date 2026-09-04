import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";
import { makeEnv, ctxFor, manifestOf, remember, sha, liveNow, unitsNamespace } from "./fixtures/unit-env.mjs";

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
  for (const path of [`${U}../admin/index.html`, `${U}/a.css`, `${U}a//b.css`, "checkout/flow/a.css",
    `${U}./x.html`, `${U}sub/./x.html`, `${U}sub/.`]) {
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

// ── two units landing at once ────────────────────────────────────────────────
//
// The landing writes `spaces/<id>/manifest.json` read-modify-write. Two workers landing
// DIFFERENT units at once both read v8, and the second `put` drops the first one's files
// — which the next `sync-main` then adopts as if somebody had deleted them. The write
// therefore carries the etag it read as a precondition, and a refused write re-reads and
// recomposes from the SAME landed table (the lease pins it) rather than landing stale.
test("a landing that loses the manifest race recomposes and retries", async () => {
  const { ctx, env } = await setup();
  const MKEY = "spaces/alpha/manifest.json";
  const X = U, Y = "/checkout/second/";

  const landUnit = async (unit, body, baseHash) => {
    const o = (await json(await call(ctx, env, "open", { unit }))).body;
    await env.BUNDLES.put(`blobs/${sha(body)}`, body);
    const s = await json(await call(ctx, env, "save", { unit, draftId: o.draftId, draftRevision: 0,
      changes: [{ path: `${unit}index.html`, h: sha(body), ct: "text/html; charset=utf-8", s: body.length, baseHash }] }));
    assert.equal(s.status, 200, JSON.stringify(s.body));
    return json(await call(ctx, env, "land", { unit, draftId: o.draftId, baseRevision: o.baseRevision, note: "" }));
  };

  const xBody = "<h1>flow v2</h1>";
  assert.equal((await landUnit(X, xBody, sha(INDEX))).status, 200);

  // Somebody else's landing, injected exactly once between this one's read of the
  // manifest and its write of it: the landing reads the manifest exactly once per
  // attempt, so the first read after arming is the one whose write must be refused.
  const OTHER = "/checkout/elsewhere/index.html";
  const raw = { get: env.BUNDLES.get.bind(env.BUNDLES), put: env.BUNDLES.put.bind(env.BUNDLES) };
  let armed = false, injected = false, manifestPuts = 0;
  env.BUNDLES.get = async (k, opts) => {
    const r = await raw.get(k, opts);
    if (armed && !injected && k === MKEY) {
      injected = true;
      const m = JSON.parse(env.BUNDLES.store.get(MKEY));
      m.files[OTHER] = { h: sha("elsewhere"), ct: "text/html; charset=utf-8", s: 9 };
      m.routing.publicPrefixes = [...m.routing.publicPrefixes, "/checkout/elsewhere/"];
      m.version += 1;
      await raw.put(MKEY, JSON.stringify(m));
    }
    return r;
  };
  env.BUNDLES.put = async (k, v, opts) => { if (k === MKEY) manifestPuts++; return raw.put(k, v, opts); };

  const yBody = "<h1>second</h1>";
  const o = (await json(await call(ctx, env, "open", { unit: Y }))).body;
  await env.BUNDLES.put(`blobs/${sha(yBody)}`, yBody);
  await call(ctx, env, "save", { unit: Y, draftId: o.draftId, draftRevision: 0,
    changes: [{ path: `${Y}index.html`, h: sha(yBody), ct: "text/html; charset=utf-8", s: yBody.length, baseHash: null }] });
  armed = true; // only the LAND reads the manifest to write it back
  const l = await json(await call(ctx, env, "land", { unit: Y, draftId: o.draftId, baseRevision: o.baseRevision, note: "" }));
  assert.equal(injected, true, "the out-of-band change never happened");
  assert.equal(l.status, 200, JSON.stringify(l.body));
  assert.equal(manifestPuts, 2, "the first write must have been refused and retried");

  const after = liveNow(env);
  assert.equal(after.files[`${X}index.html`].h, sha(xBody), "the first unit's landing survived");
  assert.equal(after.files[`${Y}index.html`].h, sha(yBody), "the second unit's landing is live");
  assert.equal(after.files[OTHER].h, sha("elsewhere"), "the out-of-band landing was not dropped");
  assert.equal(after.version, l.body.version);
});

// ── the version document belongs to the write that won ───────────────────────
//
// The loser of the manifest race used to leave a `versions/<n>.json` behind, and on a
// deployment with no version-issuing store (`nextPublishVersion` falling back to
// `cur.version + 1`) the two attempts computed the SAME number — so the loser's document
// OVERWROTE the winner's, and `rollback <n>` would have silently reverted somebody
// else's landing to a table that was never live. The version document is therefore
// written only after the manifest write succeeds, from the same attempt.
test("a version document is written only for the attempt whose manifest write won", async () => {
  const { ctx, env } = await setup();
  const MKEY = "spaces/alpha/manifest.json";
  const Y = "/checkout/second/";
  const OTHER = "/checkout/elsewhere/index.html";
  const raw = { get: env.BUNDLES.get.bind(env.BUNDLES), put: env.BUNDLES.put.bind(env.BUNDLES) };

  // Somebody else's landing, injected once between this one's read and its write — and
  // this time a WHOLE publish, version document included, exactly as the winner leaves it.
  let armed = false, injected = null;
  env.BUNDLES.get = async (k, opts) => {
    const r = await raw.get(k, opts);
    if (armed && !injected && k === MKEY) {
      const m = JSON.parse(env.BUNDLES.store.get(MKEY));
      m.files[OTHER] = { h: sha("elsewhere"), ct: "text/html; charset=utf-8", s: 9 };
      m.routing.publicPrefixes = [...m.routing.publicPrefixes, "/checkout/elsewhere/"];
      m.version += 1;
      injected = { version: m.version, doc: JSON.stringify(m) };
      await raw.put(`spaces/alpha/versions/${m.version}.json`, injected.doc);
      await raw.put(MKEY, injected.doc);
    }
    return r;
  };

  const yBody = "<h1>second</h1>";
  const o = (await json(await call(ctx, env, "open", { unit: Y }))).body;
  await env.BUNDLES.put(`blobs/${sha(yBody)}`, yBody);
  await call(ctx, env, "save", { unit: Y, draftId: o.draftId, draftRevision: 0,
    changes: [{ path: `${Y}index.html`, h: sha(yBody), ct: "text/html; charset=utf-8", s: yBody.length, baseHash: null }] });
  armed = true;
  const l = await json(await call(ctx, env, "land", { unit: Y, draftId: o.draftId, baseRevision: o.baseRevision, note: "" }));
  assert.equal(l.status, 200, JSON.stringify(l.body));
  assert.ok(injected, "the out-of-band publish never happened");
  assert.notEqual(l.body.version, injected.version, "the retry issued a fresh number");

  // The losing attempt reused the winner's number, so its document must never have been
  // written: what is under that number is the winner's own bytes, untouched.
  assert.equal(env.BUNDLES.store.get(`spaces/alpha/versions/${injected.version}.json`), injected.doc,
    "the losing attempt overwrote a version document that was genuinely live");
  // And the attempt that won left its own, matching the manifest byte for byte.
  assert.equal(env.BUNDLES.store.get(`spaces/alpha/versions/${l.body.version}.json`), env.BUNDLES.store.get(MKEY));
});

// ── an emptied draft, and prefixes with nothing behind them ──────────────────
test("emptying a draft cannot take the prototype's URL down, and a dead prefix is pruned", async () => {
  const { ctx, env } = await setup();
  const before = liveNow(env);
  const o = (await json(await call(ctx, env, "open", { unit: U }))).body;
  for (const [path, baseHash] of [[`${U}index.html`, sha(INDEX)], [`${U}a.css`, sha(CSS)]]) {
    const r = await json(await call(ctx, env, "save", { unit: U, draftId: o.draftId, draftRevision: o.draftRevision || 0,
      changes: [{ path, delete: true, baseHash }] }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    o.draftRevision = r.body.draftRevision;
  }
  const l = await json(await call(ctx, env, "land", { unit: U, draftId: o.draftId, baseRevision: 1, note: "" }));
  assert.equal(l.status, 409, JSON.stringify(l.body));
  assert.deepEqual(l.body, { error: "would-unpublish" });
  assert.deepEqual(liveNow(env), before, "the manifest did not move");
  assert.equal((await W.assetFetch(ctx.tenantId, env, new Request(`https://x.test${U}`))).status, 200);
});

test("a landing prunes a public prefix nothing serves under any more", async () => {
  const { ctx, env } = await setup();
  const live = liveNow(env);
  live.routing.publicPrefixes = [...live.routing.publicPrefixes, "/checkout/gone/"];
  await env.BUNDLES.put("spaces/alpha/manifest.json", JSON.stringify(live));
  const o = (await json(await call(ctx, env, "open", { unit: U }))).body;
  const body = "<h1>flow v2</h1>";
  await env.BUNDLES.put(`blobs/${sha(body)}`, body);
  await call(ctx, env, "save", { unit: U, draftId: o.draftId, draftRevision: 0,
    changes: [{ path: `${U}index.html`, h: sha(body), ct: "text/html; charset=utf-8", s: body.length, baseHash: sha(INDEX) }] });
  const l = await json(await call(ctx, env, "land", { unit: U, draftId: o.draftId, baseRevision: 1, note: "" }));
  assert.equal(l.status, 200, JSON.stringify(l.body));
  assert.deepEqual(liveNow(env).routing.publicPrefixes, [U], "a prefix with no files behind it is not carried forward");
});

// ── a unit is a prototype folder ─────────────────────────────────────────────
//
// `augur open checkout` drafted `/checkout/` and landing added `/checkout/` to
// publicPrefixes. The gate matches by startsWith, so every gated prototype under that
// opportunity opened to anonymous visitors — from a draft on a folder nobody edits.
test("an opportunity is not a unit, and a prototype folder is", async () => {
  const { ctx, env } = await setup();
  for (const unit of ["/checkout/", "/skills/", "/playground/"]) {
    const r = await json(await call(ctx, env, "open", { unit }));
    assert.equal(r.status, 400, `${unit} was opened`);
    assert.equal(r.body.error, "bad-unit");
  }
  for (const unit of ["/checkout/fresh/", "/playground/sketch/"]) {
    const r = await json(await call(ctx, env, "open", { unit }));
    assert.equal(r.status, 200, `${unit}: ${JSON.stringify(r.body)}`);
  }
});

// ── a new unit may not claim a shared folder ─────────────────────────────────
//
// A two-segment path was enough to open a NEW unit, so `/components/button/` or
// `/skills/x-ui/` opened as one — and landing replaces a unit's folder wholesale, which
// would have taken the design system's or the gallery's own files with it.
test("a new unit may not sit under a folder the site shares", async () => {
  const { ctx, env } = await setup();
  for (const unit of ["/components/button/", "/skills/x-ui/", "/base/x/", "/pages/x/", "/patterns/x/"]) {
    const r = await json(await call(ctx, env, "open", { unit }));
    assert.equal(r.status, 400, `${unit} was opened`);
    assert.deepEqual(r.body, { error: "bad-unit", reason: "reserved-folder" });
  }
  for (const unit of ["/checkout/fresh/", "/playground/sketch/"]) {
    const r = await json(await call(ctx, env, "open", { unit }));
    assert.equal(r.status, 200, `${unit}: ${JSON.stringify(r.body)}`);
  }
  // A unit the manifest already declares is a unit wherever it sits.
  const EXISTING = "/components/button/";
  const live = liveNow(env);
  live.files[`${EXISTING}index.html`] = live.files[`${U}index.html`];
  live.routing.publicPrefixes = [...live.routing.publicPrefixes, EXISTING];
  await env.BUNDLES.put("spaces/alpha/manifest.json", JSON.stringify(live));
  assert.equal((await json(await call(ctx, env, "open", { unit: EXISTING }))).status, 200);
});

test("a unit the space already publishes is a unit whatever its shape", async () => {
  const { ctx, env } = await setup();
  const DEEP = "/toolkit/embed/deep/";
  const live = liveNow(env);
  live.files[`${DEEP}index.html`] = live.files[`${U}index.html`];
  live.routing.publicPrefixes = [...live.routing.publicPrefixes, DEEP];
  await env.BUNDLES.put("spaces/alpha/manifest.json", JSON.stringify(live));
  const r = await json(await call(ctx, env, "open", { unit: DEEP }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test("landing a unit the manifest already declares leaves the prefix list alone", async () => {
  const { ctx, env } = await setup();
  const live = liveNow(env);
  // The same unit, spelled as a manifest may already carry it.
  live.routing.publicPrefixes = ["/checkout/flow"];
  await env.BUNDLES.put("spaces/alpha/manifest.json", JSON.stringify(live));
  const o = (await json(await call(ctx, env, "open", { unit: U }))).body;
  const body = "<h1>flow v2</h1>";
  await env.BUNDLES.put(`blobs/${sha(body)}`, body);
  await call(ctx, env, "save", { unit: U, draftId: o.draftId, draftRevision: 0,
    changes: [{ path: `${U}index.html`, h: sha(body), ct: "text/html; charset=utf-8", s: body.length, baseHash: sha(INDEX) }] });
  const l = await json(await call(ctx, env, "land", { unit: U, draftId: o.draftId, baseRevision: 1, note: "" }));
  assert.equal(l.status, 200, JSON.stringify(l.body));
  assert.deepEqual(liveNow(env).routing.publicPrefixes, ["/checkout/flow"], "the unit was not declared a second time");
});

// ── the bytes are live even when the record of them is not ───────────────────
//
// `land` writes the manifest and THEN tells the object it happened. Between the two the
// lease can lapse (a slow write) or the object can blink, and the answer used to be the
// object's refusal — while main had already moved. The caller read a failure, the bytes
// were live, and the next call adopted them as `by: "live"`, losing the author.
function landedFails(times) {
  const ns = unitsNamespace();
  let n = 0;
  return {
    ...ns,
    get(name) {
      const stub = ns.get(name);
      return {
        fetch(input, init) {
          const p = new URL(typeof input === "string" ? input : input.url).pathname;
          if (p === "/landed" && n < times) {
            n++;
            return new Response(JSON.stringify({ error: "bad-lease" }), { status: 409, headers: { "content-type": "application/json" } });
          }
          return stub.fetch(input, init);
        },
      };
    },
  };
}

test("a landing the object could not record is reported as landed, not as a failure", async () => {
  const t = tenant(), ctx = ctxFor(t);
  const env = await makeEnv({ live: manifestOf(7, { [U]: { "index.html": INDEX, "a.css": CSS } }), units: landedFails(2) });
  W.__setTenantTestState({ memo: { at: Date.now(), tenantId: t } });
  const o = (await json(await call(ctx, env, "open", { unit: U }))).body;
  const body = "<h1>flow v2</h1>";
  await env.BUNDLES.put(`blobs/${sha(body)}`, body);
  await call(ctx, env, "save", { unit: U, draftId: o.draftId, draftRevision: 0,
    changes: [{ path: `${U}index.html`, h: sha(body), ct: "text/html; charset=utf-8", s: body.length, baseHash: sha(INDEX) }] });
  const l = await json(await call(ctx, env, "land", { unit: U, draftId: o.draftId, baseRevision: 1, note: "v2" }));
  assert.equal(l.status, 200, JSON.stringify(l.body));
  assert.equal(l.body.recorded, false);
  assert.equal(l.body.revision, null);
  assert.equal(l.body.warning, "landed-unrecorded");
  assert.equal(l.body.version, 8);
  assert.equal(l.body.url, `https://x.test${U}`);
  assert.equal(liveNow(env).files[`${U}index.html`].h, sha(body), "the bytes ARE live");
  const served = await W.assetFetch(t, env, new Request(`https://x.test${U}`));
  assert.equal(await served.text(), body);
  // The next call adopts the landing that was never recorded, so the history says it
  // happened even though it cannot say who landed it.
  const h = await json(await call(ctx, env, "history", { unit: U }, { method: "GET" }));
  assert.deepEqual(h.body.landings.map((x) => [x.revision, x.by]), [[2, "live"], [1, "live"]]);
});

// The landing lease exists to keep two landings off one unit for the ten seconds the
// manifest write takes. A landing whose record never went through holds a lease that
// NOBODY will ever commit under — so it is let go, and the next landing on the unit is
// answered on its own merits instead of waiting out a window that means nothing.
test("a landing the object could not record lets its lease go", async () => {
  const t = tenant(), ctx = ctxFor(t);
  const env = await makeEnv({ live: manifestOf(7, { [U]: { "index.html": INDEX, "a.css": CSS } }), units: landedFails(2) });
  W.__setTenantTestState({ memo: { at: Date.now(), tenantId: t } });
  // A second person's draft, open on the same unit before any of this.
  const other = (await json(await call(ctx, env, "open", { unit: U }, { session: "pass two" }))).body;

  const o = (await json(await call(ctx, env, "open", { unit: U }))).body;
  const body = "<h1>flow v2</h1>";
  await env.BUNDLES.put(`blobs/${sha(body)}`, body);
  await call(ctx, env, "save", { unit: U, draftId: o.draftId, draftRevision: 0,
    changes: [{ path: `${U}index.html`, h: sha(body), ct: "text/html; charset=utf-8", s: body.length, baseHash: sha(INDEX) }] });
  assert.equal((await json(await call(ctx, env, "land", { unit: U, draftId: o.draftId, baseRevision: 1, note: "v2" }))).body.recorded, false);

  // The unit moved under the other draft, and that is what it is told — not that a
  // landing is in progress.
  const l2 = await json(await call(ctx, env, "land", { unit: U, draftId: other.draftId, baseRevision: other.baseRevision, note: "" }));
  assert.equal(l2.status, 409, JSON.stringify(l2.body));
  assert.equal(l2.body.error, "main-moved");

  // And a draft opened on what is live now lands straight away, rather than waiting out
  // the abandoned lease.
  const fresh = (await json(await call(ctx, env, "open", { unit: U }, { session: "pass three" }))).body;
  const third = "<h1>flow v3</h1>";
  await env.BUNDLES.put(`blobs/${sha(third)}`, third);
  await call(ctx, env, "save", { unit: U, draftId: fresh.draftId, draftRevision: 0,
    changes: [{ path: `${U}index.html`, h: sha(third), ct: "text/html; charset=utf-8", s: third.length, baseHash: sha(body) }] });
  const l3 = await json(await call(ctx, env, "land", { unit: U, draftId: fresh.draftId, baseRevision: fresh.baseRevision, note: "v3" }));
  assert.equal(l3.status, 200, JSON.stringify(l3.body));
  assert.equal(liveNow(env).files[`${U}index.html`].h, sha(third));
});

test("a landing recorded on the retry is a landing like any other", async () => {
  const t = tenant(), ctx = ctxFor(t);
  const env = await makeEnv({ live: manifestOf(7, { [U]: { "index.html": INDEX, "a.css": CSS } }), units: landedFails(1) });
  W.__setTenantTestState({ memo: { at: Date.now(), tenantId: t } });
  const o = (await json(await call(ctx, env, "open", { unit: U }))).body;
  const body = "<h1>flow v2</h1>";
  await env.BUNDLES.put(`blobs/${sha(body)}`, body);
  await call(ctx, env, "save", { unit: U, draftId: o.draftId, draftRevision: 0,
    changes: [{ path: `${U}index.html`, h: sha(body), ct: "text/html; charset=utf-8", s: body.length, baseHash: sha(INDEX) }] });
  const l = await json(await call(ctx, env, "land", { unit: U, draftId: o.draftId, baseRevision: 1, note: "v2" }));
  assert.equal(l.status, 200, JSON.stringify(l.body));
  assert.equal(l.body.recorded, true);
  assert.equal(l.body.revision, 2);
  const h = await json(await call(ctx, env, "history", { unit: U }, { method: "GET" }));
  assert.deepEqual(h.body.landings.map((x) => [x.revision, x.by, x.note]),
    [[2, W.personId("ada@example.test"), "v2"], [1, "live", "adopted from live"]]);
});
