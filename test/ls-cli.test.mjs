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
