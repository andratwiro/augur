#!/usr/bin/env node
/**
 * board-snapshot — move a board by its AUTHORITATIVE document, not by its KV mirror.
 *
 *   node scripts/board-snapshot.mjs lag  --origin <site> --path </board/path/>
 *   node scripts/board-snapshot.mjs read --origin <site> --path </board/path/> --out board.json
 *   node scripts/board-snapshot.mjs seed --origin <site> --path </board/path/> --from board.json
 *   node scripts/board-snapshot.mjs move --from <old site> --to <new site> --path </board/path/>
 *
 * `MIG-board-snapshot-via-ws`. The whole of the reasoning is in
 * `scripts/lib/board-snapshot.mjs`; the short version is that KV holds a mirror written on a
 * 45-second dirty alarm, `GET /__board` and every state export serve that mirror, and the
 * only read of the truth is the `welcome` frame a room sends when a client joins. So this
 * joins as a client.
 *
 * ⚠️ `lag` FIRST, ALWAYS. It is the one verb that changes nothing anywhere and it answers the
 * question a cutover actually turns on: how much is in the room that is not in the mirror. A
 * run that reports zero says a KV-sourced copy of this board would have been correct; any
 * other number is the work that copy would have thrown away.
 *
 * ⚠️ `move` DOES NOT DELETE THE SOURCE and never will. A migration that has removed the thing
 * it migrated is not reversible, and rolling a cutover back has to leave the old boards where
 * they were — the same rule `scripts/migrate-board-keys.mjs` follows for the mirror keys.
 *
 * ⚠️ IT MOVES ONE BOARD. There is no `--all`, on purpose: enumerating boards means listing KV
 * keys, which needs an account credential this script deliberately does not hold and would be
 * the wrong list anyway (a room can hold a board whose mirror key has never been written). The
 * list of paths comes from the mirror — `scripts/migrate-board-keys.mjs` scans exactly that —
 * and each one is then read from where the truth is. Loop in the shell, so a failure stops on
 * the board it failed on and says which.
 *
 * WHAT IT NEEDS: nothing but the two origins. No account token, no KV namespace id, no
 * realtime secret — `/__rt` and `/__board` are both public, because a board's URL is its
 * credential. `--direct` is the exception and reads `AUGUR_RT_SECRET` from the environment,
 * never from an argument, so it cannot land in a shell history or a CI log.
 */
import fs from "node:fs";
import { RT_SECRET_HEADER } from "../realtime/src/index.js";
import {
  DEFAULT_SETTLE_MS, DEFAULT_TIMEOUT_MS, MIRROR_CADENCE_MS, SnapshotError,
  openWebSocket, snapshotRoom, seedRoom, measureLag, readMirror,
} from "./lib/board-snapshot.mjs";

const args = process.argv.slice(2);
const verb = args[0] && !args[0].startsWith("--") ? args[0] : "";
const flag = (f) => args.includes(f);
const opt = (f, d = null) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
const num = (f, d) => { const v = opt(f); return v === null ? d : Number(v); };

const JSON_OUT = flag("--json");
const log = (m) => console.error(`\x1b[36m[board-snapshot]\x1b[0m ${m}`);
const die = (m, code = 1) => { console.error(`\x1b[36m[board-snapshot]\x1b[0m \x1b[31m${m}\x1b[0m`); process.exit(code); };

const USAGE = `usage:
  board-snapshot lag  --origin <site> --path </board/path/>
  board-snapshot read --origin <site> --path </board/path/> [--out <file>]
  board-snapshot seed --origin <site> --path </board/path/> --from <file> [--merge]
  board-snapshot move --from <site> --to <site> --path </board/path/> [--to-path </new/path/>] [--merge]

options:
  --settle <ms>    gap between the two observer reads (default ${DEFAULT_SETTLE_MS})
  --attempts <n>   retries when the board changes mid-read (default 3)
  --timeout <ms>   per-frame wait (default ${DEFAULT_TIMEOUT_MS})
  --allow-unstable report a read taken while the board was being edited, instead of failing
  --direct         speak /room to a standalone realtime worker, with AUGUR_RT_SECRET
  --json           machine-readable report on stdout`;

