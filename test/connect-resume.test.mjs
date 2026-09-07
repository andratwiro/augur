// test/connect-resume.test.mjs — `augur connect` can stop waiting and come back.
//
// Found live, on a cold machine: an agent that talks to its person through messages ran
// `connect`, relayed the line, and then had to wait inside the same turn — five minutes,
// the code's whole life — because the person could not see the line until the command
// ended, and the command did not end until the person acted. So a pairing this machine
// started is kept, `--no-wait` prints the line and exits, and `connect` run again claims
// that same code instead of minting a second one.
//
// The second half of the same problem is here too: a code that has to be READ OUT to an
// assistant and relayed back is a code an assistant is right to refuse (7 Sep 2026, a live
// invited run — it named that exact shape and ran nothing). So a waiting `connect` opens
// the approval page itself with the code already in it. ⚠️ EVERY env in this file sets
// `AUGUR_NO_OPEN=1`: without it a test run takes over the screen of whoever ran it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";

const CONNECT = path.resolve("scripts/connect.mjs");

/** The two pairing routes, as small as the CLI needs them, with an `approve()` the test flips. */
function pairServer() {
  const codes = new Map();
  const revoked = new Set();
  let starts = 0;
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      const json = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.url === "/__publish/_pair/start") {
        starts++;
        const code = `CODE${String(starts).padStart(4, "0")}`;
        codes.set(code, { deviceSecret: `secret-${starts}`, approved: false });
        return json(200, { code, deviceSecret: `secret-${starts}`, approveUrl: `http://x/__connect`, expiresInMs: 300000 });
      }
      if (req.url === "/__unit/drafts") {
        // What a connected machine can read: 200 with the right token, 401 without.
        const auth = req.headers.authorization || "";
        const ok = [...codes.keys()].length === 0 || true;
        return json(/^Bearer tok-CODE\d+$/.test(auth) && !revoked.has(auth.slice(7)) ? 200 : 401, ok ? { drafts: [] } : {});
      }
      if (req.url === "/__publish/_pair/claim") {
        const { code, deviceSecret } = JSON.parse(body || "{}");
        const c = codes.get(code);
        if (!c || c.deviceSecret !== deviceSecret) return json(404, { error: "no-such-code" });
        if (!c.approved) return json(202, { status: "pending" });
        codes.delete(code);
        return json(200, { status: "approved", token: `tok-${code}`, space: "alpha" });
      }
      json(404, { error: "not-found" });
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({
    origin: `http://127.0.0.1:${srv.address().port}`,
    approve: (code) => { codes.get(code).approved = true; },
    revoke: (token) => { revoked.add(token); },
    get starts() { return starts; },
    close: () => new Promise((r) => srv.close(r)),
  })));
}

const run = (args, env) => new Promise((resolve) => {
  const p = spawn(process.execPath, [CONNECT, ...args], { env });
  let out = "", err = "";
  p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { err += d; });
  p.on("close", (code) => resolve({ code, out, err }));
});

test("--no-wait prints the line and exits; connect again collects the token for the SAME code", async () => {
  const srv = await pairServer();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "augur-connect-"));
  const env = { ...process.env, HOME: home, AUGUR_ORIGIN: srv.origin, AUGUR_NO_OPEN: "1" };
  delete env.AUGUR_TOKEN;
  try {
    const first = await run(["--no-wait"], env);
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /open .*__connect.* and enter .*CODE-0001/, "the line to relay, with the code");
    assert.match(first.out, /Not waiting/);
    assert.equal(fs.existsSync(path.join(home, ".config", "augur", "tokens.json")), false, "no token yet");
    const pending = JSON.parse(fs.readFileSync(path.join(home, ".config", "augur", "pairing.json"), "utf8"));
    assert.equal(pending[new URL(srv.origin).host].code, "CODE0001", "the pairing is kept on this machine");

    // Run again before the approval: the same code is shown, not a new one; still no wait.
    const again = await run(["--no-wait"], env);
    assert.equal(again.code, 0, again.err);
    assert.match(again.out, /CODE-0001/, "the same code");
    assert.equal(srv.starts, 1, "no second code was minted");

    // The person approves. Connect again collects the token.
    srv.approve("CODE0001");
    const third = await run(["--no-wait"], env);
    assert.equal(third.code, 0, third.err);
    assert.match(third.err + third.out, /paired/);
    const tokens = JSON.parse(fs.readFileSync(path.join(home, ".config", "augur", "tokens.json"), "utf8"));
    assert.equal(tokens[new URL(srv.origin).host].token, "tok-CODE0001");
    assert.equal(srv.starts, 1, "still one code, ever");
    const after = JSON.parse(fs.readFileSync(path.join(home, ".config", "augur", "pairing.json"), "utf8"));
    assert.equal(after[new URL(srv.origin).host], undefined, "the pending pairing is forgotten once collected");
  } finally { await srv.close(); }
});

test("a pairing the server no longer knows is dropped and a new code is minted", async () => {
  const srv = await pairServer();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "augur-connect-"));
  const env = { ...process.env, HOME: home, AUGUR_ORIGIN: srv.origin, AUGUR_NO_OPEN: "1" };
  delete env.AUGUR_TOKEN;
  try {
    fs.mkdirSync(path.join(home, ".config", "augur"), { recursive: true });
    fs.writeFileSync(path.join(home, ".config", "augur", "pairing.json"), JSON.stringify({
      [new URL(srv.origin).host]: { code: "GONE0000", deviceSecret: "x", approveUrl: "http://x/__connect", startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() },
    }));
    const r = await run(["--no-wait"], env);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /CODE-0001/, "a fresh code");
    assert.equal(srv.starts, 1);
  } finally { await srv.close(); }
});

