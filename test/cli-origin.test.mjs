// test/cli-origin.test.mjs — what every verb's argv has in common (scripts/lib/cli-args.mjs):
// `--origin <url>` is honoured by every verb and never mistaken for a positional, a shell
// whose folder is gone gets one sentence, and `close` takes the folder to remove.
//
// Measured 9 Sep 2026 on a cold machine: an agent paired with `connect --origin X`, then
// typed `ls --origin X` and was told `no opportunity "https://…" here` — the router handed
// the flag to `ls`, whose positional scan took the URL for a name, while the origin fell
// back to the last pairing. Then `close --discard` inside the draft folder left the shell
// standing in a deleted directory, and the next verb died with `uv_cwd` and a stack.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { takeOrigin, cwdGone } from "../scripts/lib/cli-args.mjs";
import { startUnitServer } from "./fixtures/unit-server.mjs";
import { manifestOf, remember } from "./fixtures/unit-env.mjs";

const CLI = path.resolve("scripts/cli.mjs");
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
// Async on purpose where a fixture server lives in this process: spawnSync would block the
// loop the server answers from.
const run = (args, cwd, env) => new Promise((resolve) => {
  const child = spawn(process.execPath, [CLI, ...args], { cwd, env });
  let out = "", err = "";
  child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { err += d; });
  child.on("close", (code) => resolve({ code, out, err }));
});

test("takeOrigin lifts --origin out of any verb's argv, in either spelling, and keeps the rest in order", () => {
  assert.deepEqual(takeOrigin(["--origin", "https://a.test/", "toolkit"]), { rest: ["toolkit"], origin: "https://a.test", error: null });
  assert.deepEqual(takeOrigin(["toolkit/cards", "--dir", "x", "--origin=https://b.test"]), { rest: ["toolkit/cards", "--dir", "x"], origin: "https://b.test", error: null });
  assert.deepEqual(takeOrigin(["--discard"]), { rest: ["--discard"], origin: "", error: null });
  assert.match(takeOrigin(["--origin"]).error, /needs a URL/);
  assert.match(takeOrigin(["--origin", "--dir"]).error, /needs a URL/);
  assert.match(takeOrigin(["--origin="]).error, /needs a URL/);
  assert.equal(cwdGone(), null, "this test's own folder exists");
});

test("`augur ls --origin <url>` uses the URL as the origin and never as an opportunity name", async () => {
  // A closed port: the verb must try THAT origin and name it in its refusal, rather than
  // answer for whatever this machine paired with last or a sibling deploy shell names.
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const dead = `http://127.0.0.1:${probe.address().port}`;
  await new Promise((r) => probe.close(r));
  const env = { ...process.env, HOME: tmp("augur-home-"), AUGUR_ORIGIN: "", AUGUR_TOKEN: "not-a-token" };
  for (const args of [["ls", "--origin", dead], ["ls", `--origin=${dead}`], ["ls", "--origin", dead, "toolkit"]]) {
    const r = await run(args, tmp("augur-cwd-"), env);
    assert.equal(r.code, 1, r.err);
    assert.doesNotMatch(r.err, /no opportunity/, `${args.join(" ")}: the URL was read as an opportunity`);
    assert.doesNotMatch(r.err, /no target origin|no origin named/, `${args.join(" ")}: the flag was dropped`);
    assert.ok(r.err.includes(`could not reach ${dead}`), `${args.join(" ")}: ${r.err}`);
  }
  const bare = await run(["ls", "--origin"], tmp("augur-cwd-"), env);
  assert.equal(bare.code, 1);
  assert.match(bare.err, /--origin needs a URL/);
});

test("a verb run from a folder that no longer exists is told to cd .., with no stack", () => {
  const d = tmp("augur-gone-");
  const r = spawnSync("/bin/sh", ["-c", `cd "${d}" && rmdir "${d}" && "${process.execPath}" "${CLI}" status`],
    { encoding: "utf8", env: { ...process.env, AUGUR_ORIGIN: "", AUGUR_TOKEN: "" } });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /no longer exists.*cd \.\./s);
  assert.doesNotMatch(r.stderr, /uv_cwd|at .*\.mjs:\d+/, "no stack trace");
});

test("`augur close <folder>` works from the parent and leaves the shell's folder alone; run inside, it ends with cd ..", async () => {
  const U = "/checkout/flow/";
  const srv = await startUnitServer({ live: manifestOf(2, { [U]: { "index.html": remember("<h1>flow</h1>") } }), tenantId: "cli-close-1" });
  try {
    const home = tmp("augur-home-");
    const env = { ...process.env, HOME: home, AUGUR_ORIGIN: srv.origin, AUGUR_TOKEN: "tok", AUGUR_NO_ADAPTERS: "1", AUGUR_DRAFTS_REGISTRY: path.join(home, "drafts.json") };
    const work = tmp("augur-work-");
    fs.writeFileSync(path.join(work, "space.json"), JSON.stringify({ id: "alpha" }));

    const o = await run(["open", "checkout/flow", "--dir", "flow"], work, env);
    assert.equal(o.code, 0, o.err);
    assert.ok(fs.existsSync(path.join(work, "flow", "index.html")));
    const c = await run(["close", "flow", "--discard"], work, env);
    assert.equal(c.code, 0, c.err);
    assert.match(c.err, /draft abandoned and folder removed/);
    assert.doesNotMatch(c.err, /cd \.\./, "from the parent, nothing was pulled from under the shell");
    assert.equal(fs.existsSync(path.join(work, "flow")), false);

    const o2 = await run(["open", "checkout/flow", "--dir", "flow2"], work, env);
    assert.equal(o2.code, 0, o2.err);
    const c2 = await run(["close", "--discard"], path.join(work, "flow2"), env);
    assert.equal(c2.code, 0, c2.err);
    assert.match(c2.err, /folder removed/);
    assert.match(c2.err, /this shell's folder.*cd \.\./, "run inside, the last line says where the shell now stands");
    assert.equal(fs.existsSync(path.join(work, "flow2")), false);

    const nope = await run(["close", "nothing-here"], work, env);
    assert.equal(nope.code, 1);
    assert.match(nope.err, /nothing-here is not a draft folder/);
  } finally { await srv.close(); }
});
