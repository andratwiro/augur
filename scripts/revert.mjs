#!/usr/bin/env node
// augur revert <prototype> [--to <revision>] [-m "why"] [--list] — put a prototype back to
// an earlier landing. Without --to, the landing before the newest one ("undo the last
// landing"). The revert is itself a landing, so history keeps the bad one and says what put
// it back; revert again to undo the revert. --list prints the landings, newest first.
import fs from "node:fs";
import { targetPaired, buildStamp } from "./lib/store.mjs";
import { unitClient, unitPathFor } from "./lib/draft.mjs";
import { doRevert, historyLines } from "./lib/revert.mjs";
import { normUnit } from "../src/unit-core.mjs";

const log = (m) => console.error(`\x1b[35m[revert]\x1b[0m ${m}`);
const die = (m) => { console.error(`\x1b[31m[revert]\x1b[0m ${m}`); process.exit(1); };
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : null; };
const positional = argv.filter((a, i) => !a.startsWith("-") && !(i > 0 && argv[i - 1].startsWith("-")));
const raw = positional[0];
if (!raw) die("name a prototype: `augur revert <opportunity>/<prototype>` (add --list to see its landings).");
const unit = normUnit(unitPathFor(raw) || raw);
if (!unit) die(`"${raw}" is not a prototype path.`);
let origin, token;
try { ({ origin, token } = await targetPaired({ needToken: true })); } catch (e) { die(e.message); }
let space = null;
try { space = JSON.parse(fs.readFileSync("space.json", "utf8")).id; } catch (e) { /* not in a space folder */ }
if (!space) { try { space = Object.keys((await buildStamp(origin)).spaces || {})[0] || null; } catch (e) { /* stamp unreachable */ } }
if (!space) die("could not tell which space this instance serves — run from a folder with space.json, or set AUGUR_ORIGIN.");
const client = unitClient({ origin, token, space, session: "revert" });

if (argv.includes("--list")) {
  const h = await client.history(unit);
  if (h.status) die(`could not read the history: ${h.error || h.status}${h.message ? ` — ${h.message}` : ""}`);
  const lines = historyLines(h);
  if (!lines.length) die(`${unit} has no landings yet.`);
  for (const l of lines) console.log(l);
  process.exit(0);
}

const r = await doRevert({ client, unit, to: opt("--to"), note: opt("-m") });
if (!r.ok) {
  if (r.error === "nothing-before") die(`${unit} has only one landing — there is nothing before it to put back.`);
  if (r.error === "already-live") die(`revision ${opt("--to")} is what ${unit} serves now.`);
  if (r.error === "unknown-revision") die(`${unit} has no landing ${opt("--to")} — see \`augur revert ${raw} --list\`.`);
  if (r.error === "no-landings") die(`${unit} has no landings yet.`);
  if (r.error === "landing-in-progress") die("somebody is landing this prototype right now — try again in a few seconds.");
  if (r.error === "network") die(`could not reach the instance (${r.message}). Nothing changed.`);
  die(`revert refused: ${r.error || r.status}${r.message ? ` — ${r.message}` : ""}`);
}
log(`${unit} is back to revision ${r.to} (was ${r.from})${r.recorded === false ? " — live, but its history entry is missing" : `, recorded as revision ${r.revision}`}`);
console.log(r.url);
