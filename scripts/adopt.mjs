// adopt.mjs — copy an instance's KV state into its workspace Durable Object.
//
//   augur adopt                  against the origin in this folder's config
//   AUGUR_ORIGIN=<url> augur adopt   against a named instance
//   … --dry-run                  read the export, report what would be copied, write nothing
//
// `B-kv-to-do-migration-tool`. Phase one of moving off shared KV, and the whole of it is a
// COPY: the object ends up holding a second, faithful copy of every family the inventory
// sends it, and NOTHING READS IT. Cutting the reads over is `B-kv-read-cutover`, separately,
// one family at a time.
//
// ⚠️ IT IS NOT CALLED `migrate`, AND THAT IS NOT A NAMING QUIBBLE. `augur migrate` already
// means something else — move a whole workspace from one instance to another — and a second
// verb one keystroke away from it, run against a live instance, is a trap. This one adopts
// what is already here; it moves nothing and it goes nowhere.
//
// HOW IT WORKS, AND WHY THAT IS SAFE. It asks the instance for its own state
// (`_state/export`) and hands it straight back (`_state/import`). The import writes the
// identity and content families into the workspace object AND writes them to KV exactly as
// it found them — so the KV half is a byte-for-byte rewrite of what was already there, a
// no-op that cannot change what the login gate reads, while the object gains the copy. That
// is what makes this re-runnable: run it twice and the second run leaves what the first did.
//
// It never sends `prune` and never sends `clear`. Both are verbs a RESET needs; a copy that
// could empty a family is not a copy.
import { target, apiClient } from "./lib/store.mjs";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const DRY = flag("--dry-run");

const log = (m) => console.log(`\x1b[35m[adopt]\x1b[0m ${m}`);
const die = (m) => { console.error(`\x1b[31m[adopt]\x1b[0m ${m}`); process.exit(1); };

// `target()` resolves the origin and the token FOR THAT ORIGIN together, which is what
// stops a run against one instance reaching for another's credential. Point it elsewhere
// with AUGUR_ORIGIN, the same way every other command here does.
let origin, token;
try { ({ origin, token } = target()); } catch (e) { die(e.message); }

const req = apiClient(origin, token);

log(`${origin}${DRY ? "  (dry run)" : ""}`);

let doc;
try {
  doc = await (await req("_state/export")).json();
} catch (e) {
  die(`could not read this instance's state: ${e.message}\n  A star-scope token is required — a space-scoped one is refused here on purpose.`);
}

// An export that could not read a family is not a copy to hand back. `importState` refuses
// it too; failing here means the operator hears WHY rather than reading a rejection.
if (Array.isArray(doc.failed) && doc.failed.length) {
  die(`this instance could not export ${doc.failed.length} famil(y/ies): ${doc.failed.map((f) => f && f.id).join(", ")}\n  Nothing was written. Fix the read before copying, or the copy is short and nothing says so.`);
}

const families = Object.keys(doc.families || {});
log(`${families.length} famil(y/ies), ${(doc.assets || []).length} canvas image(s)`);

if (DRY) {
  for (const id of families.sort()) {
    const v = doc.families[id];
    const n = v && typeof v === "object" ? Object.keys(v).length : 1;
    console.log(`  ${id.padEnd(20)} ${n} entr${n === 1 ? "y" : "ies"}`);
  }
  log("dry run — nothing written. Re-run without --dry-run to copy.");
  process.exit(0);
}

// Deliberately NOT spreading `doc`: an export document carries `clear` and `prune` only if
// something put them there, and a copy must not be able to pick them up by accident.
const body = { format: doc.format, families: doc.families };

const res = await (await req("_state/import", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})).json();

if (!res.ok) die(`the instance refused the copy: ${res.reason || JSON.stringify(res)}`);

if (!res.workspaceObject) {
  die(
    "this instance has NO workspace object bound, so nothing was copied into one.\n" +
    "  KV was rewritten with what it already held, which changes nothing and is not the point.\n" +
    "  Bind TENANTS in the shell's wrangler.toml and run this again.",
  );
}

log(`\x1b[32mcopied\x1b[0m — ${(res.written || []).length} famil(y/ies) into the workspace object${res.atomic ? ", in one transaction" : ""}`);

// Everything below is what the copy could NOT carry. A copy that reports success while
// quietly omitting something is the failure this whole item exists to avoid, so these are
// printed every run rather than only when somebody passes a flag.
for (const s of res.unmapped || []) {
  console.log(`  \x1b[33mnot copied\x1b[0m  ${s.id}\n              ${s.why}`);
}
for (const r of res.refusedRows || []) {
  console.log(`  \x1b[33mrefused\x1b[0m    ${r.family} ${r.key}\n              ${r.why}`);
}
if (!res.atomic) {
  console.log("  \x1b[33mnote\x1b[0m       this runtime has no transactionSync, so the write was ordered rather than atomic");
}

log("nothing reads this copy yet — that is B-kv-read-cutover. Run this again any time; it is a no-op the second time.");
