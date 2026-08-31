// restore.mjs — put an `augur export` copy back into a bundle store.
//
//   augur restore <dir>                 every space in the export
//   … --space <id>                      one space
//   … --dry-run                         report what would ship, send nothing
//   … --force                           overwrite live content that is NEWER than the copy
//   … --state                           ALSO replay the workspace state a `--full` export
//                                       carries: roster, invites, publish tokens, statuses,
//                                       card names, boards, comment threads, pins, images
//
// A restore is an ordinary publish: blobs first, then one manifest commit per
// space, so it lands atomically and gets its own version number. It does NOT
// rewrite history — the versions the store already holds stay where they are, and
// the restored state arrives on top. That is deliberate: a restore run by mistake
// is then undone by `rollback`, not by another restore.
//
// ⚠️ AND THE COPY'S OWN HISTORY IS NOT REPLAYED EITHER. `augur export --history` walks
// every retained version's manifest and downloads every blob any of them referenced; this
// command reads none of it. The target ends up holding ONE version — the restored one —
// whatever the copy carries, so a workspace that arrives by restore or by `augur migrate`
// can be rolled back exactly zero publishes. Said out loud at the end of a run rather than
// discovered on the day somebody needs to roll one back. The archive is still worth
// taking: the manifests under `versions/` name every file of every past publish and the
// blobs are all on disk, so a specific past publish can be reconstructed by hand.
//
// Provenance survives. The manifest carries `source` (the space repo sha and the
// dirty flag) through unchanged, so a restored site still reports honestly in
// /_build.json what it was built from — including that it came from a working tree
// if it did.
//
// Target and token resolve exactly as `augur publish` does; see lib/store.mjs.
// Recovery walkthrough: `docs/2026-08-09-bundle-store-recovery.md`.

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { target, apiClient, buildStamp, CLIENT_PROTOCOL } from "./lib/store.mjs";

const log = (msg) => console.error(`\x1b[36m[restore]\x1b[0m ${msg}`);
const die = (msg) => { log(msg); process.exit(1); };

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
// The first bare argument is the directory. Walked by index rather than found by
// value so a value that happens to equal an option's argument can't confuse it.
let DIR = null;
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) { if (args[i] === "--space") i++; continue; }
  DIR = args[i];
  break;
}
const ONE = opt("--space");
const DRY = flag("--dry-run");
const FORCE = flag("--force");
// Opt-in, and deliberately not implied by the copy having state in it. Replaying the
// roster and the publish tokens changes WHO CAN GET IN — a different and larger act than
// putting content back, and the case where somebody wants only the content is real (a
// content restore onto a workspace whose membership has moved on since).
const STATE = flag("--state");
if (!DIR) die("name the export directory: augur restore <dir>");
if (!existsSync(path.join(DIR, "export.json"))) die(`${DIR} has no export.json — not an augur export.`);

let origin, token;
try { ({ origin, token } = target()); } catch (e) { die(e.message); }
const req = apiClient(origin, token);

const meta = JSON.parse(await readFile(path.join(DIR, "export.json"), "utf8"));
log(`${DIR} (taken ${meta.exportedAt} from ${meta.origin}) → ${origin}${DRY ? " [dry run]" : ""}`);
if (meta.origin && meta.origin !== origin) {
  log(`\x1b[33m⚠ this copy was taken from ${meta.origin}, you are restoring to ${origin}\x1b[0m`);
}

const files = (await readdir(path.join(DIR, "manifests"))).filter((f) => f.endsWith(".json"));
const ids = ONE ? [ONE] : files.map((f) => f.replace(/\.json$/, ""));

// What is live now — so a restore can refuse to bury newer content by accident.
let live = {};
try {
  const stamp = await buildStamp(origin);
  live = { ...stamp.spaces, _engine: stamp.engine };
} catch (e) {
  // ⚠️ NAMED AS A GUARD THAT IS OFF, not as a shrug. An empty store is the expected reason
  // and it is not the only one — a target behind a 500, a wrong origin, a CDN serving an
  // error for `/_build.json` all land here, and in every one of those cases the next few
  // lines will publish over whatever is live without ever comparing dates. "Proceeding" on
  // its own reads as "nothing to worry about", which is true exactly once.
  log("\x1b[33m⚠ could not read the live build stamp at " + origin + " — an EMPTY STORE looks "
    + "like this, and so does a target that is merely unreachable. The newer-than-this-copy "
    + "guard is OFF for this run: nothing will stop a restore burying live content.\x1b[0m");
}

