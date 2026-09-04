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
