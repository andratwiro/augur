// test/draft-bearer-view.test.mjs — a draft address answers to the paired terminal's token.
//
// The draft is the terminal's own work (`open`, `save`, `land` act as the member the token
// names), and the page it is told is "live at once" met it with the sign-in card: no cookie.
// Measured 9 Sep 2026: an agent built a local server to look at its own draft. A GET of the
// draft address carrying `Authorization: Bearer <publish token>` is now served as that
// token's member, no-store; the same header opens nothing else — not main, not /__me — and
// a machine token with no person behind it opens nothing at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/_worker.js";
import { __testables as W } from "../src/_worker.js";
import { makeEnv, manifestOf, remember, sha, ADA_MEMBER, cookieFor } from "./fixtures/unit-env.mjs";

// A member's page goes through the live-reload rewriter, which only exists on the edge. Node
// gets a pass-through: this test asks WHO is served the draft's bytes, not what is injected.
if (typeof globalThis.HTMLRewriter === "undefined") {
  globalThis.HTMLRewriter = class { on() { return this; } onDocument() { return this; } transform(res) { return res; } };
}

let n = 0;
const U = "/checkout/flow/";
const INDEX = remember("<h1>flow</h1>");
const V2 = "<h1>flow v2</h1>";

async function draft() {
  const t = `bearer-view-${++n}`;
  const env = await makeEnv({ live: manifestOf(3, { [U]: { "index.html": INDEX } }) });
  // Bundle mode reads the roster from the store's own config document; the fixture's env has
  // none, so this is a workspace with one member (Ada, an editor) and pairing on.
  await env.BUNDLES.put("config/instance.json", JSON.stringify({ users: [ADA_MEMBER], tenantId: t, devicePairing: true }));
  // A second token an admin typed for a machine: in scope, no person behind the label.
  const tokens = JSON.parse(await env.COMMENTS.get("publish:tokens"));
  tokens[await W.tokenFor("pub:machine")] = { space: "alpha", label: "ci" };
  await env.COMMENTS.put("publish:tokens", JSON.stringify(tokens));
  W.__setTenantTestState({ memo: { at: Date.now(), tenantId: t } });
  W.__setConfigTestState({ cfgAt: 0, cfgGoodAt: 0 });
  const call = async (path, headers = {}, method = "GET", body) => {
    const orig = console.log; console.log = () => {};
    try {
      const res = await worker.fetch(new Request(`https://x.test${path}`, { method, headers, body }), env, {});
      return { status: res.status, headers: res.headers, body: await res.text() };
    } finally { console.log = orig; }
  };
  const api = async (verb, payload) => JSON.parse((await call(`/__unit/${verb}`, { Authorization: "Bearer tok", "content-type": "application/json" }, "POST", JSON.stringify(payload))).body);
  const o = await api("open", { unit: U });
  assert.ok(o.draftId, JSON.stringify(o));
  await env.BUNDLES.put(`blobs/${sha(V2)}`, V2);
  const s = await api("save", { unit: U, draftId: o.draftId, draftRevision: 0,
    changes: [{ path: `${U}index.html`, h: sha(V2), ct: "text/html; charset=utf-8", s: V2.length, baseHash: sha(INDEX) }] });
  assert.equal(s.draftRevision, 1, JSON.stringify(s));
  assert.equal(o.address, `/checkout/flow@${o.draftId}/`, "the address sits at the unit's depth");
  return { env, call, address: o.address };
}

test("the paired terminal's token opens its draft address; nothing and nobody else does", async () => {
  const { env, call, address } = await draft();

  const anon = await call(address);
  assert.equal(anon.status, 200, "the gate answers 200 with the sign-in card");
  assert.doesNotMatch(anon.body, /flow v2/, "no cookie, no token: the draft is not shown");

  const member = await call(address, { Cookie: await cookieFor(env, ADA_MEMBER) });
  assert.match(member.body, /flow v2/, "a signed-in member sees the draft (unchanged)");
  assert.match(member.body, /__augurDraft/, "a member's page carries the draft bar");

  const bearer = await call(address, { Authorization: "Bearer tok" });
  assert.equal(bearer.status, 200);
  assert.match(bearer.body, /flow v2/, "the token's member sees the draft");
  assert.doesNotMatch(bearer.body, /__augurDraft|__drafts\/drafts\.js/, "no draft bar: its calls have no session and would only fail");

  const relative = new URL("../../skills/ui/a.css", `https://x.test${address}`).pathname;
  assert.equal(relative, new URL("../../skills/ui/a.css", `https://x.test${U}`).pathname, "a relative link resolves as on the real page");
  assert.equal(bearer.headers.get("Cache-Control"), "no-store");
  assert.match(bearer.headers.get("Vary") || "", /Authorization/);

  const encoded = await call(address.replace("@", "%40"), { Authorization: "Bearer tok" });
  assert.match(encoded.body, /flow v2/, "the encoded spelling is the same address");

  const wrong = await call(address, { Authorization: "Bearer nope" });
  assert.doesNotMatch(wrong.body, /flow v2/, "an unknown token is a stranger");

  const machine = await call(address, { Authorization: "Bearer machine" });
  assert.doesNotMatch(machine.body, /flow v2/, "a machine token names no person to see the page as");

  const posted = await call(address, { Authorization: "Bearer tok" }, "POST", "");
  assert.doesNotMatch(posted.body, /flow v2/, "only a read is opened by the header");
});

test("the header widens nothing else: /__me stays signed out and main stays gated for a bearer", async () => {
  const { call } = await draft();
  const me = await call("/__me", { Authorization: "Bearer tok" });
  assert.equal(JSON.parse(me.body).user, null, "identity from a bearer exists only for a draft-address read");
  // The gallery at the root is gated content; a bearer there is a stranger — told so as a
  // machine (401, JSON), where a browser would get the 200 card.
  const anonRoot = await call("/");
  assert.equal(anonRoot.status, 200, "a browser-shaped stranger gets the card");
  const bearerRoot = await call("/", { Authorization: "Bearer tok" });
  assert.equal(bearerRoot.status, 401);
  assert.equal(JSON.parse(bearerRoot.body).error, "sign-in-required");
  assert.doesNotMatch(bearerRoot.body, /flow/, "and nothing of the workspace's content");
});
