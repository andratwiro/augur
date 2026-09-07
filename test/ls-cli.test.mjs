// test/ls-cli.test.mjs — `augur ls` reads the live manifest and lists opportunities (or one
// opportunity's prototypes) from it, so an agent asked to "put it under Broad Listening"
// finds `broad-listening` instead of guessing or inventing a project.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { startUnitServer } from "./fixtures/unit-server.mjs";
import { manifestOf, remember } from "./fixtures/unit-env.mjs";
import { seedSource } from "../src/provenance.mjs";

// Async on purpose, like `openIn` in draft-cli.test.mjs: the fixture server this hits lives
// in THIS process, so a synchronous spawn would block the event loop the server needs to
// answer on — a self-deadlock, not a bug in the script under test.
const run = (script, args, cwd, env) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.resolve(`scripts/${script}`), ...args], { cwd, env: env || { ...process.env, AUGUR_ORIGIN: "", AUGUR_TOKEN: "" } });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  child.on("close", (status) => resolve({ status, stdout, stderr }));
});

test("ls lists opportunities, then one opportunity's prototypes, from the live manifest", async () => {
  const srv = await startUnitServer({
    live: manifestOf(2, {
      "/toolkit/cards/": { "index.html": remember("<h1>c</h1>") },
      "/toolkit/slider/": { "index.html": remember("<h1>s</h1>") },
      "/playground/riot/": { "index.html": remember("<h1>r</h1>") },
    }),
    tenantId: "cli-ls-1",
  });
  try {
    const env = { ...process.env, AUGUR_ORIGIN: srv.origin, AUGUR_TOKEN: "tok" };
    const a = await run("ls.mjs", [], os.tmpdir(), env);
    assert.equal(a.status, 0, a.stderr);
    assert.match(a.stdout, /^playground\s+1 prototype$/m);
    assert.match(a.stdout, /^toolkit\s+2 prototypes$/m);
    const b = await run("ls.mjs", ["toolkit"], os.tmpdir(), env);
    assert.equal(b.status, 0, b.stderr);
    assert.equal(b.stdout.trim().split("\n").sort().join(","), "toolkit/cards,toolkit/slider");
    const c = await run("ls.mjs", ["nope"], os.tmpdir(), env);
    assert.equal(c.status, 1);
    assert.match(c.stderr, /no opportunity "nope"/);
  } finally { await srv.close(); }
});

// ── the member's own welcome page is served, never listed — `augur ls` agrees with the
// gallery (`isWelcomeUnit`, src/galleries.mjs) so an agent asked to survey the workspace
// does not report a page nobody published as one of its prototypes.
test("ls does not list, or count, a unit stamped kind: welcome", async () => {
  const live = manifestOf(2, {
    "/toolkit/cards/": { "index.html": remember("<h1>c</h1>") },
    "/start-here/k3f9x2/": { "index.html": remember("<h1>w</h1>") },
  });
  live.routing.unitSources = { "/start-here/k3f9x2/": seedSource({ kind: "welcome", sha: null, dirty: false }) };
  const srv = await startUnitServer({ live, tenantId: "cli-ls-2" });
  try {
    const env = { ...process.env, AUGUR_ORIGIN: srv.origin, AUGUR_TOKEN: "tok" };
    const a = await run("ls.mjs", [], os.tmpdir(), env);
    assert.equal(a.status, 0, a.stderr);
    assert.match(a.stdout, /^toolkit\s+1 prototype$/m);
    assert.doesNotMatch(a.stdout, /start-here/, "the member's page is not one of the opportunities");
    const b = await run("ls.mjs", ["start-here"], os.tmpdir(), env);
    assert.equal(b.status, 1, "no opportunity is left once its only unit is filtered");
    assert.match(b.stderr, /no opportunity "start-here"/);
  } finally { await srv.close(); }
});
