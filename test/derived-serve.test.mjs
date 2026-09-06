// test/derived-serve.test.mjs — where drafts are served, the gallery and its indexes come
// from the live store, so a landing is on them at once; where they are not, nothing here runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";
import { makeEnv, ctxFor, manifestOf, remember, sha, file, ADA } from "./fixtures/unit-env.mjs";

let n = 0;
const U = "/checkout/flow/", V = "/checkout/other/", P = "/playground/scratch/";
const INDEX = remember("<h1>flow</h1>");
const STALE = remember("<!doctype html><h1>a gallery somebody built last month</h1>");

async function setup(extra = {}) {
  const t = `derived-${++n}`, ctx = ctxFor(t);
  const live = manifestOf(7, { [U]: { "index.html": INDEX }, [V]: { "index.html": INDEX }, [P]: { "index.html": INDEX } });
  live.files["/index.html"] = file(STALE);
  live.files["/checkout/index.html"] = file(STALE);
  live.files[`${U}preview.webp`] = { h: sha("webp"), ct: "image/webp", s: 4 };
  live.files[`${U}index.html`] = { ...live.files[`${U}index.html`], by: W.personId(ADA.email), editedAt: "2026-09-05T10:00:00.000Z" };
  const env = await makeEnv({ live });
  await env.BUNDLES.put(`blobs/${sha("webp")}`, "webp");
  W.__setTenantTestState({ memo: { at: Date.now(), tenantId: t } });
  return { t, ctx: { ...ctx, ...extra }, env, live };
}
const page = (ctx, env, path) => W.derivedPage(ctx, env, new URL(`https://x.test${path}`));

test("the root, an opportunity, the playground, the tiers and the finder index are derived from the units", async () => {
  const { ctx, env } = await setup();
  const root = await page(ctx, env, "/");
  assert.equal(root.status, 200);
  const html = await root.text();
  assert.doesNotMatch(html, /somebody built last month/, "the stored gallery is not what is served");
  assert.match(html, /class="card-opp"/);
  assert.match(html, /<span class="folderbar__count">1<\/span>/, "one folder: checkout");
  assert.match(html, /src="\/checkout\/flow\/preview\.webp"/);
  assert.match(html, /data-person="/, "the recorded author's face");
  assert.match(html, /2 prototypes/);
  const opp = await (await page(ctx, env, "/checkout/")).text();
  assert.equal((opp.match(/class="card-proto"/g) || []).length, 2);
  assert.match(opp, /data-status-key="checkout\/flow"/);
  const redirect = await page(ctx, env, "/checkout");
  assert.equal(redirect.status, 308);
  assert.equal(new URL(redirect.headers.get("Location")).pathname, "/checkout/");
  const pg = await (await page(ctx, env, "/playground/")).text();
  assert.match(pg, /data-rename-key="playground\/scratch"/);
  const base = await (await page(ctx, env, "/base/")).text();
  assert.match(base, /class="ghosts"/);
  const search = await page(ctx, env, "/__search.json");
  const idx = await search.json();
  assert.ok(idx.some((e) => e.y === "Prototype" && e.k === "checkout/flow"));
  assert.ok(idx.some((e) => e.y === "Playground" && e.k === "playground/scratch"));
  assert.equal(await page(ctx, env, "/checkout/flow/"), null, "a unit page is served from its table, not derived");
  assert.equal(await page(ctx, env, "/nowhere/"), null);
  assert.equal(await page(ctx, env, "/checkout/flow/index.html"), null);
});

test("the status overlay and the baseline both reach the cards; the overlay wins", async () => {
  const { ctx, env, live } = await setup();
  const baseline = JSON.stringify({ _comment: "x", "checkout/flow": "in-progress", "checkout/other": "dev-ready" });
  live.files["/prototype-status.json"] = file(baseline, "application/json");
  await env.BUNDLES.put(`blobs/${sha(baseline)}`, baseline);
  await env.BUNDLES.put("spaces/alpha/manifest.json", JSON.stringify(live));
  W.__setConfigTestState({ manifests: null });
  await env.COMMENTS.put("statuses", JSON.stringify({ "checkout/flow": "dev-ready" }));
  const opp = await (await page(ctx, env, "/checkout/")).text();
  assert.match(opp, /data-status-key="checkout\/flow" data-status="dev-ready"/, "the overlay wins over the baseline");
  assert.match(opp, /data-status-key="checkout\/other" data-status="dev-ready"/, "the baseline stands alone");
});

test("a unit landed from a draft is on the gallery on the next request, with no publish", async () => {
  const { ctx, env } = await setup();
  const call = async (verb, body) => (await W.unitApi(ctx, new Request(`https://x.test/__unit/${verb}`, {
    method: "POST", headers: { Authorization: "Bearer tok", "content-type": "application/json", "X-Augur-Session": "s" }, body: JSON.stringify(body),
  }), new URL(`https://x.test/__unit/${verb}`), env)).json();
  const NEW = "/onboarding/welcome/";
  const o = await call("open", { unit: NEW });
  assert.equal(o.draftId.length, 6, JSON.stringify(o));
  const body = "<h1>welcome</h1>";
  await env.BUNDLES.put(`blobs/${sha(body)}`, body);
  await call("save", { unit: NEW, draftId: o.draftId, draftRevision: 0, changes: [{ path: `${NEW}index.html`, h: sha(body), ct: "text/html; charset=utf-8", s: body.length, baseHash: null }] });
  const before = await (await page(ctx, env, "/")).text();
  assert.doesNotMatch(before, /Onboarding/, "a draft is not on the gallery");
  const landed = await call("land", { unit: NEW, draftId: o.draftId, baseRevision: o.baseRevision, note: "" });
  assert.equal(landed.ok, true, JSON.stringify(landed));
  const after = await (await page(ctx, env, "/")).text();
  assert.match(after, /Onboarding/, "landed: on the gallery");
  assert.match(after, /<span class="folderbar__count">2<\/span>/);
  const opp = await (await page(ctx, env, "/onboarding/")).text();
  assert.match(opp, /data-rename-key="onboarding\/welcome"/);
  assert.match(opp, /data-person="/, "credited to the person who landed it");
});

test("where drafts are not served, nothing is derived", async () => {
  const { ctx, env } = await setup();
  const plain = { ...env, UNITS: undefined };
  assert.equal(await page(ctx, plain, "/"), null);
  assert.equal(await page(ctx, plain, "/checkout/"), null);
});
