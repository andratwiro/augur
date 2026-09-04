// test/unit-serve.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";
import { makeEnv, ctxFor, manifestOf, remember, sha } from "./fixtures/unit-env.mjs";

let n = 0;
const U = "/checkout/flow/";
const INDEX = remember("<h1>flow</h1>");
const CSS = remember("h1{color:red}");

async function draftWithEdit() {
  const t = `unit-serve-${++n}`, ctx = ctxFor(t);
  const env = await makeEnv({ live: manifestOf(3, { [U]: { "index.html": INDEX, "a.css": CSS } }) });
  W.__setTenantTestState({ memo: { at: Date.now(), tenantId: t } });
  const api = async (verb, body) => (await W.unitApi(ctx, new Request(`https://x.test/__unit/${verb}`, {
    method: "POST", headers: { Authorization: "Bearer tok", "content-type": "application/json" }, body: JSON.stringify(body),
  }), new URL(`https://x.test/__unit/${verb}`), env)).json();
  const o = await api("open", { unit: U });
  const v2 = "<h1>flow v2</h1>";
  await env.BUNDLES.put(`blobs/${sha(v2)}`, v2);
  await api("save", { unit: U, draftId: o.draftId, draftRevision: 0,
    changes: [{ path: `${U}index.html`, h: sha(v2), ct: "text/html; charset=utf-8", s: v2.length, baseHash: sha(INDEX) }] });
  return { t, ctx, env, draftId: o.draftId, v2 };
}

test("a draft address serves the draft's bytes while the real URL serves main", async () => {
  const { t, env, draftId, v2 } = await draftWithEdit();
  const draft = await W.assetFetch(t, env, new Request(`https://x.test${U}@${draftId}/`));
  assert.equal(draft.status, 200);
  assert.equal(await draft.text(), v2);
  assert.equal(draft.headers.get("Content-Type"), "text/html; charset=utf-8");
  const main = await W.assetFetch(t, env, new Request(`https://x.test${U}`));
  assert.equal(await main.text(), INDEX);
  const css = await W.assetFetch(t, env, new Request(`https://x.test${U}@${draftId}/a.css`));
  assert.equal(await css.text(), CSS, "an untouched file resolves through the draft table too");
  const missing = await W.assetFetch(t, env, new Request(`https://x.test${U}@zzzzzz/`));
  assert.equal(missing.status, 404);
});

test("a draft address is never public, whatever the unit's own gate says", async () => {
  const { ctx, draftId } = await draftWithEdit();
  const tctx = { ...ctx, PUBLIC_PREFIXES: [U], PUBLIC_SKILL_PREFIXES: [] };
  assert.equal(W.isPublicPath(tctx, `${U}index.html`), true);
  assert.equal(W.isPublicPath(tctx, `${U}@${draftId}/index.html`), false);
  assert.equal(W.isPublicPath(tctx, `${U}@${draftId}/`), false);
  assert.equal(W.isPublicPath(tctx, `${U}%40${draftId}/index.html`), false,
    "a percent-encoded draft address must not sail past the gate on a literal @ check");
  assert.equal(W.isPublicPath(tctx, "/checkout/flow/%E0%A4%A"), false,
    "an undecodable path is not public");
});

test("an encoded draft address serves through the same table", async () => {
  const { t, env, draftId, v2 } = await draftWithEdit();
  const draft = await W.assetFetch(t, env, new Request(`https://x.test${U}%40${draftId}/`));
  assert.equal(draft.status, 200);
  assert.equal(await draft.text(), v2);
});
