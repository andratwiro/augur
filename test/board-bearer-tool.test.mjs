// E-28, second cut. The canvas tools are terminals: they hold a pairing, never a cookie.
// Once a gated canvas keeps its board behind the gate, a tool has to be able to say whose
// it is, so `/__board` and `/__rt` read `Authorization: Bearer <publish token>` as the
// member the token names — the same resolve a draft address uses, and nothing wider: a
// machine token, a wrong token and no token are all still strangers, and the same header
// opens no comments. Fixture as in draft-bearer-view.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/_worker.js";
import { __testables as W } from "../src/_worker.js";
import { makeEnv, manifestOf, remember, ADA_MEMBER } from "./fixtures/unit-env.mjs";

let n = 0;
const U = "/checkout/flow/"; // published, and public to nobody
const INDEX = remember("<h1>flow</h1>");
const DOC = JSON.stringify({ doc: { name: "By the tool", nodes: [], tombs: {}, clock: 1 } });

async function workspace() {
  const t = `board-bearer-${++n}`;
  // The fixture publishes every unit as public; this one is the gated kind.
  const live = manifestOf(3, { [U]: { "index.html": INDEX } });
  live.routing.publicPrefixes = [];
  const env = await makeEnv({ live });
  await env.BUNDLES.put("config/instance.json", JSON.stringify({ users: [ADA_MEMBER], tenantId: t, devicePairing: true }));
  const tokens = JSON.parse(await env.COMMENTS.get("publish:tokens"));
  tokens[await W.tokenFor("pub:machine")] = { space: "alpha", label: "ci" };
  await env.COMMENTS.put("publish:tokens", JSON.stringify(tokens));
  W.__setTenantTestState({ memo: { at: Date.now(), tenantId: t } });
  W.__setConfigTestState({ cfgAt: 0, cfgGoodAt: 0 });
  return async (path, headers = {}, method = "GET", body) => {
    const orig = console.log; console.log = () => {};
    try {
      const res = await worker.fetch(new Request(`https://x.test${path}`, { method, headers, body }), env, {});
      return { status: res.status, body: await res.text() };
    } finally { console.log = orig; }
  };
}

const board = `/__board?path=${encodeURIComponent(U)}`;
const TOK = { Authorization: "Bearer tok" };

test("a paired terminal's token reads and writes a gated board; no token, a wrong one and a machine token do not", async () => {
  const call = await workspace();

  assert.equal((await call(board)).status, 401, "signed out");
  assert.equal((await call(board, {}, "POST", DOC)).status, 401, "signed out, write");
  assert.equal((await call(board, { Authorization: "Bearer nope" })).status, 401, "a token nobody issued");
  assert.equal((await call(board, { Authorization: "Bearer machine" })).status, 401, "a machine token names no member");
  assert.equal((await call(board, { Authorization: "Bearer machine" }, "POST", DOC)).status, 401);

  const wrote = await call(board, { ...TOK, "content-type": "application/json" }, "POST", DOC);
  assert.equal(wrote.status, 200, wrote.body);
  const read = await call(board, TOK);
  assert.equal(read.status, 200);
  assert.equal(JSON.parse(read.body).doc.name, "By the tool");
  assert.equal((await call(board)).status, 401, "and it is still closed to a stranger afterwards");
});

test("the token passes the room gate on /__rt, and a stranger does not", async () => {
  const call = await workspace();
  const room = `/__rt?path=${encodeURIComponent(U)}`;
  assert.equal((await call(room, { Upgrade: "websocket" })).status, 401);
  assert.equal((await call(room, { Upgrade: "websocket", Authorization: "Bearer nope" })).status, 401);
  const past = await call(room, { Upgrade: "websocket", ...TOK });
  assert.notEqual(past.status, 401, past.body); // whatever this env's rooms answer, it is not the gate
});

test("the same header opens nothing else: comments on a gated page stay closed to it, and so does /__me", async () => {
  const call = await workspace();
  assert.equal((await call(`/__review/api?path=${encodeURIComponent(U)}`, TOK)).status, 401);
  const me = await call("/__me", TOK);
  assert.doesNotMatch(me.body, /ada@example\.test/);
});
