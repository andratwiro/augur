// test/draft-cli.test.mjs — the entry points parse their arguments and print the contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const run = (script, args, cwd) => spawnSync(process.execPath, [path.resolve(`scripts/${script}`), ...args], { cwd, encoding: "utf8", env: { ...process.env, AUGUR_ORIGIN: "", AUGUR_TOKEN: "" } });

test("every verb is routed and refuses to run outside a draft folder with a sentence, not a stack", () => {
  const cli = fs.readFileSync("scripts/cli.mjs", "utf8");
  for (const v of ["open", "save", "land", "sync", "close", "read", "watch", "hook"]) assert.match(cli, new RegExp(`\\b${v}: "${v}\\.mjs"`));
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "augur-cli-"));
  for (const v of ["save", "land", "sync", "close", "watch"]) {
    const r = run(`${v}.mjs`, [], dir);
    assert.equal(r.status, 1, `${v}: ${r.stderr}`);
    assert.match(r.stderr, /not a draft folder/);
    assert.doesNotMatch(r.stderr, /at .*\.mjs:\d+/, "no stack trace");
  }
});

test("open without a unit or a target says what is missing", () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "augur-cli-"));
  const r = run("open.mjs", [], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /name a prototype/);
});

// ── open installs the editor hooks, once, and only when asked ─────────────────
import os from "node:os";
import { spawn } from "node:child_process";
import { startUnitServer } from "./fixtures/unit-server.mjs";
import { manifestOf, remember } from "./fixtures/unit-env.mjs";

// Async on purpose: open talks to the fixture server living in THIS process.
const openIn = (cwd, unit, env) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.resolve("scripts/open.mjs"), unit], { cwd, env });
  let out = "", err = "";
  child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { err += d; });
  child.on("close", (code) => resolve({ code, out, err }));
});

test("open installs the editor hooks into this machine's tool settings once; AUGUR_NO_ADAPTERS skips it", async () => {
  const U = "/checkout/flow/";
  const srv = await startUnitServer({ live: manifestOf(5, { [U]: { "index.html": remember("<h1>flow</h1>") } }), tenantId: "cli-open-1" });
  try {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "augur-home-"));
    fs.mkdirSync(path.join(home, ".claude"));
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ theme: "dark" }));
    const registry = path.join(home, "drafts.json");
    // A work folder is a space checkout (open reads space.json for the space id), and the
    // draft folder lands inside it — which the deny rule treats as a draft folder first.
    const workDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "augur-work-")); fs.writeFileSync(path.join(d, "space.json"), JSON.stringify({ id: "alpha" })); return d; };
    const env = { ...process.env, HOME: home, AUGUR_ORIGIN: srv.origin, AUGUR_TOKEN: "tok", AUGUR_DRAFTS_REGISTRY: registry };
    delete env.AUGUR_NO_ADAPTERS;
    const work = workDir();
    const first = await openIn(work, "checkout/flow", env);
    assert.equal(first.code, 0, first.err);
    assert.match(first.err, /editor hooks installed/);
    const settings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
    assert.equal(settings.theme, "dark");
    assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /hook\.mjs" pre$/);
    assert.match(settings.hooks.PostToolUse[0].hooks[0].command, /hook\.mjs" post$/);
    const second = await openIn(workDir(), "checkout/flow", env);
    assert.equal(second.code, 0, second.err);
    assert.doesNotMatch(second.err, /editor hooks/, "the second open says nothing about hooks");
    const home3 = fs.mkdtempSync(path.join(os.tmpdir(), "augur-home-"));
    fs.mkdirSync(path.join(home3, ".claude"));
    const third = await openIn(workDir(), "checkout/flow", { ...env, HOME: home3, AUGUR_NO_ADAPTERS: "1" });
    assert.equal(third.code, 0, third.err);
    assert.equal(fs.existsSync(path.join(home3, ".claude", "settings.json")), false, "nothing written when asked not to");
  } finally { await srv.close(); }
});