test("the waiting form says it can be interrupted and resumed", async () => {
  const srv = await pairServer();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "augur-connect-"));
  const env = { ...process.env, HOME: home, AUGUR_ORIGIN: srv.origin, AUGUR_NO_OPEN: "1" };
  delete env.AUGUR_TOKEN;
  try {
    const p = spawn(process.execPath, [CONNECT], { env });
    let out = "";
    await new Promise((resolve) => { p.stdout.on("data", (d) => { out += d; if (/--no-wait/.test(out)) resolve(); }); });
    p.kill("SIGINT");
    await new Promise((r) => p.on("close", r));
    assert.match(out, /stop waiting \(Ctrl-C\)/, "says it can be stopped");
    assert.match(out, /AGENTS: .*do not wait here/, "tells an agent, in the second person, not to wait");
    assert.match(out, /--no-wait/, "names the flag for message-relayed agents");
    const pending = JSON.parse(fs.readFileSync(path.join(home, ".config", "augur", "pairing.json"), "utf8"));
    assert.ok(pending[new URL(srv.origin).host], "the pairing survives the interrupt");
  } finally { await srv.close(); }
});

test("A MACHINE THAT IS ALREADY CONNECTED DOES NOT PAIR AGAIN BY ACCIDENT — --again does, and a dead token does", async () => {
  const srv = await pairServer();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "augur-connect-"));
  const env = { ...process.env, HOME: home, AUGUR_ORIGIN: srv.origin, AUGUR_NO_OPEN: "1" };
  delete env.AUGUR_TOKEN;
  try {
    const first = await run(["--no-wait"], env);
    assert.equal(first.code, 0, first.err);
    srv.approve("CODE0001");
    const collected = await run(["--no-wait"], env);
    assert.match(collected.err + collected.out, /paired/);
    assert.equal(srv.starts, 1);

    // The agent runs connect again without reading the answer: no new code, a plain sentence.
    const again = await run([], env);
    assert.equal(again.code, 0, again.err);
    assert.match(again.out, /already connected to .*127\.0\.0\.1:\d+/);
    assert.match(again.out, /Nothing to approve/);
    assert.match(again.out, /augur connect --again/);
    assert.equal(srv.starts, 1, "no second code was minted");

    // On purpose: --again pairs afresh.
    const fresh = await run(["--no-wait", "--again"], env);
    assert.equal(fresh.code, 0, fresh.err);
    assert.match(fresh.out, /CODE-0002/);
    assert.equal(srv.starts, 2);

    // A token the workspace no longer honours falls through to a new pairing without being asked.
    srv.revoke("tok-CODE0001");
    const dead = await run(["--no-wait"], env);
    assert.equal(dead.code, 0, dead.err);
    assert.match(dead.out, /CODE-000[23]/, "a code is shown, not 'already connected'");
  } finally { await srv.close(); }
});

test("a waiting connect opens the approval page with the code in it — and --no-open does not", async () => {
  // The opener is faked on PATH rather than mocked in the module, because what is being
  // pinned is that a real `spawn` of the platform's opener happens with the right URL. The
  // marker file is what a browser would have been.
  const srv = await pairServer();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "augur-opener-"));
  const marker = path.join(bin, "opened.txt");
  for (const name of ["open", "xdg-open", "start"]) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nprintf '%s\\n' "$1" >> ${JSON.stringify(marker)}\n`, { mode: 0o755 });
  }
  // Wait for a code, then stop: the point is what happened by the time the line is printed.
  const untilPrinted = (args, env) => new Promise((resolve) => {
    const p = spawn(process.execPath, [CONNECT, ...args], { env });
    let out = "";
    p.stdout.on("data", (d) => { out += d; if (/AGENTS: /.test(out)) { p.kill("SIGINT"); } });
    p.on("close", () => resolve(out));
  });
  const settle = async () => {
    for (let i = 0; i < 40; i++) {
      if (fs.existsSync(marker)) return fs.readFileSync(marker, "utf8");
      await new Promise((r) => setTimeout(r, 50));
    }
    return "";
  };
  try {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "augur-connect-"));
    const env = { ...process.env, HOME: home, AUGUR_ORIGIN: srv.origin, PATH: `${bin}:${process.env.PATH}` };
    delete env.AUGUR_TOKEN; delete env.AUGUR_NO_OPEN;
    const out = await untilPrinted([], env);
    assert.match(out, /A browser tab with the code filled in/, "and it says a tab should have opened");
    assert.match(out, /if it\n?\s*did not, send the line above/, "with the printed line as the fallback");
    const opened = await settle();
    assert.match(opened, new RegExp(`^${srv.origin.replace(/[.]/g, "\\.")}/__welcome\\?code=CODE0001$`, "m"),
      "the approval page, carrying the code");

    // --no-open: same pairing, same printed line, no opener touched.
    fs.rmSync(marker, { force: true });
    const home2 = fs.mkdtempSync(path.join(os.tmpdir(), "augur-connect-"));
    const env2 = { ...env, HOME: home2 };
    const out2 = await untilPrinted(["--no-open"], env2);
    assert.match(out2, /CODE-0002/, "the flag is accepted and the pairing still happens");
    assert.doesNotMatch(out2, /A browser tab/, "and nothing claims a tab opened");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(fs.existsSync(marker), false, "no opener was run");

    // AUGUR_NO_OPEN=1 is the same switch, for a script or a suite that cannot pass a flag.
    const home3 = fs.mkdtempSync(path.join(os.tmpdir(), "augur-connect-"));
    const out3 = await untilPrinted([], { ...env, HOME: home3, AUGUR_NO_OPEN: "1" });
    assert.match(out3, /CODE-0003/);
    assert.doesNotMatch(out3, /A browser tab/);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(fs.existsSync(marker), false, "no opener was run");
  } finally { await srv.close(); }
});
