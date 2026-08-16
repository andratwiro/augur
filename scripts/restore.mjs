// restore.mjs — put an `augur export` copy back into a bundle store.
//
//   augur restore <dir>                 every space in the export
//   … --space <id>                      one space
//   … --dry-run                         report what would ship, send nothing
//   … --force                           overwrite live content that is NEWER than the copy
//
// A restore is an ordinary publish: blobs first, then one manifest commit per
// space, so it lands atomically and gets its own version number. It does NOT
// rewrite history — the versions the store already holds stay where they are, and
// the restored state arrives on top. That is deliberate: a restore run by mistake
// is then undone by `rollback`, not by another restore.
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
  log("could not read the live build stamp (an empty store looks like this) — proceeding");
}

let restored = 0;
for (const id of ids) {
  const file = path.join(DIR, "manifests", `${id}.json`);
  if (!existsSync(file)) die(`${id}: no manifest in this export.`);
  const m = JSON.parse(await readFile(file, "utf8"));
  const total = Object.keys(m.files || {}).length;
  if (!total) die(`${id}: the exported manifest has no files — refusing to publish an empty space.`);

  const now = live[id];
  if (now && now.publishedAt && meta.exportedAt && now.publishedAt > meta.exportedAt && !FORCE) {
    die(`${id}: live content (published ${now.publishedAt}) is NEWER than this copy (${meta.exportedAt}). ` +
        `Restoring would bury it. Re-run with --force if that is what you mean.`);
  }

  // Ask the store which blobs it is missing, then send only those.
  const check = await (await req(`${id}/check`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ files: m.files }),
  })).json();
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

if (DRY) { console.log("(dry run, nothing shipped)"); process.exit(0); }
console.log(`${origin}  ${restored} space(s) restored`);
