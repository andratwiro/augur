// export.mjs — take an off-Cloudflare copy of the bundle store.
//
//   augur export --out <dir>            the live state of every space + engine chrome
//   … --history                         every retained version's manifest and blobs too
//   … --space <id>                      one space only
//   … --full                            AND everything that is not published content:
//                                       the roster, invites, publish tokens, statuses,
//                                       card names, boards, comment threads, pins, and
//                                       the images pasted onto a canvas
//
// Why this exists: the store is the only copy of what the site serves. Most of it
// is reproducible (clone the space at its recorded sha, publish again) — but a
// publish from a DIRTY working tree serves bytes that exist in no repository at
// all, and those are gone for good if the bucket is. R2 has no point-in-time
// restore to fall back on.
//
// Deliberately runs against the site's own HTTP API with a publish token rather
// than Cloudflare account credentials, so the nightly job that keeps the copy holds
// the weakest credential that can do the work — and so a restore needs nothing but
// this directory and a token.
//
// The output is incremental and content-addressed: blobs are named by hash and
// never rewritten, so re-running over an existing directory downloads only what is
// new. Point it at a path your normal backups already cover.
//
// ⚠️ WITHOUT `--full` THIS IS A COPY OF WHAT WAS PUBLISHED AND NOTHING ELSE. Not who
// could publish it, not who had been invited, not what anybody had said about it, not what
// had been pasted onto a board. That was the whole shape of a backup until
// `/__publish/_state/export` existed, and it is worth saying plainly rather than leaving
// somebody to discover it during a restore. `--full` needs a STAR-SCOPE token, because the
// answer carries the roster and the publish-token hashes.
//
// NOT included even with `--full`: config/instance.json (reproducible from the deploy
// shell, and not something to scatter extra copies of) and the password hashes, which the
// export endpoint cannot reach — a credential is account-level and belongs to the account
// store. See `docs/2026-08-09-bundle-store-recovery.md`.

