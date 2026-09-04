#!/usr/bin/env node
// augur save — push every changed file in this draft folder. Live at the draft address on
// return. Exit 1 with the reason when the instance refuses. See docs/drafts-that-land.md §4.
import { resolveOrigin, resolveToken } from "./lib/store.mjs";
import { readState, unitClient, doSave } from "./lib/draft.mjs";

const die = (m) => { console.error(`\x1b[31m[save]\x1b[0m ${m}`); process.exit(1); };
const dir = process.cwd();
const st = readState(dir);
if (!st) die("not a draft folder — run `augur open <prototype>` first.");
const origin = st.origin || resolveOrigin();
const token = resolveToken(origin);
if (!token) die("no publish token — run `augur connect` once.");
const client = unitClient({ origin, token, space: st.space, session: st.session });
const r = await doSave({ client, dir });
if (!r.ok) {
  if (r.error === "stale-draft" || r.error === "stale-draft-revision") die("this draft moved under you (another process saved to it) — run `augur sync`.");
  die(`save refused: ${r.error || r.status}`);
}
if (r.changed.length) console.error(`\x1b[35m[save]\x1b[0m ${r.changed.length} file(s) live at ${origin}${st.address}`);
console.log(`${origin}${st.address}`);
