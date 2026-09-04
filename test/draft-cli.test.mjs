// test/draft-cli.test.mjs — the entry points parse their arguments and print the contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const run = (script, args, cwd) => spawnSync(process.execPath, [path.resolve(`scripts/${script}`), ...args], { cwd, encoding: "utf8", env: { ...process.env, AUGUR_ORIGIN: "", AUGUR_TOKEN: "" } });

test("every verb is routed and refuses to run outside a draft folder with a sentence, not a stack", () => {
  const cli = fs.readFileSync("scripts/cli.mjs", "utf8");
  for (const v of ["open", "save", "land", "sync", "close"]) assert.match(cli, new RegExp(`\\b${v}: "${v}\\.mjs"`));
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "augur-cli-"));
  for (const v of ["save", "land", "sync", "close"]) {
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