// Spaces the TARGET refuses because they are not a workspace's to hold. Today that is one
// space and one reason: on a deployment that resolves workspaces from the Host, the engine
// chrome (`_engine`) is a single bundle serving every workspace, so no workspace's own
// publish token may write it — see `sharedChromeRefusal` in src/_worker.js. A copy taken
// from a single-workspace instance always carries `_engine`, and `augur migrate` is exactly
// the command that moves such a copy onto a shared deployment, so this is the ordinary case
// rather than an error. Named and counted, never silent: a restore that quietly dropped a
// space would be indistinguishable from a complete one.
const declined = [];
const DECLINED_REASON = "chrome-not-writable-here";

let restored = 0;
for (const id of ids) {
  const file = path.join(DIR, "manifests", `${id}.json`);
  if (!existsSync(file)) die(`${id}: no manifest in this export.`);
  const m = JSON.parse(await readFile(file, "utf8"));
  const total = Object.keys(m.files || {}).length;
  if (!total) die(`${id}: the exported manifest has no files — refusing to publish an empty space.`);

  const now = live[id];
  if (now && now.publishedAt && meta.exportedAt && now.publishedAt > meta.exportedAt && !FORCE) {
    // ⚠️ "NEWER" IS NOT THE QUESTION — "DIFFERENT" IS, and the difference is what makes a
    // re-run possible. A restore stamps `publishedAt` at the moment it commits, so its own
    // result is by definition newer than the copy that produced it. Read literally, the date
    // guard therefore fires on the SECOND run of any restore — including the one an operator
    // makes after a run that died halfway, and including `augur migrate`'s, which passes no
    // `--force` and whose header promises re-running is safe. It was not: a migration that
    // failed after committing one space of two could not be repeated at all.
    //
    // So when the date says bury, ask what would be buried. The live manifest's file map
    // against this copy's: identical means live IS this copy and there is nothing to lose.
    // Anything else and the guard stands exactly as it did.
    // Compared on the CONTENT ADDRESSING and nothing else — path → hash, sorted. The rest
    // of a file's record is server-assigned: the commit handler stamps `{by, editedAt}` on
    // every file whose bytes changed, so a live manifest is never field-for-field equal to
    // the copy that produced it even when every byte it serves came from there. Comparing
    // whole records would make this recognise nothing and re-runs would stay broken.
    const addressing = (files) => JSON.stringify(
      Object.keys(files || {}).sort().map((p) => [p, (files[p] || {}).h]),
    );
    let same = false;
    try {
      const liveManifest = await (await req(`${id}/manifest`)).json();
      same = addressing(liveManifest.files) === addressing(m.files);
    } catch (e) { /* cannot read it ⇒ cannot claim it is the same ⇒ refuse below */ }
    if (!same) {
      die(`${id}: live content (published ${now.publishedAt}) is NEWER than this copy (${meta.exportedAt}) ` +
          `and its files DIFFER from it. Restoring would bury it. Re-run with --force if that is what you mean.`);
    }
    log(`${id}: live is newer than this copy but byte-identical to it — this is a re-run, continuing`);
  }

  // Ask the store which blobs it is missing, then send only those. This is also the first
  // request of the space, so it is where a target that will not take this space at all says
  // so — before a single blob is uploaded.
  let check;
  try {
    check = await (await req(`${id}/check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: m.files }),
    })).json();
  } catch (e) {
    if (!String(e.message).includes(DECLINED_REASON)) throw e;
    // Explicitly asked for ⇒ a refusal is an answer to the question, not a detour around it.
    if (ONE === id) {
      die(`${id}: this target will not take it — the page chrome there is one build shared by `
        + "every workspace, so no workspace's publish token may write it.");
    }
    log(`\x1b[33m⚠ ${id}: this target serves it from a shared build and will not take a `
      + "workspace's copy of it — SKIPPED, and nothing else in this copy is affected\x1b[0m");
    declined.push(id);
    continue;
  }
  const missing = [...new Set(check.missing || [])];
  log(`${id}: ${total} files, ${missing.length} blobs to upload, live v${check.liveVersion || 0}`);
  if (DRY) continue;

  const queue = [...missing];
  let failed = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (queue.length) {
      const h = queue.pop();
      const blob = path.join(DIR, "blobs", h);
      if (!existsSync(blob)) { failed++; log(`${id}: blob ${h.slice(0, 12)} is not in this export`); continue; }
      const body = await readFile(blob);
      for (let attempt = 0; ; attempt++) {
        try { await req(`${id}/blob/${h}`, { method: "PUT", body }); break; }
        catch (e) {
          if (attempt >= 2) { failed++; log(`${id}: blob ${h.slice(0, 12)} failed: ${e.message}`); break; }
        }
      }
    }
  }));
  // Nothing is committed on a partial upload, so the live site is untouched and the
  // run can simply be repeated once the copy is complete.
  if (failed) die(`${id}: ${failed} blob(s) missing or failed — nothing committed, live untouched.`);

  // Strip the fields the store assigns on commit; everything else (files, routing,
  // space meta, source) is restored verbatim.
  const { version, publishedAt, publishedBy, ...body } = m;
  const res = await (await req(`${id}/commit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // Same protocol declaration a normal publish makes — a restore is an ordinary
    // publish, so an instance with a floor must be able to judge this client too.
    body: JSON.stringify({ ...body, clientProtocol: CLIENT_PROTOCOL }),
  })).json();
  log(`${id}: restored as v${res.version}`);
  restored++;
}

// ── the workspace state ────────────────────────────────────────────────────
// After the content, because the content is the thing a half-finished restore most needs
// to have landed: a workspace with its pages back and its comments missing is recoverable
// by re-running this, and the other way round is a site serving nothing.
let stateReport = null;
let boardPaths = [];
if (STATE) {
  if (!meta.full) {
    die("--state needs a copy taken with `augur export --full`; this one carries content only.");
  }
  const file = path.join(DIR, "state.json");
  if (!existsSync(file)) die(`${DIR} says it is a full copy but has no state.json — do not trust it.`);
  const doc = JSON.parse(await readFile(file, "utf8"));

  // The canvas images first. A board that references an image the store does not have
  // renders a hole, and the board doc is what arrives in the same breath.
  const hashes = doc.assets || [];
  // The type each image was served as, recorded by the export beside the bytes. The
  // endpoint takes the type from THIS HEADER and stores anything that is not an image type
  // as `image/jpeg` — so a PUT that sends none silently re-labels every PNG, GIF and WebP
  // on the way in, and content addressing cannot notice because the bytes are right. An
  // older copy has no sidecar; it keeps the old behaviour and says so.
  let types = {};
  try { types = JSON.parse(await readFile(path.join(DIR, "assets.json"), "utf8")); } catch (e) {}
  const untyped = hashes.filter((h) => !types[h]);
  if (untyped.length) {
    log(`\x1b[33m⚠ ${untyped.length} of ${hashes.length} image(s) carry no recorded content type `
      + `(a copy taken before assets.json existed) — they will be stored as image/jpeg. `
      + `Re-run \`augur export --full\` against the source to record them.\x1b[0m`);
  }
  let sent = 0, missing = 0;
  for (const h of hashes) {
    const blob = path.join(DIR, "assets", h);
    if (!existsSync(blob)) { missing++; log(`image ${h.slice(0, 12)} is not in this export`); continue; }
    if (DRY) { sent++; continue; }
    try {
      await req(`_state/asset/${h}`, {
        method: "PUT",
        body: await readFile(blob),
        ...(types[h] ? { headers: { "content-type": types[h] } } : {}),
      });
      sent++;
    } catch (e) { missing++; log(`image ${h.slice(0, 12)} failed: ${e.message}`); }
  }
  if (missing) die(`${missing} canvas image(s) missing or failed — nothing replayed, live state untouched.`);

  const families = Object.keys(doc.families || {});
  boardPaths = Object.keys((doc.families || {})["board:"] || {});
  log(`workspace state: ${families.length} famil(y/ies), ${hashes.length} image(s)`);
  if (!DRY) {
    const res = await (await req("_state/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(doc),
    })).json();
    if (!res.ok) die(`the instance refused the state: ${res.reason}${res.failed ? ` (${res.failed.join(", ")})` : ""}`);
    if (res.skipped && res.skipped.length) log(`\x1b[33mskipped (not in the instance's inventory): ${res.skipped.join(", ")}\x1b[0m`);
    stateReport = res;
  }
}