import { mkdir, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { target, apiClient, buildStamp, idsFromStamp } from "./lib/store.mjs";

const log = (msg) => console.error(`\x1b[36m[export]\x1b[0m ${msg}`);
const die = (msg) => { log(msg); process.exit(1); };

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const OUT = opt("--out");
const HISTORY = flag("--history");
const FULL = flag("--full");
const ONE = opt("--space");
if (!OUT) die("name a destination: --out <dir>");

let origin, token;
try { ({ origin, token } = target()); } catch (e) { die(e.message); }
const req = apiClient(origin, token);

const started = Date.now();
log(`${origin} → ${OUT}${HISTORY ? " (with history)" : ""}${FULL ? " (with workspace state)" : ""}`);

const stamp = await buildStamp(origin);
const ids = (ONE ? [ONE] : idsFromStamp(stamp));

await mkdir(path.join(OUT, "manifests"), { recursive: true });
await mkdir(path.join(OUT, "blobs"), { recursive: true });

// Blobs already on disk from an earlier run. Content addressing makes this a safe
// skip: a hash that is present is by definition the right bytes.
const have = new Set();
try { for (const f of await readdir(path.join(OUT, "blobs"))) have.add(f); } catch (e) {}
if (have.size) log(`${have.size} blobs already present — downloading only what's new`);

// hash → { s: byte size, via: a space id whose manifest references it }.
// Blobs are global to the store (one content-addressed pool, shared across spaces),
// but the API path is scoped — /__publish/<space>/blob/<h> — and a per-space token
// is only accepted on its own space. So each hash remembers a space that references
// it, and is fetched through that one. A star-scoped token works either way.
const wanted = new Map();
const spaces = [];
const skipped = [];

for (const id of ids) {
  let live;
  try {
    live = await (await req(`${id}/manifest`)).json();
  } catch (e) {
    // A space-scoped publish token can only read its own space, and backing up
    // just your own space is a legitimate thing to do — so a 403 skips loudly
    // instead of aborting. Everything else (a space in the stamp with no
    // manifest, a typo in --space) is a real inconsistency: stop, rather than
    // write a quietly incomplete copy.
    if (/→ 403/.test(e.message)) {
      log(`\x1b[33m⚠ ${id}: this token cannot read it — SKIPPED, not in this copy\x1b[0m`);
      skipped.push({ id, reason: "forbidden" });
      continue;
    }
    die(`${id}: could not read its manifest — ${e.message}`);
  }
  await writeFile(path.join(OUT, "manifests", `${id}.json`), JSON.stringify(live), "utf8");
  for (const f of Object.values(live.files || {})) if (f && f.h && !wanted.has(f.h)) wanted.set(f.h, { s: f.s || 0, via: id });
  spaces.push({ id, version: live.version || 0, publishedAt: live.publishedAt || null, source: live.source || null });
  log(`${id}: v${live.version || 0}, ${Object.keys(live.files || {}).length} files${live.source && live.source.dirty ? " \x1b[33m[dirty]\x1b[0m" : ""}`);

  if (!HISTORY) continue;
  const { versions } = await (await req(`${id}/versions`)).json();
  await mkdir(path.join(OUT, "versions", id), { recursive: true });
  for (const v of versions) {
    const m = await (await req(`${id}/version/${v}`)).json();
    await writeFile(path.join(OUT, "versions", id, `${v}.json`), JSON.stringify(m), "utf8");
    for (const f of Object.values(m.files || {})) if (f && f.h && !wanted.has(f.h)) wanted.set(f.h, { s: f.s || 0, via: id });
  }
  log(`${id}: ${versions.length} historical version(s)`);
}

const todo = [...wanted.keys()].filter((h) => !have.has(h));
const bytes = todo.reduce((n, h) => n + wanted.get(h).s, 0);
log(`${wanted.size} blobs referenced, ${todo.length} to fetch (${(bytes / 1e6).toFixed(1)} MB)`);

let done = 0, failed = 0;
const queue = [...todo];
await Promise.all(Array.from({ length: 8 }, async () => {
  while (queue.length) {
    const h = queue.pop();
    for (let attempt = 0; ; attempt++) {
      try {
        const buf = Buffer.from(await (await req(`${wanted.get(h).via}/blob/${h}`)).arrayBuffer());
        await writeFile(path.join(OUT, "blobs", h), buf);
        done++;
        if (done % 200 === 0) log(`${done}/${todo.length} blobs…`);
        break;
      } catch (e) {
        if (attempt >= 2) { failed++; log(`blob ${h.slice(0, 12)} failed: ${e.message}`); break; }
      }
    }
  }
}));

// A partial copy that reports success is worse than no copy: it is the one you
// discover is short a few thousand blobs on the day you need it.
if (failed) die(`${failed} blob(s) failed — this copy is INCOMPLETE, do not trust it for restore.`);

// ── everything that is not published content ────────────────────────────────
// One document plus one file per canvas image. Written LAST, so a copy that has it has
// everything before it too — and recorded in export.json so a restore never has to guess
// whether it is looking at a full copy or a content-only one.
let state = null;
if (FULL) {
  let doc;
  try {
    doc = await (await req("_state/export")).json();
  } catch (e) {
    die(/→ 403/.test(e.message)
      ? "--full needs a STAR-SCOPE token: it reads the roster, the invites and the publish-token hashes."
      : `could not read the workspace state — ${e.message}`);
  }
  if (doc.failed && doc.failed.length) {
    die(`the instance could not read ${doc.failed.length} state famil(y/ies): `
      + `${doc.failed.map((f) => f.id).join(", ")}. This copy would be INCOMPLETE — fix that first.`);
  }
  await writeFile(path.join(OUT, "state.json"), JSON.stringify(doc), "utf8");

  // The canvas images the rows point at. Their bytes are in R2 under a different prefix
  // from the published blobs, so the blob walk above never sees them.
  await mkdir(path.join(OUT, "assets"), { recursive: true });
  const already = new Set();
  try { for (const f of await readdir(path.join(OUT, "assets"))) already.add(f); } catch (e) {}
  const hashes = (doc.assets || []).filter((h) => !already.has(h));
  let assetFail = 0;
  for (const h of hashes) {
    try {
      const buf = Buffer.from(await (await req(`_state/asset/${h}`)).arrayBuffer());
      await writeFile(path.join(OUT, "assets", h), buf);
    } catch (e) { assetFail++; log(`asset ${h.slice(0, 12)} failed: ${e.message}`); }
  }
  if (assetFail) die(`${assetFail} canvas image(s) failed — this copy is INCOMPLETE, do not trust it for restore.`);
  state = {
    families: Object.keys(doc.families || {}).length,
    absent: (doc.absent || []).length,
    assets: (doc.assets || []).length,
  };
  log(`workspace state: ${state.families} famil(y/ies), ${state.assets} canvas image(s)`);
}

await writeFile(path.join(OUT, "export.json"), JSON.stringify({
  format: 1,
  origin,
  exportedAt: new Date().toISOString(),
  history: HISTORY,
  // `full: false` is written, not omitted: a restore that could not tell a content-only
  // copy from a full one would report "no state to replay" for both.
  full: FULL,
  state,
  spaces,
  // What this copy does NOT contain, recorded so a restore from it is never a
  // surprise. Engine chrome landing here is benign — it rebuilds from the engine
  // repo with one deploy — but it should still be stated, not inferred.
  skipped,
  blobs: wanted.size,
}, null, 2), "utf8");

log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
if (skipped.length) log(`\x1b[33m${skipped.length} target(s) skipped: ${skipped.map((s) => s.id).join(", ")}\x1b[0m`);
console.log(`${OUT}  ${spaces.length} space(s), ${wanted.size} blobs`
  + (state ? `, ${state.families} state famil(y/ies), ${state.assets} image(s)` : "")
  + (skipped.length ? `, ${skipped.length} skipped` : ""));
if (!FULL) log("\x1b[33mcontent only — pass --full to include the roster, comments, boards and pins\x1b[0m");
