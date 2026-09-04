// draft.mjs — the CLI half of drafts that land, as functions over an injected client.
//
// Every verb here is `do<Verb>({client, dir, …}) → result`, and the entry points in
// scripts/{open,save,land,sync,close}.mjs only print the result. The client is the small
// object `unitClient` returns, so a test can stand in a fake instance and drive the whole
// loop on disk without a network. See docs/drafts-that-land.md §4 and §7.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { merge3 } from "./merge3.mjs";

export const STATE_FILE = ".augur/draft.json";
export const THEIRS_DIR = ".augur/theirs";
// The machine-wide registry of open draft folders. `AUGUR_DRAFTS_REGISTRY` exists for the
// test suite, which must never write into the developer's own home folder.
export const REGISTRY = path.join(os.homedir(), ".config", "augur", "drafts.json");
const registryPath = () => process.env.AUGUR_DRAFTS_REGISTRY || REGISTRY;

const MIME = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", css: "text/css; charset=utf-8",
  js: "application/javascript; charset=utf-8", mjs: "application/javascript; charset=utf-8",
  json: "application/json; charset=utf-8", txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8",
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
  ico: "image/x-icon", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  mp3: "audio/mpeg", mp4: "video/mp4", webm: "video/webm", pdf: "application/pdf", wasm: "application/wasm",
};
export const mimeOf = (name) => MIME[path.extname(name).slice(1).toLowerCase()] || "application/octet-stream";
export const hashBytes = (buf) => createHash("sha256").update(buf).digest("hex");
export const relOf = (unit, urlPath) => urlPath.slice(unit.length);
export const urlOf = (unit, rel) => unit + rel;

export function scanFolder(dir) {
  const out = {};
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (rel === "" && e.name === ".augur") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile()) {
        const buf = fs.readFileSync(path.join(d, e.name));
        out[r] = { h: hashBytes(buf), ct: mimeOf(e.name), s: buf.length };
      }
    }
  };
  walk(dir, "");
  return out;
}

export function readState(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), "utf8")); } catch (e) { return null; }
}
export function writeState(dir, state) {
  fs.mkdirSync(path.join(dir, ".augur"), { recursive: true });
  const p = path.join(dir, STATE_FILE);
  fs.writeFileSync(p + ".tmp", JSON.stringify(state, null, 2));
  fs.renameSync(p + ".tmp", p);
}

export function changesBetween(unit, savedTable, localScan) {
  const changes = [];
  const seen = new Set();
  for (const [rel, f] of Object.entries(localScan)) {
    const p = urlOf(unit, rel);
    seen.add(p);
    const prior = savedTable[p];
    if (prior && prior.h === f.h) continue;
    changes.push({ path: p, h: f.h, ct: f.ct, s: f.s, baseHash: prior ? prior.h : null });
  }
  for (const [p, f] of Object.entries(savedTable)) if (!seen.has(p)) changes.push({ path: p, baseHash: f.h, delete: true });
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

// ── the machine-wide registry of open draft folders ──────────────────────────
function readRegistry() {
  try { return JSON.parse(fs.readFileSync(registryPath(), "utf8")); } catch (e) { return { drafts: [] }; }
}
function writeRegistry(reg) {
  const p = registryPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p + ".tmp", JSON.stringify(reg, null, 2));
  fs.renameSync(p + ".tmp", p);
}
export function registryAdd(entry) {
  const reg = readRegistry();
  reg.drafts = reg.drafts.filter((d) => d.dir !== entry.dir).concat([entry]);
  writeRegistry(reg);
}
export function registryRemove(dir) {
  const reg = readRegistry();
  reg.drafts = reg.drafts.filter((d) => d.dir !== dir);
  writeRegistry(reg);
}
export const registryList = () => readRegistry().drafts;

// ── the client ───────────────────────────────────────────────────────────────
/**
 * `fetchJson(url, init)` is fetch with the bearer header added; the unit routes live at
 * `/__unit/<verb>` and blobs at `/__publish/<space>/blob/<hash>`. Non-2xx answers come back
 * as `{status, ...body}` rather than throwing, because a 409 is an answer, not a failure.
 */
export function unitClient({ origin, token, space, session }) {
  const headers = { Authorization: `Bearer ${token}`, "X-Augur-Session": session || "" };
  const post = async (verb, body) => {
    const r = await fetch(`${origin}/__unit/${verb}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
    const out = await r.json().catch(() => ({}));
    return r.ok ? out : { status: r.status, ...out };
  };
  const get = async (verb, unit) => {
    const r = await fetch(`${origin}/__unit/${verb}?unit=${encodeURIComponent(unit)}`, { headers });
    const out = await r.json().catch(() => ({}));
    return r.ok ? out : { status: r.status, ...out };
  };
  return {
    open: (b) => post("open", b), save: (b) => post("save", b), land: (b) => post("land", b),
    sync: (b) => post("sync", b), discard: (b) => post("discard", b), presence: (unit) => get("presence", unit),
    async blobPut(h, body) {
      const r = await fetch(`${origin}/__publish/${space}/blob/${h}`, { method: "PUT", headers, body });
      if (!r.ok && r.status !== 204) throw new Error(`blob upload failed: ${r.status}`);
    },
    async blobGet(h) {
      const r = await fetch(`${origin}/__publish/${space}/blob/${h}`, { headers });
      if (!r.ok) throw new Error(`blob fetch failed: ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    },
  };
}

