// Guards the cwd-wins-for-its-own-id fix in publish.mjs — a real hazard a workspace
// layout turned up. `byId` (which resolves the tree a publish builds and ships) was
// built ONLY from clones sitting next to the engine. A space repo standing at cwd
// that is NOT a direct engine-sibling (a nested clone, a worktree, the
// collab-sandbox layout) never lands in that map — so when a DIFFERENT clone
// declaring the SAME space id sits next to the engine, `byId[thatId]` silently kept
// pointing at the SIBLING, and a publish/ship run from cwd would build and ship the
// sibling's tree instead: exit 0, a plausible live URL, no sign anything went wrong.
// The duplicate-checkout guard doesn't catch it either — it only inspects the
// sibling set, and the cwd clone was never part of that set.
//
// The engine's own stated contract is "running inside a space repo publishes THAT
// space" (see this file's header comment). This reproduces the collision and
// checks the CLI actually honors it for the thing that matters most: the CONTENT
// it builds and would ship — not just the source-dir bookkeeping (git sha, dirty
// flag) byId also feeds. A fix that only patched byId wouldn't be enough: build.js
// discovers space content by reading GV_SPACES_ROOT off disk itself, independent
// of byId, so this test would still catch the sibling's tree winning even if byId
// alone were "fixed."
//
// publish.mjs has no exports (it is a script, run for its side effects) — like
// test/publish-preflight.test.mjs, the only honest way to check this is to run the
// real CLI against a throwaway HTTP stand-in for the origin and read what it
// actually built.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLISH_MJS = path.join(ENGINE_ROOT, "scripts", "publish.mjs");

// A minimal stand-in for the worker's /__publish/* surface. liveVersion 0 takes the
// "live is empty" fast path, so the client never needs a live manifest or a real git
// ancestry to prove it's safe — it goes straight to building and checking. Every
// /check call is recorded: the LAST one carries the real built manifest, which is
// exactly what a real commit would have shipped, so reading it back is the same
// thing as asking "which tree did this publish actually resolve?".
function startMockOrigin() {
  const checks = [];
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const c of req) body += c;
      if (req.method === "POST" && /\/check$/.test(req.url)) {
        try { checks.push(JSON.parse(body || "{}")); } catch (e) { checks.push({}); }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ missing: [], liveVersion: 0, filesUnchanged: false, protocol: 3, livePrefixes: [] }));
        return;
      }
      if (req.method === "GET" && /\/profiles$/.test(req.url)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ profiles: [] }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not-implemented-in-mock" }));
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, checks }));
  });
}

// One space id, cloned twice with different content. `siblingDir` sits directly
// under GV_SPACES_ROOT — where the engine's own sibling discovery looks.
// `cwdDir` sits somewhere else entirely, matching the nested-clone/worktree shape
// the duplicate-checkout guard misses: nothing under GV_SPACES_ROOT ever names it.
function makeSpaceClone(dir, protoName, marker) {
  const protoDir = path.join(dir, "toolkit", "prototypes", protoName);
  mkdirSync(protoDir, { recursive: true });
  writeFileSync(path.join(dir, "space.json"), JSON.stringify({ id: "acme", name: "Acme", default: true }));
  writeFileSync(path.join(protoDir, "index.html"), `<!doctype html><html><body>${marker}</body></html>`);
}

function runPublishFrom(cwd, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PUBLISH_MJS, "--dry-run"], { cwd, env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("cwd wins its own space id over a same-id sibling next to the engine (dry-run, real CLI)", async () => {
  const work = mkdtempSync(path.join(tmpdir(), "augur-cwd-wins-test-"));
  const fakeHome = mkdtempSync(path.join(tmpdir(), "augur-cwd-wins-home-"));
  const siblingsRoot = path.join(work, "siblings");
  const siblingDir = path.join(siblingsRoot, "acme-sibling");
  // Deliberately NOT under siblingsRoot — the nested-clone/worktree shape.
  const cwdDir = path.join(work, "elsewhere", "acme-nested-clone");
  mkdirSync(siblingsRoot, { recursive: true });
  makeSpaceClone(siblingDir, "sib-proto", "SIBLING_MARKER_b17f");
  makeSpaceClone(cwdDir, "cwd-proto", "CWD_MARKER_9a42");

  const { server, checks } = await startMockOrigin();
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const { code, stderr } = await runPublishFrom(cwdDir, {
      PATH: process.env.PATH,
      HOME: fakeHome,
      AUGUR_ORIGIN: origin,
      AUGUR_TOKEN: "irrelevant-mock-accepts-anything",
      GV_SPACES_ROOT: siblingsRoot,
    });

    assert.equal(code, 0, `dry-run must succeed: ${stderr}`);
    assert.match(stderr, /cwd wins space "acme"/,
      "must say out loud that it overrode a same-id sibling");

    assert.equal(checks.length >= 2, true, "must have reached the real (post-build) /check call");
    const files = Object.keys(checks[checks.length - 1].files || {});
    assert.equal(files.some((f) => f.includes("cwd-proto")), true,
      "the resolved publish must contain CWD's prototype");
    assert.equal(files.some((f) => f.includes("sib-proto")), false,
      "the resolved publish must NOT contain the sibling's prototype — that would be the wrong tree");
  } finally {
    server.close();
    rmSync(work, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("no collision, no override — an ordinary sibling-only publish never mentions cwd override", async () => {
  // The common case must stay exactly as before: zero cost, zero behavior change,
  // when cwd IS the (only) clone for its id.
  const work = mkdtempSync(path.join(tmpdir(), "augur-cwd-wins-control-"));
  const fakeHome = mkdtempSync(path.join(tmpdir(), "augur-cwd-wins-control-home-"));
  const siblingsRoot = path.join(work, "siblings");
  const onlyDir = path.join(siblingsRoot, "acme-only");
  mkdirSync(siblingsRoot, { recursive: true });
  makeSpaceClone(onlyDir, "only-proto", "ONLY_MARKER_1234");

  const { server, checks } = await startMockOrigin();
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const { code, stderr } = await runPublishFrom(onlyDir, {
      PATH: process.env.PATH,
      HOME: fakeHome,
      AUGUR_ORIGIN: origin,
      AUGUR_TOKEN: "irrelevant-mock-accepts-anything",
      GV_SPACES_ROOT: siblingsRoot,
    });

    assert.equal(code, 0, `dry-run must succeed: ${stderr}`);
    assert.doesNotMatch(stderr, /cwd wins space/, "no collision means no override, no mirror copy");
    const files = Object.keys(checks[checks.length - 1].files || {});
    assert.equal(files.some((f) => f.includes("only-proto")), true);
  } finally {
    server.close();
    rmSync(work, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
