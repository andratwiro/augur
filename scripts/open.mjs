#!/usr/bin/env node
// augur open <prototype> [--new] [--new-opportunity] [--draft <id>] [--dir <folder>] [--session <label>]
//
// Open one prototype into a folder of its own, as a draft that is live at once at its own
// address. Prints who else is drafting it. The folder holds only that prototype's files and
// a `.augur/draft.json`; nothing else on this machine is shared with any other session.
// `--draft <id>` picks up a draft that is already open (its folder gone, or on another
// machine) instead of starting a new one: its saved files, its base, its address.
// See docs/drafts-that-land.md §4.
import fs from "node:fs";
import path from "node:path";
import { targetPaired, tokenOrPair, buildStamp } from "./lib/store.mjs";
import { unitClient, doOpen, doAdopt, unitPathFor } from "./lib/draft.mjs";
import { installAdapters, augurOnPath } from "./lib/adapters.mjs";
import { normUnit } from "../src/unit-core.mjs";
import { positionals } from "./lib/cli-args.mjs";

const log = (m) => console.error(`\x1b[35m[open]\x1b[0m ${m}`);
const die = (m) => { console.error(`\x1b[31m[open]\x1b[0m ${m}`); process.exit(1); };
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : null; };
// `--new` and `--new-opportunity` take no value, so the unit may stand on either side of them.
const positional = positionals(argv, ["--dir", "--session", "--origin", "--draft"]);

const raw = positional[0];
if (!raw) die("name a prototype: `augur open <opportunity>/<prototype>` (a folder path works too).");
const unit = normUnit(unitPathFor(raw) || raw);
if (!unit) die(`"${raw}" is not a prototype path.`);
let origin, token;
try { ({ origin, token } = await targetPaired({ needToken: true })); } catch (e) { die(e.message); }
// The space id addresses blob uploads. A folder with a space.json names it; otherwise the
// instance's own build stamp does (one workspace serves one space).
let space = null;
try { space = JSON.parse(fs.readFileSync("space.json", "utf8")).id; } catch (e) { /* not in a space folder */ }
if (!space) { try { space = Object.keys((await buildStamp(origin)).spaces || {})[0] || null; } catch (e) { /* stamp unreachable */ } }
if (!space) die("could not tell which space this instance serves — run from a folder with space.json, or set AUGUR_ORIGIN.");
const session = process.env.AUGUR_SESSION || opt("--session") || `session-${process.pid}`;
const dir = path.resolve(opt("--dir") || unit.split("/").filter(Boolean).pop());

let client = unitClient({ origin, token, space, session });
const isNew = argv.includes("--new");
const allowNewOpportunity = argv.includes("--new-opportunity");
const adoptId = opt("--draft");
if (adoptId !== null && !/^[a-z0-9]{6}$/.test(adoptId)) die(`--draft takes a draft id, six letters and digits (the part after @ in the draft's address).`);
if (adoptId && isNew) die("--draft picks up an open draft of a prototype that exists; it does not go with --new.");
const attempt = () => adoptId
  ? doAdopt({ client, unit, draftId: adoptId, dir, origin, space, session, now: new Date().toISOString() })
  : doOpen({ client, unit, dir, origin, space, session, now: new Date().toISOString(), isNew, allowNewOpportunity });