// ── the verbs ────────────────────────────────────────────────────────────────
// `blobPut`/`blobGet` throw on a non-2xx answer, and a raw `fetch` can reject outright
// (offline, DNS, a dropped connection mid-transfer) — a transient failure anywhere inside
// a verb must come back as a result, not an unhandled rejection. `guarded` is that catch,
// applied once to each `do<Verb>` export rather than five times: whatever the body threw
// becomes `{ok: false, error: "network", message}`, and since nothing here writes state
// until its work has actually succeeded, disk is left exactly as it was at the failure —
// a retry reprocesses safely.
function guarded(fn) {
  return async (...args) => {
    try { return await fn(...args); }
    catch (err) { return { ok: false, error: "network", message: String((err && err.message) || err) }; }
  };
}

async function materialise(client, unit, table, dir) {
  for (const [p, f] of Object.entries(table)) {
    const dest = path.join(dir, relOf(unit, p));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, await client.blobGet(f.h));
  }
}

async function doOpenImpl({ client, unit, dir, origin, space, session, now }) {
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) return { ok: false, error: "folder-not-empty", dir };
  const createdFolder = !fs.existsSync(dir);
  const o = await client.open({ unit });
  if (o.status) return { ok: false, ...o };
  // From here the server-side draft exists, so any failure below must both undo what we
  // wrote to disk and tell the server to drop the orphan — otherwise a retry finds a
  // half-materialised folder (`folder-not-empty`) and the draft it opened is never freed.
  try {
    fs.mkdirSync(dir, { recursive: true });
    await materialise(client, unit, o.table, dir);
    // `table` is what the DRAFT last saved (the per-file bases a save is checked against);
    // `baseTable` is what MAIN held at the draft's base revision (what a sync merges from).
    const state = { origin, space, unit, address: o.address, draftId: o.draftId, session, baseRevision: o.baseRevision, draftRevision: 0, table: o.table, baseTable: o.table, openedAt: now };
    writeState(dir, state);
    registryAdd({ dir, unit, draftId: o.draftId, origin, openedAt: now });
  } catch (err) {
    // When we created `dir` ourselves, the whole thing is ours to remove. When it
    // pre-existed, the empty-folder check above guarantees everything under it now is
    // ALSO ours (nothing else can have written there since) — so every entry goes, not
    // just the ones named in `o.table`, leaving the pre-existing folder itself in place.
    if (createdFolder) fs.rmSync(dir, { recursive: true, force: true });
    else for (const e of fs.readdirSync(dir)) fs.rmSync(path.join(dir, e), { recursive: true, force: true });
    try { await client.discard({ unit, draftId: o.draftId }); } catch (e) { /* best-effort */ }
    throw err;
  }
  const others = (o.presence || []).filter((d) => d.id !== o.draftId);
  return { ok: true, draftId: o.draftId, address: `${origin}${o.address}`, files: Object.keys(o.table).length, others };
}

async function doSaveImpl({ client, dir, baseRevision, baseTable }) {
  const st = readState(dir);
  if (!st) return { ok: false, error: "not-a-draft", dir };
  const local = scanFolder(dir);
  const changes = changesBetween(st.unit, st.table, local);
  if (!changes.length && baseRevision === undefined) return { ok: true, changed: [], draftRevision: st.draftRevision };
  for (const c of changes) if (!c.delete) await client.blobPut(c.h, fs.readFileSync(path.join(dir, relOf(st.unit, c.path))));
  const r = await client.save({ unit: st.unit, draftId: st.draftId, draftRevision: st.draftRevision, changes, ...(baseRevision !== undefined ? { baseRevision } : {}) });
  if (r.status) return { ok: false, ...r };
  // A caller mid-sync (`doSyncImpl`) hands its advanced `baseTable` in here rather than
  // writing state itself, so the whole revision — `draftRevision`, `table`, `baseRevision`
  // and `baseTable` — lands in the ONE `writeState` below, only once the server has
  // actually accepted the save. A failure anywhere above this line leaves the file on disk
  // byte-identical to before the call, whatever advanced state a caller was carrying.
  st.draftRevision = r.draftRevision; st.table = r.table;
  if (baseRevision !== undefined) st.baseRevision = baseRevision;
  if (baseTable !== undefined) st.baseTable = baseTable;
  writeState(dir, st);
  return { ok: true, changed: changes.map((c) => relOf(st.unit, c.path)), draftRevision: r.draftRevision };
}

