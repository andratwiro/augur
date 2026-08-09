// export.mjs — take an off-Cloudflare copy of the bundle store.
//
//   augur export --out <dir>            the live state of every space + engine chrome
//   … --history                         every retained version's manifest and blobs too
//   … --space <id>                      one space only
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
// NOT included: config/instance.json (the user roster — reproducible from the
// deploy shell, and not something to scatter extra copies of). See
// `docs/2026-08-09-bundle-store-recovery.md`.

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
const ONE = opt("--space");
if (!OUT) die("name a destination: --out <dir>");

let origin, token;
try { ({ origin, token } = target()); } catch (e) { die(e.message); }
const req = apiClient(origin, token);

const started = Date.now();
log(`${origin} → ${OUT}${HISTORY ? " (with history)" : ""}`);

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

for (const id of ids) {
  let live;
  try {
    live = await (await req(`${id}/manifest`)).json();
  } catch (e) {
    // A space in the stamp with no manifest is a genuine inconsistency; a space
    // named with --space that doesn't exist is a typo. Either way, say so and stop
    // rather than writing a quietly incomplete backup.
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

await writeFile(path.join(OUT, "export.json"), JSON.stringify({
  format: 1,
  origin,
  exportedAt: new Date().toISOString(),
  history: HISTORY,
  spaces,
  blobs: wanted.size,
}, null, 2), "utf8");

log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`${OUT}  ${spaces.length} space(s), ${wanted.size} blobs`);
