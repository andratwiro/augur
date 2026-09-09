#!/usr/bin/env node
// augur close [<folder>] [--discard] — remove a draft folder: the one named, or the one this
// runs in. A landed draft closes freely; an open one is kept unless --discard, which also
// abandons the draft on the instance.
//
// Naming the folder exists for the shell's sake. `close` run INSIDE the folder removes the
// directory the shell is standing in, and the next command from that shell fails before it
// starts (`getcwd: cannot access parent directories`, then a Node stack). From the parent —
// `augur close .drafts/flow` — nothing is pulled from under anyone; and when the folder
// closed IS the shell's, the last line says `cd ..`.
import path from "node:path";
import { resolveOrigin, resolveToken, tokenOrPair } from "./lib/store.mjs";
import { readState, unitClient, doClose } from "./lib/draft.mjs";

const log = (m) => console.error(`\x1b[35m[close]\x1b[0m ${m}`);
const die = (m) => { console.error(`\x1b[31m[close]\x1b[0m ${m}`); process.exit(1); };
const argv = process.argv.slice(2);
const discard = argv.includes("--discard");
const named = argv.find((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
const startedIn = process.cwd();
const dir = path.resolve(startedIn, named || ".");
const shellsOwn = path.resolve(startedIn) === dir || path.resolve(startedIn).startsWith(dir + path.sep);
const cdHint = () => { if (shellsOwn) log("that was this shell's folder — `cd ..` before the next command."); };
const st = readState(dir);
if (!st) {
  // A read-only copy has no state file; doClose recognises it from the registry.
  process.chdir(path.dirname(dir));
  const r = await doClose({ client: {}, dir, discard: false });
  if (!r.ok) die(named ? `${named} is not a draft folder — nothing to close there.` : "not a draft folder — nothing to close here.");
  log("read-only copy removed"); cdHint();
  process.exit(0);
}
const origin = st.origin || resolveOrigin();
let token = resolveToken(origin);
if (!token && !st.landed) { try { token = await tokenOrPair(origin); } catch (e) { die(e.message); } }
const client = unitClient({ origin, token, space: st.space, session: st.session });
process.chdir(path.dirname(dir));
const r = await doClose({ client, dir, discard });
if (!r.ok) {
  if (r.error === "draft-still-open") die(`draft ${r.draftId} has not landed — \`augur land\` first, or \`augur close --discard\` to abandon it (it stays on the instance for a while).`);
  die(`close refused: ${r.error || r.status}`);
}
log(r.discarded ? "draft abandoned and folder removed" : "folder removed");
cdHint();
