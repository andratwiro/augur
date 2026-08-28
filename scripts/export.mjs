// export.mjs — take an off-Cloudflare copy of the bundle store.
//
//   augur export --out <dir>            the live state of every space + engine chrome
//   … --history                         every retained version's manifest and blobs too.
//                                       ⚠️ A RESTORE DOES NOT REPLAY IT — see restore.mjs.
//                                       This is an archive of what each past publish was,
//                                       readable off disk; it does not rebuild the far
//                                       side's rollback history.
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
// store.
//
// SO HOW DOES ANYBODY SIGN IN TO A RESTORED INSTANCE? With the SEED password from the
// deploy shell's identity.json. `effectiveSecret` falls back to the roster's baked hash
// when the KV key is absent, and after a restore into a fresh instance it is absent — so
// the first admin gets in the same way they did on day one, and resets everybody from
// there. Nothing has to be carried and no KV surgery is needed. The nuance, because it is
// the difference between a promise kept and a promise nearly kept: that is the SEED
// password, not whatever they had changed it to. See test/restore-login.test.mjs.
//
// See `docs/2026-08-09-bundle-store-recovery.md`.

import { mkdir, writeFile, readFile, readdir, rename, unlink, stat } from "node:fs/promises";
import path from "node:path";
import { target, apiClient, buildStamp, idsFromStamp } from "./lib/store.mjs";

/**
 * Write a content-addressed file so that it is either absent or COMPLETE, never short.
 *
 * ⚠️ THIS IS WHAT MAKES THE RESUME SAFE, and without it the skip logic below is a lie.
 * `writeFile` of a multi-megabyte buffer is several `write(2)` calls; a process killed
 * between two of them leaves a file with the right NAME and the wrong bytes. The next run
 * sees the name, skips it — "a hash that is present is by definition the right bytes" —
 * and every run after that reports a complete copy. Nothing finds it until a restore, and
 * a restore is exactly the moment nobody wants to find it.
 *
 * A rename within one directory is atomic on every filesystem this runs on, so the visible
 * name never refers to a partial file. The `.part` is swept at startup, not left to rot.
 */
async function writeAtomic(file, buf) {
  const tmp = `${file}.part`;
  await writeFile(tmp, buf);
  await rename(tmp, file);
}

/** Leftovers from a killed run: named so they can never be mistaken for a finished blob. */
async function sweepPartials(dir) {
  let names = [];
  try { names = await readdir(dir); } catch (e) { return 0; }
  let n = 0;
  for (const f of names) {
    if (!f.endsWith(".part")) continue;
    try { await unlink(path.join(dir, f)); n++; } catch (e) {}
  }
  return n;
}

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
// ⚠️ STAMPED BEFORE THE FIRST READ, never after the last one. `restore` refuses to bury
// live content published after this moment, so this has to be the moment the copy started
// describing the instance. Stamped at the END, a publish that landed DURING the export —
// after its manifest was read, before the copy finished — carries a `publishedAt` EARLIER
// than the copy's own, and the guard waves the restore through as if the copy were newer.
// The window is the whole length of the export, which on a real instance is minutes.
const exportedAt = new Date(started).toISOString();
log(`${origin} → ${OUT}${HISTORY ? " (with history)" : ""}${FULL ? " (with workspace state)" : ""}`);

const stamp = await buildStamp(origin);
const ids = (ONE ? [ONE] : idsFromStamp(stamp));

await mkdir(path.join(OUT, "manifests"), { recursive: true });
await mkdir(path.join(OUT, "blobs"), { recursive: true });

// Blobs already on disk from an earlier run, WITH THEIR SIZES. Content addressing makes
// the skip safe only for a file that is whole: a hash that is present is the right bytes
// as long as all of them are there, and the manifest records how many that is. So the
// resume compares the size it finds against the size the manifest declares and re-fetches
// anything short — which costs one `stat` per blob and closes the one way a resumed copy
// could report success over bytes a killed run left half-written.
const partials = await sweepPartials(path.join(OUT, "blobs"));
if (partials) log(`\x1b[33mswept ${partials} half-written blob(s) from an interrupted run\x1b[0m`);
const have = new Map();
try {
  for (const f of await readdir(path.join(OUT, "blobs"))) {
    if (f.endsWith(".part")) continue;
    try { have.set(f, (await stat(path.join(OUT, "blobs", f))).size); } catch (e) {}
  }
} catch (e) {}
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

// A blob counts as present only if it is present AND the right length. A recorded size of
// zero means the manifest does not say, and there is nothing to check it against.
const short = [];
const todo = [...wanted.keys()].filter((h) => {
  if (!have.has(h)) return true;
  const want = wanted.get(h).s;
  if (want && have.get(h) !== want) { short.push(h); return true; }
  return false;
});
if (short.length) {
  log(`\x1b[33m⚠ ${short.length} blob(s) on disk are the wrong length — re-fetching. `
    + `An earlier copy in this directory was INCOMPLETE and reported success.\x1b[0m`);
}
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
        await writeAtomic(path.join(OUT, "blobs", h), buf);
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
  await sweepPartials(path.join(OUT, "assets"));
  const already = new Set();
  try { for (const f of await readdir(path.join(OUT, "assets"))) { if (!f.endsWith(".part")) already.add(f); } } catch (e) {}

  // WHAT TYPE OF IMAGE EACH ONE IS, kept beside the bytes.
  //
  // The hash addresses the bytes and says nothing about how to serve them. The instance
  // holds the type separately (R2 object metadata), the restore endpoint takes it from the
  // request's `content-type` header, and a PUT that sends none is stored as `image/jpeg` —
  // so without this every restored PNG, GIF and WebP arrives declared as a JPEG, cached
  // `immutable` for a year, on the far side of a migration that reported every image
  // present. It is a sidecar rather than a field on `state.json` because two of the three
  // places an image can live carry no metadata row at all (see the export endpoint), and
  // the response header is the one answer that exists for all three.
  let types = {};
  try { types = JSON.parse(await readFile(path.join(OUT, "assets.json"), "utf8")); } catch (e) {}
  const hashes = (doc.assets || []).filter((h) => !already.has(h));
  let assetFail = 0;
  for (const h of hashes) {
    try {
      const res = await req(`_state/asset/${h}`);
      const ct = (res.headers.get("content-type") || "").split(";")[0].trim();
      const buf = Buffer.from(await res.arrayBuffer());
      await writeAtomic(path.join(OUT, "assets", h), buf);
      if (ct) types[h] = ct;
    } catch (e) { assetFail++; log(`asset ${h.slice(0, 12)} failed: ${e.message}`); }
  }
  if (assetFail) die(`${assetFail} canvas image(s) failed — this copy is INCOMPLETE, do not trust it for restore.`);
  await writeFile(path.join(OUT, "assets.json"), JSON.stringify(types), "utf8");
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
  exportedAt,
  finishedAt: new Date().toISOString(),
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
