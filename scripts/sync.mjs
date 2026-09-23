#!/usr/bin/env node
// augur sync — fold what landed on main since this draft opened into the draft. One-sided
// changes are taken; a file changed on both sides is merged where the lines do not overlap
// and left to you where they do (theirs is written under .augur/theirs/). Nothing is guessed.
// While an overlap is open the draft stays on its old base, so nothing can land past it;
// delete a theirs file once you have folded it, and `augur land` finishes the move.
import { resolveOrigin, tokenOrPair } from "./lib/store.mjs";
import { readState, unitClient, doSync, THEIRS_DIR } from "./lib/draft.mjs";

const log = (m) => console.error(`\x1b[35m[sync]\x1b[0m ${m}`);
const die = (m) => { console.error(`\x1b[31m[sync]\x1b[0m ${m}`); process.exit(1); };
const dir = process.cwd();
const st = readState(dir);
if (!st) die("not a draft folder — run `augur open <prototype>` first.");
const origin = st.origin || resolveOrigin();
let token;
try { token = await tokenOrPair(origin); } catch (e) { die(e.message); }
const client = unitClient({ origin, token, space: st.space, session: st.session });
const r = await doSync({ client, dir });
if (!r.ok && r.error === "draft-closed") die(`this draft was ${r.landed ? `landed by ${r.name || r.by || "someone"}${r.session ? ` (${r.session})` : ""} at ${r.at}` : "discarded"} — the folder is no longer a draft. Your edits are still here; run augur open on the prototype again and redo in it only what you had not saved by then — copying whole files over would undo anything landed since.`);
if (!r.ok && r.error === "network") die(`could not reach the instance (${r.message}). Nothing is lost — run augur sync again.`);
if (!r.ok) die(`sync refused: ${r.error || r.status}${r.message ? ` — ${r.message}` : ""}`);
for (const f of r.taken) log(`took theirs   ${f}`);
for (const f of r.merged) log(`merged        ${f}`);
for (const c of r.conflicts) {
  log(`OVERLAP       ${c.rel} — yours stays in place, theirs is at ${THEIRS_DIR}/${c.rel}`);
  for (const h of c.hunks) log(`  lines ${h.baseStart + 1}-${h.baseEnd}: yours ${JSON.stringify(h.mine.join("\n")).slice(0, 80)} · theirs ${JSON.stringify(h.theirs.join("\n")).slice(0, 80)}`);
}
if (r.conflicts.length) {
  log(`fold each overlap into your file and delete its ${THEIRS_DIR}/ copy — that is how you say it is folded. Until then nothing can land this draft, from here or from the site.`);
  log(`then check the draft address and \`augur land\` — it moves the draft onto revision ${r.mainRevision} and lands.`);
} else {
  log(`draft now based on revision ${r.mainRevision} — check the draft address, then land`);
}
console.log(`${origin}${st.address}`);
if (r.conflicts.length) process.exit(2);
