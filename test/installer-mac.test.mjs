// installer-mac.test.mjs — the macOS installer script is valid bash, names the agent
// tool only through AGENT_TOOL, needs no admin rights, and fails loudly rather than
// vanishing a Terminal window.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { macInstallerScript } from "../src/installer-mac.mjs";
import { AGENT_TOOL } from "../src/agent-tool.mjs";

test("the installer is valid bash, bakes the origin in, and touches nothing outside the home", () => {
  const s = macInstallerScript({ origin: "https://acme.example", agentTool: AGENT_TOOL });
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "inst-")), "x.command"); fs.writeFileSync(f, s);
  assert.equal(spawnSync("bash", ["-n", f]).status, 0, "bash -n");
  assert.match(s, /connect --origin https:\/\/acme\.example/);
  assert.doesNotMatch(s, /\bsudo\b/);
  assert.match(s, /set -euo pipefail/);
});

test("the script names the agent tool only through agentTool.name/install/bin", () => {
  const tool = { id: "x", name: "Widget Agent", install: "npm install -g @widget/agent", bin: "widgetagent" };
  const s = macInstallerScript({ origin: "https://acme.example", agentTool: tool });
  assert.match(s, /Widget Agent/);
  assert.match(s, /npm install -g @widget\/agent/);
  assert.match(s, /widgetagent/);
});

test("every failure path prints a sentence and waits for Return before exiting", () => {
  const s = macInstallerScript({ origin: "https://acme.example", agentTool: AGENT_TOOL });
  assert.match(s, /fail\(\)\s*\{[^}]*read -r[^}]*exit 1/s, "fail() prints, waits, then exits");
  // a bare `set -e` exit with no trap is a vanished window — this is the catch-all.
  assert.match(s, /trap\s+.*\bERR\b/, "an ERR trap catches anything not explicitly guarded");
});

test("connects with --no-wait first (to print the code) then again to collect it, opening /__welcome not /__connect", () => {
  const s = macInstallerScript({ origin: "https://acme.example", agentTool: AGENT_TOOL });
  assert.match(s, /connect --origin https:\/\/acme\.example --no-wait/);
  assert.match(s, /open "https:\/\/acme\.example\/__welcome"/);
  assert.doesNotMatch(s, /open "https:\/\/acme\.example\/__connect"/);
});

test("exports npm_config_prefix before installing the CLI with npm", () => {
  const s = macInstallerScript({ origin: "https://acme.example", agentTool: AGENT_TOOL });
  const prefixAt = s.indexOf("npm_config_prefix");
  const installAt = s.indexOf("npm install -g @augurworks/augur");
  assert.ok(prefixAt >= 0 && installAt >= 0 && prefixAt < installAt, "npm_config_prefix exported before the npm install line");
});
