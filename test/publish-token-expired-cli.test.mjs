// An expired publish token says so, in both directions.
//
// `B-cli-token-refresh`. Publish tokens now run out (30 days by default), which makes
// expiry the one refusal every holder will certainly hit — and the only one with a fix
// they can run themselves in five seconds. Answering it with `403 forbidden` sends a
// person looking for a permissions problem they do not have.
//
// So there are two halves and both are tested here: the worker has to be able to SAY
// "expired" without becoming an oracle, and the CLI has to print the fix rather than the
// status code.
//
// WHAT IS DELIBERATELY NOT BUILT: the item's stretch goal of auto-retrying through
// login.mjs when AUGUR_EMAIL and AUGUR_PASSWORD happen to be in the environment. Reading a
// password out of the environment to re-authenticate silently is the exact pattern
// `augur connect` exists to remove, and an expiry that repairs itself invisibly is an
// expiry that teaches nobody anything. One clear sentence is the better answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { __testables as W } from "../src/_worker.js";

const ENGINE = fileURLToPath(new URL("..", import.meta.url));

function memKV(init = {}) {
  const store = new Map(Object.entries(init));
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
  };
}

const ADMIN = { email: "boss@example.test", name: "Boss", role: "admin" };
const EDITOR = { email: "ed@example.test", name: "Ed", role: "editor" };
const VIEWER = { email: "look@example.test", name: "Look", role: "viewer" };
const ctx = () => Object.freeze({
  ...W.applyInstance({ users: [ADMIN, EDITOR, VIEWER] }),
  SPACES: [{ id: "alpha", default: true }],
});

const bearer = (t) => new Request("https://x.test/__publish/alpha/check", { headers: { Authorization: "Bearer " + t } });

// ── the worker half ──────────────────────────────────────────────────────────

test("THE API ANSWERS token-expired, with the fix in the message", async () => {
  const kv = memKV();
  const env = { COMMENTS: kv, BUNDLES: {} };
  const c = ctx();
  const minted = await W.mintPublishToken(kv, c, EDITOR);
  const map = JSON.parse(kv.store.get("publish:tokens"));
  for (const h in map) map[h].expiresAt = new Date(Date.now() - 1000).toISOString();
  kv.store.set("publish:tokens", JSON.stringify(map));

  const url = new URL("https://x.test/__publish/alpha/check");
  const res = await W.publishApi(c, bearer(minted.token), url, env);
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, "token-expired");
  assert.match(body.message, /augur login/);
});

test("A TOKEN NOBODY MINTED LEARNS NOTHING — the reason is not an oracle", async () => {
  // The only way to be told "expired" is to hold a token that IS in the map, which means
  // holding it. A stranger guessing gets the same bare `forbidden` they always got.
  const kv = memKV();
  const env = { COMMENTS: kv, BUNDLES: {} };
  const c = ctx();
  await W.mintPublishToken(kv, c, EDITOR);
  const url = new URL("https://x.test/__publish/alpha/check");
  const res = await W.publishApi(c, bearer("no-such-token"), url, env);
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "forbidden" }, "a guessed token was told something");
});

test("the other refusals keep the error code they had, and gain a sentence", async () => {
  // `error` stays `forbidden` for everything but expiry, so nothing that already branches
  // on the code has to change. `message` is the addition.
  assert.deepEqual(W.publishRefusalBody("token-expired").error, "token-expired");
  for (const [reason, re] of [
    ["not-a-member", /no longer a member/],
    ["viewer-role", /look around/],
    ["not-an-admin", /no longer one/],
  ]) {
    const b = W.publishRefusalBody(reason);
    assert.equal(b.error, "forbidden", reason);
    assert.match(b.message, re, reason);
  }
  assert.deepEqual(W.publishRefusalBody("unknown-token"), { error: "forbidden" });
  assert.deepEqual(W.publishRefusalBody("no-token"), { error: "forbidden" });
  assert.deepEqual(W.publishRefusalBody(undefined), { error: "forbidden" });
});

test("every refusal the resolver can produce has a body, and every good token has none", async () => {
  // A reason the body function has never heard of would fall through to a bare `forbidden`
  // — which is safe, and silently loses the one message worth printing. Enumerate instead.
  const kv = memKV();
  const c = ctx();
  const env = { COMMENTS: kv };
  const good = await W.mintPublishToken(kv, c, ADMIN);
  const seen = new Set();
  const at = async (token, spaceId = "alpha") =>
    (await W.publishAuthDetailed(c, bearer(token), env, spaceId)).refusal;

  seen.add(await at("nope"));                                   // unknown-token
  seen.add((await W.publishAuthDetailed(c, new Request("https://x.test/"), env, "alpha")).refusal); // no-token
  assert.equal(await at(good.token, "alpha"), null, "an admin's star token was refused");

  const scoped = await W.mintPublishToken(kv, c, EDITOR);
  seen.add(await at(scoped.token, "beta"));                     // wrong-space
  assert.deepEqual([...seen].sort(), ["no-token", "unknown-token", "wrong-space"]);
  for (const r of seen) assert.ok(W.publishRefusalBody(r).error, `${r} produced no body`);
});

// ── the CLI half ─────────────────────────────────────────────────────────────

test("PUBLISH PRINTS THE FIX, not the status code", async () => {
  // The VERIFY, driven for real: a stub instance answers the refusal the worker above
  // produces, and `publish.mjs` runs against it exactly as `augur ship` would.
  //
  // execFile ASYNC, never execFileSync — a sync child blocks this event loop, so the stub
  // server in this same process could never answer and the probe would hang until timeout.
  const server = http.createServer((_req, res) => {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify(W.publishRefusalBody("token-expired")));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const out = await new Promise((resolve) => {
      execFile(process.execPath, ["scripts/publish.mjs", "--engine", "--dry-run"], {
        cwd: ENGINE,
        env: { ...process.env, AUGUR_ORIGIN: `http://127.0.0.1:${port}`, AUGUR_TOKEN: "fake" },
      }, (err, stdout, stderr) => resolve(`${stdout}${stderr}`));
    });
    assert.match(out, /EXPIRED/, `the refusal did not name expiry:\n${out}`);
    assert.match(out, /augur login/, "the message does not name the fix");
    assert.ok(!/\b403\b/.test(out), `the raw status code was printed instead of the fix:\n${out}`);
  } finally { server.close(); }
});

test("a refusal with no reason still prints the old, useful message", async () => {
  // An instance running an older engine answers a bare `forbidden`. That path predates
  // this work and has to keep working, or taking this CLI would make older instances
  // harder to diagnose rather than easier.
  const server = http.createServer((_req, res) => {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "forbidden" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const out = await new Promise((resolve) => {
      execFile(process.execPath, ["scripts/publish.mjs", "--engine", "--dry-run"], {
        cwd: ENGINE,
        env: { ...process.env, AUGUR_ORIGIN: `http://127.0.0.1:${port}`, AUGUR_TOKEN: "fake" },
      }, (err, stdout, stderr) => resolve(`${stdout}${stderr}`));
    });
    assert.match(out, /publish token rejected/);
    assert.match(out, /augur login/);
  } finally { server.close(); }
});