if (!verb || flag("--help") || flag("-h")) { console.error(USAGE); process.exit(verb ? 0 : 1); }

const PATH = opt("--path");
const DIRECT = flag("--direct");
const headers = {};
if (DIRECT) {
  const secret = process.env.AUGUR_RT_SECRET;
  if (!secret) die("--direct speaks to a standalone realtime worker, which refuses without its shared secret. Put it in AUGUR_RT_SECRET.");
  headers[RT_SECRET_HEADER] = secret;
}
const common = {
  direct: DIRECT,
  headers,
  settleMs: num("--settle", DEFAULT_SETTLE_MS),
  attempts: num("--attempts", 3),
  timeoutMs: num("--timeout", DEFAULT_TIMEOUT_MS),
  allowUnstable: flag("--allow-unstable"),
};

const emit = (obj) => { if (JSON_OUT) console.log(JSON.stringify(obj, null, 2)); };
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

function reportSnapshot(label, snap) {
  const s = snap.summary;
  if (snap.empty) { log(`${label}: the room holds NO document — this board has never been drawn on`); return; }
  log(`${label}: ${plural(s.nodes, "node")}, ${plural(s.tombs, "tombstone")}, name ${JSON.stringify(s.name)} @v${s.nameV}, ${s.bytes} bytes`);
  log(`${label}: digest ${s.digest.slice(0, 16)} · agreed across ${snap.observers.length} independent joins ${snap.settleMs}ms apart (attempt ${snap.attempt})`);
}

