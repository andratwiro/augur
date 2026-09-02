// A publish token follows a hostname move, and a dead one pairs itself back to life.
//
// Two refusals used to end with an instruction for a person — "run `augur login
// --origin <new host>`" after a workspace moved, and "run `augur login` again" when a
// token expired. Both are things the CLI can do on its own: the old host's redirect
// PROVES the move (same instance, new address), and device pairing mints a token from a
// browser the person is already signed in to. Neither is a question worth asking.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLISH = path.join(ROOT, "scripts", "publish.mjs");

const run = (argv, env) => new Promise((resolve) => {
  execFile(process.execPath, [PUBLISH, ...argv], { cwd: ROOT, env: { ...process.env, AUGUR_NO_SELF_UPDATE: "1", ...env } },
    (err, stdout, stderr) => resolve({ code: err ? err.code || 1 : 0, out: `${stdout}${stderr}` }));
});

const serve = async (handler) => {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, origin: `http://127.0.0.1:${server.address().port}`, host: `127.0.0.1:${server.address().port}` };
};
const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const home = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "augur-home-"));
  fs.mkdirSync(path.join(dir, ".config", "augur"), { recursive: true });
  return dir;
};
const tokensOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, ".config", "augur", "tokens.json"), "utf8"));

test("A TOKEN FOLLOWS THE MOVE when the old host redirects to the new one", async () => {
  const seen = [];
  const next = await serve((req, res) => {
    if (req.url.startsWith("/__publish/") && req.url.endsWith("/check")) {
      seen.push(req.headers.authorization);
      return json(res, 403, { error: "forbidden", message: "stop here, the test has what it needs" });
    }
    json(res, 404, {});
  });
  const old = await serve((req, res) => {
    res.writeHead(302, { location: `${next.origin}${req.url}` });
    res.end();
  });
  const dir = home();
  fs.writeFileSync(path.join(dir, ".config", "augur", "tokens.json"),
    JSON.stringify({ [old.host]: { token: "carried", space: "*", email: "who@example.test" } }));
  try {
    const r = await run(["--engine", "--dry-run"], { HOME: dir, AUGUR_ORIGIN: next.origin, AUGUR_TOKEN: "", AUGUR_NO_PAIR: "1" });
    assert.match(r.out, /now redirects to .* the publish token followed the move/, r.out);
    assert.ok(!/no publish token for/.test(r.out), `still refused as if no token:\n${r.out}`);
    assert.deepEqual(seen, ["Bearer carried"], "the carried token was not what reached the new host");
    const saved = tokensOf(dir);
    assert.equal(saved[next.host].token, "carried", "the alias was not persisted for next time");
    assert.equal(saved[next.host].movedFrom, old.host);
    assert.equal(saved[old.host].token, "carried", "the old entry must survive — a rollback would need it");
  } finally { next.server.close(); old.server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a host that does NOT redirect proves nothing — its token is never sent elsewhere", async () => {
  const sent = [];
  const next = await serve((req, res) => { sent.push(req.url); json(res, 403, { error: "forbidden" }); });
  const unrelated = await serve((_req, res) => json(res, 200, { builtAt: "x", spaces: {} }));
  const dir = home();
  fs.writeFileSync(path.join(dir, ".config", "augur", "tokens.json"),
    JSON.stringify({ [unrelated.host]: { token: "theirs", space: "*" } }));
  try {
    const r = await run(["--engine", "--dry-run"], { HOME: dir, AUGUR_ORIGIN: next.origin, AUGUR_TOKEN: "", AUGUR_NO_PAIR: "1" });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /no publish token for 127\.0\.0\.1/);
    assert.match(r.out, /if this workspace moved, that is why/);
    assert.ok(!sent.some((u) => u.endsWith("/check")), "a credential for another host was tried here");
  } finally { next.server.close(); unrelated.server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

/** An instance with pairing on: start hands out a code, claim approves at once. */
async function pairingInstance() {
  const log = [];
  const inst = await serve((req, res) => {
    log.push(req.url);
    if (req.url === "/__publish/_pair/start") {
      return json(res, 200, { code: "ABCD1234", deviceSecret: "s", approveUrl: `${inst.origin}/__connect`, expiresInMs: 60000 });
    }
    if (req.url === "/__publish/_pair/claim") return json(res, 200, { status: "approved", token: "fresh", space: "*" });
    if (req.url.endsWith("/check")) {
      if (req.headers.authorization === "Bearer fresh") return json(res, 403, { error: "forbidden", message: "the FRESH token reached the check" });
      return json(res, 403, { error: "token-expired", message: "This publish token has expired." });
    }
    json(res, 404, {});
  });
  inst.log = log;
  return inst;
}

test("AN EXPIRED TOKEN PAIRS ITSELF BACK, inside the publish, and the publish carries on", async () => {
  const inst = await pairingInstance();
  const dir = home();
  fs.writeFileSync(path.join(dir, ".config", "augur", "tokens.json"), JSON.stringify({ [inst.host]: { token: "stale", space: "*" } }));
  try {
    const r = await run(["--engine", "--dry-run"], { HOME: dir, AUGUR_ORIGIN: inst.origin, AUGUR_TOKEN: "" });
    assert.match(r.out, /EXPIRED — pairing this machine with a browser/, r.out);
    assert.match(r.out, /ABCD-1234/, "the code a person types was not shown");
    assert.match(r.out, /the FRESH token reached the check/, "the publish did not retry with the new token");
    assert.ok(!/Run `augur login`/.test(r.out), `a person was still told to log in:\n${r.out}`);
    assert.equal(tokensOf(dir)[inst.host].token, "fresh");
    assert.equal(tokensOf(dir)[inst.host].via, "connect");
  } finally { inst.server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("NO TOKEN AT ALL pairs too — a first publish never starts with a login lesson", async () => {
  const inst = await pairingInstance();
  const dir = home();
  try {
    const r = await run(["--engine", "--dry-run"], { HOME: dir, AUGUR_ORIGIN: inst.origin, AUGUR_TOKEN: "" });
    assert.match(r.out, /no publish token for .* — pairing this machine/, r.out);
    assert.match(r.out, /the FRESH token reached the check/);
    assert.ok(!/Run `augur login` once/.test(r.out), r.out);
  } finally { inst.server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a MACHINE token is never paired for — CI gets the sentence, not a code to type", async () => {
  const inst = await pairingInstance();
  const dir = home();
  try {
    const r = await run(["--engine", "--dry-run"], { HOME: dir, AUGUR_ORIGIN: inst.origin, AUGUR_TOKEN: "stale" });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /EXPIRED/);
    assert.ok(!/pairing this machine/.test(r.out), r.out);
    assert.ok(!inst.log.includes("/__publish/_pair/start"), "a pairing was started for a machine token");
  } finally { inst.server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("an instance without pairing keeps the old, useful refusal", async () => {
  const inst = await serve((req, res) => {
    if (req.url.startsWith("/__publish/_pair/")) return json(res, 403, { error: "forbidden" });
    json(res, 403, { error: "token-expired", message: "expired" });
  });
  const dir = home();
  fs.writeFileSync(path.join(dir, ".config", "augur", "tokens.json"), JSON.stringify({ [inst.host]: { token: "stale", space: "*" } }));
  try {
    const r = await run(["--engine", "--dry-run"], { HOME: dir, AUGUR_ORIGIN: inst.origin, AUGUR_TOKEN: "" });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /EXPIRED/);
    assert.match(r.out, /augur login/);
    assert.ok(!/pairing this machine/.test(r.out), r.out);
  } finally { inst.server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
