#!/usr/bin/env node
// augur land [-m "note"] — replace the prototype's main with this draft. The real URL moves;
// its address is the last line of stdout. Refused when main moved since the draft opened:
// then `augur sync`, check the draft address, and land again. See docs/drafts-that-land.md.
import { resolveOrigin, resolveToken } from "./lib/store.mjs";
import { readState, unitClient, doLand } from "./lib/draft.mjs";

const log = (m) => console.error(`\x1b[35m[land]\x1b[0m ${m}`);
const die = (m) => { console.error(`\x1b[31m[land]\x1b[0m ${m}`); process.exit(1); };
const argv = process.argv.slice(2);
const i = argv.indexOf("-m");
const note = i > -1 ? argv[i + 1] || "" : "";
const dir = process.cwd();
const st = readState(dir);
if (!st) die("not a draft folder — run `augur open <prototype>` first.");
const origin = st.origin || resolveOrigin();
const token = resolveToken(origin);
if (!token) die("no publish token — run `augur connect` once.");
const client = unitClient({ origin, token, space: st.space, session: st.session });
const r = await doLand({ client, dir, note });
if (!r.ok) {
  if (r.error === "main-moved") {
    log(`main moved since this draft opened (now revision ${r.mainRevision}):`);
    for (const c of r.changed || []) log(`  changed  ${c.path}${c.by ? `  by ${c.by}` : ""}`);
    for (const p of r.removed || []) log(`  removed  ${p}`);
    die("run `augur sync` to fold those in, check the draft address, then `augur land` again.");
  }
  if (r.error === "landing-in-progress") die("somebody is landing this prototype right now — try again in a few seconds.");
  die(`land refused: ${r.error || r.status}`);
}
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
