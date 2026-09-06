#!/usr/bin/env node
// augur hook <pre|post|install|remove|status>
//
// `pre` and `post` are what an agent tool runs around every file edit, with the tool's own
// JSON on stdin (docs/drafts-that-land.md §7). Both answer with an exit code: 0 lets the
// edit through, 2 refuses it and puts one sentence on stderr for the agent to read in its
// next tool result. NOTHING ELSE EXITS NON-ZERO: an unreadable payload, a missing
// registry, an exception — every accident exits 0 and says nothing, because the hook is
// installed machine-wide and a bug here would take every editor down with it.
//
//   pre    refuse a write into a read-only copy, or into a shared checkout's prototype
//   post   save the draft the edited file belongs to; refused saves fail with the reason
//
// `install|remove|status` manage the adapters — `augur open` installs them once.
import fs from "node:fs";
import { ADAPTERS, denyDecision, saveDecision, installAdapters, removeAdapters } from "./lib/adapters.mjs";
import { registryList, readState, unitClient, doSave } from "./lib/draft.mjs";
import { resolveToken } from "./lib/store.mjs";

const event = process.argv[2];
const refuse = (m) => { process.stderr.write(m + "\n"); process.exit(2); };

if (event === "install" || event === "remove" || event === "status") {
  const rows = event === "install" ? installAdapters() : event === "remove" ? removeAdapters() : installAdapters({ dryRun: true });
  for (const r of rows) {
    const verdict = event === "status" ? (r.result === "unchanged" ? "installed" : r.result === "absent" ? "absent" : "not installed") : r.result;
    console.log(`${r.name}: ${verdict}${r.path ? ` (${r.path})` : ""}`);
  }
  process.exit(0);
}
if (event !== "pre" && event !== "post") {
  console.error("usage: augur hook <pre|post|install|remove|status>");
  process.exit(1);
}
if (process.env.AUGUR_HOOKS_OFF) process.exit(0);

let payload = null;
try { payload = JSON.parse(fs.readFileSync(0, "utf8")); } catch (e) { process.exit(0); }
const adapter = ADAPTERS.find((a) => a.id === (process.env.AUGUR_ADAPTER || ADAPTERS[0].id)) || ADAPTERS[0];
let p;
try { p = adapter.payload(payload); } catch (e) { process.exit(0); }
let registry = [];
try { registry = registryList(); } catch (e) { registry = []; }

if (event === "pre") {
  let d;
  try { d = denyDecision({ filePath: p.filePath, cwd: p.cwd, registry }); } catch (e) { process.exit(0); }
  if (d && d.deny) refuse(d.reason);
  process.exit(0);
}

// post
let target;
try { target = saveDecision({ filePath: p.filePath, cwd: p.cwd, registry }); } catch (e) { process.exit(0); }
if (!target) process.exit(0);
const st = readState(target.dir);
if (!st) process.exit(0);
const origin = st.origin;
// `AUGUR_TOKEN` set — even to nothing — is the answer; otherwise the saved tokens.
const token = process.env.AUGUR_TOKEN !== undefined ? process.env.AUGUR_TOKEN : resolveToken(origin);
if (!token) refuse(`draft ${st.draftId} not saved: no publish token for ${origin} — run augur connect once, then save with augur save.`);
const client = unitClient({ origin, token, space: st.space, session: st.session });
const r = await doSave({ client, dir: target.dir });
if (r.ok) process.exit(0);
if (r.error === "stale-draft" || r.error === "stale-draft-revision") refuse(`draft ${st.draftId} not saved: it moved under you (another process saved to it) — run augur sync, then augur save.`);
if (r.error === "draft-closed") refuse(`draft ${st.draftId} not saved: it was ${r.landed ? `landed by ${r.name || r.by || "someone"}${r.session ? ` (${r.session})` : ""} at ${r.at}` : "discarded"} — this folder is no longer a draft. Your edits are still here; run augur open on the prototype again and copy them in.`);
if (r.error === "network") refuse(`draft ${st.draftId} not saved: ${origin} is unreachable (${r.message}). Nothing is lost — the next save carries every change since.`);
refuse(`draft ${st.draftId} not saved: ${r.error || r.status}${r.reason ? ` (${r.reason})` : ""}${r.message ? ` — ${r.message}` : ""}. Fix it and run augur save.`);
