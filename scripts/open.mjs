#!/usr/bin/env node
// augur open <prototype> [--dir <folder>] [--session <label>]
//
// Open one prototype into a folder of its own, as a draft that is live at once at its own
// address. Prints who else is drafting it. The folder holds only that prototype's files and
// a `.augur/draft.json`; nothing else on this machine is shared with any other session.
// See docs/drafts-that-land.md §4.
import fs from "node:fs";
import path from "node:path";
import { target, buildStamp } from "./lib/store.mjs";
import { markPathFor } from "./lib/marks.mjs";
import { unitClient, doOpen } from "./lib/draft.mjs";
import { normUnit } from "../src/unit-core.mjs";

const log = (m) => console.error(`\x1b[35m[open]\x1b[0m ${m}`);
const die = (m) => { console.error(`\x1b[31m[open]\x1b[0m ${m}`); process.exit(1); };
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : null; };
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));

const raw = positional[0];
if (!raw) die("name a prototype: `augur open <opportunity>/<prototype>` (a folder path works too).");
const unit = normUnit(markPathFor(raw) || raw);
if (!unit) die(`"${raw}" is not a prototype path.`);
let origin, token;
try { ({ origin, token } = target({ needToken: true })); } catch (e) { die(e.message); }
// The space id addresses blob uploads. A folder with a space.json names it; otherwise the
// instance's own build stamp does (one workspace serves one space).
let space = null;
try { space = JSON.parse(fs.readFileSync("space.json", "utf8")).id; } catch (e) { /* not in a space folder */ }
if (!space) { try { space = Object.keys((await buildStamp(origin)).spaces || {})[0] || null; } catch (e) { /* stamp unreachable */ } }
if (!space) die("could not tell which space this instance serves — run from a folder with space.json, or set AUGUR_ORIGIN.");
const session = process.env.AUGUR_SESSION || opt("--session") || `session-${process.pid}`;
const dir = path.resolve(opt("--dir") || unit.split("/").filter(Boolean).pop());

const client = unitClient({ origin, token, space, session });
const r = await doOpen({ client, unit, dir, origin, space, session, now: new Date().toISOString() });
if (!r.ok) {
  if (r.error === "folder-not-empty") die(`${r.dir} is not empty — pick another folder with --dir.`);
  if (r.error === "units-not-configured") die("this instance does not serve drafts yet (no unit store bound).");
  die(`could not open: ${r.error || r.status}`);
}
log(`draft ${r.draftId} on ${unit} — ${r.files} file(s) in ${dir}`);
if (r.others.length) {
  log("also drafting this prototype right now:");
  for (const o of r.others) log(`  ${o.session || "someone"} (${o.active ? "active" : "idle"})`);
  log("nothing here stops you; if you both land, the second one syncs first.");
}
console.log(r.address);
