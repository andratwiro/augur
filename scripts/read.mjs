#!/usr/bin/env node
// augur read <prototype> [--dir <folder>] — a read-only copy of a unit, for context. Lands
// under _read/<unit>/ beside the draft folders; files carry no write bit and the deny hook
// refuses edits there. `augur close` inside it removes it. See docs/drafts-that-land.md §7.
import path from "node:path";
import { target } from "./lib/store.mjs";
import { unitClient, doRead, readDirFor, unitPathFor } from "./lib/draft.mjs";
import { normUnit } from "../src/unit-core.mjs";

const log = (m) => console.error(`\x1b[35m[read]\x1b[0m ${m}`);
const die = (m) => { console.error(`\x1b[31m[read]\x1b[0m ${m}`); process.exit(1); };
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : null; };
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
const raw = positional[0];
if (!raw) die("name a prototype: `augur read <opportunity>/<prototype>`.");
const unit = normUnit(unitPathFor(raw) || raw);
if (!unit) die(`"${raw}" is not a prototype path.`);
let origin, token;
try { ({ origin, token } = target({ needToken: true })); } catch (e) { die(e.message); }
const dir = path.resolve(opt("--dir") || readDirFor(unit));
const client = unitClient({ origin, token, space: "", session: "" });
const r = await doRead({ client, unit, dir, origin, now: new Date().toISOString() });
if (!r.ok) {
  if (r.error === "folder-not-empty") die(`${r.dir} is not empty — pick another folder with --dir.`);
  if (r.error === "units-not-configured") die("this instance does not serve drafts yet (no unit store bound).");
  die(`could not read: ${r.error || r.status}${r.reason ? ` (${r.reason})` : ""}`);
}
log(`${r.files} file(s) of ${unit} at revision ${r.revision}, read-only`);
console.log(dir);
