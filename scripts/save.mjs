#!/usr/bin/env node
// augur save — push every changed file in this draft folder. Live at the draft address on
// return. Exit 1 with the reason when the instance refuses. See docs/drafts-that-land.md §4.
import { resolveOrigin, tokenOrPair } from "./lib/store.mjs";
import { readState, unitClient, doSave } from "./lib/draft.mjs";

const die = (m) => { console.error(`\x1b[31m[save]\x1b[0m ${m}`); process.exit(1); };
const dir = process.cwd();
const st = readState(dir);
if (!st) die("not a draft folder — run `augur open <prototype>` first.");
const origin = st.origin || resolveOrigin();
let token;
try { token = await tokenOrPair(origin); } catch (e) { die(e.message); }
const client = unitClient({ origin, token, space: st.space, session: st.session });
const r = await doSave({ client, dir });
if (!r.ok) {
  if (r.error === "stale-draft" || r.error === "stale-draft-revision") die("this draft moved under you (another process saved to it) — run `augur sync`.");
  if (r.error === "draft-closed") die(`this draft was ${r.landed ? `landed by ${r.name || r.by || "someone"}${r.session ? ` (${r.session})` : ""} at ${r.at}` : "discarded"} — the folder is no longer a draft. Your edits are still here; run augur open on the prototype again and copy them in.`);
  if (r.error === "network") die(`could not reach the instance (${r.message}). Nothing is lost — the next save carries every change since.`);
  die(`save refused: ${r.error || r.status}${r.message ? ` — ${r.message}` : ""}`);
}
if (r.changed.length) console.error(`\x1b[35m[save]\x1b[0m ${r.changed.length} file(s) live at ${origin}${st.address}`);
console.log(`${origin}${st.address}`);
