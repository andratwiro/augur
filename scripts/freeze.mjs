#!/usr/bin/env node
/**
 * augur freeze — make a workspace read-only while it is being moved.
 *
 *   augur freeze [--reason "…"]     stop accepting writes
 *   augur freeze --status           is it frozen, and since when
 *   augur thaw                      accept writes again, and print how long it lasted
 *
 * `MIG-cutover-freeze`. Moving a workspace is export → verify → cut the hostname over, and
 * anything written to the OLD instance inside that window goes to a copy nobody will ever
 * read again. Not lost noisily — lost the way a comment is lost when somebody posts it,
 * watches it appear, and comes back tomorrow to a page that never had it.
 *
 * ONLY WRITES STOP. The other way to do this is pulling the route or the DNS record, which
 * is simpler and takes READS down too: on a real workspace the copy and the verification
 * are minutes, and minutes of dark site looks like an outage to everybody who is not
 * migrating. Here the site stays up, a reader sees what was there, and somebody who tries
 * to change something is told rather than quietly ignored. Signing in still works, because
 * whoever is watching the migration has to be able to get in and look.
 *
 * THE DURATION IS THE POINT OF `thaw` PRINTING IT. A migration has to publish how long its
 * window actually was — an instance being moved for somebody else has people planning
 * around that number, and "about ten minutes" from memory is not a number.
 */
import { target, apiClient } from "./lib/store.mjs";

const log = (m) => console.error(`\x1b[36m[freeze]\x1b[0m ${m}`);
const die = (m) => { log(m); process.exit(1); };

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
// `augur thaw` and `augur freeze --thaw` are the same thing; the CLI exposes both because
// one of them is what somebody types under pressure.
const THAW = flag("--thaw") || /thaw/.test(process.env.AUGUR_CMD || "") || args[0] === "thaw";
const STATUS = flag("--status");

let origin, token;
try { ({ origin, token } = target()); } catch (e) { die(e.message); }
const req = apiClient(origin, token);

const fmt = (ms) => {
  if (ms == null) return "unknown";
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

if (STATUS) {
  const { freeze } = await (await req("_state/freeze")).json();
  if (!freeze) { console.log(`${origin}  accepting writes`); process.exit(0); }
  console.log(`${origin}  FROZEN since ${freeze.at} — ${freeze.reason}`
    + `  (${fmt(Date.now() - Date.parse(freeze.at))} so far)`);
  process.exit(0);
}

const res = await (await req("_state/freeze", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(THAW
    ? { thaw: true }
    : { reason: opt("--reason") || "being moved to a new home" }),
})).json();

if (!res.ok) die(`${origin} refused: ${res.reason}`);

if (THAW) {
  log(`\x1b[32mthawed\x1b[0m — writes are accepted again`);
  console.log(`${origin}  frozen for ${fmt(res.durationMs)}`);
  console.log("\x1b[2mpublish that number with the migration — somebody planned around it\x1b[0m");
} else {
  log(`\x1b[33mfrozen\x1b[0m since ${res.since} — ${res.reason}`);
  console.log(`${origin}  reads unaffected; every write is refused with a 503 that says why`);
  console.log("\x1b[2mrun `augur thaw` when the cutover is done — nothing lifts this on its own\x1b[0m");
}
