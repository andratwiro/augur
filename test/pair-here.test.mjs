// A verb that needs a token and finds none PAIRS THIS MACHINE ITSELF, and carries on.
//
// The person's part is one click — Approve, in a tab that opened on their own machine
// with the code already typed. The agent relays one sentence, not a command. "No publish
// token — run `augur connect`" is what the verb says only where pairing cannot happen here
// (CI, an explicit machine token, AUGUR_NO_PAIR=1, a workspace with pairing off).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { pairHere, tokenOrPair, ENGINE_ROOT } from "../scripts/lib/store.mjs";
import { startUnitServer } from "./fixtures/unit-server.mjs";
import { manifestOf, remember } from "./fixtures/unit-env.mjs";

/**
 * The pairing door in front of a unit fixture: `_pair/start` mints a code, `_pair/claim`
 * answers pending until the code is approved, `.well-known/augur.json` says pairing is on,
 * and everything else is proxied to the fixture — so `open` meets a whole workspace.
 * `approveOn` = "claim" approves the code the moment the CLI first asks, the way a person
 * pressing Approve in the tab does; "never" leaves it pending.
 */
async function pairedWorkspace({ token = "tok", approveOn = "claim", pairing = true, upstream = null } = {}) {
  const codes = new Map();
  let starts = 0, claims = 0;
  const srv = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const json = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url === "/.well-known/augur.json") return json(200, { product: "augur", pairing: { enabled: pairing }, drafts: { enabled: true } });
    if (req.url === "/__publish/_pair/start") {
      if (!pairing) return json(404, { error: "not-found" });
      starts++;
      const code = `CODE${String(starts).padStart(4, "0")}`;
      codes.set(code, { deviceSecret: `secret-${starts}`, approved: false });
      return json(200, { code, deviceSecret: `secret-${starts}`, approveUrl: `http://x/__connect`, expiresInMs: 300000 });
    }
    if (req.url === "/__publish/_pair/claim") {
      claims++;
      const { code, deviceSecret } = JSON.parse(body || "{}");
      const c = codes.get(code);
      if (!c || c.deviceSecret !== deviceSecret) return json(404, { error: "no-such-code" });
      if (approveOn === "claim") c.approved = true;
      if (!c.approved) return json(202, { status: "pending" });
      codes.delete(code);
      return json(200, { status: "approved", token, space: "alpha" });
    }
    if (!upstream) return json(404, { error: "not-found" });
    const r = await fetch(upstream + req.url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body });
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { origin: `http://127.0.0.1:${srv.address().port}`, get starts() { return starts; }, get claims() { return claims; }, close: () => new Promise((r) => srv.close(r)) };
}

const privateHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "augur-home-"));
const savedTokenIn = (home, origin) => { try { return JSON.parse(fs.readFileSync(path.join(home, ".config", "augur", "tokens.json"), "utf8"))[new URL(origin).host]; } catch (e) { return null; } };

async function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return await fn(); }
  finally { for (const k of Object.keys(vars)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
}

test("pairHere runs the pairing on this machine and hands back the token it saved", async () => {
  const ws = await pairedWorkspace();
  const home = privateHome();
  try {
    const token = await withEnv({ HOME: home, AUGUR_TOKEN: undefined, AUGUR_NO_PAIR: undefined, CI: undefined, AUGUR_NO_OPEN: "1" },
      () => pairHere(ws.origin, { why: "no publish token" }));
    assert.equal(token, "tok");
    assert.equal(ws.starts, 1, "one code minted");
    assert.equal(savedTokenIn(home, ws.origin).token, "tok", "saved where every verb reads it");
    assert.equal(savedTokenIn(home, ws.origin).via, "connect");
  } finally { await ws.close(); }
});

test("it stays out of the way for CI, a machine token, AUGUR_NO_PAIR, and a workspace with pairing off", async () => {
  const ws = await pairedWorkspace();
  const off = await pairedWorkspace({ pairing: false });
  const home = privateHome();
  try {
    for (const vars of [{ CI: "1" }, { AUGUR_TOKEN: "machine" }, { AUGUR_NO_PAIR: "1" }]) {
      const t = await withEnv({ HOME: home, AUGUR_TOKEN: undefined, AUGUR_NO_PAIR: undefined, CI: undefined, ...vars }, () => pairHere(ws.origin));
      assert.equal(t, "", `no pairing under ${JSON.stringify(vars)}`);
    }
    assert.equal(ws.starts, 0, "and no code was minted for any of them");
    const t = await withEnv({ HOME: home, AUGUR_TOKEN: undefined, AUGUR_NO_PAIR: undefined, CI: undefined }, () => pairHere(off.origin));
    assert.equal(t, "", "a workspace that does not offer pairing");
    // and then the verb's refusal is the instruction, naming the workspace
    await withEnv({ HOME: home, AUGUR_TOKEN: undefined, AUGUR_NO_PAIR: "1" }, async () => {
      await assert.rejects(() => tokenOrPair(ws.origin), (e) => /connect --origin http:\/\/127\.0\.0\.1/.test(e.message) && /member you are working with/.test(e.message));
    });
  } finally { await ws.close(); await off.close(); }
});

// Async on purpose: the CLI talks to servers living in THIS process.
const run = (args, cwd, env) => new Promise((resolve) => {
  const child = spawn(process.execPath, args, { cwd, env });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => { stdout += d; }); child.stderr.on("data", (d) => { stderr += d; });
  child.on("close", (status) => resolve({ status, stdout, stderr }));
});

test("`augur open` on an unpaired machine pairs it and opens the draft — the person pressed Approve, nothing else", async () => {
  const U = "/checkout/flow/";
  const unit = await startUnitServer({ live: manifestOf(5, { [U]: { "index.html": remember("<h1>flow</h1>") } }), tenantId: "cli-pair-open" });
  const ws = await pairedWorkspace({ upstream: unit.origin });
  const home = privateHome();
  try {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "augur-work-"));
    fs.writeFileSync(path.join(work, "space.json"), JSON.stringify({ id: "alpha" }));
    const env = { ...process.env, HOME: home, AUGUR_ORIGIN: ws.origin, AUGUR_NO_OPEN: "1", AUGUR_NO_ADAPTERS: "1", AUGUR_NO_POSTER: "1",
      AUGUR_DRAFTS_REGISTRY: path.join(home, "drafts.json") };
    delete env.AUGUR_TOKEN; delete env.AUGUR_NO_PAIR; delete env.CI;
    const r = await run([path.join(ENGINE_ROOT, "scripts", "open.mjs"), "checkout/flow", "--dir", "flow"], work, env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /pairing this machine now/, "said what it was doing");
    assert.match(r.stderr, /the workspace member presses Approve/, "and what the person's part is");
    assert.match(r.stdout, /Waiting for Approve in that tab/, "the inline wait, not the standalone agent lecture");
    assert.doesNotMatch(r.stdout, /AGENTS: if your person reads your messages only after you finish/);
    assert.match(r.stdout.trim().split("\n").pop(), /^http:\/\/127\.0\.0\.1:\d+\/checkout\/flow\/@/, "then the draft's address, last, as always");
    assert.ok(fs.existsSync(path.join(work, "flow", "index.html")), "and the folder is there");
    assert.equal(savedTokenIn(home, ws.origin).token, "tok");
    assert.equal(ws.starts, 1);
  } finally { await ws.close(); await unit.close(); }
});