if (DRY) { console.log("(dry run, nothing shipped)"); process.exit(0); }
console.log(`${origin}  ${restored} space(s) restored`
  + (declined.length ? `, ${declined.length} declined by the target (${declined.join(", ")})` : "")
  + (stateReport ? `, ${stateReport.written.length} state famil(y/ies) replayed` : ""));
if (!STATE && meta.full) {
  log("\x1b[33mthis copy also carries the roster, comments, boards and pins — pass --state to replay them\x1b[0m");
}

// ── the two things a restore does NOT put back, said every time ──────────────
// Both are silent by nature: the site comes up, everything anybody looks at is there, and
// what is missing is only missing the day somebody reaches for it. A line each is cheap.
if (meta.history) {
  log("\x1b[33m⚠ this copy carries publish HISTORY and a restore does not replay it — "
    + `${origin} now holds one version per space, so \`augur rollback\` reaches nothing. `
    + "The archive is intact on disk under versions/.\x1b[0m");
}
if (stateReport && boardPaths.length) {
  log(`\x1b[33m⚠ ${boardPaths.length} canvas board(s) came from the KV MIRROR, which lags the `
    + "room that owns them and has been measured minutes behind. Nothing here read the room. "
    + "Per board, against the SOURCE, before you trust this:\x1b[0m");
  for (const p of boardPaths) {
    log(`    node scripts/board-snapshot.mjs move --from ${meta.origin || "<source>"} --to ${origin} --path ${p}`);
  }
}
