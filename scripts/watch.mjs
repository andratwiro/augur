#!/usr/bin/env node
// augur watch — save this draft folder on every burst of changes, until Ctrl-C. For people
// editing by hand in an editor that runs no hooks. See docs/drafts-that-land.md §7.
import { resolveOrigin, resolveToken } from "./lib/store.mjs";
import { readState, unitClient, doSave, watchFolder } from "./lib/draft.mjs";

const log = (m) => console.error(`\x1b[35m[watch]\x1b[0m ${m}`);
const die = (m) => { console.error(`\x1b[31m[watch]\x1b[0m ${m}`); process.exit(1); };
const dir = process.cwd();
const st = readState(dir);
if (!st) die("not a draft folder — run `augur open <prototype>` first.");
const origin = st.origin || resolveOrigin();
const token = resolveToken(origin);
if (!token) die("no publish token — run `augur connect` once.");
const client = unitClient({ origin, token, space: st.space, session: st.session });
let running = false, again = false;
async function save() {
  if (running) { again = true; return; }
  running = true;
  try {
    const r = await doSave({ client, dir });
    if (!r.ok) log(`save refused: ${r.error || r.status}${r.error === "stale-draft" ? " — run `augur sync`" : ""}`);
    else if (r.changed.length) log(`${r.changed.length} file(s) live at ${origin}${st.address}`);
  } finally {
    running = false;
    if (again) { again = false; save(); }
  }
}
log(`watching ${dir} — live at ${origin}${st.address} (Ctrl-C to stop)`);
const w = watchFolder(dir, save);
process.on("SIGINT", () => { w.close(); process.exit(0); });
await save();
