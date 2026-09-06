// test/ds-overlay.test.mjs — `?ds=<draft>`: a design-system draft across the whole site.
// A member checking a shared change opens any prototype with the query; the cookie keeps
// it while they navigate; an empty query drops it. Design-system files resolve from that
// draft's table and nothing else does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";
import { makeEnv, ctxFor, manifestOf, remember, sha } from "./fixtures/unit-env.mjs";

let n = 0;
const U = "/checkout/flow/", DS = "/skills/starter-ui/";
const INDEX = remember('<link rel="stylesheet" href="/skills/starter-ui/tokens.css"><h1>flow</h1>');
const TOKENS = remember(":root{--s-ink:#111}");

async function setup() {
  const t = `ds-${++n}`, ctx = { ...ctxFor(t), PUBLIC_SKILL_PREFIXES: [DS] };
  const live = manifestOf(7, { [U]: { "index.html": INDEX } });
  live.files[`${DS}tokens.css`] = { h: sha(TOKENS), ct: "text/css; charset=utf-8", s: TOKENS.length };
  live.routing.publicSkillPrefixes = [DS];
  const env = await makeEnv({ live });
  await env.BUNDLES.put(`blobs/${sha(TOKENS)}`, TOKENS);
  W.__setTenantTestState({ memo: { at: Date.now(), tenantId: t } });
  const api = async (verb, body) => (await W.unitApi(ctx, new Request(`https://x.test/__unit/${verb}`, {
    method: "POST", headers: { Authorization: "Bearer tok", "content-type": "application/json" }, body: JSON.stringify(body),
  }), new URL(`https://x.test/__unit/${verb}`), env)).json();
  const o = await api("open", { unit: DS });
  const v2 = ":root{--s-ink:teal}";
  await env.BUNDLES.put(`blobs/${sha(v2)}`, v2);
  const saved = await api("save", { unit: DS, draftId: o.draftId, draftRevision: 0,
    changes: [{ path: `${DS}tokens.css`, h: sha(v2), ct: "text/css; charset=utf-8", s: v2.length, baseHash: sha(TOKENS) }] });
  assert.equal(saved.draftRevision, 1, JSON.stringify(saved));
  return { t, ctx, env, draftId: o.draftId, v2 };
}

test("a design-system file resolves from the named draft, and from main without it", async () => {
  const { t, env, draftId, v2 } = await setup();
  const path = `https://x.test${DS}tokens.css`;
  assert.equal(await (await W.assetFetch(t, env, new Request(path))).text(), TOKENS);
  assert.equal(await (await W.assetFetch(t, env, new Request(path), { dsDraft: draftId })).text(), v2);
  assert.equal(await (await W.assetFetch(t, env, new Request(path), { dsDraft: "zzzzzz" })).text(), TOKENS, "an unknown draft changes nothing");
  const proto = await W.assetFetch(t, env, new Request(`https://x.test${U}`), { dsDraft: draftId });
  assert.equal(await proto.text(), INDEX, "a prototype's own files never come from the design-system draft");
});

test("the query sets the cookie, the cookie carries it, an empty query clears it", () => {
  const at = (path, cookie) => W.dsOverlay(new Request(`https://x.test${path}`, { headers: cookie ? { Cookie: cookie } : {} }), new URL(`https://x.test${path}`));
  const set = at("/checkout/flow/?ds=k7f3q1");
  assert.equal(set.draft, "k7f3q1");
  assert.match(set.setCookie, /^augur_ds=k7f3q1; Path=\/; SameSite=Lax; Secure; HttpOnly$/);
  const carried = at("/checkout/flow/", "augur_ds=k7f3q1; other=1");
  assert.equal(carried.draft, "k7f3q1");
  assert.equal(carried.setCookie, null);
  const cleared = at("/checkout/flow/?ds=", "augur_ds=k7f3q1");
  assert.equal(cleared.draft, null);
  assert.match(cleared.setCookie, /^augur_ds=; Path=\/; Max-Age=0/);
  assert.equal(at("/checkout/flow/?ds=NOPE").draft, null, "a malformed id is nobody's draft");
  assert.equal(at("/checkout/flow/?ds=NOPE").setCookie, null);
  assert.equal(at("/checkout/flow/", "augur_ds=NOPE").draft, null);
  assert.equal(at("/checkout/flow/").draft, null);
});