let r = await attempt();
// A token the workspace refuses is not a question for the person either: pair afresh, once,
// and try again. Only when that cannot happen here does the refusal reach the screen.
if (!r.ok && r.error === "forbidden") {
  try { token = await tokenOrPair(origin, { again: true, why: `this machine's token is not accepted by ${origin}` }); client = unitClient({ origin, token, space, session }); r = await attempt(); }
  catch (e) { die(e.message); }
}
if (!r.ok) {
  if (r.error === "folder-not-empty") die(`${r.dir} is not empty — pick another folder with --dir.`);
  if (r.error === "unknown-draft") die(`no open draft ${adoptId} on ${unit} — it was discarded, or the id is wrong (it is the part after @ in the draft's address).`);
  if (r.error === "draft-closed") die(`draft ${adoptId} was landed at ${r.at} — it is live; \`augur open ${unit.replace(/^\/|\/$/g, "")}\` starts a new one.`);
  if (r.error === "adopt-unsupported") die("this instance cannot hand an open draft over yet (its engine predates `open --draft`).");
  if (r.error === "unknown-unit") die(`${unit} does not exist here. To create it: \`augur open --new ${unit.replace(/^\/|\/$/g, "")}\`.`);
  if (r.error === "unit-exists") die(`${unit} exists already — open it without --new.`);
  if (r.error === "unslugged-unit") die(`prototype paths are lowercase letters, digits and dashes — try \`augur open --new ${r.slug}\`.`);
  if (r.error === "unknown-opportunity") die(`no opportunity "${r.opportunity}" here — \`augur ls\` lists them; \`--new-opportunity\` creates one.`);
  if (r.error === "units-not-configured") die("this instance does not serve drafts yet (no unit store bound).");
  if (r.error === "bad-unit" && r.reason === "reserved-folder") die(`${unit} sits under a folder the engine reserves — a prototype lives at <opportunity>/<prototype>.`);
  if (r.error === "bad-unit" && r.reason === "not-a-prototype-folder") die(`${unit} is not a prototype folder — name one as <opportunity>/<prototype>.`);
  if (r.error === "network") die(`could not reach the instance (${r.message}).`);
  die(`could not open: ${r.error || r.status}${r.reason ? ` (${r.reason})` : ""}${r.message ? ` — ${r.message}` : ""}`);
}
if (adoptId) {
  log(`picked up draft ${r.draftId} on ${unit}${r.name ? ` (${r.name}'s)` : ""} — ${r.files} file(s) in ${dir}, as last saved${r.lastSaveAt ? ` at ${r.lastSaveAt}` : ""}; based on revision ${r.baseRevision}.`);
  log("if anything landed since, `augur land` says so and `augur sync` folds it in — never copy files over from elsewhere, that would undo it.");
} else log(r.isNew ? `draft ${r.draftId} on ${unit} — a NEW prototype; ${dir} is empty, write its index.html there` : `draft ${r.draftId} on ${unit} — ${r.files} file(s) in ${dir}`);
// The agent tool's hooks, installed for THIS folder (its project-local settings) the first
// time a draft is opened from here — never account-wide (idempotent; `AUGUR_NO_ADAPTERS=1`
// skips it — the suite and CI set it).
if (!process.env.AUGUR_NO_ADAPTERS) {
  for (const a of installAdapters()) {
    if (a.result === "installed") log(`${a.name}: a save hook is now in ${a.path} — for this folder only, nothing account-wide. After each edit inside a draft folder here it runs \`augur hook post\`, which saves that draft to ${origin}; before an edit it refuses writes into a shared checkout's prototypes. It does nothing else and talks to nothing else; \`augur hook remove\` run here takes it out.`);
    else if (a.result === "updated") log(`${a.name}: editor hooks updated (${a.path}).`);
    if (a.movedFrom) log(`${a.name}: an older machine-wide entry in ${a.movedFrom} was removed; the hook lives with the folder now.`);
  }
}
if (r.others && r.others.length) {
  log("also drafting this prototype right now:");
  for (const o of r.others) log(`  ${o.session || "someone"} (${o.active ? "active" : "idle"})`);
  log("nothing here stops you; if you both land, the second one syncs first.");
}
// The next two steps, spelled so they run from this machine (`augur` only after a global
// install; the package's `npx` line otherwise).
const verb = augurOnPath() ? "augur" : "npx @augurworks/augur";
log(r.isNew
  ? `next: write ${path.join(dir, "index.html")} (self-contained static HTML); it is live at the address below as soon as it saves. When it is ready: \`cd ${path.basename(dir)} && ${verb} land\` — the last line printed is the live URL.`
  : `next: edit the files in ${dir}; every save is live at the address below. When it is ready: \`cd ${path.basename(dir)} && ${verb} land\` — the last line printed is the live URL.`);
console.log(r.address);
