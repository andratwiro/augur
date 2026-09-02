// A publish token minted under a person's previous address is still that person's.
//
// A roster entry's primary address can be swapped (the old one moves into `emails`, the
// attribution aliases). The holder re-check on every publish resolves a token's label
// against the roster — and it resolved primaries only, so the day somebody's address was
// swapped, every token they held answered "no longer a member". Same person, same
// roster, same role: the aliases are consulted for THIS check, and for nothing else.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

function memKV(init = {}) {
  const store = new Map(Object.entries(init));
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
  };
}
const ED = { email: "new@example.test", emails: ["old@example.test", "ed@laptop.local"], name: "Ed", role: "editor" };
const BOSS = { email: "boss@example.test", emails: ["was-boss@example.test"], name: "Boss", role: "admin" };
const ctx = () => Object.freeze({ ...W.applyInstance({ users: [ED, BOSS] }), SPACES: [{ id: "alpha", default: true }] });

async function mint(kv, label, space) {
  const raw = "tok-" + label + "-" + space;
  const map = JSON.parse((await kv.get("publish:tokens")) || "{}");
  map[await W.tokenFor("pub:" + raw)] = { space, label };
  await kv.put("publish:tokens", JSON.stringify(map));
  return raw;
}
async function verdict(c, env, token) {
  const url = new URL("https://x.test/__publish/alpha/check");
  const quiet = console.log; console.log = () => {};
  try {
    const res = await W.publishApi(c, new Request(url, { headers: { Authorization: "Bearer " + token } }), url, env);
    if (res.status !== 403) return "ok";
    const body = await res.json();
    return body.message || body.error;
  } finally { console.log = quiet; }
}

test("A TOKEN LABELLED WITH A PREVIOUS ADDRESS still publishes — same person, same role", async () => {
  const kv = memKV(); const env = { COMMENTS: kv, BUNDLES: {} };
  const t = await mint(kv, "old@example.test", "alpha");
  assert.equal(await verdict(ctx(), env, t), "ok");
});

test("the primary address works as it always did", async () => {
  const kv = memKV(); const env = { COMMENTS: kv, BUNDLES: {} };
  assert.equal(await verdict(ctx(), env, await mint(kv, "new@example.test", "alpha")), "ok");
});

test("an address on NOBODY's roster entry is still not a member", async () => {
  const kv = memKV(); const env = { COMMENTS: kv, BUNDLES: {} };
  assert.match(await verdict(ctx(), env, await mint(kv, "gone@example.test", "alpha")), /no longer a member/);
});

test("the role that comes with the alias is the person's role — an editor's old address is no admin", async () => {
  const kv = memKV(); const env = { COMMENTS: kv, BUNDLES: {} };
  // A star token under the editor's old address: the alias resolves to Ed, who is not an admin.
  assert.notEqual(await verdict(ctx(), env, await mint(kv, "old@example.test", "*")), "ok");
  // And the admin's old address keeps the admin's star scope.
  assert.equal(await verdict(ctx(), env, await mint(kv, "was-boss@example.test", "*")), "ok");
});

test("aliases are for the holder check only — sign-in still resolves the primary address", () => {
  assert.equal(W.userByEmail("old@example.test", [ED, BOSS]), null);
  assert.equal(W.userByAliasEmail("old@example.test", [ED, BOSS]), ED);
  assert.equal(W.userByAliasEmail("OLD@EXAMPLE.TEST", [ED, BOSS]), ED, "case-insensitive like every address here");
});