async function doLandImpl({ client, dir, note }) {
  const st = readState(dir);
  if (!st) return { ok: false, error: "not-a-draft", dir };
  const saved = await doSave({ client, dir });
  if (!saved.ok) return saved;
  const r = await client.land({ unit: st.unit, draftId: st.draftId, baseRevision: st.baseRevision, note: note || "" });
  if (r.status) return { ok: false, ...r };
  st.landed = true; st.landedRevision = r.revision;
  writeState(dir, st);
  registryRemove(dir);
  return { ok: true, url: r.url, revision: r.revision, version: r.version };
}

async function doSyncImpl({ client, dir }) {
  const st = readState(dir);
  if (!st) return { ok: false, error: "not-a-draft", dir };
  const r = await client.sync({ unit: st.unit, draftId: st.draftId });
  if (r.status) return { ok: false, ...r };
  const local = scanFolder(dir);
  const baseTable = st.baseTable || {};
  const nextBase = { ...baseTable };
  const taken = [], merged = [], conflicts = [], kept = [];
  const isText = (ct) => /^text\//.test(ct) || /javascript|json|svg/.test(ct);
  for (const c of r.changed) {
    const rel = relOf(st.unit, c.path);
    const base = baseTable[c.path] || null;             // what main held when this draft was based
    nextBase[c.path] = { h: c.h, ct: c.ct, s: c.s };
    if (base && base.h === c.h) continue;                // main's file is what my base already had
    const mine = local[rel] || null;
    const theirBytes = await client.blobGet(c.h);
    const dest = path.join(dir, rel);
    if (!mine && base) {                                  // absent locally but the base had it: I deleted it.
      // main changed it too (we would have `continue`d above otherwise) — that's a real
      // conflict, not a resurrection: leave the file gone, drop theirs beside it.
      // `nextBase[c.path]` above already advanced to main's version despite the conflict staying open, so a later land is possible once the agent has decided; landing without deciding lands the draft's table (this file absent) as it stands.
      writeTheirs(dir, rel, theirBytes);
      conflicts.push({ rel, hunks: [], deleted: true });
      continue;
    }
    if (!mine || (base && mine.h === base.h)) {          // new on main, or I did not touch it: take theirs
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, theirBytes);
      taken.push(rel);
      continue;
    }
    if (mine.h === c.h) { kept.push(rel); continue; }    // we made the same change
    if (!base || !isText(c.ct)) {                        // no common base, or binary: theirs beside, mine stays
      writeTheirs(dir, rel, theirBytes); conflicts.push({ rel, hunks: [] }); continue;
    }
    const baseBytes = await client.blobGet(base.h);
    const m = merge3(baseBytes.toString("utf8"), fs.readFileSync(dest, "utf8"), theirBytes.toString("utf8"));
    if (m.ok) { fs.writeFileSync(dest, m.text); merged.push(rel); }
    else { writeTheirs(dir, rel, theirBytes); conflicts.push({ rel, hunks: m.conflicts }); }
  }
  for (const p of r.removed) {
    const rel = relOf(st.unit, p);
    const base = baseTable[p], mine = local[rel];
    delete nextBase[p];
    if (mine && base && mine.h === base.h) { fs.rmSync(path.join(dir, rel), { force: true }); taken.push(rel); }
    else if (mine) kept.push(rel);
  }
  // The draft is now based on main's current revision. Do not write that here: hand
  // `nextBase` to `doSave` and let it land in the SAME `writeState` the trailing save
  // already does after the server accepts it — a save that fails on the network must
  // leave `.augur/draft.json` exactly as it was before this sync, not holding an advanced
  // `baseTable` alongside a stale `table`/`baseRevision`.
  const saved = await doSave({ client, dir, baseRevision: r.mainRevision, baseTable: nextBase });
  if (!saved.ok) return saved;
  return { ok: true, mainRevision: r.mainRevision, taken, merged, kept, conflicts };
}

function writeTheirs(dir, rel, bytes) {
  const dest = path.join(dir, THEIRS_DIR, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, bytes);
}

async function doCloseImpl({ client, dir, discard }) {
  const st = readState(dir);
  if (!st) return { ok: false, error: "not-a-draft", dir };
  if (!st.landed && !discard) return { ok: false, error: "draft-still-open", draftId: st.draftId, address: st.address };
  if (!st.landed && discard) {
    const r = await client.discard({ unit: st.unit, draftId: st.draftId });
    if (r.status && r.status !== 404) return { ok: false, ...r };
  }
  registryRemove(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true, discarded: !st.landed };
}

// Each verb's public surface is its body wrapped in `guarded` — see the comment above
// `guarded` itself. Internal callers (`doLandImpl` → `doSave`, `doSyncImpl` → `doSave`) go
// through the same wrapped export, so a blob failure partway through a land or a sync comes
// back as the same `{ok: false, error: "network"}` shape a bare save would return.
export const doOpen = guarded(doOpenImpl);
export const doSave = guarded(doSaveImpl);
export const doLand = guarded(doLandImpl);
export const doSync = guarded(doSyncImpl);
export const doClose = guarded(doCloseImpl);
