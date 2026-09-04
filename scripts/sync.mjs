#!/usr/bin/env node
// augur sync — fold what landed on main since this draft opened into the draft. One-sided
// changes are taken; a file changed on both sides is merged where the lines do not overlap
// and left to you where they do (theirs is written under .augur/theirs/). Nothing is guessed.
import { resolveOrigin, resolveToken } from "./lib/store.mjs";
import { readState, unitClient, doSync, THEIRS_DIR } from "./lib/draft.mjs";

const log = (m) => console.error(`\x1b[35m[sync]\x1b[0m ${m}`);
const die = (m) => { console.error(`\x1b[31m[sync]\x1b[0m ${m}`); process.exit(1); };
const dir = process.cwd();
const st = readState(dir);
if (!st) die("not a draft folder — run `augur open <prototype>` first.");
const origin = st.origin || resolveOrigin();
const token = resolveToken(origin);
if (!token) die("no publish token — run `augur connect` once.");
const client = unitClient({ origin, token, space: st.space, session: st.session });
const r = await doSync({ client, dir });
if (!r.ok) die(`sync refused: ${r.error || r.status}`);
for (const f of r.taken) log(`took theirs   ${f}`);
for (const f of r.merged) log(`merged        ${f}`);
for (const c of r.conflicts) {
  log(`OVERLAP       ${c.rel} — yours stays in place, theirs is at ${THEIRS_DIR}/${c.rel}`);
  for (const h of c.hunks) log(`  lines ${h.baseStart + 1}-${h.baseEnd}: yours ${JSON.stringify(h.mine.join("\n")).slice(0, 80)} · theirs ${JSON.stringify(h.theirs.join("\n")).slice(0, 80)}`);
}
log(`draft now based on revision ${r.mainRevision}${r.conflicts.length ? " — fold the overlaps in, check the draft address, then land" : " — check the draft address, then land"}`);
console.log(`${origin}${st.address}`);
if (r.conflicts.length) process.exit(2);
