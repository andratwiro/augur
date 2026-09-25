#!/usr/bin/env node
// The gate a deploy shell's `predeploy` runs before anything is built or uploaded:
//
//   node engine/scripts/ops/deploy-gate.mjs
//
// 1. A ROLLBACK-HOLD.json in the shell (written by rollback.mjs) refuses the deploy. The
//    engine pin still names the commit that was rolled back, so deploying now would ship it
//    again. Fix forward (move the pin to a commit that fixes it), then delete the file and
//    say why in the commit.
// 2. The engine's whole test suite must pass. It runs in under a minute; a red suite is not
//    shipped to every workspace at once. Browser tests need Chromium — the gate installs it
//    if Playwright can't launch one, rather than letting those tests fail or skip.
//
// Run from the shell's root (npm scripts do). Exit 0 = go; anything else = no deploy.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ENGINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHELL = process.cwd();
const say = (m) => console.error(`\x1b[35m[deploy-gate]\x1b[0m ${m}`);
const stop = (m) => { console.error(`\x1b[31m[deploy-gate]\x1b[0m ${m}`); process.exit(1); };

const hold = path.join(SHELL, "ROLLBACK-HOLD.json");
if (fs.existsSync(hold)) {
  let h = {};
  try { h = JSON.parse(fs.readFileSync(hold, "utf8")); } catch (e) { /* shown raw below */ }
  stop(`deploys are on hold: engine ${h.from && h.from.engine || "?"} was rolled back at ${h.at || "?"}` +
    ` (${h.reason || "no reason recorded"}). Move the engine pin to a commit that fixes it, delete` +
    ` ROLLBACK-HOLD.json, and say why in the commit.`);
}
if (process.env.AUGUR_SKIP_TESTS === "1") { say("AUGUR_SKIP_TESTS=1 — the test suite was NOT run for this deploy"); process.exit(0); }

if (!fs.existsSync(path.join(ENGINE, "node_modules"))) {
  say("installing the engine's dependencies for the test run…");
  const i = spawnSync("npm", ["ci", "--silent"], { cwd: ENGINE, stdio: "inherit" });
  if (i.status !== 0) stop("could not install the engine's dependencies, so the tests cannot run.");
}
const probe = spawnSync(process.execPath, ["-e", "import('playwright').then(p=>p.chromium.launch()).then(b=>b.close()).then(()=>process.exit(0),()=>process.exit(1))"], { cwd: ENGINE });
if (probe.status !== 0) {
  say("no launchable Chromium for the browser tests — installing it…");
  spawnSync("npx", ["playwright", "install", "chromium-headless-shell"], { cwd: ENGINE, stdio: "inherit" });
}
say("running the engine's test suite…");
const t = spawnSync("npm", ["test", "--silent"], { cwd: ENGINE, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const out = (t.stdout || "") + (t.stderr || "");
const failed = out.split("\n").filter((l) => /^not ok /.test(l));
const pass = (out.match(/^# pass (\d+)/m) || [])[1];
if (t.status !== 0 || failed.length) {
  for (const l of failed.slice(0, 20)) console.error("  " + l);
  stop(`${failed.length || "some"} test(s) failed — nothing was deployed. Fix them, or (a person, knowingly) AUGUR_SKIP_TESTS=1.`);
}
say(`${pass || "all"} tests pass`);
