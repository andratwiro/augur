// Guards the credential pre-flight in publish.mjs — the fix for a real failure mode an
// adversarial agent test turned up: handed a prototype task with a broken publish
// credential, the CLI still ran the full build (a real, servable artifact on disk) before
// ever discovering the token was no good. An agent watching for "did it build" instead of
// "did it publish" can mistake that artifact for a completed hand-off and serve it locally
// (file:// / localhost) instead of reporting the loud, terminal failure it actually got.
// The same gap existed for an unreachable origin — a swallowed network error let the
// build through exactly the same way, which defeats the whole point for the most likely
// real case (genuinely offline).
//
// publish.mjs has no exports (it is a script, run for its side effects), so — unlike the
// source-extraction tests beside this one — the only honest way to check the ORDERING
// claim ("no build before credentials are proven good") is to actually run it and watch
// what it does: spawn the real CLI against a throwaway HTTP stand-in for the origin, with
// no space content involved (`--engine`), and read its stdout/stderr/exit code back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLISH_MJS = path.join(ENGINE_ROOT, "scripts", "publish.mjs");
const GOOD_TOKEN = "GOOD_TOKEN_FOR_TEST";

// A minimal stand-in for the worker's /__publish/* auth surface: valid Bearer token gets a
// real check response, anything else gets exactly what a revoked/expired/wrong token gets
// from the real worker (`publishAuth` in src/_worker.js returning null → 403 forbidden).
function startMockOrigin() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const token = (/^Bearer\s+(.+)$/.exec(req.headers["authorization"] || "") || [, ""])[1];
      for await (const _c of req) {} // drain the body
      if (req.method === "POST" && /\/check$/.test(req.url)) {
        if (token !== GOOD_TOKEN) {
          res.writeHead(403, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "forbidden" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ missing: [], liveVersion: 1, filesUnchanged: false, protocol: 3 }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not-implemented-in-mock" }));
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// A port nothing listens on, gotten the reliable way: bind it, then close it. A raw
// guess (or the well-known TEST-NET-1 unroutable range) risks either colliding with a
// real listener or hanging on an OS-level connect timeout — this fails fast (ECONNREFUSED)
// and deterministically, which is exactly the shape a real DNS/connection failure takes.
function unusedPort() {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// Runs the real CLI as a subprocess: a throwaway $HOME (no ~/.config/augur/tokens.json —
// makes an absent token miss exactly like it would for a new starter) and no inherited
// AUGUR_* env, so only what this call sets is in play.
function runPublish(extraEnv, args) {
  const fakeHome = mkdtempSync(path.join(tmpdir(), "augur-preflight-test-"));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PUBLISH_MJS, ...args], {
      cwd: ENGINE_ROOT,
      env: { PATH: process.env.PATH, HOME: fakeHome, ...extraEnv },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => {
      rmSync(fakeHome, { recursive: true, force: true });
      resolve({ code, stdout, stderr });
    });
  });
}

test("absent token: dies before build, with an actionable message (regression)", async () => {
  const { code, stderr } = await runPublish(
    { AUGUR_ORIGIN: "http://127.0.0.1:1" }, // unreachable — must never be dialed
    ["--engine"],
  );
  assert.equal(code, 1);
  assert.match(stderr, /no publish token/i);
  assert.match(stderr, /login/i, "must point at the fix, not just state the problem");
  assert.doesNotMatch(stderr, /building/i, "must not have started the build");
});

test("invalid/denied token: pre-flight rejects it before build ever runs", async () => {
  const server = await startMockOrigin();
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const { code, stderr } = await runPublish(
      { AUGUR_ORIGIN: origin, AUGUR_TOKEN: "some-invalid-or-revoked-token" },
      ["--engine"],
    );
    // The core assertion: a token that is PRESENT but WRONG must be caught before the
    // build runs — a bare "no publish token" check (string non-empty) is not enough,
    // because it is exactly the state a viewer-role or revoked-credential agent is in.
    assert.doesNotMatch(stderr, /building/i,
      "build must not run before the token is proven to actually work");
    assert.equal(code, 1, "must be a hard, nonzero failure");
    assert.match(stderr, /login|token/i, "must be actionable, not a bare stack trace or 403 dump");
  } finally {
    server.close();
  }
});

test("unreachable origin: dies before build too, and reads differently from an auth rejection", async () => {
  // This is the gap the token-only pre-flight left open: a network error was swallowed
  // and the build ran anyway, so an offline agent still got a local artifact to mistake
  // for a completed hand-off — the exact failure mode this whole check exists to close.
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const { code, stderr } = await runPublish(
    { AUGUR_ORIGIN: origin, AUGUR_TOKEN: "irrelevant-nothing-is-listening-to-check-it" },
    ["--engine"],
  );
  assert.equal(code, 1, "must be a hard, nonzero failure");
  assert.doesNotMatch(stderr, /building/i, "must not have started the build");
  assert.match(stderr, /can't reach|connection|network/i, "must name the real problem (unreachable), not a guess");
  assert.doesNotMatch(stderr, /rejected \(40[13]\)/,
    "must read differently from an auth rejection — there was no response to be rejected by");
});

test("valid token: pre-flight does not false-positive — the build still runs", async () => {
  const server = await startMockOrigin();
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const { stderr } = await runPublish(
      { AUGUR_ORIGIN: origin, AUGUR_TOKEN: GOOD_TOKEN },
      ["--engine"],
    );
    assert.match(stderr, /building/i, "a good token must not be blocked from reaching the build");
  } finally {
    server.close();
  }
});