async function main() {
  if (verb === "lag") {
    if (!PATH) die("--path is required");
    const origin = opt("--origin") || die("--origin is required");
    const r = await measureLag(openWebSocket, { origin, path: PATH, ...common });
    reportSnapshot("room", r.snapshot);
    log(`mirror (read BEFORE the room, so no flush of ours is in it): ${r.mirrorBefore.empty ? "nothing" : plural(r.mirrorBefore.nodes, "node")}`);
    if (r.wouldHaveLost.nodes === 0) {
      log(`\x1b[32mthe mirror was level with the room — a KV-sourced copy of this board would have been correct at this instant\x1b[0m`);
    } else {
      log(`\x1b[33mthe mirror was BEHIND by ${plural(r.wouldHaveLost.nodes, "node")}\x1b[0m — ${r.wouldHaveLost.missing.length} missing outright, ${r.wouldHaveLost.stale.length} at an older version`);
      log(`that is what a KV-sourced migration of this board would have dropped, silently. The room writes the mirror every ${MIRROR_CADENCE_MS / 1000}s at most — but a reader sees that write later still (measured: 87s), so wait on this number reaching zero, never on a clock.`);
    }
    log(`mirror re-read after: ${r.mirrorAfter.empty ? "nothing" : plural(r.mirrorAfter.nodes, "node")}${r.readFlushedTheMirror ? " — the read's own disconnect flushed it (a snapshot leaves a quiet board's mirror fresher than it found it)" : " — unchanged"}`);
    emit(r);
    return 0;
  }

  if (verb === "read") {
    if (!PATH) die("--path is required");
    const origin = opt("--origin") || die("--origin is required");
    const snap = await snapshotRoom(openWebSocket, { origin, path: PATH, ...common });
    reportSnapshot("room", snap);
    const out = opt("--out");
    const payload = { source: { origin, path: PATH, direct: DIRECT }, readAt: new Date().toISOString(), empty: snap.empty, summary: snap.summary, stable: snap.stable, doc: snap.doc };
    if (out) { fs.writeFileSync(out, JSON.stringify(payload, null, 2)); log(`wrote ${out}`); }
    if (JSON_OUT) console.log(JSON.stringify(payload, null, 2));
    else if (!out) console.log(JSON.stringify(payload.doc));
    return snap.stable ? 0 : 3;
  }

  if (verb === "seed") {
    if (!PATH) die("--path is required");
    const origin = opt("--origin") || die("--origin is required");
    const from = opt("--from") || die("--from <file> is required — a snapshot written by `read`");
    let file;
    try { file = JSON.parse(fs.readFileSync(from, "utf8")); } catch (e) { return die(`cannot read ${from}: ${e.message}`); }
    const doc = file && file.doc ? file.doc : file;
    if (file && file.empty) return die("that snapshot is of a board that has never been drawn on — there is nothing to seed, and seeding an empty document would write a board where there was none");
    const r = await seedRoom(openWebSocket, { origin, path: PATH, doc, merge: flag("--merge"), settleMs: common.settleMs, timeoutMs: common.timeoutMs, direct: DIRECT, headers });
    log(`offered ${plural(r.offered.nodes, "node")} to ${origin}${PATH}${r.destinationWasEmpty ? " (destination was empty — adopted wholesale)" : " (destination held a board — reconciled per node)"}`);
    log(`read back over a fresh socket after the seeder had closed: ${plural(r.landed.nodes, "node")}`);
    if (!r.nodesLanded) {
      log(`\x1b[31mthe destination does not hold what was offered\x1b[0m — ${r.comparison.onlyInA.length} never arrived, ${r.comparison.differing.length} at another version`);
    } else if (r.identical) {
      log(`\x1b[32mevery node landed at the version it left with, and the destination is the source document whole\x1b[0m`);
    } else {
      // A merge, resolved by the version rules. Named rather than scored as a failure.
      log(`\x1b[32mevery node landed at the version it left with\x1b[0m`);
      if (r.kept.nodes.length) log(`the destination also kept ${plural(r.kept.nodes.length, "node")} the offer did not carry — an absence in an offer is not a deletion`);
      if (r.kept.name) log(`the destination kept its own board name ${JSON.stringify(r.kept.name)}: the offer's nameV did not beat it`);
    }
    emit(r);
    return r.ok ? 0 : 4;
  }

  if (verb === "move") {
    if (!PATH) die("--path is required");
    const from = opt("--from") || die("--from <site> is required");
    const to = opt("--to") || die("--to <site> is required");
    const toPath = opt("--to-path", PATH);
    if (from === to && PATH === toPath) die("--from and --to name the same room");
    const before = await measureLag(openWebSocket, { origin: from, path: PATH, ...common });
    reportSnapshot("source room", before.snapshot);
    if (before.snapshot.empty) return die("the source room holds no document — nothing to move", 5);
    log(`the source mirror was behind by ${plural(before.wouldHaveLost.nodes, "node")}; this move carries the room's copy, not the mirror's`);
    const seeded = await seedRoom(openWebSocket, {
      origin: to, path: toPath, doc: before.snapshot.doc, merge: flag("--merge"),
      settleMs: common.settleMs, timeoutMs: common.timeoutMs, direct: DIRECT, headers,
    });
    log(`destination now holds ${plural(seeded.landed.nodes, "node")}`);
    if (seeded.ok) log(`\x1b[32m${from}${PATH} → ${to}${toPath}: every node arrived. The source is untouched and still serving.\x1b[0m`);
    else log(`\x1b[31mthe destination does not hold what the source room had\x1b[0m`);
    emit({ from: { origin: from, path: PATH }, to: { origin: to, path: toPath }, sourceLag: before.wouldHaveLost, seeded });
    return seeded.ok ? 0 : 4;
  }

  if (verb === "mirror") {
    if (!PATH) die("--path is required");
    const origin = opt("--origin") || die("--origin is required");
    const m = await readMirror({ origin, path: PATH });
    log(`mirror: ${m.summary.empty ? "nothing" : plural(m.summary.nodes, "node")}`);
    emit(m);
    return 0;
  }

  console.error(USAGE);
  return 1;
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("board-snapshot.mjs");
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      if (e instanceof SnapshotError) {
        die(`${e.code}: ${e.message}${e.detail ? `\n  ${JSON.stringify(e.detail)}` : ""}`, e.code === "unstable" ? 3 : 2);
      }
      die(e && e.stack ? e.stack : String(e), 2);
    });
}
