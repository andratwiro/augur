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
import { compareFamily } from "./lib/state-compare.mjs";

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
//
//    ⚠️ AND THEN WAIT, because `freeze` returning is not the same as writes having stopped.
//    The worker reads the freeze flag through a per-isolate cache with a 10-second life
//    (`FREEZE_TTL_MS` in src/_worker.js), so an isolate that last looked 9 seconds ago goes
//    on accepting writes for another second, and one that has not looked at all since the
//    flag was set can accept them for the full ten. Those writes land in the workspace
//    being copied AFTER the copy starts reading it — which is exactly the loss the freeze
//    exists to prevent, arriving through the freeze itself.
//
//    Waiting the cache out is the whole fix and it costs eleven seconds of a migration
//    somebody scheduled. Shortening the TTL instead would put a KV read in front of every
//    write on every instance forever, to save eleven seconds on an operation run by hand.
//
//    ⚠️ AND A FREEZE DOES NOT STOP CANVAS EDITING. `isFrozenWrite` exempts GET, and a
//    WebSocket upgrade is a GET, so `/__rt` stays open for the whole window: somebody with
//    a board open can go on moving nodes, pasting images and renaming it while this runs,
//    and every one of those edits lands in a room on the instance being retired. The `/__board`
//    KV rail IS frozen, so what they cannot do is make the mirror this export reads catch
//    up. That is why the board step below reads the ROOM and why it is allowed to refuse:
//    an `unstable` read means somebody is editing right now, and the answer is to find them,
//    not to force it.
const FREEZE_SETTLE_MS = 11_000;
if (FREEZE && !DRY) {
  await step("freeze the source", "freeze.mjs",
    ["--reason", `being moved to ${TO}`],
    { AUGUR_ORIGIN: FROM, AUGUR_TOKEN: FROM_TOKEN });
  log(`waiting ${FREEZE_SETTLE_MS / 1000}s for every isolate's freeze cache to expire — a write accepted now would be copied late or not at all`);
  await new Promise((r) => setTimeout(r, FREEZE_SETTLE_MS));
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

// The judgement lives in lib/state-compare.mjs, where it can be tested without two
// instances on the far side of a spawned runner. It is STRUCTURAL: the two ends answer
// the same documents in different key orders (KV insertion order against the workspace
// object's sorted read), so a bytewise comparison failed correct copies.

const diffs = [];
const blind = [];
const ids = [...new Set([...Object.keys(before.families), ...Object.keys(after.families)])];
for (const id of ids) {
  const verdict = compareFamily(id, before.families[id], after.families[id]);
  if (verdict === "differ") diffs.push(id);
  if (verdict === "blind") blind.push(id);
}
const missingAssets = (before.assets || []).filter((h) => !(after.assets || []).includes(h));

for (const id of ids) {
  const n = Object.keys(before.families[id] || {}).length;
  const bad = diffs.includes(id) || blind.includes(id);
  const note = blind.includes(id)
    ? "  \x1b[33mreported absent by one side — a set of documents, so an empty one is {}\x1b[0m"
    : "";
  console.log(`  ${bad ? "\x1b[31m✗\x1b[0m" : "\x1b[32m✓\x1b[0m"} ${id.padEnd(22)} ${n} key(s)${note}`);
}
console.log(`  ${missingAssets.length ? "\x1b[31m✗\x1b[0m" : "\x1b[32m✓\x1b[0m"} ${"canvas images".padEnd(22)} ${(before.assets || []).length}`);

if (blind.length) {
  die(`neither end can be judged on ${blind.join(", ")}: one side reported the family ABSENT rather than empty.\n`
    + `  A family that is a set of documents reports an empty set as {}, so absent there means that\n`
    + `  export could not enumerate it — not that it holds nothing. The copy may well be correct and\n`
    + `  this run cannot say so. The source is untouched and still frozen.`);
}
if (diffs.length || missingAssets.length) {
  die(`the target does not match the source: ${[...diffs, ...missingAssets.map((h) => `image ${h.slice(0, 8)}`)].join(", ")}.\n`
    + `  The source is untouched and still frozen. Run this again — it is safe to repeat.`);
}

// 4b. THE ONE FAMILY THE COMPARISON ABOVE CANNOT JUDGE, and the reason it gets its own step.
//
// ⚠️ `board:` IS A MIRROR ON BOTH SIDES. The export reads the KV document a room writes on
// a dirty alarm; the target's export reads the copy this migration just wrote there. So the
// two agree the instant the restore lands, and they agree just as readily when the document
// is nodes behind the room that owns it — which is the normal state of a live board, not an
// edge case. Measured on a real instance with nobody editing: the mirror held 21 nodes and
// the room held 24. A verification that says "every family matches" over that is telling the
// truth about the copy and the wrong thing about the board, and it is the only step of this
// command that can be green while data is being dropped.
//
// So the boards move over a SOCKET, from the room that owns them into the room that will.
// `board-snapshot move` is that operation, it reads the truth and proves the seed landed,
// and it never deletes the source. One process per board so a failure names its board.
//
// It can legitimately refuse: a board somebody is editing right now reads as `unstable`,
// and the freeze does NOT stop that — a WebSocket upgrade is a GET, so `/__rt` is open for
// the whole window. That refusal is the correct answer and it is why this is a step rather
// than a footnote.
//
// AND IT IS SKIPPED, CORRECTLY, ON A DEPLOYMENT WITH NO ROOMS AT ALL. There, no room ever
// wrote the mirror, so the KV document IS the board and the copy already carried the whole
// of it. `/__rt` says which: 501 `realtime-not-configured` from a deployment that binds no
// rooms and names no realtime origin, 426 `expected-websocket` from one that does. A plain
// GET is enough to ask, which keeps this off the socket path entirely.
const hasRooms = async (origin) => {
  try {
    const r = await fetch(`${origin}/__rt?path=/`, { headers: { Accept: "application/json" } });
    return r.status !== 501;
  } catch (e) { return true; } // cannot tell ⇒ do not skip the step that protects the data
};

const boardPaths = Object.keys((before.families || {})["board:"] || {});
if (boardPaths.length && !(await hasRooms(FROM))) {
  log(`${boardPaths.length} canvas board(s): ${FROM} serves no rooms, so the KV document is the `
    + `whole board and the copy carried it. Nothing to move over a socket.`);
} else if (boardPaths.length && !(await hasRooms(TO))) {
  // The one case that is neither a pass nor a retry: the source's boards live in rooms and
  // the target has nowhere to put them. Restoring the mirror leaves boards that are as
  // stale as the mirror was and that no room will ever correct.
  die(`${boardPaths.length} board(s) live in rooms on ${FROM}, and ${TO} has no realtime configured.\n`
    + `  What landed there is the KV MIRROR, which is not the board. Configure realtime on the\n`
    + `  target (a ROOMS binding, or rtOrigin in its deploy config) and run this again.`);
} else if (boardPaths.length) {
  log(`\x1b[1mmove ${boardPaths.length} canvas board(s) from the room, not the mirror\x1b[0m`);
  const failedBoards = [];
  for (const p of boardPaths) {
    const code = await new Promise((resolve) => {
      spawn(process.execPath, [path.join(SCRIPTS, "board-snapshot.mjs"), "move",
        "--from", FROM, "--to", TO, "--path", p], { stdio: "inherit", env: process.env })
        .on("close", resolve);
    });
    if (code !== 0) failedBoards.push(p);
  }
  if (failedBoards.length) {
    die(`${failedBoards.length} board(s) did not move: ${failedBoards.join(", ")}.\n`
      + `  The content and the state DID land — only these boards are still on the source, and\n`
      + `  what ${TO} holds for them is the stale KV mirror, which is not the board. Fix and re-run;\n`
      + `  a board move is safe to repeat and never removes the source.`);
  }
  console.log(`  \x1b[32m✓\x1b[0m ${"canvas boards".padEnd(22)} ${boardPaths.length} moved from the room`);
}

const mins = ((Date.now() - started) / 60000).toFixed(1);
log(`\x1b[32mevery family matches\x1b[0m — ${Object.keys(before.families).length} famil(y/ies), ${(before.assets || []).length} image(s)`);
console.log("");
console.log(`  ${TO} now holds what ${FROM} holds.`);
console.log(`  Copy took ${mins} minutes. The source is ${FREEZE ? "still FROZEN" : "still accepting writes"}.`);
console.log("");
// THE ONE THING THAT DID NOT COME, stated in the success report rather than in a doc.
// A restore does not replay publish history, so the target starts at v1 per space; saying
// it here is the difference between a known trade and a discovery mid-incident.
console.log("\x1b[33m  Publish history did not come with it: every space on the target is at");
console.log(`  version 1, so \`augur rollback\` there reaches nothing. The archive is on disk`);
console.log(`  under ${OUT}/versions/ and ${FROM} still holds the live history until it is retired.\x1b[0m`);
console.log("");
console.log("  Next, in this order, by hand:");
console.log(`    1. look at ${TO} and decide`);
console.log("    2. point the hostname at it");
console.log(`    3. \x1b[1maugur thaw\x1b[0m against whichever instance people now reach`);
console.log("");
console.log("\x1b[2m  Nothing here touches DNS, and nothing thaws the source: both need a person.\x1b[0m");
