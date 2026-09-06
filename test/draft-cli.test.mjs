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
import http from "node:http";
import { spawn } from "node:child_process";
import { startUnitServer } from "./fixtures/unit-server.mjs";
import { manifestOf, remember } from "./fixtures/unit-env.mjs";

// Async on purpose: open talks to the fixture server living in THIS process.
const openIn = (cwd, unit, env, ...args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.resolve("scripts/open.mjs"), unit, ...args], { cwd, env });
  let out = "", err = "";
  child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { err += d; });
  child.on("close", (code) => resolve({ code, out, err }));
});

test("open installs the editor hooks into the FOLDER's local tool settings once; AUGUR_NO_ADAPTERS skips it", async () => {
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
    assert.match(first.err, /a save hook is now in .*settings\.local\.json — for this folder only/);
    const settings = JSON.parse(fs.readFileSync(path.join(work, ".claude", "settings.local.json"), "utf8"));
    assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /hook\.mjs" pre$/);
    assert.match(settings.hooks.PostToolUse[0].hooks[0].command, /hook\.mjs" post$/);
    const global = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
    assert.deepEqual(global, { theme: "dark" }, "the account-wide file is not touched");
    const second = await openIn(work, "checkout/flow", env, "--dir", "flow-again");
    assert.equal(second.code, 0, second.err);
    assert.doesNotMatch(second.err, /save hook|editor hooks/, "a second open in the same folder says nothing about hooks");
    const work3 = workDir();
    const third = await openIn(work3, "checkout/flow", { ...env, AUGUR_NO_ADAPTERS: "1" });
    assert.equal(third.code, 0, third.err);
    assert.equal(fs.existsSync(path.join(work3, ".claude", "settings.local.json")), false, "nothing written when asked not to");
  } finally { await srv.close(); }
});

// ── open --new refuses guesses: an unslugged path, or an opportunity that does not exist ──
test("open --new refuses an unknown opportunity and an unslugged path, naming the fix", async () => {
  const srv = await startUnitServer({ live: manifestOf(1, { "/toolkit/cards/": { "index.html": remember("<h1>c</h1>") } }), tenantId: "cli-new-1" });
  try {
    const env = { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), "h-")), AUGUR_ORIGIN: srv.origin, AUGUR_TOKEN: "tok", AUGUR_NO_ADAPTERS: "1", AUGUR_DRAFTS_REGISTRY: path.join(os.tmpdir(), `r-${Date.now()}.json`) };
    const w = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "w-")); fs.writeFileSync(path.join(d, "space.json"), JSON.stringify({ id: "alpha" })); return d; };
    const a = await openIn(w(), "Broad Listening/survey", env, "--new");
    assert.equal(a.code, 1);
    assert.match(a.err, /broad-listening\/survey/);
    // The refusal names the accepted spelling — retrying with exactly that slug is the
    // round trip a person actually takes. It is an unknown opportunity in this fixture
    // (only "toolkit" is authored), so it still needs --new-opportunity to go through.
    const aRetry = await openIn(w(), "broad-listening/survey", env, "--new", "--new-opportunity");
    assert.equal(aRetry.code, 0, aRetry.err);
    const b = await openIn(w(), "research/survey", env, "--new");
    assert.equal(b.code, 1);
    assert.match(b.err, /no opportunity "research".*--new-opportunity/s);
    const c = await openIn(w(), "research/survey", env, "--new", "--new-opportunity");
    assert.equal(c.code, 0, c.err);
    const d = await openIn(w(), "toolkit/survey", env, "--new");
    assert.equal(d.code, 0, d.err);
  } finally { await srv.close(); }
});

// ── open --new: a manifest that cannot be read is a refusal, not a silent skip ─────────
test("open --new reports the network when the opportunity check can't reach the instance, and opens freely against a genuinely empty manifest", async () => {
  const w = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "w-")); fs.writeFileSync(path.join(d, "space.json"), JSON.stringify({ id: "alpha" })); return d; };
  // A closed port: bind, learn the port, close it again — nothing listens there, so the
  // manifest fetch the opportunity check makes gets ECONNREFUSED instead of a stale answer.
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const deadPort = probe.address().port;
  await new Promise((r) => probe.close(r));
  const deadOrigin = `http://127.0.0.1:${deadPort}`;
  const envDead = { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), "h-")), AUGUR_ORIGIN: deadOrigin, AUGUR_TOKEN: "tok", AUGUR_NO_ADAPTERS: "1", AUGUR_DRAFTS_REGISTRY: path.join(os.tmpdir(), `r-${Date.now()}.json`) };
  const unreachable = await openIn(w(), "research/first", envDead, "--new");
  assert.equal(unreachable.code, 1);
  assert.match(unreachable.err, /could not reach the instance/);

  // Against a live instance whose manifest is genuinely readable and empty (a fresh
  // workspace, nothing authored yet), --new opens freely with no --new-opportunity: there
  // is nothing yet to compare the new unit's opportunity against.
  const srv = await startUnitServer({ live: manifestOf(1, {}), tenantId: "cli-new-empty" });
  try {
    const envLive = { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), "h-")), AUGUR_ORIGIN: srv.origin, AUGUR_TOKEN: "tok", AUGUR_NO_ADAPTERS: "1", AUGUR_DRAFTS_REGISTRY: path.join(os.tmpdir(), `r-${Date.now()}.json`) };
    const fresh = await openIn(w(), "research/first", envLive, "--new");
    assert.equal(fresh.code, 0, fresh.err);
  } finally { await srv.close(); }
});
