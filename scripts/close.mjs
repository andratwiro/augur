#!/usr/bin/env node
// augur close [--discard] — remove this draft folder. A landed draft closes freely; an open
// one is kept unless --discard, which also abandons the draft on the instance.
import { resolveOrigin, resolveToken } from "./lib/store.mjs";
import { readState, unitClient, doClose } from "./lib/draft.mjs";

const log = (m) => console.error(`\x1b[35m[close]\x1b[0m ${m}`);
const die = (m) => { console.error(`\x1b[31m[close]\x1b[0m ${m}`); process.exit(1); };
const discard = process.argv.includes("--discard");
const dir = process.cwd();
const st = readState(dir);
if (!st) die("not a draft folder — nothing to close here.");
const origin = st.origin || resolveOrigin();
const token = resolveToken(origin);
if (!token && !st.landed) die("no publish token — run `augur connect` once.");
const client = unitClient({ origin, token, space: st.space, session: st.session });
process.chdir("..");
const r = await doClose({ client, dir, discard });
if (!r.ok) {
  if (r.error === "draft-still-open") die(`draft ${r.draftId} has not landed — \`augur land\` first, or \`augur close --discard\` to abandon it (it stays on the instance for a while).`);
  die(`close refused: ${r.error || r.status}`);
}
log(r.discarded ? "draft abandoned and folder removed" : "folder removed");
