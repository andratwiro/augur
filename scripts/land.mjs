#!/usr/bin/env node
// augur land [-m "note"] [--no-poster] — replace the prototype's main with this draft. A
// prototype carrying criteria (oracle/) is checked by their runner first, when present. The
// real URL moves; its address is the last line of stdout. Refused when main moved since the
// draft opened: then `augur sync`, check the draft address, and land again. On the way up
// the folder's card picture (preview.webp) is shot when this machine has the tools for it
// and the source is newer than the poster — the gallery renders nothing for a prototype
// without one. See docs/drafts-that-land.md.
import { resolveOrigin, tokenOrPair } from "./lib/store.mjs";
import { readState, unitClient, doLand, reportSkipped, THEIRS_DIR } from "./lib/draft.mjs";
import { posterFor } from "./lib/poster.mjs";
import { criteriaGate } from "./lib/criteria-gate.mjs";

const log = (m) => console.error(`\x1b[35m[land]\x1b[0m ${m}`);
const die = (m) => { console.error(`\x1b[31m[land]\x1b[0m ${m}`); process.exit(1); };
const argv = process.argv.slice(2);
const i = argv.indexOf("-m");
let note = i > -1 ? argv[i + 1] || "" : "";
const dir = process.cwd();
const st = readState(dir);
if (!st) die("not a draft folder — run `augur open <prototype>` first.");
const origin = st.origin || resolveOrigin();
let token;
try { token = await tokenOrPair(origin); } catch (e) { die(e.message); }
let client = unitClient({ origin, token, space: st.space, session: st.session });
// The prototype's own criteria, when it carries them and this machine has their runner.
const gate = criteriaGate(dir, { log });
if (!gate.ok && gate.why === "runner-failed") die("landing refused: the criteria runner broke before it could answer (above), so nothing was checked. Fix what broke it and land again. Only a person may land past it, with AUGUR_SKIP_CRITERIA=1.");
if (!gate.ok) die("landing refused: a criterion that held at the last landing fails now (above). Fix it, or ask the person, and land again.");
// An unchecked landing says so in its own history entry, where the person reading the
// prototype's history will see it — not only in this terminal.
if (gate.unchecked) note = note ? `${note} — ${gate.unchecked}` : gate.unchecked;
// The picture first, so the save inside `land` carries it. A skip is said and never fatal.
const poster = await posterFor(dir, { log, enabled: !argv.includes("--no-poster") });
if (poster.shot) log("poster shot — preview.webp goes up with the landing");
else if (poster.skipped !== "current" && poster.skipped !== "disabled") log(`no poster (${poster.skipped}): ${poster.why}`);
let r = await doLand({ client, dir, note });
// A refused token pairs afresh, once, and lands again — see open.mjs.
if (!r.ok && r.error === "forbidden") {
  try { token = await tokenOrPair(origin, { again: true, why: `this machine's token is not accepted by ${origin}` }); client = unitClient({ origin, token, space: st.space, session: st.session }); r = await doLand({ client, dir, note }); }
  catch (e) { die(e.message); }
}
if (!r.ok) {
  if (r.error === "overlaps-open") {
    log("the last sync left these where both sides changed the same lines — landing now would drop the other side's:");
    for (const f of r.overlaps) log(`  ${f}   (theirs: ${THEIRS_DIR}/${f})`);
    die(`fold each one into your file, delete its ${THEIRS_DIR}/ copy (that is how you say it is folded), check the draft address, then \`augur land\` again.`);
  }
  if (r.error === "main-moved") {
    log(`main moved since this draft opened (now revision ${r.mainRevision}):`);
    for (const c of r.changed || []) log(`  changed  ${c.path}${c.by ? `  by ${c.by}` : ""}`);
    for (const p of r.removed || []) log(`  removed  ${p}`);
    die("run `augur sync` to fold those in, check the draft address, then `augur land` again.");
  }
  if (r.error === "landing-in-progress") die("somebody is landing this prototype right now — try again in a few seconds.");
  if (r.error === "manifest-contended") die("the workspace was busy landing other prototypes — nothing changed; run augur land again.");
  if (r.error === "draft-closed") die(`this draft was ${r.landed ? `landed by ${r.name || r.by || "someone"}${r.session ? ` (${r.session})` : ""} at ${r.at}` : "discarded"} — the folder is no longer a draft. Your edits are still here; run augur open on the prototype again and redo in it only what you had not saved by then — copying whole files over would undo anything landed since.`);
  if (r.error === "network") die(`could not reach the instance (${r.message}). Nothing is lost — run augur land again.`);
  die(`land refused: ${r.error || r.status}${r.message ? ` — ${r.message}` : ""}`);
}
reportSkipped("land", r.skipped);
// The bytes are live; when `recorded` is false only the history entry is missing. Said out
// loud because the next call adopts that landing as the instance's own, and nobody would
// otherwise know a landing of theirs is not in the record.
if (r.recorded === false) {
  log(`landed (publish v${r.version})`);
  log("this landing is live, but its history entry is missing — the next call adopts it without an author.");
} else {
  log(`landed as revision ${r.revision} (publish v${r.version})`);
}
console.log(r.url);
