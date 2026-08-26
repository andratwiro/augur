#!/usr/bin/env node
/**
 * augur migrate — move a workspace from one instance to another, and prove it arrived.
 *
 *   augur migrate --from https://old --to https://new [--freeze] [--out <dir>] [--dry-run]
 *
 * `MIG-do-rekey-run`. Five steps, and each one is a command that already exists and is
 * already tested:
 *
 *   1. FREEZE the source (optional but you almost always want it). Writes stop; reads and
 *      sign-in do not. See docs/migration-freeze.md for why that is a flag rather than a
 *      DNS pull.
 *   2. EXPORT everything — published content AND the roster, invites, publish tokens,
 *      statuses, card names, comment threads, boards, pins, canvas images.
 *   3. RESTORE it into the target, content and state.
 *   4. VERIFY by reading the target back through its OWN export and diffing family by
 *      family. This is the step that makes the run worth anything: a migration that
 *      reports success without reading the far side back has only reported that it sent
 *      some requests.
 *   5. Leave the source frozen (deliberately — see below), and print the numbers.
 *
 * WHY IT SHELLS OUT rather than reimplementing any of it: a second copy of the export
 * logic is a second thing that has to stay right, and the one that gets used less is the
 * one that rots. Each step here is the command an operator would run by hand, in order,
 * with its output on screen.
 *
 * RE-RUNNING IS SAFE, and that is the design rather than a happy accident. The export is
 * content-addressed and skips blobs it already has; the restore replaces each family
 * whole; the workspace object's import is one transaction. So a run that dies anywhere —
 * mid-family, mid-blob, mid-anything — is fixed by running it again, and the end state is
 * identical to an uninterrupted run. There is nothing to clean up first and nothing that
 * double-writes.
 *
 * ⚠️ IT DOES NOT THAW THE SOURCE, and it does not touch DNS. Both are deliberate. The
 * source stays read-only until a person has looked at the target and decided; thawing
 * automatically would reopen writes to an instance that is about to stop being the one
 * people reach. Cutting the hostname over is the step that needs a human and an account
 * credential this script does not hold.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveToken, apiClient } from "./lib/store.mjs";

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.error(`\x1b[35m[migrate]\x1b[0m ${m}`);
const die = (m) => { log(`\x1b[31m${m}\x1b[0m`); process.exit(1); };

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const FROM = (opt("--from") || "").replace(/\/+$/, "");
const TO = (opt("--to") || "").replace(/\/+$/, "");
const DRY = flag("--dry-run");
const FREEZE = flag("--freeze");
if (!FROM || !TO) die("name both ends: --from https://old --to https://new");
if (FROM === TO) die("--from and --to are the same instance.");

// Tokens come from the same file `augur login` writes, one per host, so a migration needs
// no new credential and no new place to keep one.
const FROM_TOKEN = process.env.AUGUR_FROM_TOKEN || resolveToken(FROM);
const TO_TOKEN = process.env.AUGUR_TO_TOKEN || resolveToken(TO);
if (!FROM_TOKEN) die(`no token for ${FROM} — run \`augur login --origin ${FROM}\`. It needs STAR scope.`);
if (!TO_TOKEN) die(`no token for ${TO} — run \`augur login --origin ${TO}\`. It needs STAR scope.`);

const OUT = opt("--out") || mkdtempSync(path.join(os.tmpdir(), "augur-migrate-"));

/** Run one of the existing commands, with its output on screen, and stop on failure. */
function step(name, script, argv, env) {
  return new Promise((resolve) => {
    log(`\x1b[1m${name}\x1b[0m`);
    const child = spawn(process.execPath, [path.join(SCRIPTS, script), ...argv], {
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    child.on("close", (code) => {
      if (code !== 0) die(`${name} failed (exit ${code}). Nothing to clean up — fix it and run this again.`);
      resolve();
    });
  });
}

const started = Date.now();
log(`${FROM} → ${TO}${DRY ? "  [dry run]" : ""}`);
log(`working directory: ${OUT}`);

// 1. Freeze. Before the export, never after: a copy taken while writes are still landing
//    is a copy that is already behind by the time it finishes.
if (FREEZE && !DRY) {
  await step("freeze the source", "freeze.mjs",
    ["--reason", `being moved to ${TO}`],
    { AUGUR_ORIGIN: FROM, AUGUR_TOKEN: FROM_TOKEN });
}

// 2 + 3.
await step("export everything", "export.mjs",
  ["--out", OUT, "--full", "--history"],
  { AUGUR_ORIGIN: FROM, AUGUR_TOKEN: FROM_TOKEN });

await step("restore into the target", "restore.mjs",
  [OUT, "--state", ...(DRY ? ["--dry-run"] : [])],
  { AUGUR_ORIGIN: TO, AUGUR_TOKEN: TO_TOKEN });

if (DRY) {
  log("dry run — nothing was written to the target, and the source was not frozen");
  process.exit(0);
}

// 4. THE STEP THAT MAKES THIS WORTH RUNNING. Read the target back through its own export
//    and compare, family by family. A migration that reports success without reading the
//    far side has reported that it sent some requests.
log("\x1b[1mverify the target against the source\x1b[0m");
const fromApi = apiClient(FROM, FROM_TOKEN);
const toApi = apiClient(TO, TO_TOKEN);
const [before, after] = await Promise.all([
  (await fromApi("_state/export")).json(),
  (await toApi("_state/export")).json(),
]);

const diffs = [];
for (const id of new Set([...Object.keys(before.families), ...Object.keys(after.families)])) {
  const a = JSON.stringify(before.families[id] ?? null);
  const b = JSON.stringify(after.families[id] ?? null);
  if (a !== b) diffs.push(id);
}
const missingAssets = (before.assets || []).filter((h) => !(after.assets || []).includes(h));

for (const id of Object.keys(before.families)) {
  const n = Object.keys(before.families[id] || {}).length;
  console.log(`  ${diffs.includes(id) ? "\x1b[31m✗\x1b[0m" : "\x1b[32m✓\x1b[0m"} ${id.padEnd(22)} ${n} key(s)`);
}
console.log(`  ${missingAssets.length ? "\x1b[31m✗\x1b[0m" : "\x1b[32m✓\x1b[0m"} ${"canvas images".padEnd(22)} ${(before.assets || []).length}`);

if (diffs.length || missingAssets.length) {
  die(`the target does not match the source: ${[...diffs, ...missingAssets.map((h) => `image ${h.slice(0, 8)}`)].join(", ")}.\n`
    + `  The source is untouched and still frozen. Run this again — it is safe to repeat.`);
}

const mins = ((Date.now() - started) / 60000).toFixed(1);
log(`\x1b[32mevery family matches\x1b[0m — ${Object.keys(before.families).length} famil(y/ies), ${(before.assets || []).length} image(s)`);
console.log("");
console.log(`  ${TO} now holds what ${FROM} holds.`);
console.log(`  Copy took ${mins} minutes. The source is ${FREEZE ? "still FROZEN" : "still accepting writes"}.`);
console.log("");
console.log("  Next, in this order, by hand:");
console.log(`    1. look at ${TO} and decide`);
console.log("    2. point the hostname at it");
console.log(`    3. \x1b[1maugur thaw\x1b[0m against whichever instance people now reach`);
console.log("");
console.log("\x1b[2m  Nothing here touches DNS, and nothing thaws the source: both need a person.\x1b[0m");
